# Değişiklikler

## 0.4.1 — 2026-10-02

- **Gecikme ölçümü**: tıklama ~650–1500 ms, arayüzü değiştirmeyen tuş ~10 ms, değiştiren tuş ~500 ms; taban maliyet servisin eylem sonrası "otur" beklemesi (uygulamadan bağımsız, ayarlanamıyor; boru hattı kazandırmıyor). Tablo README'de.
- `open_path_in_dialog`: seçim doğrulandıktan sonra OK'a tıklamak yerine Return (yaklaşık 0,5 s kazanç); panel kapanmazsa düğmeye tıklama yedeği. Sabit beklemeler kısaltıldı.
- `batch`/`run_macro`: son eylem tam ağaç döndürdüyse ekstra `get_app_state` atlanır (~120 ms).

## 0.4.0 — 2026-10-02

- **`compact` diff** (varsayılan açık): kaydırma çubuğu, ok/sayfa düğmeleri, tutamaç, ayırıcı ve başlıksız image/text/cell satırları diff'ten gizlenir; gizlenen sayı yazılır. Gerçek koşuda +38/−47 satırlık diff'in çoğu buydu.
- **Adım süreleri**: batch/makro günlüğünde her adımın ms'si ve toplam süre (+ re-query sayısı).
- **Hatada ekran görüntüsü** (`screenshot_on_error`, varsayılan açık): bir adım durursa küçültülmüş görüntü otomatik eklenir, sonuç `isError` olur.
- **Uygulama notları**: `get_app_state`/`batch`/`run_macro` sonuçlarına uygulamaya özel bilinen tuzaklar bir kez iliştirilir (yerleşik Freeform notları; `~/.codex-cua-plus/notes.json` ile ekle: `{"freeform": ["..."], "numbers": ["..."]}`; anahtar uygulama adında alt dize olarak aranır).
- İlk gerçek Claude Code koşusu: `run_macro("freeform_insert")` → 1 çağrı, 6 adım, resim eklendi.

## 0.3.0 — 2026-10-02

- **`output: "diff"`** (`batch`, `run_macro`): tam ağaç yerine pencere satırı + batch öncesine göre eklenen/silinen satırlar (indeksten bağımsız karşılaştırma) + odak satırı.
- **Makrolar**: `save_macro` / `run_macro` / `list_macros`. `~/.codex-cua-plus/macros.json` (`CUA_PLUS_MACRO_DIR`). Dizelerdeki `{{param}}` çalıştırmada doldurulur; eksik parametre hata verir. Örnek: `examples/macros/freeform_insert.json` (6 adım, 6,8 sn).
- **`recover`** aracı ve `batch` içinde otomatik kurtarma (`auto_recover`, varsayılan açık): ağaç kökü açık/takılı bir menüyse ve `find` orada bulamazsa Escape → menünün Cancel eylemi → başlık çubuğuna koordinatla tıklama; her adım doğrulanır.
- `open_path_in_dialog` ve `recover` artık batch eylemi olarak da kullanılabilir (makrolara girebilir).

## 0.2.0 — 2026-10-02

- **`find` ile metinle hedefleme**: `click`, `set_value`, `scroll`, `select_text`, `perform_secondary_action` ve `batch` eylemlerinde `element_index` yerine `find` (alt dize veya `/regex/`), isteğe bağlı `role` ve `nth`. İndeks son ağaçtan çözülür; bulunamazsa taze ağaç alınıp bir kez daha denenir, yine yoksa yakın adaylar listelenir.
- **`wait_for`** batch eylemi: metin görünene/kaybolana kadar bekleme (`timeout_ms`, `absent`).
- **`menu`** aracı: menü çubuğundan yol tıklama; hedef görünürse ara adımları atlar.
- **`find_elements`** aracı: yalnızca eşleşen satırlar.
- **Ekran görüntüsü küçültme**: `include_screenshot:true` iken `sips` ile 1280 px (JPEG kalite 70); orijinal boyut ve koordinat çarpanı metne eklenir. `CUA_PLUS_SCREENSHOT_MAX_PX`, `CUA_PLUS_JPEG_QUALITY`.
- **`open_path_in_dialog`** sağlamlaştırıldı: dosya adının listede seçili görünmesi beklenir, panelin OK düğmesi (`OKButton`) ağaçtan bulunup tıklanır; adım günlüğü döner.
- `batch` günlüğü artık çözülen indeksi ve satırı gösterir.

## 0.1.0 — 2026-10-01

- İlk sürüm: `batch`, `press_key.repeat`, `open_path_in_dialog`, isteğe bağlı ekran görüntüsü, idle 10 dk, `-10005`'te ChatGPT.app'i otomatik açma, temiz kapanma.
