---
name: arsiv-denetci
description: Salt okunur fotoğraf/video arşivi denetimi — birebir kopyalar (SHA-256), bozuk/kesik görseller, uzantı-imza uyuşmazlığı, yıl dağılımı, en büyük dosyalar; JSON'dan tek dosyalık HTML rapor ve iki tarama arası fark. Kullanıcı "arşivi tara", "kopyaları bul", "bozuk fotoğraf var mı", "fotoğraf arşivini analiz et", "temizlik öncesi/sonrası karşılaştır" dediğinde veya bir medya klasörünün envanterini istediğinde kullan. Hiçbir dosyayı silmez, taşımaz, değiştirmez; yalnızca rapor üretir.
---

# Arşiv Denetçisi

Bu skill arşiv hakkında kanıt üretir; temizlik yapmaz. Çıktı her zaman bir rapordur (konsol, JSON veya HTML).

## Betikler (bu skill klasörüne göre)

- `scripts/arsivci.mjs` — klasörü tarar, `--json` ile makine okunur rapor verir.
- `scripts/arsiv-rapor.mjs` — arsivci JSON'unu tek dosyalık HTML raporuna çevirir.
- `scripts/karsilastir.mjs` — iki arsivci raporunu karşılaştırır; çıkış 2 = kötüleşme.

## Akış

1. Hedef klasörü netleştir. Büyük diskte önce dar bir alt klasör veya `--max-files=3000` kullan.
2. Tara:
   `node scripts/arsivci.mjs "<klasör>" --json > rapor.json`
3. Görsel rapor istenirse:
   `node scripts/arsiv-rapor.mjs rapor.json -o rapor.html`
4. Önce/sonra karşılaştırması:
   `node scripts/karsilastir.mjs eski.json yeni.json`

## Yorumlama

- **Kopya grubu** = aynı boyut + aynı SHA-256. Güvenilir.
- **Aynı ad grubu** farklı içerik olabilir; silme gerekçesi sayılmaz.
- **İmza uyuşmazlığı** çoğu zaman yanlış uzantıdır (ör. `.png` içinde JPEG), bozukluk değil.
- `truncated: true` tarama sınırına ulaşıldı demektir; sonuç eksiktir, daraltıp tekrar tara.

## Sınırlar

- Silme, taşıma, yeniden adlandırma yok. Temizlik istenirse ayrı onay ve önce `yedekci` skill'i ile yedek gerekir.
- Raporda dış URL yok; HTML yerel ve kendi kendine yeterlidir.
- Kişisel fotoğraflar hassastır: rapor yolları kullanıcının kendi makinesinde kalır, dışarı yüklenmez.

## Doğrulama

`node scripts/arsivci.mjs --version` → `1.0.0`
