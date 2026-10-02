# Rapor 2 — Codex oturum kayıtlarından Computer Use davranış kalıpları

Kaynak: `~/.codex/sessions` (→ `/Volumes/SSD_HUB/Mac-Offload/.codex/sessions`), 323 `rollout-*.jsonl`; bunların 59'unda `cua_repl` kullanımı var (araç adı `js`, ad alanı `mcp__cua_repl`; `~/.codex/config.toml` içinde `[mcp_servers.node_repl]` → `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl`, `SKY_CUA_SERVICE_PATH=~/.codex/computer-use/Codex Computer Use.app`). Salt-okunur ayrıştırma: python3 ile JSONL; `response_item` → `function_call(name="js", arguments.code)`, `function_call_output`, `reasoning.summary`, `message`. Zaman damgaları UTC (TR saati +3).

Ağırlıklı incelenen oturumlar:

| Kısaltma | Dosya | Konu |
|---|---|---|
| **P1** | `2026/10/02/rollout-2026-10-02T00-57-38-01a0f979-…jsonl` | Freeform'da 5B küp (penterakt), 3 deneme |
| **P2** | `2026/10/02/rollout-2026-10-02T01-33-52-01a0f979-…_01a0f99a-…jsonl` | "tekrar çiz" + Freeform+Calculator+TextEdit çok-uygulamalı görev |
| **F** | `2026/10/01/rollout-2026-10-01T18-31-14-01a0f817-…jsonl` | Finder ile 233 dosyayı klasörleme |
| **C** | `2026/10/01/rollout-2026-10-01T18-58-50-01a0f830-…jsonl` | Claude.app ayarları, Chrome eklentisi, Calculator |
| **S** | `2026/09/26/rollout-2026-09-26T02-05-15-01a0dad0-…jsonl` (18:04–18:08Z kısmı) | Freeform "Gün Batımı" çizimi; öncesi Chrome (App Store Connect/Firebase) |
| **U** | `2026/09/23/rollout-2026-09-23T13-39-23-…`, `…T22-44-21-…`, `2026/09/24/…T22-14-00-…` | Unity Hub / Unity / oyun build'leri |
| **Sim** | `2026/09/19/rollout-2026-09-19T12-29-56-…jsonl` | iOS Simulator |
| **A** | `2026/09/28/rollout-2026-09-28T19-21-39-…jsonl` | AnyDesk (onay reddi) |

Codex'in kendi hafızası (`~/.codex/memories/MEMORY.md` 272–296, rollout_summaries `2026-09-28T16-21-39-ncSk-…`, `2026-09-25T23-05-15-SSoF-…`) yalnızca iki Computer Use dersi tutuyor: "`Computer Use was not approved to use X` bir onay sınırıdır, dolanma" ve "Freeform'da yerel şekil araçlarıyla gün batımı çizildi". Teknik püf noktaları hafızaya geçmemiş; hepsi oturum içinde yeniden keşfediliyor.

---

## 1. İlk `cua_repl` çağrısında gelen talimat metni

İlk `js` çağrısı (`let app = await cua.getApp("Freeform")`, P1 21:57:44Z) 28 052 karakterlik çıktı döndürüyor: `Wall time` + "## Computer Use" belgesi + onay politikası + ağaç. Aynı belge `cua.rewriteDocumentation()` ile tekrar basılabiliyor (S 06:15:48Z, Sim 10:18:10Z — belgede yazmayan ama çalışan bir metot).

Yapısı (başlıklar birebir, kurallar özet):

1. **## Computer Use** — "Control native apps and browsers… Prefer purpose-built connectors, APIs, or CLIs"; yalnız `cua_repl` kullan (AppleScript/osascript/JXA/CGEvent yasak); durum çağrılar arası kalıcı; `getApp`/tab sonucu ilk UI durumunu otomatik içerir.
2. **## API** — TypeScript bildirimi: `Target {getAXState(StateOptions), getScreenshot, getAXStateAndScreenshot, click(idx|Vec2,{mouseButton,clickCount}), drag, scroll, selectText(idx,text,{prefix,suffix,selectionType}), setValue, performSecondaryAction}`; `App extends Target {scroll(pages), paste(text,{format:"text"|"md"|"html"}), pressKey, typeText}`; tarayıcı tarafı `Browser/Tab` (Playwright locator'lı); `cua {getState, computer.launch_app, getApp, listApps, listWindows, getBrowser, createBrowserTab, getTab, listBrowsers, listTabs}`.
3. **## Native apps** — macOS'ta `getApp(ad | yol | bundle id)`; çok pencerede başlığa bak, "ilk pencereyi kontrol etmeden seçme"; Linux/Windows için `windowId`.
4. **## Workflow** — eylemlerden sonra mutlaka `getAXState()`; indeksleri her seferinde taze ağaçtan türet; **diff varsayılan**, `disableDiffing:true` yalnız gerekince; salt-ekran-görüntüsünden sonra indeks kullanmadan önce tam ağaç al; "no accessibility-tree change" dönerse aynı çağrıyı tekrarlama; **deterministik eylemleri ve son `getAXState()`'i tek çağrıda topla**; "Show All" gibi geniş ara ekranları açma; istenen sonuç görünür olunca keşfi bırak.
5. **## Output** — metin `nodeRepl.write`, görsel `nodeRepl.emitImage`; gözlem metotları sonucu kendileri basar, `{emit:false}` susturur.
6. **## Notes** — indeks tabanlı eylemleri koordinata tercih et; macOS `paste` panoyu geri yükler, biçimli/çok satırlı metin için `paste`; `performSecondaryAction` yalnız ağaçta listelenen eylem adlarıyla ("Do not guess action names"); `pressKey` xdotool sözdizimi (`"super+c"`, `"Return"`, `"KP_0"`); `getApp` ad çözümlemesi başarısızsa bundle id; **gözlem metotları kendisi bekler, `setTimeout` kullanma**; "Persist until the request is fully completed… verify that the returned UI state visibly shows the requested result".
7. **# Computer/Browser Use Confirmation Policy** — tanımlar (user-authored vs third-party content, sensitive data, transmission), dört mod: *Hand-Off Required* (kimlik bilgisi değiştirme, tarayıcı güvenlik uyarısı aşma, finansal işlem, yüksek etkili kararlar), *Confirmation at action time* (CAPTCHA, kalıcı silme, sözleşme kabulü, bilinmeyen kaynaktan yazılım, erişim genişletme, güvenlik zayıflatma), *Pre-Approval Allowed* (giriş, dosya yükleme, ayar değişikliği, kurtarılabilir silme…), *Not required* (okuma, beğeni, çerez banner'ı, düşük etkili mesaj). Davranış: onayları topla, risk+mekanizmayı açıkla, eylemden hemen önce sor, tekrar sorma.

Sonra ` Window: "Untitled 8", App: Freeform.` ve tam ağaç; en sonda `The focused UI element is 11 layout area …`.

**Uygulamaya özel talimat** (`<app_specific_instructions>`) incelenen 59 oturumda **hiç gelmedi**: Freeform, Calculator, TextEdit, Finder, Unity, Simulator, Xcode, Claude, Google Chrome (yerel uygulama olarak), AnyDesk için yok. (Mimari notundaki katalog Slack/Notion/Spotify/iPhone Mirroring/Apple Music/Numbers/Clock ile sınırlı; bu uygulamalar oturumlarda kullanılmamış.) Tek uygulamaya özel ipucu kaynağı modelin kendi deneme-yanılması.

Model C oturumunda (16:00:13Z, 16:04:05Z) bu politikayı uygulayıp "erişim genişletme" için `request_user_input_async` ile onay istedi; metninde "Bilgisayar kullanım aracının güvenlik kuralı … ayrıca onaylamamı zorunlu tutuyor" diyerek kuralı gerekçe gösterdi.

---

## 2. Çağrı yapısı ve sayısal profil

Tüm 59 oturum (tarayıcı sekmeleri dahil): 3 627 `js` çağrısı, 2 843 eylem, 3 272 gözlem → **çağrı başına 0,78 eylem, gözlem/eylem = 1,15**. Yerel uygulama çağrıları (Playwright hariç, 1 283 çağrı) sınıfı:

| Sınıf | Adet | Pay | Wall medyan | Wall ort. |
|---|---|---|---|---|
| eylem + gözlem aynı çağrıda | 756 | 59 % | 1,13 s | 1,87 s |
| yalnız gözlem | 259 | 20 % | 0,25 s | 1,75 s |
| yalnız `cua.getApp` | 210 | 16 % | 0,46 s | 1,95 s |
| eylem, gözlemsiz | 43 | 3 % | 0,33 s | 0,38 s |

Tipik çağrı: `await app.click(12); await app.getAXState();` (1 eylem + 1 gözlem). Döngü (`for`) yalnız 38/867 yerel çağrıda; büyük toplu çağrılar ancak model geometriyi önceden hesapladığında (P1 `drawPath`, 9 eylemli 30,7 s) veya Finder'da klavye tekrarlarında (`for(let i=0;i<30;i++) await app.pressKey("shift+Down")`).

867 yerel çağrıda özellik kullanımı (çağrı sayısı): `getAXState` 405, indeksle `click` 201, `pressKey` 185, `getAXStateAndScreenshot` 184, yalnız `getScreenshot` 158, koordinatla `click` 87, `emit:false` 81, `nodeRepl.write` 79, `typeText` 41, `for` 38, `disableDiffing` 27, `super+shift+g` 16, `setValue` 14, `clickCount` 12, `scroll` 11, `drag` 10, `performSecondaryAction` 10, `paste` 8, `cua.getState` 4.

**Ekran görüntüsü ne zaman?** 516/3627 çağrı (14 %). Yoğunluk uygulamaya bağlı: Simulator 29/57, Unity 72/162 ve 50/142 (ağaç oyun görünümünü anlatmıyor), Freeform çizim doğrulamasında her yol grubundan sonra (`getAXStateAndScreenshot` P1'de 25/37 çağrı), Finder'da 1/80, TextEdit/Calculator'da 0. Kural: ağaçta görünmeyen şey (tuval, oyun, simülatör) → görüntü; metin/tablo işi → yalnız ağaç.

**`emit:false`** 281 kullanım, üç oturumda yoğun: web denetimi (09-29, 123), **F** (57) ve Chrome (09-06, 57). Kalıp: ağacı değişkende tut, süz, yalnız özeti bas:
```js
nodeRepl.write((await app.getAXState({emit:false})).split('\n')
  .filter(x=>/text field|statusBarText/.test(x)).join('\n'));           // F 15:32:56Z
function compact(s){return s.split('\n').filter(x=>/row \(|text field|\d+ text [A-Za-z]|statusBarText/.test(x)).join('\n');}  // F 15:33:16Z
ax=await app.getAXState({emit:false}); let pen=Number(ax.match(/(\d+) button Description: Draw with Pen/)[1]);  // P1 22:01:50Z
```
**`disableDiffing`** 521 kullanım (356'sı S oturumunun Chrome kısmında, her gezinmeden sonra tam ağaç). Yerel uygulamalarda hata sonrası (bkz. §3) ve "ağaç değişmedi" çıktısı sonrası.

**`setTimeout`/sleep:** talimata rağmen 214 kullanım: S Chrome kısmında 161× `await new Promise(r=>setTimeout(r,2500))` (sayfa yüklenmesi), 09-13 Chrome 26× (3500 ms), **U** 9× `setTimeout(r,12000)` (Unity Play moduna girişi bekleme, 19:51:56Z), 09-24 00-44 3× 2500 ms. Freeform/Finder/TextEdit/Calculator'da hiç yok. Ayrıca C oturumunda Claude'un yanıtını beklemek için ayrı `sleep` aracı (10 000 / 15 000 ms).

**Model turu gecikmesi** (çıktı → bir sonraki çağrı): P1 ort. 6,6 s, P2 ort. 3,2 s, C ort. 5,6 s. Yani basit "1 tık + ağaç" çağrısında motor ~1 s, model ~3–6 s; süre modelde.

---

## 3. Hata anında davranış

Yerel çağrılarda görülen hata metinleri ve modelin bir sonraki çağrısı (`NEXT`):

| Hata (çıktı) | Oturum / zaman | Sonraki çağrı |
|---|---|---|
| `-10005: The element ID is no longer valid. Try to get the on-screen content again` | 09-06 Chrome 14:51:07Z; Sim 17:04:49Z; 09-24 Chrome 16:48:19Z | `getAXState({disableDiffing:true})` (bazen `emit:false` + regex süzgeç), sonra aynı eylem yeni indeksle |
| `-10005: 926 is an invalid element ID` | S 10:41:57Z (setTimeout'lu 5 tık zinciri), Sim 17:02:39Z, Xcode 09-25 19:36:02Z | tam ağaç (`disableDiffing:true`) ya da `cua.getState()` |
| `keyNotFound("CMD")` / `("SPACE")` / `("ESC")` / `("Shift")` | 09-09 05:03:00Z; U 11:57:53Z, 19:12:14Z, 20:11:23Z, 20:30:26Z | `'super+a'`, `'space'`, `"Escape"`; `Shift+Tab` için çözüm bulamayıp `nodeRepl.write(a.click.toString())` ile API'yi incelemeye çalıştı (19 s) |
| `Cannot set a value for an element that is not settable` | 09-13 Chrome 22:53:59Z | `click(441); typeText(...)` |
| `timeoutReached` (`getApp("Unity Hub")`, `getApp("/Applications/Unity/Hub/Editor/…/Unity.app")`) | U 11:07:58Z, 11:08:38Z, 19:50:05Z, 19:51:37Z; 09-26 14:59:36Z | `cua.getState()` → `getApp("Unity")` (görünen ad) |
| `noWindowsAvailable` | U 21:19:08Z, 20:33:39Z; 09-24 Chrome 19:59:16Z | `cua.getState()`; `app = await cua.getApp("Unity")` yeniden bağlan; koordinatı 6 px kaydırıp tekrar dene |
| `cannotClickOffscreenElement` | U 19:44:58Z, 19:45:03Z; 09-26 18:46:58Z | `getAXStateAndScreenshot()` → koordinatla tık |
| `windowNotFoundAtPosition((792.0, 2001.0))` | U 20:58:13Z; F 15:33:08Z (`scroll([700,500])` pencere dışı) | `getAXState()` / `getAXStateAndScreenshot()`; sonraki scroll'larda indeks (`scroll(211,"down",1)`) |
| `App quit` | 09-24 06:32:35Z | `app = await cua.getApp('com.sancak.arenasi')` |
| `NSCocoaErrorDomain Code=256 "The file “Unity” couldn't be opened"` (yol ile getApp) | U 20:21:07Z; 09-24 19:39:50Z | `cua.getApp("Unity")` / `cua.getState()` |
| `The screen capture size is invalid: (0.0, 0.0)` | 09-24 19:18:27Z | `cua.getState()` |
| `Timed out waiting for the application to read the clipboard` (paste) | F 15:36:40Z, 15:37:25Z (Go to Folder'a `paste(path)`); P1 21:58:52Z (`paste('<img src=data:…>',{format:"html"})`) | F: `getAXState()` → `Return` → sonra `setValue(274,"/Volumes/SSD_HUB")` (paste yerine); P1: tuvale tık + tekrar paste (yine hata) → vazgeçti |
| `The user changed '/System/Applications/Freeform.app'. Re-query the latest state with get_app_state` | P1 21:59:14Z | `getAXStateAndScreenshot()` |
| `The user may have conflicted with your paste operation` | U 11:04:49Z | `pressKey('super+shift+g'); getAXState()` (yeniden dene) |
| `Computer Use was not approved to use AnyDesk/Finder/Google Chrome/Freeform` | A 16:21–16:47Z; 09-26 17:57Z, 18:03Z | bundle id ile 2. deneme, başka uygulama (Finder) deneme, sonra kullanıcıya "onay sınırı" açıklaması; hafızaya "dolanma" notu |
| `-10000: Sender process is not authenticated` (Claude'un köprüsü) | 10-01 19-08 16:18:11Z | farklı değişkenle `getApp('Claude')` |
| Playwright `{"code":-32000,"message":"Not allowed"}` (filechooser.setFiles) | 09-06 ×4 | yerel Chrome uygulamasına geçip Aç panelinde `super+shift+g` + `/PathTextField/` regex ile yol yazma |
| `app.getState is not a function`, `app.screenshot is not a function`, `elementIndex must be an integer` (`click({x,y})`) | S 18:04:51Z, 18:04:57Z; U 20:11:05Z | doğru metoda geçti (`getScreenshot`, `click([x,y])`); S'de araya `cua.rewriteDocumentation()` koydu |

**Takılı menü:** P1 21:59:02Z'de ağaç kökü `0 Arrange, Secondary Actions: Cancel, Pick` olunca `await app.performSecondaryAction(0,"Cancel"); await app.getAXStateAndScreenshot();` (21:59:04Z); 22:00:36Z'de `performSecondaryAction(1,"Cancel")` + `BackSpace` (deneme çizgisini silme) + tekrar `click(41)`. Escape'i de kullanıyor (`pressKey("Escape")` 14 çağrı) ama menü kökünde Cancel eylemini tercih ediyor.

**Değişmeyen durum:** C oturumunda tık sonrası ağaç değişmeyince aynı indekse 2–3 kez tıkladı (`click(332)` 16:00:25/16:00:36Z, `click(362)` 16:02:09/14/26Z) — talimatın "do not immediately repeat" kuralı yalnız gözlem için; eylem tekrarını serbest sayıyor.

**Sürükleme başarısızlığı (Freeform):** `drag([1325,750],[800,750])` sonrası ağaçta `14 handle Description: Tail handle, Value: x: 1.135, y: 804` değerleri değişmedi (P1 21:58:02Z, 21:58:15Z); model bunu ekran görüntüsüyle de doğrulayıp 21:59:31Z'de "Computer Use'da sürükleme çizgi uçlarını taşımadı, görsel yapıştırma da hata verdi" diye durdu. "tekrar dene"de önce **tek çizgide sürüklemeyi yeniden test etti** (22:00:14Z), sonra kaleme geçti.

---

## 4. Doğrulama stratejileri

- **Ağaçta regex ile indeks türetme** (indeksler her ağaçta kayar): `/(\d+) menu button Insert Shape/`, `/(\d+) button Description: Draw with Pen/` (P1, P2), `/(\d+) text field[^\n]*PathTextField/` (09-06), `/standard window|statusBarText/` (F, 7×), `/text field|statusBarText/`, `/selected, settable|statusBarText/`, `/row \(selected\)|button Open/`, `/sheet|button Open|standard window/`, `/jpg|button Open/`.
- **Pencere başlığı/URL:** Save sonrası diff `~19 standard window codex-gorev-raporu.txt, URL: file:///Users/red/Documents/claude-codex-computer-use/docs/codex-gorev-raporu.txt` (P2 22:55:53Z) → "kaydedildi" kanıtı; `Window: "Open"`, `Window: "Save"`, `Window: ""` + `sheet ID: GoToWindow` panel aşamalarını ayırt ediyor.
- **Değer okuma:** Calculator `5 scroll area Description: Edit field … 6 text ‎1.517` (P2 22:55:18Z; U+200E işaretleri ve binlik ayracı ile); TextEdit `text entry area … Value: pano: Untitled 12\nöğe sayısı: 3\n37x41: 1517`; Finder `statusBarText` ("N items") ile taşınan dosya adedi (F mesajları: "14 CSV raporunu, 5 DWG çizimini ve 14 fotoğrafı … adetlerini Finder'da doğruladım" 15:34:00Z).
- **Öğe varlığı:** Freeform tuvalinde `12 image (selectable) Description: ornek-ev.png`, `13 layout item … sticky note`, `Description: Line` satırları; tutamaç `Value: x:…, y:…` ile hareket kontrolü.
- **Görsel doğrulama:** her yol grubundan sonra `getAXStateAndScreenshot()`; son adımda `performSecondaryAction(0,"Raise")` ile pencereyi öne alıp görüntü (P2 22:55:57Z).
- **Odak satırı:** `The focused UI element is 3 text entry area …` → yazmaya hazır olduğunu buradan anlıyor.
- **Son mesajda kanıt cümlesi:** "Panodaki üç öğe ve Calculator sonucu 1517 doğrulandı" (P2 22:55:38Z); "Tamamlandı; tüm adımlar UI üzerinden doğrulandı, sürükleme kullanılmadı" (22:56:02Z).

---

## 5. Uygulama başına öğrenilenler

**Freeform** (P1, P2, S)
- Çalışmadı: `drag` (uç/tutamaç taşımıyor; S 18:05:57Z, 18:06:19Z, P1), HTML `<img data:svg>` `paste` (pano zaman aşımı), tutamaçları seçip `shift+Left` ile uzatma (P1 21:58:31Z).
- Çalıştı: **Insert Shape (menü düğmesi) → "Draw with Pen" → noktalara `click([x,y])` → `Return` → `Escape`**; her yol için indeksleri taze ağaçtan regex ile al (`drawPath`); 32 köşe/80 kenarı Gray-kodlu Hamilton yolu + açgözlü kalan izler = 17 yol, 4–6 çağrı; sonunda boş tuvale tık (`click([1770,950])`) ile seçimi bırak.
- Şekil ekleme: `Insert > Shape > Triangle/Oval` menü öğeleri; `performSecondaryAction(idx,"Show format options")` → renk/biçim paneli (S 18:05:33Z); seçili öğeyi **ok tuşları (1 pt) / `shift+ok` (10 pt)** ile taşı ve `shift+ok` ile yeniden boyutlandır (S 18:06:36Z: 15×`shift+Right`, 10×`shift+Up`; P2 30×`shift+Right`).
- Resim ekleme: `Insert > Choose File` → `super+shift+g` → `setValue(2, "/yol/dosya.png")` → `Return` → `click(Open)` (P2 22:54:38–45Z). Yapışkan not: `Insert > Sticky Note` → `typeText`; metin kutusu aynı; `Escape` düzenlemeyi bitirir.
- Pano adı: başlık metnine tık (`click(47); typeText("Untitled 12")`) veya `click(35,{clickCount:2}); setValue(91,"Gün Batımı"); Return` (S 18:07:45Z).
- Tuzak: Escape bazen "All Boards" görünümüne döner; `Arrange` menüsü açık kalır → `performSecondaryAction(0,"Cancel")`.

**Calculator** (P2 22:55:15Z; C 16:06:40Z)
- Tüm tuşlar tek çağrıda indeksle: `click(6)…click(24)` (3,7,×,4,1,=) 2,66 s; sonuç `Edit field` altındaki son `text` satırı (`‎1.517`), ilk satır `Last Expression` (`‎37‎×‎41`). Tuşlama `typeText` ile hiç denenmedi.

**TextEdit** (P2 22:55:20–53Z)
- Açılışta `Window: "Open"` paneli → `New Document` (`click(251)`); `Format` menüsü → `Make Plain Text` (`click(259)`, `click(65)`); `typeText("satır1\nsatır2\n…")` çok satır tek seferde; `super+s` → `setValue(25,"ad.txt")` (saveAsNameTextField) → `super+shift+g` → `setValue(21,"/klasör")` → `Return` → `click(32)` Save; doğrulama başlık+URL.

**Finder** (F 15:31–15:39Z, 80 çağrı)
- `super+shift+d` Masaüstü, `super+2` liste görünümü, satır tık + `shift+Down`×N çoklu seçim, `super+ctrl+n` "seçimle yeni klasör" + `typeText(ad)` + `Return`; **tip-ile-seç** (`typeText("5b3ca8")` dosya adı öneki) → `shift+Down` ile genişlet; taşıma `super+c` → `super+shift+g` + yol → `Return` → `super+alt+v`; `super+Up/Down` üst/alt klasör; `super+ctrl+t` kenar çubuğuna ekle; `performSecondaryAction(211,"Expand")` grup aç; sayım `statusBarText`; `compact()` süzgeci + `.slice(-35)` kuyruk okuma.
- Tuzak: Go to Folder'a `paste(path)` iki kez pano zaman aşımı → `setValue(PathTextField, path)`; koordinatla `scroll` pencere dışına düşünce `windowNotFoundAtPosition` → indeksli `scroll(211,"down",1)`.

**Safari / Google Chrome (yerel uygulama olarak)** (09-06, S, 09-24, C)
- Dosya yükleme: Playwright `filechooser` "Not allowed" → `chromeApp.click(Choose File)` → `super+shift+g` → `/PathTextField/` regex ile alan → `typeText(path)`; Aç düğmesi `/button Open/`.
- Gezinme: `super+t` + `typeText("chrome://extensions")` + `Return` (C 16:00:55Z); yükleme beklemesi için `setTimeout 1500–2500` + `getAXState({disableDiffing:true})` (talimata aykırı ama sürekli).
- `getApp("Google Chrome")` tüm pencereler kapalıyken `noWindowsAvailable`.

**Unity / Unity Hub / oyun build'leri** (U)
- `getApp("Unity Hub")` ve tam `.app` yolu `timeoutReached`/`NSCocoaErrorDomain 256`; görünen ad `"Unity"` veya bundle id (`com.unity3d.UnityEditor5.x`, oyun için `com.sancak.arenasi`) çalışıyor.
- Tuş adları küçük/xdotool (`space`, `Escape`); `Shift+Tab` çözümsüz kaldı.
- Game view için ekran görüntüsü şart; ekran dışı öğe → koordinat; Play moduna giriş `setTimeout 12000`.
- Model ağaç yerine çoğu kez kod/Editor.log üzerinden ilerledi (reasoning: "Inspecting Editor.log timestamps", "Verifying Unity Play console").

**iOS Simulator** (Sim) — ağaç çok seyrek, neredeyse her adım `getAXStateAndScreenshot`; `invalid element ID` sık → `disableDiffing:true`.

**Claude.app** (C) — ayar sayfalarında indeksle tık; durum değişmeyince aynı tıkı tekrar; Claude'un yanıtını beklemek için `sleep` aracı; `paste` ile uzun prompt gönderme + `Return`.

**AnyDesk** (A) — "not approved" → ad, bundle id, Finder üzerinden deneme, sonra kullanıcıya sınır açıklaması; sonraki oturumlarda hafıza notu ile hiç denemedi.

---

## 6. Zaman

| Görev (oturum, kullanıcı mesajı UTC) | Süre (ilk çağrı→son mesaj) | `js` çağrısı | Eylem / gözlem / ss | Reasoning | Motor wall | Model turu ort. |
|---|---|---|---|---|---|---|
| Penterakt 1. deneme (P1 21:57:41Z) — başarısız | 120 s | 18 | 29 / 25 / 12 | 16 | 30 s | 6,6 s |
| Penterakt "tekrar dene" (P1 21:59:56Z) — başarılı | ≈197 s | 13 | 24 / 20 / 8 | 12 | 100 s | ~8 s |
| Penterakt "tekrar çiz" (P1 22:10:27Z) | 137 s | 6 | 12 / 13 / 5 | 3 | 98 s | 6 s |
| Penterakt "tekrar çiz" (P2 22:33:55Z) | 113 s | 6 | 7 / 8 / 5 | 3 | 77 s | 4 s |
| Freeform+Calculator+TextEdit (P2 22:54:19Z) | 102 s | 25 | 36 / 23 / 1 | 3 | 29 s | 3,2 s |
| Finder 233 dosya (F 15:31:28Z) | 449 s | 80 | 169 / 79 / 1 | 47 | 105 s | ~4 s |
| Freeform gün batımı (S 18:04:33Z) | 211 s | 33 | 34 / 36 / 10 | 38 | 25 s | ~5 s |

Okuma: çizimde süre motorda (her tık ~1 s; 80 kenar × ~2 nokta ≈ 100 s kaçınılmaz), diğer görevlerde süre modelde (çok-uygulamalı görevde 29 s motor, ~73 s model gecikmesi). İlk `getApp` çağrısı 1–7 s (belge + tam ağaç), tek `getAXState` 0,07–0,25 s, tık+ağaç ~1,1 s medyan.

---

## 7. Reasoning / planlama kalıpları

- **Tek cümlelik niyet mesajı → ilk çağrı:** "Freeform'u açıp çizimi gerçekten uygulama içinde yapacağım. Önce … açık uygulamaları göreceğim." (S), "Sürükleme kullanmadan işlemleri tamamlayacağım; her adımı uygulamanın UI durumundan doğrulayacağım." (P2).
- **Envanter → bağlan → oku → eyle:** eski oturumlarda `cua.getState()` ile başlıyor (S, U); Ekim'de doğrudan `getApp` (ilk çıktı zaten ağacı veriyor).
- **Küçük örnekle kanıtla, sonra ölçekle:** "önce sürüklemenin çalıştığını tek çizgide doğrulayacağım" (P1 21:59:58Z); kalemle 2 nokta → 32 nokta → döngü.
- **Geometriyi UI'dan önce kodda çöz:** reasoning "Examining graph optimization … Euler path … duplicate certain paths" (P1 22:10:50Z); JS içinde köşe/kenar/iz hesabı, UI'ya yalnız tık listesi gidiyor.
- **Alt görev başlıkları:** "Checking drawing controls / Opening a new board", "Resizing selected triangle / Moving selected triangle", "Preparing blue sea band" (S); "Exploring group selection in Finder", "Organizing project shortcuts" (F); Unity'de uzun zincirler ("Fixing background scale / Adjusting background mapping / … / Planning portrait background").
- **Ara ilerleme mesajı** her 1–2 dakikada ("Ana çizim oluştu; kalan köşe bağlantılarını tamamlıyorum.", "75 PDF, 43 PNG … klasörlerine yerleşti. Dosya silmedim.").
- **Durma kararı:** iki alternatif de başarısızsa (drag + paste) somut engeli yazıp bitiriyor; kullanıcı "tekrar dene" deyince üçüncü yöntem.
- **Onay politikası uygulaması:** erişim genişletmeden önce `request_user_input_async` (C).
- **Hafıza kullanımı:** onay sınırı ve "sunset" sonucu dışında teknik ders kaydedilmemiş; Finder/TextEdit/Calculator reçeteleri her oturumda sıfırdan.

---

## 8. Sarmalayıcıya (Claude tarafı) aktarılabilecek 10 somut iyileştirme

Mevcut durum (`/Users/red/Documents/claude-codex-computer-use/server.mjs`, `README.md`): `script` (find/findAll/value/text/lastTextUnder/waitFor/nudge/menu/openPath), `batch` (find, wait_for, if_present, repeat, dry_run), `recover`, `open_path_in_dialog`, `find_elements`, `screenshot` (bölge), diff varsayılan, `BUILTIN_NOTES` (freeform, textedit, calculator, "open/save panel"), hata kodu açıklamaları. Aşağıdakiler bu oturumlardan türeyen, henüz olmayan parçalar.

1. **Tuş adı normalizasyonu** (`press_key`, `script.pressKey`): Codex 5 turu `keyNotFound("CMD"/"SPACE"/"ESC"/"Shift")` ile kaybetti. Eşleme: `CMD|Cmd|Command→super`, `ESC→Escape`, `SPACE|Space→space`, `ENTER→Return`, `Shift+Tab→shift+Tab`, `Ctrl→ctrl`, `Opt|Option→alt`; büyük harfli tek harf (`A`) → `shift+a`. Araç açıklamasına: "xdotool adları: `super+c`, `Return`, `Escape`, `space`, `shift+Tab`; `CMD/ESC/SPACE` kabul edilip çevrilir."
2. **`finder` notları (notes.json'a yeni anahtar):** "Liste görünümü `super+2`; seçimle yeni klasör `super+ctrl+n` → ad yaz → Return; dosya adı önekini `type_text` ile yazmak o öğeyi seçer, `shift+Down` repeat ile genişlet; taşıma: `super+c` → `super+shift+g` + yol → Return → `super+alt+v`; adet `statusBarText` satırında; Go to Folder alanına `paste` pano zaman aşımı verir → `set_value` (PathTextField) kullan; koordinatla scroll pencere dışına düşerse `windowNotFoundAtPosition` → indeksle scroll."
3. **Pano zaman aşımı otomatik düşüşü:** `paste` `-10005 … read the clipboard` dönerse ve odaklı öğe `text field (settable)` ise sarmalayıcı aynı metni `set_value` ile tekrar denesin (F 15:36:40Z/15:37:25Z, P1 21:58:52Z üç kez görüldü); yoksa hata metnine "Go to Folder alanı için set_value kullan" ipucu ekle.
4. **Geçersiz indeks için tek otomatik yeniden deneme:** `element ID is no longer valid` / `N is an invalid element ID` geldiğinde, eylem `find` ile hedeflendiyse taze tam ağaçtan yeniden çöz ve bir kez tekrar et; indeksle hedeflendiyse çıktıya tam ağaç ekle (Codex'in `disableDiffing:true` refleksi). `batch`/`script` içinde `find` zaten taze; bu özellik düz araçlar için.
5. **`getApp` ad çözüm zinciri:** yol ile `NSCocoaErrorDomain 256`, Hub için `timeoutReached`, kapalı uygulamada `noWindowsAvailable` → sırayla görünen ad → bundle id → `list_apps`'ten eşleşen `displayName` ile tekrar dene ve hangi adın tuttuğunu notes'a yaz ("Unity → `Unity` veya `com.unity3d.UnityEditor5.x`; Hub'a yol verme"). `-10005 noWindowsAvailable` açıklamasına "uygulama açık ama penceresiz; `open_application`/`super+n` sonra tekrar bağlan" ekle.
6. **Takılı menü sezgisi her sonuçta:** ağaç kökü `^0 \S.*Secondary Actions: Cancel, Pick` ise sonuç başına `Not: menü açık kaldı (Arrange/Insert); recover veya perform_secondary_action(0,"Cancel")` satırı ekle; `batch.auto_recover` zaten var, düz `click`/`press_key` için de uygulansın. Codex iki kez bunu kendisi fark edip `Cancel` eylemi kullandı.
7. **`script` yardımcıları:** `app.refind(ax?, /regex/)` (taze ağaçtan indeks), `app.pen(points, {deselectAt:[x,y]})` = Insert Shape → Draw with Pen → noktalar → Return → Escape (indeksleri her çağrıda yeniden türeterek; P1 `drawPath` kalıbı), `app.deselect()` (boş tuval koordinatına tık), `app.raise()` (`performSecondaryAction(0,"Raise")` — Codex ekran görüntüsünden önce kullandı), `app.compact(ax, /rows|text field|statusBarText/)` ve `app.tail(ax, n)` (F kalıbı), `app.keys("shift+Down", 30)`.
8. **API tahmin koruması:** Codex `app.getState()`, `app.screenshot()`, `click({x,y})`, `getStateAndScreenshot?.()` çağırdı. `script` ortamına takma adlar ekle (`getState→getAXState`, `screenshot→getScreenshot`, `click({x,y})→click([x,y])`, `secondary/performSecondaryAction` her ikisi) ve bilinmeyen metotta "mevcut metotlar: …" listesi döndür; her hata çıktısında `app.help()` hatırlatması.
9. **Per-uygulama varsayılan ekran görüntüsü:** notes.json'da `"_screenshot": true` anahtarı (Simulator, Unity, oyun build'leri, Freeform tuval doğrulaması) → `get_app_state`/`script.final_state` o uygulamada otomatik `include_screenshot`; Codex bu uygulamalarda çağrıların %50–80'inde görüntü istedi, Finder/TextEdit'te %1.
10. **Onay sınırı ve kullanıcı müdahalesi metinleri:** `Computer Use was not approved to use X` (kod yok, düz metin) ve `The user changed '<app>'. Re-query the latest state` için de adlandırılmış açıklama: ilki "onay sınırı; bundle id/başka uygulama ile tekrar deneme (Codex 4 kez denedi, boşuna); kullanıcıya bildir", ikincisi "kullanıcı uygulamada bir şey değiştirdi; indeksler geçersiz, tam ağaç al". README'deki "4. `-10012`/`-10016` görürsen dur" kuralına bu iki metni ekle.

Ek (notes.json cümleleri):
- `freeform`: "Pano adını değiştirmek: başlık metnine çift tık (`clickCount:2`) → `set_value` → Return. `performSecondaryAction(idx,"Show format options")` renk/biçim panelini açar. Seçili öğe ok tuşuyla 1 pt, shift+ok ile 10 pt hareket eder; shift+ok seçili şekli büyütmek için de kullanılır. Tutamaç satırlarındaki `Value: x:…, y:…` değişmediyse hareket olmamıştır."
- `calculator`: "Tuşlar tek çağrıda indeksle tıklanabilir (7 tık ≈ 2,7 s); `Last Expression` ilk satır, sonuç ikinci scroll area'nın `text` satırı."
- `textedit`: "Save akışı: `super+s` → `set_value`(saveAsNameTextField) → `super+shift+g` → `set_value`(PathTextField) → Return → Save; diff'te `URL: file://…` görünmesi kaydın kanıtı."
- `unity`: "`getApp` için `Unity` veya `com.unity3d.UnityEditor5.x`; `.app` yolu ve `Unity Hub` zaman aşımı verir. Tuşlar `space`/`Escape`. Game view için ekran görüntüsü şart; Play moduna girişi `wait_for` ile bekle, sleep ile değil."
- `simulator`: "Ağaç seyrek; her adımda ekran görüntüsü + koordinat; `invalid element ID` sık → `output:"full"`."

Araç açıklamasına eklenecek cümle (`script`): "Codex aynı işi 25 `js` turu ve ~75 s model gecikmesiyle yapar; burada tüm planı tek script'e yaz: `find` ile hedefle, `waitFor` ile bekle, `log` ile ara sonuçları topla, yalnız son diff'i döndür. Çizim/geometriyi önce JS'te hesapla, UI'ya yalnız tık listesi gönder."
