# Rapor 1 — `@oai/sky` (Codex Computer Use JS kütüphanesi) ve modelin REPL sözleşmesi

Tarih: 2026-10-02 · Salt-okunur inceleme (cat/sed/grep/strings/js-beautify). Hiçbir dosya değiştirilmedi, uygulama çalıştırılmadı, model çağrısı yapılmadı.

## 0. Kapsam, sürümler, yöntem

| Paket | Sürüm | Konum |
|---|---|---|
| `@oai/sky` | 0.7.5 | `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/` (`package.json`) |
| `@oai/cua` (tinyskyAlt: `cua.getApp` burada) | 0.2.5 | `.../node_modules/@oai/cua/` |
| `@oai/cua-repl` (MCP `cua_repl` başlatıcısı) | 0.1.0 | `.../node_modules/@oai/cua-repl/` |
| `@oai/browser-desktop` (Tab API dokümanı) | 0.1.1 | `.../node_modules/@oai/browser-desktop/` |
| Swift servis `SkyComputerUseService` | — | `.../@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` (23,8 MB) |

`dist/**/*.js` dosyaları tek satırlık minified ESM. Satır numaraları aşağıda **js-beautify ile açılmış kopyalara** göredir:
- `SKY = /private/tmp/claude-501/-Users-red-Documents-ChatGPT-renk101/22e27c99-0057-4c04-b986-46da9ef92d04/scratchpad/sky_pretty/` (örn. `targets__mac__client.js` ⇔ `sky/dist/project/cua/sky_js/src/targets/mac/client.js`)
- `CUA = .../scratchpad/cua_pretty/` (⇔ `cua/dist/lib/js/oai_js_cua/src/...`)
- `STR = .../scratchpad/sky_service_strings.txt` (`strings -n 6` çıktısı, 27 536 satır)

### 0.1 Mimari — tek cümle
Model → `cua_repl`/`node_repl` (JS) → `globalThis.cua` (`@oai/cua/tinyskyAlt`) → `sky` Proxy (`@oai/sky` `sky.js`) → `nodeRepl.rpc("sky", …)` → `@oai/sky/service` (`handleRpc`) → `MacComputerUseClient` → `MacNativePipeTransport` (JSON-RPC 2.0, 4 baytlık LE uzunluk önekli çerçeve, Unix soketi) → Swift `SkyComputerUseService`. **Diff, örtük bekleme, element indeksleri, ekran görüntüsü, politika kararı ve URL engelleme tamamen Swift serviste**; JS tarafı ince bir köprü + onay/telemetri katmanıdır.

---

## 1. `cua.getApp` → `App` nesnesi: tüm metotlar

### 1.1 Nereden geliyor
- `CUA/tinysky_alt__globals.js:5-18` — banner `await import("@oai/cua/tinyskyAlt")` (`cua-repl/instructions/banner.js:1`). `CUA_REPL_ENABLED_SURFACES` zorunlu (`browser`, `computer`), `create_tinysky_alt({browser, computer})` çağrılır; sonuç `globalThis.cua` olur ve `initialize = getState` eklenir.
- `CUA/tinysky_alt__create_tinysky_alt.js:76-89` — mac için `getApp(t)`: `t` string değilse hata `"macOS getApp requires an app name, path, or bundle ID."`; `computer.get_app_state({app:t, disableDiff:true})` çağırır (**ilk gözlem her zaman tam ağaç**), `bind_mac_app(computer, state.app)` ile App üretir ve `emitter.emit(state.text)` ile ağacı modele yazar (`cua.state` item'ı).
- Linux/Windows `getApp({windowId})` (`:91-130`), `listWindows` ve `launch_app` yalnızca orada.

### 1.2 `bind_mac_app` — `CUA/tinysky_alt__bind_mac_app.js`
| Metot | Satır | Parametreler / varsayılanlar | Alt çağrı (`sky.*`) | Dönüş |
|---|---|---|---|---|
| `getAXState(options?)` | 14-19 | `{emit?:true, disableDiffing?:false}` (`i()` :111-116 `disableDiffing`→`disableDiff`) | `get_app_state({app, disableDiff})` | `Promise<string>` (ağaç/diff metni); `emit!==false` ise `nodeRepl.write(text,"cua.state")` (`CUA/core__display.js:5-13`) |
| `getScreenshot(options?)` | 20-32 | `{emit?}` | `get_app_state({app})` (**diff kapatılmaz**, yani servis diff durumunu ilerletir) | `Uint8Array` (PNG; `screenshot_bytes()` data: veya file: URL okur, `CUA/core__screenshot_bytes.js`); `screenshot===null` ise `"Screenshot unavailable for <app>."`; `nodeRepl.emitImage(bytes)` |
| `getAXStateAndScreenshot(options?)` | 33-48 | `StateOptions` | `get_app_state` | `{state, screenshot?}`; ikisini de yazar |
| `paste(text, {format?})` | 49-57 | `format` varsayılan `"text"`; `"md"`, `"html"` | `paste({app,text,format})` | `void` |
| `click(target, {mouseButton?, clickCount?})` | 58-63 | `target` sayı → `element_index`; `[x,y]` → `x,y` | `click` | `void` |
| `drag([x1,y1],[x2,y2])` | 64-73 | — | `drag({from_x,from_y,to_x,to_y})` | `void` |
| `pressKey(key)` | 74-77 | xdotool/keysym söz dizimi (`"super+c"`, `"Return"`, `"KP_0"`) | `press_key` | `void` |
| `scroll(target, direction, pages?)` | 78-85 | nesne (`{pixels}`) verilirse `"macOS scroll accepts pages, not pixels."`; pages verilmezse istemci 1 sayar | `scroll` | `void` |
| `selectText(idx, text, {prefix?, suffix?, selectionType?})` | 86-93 | `selectionType` → `selection_type` (`text`\|`cursor_before`\|`cursor_after`) | `select_text` | `void` |
| `setValue(idx, value)` | 94-98 | — | `set_value` | `void` |
| `typeText(text)` | 99-102 | — | `type_text` | `void` |
| `performSecondaryAction(idx, action)` | 103-107 | ağaçta görünen "Secondary Actions" adı; tahmin yasak | `perform_secondary_action` | `void` |

Tip sözleşmesi: `cua/dist/lib/js/oai_js_cua/src/tinysky_alt/types.d.ts:66-98` (`Target`, `App`, `Tab`), `ObservationOptions.emit` "Defaults to true" (:15-18), `StateOptions.disableDiffing` (:29-31).

### 1.3 `cua` kökündeki diğer üyeler (`create_tinysky_alt.js:48-58, 60-73`)
`getState({emit})` (uygulama+tarayıcı envanteri, `get_state.js`), `rewriteDocumentation()` (özet sonrası dokümanı tekrar yazar, `output.md:3`), `computer` (ham `sky` Proxy), `listApps({emit})`, tarayıcı tarafı `getBrowser/createBrowserTab/getTab/listBrowsers/listTabs` (`create_browser_api.js`). `globalThis.agent` = ham browser runtime (`:62`).

### 1.4 `sky` ham API (App'in altındaki katman) — `SKY/targets__mac__create_client.js:45-68`
`target:"mac"`, `list_apps`, `get_app_state(input)`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text`; `SKY_ENABLE_AUDIO=1` ise `start_audio_recording`/`stop_audio_recording` (:65-67). Her biri `withComputerUsePolicy(toolName, input, op)` ile sarılır (örn. `targets__mac__click.js:13`). `get_app_state` ek olarak `appsWithDeliveredInstructions: Set` paylaşır (:47, 51-54).
Giriş şeması (snake_case): `sky/docs/sky-window-api.md:12-120` ve `types/window/*.d.ts` (örn. `Click.d.ts:3-16`, `Scroll.d.ts`, `SelectText.d.ts`, `Paste.d.ts:8` `format` zorunlu).

### 1.5 `MacComputerUseClient` (IPC isteğini kuran sınıf) — `SKY/targets__mac__client.js`
- Sabitler :12-18 — istek tipleri `ComputerUseIPCAppPolicyRequest`, `…StartAudioRecordingRequest`, `…StopAudioRecordingRequest`, `…AppGetSkyshotRequest`, `…ListAppsRequest`, `…AppPerformActionRequest`, `…AppStartRequest`.
- Kurucu :20-23 — `apiVersion` varsayılan **`"CodexComputerUseIPC-5"`**, `timeoutSeconds` varsayılan **120**, `codexMetadata`.
- `getAppState` :39-45 — `{app, disableDiff}`.
- `click` :46-61 — `clickCount` varsayılan 1, `mouseButton` varsayılan `"left"`; hedef `h()` :205-218: `elementIndex` varsa `{elementID:{_0:"<idx>"}}`, yoksa `{coordinate:{_0:[x,y]}}`; `g()` :230-247 düğme → 0/1/2 (`l/left`, `r/right`, `m/middle`, veya 0,1,2).
- `drag` :62-74 — `{from:[x,y], to:[x,y]}`; `x()` :220-222 sonlu sayı doğrulaması.
- `paste` :75-82, `performSecondaryAction` :83-90 (`elementID` string), `pressKey` :91-98 (`{pressKey:{_0:key}}`, boş anahtar `TypeError("key is required")`), `scroll` :99-113 (`pages` varsayılan 1; `pages<=0` TypeError; yön `A()` :250-266), `setValue` :114-121, `selectText` :122-133 (`selection` varsayılan `"text"`), `typeText` :134-140 (`{type:{_0:text}}`).
- `request` :146-162 — `b()` :268-270 ile `undefined` alanları temizler, `codexMetadata` seçimi `l()` :189-191 → `nodeRepl.requestMeta["x-codex-turn-metadata"]` (:184-187). Taşıma kapalıysa önbellekten düşer (:160).
- `startApp` (:36-38) JS'te hiç çağrılmıyor (servis `get_app_state` içinde kendisi başlatıyor; SKILL.md:109).

### 1.6 `sky` Proxy ve servis RPC'si — `SKY/sky.js`, `SKY/service.js`
- `sky.js:15-21` — modül yüklenince `nodeRepl.rpc("sky", {type:"setup"})` → `{target, methods[]}`; hata olursa tüm metotlar `Promise.reject(err)` döner (:26).
- `sky.js:47-54` — her metot `rpc("sky", {type:"execute", method, args})`. `get_screenshot`/`stop_audio_recording`/linux `get_window_state` sonuçlarını `data_url`'den `bytes` üretir (:80-93, 97-106).
- `service.js:17-74` — `handleRpc`: `setup`, `execute`, linux `drag_start/move/end`. `execute` sonuçlarında `bytes` atılır, yalnız `{filepath, data_url}` taşınır (:76-81).
- `nodeRepl` dışı ortamda (`globalThis.nodeRepl` yoksa) `create_client(load_options())` doğrudan kullanılır (`sky.js:42`); `OAI_SKY_CONFIG_PATH` JSON yoksa platforma göre target (`load_options.js:5-26`).

### 1.7 Sonuç biçimi — `SKY/targets__mac__window_result.js`
`{app, screenshot: {url} | null, text}` (:18-24). Servis `skyshot` yoksa `"computer-use service did not return a screenshot"` (:9); `text` string değilse hata (:30). `appSpecificInstructions` ilk kez geldiğinde `text`'in önüne `<app_specific_instructions>\n…\n</app_specific_instructions>\n` eklenir; aynı bundle id için tek sefer (`Set`), `com.apple.iWork.Numbers` için hiç eklenmez (:4, :40-48). Servis tarafı aynı etiketi üretir (`STR:11903-11904`).

---

## 2. Örtük bekleme (settle) mantığı

**macOS'ta JS tarafında hiçbir bekleme yok.** `get_app_state`/`click` vb. doğrudan IPC'ye gider (`targets__mac__get_app_state.js:14-24`, `click.js:11-25`); `setTimeout` yalnızca taşıma zaman aşımları için kullanılır. Bekleme Swift serviste:
- Kanıt (strings): `needsUISettleBeforeSkyshot` (`STR:6786`), `AXElementBusyChanged` AX bildirim aboneliği (`STR:9367`), `userInteractionMonitor` / `userInteractionDebounceDuration` (`STR:7128` civarı), `nextInteractionTiming` imleç animasyonu kısıtı (`STR:6781, 6855-6857`), `SystemLockScreenSettleObservation`.
- Modele anlatılan davranış (SKILL.md:112): eylemden sonra **≈1 sn** bekler, uygulamada yükleme göstergesi/değişim belirtisi varsa **5 sn'ye kadar** ek bekler; `getAXState/getScreenshot` otomatik bekler, `setTimeout` kullanma (`cua/docs/tinysky-alt-core-cua-repl.md:212`).
- Sarmalayıcı README.md:26 ölçümü: ≈0,42 s settle (50 ms poll, Statsig `ui_settle_poll_interval_milliseconds`) + ≈25 ms capture + ≈10 ms ağaç; sadece-modifier tuşlar 1-3 ms.
- Servise giden tek "zaman" bilgisi: `deadlineUnixMilliseconds = Date.now() + timeoutSeconds*1000` (`native-pipe.js:179`); servis `"Request deadline exceeded"` üretebilir (`STR:7181`).
- Servis kullanıcı müdahalesini algılarsa mesaj: `"The user changed '<app>'. Re-query the latest state with \`get_app_state\` before sending more actions."` ve `"The user is still interacting with '<app>' … seconds and retry."` (`STR:7126-7129`).

**Linux'ta JS tarafında bekleme var** (karşılaştırma için): `SKY/targets__linux__action_settler.js:14-32` — `defer()` eylemden sonra `post_action_sleep_ms` (varsayılan **100 ms**) ileri bir "en erken an" koyar; `wait()` sonraki eylem/gözlemden önce bu ana kadar uyur (`click.js:11-14`, `get_window_state.js:18`).

---

## 3. Diff algoritması

**Tamamen Swift serviste.** JS yalnızca `disableDiff` bayrağını geçirir (`client.js:40-45`, `bind_mac_app.js:111-116`); diff durumu serviste uygulama başına tutulur ("önceki ağaç"); `getScreenshot()` bile `get_app_state` çağırdığından diff baseline'ını ilerletir (bu yüzden doküman "ekran görüntüsü-only gözlemden sonra tam ağaç iste" der, `tinysky-alt-core-cua-repl.md:170`).

Servis string'leri (`STR`):
- `7527` `"The following is a diff from the previous accessibility tree"`
- `7528` `"with ~, +, and - representing changed, added, and removed elements, respectively."`
- `7529` `"with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range."` + `9277` `"Removed element IDs: "` — feature flag `feature/axTreeDiffingRemovedElementIDRanges` (`13449-13450`); ana bayrak `feature/axTreeDiffing` (`13447`), `isAXTreeDiffingEnabled`, `diffFromPrevious`.
- `7530` `"The following is a cumulative diff from the initial accessibility tree"` — kümülatif mod (başlangıç ağacına göre).
- `6967` `"There has been no change"`, `7531` `"There has been no change in the accessibility tree for "` (uygulama adı eklenir).
- `1065` `AccessibilityDifferenceLineBudgetExceeded`, `6971` `"[truncated to visible range] "` — diff satır bütçesi aşılınca kesme.
- `429` `DifferenceBaseline`, `1076-1080` `UIElementRenderDifference(Buffer)`.

İndeks kayması: servis, ağacı yeniden render ettiğinde **yeni indeksler** verir; diff satırları yeni indekslerle gelir, kaldırılanlar ID (eski indeks) aralığı olarak özetlenir. Linux tarafında ise JS `ElementIds` (`targets__linux__element_ids.js:5-16`) pencere başına `native_id→id` haritası tutar ve `query` varsa eski id'leri korur; bilinmeyen id `"Unknown element ID … refresh get_window_state()"` (:25). Mac'te böyle bir JS haritası yok; "Re-query" mesajı (bkz. §2) ve `invalid_element_id` / `" is an invalid element ID"` (`STR:7178, 6975` civarı) servisten döner.

---

## 4. Hata kodları — `SKY/targets__mac__errors.js:1-23`

| Kod | Ad | Modele giden mesaj / kaynak | Önerilen davranış |
|---|---|---|---|
| -10000 | `senderProcessNotAuthenticated` | servis; köprü olmadan doğrudan başlatınca | İmzalı başlatıcı (`codex sandbox`) ile başlat; aşma yok |
| -10001 | `couldNotGetRequestData` | istek gövdesi okunamadı | İstek JSON'unu doğrula |
| -10002 | `couldNotGetRequestTypeName` | `requestType` eksik | — |
| -10003 | `couldNotResolveRequestType` | bilinmeyen tip | API sürümü uyumsuzluğu olabilir |
| -10004 | `unhandledEvent` | — | yeniden dene |
| -10005 | `unknownError` | genel; alt metinler: `"app-server exited"`, `"timed out waiting for … from codex app-server"`, `"codex app-server rejected"` (`STR:9250-9253`) | app-server kapalıysa ChatGPT.app'i aç; timeout ise bekle |
| -10006 | `appNotAllowed` | `"Computer use actions are not allowed for system security process: "` (`STR:6801`), politika `denied` | başka uygulama/yol |
| -10007 | `runningApplicationNotFound` | uygulama çalışmıyor/başlatılamadı | `get_app_state` tekrar (arka planda başlatır) |
| -10008 | `accessibilityError` | `"AX tree unexpectedly missing."`, `"UI tree capture failed."` (`STR:6811, 7125`) | yeniden `get_app_state`; ekran görüntüsüne düş |
| -10009 | `permissionsNotGranted` | Erişilebilirlik/Ekran Kaydı izni yok | kullanıcıya resmi izin akışı |
| -10010 | `invalidApp` | ad/bundle çözülemedi | `list_apps` ile bundle id kullan (SKILL.md:111) |
| -10011 | `noActiveSession` | oturum yok | yeniden başlat |
| -10012 | `userStoppedSession` | kullanıcı Esc/durdur | **döngüleri durdur**; telemetride `cancelled` (`computer-use-policy.js:142`) |
| -10013 | `incompatibleClientVersion` | `ping` sürüm uyuşmazlığı; JS tarafında da `"Sky Computer Use API version mismatch: client=… server=…"` (`native-pipe.js:191`) | istemci/servis sürümünü eşle |
| -10014 | `permissionsPending` | izin diyalogu açık | kullanıcı onayı bekle |
| -10015 | `blockedURL` | `"Computer Use stopped due to encountering a disallowed URL: "` (`STR:6914`), `ComputerUseURLBlocklistCache` | URL'yi değiştir; aşma yok |
| -10016 | `userIntervened` | `"The user changed '…'. Re-query the latest state…"` | taze `get_app_state`, sonra devam; telemetride `cancelled` |
| -10017 | `couldNotGetSenderPID` | IPC kimlik | köprü üzerinden başlat |
| -10018 | `ambiguousApp` | `"Ambiguous app identifier '…'. Multiple apps share this bundle identifier: …. Use an app name or full app path instead."` (`STR:7715-7717`) | tam `.app` yolu ver |
| -10019 | `couldNotGetBootstrapPort` | Mach bootstrap (`STR:7539-7563`) | servisi yeniden başlat |
| -10020 | `screenLocked` | ekran kilitli (`CUALockScreenGuardian`) | kullanıcı kilidi açsın |

JS tarafı sınıflar: `SkyComputerUseError{code, errorName, request, requestType}` (:25-35; bilinmeyen kod → `"jsonRPCError"`), `SkyComputerUseTransportError{cause}` (:36-40). Taşıma hataları (metin): `"Sky Computer Use native pipe is unavailable"`, `"… host service connection timed out"`, `"… host service ensure timed out"`, `"… service startup request failed"`, `"… native pipe startup failed"`, `"… <method> timed out"`, `"… native pipe closed before response"`, `"… returned an invalid JSON-RPC response"`, `"… frame is too large: N"` (`native-pipe.js:26,44,54,119,126,284,168,224,201/214`). Servisten JSON-RPC düzeyinde: `"Method not found"`, `"Response exceeds maximum frame size"`, `"Request deadline exceeded"` (`STR:7180-7182`). Eylem düzeyi metinler: `"Could not find the requested text to select in the element"`, `"Cannot set a value for an element that is not settable"`, `" is not a valid secondary action for "`, `"Menu mouse action not supported"`, `"The user may have conflicted with your paste operation…"`, `"Timed out waiting for the application to read the clipboard"` (`STR:6808-6821`).

---

## 5. Politika / onay akışı — `SKY/targets__mac__computer-use-policy.js`

`withComputerUsePolicy(toolName, input, op)` (:19-108), her eylemde:
1. `setComputerUseResponseMeta(null)` (:21) → `nodeRepl.setResponseMeta({"codex/toolSurface": {kind:"computerUse", app:{appId, kind:"appId"}}})`; app `com.google.Chrome` ise ek `"codex/computerUseChrome": true` (:153-167).
2. Girdi `f()` ile dondurulur: `app` düz veri özelliği ve boş olmayan string olmalı, aksi halde `"Computer Use app approval requires …"` (:185-203).
3. `client.getAppPolicy(app)` → `MacAppPolicyResult {decision, allowPersistentApproval, target{appPath, bundleIdentifier, displayName, risk:"high"|"low", warningSubtitle}}` (`client.d.ts:86-97`).
4. Karar (:27-39): `allowed` → devam; `denied` → `"Computer Use is blocked from using the app '<id>' by your organization's policy."`; `forbidden` → `"Computer Use is not allowed to use the app '<id>' for safety reasons."` (serviste `ComputerUseAllowForbiddenTargets` bayrağı, `STR:7707`).
5. Onay (elicitation) :40-104 — `nodeRepl.createElicitation({message:"Allow Computer Use to use \"<displayName>\"?", meta:{codex_approval_kind:"mcp_tool_call", connector_id:"computer-use", persist: allowPersistentApproval ? ["session","always"] : ["session"], riskLevel: target.risk, subtitle: warningSubtitle, tool_call_id, tool_name, tool_params:{app:bundleId}, tool_params_display:[…]}})`. Yanıt `content.source === "computer-use-persisted-state"` ise **kalıcı onay** (telemetri yok, :80-82); aksi halde `accept|cancel|decline` loglanır (:84-101). `accept` değilse `"Computer Use was not approved to use <app>"` (:103).
6. Onaylı girdide `app`, politikanın verdiği `appPath` ile değiştirilir (:105) — böylece servis belirsiz bundle id yerine tam yol alır.
7. `withComputerUseToolTelemetry` + `nodeRepl.withSuspendedTimeout` içinde eylem (:106, 134-151).

URL kuralı: JS'te yok; servis `ComputerUseURLPolicyChecking`/`AuraSiteStatusURLPolicyChecker`/`ComputerUseURLBlocklistCache` (`STR:171,176,6911`) ile `-10015` döner. Ses kaydı onayı ayrı: `"Allow Computer Use to record computer audio?"`, `riskLevel:"high"`, yalnız `["session"]` (:110-132). Uyarı metni (servis): `"Allowing ChatGPT to use this app introduces new risks, including those related to prompt injection attacks…"` (`STR:7176`).

**Dört onay modu (modele öğretilen, `cua/docs/tinysky-alt-confirmations.md`)**: 1) Hand-off (kullanıcı yapmalı: şifre değiştir son adımı, güvenlik/paywall aşma) :25-30; 2) Her zaman eylem anında onay (silme, hesap/izin/anahtar, CAPTCHA, yazılım kurma, üçüncü taraflara iletişim, abonelik, finans, sistem ayarı, tıbbi) :32-46; 3) Ön onay geçerli (login, yaş doğrulama, "emin misin", yükleme, dosya taşıma, hassas veri iletimi—veri+hedef açıkça belirtilmişse) :48-61; 4) Onay gerekmez (çerez/ToS, indirme, taksonomi dışı) :63-68. Bu metin `TINYSKY_ALT_INITIALIZE_DOCS` `core-cua-repl` ise ve `requestMeta["openai/confirmation_policies"].computer_use` (≤12 kB) yoksa çekirdeğe eklenir; `training`/`orbit` ortamında eklenmez (`CUA/tinysky_alt__create_documentation.js:5-36`).

---

## 6. `native-pipe.js` — taşıma katmanı (`SKY/targets__mac__native-pipe.js`)

- Sabitler :20-21 — `MAX_FRAME = 8 388 608` (8 MB), `HOST_TIMEOUT = 5000 ms`.
- Çerçeveleme :196-217 — `[uint32 LE uzunluk][UTF-8 JSON]`; decode kısmi tamponu tutar; 8 MB üstü → `SkyComputerUseTransportError`.
- `create(apiVersion)` :23-132: `nodeRepl.nativePipe.createConnection` zorunlu (:26). Soket yolu: `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` yoksa `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock` (:27). Önce **250 ms** bağlanma denemesi (:30); başarısızsa `ensureService` ve ardından **5000 ms** bağlanma (:124).
- `ensureService` :34-117: `NODE_REPL_HOST_SERVICES_PIPE_PATH` varsa o pipe'a JSON-RPC `{"id":0,"method":"ensureService","params":{"service":"computer-use"}}` yazar, 5 s bekler (:37-96); yoksa `nodeRepl.launchServices.openApplication` ile uygulamayı açar: `SKY_CUA_SERVICE_PATH` → `applicationPath`; `CODEX_HOME/computer-use/Codex Computer Use.app` varsa o; yoksa `bundleIdentifier:"com.openai.sky.CUAService"` (:100-115).
- `connect` :133-160: deadline'a kadar 100 ms aralıkla yeniden dener; her bağlantıda `ping` (≤1000 ms) ve `serverApiVersion === clientApiVersion` kontrolü; uyumsuzluk veya `incompatibleClientVersion` ise hemen fırlatır (:152).
- `request` :173-185: istekler **seri** (`#queue` promise zinciri); gövde `{clientApiVersion, codexTurnMetadata, deadlineUnixMilliseconds, request, requestType}`; zaman aşımı `timeoutSeconds*1000` (varsayılan 120 s).
- Kapanış :313-318 — soket kapanınca tüm bekleyenler `"… native pipe closed before response"` ile reddedilir; `client.js:160` taşımayı önbellekten atar, bir sonraki istek yeniden bağlanır (**yeniden bağlanma = tembel, istek başına**).
- Yanıt doğrulama :223-242 — `jsonrpc:"2.0"`, numerik `id`, `result` XOR `error{code:number,message:string}`.

`process.env`/`nodeRepl.env` okumaları (tüm sky dist + cua + cua-repl; grep sayımı): `SKY_CUA_SERVICE_NATIVE_PIPE_PATH`, `SKY_CUA_SERVICE_PATH`, `CODEX_HOME`, `NODE_REPL_HOST_SERVICES_PIPE_PATH`, `SKY_ENABLE_AUDIO` (mac/linux create_client), `OAI_SKY_CONFIG_PATH` (load_options), `NODE_REPL_DISABLE_ANALYTICS`, `BROWSER_USE_DISABLE_AMBIENT_NETWORK`, `BROWSER_USE_CODEX_APP_VERSION`, `BROWSER_USE_CODEX_APP_BUILD_FLAVOR`, `NODE_REPL_SENTRY_USER_ID` (telemetri), `CUA_REPL_ENABLED_SURFACES`, `CUA_REPL_BROWSER_ENV`, `CUA_REPL_BROWSER_GUIDANCE`, `CUA_REPL_NODE_REPL_PATH`, `NODE_REPL_JS_BANNER`, `NODE_REPL_TRUSTED_SERVICES`, `NODE_REPL_UNTRUSTED_ENV_ALLOWLIST`, `NODE_REPL_TOOL_OVERRIDES` (cua-repl `launch.js:24-57`), `TINYSKY_ALT_INITIALIZE_DOCS`, `WSL_DISTRO_NAME`/`USERPROFILE` (windows), `COMSPEC` (cli). cua-repl `launch.js:35` güvenilir servisleri `{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}` olarak `NODE_REPL_TRUSTED_SERVICES`'e yazar; `js` aracı `output_token_limit: 25000` (`plugin/.mcp.template.json:12`).

---

## 7. Tarayıcı `Tab` API'si ve Window2/Full Desktop farkları

`bind_tab` (`CUA/tinysky_alt__bind_tab.js:9-56`): tab'a `Target` yüzeyi eklenir; `tab.ax` varsa `ax.get("state"|"screenshot"|"both", {disableDiffing})`, yoksa Playwright `domSnapshot()` (indeks yok) / `tab.screenshot()`. Giriş metotları `ax` yoksa `"This tab does not support accessibility input. Use its Playwright API."` (:73-76). `typeText/paste/pressKey` ilk argüman `elementIndex|null` (null = mevcut odak; :78-80), 250 ms içinde odak kurulur (`types.d.ts:91-98`).

`Tab` üyeleri (`browser-desktop/environment-docs/codex-app/api.json`, `interfaces.Tab`): `ax` (AXAPI), `cua` (koordinat CUA: click/double_click/drag/keypress/move/scroll/type/downloadMedia), `dom_cua` (DOM id tabanlı: `get_visible_dom`, click, type…), `playwright` (locator'lar: `getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/locator/frameLocator`, `domSnapshot`, `elementInfo`, `elementScreenshot`, `evaluate` (salt-okunur), `expectNavigation`, `waitForLoadState/URL/Timeout/Event(download|filechooser)`; `PlaywrightLocator`: `click/dblclick/fill/type/press/pressSequentially/check/setChecked/selectOption/waitFor/innerText/textContent/getAttribute/count/first/last/nth/filter/and/or/evaluate(All)`), `content` (`export`, `exportGsuite(pdf|md|xlsx|csv|docx|pptx)`, `exportYouTubeTranscript`), `clipboard` (read/write/Text), `dev`, `capabilities`, `goto/back/forward/reload/close`, `screenshot`, `title/url`, `getJsDialog`, `markDeliverable/markHandoff/requestManualHandoff`. `Tabs`: `list/get/new/selected/content(urls)`; `BrowserUser`: `openTabs/claimTab/getTabContext`. Tarayıcı türleri `iab|extension|cdp|mcpapps` (mcpapps DOM-only). Tab mention `plugin://browser|chrome…@openai-bundled/?mention=tab-v1&browserId&tabId&title&url` (`tab_reference.js:5-27`).

| | Window (mac) | Window2 (windows) | Full Desktop (linux) |
|---|---|---|---|
| Hedef | `app` string | `window:{id,app,title}` | `window?` (yoksa masaüstü) |
| Gözlem | `get_app_state` → `{text, screenshot}` diff'li | `get_window_state({include_screenshot=true, include_text=false})` → `{accessibility{tree,focused_element,selected_text…}, screenshots[{id,zIndex,origin}]}` | `get_window_state({include_screenshot, query})` → `{ax_tree (nesne, to_string), ax_tree_source: at_spi\|x11, screenshots}` |
| Kaydırma | `pages` | `scrollX/scrollY` delta + koordinat zorunlu | `pixels` + element_id/koordinat |
| Ek | `paste(text,md,html)`, `select_text`, `set_value`, `press_key` | `launch_app`, `activate_window`, `screenshotId` koordinat eşlemesi | `launch_app`, `activate_window`, `drag(path)`, `drag_handle`, `move`, `move_relative`, `key_down/up`, `clipboard_read/write/release`, `click.duration/key`, `get_screenshot` |
| Eksik | — | `select_text`, `paste` (text-only), element scroll | `select_text`, `set_value` |
Kaynaklar: `sky/docs/sky-window-api.md`, `sky-window2-api.md`, `sky-full-desktop-api.md`.

---

## 8. Telemetri — `SKY/targets__mac__computer-use-telemetry.js`

Statsig istemcisi (`@statsig/js-client`), anahtar `client-br04gw…` (:14), `api https://ab.chatgpt.com/v1`, `logEventUrl https://chatgpt.com/ces/v1/rgstr` (:15-16); `nodeRepl.fetch` üzerinden; kullanıcı kimliği `NODE_REPL_SENTRY_USER_ID` ve **`https://chatgpt.com/backend-api/me`** çağrısı ile e-posta/id (:117-128). Kapatma: `NODE_REPL_DISABLE_ANALYTICS=1` veya `BROWSER_USE_DISABLE_AMBIENT_NETWORK=1` (:159-162). Tier: `BROWSER_USE_CODEX_APP_BUILD_FLAVOR` dev/agent→development, internal-alpha/nightly→staging (:169-180).

Olaylar (`eventName:"__protobuf_structured_event__"`, `@type: openai.buf.dev/openai/protobuf-analytics-events/…v1.<Ad>`, `runtime:"CODEX_COMPUTER_USE_MCP_RUNTIME_NODE_REPL"`):
- `CodexComputerUseMcpServerLaunched {transport:"stdio"}` — istemci oluşturulunca, bir kez (:20-24; `create_client.js:46`).
- `CodexComputerUseMcpAppApprovalRequested {bundleIdentifier, toolName}` (:26-31).
- `CodexComputerUseMcpAppApprovalResolved {approvalResult: accepted|canceled|declined, approvalPersistence: always|session}` (:33-41).
- `CodexComputerUseMcpToolCalled {durationMs, invocationSource:"code_mode", mcpErrorPresent, mcpServerName:"node_repl", pluginId:"computer-use@openai-bundled", terminalStatus: completed|failed|cancelled, toolName, transport:"native_pipe", bundleIdentifier?, threadId?, turnId?, itemId?, model?, reasoningEffort?}` (:43-84) — tur meta `x-codex-turn-metadata`'dan.
Servis tarafında ayrıca `CodexComputerUseIdleTimeoutReached`, `…PermissionRequested/WindowShown/GrantFinished` (`STR:4034-4037`).

---

## 9. Modele verilen talimatlar (özet)

Kaynaklar: `cua/docs/tinysky-alt-core-cua-repl.md` (çekirdek, cua_repl), `…-core-node-repl.md` (node_repl varyantı), `…-confirmations.md`, `…-other-browser-apis.md`, `cua-repl/instructions/macos/{description,computer,browser,output}.md`, `sky/docs/skills/oai_sky_lib/macos/SKILL.md`, servis içi `AppInstructions/*.md`.

Kurallar (özet):
1. Tüm UI işi `cua_repl` JS ile; AppleScript/JXA/System Events/CGEvent yok (core:5-6). Özel eklenti/API varsa onu tercih et.
2. İlk çağrıda **tam olarak bir** giriş çağrısı (`cua.getState()` / `getApp` / `getTab` / `createBrowserTab`); ekstra bekleme/snapshot ekleme; dönen doküman ve ilk durumu oku (description.md:3-5).
3. Eylemlerden sonra karar vermeden önce `getAXState()`; indeksleri taze ağaçtan türet, eskiyi kullanma (core:168).
4. Varsayılan diff'i tercih et; `{disableDiffing:true}` sadece tam ağaç gerektiğinde; ekran görüntüsü-only gözlemden sonra tam ağaç al (core:170).
5. Deterministik eylemleri ve son `getAXState()`'i **tek çağrıda** topla; `getApp/getTab/createBrowserTab` ilk durumu zaten gösterir (core:173-175).
6. "No change" dönerse araya eylem koymadan tekrar sorma; sadece eksik bağlam tanımlanabiliyorsa screenshot/full iste (core:176).
7. Görünür sonuç yeterliyse "Show All" gibi geniş UI açma; sonuç göründüğünde dur (core:177-178).
8. Çıktı: gözlem metotları kendileri yazar; `nodeRepl.write/emitImage` ile tekrar yazma; `{emit:false}` ile kapat; ilk-kullanım dokümanı yine gösterilir (core:195-199).
9. Elementle hedeflemeyi koordinata tercih et; AX çalışmazsa screenshot+koordinat; DOM-only tab'da Playwright (core:203).
10. `paste` biçimli/çok satırlı metin için; mac panoyu geri yükler; `format` açıkça ver (core:204, SKILL.md:133-141).
11. `scroll` mac'te sayfa; `selectText` linux/windows'ta yok; `setValue` linux'ta yok (core:205-206).
12. `performSecondaryAction` yalnız ağaçta listelenen eylemler; isim tahmin etme (core:208).
13. `pressKey` xdotool söz dizimi (`super+c`, `KP_0`) (core:210).
14. `getApp` mac'te ad/yol/bundle id; ad çözülmezse bundle id ile tekrar dene; uygulama arka planda başlatılır (core:211).
15. `setTimeout` ile bekleme; dahili bekleme yeterli (core:212).
16. Görev tamamen bitene kadar sürdür; "denedim" bitmiş değildir; durum görünür biçimde doğrulanmalı (core:215).
17. Özetle başlayan bağlamda `await cua.rewriteDocumentation()` (output.md:3).
18. Tarayıcı seçimi öncelik sırası: mention → url+browser → tabId+browser → `createBrowserTab("iab", url, {visible})` → adlı tarayıcı → `getBrowser({url})`; chrome/edge için emoji'li `sessionName` (browser.md).
19. Onay politikası dört modu (§5).
20. Uygulama özel notlar (servis `appSpecificInstructions`): Apple Music (arama `set-value`, "Scroll Up/Down" eylemleri, çift tık oynat), Clock (zamanlayıcı slider'larına tıkla+yaz, `set value` kullanma), iPhone Mirroring (⌘1/2/3, scroll kullan drag değil), Notion (blok/Return/cmd+a davranışı), Numbers (1 tık ekle / 3 tık değiştir, satırı \t ile tek `type_text`), Slack (`set_value` kullan, `type_text` \n gönderir; ipucu metninden Return/Shift+Return'ü oku), Spotify (gecikmeli güncelleme; uyuma, tekrar `get-state`).

---

## 10. Sarmalayıcımızda eksik olan ve eklenebilecek 10 somut özellik

Sarmalayıcı: `/Users/red/Documents/claude-codex-computer-use/server.mjs` (v0.7.2; `script`, `batch`, diff, notlar, makrolar, `menu`, `open_path_in_dialog`, `recover`, `status`, `screenshot`). Köprü (`npx claude-codex-computer-use@latest`) üstünden geçirilen araçlar: `get_app_state, click, press_key, type_text, set_value, scroll, drag, select_text, perform_secondary_action, list_apps` (README.md:46, `ACTION_SCHEMA` :320).

1. **`paste(text, {format:"text"|"md"|"html"})`** — Codex'in biçimli/çok satırlı giriş için tercih ettiği yol (SKILL.md:131-141); pano geri yüklenir. Bizde yok (ACTION_SCHEMA enum'unda ve `makeApp`'te yok). Nasıl: köprü `paste`'i geçiriyorsa `makeApp.paste` + ACTION_SCHEMA'ya ekle; geçirmiyorsa köprüye PR (IPC `AppPerformActionRequest{paste:{text,format}}`, `client.js:75-82`). `"The user may have conflicted with your paste operation"` metnini `annotateServiceError`'a ekle.
2. **Servis diff'ini doğrudan kullan (`disableDiff`)** — `get_app_state` IPC'si `disableDiff` alıyor (`client.js:40-45`); servis `~/+/-` ve "Removed element IDs" biçiminde, satır bütçeli, kullanıcı-değişimi farkında diff üretiyor. Bizim `treeDiff` (server.mjs:139-151) multiset eşleme; `~` (değişen) kavramı yok, indeks kaymasını "sil+ekle" olarak gösteriyor. Nasıl: köprü `disableDiff` parametresini geçiriyorsa `output:"service-diff"` seçeneği ekle; `getApp`'te ilk gözlemi `disableDiff:true` ile al (Codex gibi, `create_tinysky_alt.js:84`), sonrakileri servis diff'iyle.
3. **`emit:false` eşdeğeri + gözlem metotlarının `script` içinde "görünmez" kalması** — Codex'te `getAXState({emit:false})` modele hiç yazmaz; bizde `script` zaten ağaçları değişkende tutuyor ama `getAXStateAndScreenshot` ekran görüntüsünü sona erteliyor (:354). Nasıl: `app.getScreenshot({emit})` ve `app.getAXStateAndScreenshot({emit, disableDiffing})` imzalarını Codex'inkiyle birebir yap (`bind_mac_app.js:14-48`); `emit:true` ise sonuca o anki görüntüyü/ağacı ek içerik olarak koy.
4. **`-10012/-10016` ile "Re-query" davranışını Codex gibi ele al** — `makeApp.call` (:328) "Re-query" metninde otomatik yeniden okuyup **aynı eylemi tekrar deniyor**; servis bunu "kullanıcı araya girdi, tekrar bakmadan devam etme" olarak tasarlamış (`STR:7126-7129`). Nasıl: tekrar denemeden önce `state.lastTree` yenile ve `find` hedeflerini yeniden çöz; `-10016` için `e.stop=true` (zaten), ayrıca `"still interacting … seconds"` metnindeki saniyeyi parse edip o kadar bekle.
5. **Uygulama onay/politika ön kontrolü (`getAppPolicy`)** — Codex her eylemden önce `AppPolicyRequest` ile `allowed|denied|forbidden`, `risk`, `warningSubtitle`, `appPath` alır (`computer-use-policy.js:25-39`). Bizde yok; `-10006` sonradan gelir. Nasıl: köprü/IPC üzerinden `get_app_policy` aracı veya `status`'a `policy(app)`; dönen `appPath`'i sonraki çağrılarda `app` olarak kullan (belirsiz bundle id `-10018`'i önler).
6. **Uygulama-özel talimatları (servis `appSpecificInstructions`) tek sefer gösterme ve bizim notlarla birleştirme** — Servis Music/Clock/Notion/Numbers/Slack/Spotify/iPhone Mirroring için `<app_specific_instructions>` döner (`window_result.js:40-48`); köprü bunu metnin içinde geçiriyor olabilir ama bizim `treeDiff` bu bloğu "satır" sayıp diff'e gömüyor. Nasıl: `resultText` içinde `<app_specific_instructions>…</app_specific_instructions>` bloğunu ayır, `withNotes` ile birlikte uygulama başına bir kez göster; ağaç ayrıştırmasından çıkar.
7. **Cumulative diff modu** — Servis "cumulative diff from the initial accessibility tree" destekliyor (`STR:7530`); `script` sonunda biz zaten `firstTree`'ye göre diff veriyoruz (:404) ama `batch`'te değil. Nasıl: `batch.output:"diff"` için `captureBefore` varsayılanını açıp başlangıç ağacını baz al; `diff_base: "first"|"last"` parametresi.
8. **Tarayıcı sekmeleri için `getTab`/Playwright locator yolu** — Codex, Chrome için ayrı `Tab` API'si (AX indeksli + `getByRole/fill/click` locator'ları, `domSnapshot`, `waitForURL`) kullanır; biz Chrome'u yalnızca AX ağacıyla sürüyoruz. Nasıl: `script` içine `cua.getTab(url)` → mevcut Claude-in-Chrome MCP araçlarına köprü (`find/form_input/javascript_tool`) veya en azından `app.waitFor(/Window: ".*- Google Chrome"/)` + `pressKey("super+l")`/`typeText(url)` makrosu; Chrome tespitinde `"codex/computerUseChrome"` benzeri bayrakla notları değiştir.
9. **`list_apps` zenginleştirme ve `startApp`** — `SkyDiscoveredApp` `appPath`, `isFrontmost`, `lastUsedDate`, `useCount` taşıyor (`client.d.ts:4-12`); `AppStartRequest` ayrı bir IPC (`client.js:36-38`). Nasıl: `status`/`list_apps` çıktısında `isFrontmost` ve `appPath` göster; `find_apps(query)` ile ad→bundle→yol çözümü; ilk `getApp`'te yol kullan.
10. **Zaman aşımı/deadline ve kuyruk semantiğini açığa çıkar** — Taşıma istekleri seri ve `timeoutSeconds` (120 s) ile `deadlineUnixMilliseconds` gönderiyor (`native-pipe.js:173-185`); `nodeRepl.withSuspendedTimeout` uzun eylemleri korur. Bizde `script.timeout_ms` var ama tek tek eylemler için yok; paralel `Promise.all` çağrıları köprüde sıraya giriyor olabilir. Nasıl: `makeApp` eylemlerine `{timeout_ms}` opsiyonu, `batch` adımlarına `timeout_ms`; `script` dokümanına "eylemler seri çalışır, `Promise.all` hız kazandırmaz" notu; `status`'a ping/version mismatch (`-10013`) kontrolü.

Ek küçük adaylar: `press_key` boş anahtar/`pages<=0` gibi istemci-tarafı TypeError doğrulamalarını (`client.js:92,101`) `batch.dry_run`'a taşımak; `select_text.selection_type` ve `click.mouse_button` kısaltmalarını (`l/r/m`, `u/d`) kabul etmek; `SKY_ENABLE_AUDIO` ses kaydı araçlarını (`start/stop_audio_recording`, 100–300 000 ms) opsiyonel geçirmek.
