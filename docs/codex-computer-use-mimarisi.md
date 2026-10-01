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
