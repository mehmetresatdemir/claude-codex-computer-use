# claude-codex-computer-use

**Codex'in (ChatGPT.app) yerel Computer Use motorunu Claude Code'dan, Codex kotası harcamadan ve toplu komutlarla kullanmak.**

> Ad benzerliği: bu depo, altta kullandığı [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) köprüsünden **ayrıdır**; köprüyü değiştirmez, önüne `codex-cua-plus` adlı sarmalayıcıyı ve ölçümleri ekler. Sarmalayıcının dosya/araç adı `codex-cua-plus` olarak kalır.

<details>
<summary><b>English summary</b> (the rest of this README is in Turkish)</summary>

### What this is

A thin, dependency-free MCP server (`server.mjs`, Node ≥ 22.14) that sits in front of [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) and lets **Claude Code drive macOS apps through the Computer Use engine that ships with OpenAI's ChatGPT/Codex desktop app**. Claude makes every decision; Codex only supplies the "eyes and hands" (screenshot + accessibility tree, click, type, keys). **No OpenAI model is called and no Codex quota is consumed** — verified by watching the processes with `lsof` during live calls (zero TCP connections; the client talks to the local service over a Unix socket) and by scanning the binaries for endpoints (telemetry/feature-flag and auth/profile only, no model API).

### Why the bridge is needed

Launching `SkyComputerUseClient` directly from Claude Code fails with `-10000: Sender process is not authenticated` — the service checks the launcher's process ancestry. The bridge starts the client through the signed `codex sandbox` launcher inside ChatGPT.app, which the service accepts. `codex sandbox` is just a launcher; it opens no model session.

### What the wrapper adds

Measured latency of the engine itself: warm `get_app_state` ≈ 70 ms, `list_apps` ≈ 10 ms. The slowness comes from spending one model round-trip (plus a 159 KB screenshot) per action. So the wrapper cuts round-trips:

| Feature | Effect |
|---|---|
| `batch` — run a list of actions, return only the final state | N round-trips → 1 |
| **`find`** — target elements by text instead of `element_index` (`{"tool":"click","find":"Choose File"}`); exact > word > substring, `/regex/`, `role`, `nth`; re-reads the tree once if not found and lists near candidates | whole flows in one `batch` without knowing indices |
| **`wait_for`** — poll until a text appears in (or disappears from) the tree | deterministic instead of blind sleeps |
| **`menu`** — click a menu-bar path like `["Insert","Shape","Triangle"]`, skipping intermediate items when the target is already visible | 3 calls → 1 |
| **`find_elements`** — return only matching tree lines | small replies |
| `include_screenshot` on every tool, **default off**; when on, the JPEG is downscaled with `sips` to 1280 px and the original size + multiplier is appended | 159 KB → ~3 KB (off) / ~125 KB (on) |
| `press_key.repeat` | e.g. 15× `shift+Down` in one call |
| `open_path_in_dialog` — ⌘⇧G → path → Return, waits for the file to be selected, then clicks the panel's OK button found in the tree | 5 calls → 1, no blind Return |
| Auto-launch ChatGPT.app on `-10005 app-server exited`, retry once | no manual fix |
| Idle timeout 60 s → 10 min; clean SIGTERM shutdown of the child tree | no cold starts, no orphans |

Real task (Freeform: open board → Insert → Choose File → go to path → insert): 7 model turns by hand (~1 min) → 3 calls / 5.6 s with index-based `batch` (v0.1) → **2 calls / 8.4 s with `find` + `wait_for` and a verified insert (v0.2)**. `menu` inserting a triangle: 1 call, 2.4 s.

### Install

Requires macOS 14.4+, ChatGPT.app with Computer Use installed **and running**, Node ≥ 22.14, Claude Code.

```bash
git clone https://github.com/mehmetresatdemir/claude-codex-computer-use.git
cd claude-codex-computer-use && ./scripts/install.sh   # finds paths, registers the MCP server as codex-computer-use
```
Then start a new Claude Code session. Tools appear as `mcp__codex-computer-use__*`.

### Known limits

- ChatGPT.app must be running (the service hangs off its `codex app-server`).
- In canvas apps like Freeform, `drag` and `set_value` on handles do **not** move shapes (synthetic instant drags are ignored). Workaround used here: render the picture to a PNG and insert it via *Insert > Choose File* (`examples/`).
- Coordinates are in the original screen resolution, not the downscaled screenshot.
- Repro scripts: `scripts/bench.py` (latency), `scripts/net_check.sh` (network), `examples/freeform_insert_image.py` (end-to-end without Claude). Day log: `docs/gunluk-2026-10-01.md` (Turkish).

</details>

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
| `batch` | Eylem listesini sırayla çalıştırır, yalnızca **son** durumu döndürür. `app` tüm eylemlere varsayılan. Hata olursa durur, o ana kadarki günlüğü verir. | N model turu → 1 |
| **`find` ile hedefleme** (click, set_value, scroll, select_text, perform_secondary_action; batch içinde de) | `element_index` yerine metin: `{"tool":"click","find":"Choose File"}`. Son ağaçta tam eşleşme > sözcük eşleşmesi > alt dize; `/regex/`, `role`, `nth` desteklenir. Bulunamazsa taze ağaç alıp bir kez daha dener, yine yoksa yakın adayları listeler. | İndeks bilmeden tek `batch` ile tüm akış |
| **`wait_for`** (batch eylemi) | Bir metin ağaçta görünene (veya `absent:true` ile kaybolana) kadar bekler; `timeout_ms` (4000). | Kör `sleep` yerine deterministik |
| **`menu`** | `path:["Insert","Shape","Triangle"]` — menü çubuğundan yol tıklar. Codex menü ağacını iç içe verdiği için hedef görünür olunca ara adımları atlar. | 3 tur → 1 |
| **`find_elements`** | Ağacın tamamını döndürmeden sorguyla eşleşen satırları verir. | Küçük yanıt |
| `include_screenshot` (tüm araçlarda) | Varsayılan **kapalı**; ağaç yetmezse `true`. Açıkken görüntü `sips` ile **1280 px'e küçültülür** (JPEG kalite 70), orijinal çözünürlük ve çarpan metne yazılır. | 159 KB → ~3 KB (kapalı) / ~125 KB → küçültülmüş |
| `press_key.repeat` | Aynı tuşu N kez (ör. 15× `shift+Down`). | 15 tur → 1 |
| `open_path_in_dialog` | Açık Aç/Kaydet panelinde ⌘⇧G → yol → Return; dosya adının listede **seçili** görünmesini bekler, sonra panelin OK düğmesini (`OKButton`) ağaçtan bulup tıklar (kör Return değil). | 5 tur → 1, deterministik |
| Otomatik uygulama açma | `-10005 app-server exited` görünce `open -g -a ChatGPT` ile uygulamayı arka planda açar, servis gelince bir kez yeniden dener. | Elle müdahale yok |
| Temiz kapanma | SIGTERM/SIGINT/SIGHUP'ta üst akış süreç ağacını da kapatır. | Yetim istemci kalmaz |
| `sleep_ms` (batch içinde) | Sabit bekleme (gerekirse). | — |

Ortam değişkenleri: `CUA_PLUS_NPX` (npx yolu), `CUA_PLUS_DEFAULT_SCREENSHOT` (`true` yaparsan eski davranış), `CUA_PLUS_SCREENSHOT_MAX_PX` (1280; `0` küçültmeyi kapatır), `CUA_PLUS_JPEG_QUALITY` (70), `CUA_PLUS_KEY_DELAY_MS` (tekrar aralığı, 40), `CUA_PLUS_APP_NAME` (`ChatGPT`), `CUA_PLUS_DEBUG=1`. Köprünün kendi değişkenleri (`COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS` vb.) aynen geçer.

**Gerçek ölçüm (Freeform, resim ekleme):**

| Yöntem | Model turu | Süre |
|---|---|---|
| Elle, her adım ayrı çağrı | 7 | ~1 dk |
| `batch` (indeksle) + `open_path_in_dialog` (v0.1) | 3 | 5,6 sn |
| `batch` (**find** + **wait_for**) + `open_path_in_dialog` (v0.2) | **2** | 8,4 sn* |

\* v0.2'de süre biraz daha uzun çünkü her adım doğrulanıyor (`wait_for`, listede seçim beklemesi, OK düğmesini ağaçtan bulma); karşılığında kör Return'ün ekleme yapmadan geçtiği durum ortadan kalktı. `menu` ile üçgen ekleme: 2,4 sn, 1 çağrı.

Tek `batch` örneği (indeks bilmeden):

```json
{
  "app": "Freeform",
  "actions": [
    {"tool": "click", "find": "New Board", "role": "button"},
    {"tool": "wait_for", "args": {"text": "Window: \"Untitled"}},
    {"tool": "click", "find": "Insert"},
    {"tool": "click", "find": "Choose File"},
    {"tool": "wait_for", "args": {"text": "Window: \"Open\""}}
  ],
  "final_state": false
}
```
ardından `open_path_in_dialog {"app":"Freeform","path":"/tam/yol/resim.png"}`.

## Kurulum

Gereksinimler: macOS 14.4+, **ChatGPT.app (Codex) kurulu ve açık**, Node ≥ 22.14 (nvm ile `nvm install 22`; v22.20.0 ile test edildi), Claude Code 2.1.2xx+.

```bash
git clone https://github.com/mehmetresatdemir/claude-codex-computer-use.git
cd claude-codex-computer-use
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
CHANGELOG.md                       sürüm notları
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
