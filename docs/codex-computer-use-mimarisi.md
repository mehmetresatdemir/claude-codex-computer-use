# Codex Computer Use: mimari çözümleme ve bizim tasarım kararlarımız

Kaynaklar: ChatGPT.app içindeki `cua_node/lib/node_modules/@oai/sky` (okunabilir JS; `dist/.../targets/mac/*.js`, `docs/*.md`, `docs/skills/.../SKILL.md`), Codex oturum kayıtları (`~/.codex/sessions/*.jsonl`; `cua_repl` ilk çağrısında modele verilen 29 KB'lık Computer Use talimatı), ikili dosya dizeleri ve canlı ağ/süreç izlemeleri (2026-10-01/02). Amaç kopyalamak değil, mantığı anlayıp kendi aracımızı daha iyi yapmak.

## 1. Katmanlar

```
Codex uygulaması (model: OpenAI)                      Claude Code (model: Claude)
   │ js aracı = node_repl (kalıcı JS REPL)                 │ MCP (stdio)
   │ @oai/sky kütüphanesi                                  │ codex-cua-plus (bizim sarmalayıcı)
   │ nativePipe → computeruse.sock                         │ claude-codex-computer-use köprüsü
   │                                                       │ codex sandbox → SkyComputerUseClient mcp (imzalı)
   └────────────► SkyComputerUseService (Swift) ◄──────────┘   (istemci de aynı soketi kullanır)
                   ekran yakalama (ScreenCaptureKit), erişilebilirlik, olay enjeksiyonu,
                   uygulama politikası, onay overlay'i ("Esc to cancel"), oturum, telemetri
```

- **Servis** ChatGPT.app'in `codex app-server`'ı tarafından ayakta tutulur (`ensureService` host-services IPC'si; `NODE_REPL_HOST_SERVICES_PIPE_PATH`). Uygulama kapalıyken `-10005` gelir. Servisin kendisi internete çıkmaz; model trafiği yalnızca `codex app-server` üzerinden.
- **IPC**: Unix soketi `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock`, API sürümü `CodexComputerUseIPC-5`, istek başına 120 sn zaman aşımı, 8 MB mesaj sınırı, 250 ms bağlanma / 5 sn başlatma bekleme. İstek tipleri: `ListApps`, `AppStart`, `AppPolicy`, `AppGetSkyshot` (`disableDiff`), `AppPerformAction` (`click{at,clickCount,mouseButton}`, `drag{from,to}`, `scroll{at,direction,pages}`, `pressKey`, `type`, `paste{text,format}`, `setValue{elementID,value}`, `selectText{elementID,text,prefix,suffix,selection}`, `performSecondaryAction{elementID,action}`), ses kaydı.
- **Gönderici doğrulama**: servis, soketi açan sürecin soy ağacına bakar (`computer_use_ipc_has_trusted_ancestor`, `ancestor_depth`). Köprü bu yüzden imzalı `codex sandbox` ile başlatır.

## 2. Modelin gördüğü sözleşme (Codex tarafı)

- Tek araç: `cua_repl` (JavaScript). API: `cua.getApp(name)` → `App` nesnesi; `click(idx | [x,y])`, `drag`, `scroll`, `selectText`, `setValue`, `performSecondaryAction`, `pressKey`, `typeText`, `paste(text,{format})`; gözlem: `getAXState({emit, disableDiffing})`, `getScreenshot`, `getAXStateAndScreenshot`. Tarayıcılar için ayrı `Tab` API'si (Playwright locator'ları).
- **Durum kalıcı**; `getApp` sonucu otomatik gösterilir; gözlem metotları `emit:false` ile susturulur (ağaç değişkende kalır).
- **Diff varsayılan**: ağaç bir öncekine göre fark olarak döner ("~ değişen, + eklenen, kaldırılanlar id aralığı"); tam ağaç yalnızca `disableDiffing:true` ile.
- **Örtük bekleme**: gözlem metotları "uygun süre" bekler (~1 sn; yükleniyor göstergesi/değişim belirtisi varsa 5 sn'ye kadar). Model `setTimeout` ile beklemesin denir. Bizim ölçtüğümüz 0,5–1,5 sn "otur" beklemesi budur.
- **Uygulamaya özel talimat**: servis `appSpecificInstructions` döndürürse ilk kullanımda `<app_specific_instructions>` olarak ağacın başına eklenir (Numbers hariç). MCP yolunda da geliyor ama yalnızca servisin rehberi olan uygulamalar için (ör. Safari: "Browser Computer Use" kuralları); Freeform, Calculator, TextEdit için yok. Bizim `notes.json` bu boşluğu dolduruyor.
- **Politika/onay**: her çağrıdan önce `getAppPolicy(app)` → `allowed | denied | forbidden`, risk seviyesi, kalıcı onay ("session"/"always"); onay `createElicitation` ile kullanıcıya sorulur. Ayrı bir "Confirmation Policy" belgesi dört mod tanımlar: *hand-off* (kimlik bilgisi değiştirme, finansal işlem…), *eylem anında onay* (CAPTCHA, kalıcı silme, sözleşme kabulü…), *ön onayla geçer* (giriş yapma, dosya yükleme…), *gerekmez* (okuma, beğeni, çerez banner'ı…).
- **Hata kodları** (`errors.js`): −10000 senderProcessNotAuthenticated … −10012 userStoppedSession, −10016 userIntervened, −10018 ambiguousApp, −10020 screenLocked. Kullanıcı Esc'e basınca döngü durdurulur.
- **Telemetri**: her araç çağrısı için süre ve bitiş durumu (`completed/cancelled/failed`), onay istek/sonuçları; Statsig üzerinden.

## 3. Codex'in çizim davranışından öğrenilenler

Oturum kaydı (00:57–01:03): çizgi şeklinin uçlarını `drag` ile taşımayı denedi (olmadı), SVG'yi HTML olarak `paste` etmeyi denedi (pano zaman aşımı), takılı menüyü `performSecondaryAction(0,"Cancel")` ile kapattı, "yapamadım" dedi; tekrar denemede şekil menüsünde **Draw with Pen**'i bulup iki noktayla doğruladı, sonra geometriyi kodla üretti (5 eksen vektörü, 32 köşe bit maskesi, Gray kodu ana yol, açgözlü kalan yollar) ve `drawPath` döngüsüyle 4 çağrıda bitirdi. Her yol: `Insert Shape → Draw with Pen → noktalar → Return → Escape`. Sonraki "tekrar çiz" istekleri aynı reçeteyi 4–6 çağrıda uyguladı.

Çıkarım: hız motorun değil **döngünün** eseri. Tıklama başına model turu yok; model yalnızca plan, hata ve doğrulama noktalarında devrede.

## 4. Bizim tasarımımız (kopya değil, aynı sorunlara kendi cevaplarımız)

| Codex'te | Bizde | Fark/karar |
|---|---|---|
| `cua_repl` JS, `nodeRepl.write` | `script` aracı (`node:vm`), `log()` | Aynı fikir; ek olarak `app.click({find})`, `app.find/findAll`, `app.waitFor` (Codex'te yok: model regex'i kendi yazıyor). |
| Servis tarafı AX diff | Sarmalayıcı tarafı indeksten bağımsız satır diff'i + gürültü filtresi | Servisin diff'i MCP yolunda yok; kendi diff'imiz indeks kaymasına dayanıklı. |
| `emit:false` | `getAXState()` her zaman sessiz; yalnızca sonda diff | Daha basit sözleşme. |
| `app_specific_instructions` (servis, yalnızca bazı uygulamalar) | `notes.json` + yerleşik notlar (kullanıcı genişletir) | Servisin rehber vermediği uygulamaları tamamlar. |
| Örtük bekleme (servis) | Aynı servis; ek olarak `wait_for` metin koşulu | Sabit `sleep` yerine doğrulama. |
| Hata kodları adlı | `SERVICE_ERRORS` eşlemesi: ad + ne yapmalı; −10012/−10016'da döngüler kesilir | Codex'teki davranışın karşılığı. |
| Onay politikası belgesi | Claude'un kendi kuralları + README'de kısa politika | Çakışma yok. |
| Esc overlay'i | Servisin overlay'i aynen var | Kullanıcı Esc'e basınca `userStoppedSession` gelir. |

Değiştiremediklerimiz: imzalı istemci ve servis (otur beklemesi, drag'in tuval uygulamalarında işlememesi, MCP yolunda servis diff'inin olmaması).

## 5. Pratik kurallar (bu çözümlemeden)

1. Öngörülebilir diziyi tek `script`/`batch` ile gönder; ağacı kodda tut, modele sonda diff ver.
2. Eylem sonrası sabit bekleme koyma; servis bekliyor. Metin koşulu gerekiyorsa `waitFor`.
3. Uygulama sorunlarını önce `notes` ile yakala (Freeform: drag yok, AXPress resimde Quick Look, Escape panodan çıkar).
4. `-10012/-10016` görürsen dur; kullanıcı araya girmiştir.
5. `-10005` iki anlama gelir: `app-server exited` (ChatGPT.app kapalı) veya `timeoutReached` (ağaç çok büyük/yavaş, ör. Safari). İkincisinde uygulamayı açmaya çalışma; koordinat/daha küçük hedef kullan.

## 6. Servisin içi: ikili dosya, Statsig yapılandırması ve canlı log (2026-10-02, ikinci geçiş)

Kaynaklar: `~/.codex/computer-use/Codex Computer Use.app` (sürüm 26.924.1001281; `codesign`, `strings`, `nm`), servis tercihleri `com.openai.sky.CUAService.plist` içindeki Statsig yerel deposu (953 KB JSON), `/usr/bin/log stream --level debug` ile sarmalayıcı üzerinden yapılan ölçümlü eylemler. Hiçbir şey değiştirilmedi; kimlik doğrulama yoluna dokunulmadı.

### 6.1 Paket ve yetkiler

- `SkyComputerUseService` (23,8 MB Swift, 161 k sembol) + `SharedSupport/` altında üç yardımcı uygulama: **Installer**, **SkyComputerUseClient** (MCP istemcisi, 14,8 MB) ve **CUALockScreenGuardian** (ekran kilidi bekçisi; `com.apple.screenIsLocked/Unlocked` bildirimlerini izler, kilitliyken `-10020 screenLocked` döner).
- Entitlement'lar: `application-groups` (grup kabı `2DC432GLL2.com.openai.sky.CUAService`, soketin yeri), `automation.apple-events`, `personal-information.addressbook` (Messages araçları için kişi çözümleme), `keychain-access-groups`. Takım kimliği `2DC432GLL2`.
- Servis yalnızca Computer Use değil; aynı IPC üzerinde **Messages** (chat bul/oku/ara/gönder/say), **Skysight** (arka plan etkinlik akışı ve bellek özetleri), **EventStream** (kayıt & tekrar oynatma, "Record & Replay"), ses kaydı ve Calendar yer tutucusu da var. İstek tipleri: `AppStart/Stop/Modify/Usage`, `AppPolicy`, `AppGetSkyshot`, `AppPerformAction`, `AppStartCapture` + `AppNextCaptureUpdate` (akış halinde yakalama), `FrontmostWindow`, `ListApps`, `CodexTurnEnded`, `CodexStatusItemMenuState`, `EventStreamStart/Status/Stop`, `Messages*`, `Skysight*`, `Start/StopAudioRecording`. MCP istemcisi bunlardan yalnızca 10 Computer Use aracını, Messages araçlarını, `computer_history_*` ve kayıt araçlarını dışarı açıyor; akış halinde yakalama ve `FrontmostWindow` MCP'de yok.

### 6.2 Servisin okuduğu bayraklar ve Statsig değerleri

Canlı logda servis her istekte şu UserDefaults anahtarlarına bakıyor (hiçbiri tanımlı değil, yani varsayılanlar geçerli): `feature/axTreeDiffing`, `feature/axTreeDiffingRemovedElementIDRanges`, `feature/skyshotClassifier`, `feature/computerUseCursor`, `ComputerUseAllowForbiddenTargets`. Statsig deposundaki dinamik yapılandırmalar (ad yerine hash; değerler okunabilir):

| Değer | Anlamı |
|---|---|
| `ui_settle_poll_interval_milliseconds = 50`, `primary_window_poll_interval_milliseconds = 50` | Eylem sonrası "oturdu mu" kontrolü ve ana pencere takibi 50 ms adımlarla yoklanıyor. |
| `should_use_jpeg = true`, `jpeg_compression_quality = 0.8`, `should_normalize_screenshot_to_point_resolution = true` | Ekran görüntüsü JPEG %80 ve **nokta çözünürlüğüne** indirgenmiş (Retina 2× piksel değil). Sarmalayıcımızın 1280 px/%70 küçültmesi bunun üstüne geliyor. |
| `ax_prefetch_enabled = false` | AX ağacını önceden çekme kapalı. |
| `domains: [github.com, slack.com, notion.so, figma.com, docs.google.com, … ] + urls: [accounts.google.com/v3/signin/, id.atlassian.com/login]` | Tarayıcı URL politikası listesi: bu alanlarda oturum "Computer Use is not allowed on the current browser URL" ile durduruluyor ya da farklı akışa yönlendiriliyor. |
| `chrome_extension_install_enabled = true` | Tarayıcı için uzantı yolu tercih ediliyor. |

Ağaç diff'i serviste bir **özellik kapısı**: metinler servis ikilisinde ("The following is a diff from the previous accessibility tree", "Removed element IDs:", "There has been no change in the accessibility tree for …"). MCP yolunda eylem yanıtı ağaç içermiyor; istemcinin sabit metni "Action completed. Call `get_app_state` to fetch the updated UI state." Yani Codex'in REPL yolu *eylem + gözlem*i tek çağrıda alırken MCP yolu iki çağrı istiyor; sarmalayıcımız eylemin ardından kendi `get_app_state`'ini çağırıp diff'i üretiyor.

### 6.3 Uygulamaya özel talimat kataloğu

`Package_ComputerUse.bundle/Contents/Resources/AppInstructions/` altında yedi dosya: Slack, Notion, Spotify, iPhone Mirroring, Apple Music, Numbers, Clock (0,3–3,6 KB Markdown). İçerik tarzı: uygulamanın tuzakları ("Slack'te Return mesajı gönderir, `set_value` kullan"), hangi aracın hangi işe yaradığı, ve "sonuç gecikmeli gelir, uyumak yerine `get-state`'i tekrar çağır" türü sabır kuralları. MCP istemcisi bunları bundle başına bir kez `<app_specific_instructions>` olarak ekliyor (`bundleIdentifiersWithDeliveredInstructions`). Freeform, TextEdit, Calculator, Finder için talimat yok; bizim `notes.json`/yerleşik notlarımız tam bu boşluğu dolduruyor ve aynı tarzda yazılmalı: tuzak → doğru araç → doğrulama.

Onay kalıcılığı istemcide (`AppApprovalStore`, `persistentApprovals`, `persistentApprovalsModificationDate`); kalıcı onay yazılamazsa "Computer Use could not persist the approval permanently for app …" döner. Politika yanıtı `decision ∈ {allowed, denied, forbidden}`, `riskLevel`, `warningSubtitle`, `allowPersistentApproval`.

### 6.4 Bir eylemin zaman çizelgesi (canlı log, Freeform "All Boards")

`scripts/service_trace.py` log akışını istek başına **bekleme / yakalama / ağaç** olarak ayırır. Her eylem serviste **iki IPC işlemi**: önce ~0–1 ms'lik politika kontrolü, sonra eylemin kendisi.

| Eylem | Bekleme (otur) | Yakalama (ScreenCaptureKit) | Ağaç + serileştirme | Toplam |
|---|---|---|---|---|
| `press_key shift` (yalnızca değiştirici) | – | – | – | 1–3 ms (ekran görüntüsü alınmıyor) |
| `scroll` kaydırılacak öğe yokken | – | – | – | 1–3 ms |
| `press_key Escape` | 415–522 ms | 23–28 ms | 9–12 ms | 453–560 ms |
| `click` boş tuval | 423–438 ms | 23–27 ms | 8–11 ms | 455–473 ms |
| `click` — `get_app_state` sonrası **ilk** eylem | 862 ms | 32 ms | 12 ms | 906 ms (pencere etkinleştirme) |
| `type_text "abc"` | 415–444 ms | 26–31 ms | 9–11 ms | 450–486 ms (karakter başına değil, çağrı başına) |
| `get_app_state` (salt gözlem) | 17–20 ms | 22–25 ms | 13–30 ms | 53–75 ms |

Çıkarımlar: (1) "Otur" beklemesi yaklaşık **0,42 s taban + 50 ms yoklama**; sabit 1 s değil. Uygulama meşgulse (`AXElementBusyChanged`, `AXProgressIndicator`) 5 s'ye kadar uzar. (2) Değiştirici tuş ve etkisiz kaydırma hiç beklemiyor; `type_text` tüm metin için tek bekleme ödüyor → metni tek `type_text` ile gönder, tuş tuş değil. (3) Gözlem ucuz (~60 ms); pahalı olan eylem sonrası bekleme. (4) Bir uygulamada ilk eylem ~0,9 s; sonrakiler ~0,5 s. 6-küp (353 eylem, 309 s ≈ 0,87 s/eylem) bu tabana `getAXState` çağrıları ve kalem yolu başına menü tıklamaları eklenince çıkıyor.

Servisin kendi mesajları `<private>` olarak maskeli; yukarıdaki süreler Apple alt sistemlerinin (XPC transaction, ScreenCaptureKit, ReplayKit) zaman damgalarından türetildi. Olay enjeksiyonu için `kTCCServiceListenEvent`/`kTCCServiceAppleEvents` kontrolleri yalnızca oturum başında bir kez yapılıyor.

## 7. Beş ajanlı derin inceleme (2026-10-02) — eklenen bilgiler ve 0.8.0'a yansıyanlar

Raporlar `docs/research/` altında. Burada yalnızca yeni öğrenilenler:

- **JS kütüphanesi (`@oai/sky` 0.7.5):** diff, örtük bekleme, element kimlikleri ve politika kararı tamamen Swift serviste; JS yalnızca `disableDiff` bayrağını geçirir. Mac'te JS tarafında hiç bekleme yok (Linux hedefinde `ActionSettler` 100 ms). Taşıma: JSON-RPC 2.0, 4 bayt LE uzunluk öneki, 8 MB çerçeve, istek başına 120 s + `deadlineUnixMilliseconds`, istekler seri. Onay `nodeRepl.createElicitation` ile; kalıcı onay `persist: session|always`. Modele 20 kural + 4 modlu onay politikası veriliyor.
- **Codex'in gerçek kullanımı (59 oturum, 3 627 çağrı):** tipik çağrı "1 eylem + `getAXState()`"; döngü yalnız %4; ekran görüntüsü %14 (tuval/oyun uygulamalarında %50–80, Finder/TextEdit/Calculator'da ~%0); `emit:false` 281, `disableDiffing` 521 kez; `setTimeout` talimata rağmen 214 kez (Chrome, Unity). 5 tur `keyNotFound("CMD"/"ESC"/"SPACE")` ile kaybedilmiş. İncelenen hiçbir oturumda `<app_specific_instructions>` gelmemiş. Tık+ağaç medyan 1,13 s; model turu 3–7 s.
- **Servis/istemci ikilileri:** tek `SkyComputerUseClient` ikilisinde 5 MCP sunucusu (Computer Use, Messages, Computer History, Record & Replay, Calendar). `paste{text,format}` IPC'de var, MCP'de yok. Tuş adları X11 keysym (`cmd`/`win` geçersiz; `super`/`command` geçerli). Enjeksiyon CGEvent/NSEvent + AXPress; AppleScript yok. Onaylar `…/Application Support/Software/ComputerUseAppApprovals.json`; yerleşik yasak: parola yöneticileri, Terminal/iTerm/Warp/kitty/WezTerm/ghostty, Codex/ChatGPT, SecurityAgent. Gönderici doğrulaması ebeveyn zincirinin team id/signing id'sine bakıyor (2DC432GLL2).
- **Host katmanı:** `SkyComputerUseService` ChatGPT ana sürecinin "managed service" çocuğu (app-server'ın değil). `node_repl` Rust süpervizörü: `js` 30 s/25k token, `js_reset`, gizli `turn_ended`; Unix soketlerini çekirdek değil Rust açıyor. `codex sandbox` yalnızca imzalı `exec` (profil `disabled`), seatbelt şablonu `(deny default)(allow process-exec)(allow file-read*)` + yazma kökleri + unix-socket. Bu makinede `NODE_REPL_HOST_SERVICES_PIPE_PATH` yok; `ensureService` yolu kullanılmıyor.
- **Bizim sarmalayıcının 0.7.2 incelemesi:** eylem sonrası bayat ağaçla `find` (yanlış öğeye tıklama riski), `/Users/x` sorgusunun regex sanılması, `script` zaman aşımının kodu durdurmaması, üst akış `elicitation/create` isteklerinin düşürülmesi, `substitute`'un sayıları dizeye çevirmesi (wait_for zaman aşımı hiç gelmiyordu), gerçek hatalı örnek çıktı (Calculator 37×41 → "3741").

**0.8.0'a yansıyanlar:** `lib/pure.mjs` + 14 birim testi; eylem sonrası ağaç taze okunur (eylem yanıtı ağaç taşıyorsa o kullanılır, ek okuma yok); `findInTree` regex/İ/nth/disabled düzeltmeleri; `script` iptal bayrağı ve tek yeniden deneme, vm-dışı RegExp tanıma; üst akış isteklerinin istemciye aktarılması, 130 s zaman aşımı, süreç grubuyla kapatma, ortam süzme; `paste` (pano üzerinden; Codex REPL'in `paste`'inin karşılığı); tuş adı normalizasyonu (`cmd→super`, `esc→Escape`…); tam hata tablosu (-10000…-10020) + düz metin hatalar (`not approved`, `user changed`, pano zaman aşımı, `noWindowsAvailable`); `observe` seçeneği; `_match` (pencere/ağaç desenine göre) ve `_screenshot` (uygulama başına varsayılan görüntü) not türleri; Finder/Unity/Simulator notları; `app.pen/refind/keys/deselect/raise/compact/tail/help` ve ad takma adları; tüm çalışma zamanı metinleri İngilizce.
