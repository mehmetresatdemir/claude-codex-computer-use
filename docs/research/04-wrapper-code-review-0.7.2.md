# server.mjs (codex-cua-plus 0.7.2) kod incelemesi

Kapsam: `/Users/red/Documents/claude-codex-computer-use/server.mjs` (952 satır), README.md, CHANGELOG.md, docs/codex-computer-use-mimarisi.md, docs/gunluk-2026-10-01.md, examples/, scripts/. Salt okunur inceleme; `node --check` geçti. Saf fonksiyonlar (satır 69–71, 126–165, 209–260) scratchpad'e kopyalanıp Node 20 ile sondalandı; aşağıdaki "doğrulandı" ibareleri bu denemelere dayanır. Servis/MCP başlatılmadı.

Not: Rapor boyunca satır numaraları `server.mjs`'e aittir.

---

## 1. Hatalar ve kırılganlıklar

### 1.1 Eylem sonrası ağaç bayatlığı → `find` yanlış öğeye tıklayabilir (en önemli hata)

- `state.lastTree` yalnızca sonuç ağaç içeriyorsa güncellenir (596: `if (looksLikeTree(t)) state.lastTree = t`). Mimari belgesi §6.2 ve verilen ölçüm gerçeği: MCP eylem yanıtı ağaç **içermez** ("Action completed. Call get_app_state…"). Dolayısıyla batch içinde `click find=A` sonrası UI değişse de `lastTree` eylem öncesi ağaçtır.
- `resolveTarget` (524–525) önce bayat `state.lastTree`'ye, o yoksa çağrılar arası `treeCache`'e (282–284, 911) bakar; **isabet varsa taze okuma yapmaz** (526). Eylem sonrası indeksler kaydıysa ve eski ağaçta aynı metin hâlâ varsa, yanlış `element_index` ile tıklanır; üst akış `invalidElementID` vermez çünkü indeks geçerlidir.
- `batch` açıklaması (335) "indices are resolved from the fresh tree at each step" der — kodla çelişir.
- Aynı kök neden: `if_present`/`if_absent` (617–621) bayat ağaca bakar; `menu` aracı (886) ve script `menu` yardımcısı (731) hedefi bayat ağaçta görürse ara adımları atlayıp eski indeksi tıklar; script `resolve` (704) `state.lastTree || cachedTree` ile aynı davranır.
- Tek araç yolu (913–916): `runBatch` `state.lastTree=null` ile başlar → `cachedTree(app)` dakikalar önceki ağaç olabilir.
- Öneri: UI değiştiren her eylemden (click/press_key/type_text/set_value/scroll/drag/secondary) sonra `state.lastTree = null` yap ve `treeCache`'i "kirli" işaretle; `find` isabetini bayat ağaçta bulsan bile ≈60 ms'lik taze `get_app_state` ile doğrula (satır ve rol aynı mı). `menu`'de hedef görünürlük kararını yalnızca taze ağaçla ver.

### 1.2 `findInTree` regex ayrıştırması (215–218) — doğrulandı

- `"/Users/red/x"` gibi `/` ile başlayan ve içinde başka `/` olan her sorgu regex sanılır: `new RegExp("Users/red", "xi")` → **`Invalid flags supplied to RegExp constructor 'xi'`** fırlatır (218). Hata genel yakalayıcıya (949–950) düşer; batch içinde adım "HATA: Invalid flags" olur. `find_elements` ile yol aramak imkânsız.
- `"/image/g"` → bayraklar `"gi"`; `re.test` (225) `lastIndex` tuttuğu için ardışık satırlarda eşleşme kaçırır (2 image satırından 1'i bulundu — doğrulandı).
- `q.endsWith("i") ? "" : "i"` (218): `/abc/m` → `"mi"` ama `/abc/im` → `"imi"` → geçersiz bayrak fırlatır.
- Türkçe `İ`: `"İleri".toLowerCase()` = `"i̇leri"` (noktalı i + birleşik işaret) → `"ileri"` ile eşleşmez (219, 223; doğrulandı). `toLocaleLowerCase("en")`/NFKD normalizasyonu veya `localeCompare` gerekir.
- Öneri: regex biçimini katı tanımla: `^/(.+)/([gimsuy]*)$` ile yakala, `g` ve `y` bayraklarını at, bayrak kümesi geçersizse düz metne düş; tam yol sorguları için `//` kaçışı belgele.

### 1.3 `findInTree` puanlama tuzakları (221–233)

- `nth` yalnızca **en yüksek skor grubundan** seçer (232–233): `"Insert"` için adaylar `[2:2, 3:1]` iken `nth:1` → `null` (doğrulandı). Şema (324) "If find matches several lines, which one" der; model 2. alt dize eşleşmesini isterken `null` alır.
- `role` süzgeci `startsWith` (222): `role:"text"` hem `text field` hem `text` satırlarını geçirir (doğrulandı); `role:"button"` → `button group`'u da.
- Sözcük eşleşmesi `(^|\s|:)q(,|$)` (227): `"button (disabled) Save"` da 2 puan alır; pasif öğeler aktif olanlarla eşit sıradadır — `(disabled)` içeren satıra ceza verilmeli.
- Regex sorguları sabit 2 puan alır (225); `nth` ağaç sırasına göre çalışır, tutarlı ama belgede yok.
- `parseTree` (129) `^\s*(\d+) (.*)$`: rakamla başlayan düz metin satırlarını (ör. `2024 yılı`) düğüm sanır (doğrulandı: `['0','1','2024']`). Girinti bilgisi atılır; `lastTextUnder` (739) girintiyi ayrıca `search(/\S/)` ile yeniden hesaplar.
- `looksLikeTree` (134) `/^\s*0 /m`: `"Found\n0 results"` için `true` (doğrulandı) → hata metni ağaç sanılıp `treeCache`'e yazılabilir (283).

### 1.4 JSON-RPC işleme

- **Üst akıştan gelen istekler düşürülüyor** (41–49): `m.id` tanımlı ama `pending`'de değilse ve `m.method` varsa (ör. `elicitation/create` — mimari belgesi §2 onay akışının `createElicitation` ile sorulduğunu söylüyor; `ping`, `roots/list`, `sampling/*`) hiçbir şey yapılmaz. Üst akış yanıt beklerse çağrı sonsuza dek asılı kalır. Çözüm: bu istekleri alt akışa yönlendir (id'leri yeniden eşle: üst akış id'si ile bizim `nextId` çakışabilir) ve yanıtı geri taşı; en azından `ping`'e `{}` dön, diğerlerine `-32601` ile cevap ver.
- Üst akış yanıtı `m.error` → `new Error(message)` (45): `code`/`data` kaybolur; alt akışa her şey `isError` metni olarak iner.
- Alt akışta `tools/list`/`initialize` sırasında fırlayan istisna `result: {content, isError}` ile dönüyor (949–950) — bu yalnızca `tools/call` için geçerli; `tools/list` için JSON-RPC `error` nesnesi gerekir. `tools/call` için `-32602` (bilinmeyen araç) yerine üst akışa körlemesine geçiliyor (927).
- `initialize` (941) istemcinin gönderdiği `protocolVersion`'ı aynen yansıtır; desteklenen sürümü dönmelidir.
- Parse edilemeyen satır sessizce yutulur (935); `-32700` mümkün değil (id yok) ama `debug` logu bile yok. `notifications/cancelled` işlenmez; uzun `script`/`batch` iptal edilemez.
- Üst akış bildirimleri alt akışa `initialize` tamamlanmadan da geçirilebilir (48); `notifications/tools/list_changed` geçirilirken biz `listChanged:false` ilan ediyoruz (941).
- `pending` için zaman aşımı yok (34–40): üst akış bir isteğe hiç yanıt vermezse Map sızar ve alt akış çağrısı asılı kalır. Servisin kendi 120 s IPC sınırı var (belge §1); sarmalayıcıda ~130 s güvenlik zaman aşımı olmalı.

### 1.5 Üst akış süreç yönetimi

- `spawn(NPX, …)` (28) modül yüklenirken; `up.on("error")` yok → `npx` bulunamazsa (ENOENT) yakalanmamış `'error'` olayı ile çökme. `up.stdin.on("error")` de yok → üst akış öldükten sonra `upSend` (33) EPIPE ile çökertir.
- SIGTERM işleyicisi (51–53) yalnızca `npx`'e sinyal gönderir; `npx` → köprü (node) → `codex sandbox` → `SkyComputerUseClient` zinciri torun süreçlerdir. `npx` sinyali iletmezse istemci yetim kalır (günlük §8 "yetim süreçler" tam bu). Çözüm: `detached:true` + `process.kill(-up.pid, "SIGTERM")` (süreç grubu) veya köprüyü doğrudan `node <bridge path>` ile başlat.
- `process.exit(0)` 200 ms sonra koşulsuz (52); çıkış yanıtı/temizlik beklenmez. stdin kapanınca (952) `up.kill()` sonrası **anında** `process.exit(0)`.
- Üst akış kapanınca sarmalayıcı da çıkar (50). Köprünün `COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS` boşta kapanması köprüyü de bitiriyorsa MCP sunucusu 10 dk sonra ölür ve Claude Code "Connection closed" görür. Daha sağlam: üst akışı tembel yeniden başlat (`up` değişkenini yeniden ata, `upstreamInitialized=null`, `pending`'i reddet).
- `SERVICE_DOWN` (265) `Sender process is not authenticated` (-10000) için de ChatGPT.app'i açar (291–292): -10000 başlatıcı/soy ağacı sorunudur; uygulamayı açmak çözmez, her çağrıda 30 s'ye kadar (272–276) boşuna beklenir.
- `ensureCodexAppRunning` `pgrep -f "codex .*app-server"` (274) desenini kendi `pgrep` komut satırı da içerir (pgrep kendini dışlar ama `status`'taki paralel `pgrep` çağrılarıyla (803) yarış edebilir; düşük olasılık).
- `run()` (82–87) ve `open`/`pgrep` spawn'larında (271, 274) `'error'` dinleyicisi yok; ikili yoksa çökme.

### 1.6 Yarış durumları / eşzamanlılık

- Alt akış satır işleyicisi `async` (934): MCP istemcisi paralel `tools/call` gönderebilir. Paylaşılan durum: `treeCache` (282), `notesShown` (198), `scriptCtx.cua` (748 — her çağrıda yeniden bağlanır; iki eşzamanlı `script` birbirinin `state`'ini ezer), `launchingApp` (266), `loadMacros/saveMacros` (207–208, okuma-değiştirme-yazma). Çözüm: tek kuyruk (mutex) ile `tools/call`'ları sırala; Computer Use zaten tek ekrana sürücüdür, paralellik anlamsız.
- `script` zaman aşımı sonrası kod çalışmaya devam eder (bkz. 1.8) ve bir sonraki araç çağrısıyla **eylemler iç içe geçer**.

### 1.7 Bellek

- `treeCache` uygulama başına son ağaç (282): bağlı, ama Safari gibi büyük ağaçlar 100+ KB; bayatlık sorunu büyüklükten daha önemli. Anahtar `String(app).toLowerCase()` iken `notesShown` ham `app` ile tutulur (201–202): `freeform`/`Freeform` notları iki kez gösterir.
- `scriptCtx` (690, 744–746): kullanıcı değişkenleri bilerek kalıcı; `state.logs` (743) sınırsız — 353 eylemlik döngüde `log()` ile MB'larca metin dönebilir. Üst sınır (ör. son 500 satır + "kısaltıldı") ekle.
- `pending` (30) zaman aşımı olmadığından sızabilir (1.4).
- `shrinkScreenshot`/`screenshot` her çağrıda `mkdtempSync` + dosya (102–118, 823–838): `rmSync` `finally`'de, OK; ama `imageSize` için 2 ekstra `sips` süreci (bkz. §2).

### 1.8 `script` sandbox (742–777) — doğrulandı

- **Timeout iptal etmiyor**: `vm.runInContext(..., {timeout:5000})` (758) yalnızca fonksiyon *ifadesinin* derlenmesini kapsar; gövde `fn()` ile dışarıda çalışır. `Promise.race` (759) sadece yanıtı erken döndürür; `await` içeren döngü sürer (deneme: zaman aşımında 3 tık, 400 ms sonra 10 tık). Senkron `while(true){}` ise olay döngüsünü tamamen kilitler, `sleep` zamanlayıcısı hiç tetiklenmez → sunucu donar.
- **vm güvenlik sınırı değil**: bağlama verilen `sleep`, `setTimeout`, `console.log`, `cua.*` ana makine fonksiyonlarıdır; `sleep.constructor("return process")().pid === process.pid` (doğrulandı). `__state` (754) ve `Error`, `Object` da ana makineden. Tek çağıran Claude olduğu için kabul edilebilir, ama README "sandbox" izlenimi vermemeli; yorumlarda açıkça "güven sınırı değil" yazılmalı.
- Öneriler: (a) `state.cancelled` bayrağı: zaman aşımında `true`, `call()` (692) her eylemden önce kontrol edip fırlatsın → en azından yeni IPC gitmez; (b) gerçek iptal için `worker_threads` + `worker.terminate()`; (c) `vm` `timeout` + `microtaskMode:"afterEvaluate"` senkron sonsuz döngüyü keser ama IPC `await`'lerini değil.
- `makeApp.call` (697): "Re-query" yanıtında **sınırsız özyineleme** (`return call(tool,args)`); üst akış tekrar aynı yanıtı verirse sonsuz döngü. `runAction`'daki gibi (590–595) bir kez dene.
- `runScript` diff tabanı (769–773): yorum "kod başında alınan ağaç" der ama `before = state.lastTree` **son** ağaçtır; `state.firstTree` ilk `getApp`'in uygulamasına aittir. `args.app` farklı bir uygulamaysa (ör. ilk `getApp("Freeform")`, `app:"TextEdit"`) diff Freeform ağacı ile TextEdit ağacı arasında alınır → anlamsız.
- Sonuç olarak gerçek olay: `docs/claude-gorev-raporu.txt` "37x41: 3741" (Codex raporunda 1517). `lastTextUnder(ax,"Edit field")` (739) sonuç satırı yerine ifade satırını okumuş; `replace(/[^\d]/g,"")` "37×41"i "3741" yapmış. `lastTextUnder` kapsayıcı altındaki *son* `text` satırını döndürür; Calculator'da sonuç tek satırda değilse veya `Return` sonrası ağaç oturmadan okunduysa yanlış. Doğrulama (`waitFor` ile değerin değişmesi) gerekiyor; örnek script (`examples/scripts/multi_app_task.js:16`) bu hatayı maskeliyor.

### 1.9 `openPathInDialog` varsayımları (658–687)

- `m = state.lastTree.match(/^\s*(\d+) text field .*PathTextField/m)` (663): `waitFor` büyük/küçük harf duyarsız alt dize ile buldu ama regex büyük/küçük harf duyarlı ve rolün tam `text field` olmasını ister; eşleşmezse `m[1]` → `TypeError: Cannot read properties of null` (genel yakalayıcıya düşer, log satırı "Hata: …" olur, batch adımı anlamsız hata gösterir).
- `super+shift+g` (660) ABD kısayolu varsayımı; panelin önde olduğu kontrol edilmez.
- Seçim doğrulaması `Value: ${base}` alt dizesi (669): `ev` → `ev.png`, `evening` ile de eşleşir; klasör yolunda (`openPath("/…/docs")`, examples/scripts/multi_app_task.js:24) seçili öğe olmayabilir → `ok:false` dönüp "listede görünmedi" der, oysa gezinme başarılıdır.
- Kapanış kontrolü `open-panel` metninin yokluğu (678, 680): **Kaydet panelinde** (`save-panel`, bkz. examples/macros/textedit_write_save.json) bu metin zaten yoktur → `waitFor absent` hemen `ok` → "confirm: Return" loglanır, panel açık kalsa bile; OK düğmesi fallback'i hiç çalışmaz.
- 668'deki `waitFor(... absent:true)` sonucu yoksayılır.
- `press_key Return` sonrası `wait_for` 1,5 s (678): Return UI değiştirdiği için servis zaten ≈0,5 s bekler; iki okuma yeter.

### 1.10 `shrinkScreenshot` / `screenshot` (95–119, 818–839)

- Başarısızlık yolu iyi (`try/catch` → orijinal, `finally` temizlik). Ama `run("sips")` `'error'` dinleyicisi yok (84): `sips` yoksa (macOS dışı) çökme.
- `screenshot` aracı `mimeType:"image/jpeg"` sabit (837) — küçültme yapılmadıysa (`max_px:0` veya küçük görüntü) ve üst akış PNG verdiyse yanlış MIME. `ext` tespiti `shrinkScreenshot`'ta var (101), burada yok.
- `st.content.filter` (821) `st.content` yoksa çöker; `imageSize` `null` dönerse `size?.w` "undefined×undefined" yazar (827).
- `shrinkScreenshot` not metni (115) koordinat çarpanını yazıyor ama Statsig'e göre servis görüntüyü zaten nokta çözünürlüğüne indiriyor (belge §6.2) ve günlük tıklamaların 2560 px'te olduğunu söylüyor; "ORİJİNAL çözünürlük" ifadesi hangisi? Belgelenmeli.
- `recover` son çaresi (513–516): ekran görüntüsü genişliğinden `(w/2, 12)` tıklar. (a) Görüntü nokta çözünürlüğündeyse tıklama koordinatı yarıya iner; (b) y=12 macOS menü çubuğudur — pencere başlığı değil; menü çubuğunun ortasına tıklamak başka bir menü açabilir (kurtarmanın tersi). Pencere konumu ağaçtan (window satırı/Frame) alınmalı.

### 1.11 Regex/diff hataları

- `treeDiff` (139–148) doğru (çoğaltılmış satır sayımı doğrulandı). Ama `renderResult` (306, 310) `treeDiff`'i iki kez hesaplar (bir kez boşluk kontrolü, bir kez `diffText` içinde).
- `diffText` sabit 60/30 kesme (163) ve `(kısaltıldı; … output:"full")` metni; `compact` gürültü sayacı toplam değişikliği gizler (başlıksız `image` eklemesi Freeform'da **anlamlı** değişikliktir — 1.8'deki örnekte "+0 satır" döndü, doğrulandı).
- `NOISE_RE` (151) `image$|text$` yalnızca başlıksız satırları yakalar; `text ` (boşluklu) kaçar; tasarım gereği olabilir ama belgelenmeli.
- `STOP_CODES` (261) ve `annotateServiceError` (256) köprünün `server error -1XXXX` biçimine bağlı; köprü metni değişirse tüm eşleme sessizce devre dışı kalır. `isSoftError` (74) yalnızca ilk 200 karaktere bakar.
- `substitute` (210) her değeri `String()` yapar: `timeout_ms:"{{t}}"` → `"6000"` → `Date.now() + "6000"` dize birleşimi (544) → deadline ~1,8e16 → `wait_for` metin görünene kadar **asla zaman aşımı yapmaz** (doğrulandı). `repeat`, `nth`, `ms` de dize olur. Tam `{{x}}` eşleşmesinde ham tipi koru.

### 1.12 `runBatch` koşulları (604–639)

- `dryRun` (606) `finalState=false` yapar ama `captureBefore` da kapanır → dry-run'da `output:"diff"` anlamsız; sorun değil ama dönen metin (791) `output`'u yoksayar.
- `optional` adım hata verince `last` eski kalır; ardından `lastIsFresh` (632) eski bir ağaç sonucunu "taze" sayabilir (ör. `wait_for` ok + sonra `click` optional hata → son ağaç `wait_for`'dan, click sonrası değil).
- `if_present` kontrolü `app` yoksa (618) ağaç okumadan boş ağaçla değerlendirir → her `if_present` atlanır, `if_absent` çalışır.
- `failed` olduğunda son durum okunmaz (632–633) ama `packBatch` diff/ekran görüntüsü için `last`'ı kullanır; hata anındaki gerçek ekran yerine son başarılı adımın ekranı gösterilir.
- `label` (613) `a.repeat > 1` dize karşılaştırması (`substitute` sonrası) çalışır ama kırılgan.

### 1.13 Dil karışıklığı (araç çıktıları hâlâ Türkçe)

Araç tanımları İngilizce (315–466, 478–488), ama modele dönen çalışma zamanı metinleri Türkçe. Satırlar:
79 (ekran görüntüsü atlandı), 115 (küçültüldü/ORİJİNAL), 162–164 (satır/gürültü/kısaltıldı), 203 (Notlar), 238–252 (`SERVICE_ERRORS` ipuçları Türkçe, 239 -10005 İngilizce — tek dosyada iki dil), 293 (Not: Codex…), 309 (ağaçta değişiklik yok), 504 (kök hâlâ menü/kurtarıldı), 538 (bulunamadı/Yakın adaylar), 553 (zaman aşımı), 560–564 (dry-run, gitti/göründü; 561 "slept" İngilizce), 576, 580 (odaklama tıklaması), 597 (kullanıcı durdurdu), 621 (atlandı (koşul)), 627–629 (HATA/atlandı), 637 (toplam … son okuma atlandı), 653 (hata nedeniyle…), 662, 670, 675, 679–681 (open_path logları), 706, 731 (script hata mesajları), 762 (script: HATA … eylem), 791, 795 (dry-run/makro kaydedildi), 808–813 (status), 821, 827, 832–833, 836 (screenshot), 845 (recover başarılı/BAŞARISIZ), 852, 856–857, 861, 864 (makro), 900 (eşleşme), 950 (Hata:). Yerleşik notlar (171–189) ve kod yorumları da Türkçe. Öneri: tek `t()` sözlüğü + `CUA_PLUS_LANG` (varsayılan `en`), notlar için `notes.json`'da dil anahtarı.

### 1.14 Diğer

- `loadMacros` (207) bozuk JSON'u sessizce `{}` sayar; sonraki `saveMacros` tüm makroları **siler**. Parse hatasında yazmayı reddet/yedek al.
- `list_macros` (856) `m.actions.length` — elle düzenlenmiş dosyada `actions` yoksa çöker.
- `find_elements` hata yolunda (896) `st` ekran görüntüsüyle birlikte (≈160 KB) olduğu gibi döner; `stripScreenshot` uygulanmıyor.
- `callTool` üst akış `tools/list`'i her `tools/list` isteğinde yeniden çeker (471–473); önbelleklenebilir.
- `KEY_DELAY_MS`/`SCREENSHOT_MAX_PX` (19, 21) geçersiz env'de `NaN`; `sleep(NaN)` anında döner, `!NaN` → küçültme kapanır (sessiz).
- `notesFor` (194) `includes` ile eşleşir: `"open/save panel"` anahtarı yalnızca app adı bu metni içeriyorsa gelir — hiçbir uygulama adı "open/save panel" içermez; bu notlar fiilen hiç gösterilmez (187–189). Pencere başlığına/ağaca göre tetiklenmeli.

---

## 2. Performans

Ölçülen gerçekler: UI değiştiren eylem ≈0,5 s (servis içi otur beklemesi), gözlem ≈60 ms, eylem yanıtı ağaç içermez.

1. **Tek araç yolunda eylem sonrası gözlem yok** (927–929): `click` çağrısı "Action completed…" döner; `output:"diff"` burada etkisiz (`renderResult` 302'de `looksLikeTree(after)` false → ham sonuç). Model ikinci bir `get_app_state` turu harcar (saniyeler). Öneri: `observe` seçeneği, varsayılan `true` olarak UI değiştiren eylemlerde ≈60 ms'lik `get_app_state` + diff; `observe:false` ile atlanabilsin (ör. ardışık tuşlar). Bu, kullanıcıdaki "eylemden sonra sarmalayıcı kendi get_app_state'ini çağırır" beklentisini de kod gerçeğine getirir. README "Diff output by default on every tool" iddiası şu an yalnızca `get_app_state`, `batch`, `script` için doğru.
2. **Script `app.click` sonrası otomatik gözlem yok** (692–701): tıklama = 1 IPC (iyi). Fakat `resolve` (704) bayat ağaç kullandığı için `{find}` hedefleri yanlış olabilir (1.1); ucuz çözüm: `{find}` ile hedeflemede her zaman taze `get_app_state` (≈60 ms, tıklamanın %12'si). `cua.getApp` her zaman bir `getAXState` yapar (749) — gerekli.
3. **Batch sonunda gereksiz okuma**: `lastIsFresh` (632) eylem yanıtları ağaç içermediğinden pratikte yalnızca son adım `wait_for`/`get_app_state` ise doğru; iyi. Ama `type_text find=` (578–580) önce `click` (≈0,5–0,9 s) sonra yazar; ağaçtaki `The focused UI element is <idx>` satırı hedefle aynıysa tıklama atlanabilir (≈0,5 s tasarruf).
4. **`openPathInDialog`** (660–681): `press_key ⌘⇧G` + `waitFor` (150 ms yoklama) + `set_value` + `sleep 60` + `Return` + `waitFor absent` + `waitFor Value` + `Return` + `waitFor absent` → 4 eylem ≈2 s + 4–6 gözlem. `sleep(60)` (665) gereksiz (servis bekliyor); `waitFor absent PathTextField` (668) + `waitFor Value` (669) tek döngüde birleştirilebilir.
5. **Ağaç ayrıştırma tekrarları**: `findInTree` her çağrıda `parseTree` + sorgu başına `new RegExp` (227); `lastTextUnder` (739) satır başına `findInTree` → satır başına `RegExp` derlemesi ve `clean.split("\n")` 3 kez; `script.menu` (731) adım başına 2–3 `findInTree`. `parseTree` sonucunu ağaç metnine göre memoize et (WeakMap/son metin karşılaştırması).
6. **Diff maliyeti**: `renderResult` (306+310) iki `treeDiff`; `diffText` içinde `parseTree(after)` ikinci kez (147). Küçük ama her çağrıda.
7. **Ekran görüntüsü**: `shrinkScreenshot` 3 `sips` süreci (`imageSize` ×2 + `-Z`), her biri ~30–80 ms + temp dosya; boyutu PNG IHDR/JPEG SOF başlığından okuyarak 2 spawn kalkar. Üst akış görüntüyü her yanıtta gönderiyor (≈160 KB base64 çözme) — `include_screenshot=false` iken bile `stripScreenshot` öncesi bellek/CPU; köprü seviyesinde kapatılamıyorsa kabul.
8. **`waitFor` yoklama** 150 ms + 60 ms okuma (551): makul; `timeout_ms` dize hatası (1.11) dışında sorun yok.
9. **`status`** (805) `list_apps`'i `callUpstream` yerine doğrudan `upRequest` ile çağırır: doğru (otomatik başlatma tetiklenmez).
10. **`tools/list`** her seferinde üst akışa gider (473): bir kez önbellekle.

---

## 3. API tutarlılığı

- `batch` (335): "indices are resolved from the fresh tree at each step" — yanlış (1.1). `output` açıklaması (343) "full (default)" der; `callTool` 797 `args.output` geçirir, `packBatch` 645 yalnızca `"diff"` kontrol eder → varsayılan `full` doğru ama tek araçlar için varsayılan `diff` (299, 479): aynı sunucuda iki farklı varsayılan.
- `run_macro` şeması (419–427) `auto_recover`, `dry_run`, `params` doğrulaması yok; `runBatch` 867'ye `autoRecover` geçmez (varsayılan true, tutarlı ama belgesiz). `save_as` sırasında `params` şablonu ham kaydedilir (794) — açıklama (346) ile uyumlu.
- `script` şeması: `app` açıklaması "App for final_state" ama diff tabanı `firstTree` başka uygulamanın olabilir (1.8). `output:"none"` + `include_screenshot` ekstra `get_app_state` yapar (766) — belgelenmiş (CHANGELOG 0.7.1). `timeout_ms` davranışı (iptal etmez) belgede yok.
- Pass-through araçlarda `find`/`role`/`nth` eklenirken `required`'dan yalnızca `element_index` çıkarılır (485); `click` için `x,y` alternatifi şemada görünmez (üst akış şemasına bağlı). `type_text`'e `find` eklenir (468–470) ama "önce tıklar" davranışı yalnızca kodda (578).
- `ACTION_SCHEMA.tool` enum'unda (320) `list_apps` yok ama `runAction` her aracı geçirir; `sleep_ms`/`wait_for` şema açıklamasında `args` içinde, `recover: {}` — tutarlı.
- `screenshot` (390–395): `region` açıklaması "original coordinates" — hangi çözünürlük olduğu belirsiz (1.10). `max_px` açıklaması İngilizce, çıktı Türkçe.
- Eksik `description`: `save_macro.name/description` (408), `run_macro.name/app/include_screenshot/output/final_state/compact/screenshot_on_error` (422–424), `script.include_screenshot` (377), `recover.app/include_screenshot` (400), `menu.app/include_screenshot` (439), `find_elements.app/role/limit` (448), `open_path_in_dialog.include_screenshot` (461), `save_description` (348), `batch.actions` (340), `screenshot.app/region/max_px` (393).
- Hata nesneleri: `isError` tutarsız — `packBatch` (653) `true`; `runScript` `!!error || undefined` (767, 776); `open_path_in_dialog` `!r.ok || undefined` (907); `recover` BAŞARISIZ olsa da `isError` yok (845); `menu` adım hatasında `isError` yok (890); `wait_for` zaman aşımı batch'i `failed` yapar ama tek `wait_for` aracı yok. Tek bir `fail(text, extra)` yardımcıyla standartlaştır.
- `annotateServiceError` tüm eşlenen kodlarda `isError:true` koyar (259) — `-10014 permissionsPending` gibi "bekle" durumları da hata görünür; belgelenmeli.
- `find_elements` `limit` (448) 1–50, varsayılan 20 (898) ama `findInTree` zaten 8 aday ile kırpar (233) → `limit>8` etkisiz. Hata.
- `list_apps` için `include_screenshot/output` eklenmez (477) ama `callTool` 784–785 `include_screenshot`'u her araçtan siler — tutarlı.
- MCP `initialize`: `capabilities.tools.listChanged:false` (941) ile üst akış bildirimlerinin (48) geçirilmesi çelişir.

---

## 4. Test eksikleri

Depoda hiç test yok (`package.json` bile yok; `scripts/bench.py` canlı servis ister). Birim testine uygun saf fonksiyonlar: `parseTree`, `looksLikeTree`, `treeRootIsMenu`, `windowLine`, `treeDiff`, `diffText`, `NOISE_RE`, `substitute`, `findInTree`, `annotateServiceError`, `resultText`, `isSoftError`, `stripScreenshot`, `notesFor` (dosya enjekte edilerek), `makeApp` yardımcıları `value/text/lastTextUnder` (ağaç metniyle), `packBatch` (sahte `last/log`), `renderResult`. Sahte üst akış (`callUpstream` yerine kuyruk) ile `runBatch`/`resolveTarget`/`openPathInDialog` de testlenebilir.

Engel: `server.mjs` yüklenirken `spawn(NPX)` (28) çalışır → import edilemez. Ön adım: saf fonksiyonları `lib/pure.mjs`'e taşı (veya `if (process.env.CUA_PLUS_NO_SPAWN)` koru) ve `server.mjs` oradan import etsin. Aşağıdaki dosya scratchpad'de aynı API'yi sunan kopya ile **çalıştırıldı: 7 geçti, 3 todo (bilinen hatalar)**.

```js
// test/pure.test.mjs — çalıştır: node --test test/pure.test.mjs  (servis gerekmez)
// Ön koşul: saf fonksiyonlar lib/pure.mjs'e taşınmış olmalı (server.mjs import edilince npx'i spawn eder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTree, looksLikeTree, treeRootIsMenu, treeDiff, diffText, substitute, findInTree, annotateServiceError } from "../lib/pure.mjs";

const TREE = `Window: "Untitled 3"
0 window Untitled 3
  1 button New Board, ID: nb
  2 menu bar item Insert
  3 button Insert Shape
  4 text field (settable) Value: /Users/red/x, ID: PathTextField
  5 scroll bar
  6 image
  7 image
The focused UI element is 1 button New Board`;

test("parseTree: indeks + rest", () => {
  const rows = parseTree(TREE);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[1], { index: "1", rest: "button New Board, ID: nb", line: "1 button New Board, ID: nb" });
});

test("looksLikeTree / treeRootIsMenu", () => {
  assert.equal(looksLikeTree(TREE), true);
  assert.equal(looksLikeTree("Action completed. Call get_app_state."), false);
  assert.equal(treeRootIsMenu("0 Insert, Secondary Actions: Cancel, Pick\n  1 menu"), true);
  assert.equal(treeRootIsMenu(TREE), false);
});

test("findInTree: tam > sözcük > alt dize, role süzgeci, nth", () => {
  assert.equal(findInTree(TREE, "Insert").hit.index, "2");            // sözcük (2) > alt dize (1)
  assert.equal(findInTree(TREE, "button New Board, ID: nb").hit.score, 3);
  assert.equal(findInTree(TREE, "Insert", { role: "button" }).hit.index, "3");
  assert.equal(findInTree(TREE, "/image/").hit.index, "6");
  assert.equal(findInTree(TREE, "/image/", { nth: 1 }).hit.index, "7");
  assert.equal(findInTree(TREE, "yok").hit, null);
});

test("findInTree: yol benzeri sorgu regex sanılmamalı", { todo: "server.mjs:217-218 '/a/b' → RegExp('a','bi') fırlatır" }, () => {
  assert.doesNotThrow(() => findInTree(TREE, "/Users/red/x"));
});

test("findInTree: /re/g eşleşme kaybetmemeli", { todo: "server.mjs:225 stateful re.test" }, () => {
  assert.equal(findInTree(TREE, "/image/g").candidates.length, 2);
});

test("treeDiff: indeksten bağımsız, çoğaltılmış satırları sayar", () => {
  const after = TREE.replace("  7 image\n", "").replace("1 button New Board", "9 button New Board");
  assert.deepEqual(treeDiff(TREE, after), { added: [], removed: ["image"] });
  assert.deepEqual(treeDiff(TREE, TREE + "\n  8 button Done").added, ["8 button Done"]);
});

test("diffText: gürültü gizleme ve başlık satırı", () => {
  const after = TREE.replace("  5 scroll bar\n", "");
  const out = diffText(TREE, after);
  assert.match(out, /^Window: "Untitled 3"/);
  assert.match(out, /1 gürültü satırı gizlendi/);
  assert.match(diffText(TREE, after, { compact: false }), /- scroll bar/);
});

test("substitute: {{ad}} yer tutucuları, bilinmeyen anahtar korunur", () => {
  assert.deepEqual(substitute({ a: ["x {{p}}", { b: "{{q}}" }], n: 3 }, { p: "P" }), { a: ["x P", { b: "{{q}}" }], n: 3 });
});

test("substitute: sayısal parametre tür kaybı", { todo: "server.mjs:210 her zaman String(); waitFor timeout_ms dize olur" }, () => {
  assert.equal(typeof substitute("{{t}}", { t: 6000 }), "number");
});

test("annotateServiceError: kodu adlandırır, isError koyar, bilinmeyen kodu bırakır", () => {
  const r = annotateServiceError({ content: [{ type: "text", text: "MCP error: server error -10012: stopped" }] });
  assert.equal(r.isError, true);
  assert.match(r.content.at(-1).text, /^\[userStoppedSession\]/);
  const u = { content: [{ type: "text", text: "server error -10099" }] };
  assert.equal(annotateServiceError(u), u);
});
```

Sonraki test adayları (sahte üst akış ile): `resolveTarget` eylem sonrası taze okuma yapıyor mu; `runBatch` `optional`/`if_present`/`STOP_CODES` kesmesi; `openPathInDialog` Kaydet panelinde kapanış doğrulaması; `runScript` zaman aşımı sonrası yeni IPC gitmemesi; JSON-RPC: üst akış `ping`/`elicitation` isteğine yanıt.

---

## 5. Öneri listesi (öncelik sırasıyla)

1. **Eylem sonrası ağacı geçersiz kıl, `find`'ı taze ağaçla çöz** — UI değiştiren her `callUpstream` sonrası `state.lastTree=null` ve `treeCache` kirli; `resolveTarget`/script `resolve`/`menu` isabetlerini ≈60 ms'lik okumayla doğrula. Yanlış öğeye tıklama riskini kaldırır. (524–526, 596, 704, 731, 886)
2. **`findInTree` regex ayrıştırmasını düzelt** — `^/(.+)/([gimsuy]*)$`, `g/y` bayraklarını at, geçersiz bayrakta düz metne düş; yol sorguları çalışsın. (215–218, 225)
3. **`script` zaman aşımı ve yeniden giriş** — `state.cancelled` bayrağı + `call()`'da kontrol; `Re-query` özyinelemesine tek deneme sınırı; eşzamanlı `script`/`tools/call`'ları tek kuyruğa al; gerçek iptal için `worker_threads`. (692–701, 758–759, 748)
4. **Üst akış istek/bildirim yönlendirmesi** — `ping`/`elicitation/create`/`roots/list` isteklerini alt akışa geçir (id yeniden eşleme), yanıtı geri taşı; `pending`'e 130 s zaman aşımı; `m.error.code`'u koru. (41–49, 34–40)
5. **Süreç yaşam döngüsü** — `up.on("error")`, `up.stdin.on("error")`; `detached:true` + süreç grubunu öldür; üst akış ölünce `process.exit` yerine tembel yeniden başlat; `-10000`'i `SERVICE_DOWN`'dan çıkar. (28, 33, 50–53, 265, 952)
6. **`substitute` tip koruması** — tam `{{x}}` eşleşmesinde ham değeri döndür; `waitFor` deadline'ı `Number()` ile zorla. (210, 544)
7. **`openPathInDialog` sağlamlaştırma** — `m` null kontrolü, `save-panel|open-panel` ile kapanış doğrulaması, `Value: base` yerine `Value: base(,|$)` sınırı, klasör yolunda seçim beklememe, `sleep(60)`'ı kaldır. (663–681)
8. **Tek araç yolunda `observe` seçeneği** — UI değiştiren eylemlerde varsayılan taze `get_app_state` + diff, `observe:false` ile atlanabilir; README'nin "diff on every tool" iddiasını gerçekleştirir, model turu azaltır. (910–929, 302)
9. **`recover` son çaresi** — y=12 menü çubuğu; pencere konumunu ağaçtan/`FrontmostWindow`'dan al ya da bu adımı kaldır. Görüntü/tıklama çözünürlüğü farkını belgele. (513–516, 115)
10. **`nth`/puanlama** — `nth`'yi tüm aday listesine uygula (skor sırası korunur), `(disabled)` satırlara ceza, `role` için tam sözcük eşleşmesi, Türkçe için `toLocaleLowerCase`/NFKD. (219–233)
11. **Performans küçükleri** — `parseTree` memoize, `renderResult` tek `treeDiff`, `shrinkScreenshot` boyutu başlıktan oku (2 `sips` eksik), `type_text find` için odak zaten hedefteyse tıklamayı atla, `tools/list` önbelleği. (126, 306–310, 88–93, 578, 471)
12. **`isError` ve hata biçimi standardı** — tek `fail()` yardımcı; `recover`/`menu` başarısızlığında `isError`; `tools/list` hatalarını JSON-RPC `error` ile dön; `find_elements` hata yolunda görüntüyü ayıkla. (845, 890, 949–950, 896)
13. **Makro dosyası güvenliği** — bozuk JSON'da yazmayı reddet/yedekle; `actions` yoksa `list_macros` çökmesin; `find_elements.limit`'i `findInTree`'nin 8 aday sınırıyla uyumlu yap. (207–208, 856, 233/898)
14. **Dil tekilleştirme** — çalışma zamanı metinleri için `t()` sözlüğü ve `CUA_PLUS_LANG`; `SERVICE_ERRORS` ipuçlarını tek dile çek; notlar için dil anahtarı. (bkz. 1.13 satır listesi)
15. **Belge/şema** — eksik `description`'ları doldur, `batch.output` ile tek araç `output` varsayılan farkını belirt, `script` zaman aşımının iptal etmediğini (düzeltilene kadar) ve vm'nin güven sınırı olmadığını yaz, "open/save panel" notlarının hiç tetiklenmediğini düzelt (pencere başlığına göre), `examples/scripts/multi_app_task.js:16` Calculator okumasına `waitFor` doğrulaması ekle (gerçek hatalı çıktı: docs/claude-gorev-raporu.txt "37x41: 3741"). (315–466, 187–194, 739)
