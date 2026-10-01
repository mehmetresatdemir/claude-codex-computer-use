# claude-codex-cua-plus

**Codex'in (ChatGPT.app) yerel Computer Use motorunu Claude Code'dan, Codex kotası harcamadan ve toplu komutlarla kullanmak.**

Bu depo bir günlük bir çalışmanın çıktısıdır (2026-10-01): Codex uygulamasıyla gelen macOS Computer Use bileşenini Claude Code'a bağladık, "kimlik doğrulanmamış gönderici" hatasını çözdük, kota harcanıp harcanmadığını ağ izlemesiyle ölçtük, hızını kıyasladık ve üstüne hızı ~7 kat artıran ince bir sarmalayıcı MCP sunucusu yazdık. Yol boyunca öğrenilen her şey burada.

> Kararları veren model **Claude**'dur. Codex'ten yalnızca "gözler ve eller" (ekran + erişilebilirlik ağacı okuma, tıklama, yazma) kullanılır. OpenAI modeli çağrılmaz.

---

## İçindekiler

- [Mimari](#mimari)
- [Neden çalışmıyordu, nasıl çalıştı](#neden-çalışmıyordu-nasıl-çalıştı)
- [Codex kotası harcanıyor mu? (ölçüm)](#codex-kotası-harcanıyor-mu-ölçüm)
- [Hız: araç mı yavaş, model turu mu? (ölçüm)](#hız-araç-mı-yavaş-model-turu-mu-ölçüm)
- [Sarmalayıcı: codex-cua-plus](#sarmalayıcı-codex-cua-plus)
- [Kurulum](#kurulum)
- [Kullanım](#kullanım)
- [Bilinen sınırlar](#bilinen-sınırlar)
- [Sorun giderme](#sorun-giderme)
- [Depo içeriği](#depo-içeriği)

---

## Mimari

```
Claude Code (model: Claude)
   │  MCP / stdio
   ▼
codex-cua-plus/server.mjs          ← bu depo: batch, repeat, dialog makrosu, görüntü kırpma, otomatik app açma
   │  MCP / stdio
   ▼
claude-codex-computer-use (npx)    ← songkeys'in köprüsü: imzalı başlatıcıyı çağırır, elicitation'ı kabul eder
   │  spawn
   ▼
codex sandbox -- SkyComputerUseClient mcp     ← ChatGPT.app içindeki imzalı istemci
   │  Unix soketi (…/Group Containers/…CUAService/IPC/computeruse.sock)
   ▼
SkyComputerUseService (~/.codex/computer-use) ← ekran görüntüsü, erişilebilirlik ağacı, tıklama/tuş
   │  macOS Accessibility / CGEvent
   ▼
Hedef uygulama
```

Hiçbir katmanda OpenAI modeline istek yoktur. Servis **ChatGPT.app'in `codex app-server` sürecine bağlıdır**: uygulama kapalıysa Computer Use çalışmaz.

## Neden çalışmıyordu, nasıl çalıştı

`SkyComputerUseClient`'ı doğrudan Claude Code'dan başlatınca servis şu hatayı veriyor:

```
Computer Use server error -10000: Sender process is not authenticated
```

Servis, istemciyi başlatan sürecin **soy ağacını** doğruluyor; Claude → istemci zinciri tanınmıyor. [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) köprüsü istemciyi ChatGPT.app içindeki imzalı `codex` ile (`codex sandbox -- … SkyComputerUseClient mcp`) başlatıyor; bu zincir kabul ediliyor. `codex sandbox` yalnızca bir başlatıcıdır (seatbelt profili ile komut çalıştırır), model oturumu açmaz.

Köprüyü ekleyince ilk `list_apps` çağrısı başarıyla açık uygulama listesini döndürdü. Kayıt (`claude mcp add`) yapıldıktan sonra araçların görünmesi için **yeni oturum** gerekir.

## Codex kotası harcanıyor mu? (ölçüm)

Hayır. Üç bağımsız kanıt:

1. **Canlı ağ izleme.** `get_app_state` çağrısı sırasında köprü, istemci ve servis süreçleri 10 sn boyunca `lsof -i` ile izlendi: **sıfır TCP bağlantısı**.
2. **Soketler.** İstemci servise yalnızca Unix soketiyle bağlanıyor (`lsof -U`).
3. **İkili dosya taraması.** `strings` ile servis ve istemcide bulunan adresler yalnızca telemetri/feature-flag (`statsigapi.net`, `featureassets.org`, `chatgpt.com/ces`) ve `api.openai.com/auth|profile`. Model (Responses/`backend-api/codex`) adresi yok. Canlı çağrıda bunlara da bağlanılmadı.

Dışarıya bağlı görünen `codex` süreçleri ChatGPT.app'in kendi `app-server`/`exec-server`'ıdır (ebeveyni ChatGPT.app); köprüyle ilgisi yoktur.

## Hız: araç mı yavaş, model turu mu? (ölçüm)

`scripts/bench.py` köprüye doğrudan bağlanıp ölçer:

| Çağrı | Süre |
|---|---|
| İstemci başlatma (ilk bağlantı) | ~1,1 sn |
| `get_app_state` soğuk | ~1,2 sn |
| `get_app_state` sıcak | **~70 ms** |
| `list_apps` | ~10 ms |

Yani Codex'in motoru hızlı. Yavaşlık, her adımın bir **model turu** olmasından geliyor: ağaç + 159 KB ekran görüntüsü modele gider, model düşünür, cevabı yazar, bir sonraki tek eylemi gönderir. Codex uygulamasının kendi döngüsü arada metin üretmeden sıkı çalıştığı için daha hızlı görünür.

Çözüm: model turlarını azaltmak → sarmalayıcı.

## Sarmalayıcı: codex-cua-plus

`server.mjs`, bağımlılıksız (yalnızca Node ≥ 22.14) bir MCP sunucusudur. Köprüyü kendisi başlatır, Codex'in 10 aracını **aynen** geçirir ve şunları ekler:

| Özellik | Ne yapar | Kazanç |
|---|---|---|
| `batch` | Eylem listesini sırayla çalıştırır, yalnızca **son** durumu döndürür. `app` tüm eylemlere varsayılan. Hata olursa durur, o ana kadarki özeti verir. | N model turu → 1 |
| `include_screenshot` (tüm araçlarda) | Varsayılan **kapalı**; ağaç yetmezse `true`. | Yanıt 159 KB → ~3 KB |
| `press_key.repeat` | Aynı tuşu N kez (ör. 15× `shift+Down`). | 15 tur → 1 |
| `open_path_in_dialog` | Açık Aç/Kaydet panelinde ⌘⇧G → yol → Return (→ Return). | 5 tur → 1 |
| Otomatik uygulama açma | `-10005 app-server exited` görünce `open -g -a ChatGPT` ile uygulamayı arka planda açar, servis gelince bir kez yeniden dener. | Elle müdahale yok |
| Temiz kapanma | SIGTERM/SIGINT/SIGHUP'ta üst akış süreç ağacını da kapatır. | Yetim istemci kalmaz |
| `sleep_ms` (batch içinde) | Animasyon/panel beklemesi. | — |

Ortam değişkenleri: `CUA_PLUS_NPX` (npx yolu), `CUA_PLUS_DEFAULT_SCREENSHOT` (`true` yaparsan eski davranış), `CUA_PLUS_KEY_DELAY_MS` (tekrar aralığı, 40), `CUA_PLUS_APP_NAME` (`ChatGPT`), `CUA_PLUS_DEBUG=1`. Köprünün kendi değişkenleri (`COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS` vb.) aynen geçer.

**Gerçek ölçüm:** Freeform'da "panoyu aç → Insert → Choose File → yola git → ekle → kopyayı sil" akışı: elle 7 model turu → `batch` + makro ile **5,6 sn, 0 ara tur**.

## Kurulum

Gereksinimler: macOS 14.4+, **ChatGPT.app (Codex) kurulu ve açık**, Node ≥ 22.14 (nvm ile `nvm install 22`; v22.20.0 ile test edildi), Claude Code 2.1.2xx+.

```bash
git clone https://github.com/mehmetresatdemir/claude-codex-cua-plus.git
cd claude-codex-cua-plus
./scripts/install.sh
```

Betik; Node 22'yi, ChatGPT.app içindeki imzalı `codex` ve `SkyComputerUseClient` yollarını bulur, `codex-computer-use` adıyla kullanıcı geneli MCP kaydı yapar (varsa eskisini kaldırır). Ardından **yeni bir Claude Code oturumu** aç.

Elle kayıt istersen `scripts/install.sh` içindeki `claude mcp add` komutunu kopyala.

> Node 22 kurulumunda `nvm install 22` checksum hatası verip kaynaktan derlemeye geçerse durdur; `nvm ls-remote 22` ile bir alt sürümü (ör. 22.20.0) kur.

## Kullanım

Claude Code içinde araçlar `mcp__codex-computer-use__*` adıyla görünür. Önerilen döngü:

1. `get_app_state(app)` → ağacı oku (görüntüsüz).
2. Öngörülebilir adımları **tek `batch`** ile gönder; `element_index` kullan.
3. Sonuç ağacını oku; gerekirse `include_screenshot:true` ile bir kez görüntü iste.

Örnek `batch` (Freeform'a dosya ekleme; indeksler o anki ağaçtan alınır):

```json
{
  "app": "Freeform",
  "actions": [
    {"tool": "click", "args": {"element_index": "83"}},
    {"tool": "click", "args": {"element_index": "31"}},
    {"tool": "sleep_ms", "args": {"ms": 300}}
  ]
}
```
ardından
```json
{"app": "Freeform", "path": "/tam/yol/resim.png"}
```
`open_path_in_dialog` ile.

Python'dan doğrudan (Claude olmadan) sürmek için `examples/freeform_insert_image.py`'a bak; aynı JSON-RPC'yi stdio üzerinden konuşur.

## Bilinen sınırlar

- **ChatGPT.app açık olmalı.** Kapanırsa `-10005: codex app-server exited before returning a response`. Sarmalayıcı uygulamayı açmayı dener; başaramazsa elle aç.
- **Tuval sürüklemesi.** Freeform gibi uygulamalarda `drag` (ve tutamaçlara `set_value`) şekilleri **taşımaz**: uygulama sentetik, anlık sürüklemeyi yoksayıyor. Claude'un kendi Computer Use aracındaki `mouse_down/move/up` dizisi tam ekran modunda çalıştı. Pratik yol: resmi dosya olarak üretip `Insert > Choose File` ile eklemek (`examples/draw_*.py`).
- **Takılı menü.** Bir akış menüyü açık bırakırsa Codex'in ağacı o menüde kalabilir; `Escape`/`Cancel` düzeltmedi, uygulamada gerçek bir boş-alan tıklaması düzeltti.
- **Koordinatlar** orijinal ekran çözünürlüğündedir (ör. 2560×1300); ölçeklenmiş görüntüdeki piksel değil. Yanıt metnindeki çarpanı kullan.
- Tek bir istemci oturumu kullan; aynı anda birden fazla köprü/istemci servisi karıştırabilir.

## Sorun giderme

| Belirti | Sebep | Çözüm |
|---|---|---|
| `-10000 Sender process is not authenticated` | İstemci imzalı başlatıcı olmadan açılmış | Köprü/sarmalayıcı üzerinden kaydet; eski doğrudan kaydı kaldır |
| `-10005 app-server exited` | ChatGPT.app kapalı | Uygulamayı aç (sarmalayıcı dener) |
| `EBADENGINE node >=22.14` | Node 20 | `nvm install 22`, kayıtta `PATH` ve `npx` yolunu 22'ye çevir |
| Araçlar görünmüyor | Kayıt sonrası eski oturum | Yeni oturum aç |
| Yanıt "user changed the app" | Sen uygulamayı kullandın | `get_app_state` ile yeniden oku |
| Teşhis | — | `CUA_PLUS_DEBUG=1 COMPUTER_USE_BRIDGE_DEBUG=1` ile stderr'e bak |

## Depo içeriği

```
server.mjs                         sarmalayıcı MCP sunucusu (tek dosya)
scripts/install.sh                 yolları bulur, MCP kaydını yapar
scripts/bench.py                   köprü gecikme ölçümü
scripts/net_check.sh               çağrı sırasında ağ bağlantısı var mı?
examples/freeform_insert_image.py  Claude'suz uçtan uca örnek (Python → sarmalayıcı)
examples/draw_house.py             Pillow ile ev sahnesi
examples/draw_sailboat.py          Pillow ile yelkenli sahnesi
docs/gunluk-2026-10-01.md          günün adım adım kaydı (hatalar dahil)
docs/ornek-*.png                   Freeform'a eklenen örnek resimler
```

## Teşekkür

Köprü: [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) (MIT). Computer Use bileşeni OpenAI'ın ChatGPT/Codex macOS uygulamasının parçasıdır; bu depo onu değiştirmez, yalnızca üstüne ince bir katman koyar.

Lisans: MIT.
