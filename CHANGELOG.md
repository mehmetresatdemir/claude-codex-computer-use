# Değişiklikler

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
