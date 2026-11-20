---
name: aidoctor
description: Hermes ve FreeAgent AI kurulum denetimi — çözülemeyen env değişkenleri, bilinmeyen sağlayıcı referansları, satır içi anahtarlar, yinelenen env adları, katalog farkı, FreeAgent sağlığı; sır değerlerini asla yazdırmaz. Kullanıcı "AI kurulumunu kontrol et", "Hermes config doğrula", "sağlayıcı sağlık", "anahtar sızıntısı var mı", "aidoctor" dediğinde kullan.
---

# AI Doctor

Yerel AI yığınını (Hermes + FreeAgent) çevrimdışı denetler. Çıktıda anahtar değeri yoktur; yalnızca ad, satır ve sayı.

## Betik

`scripts/aidoctor.mjs` — sıfır bağımlılık.

## Akış

1. Varsayılan (çevrimdışı):
   `node scripts/aidoctor.mjs --no-color`
2. Makine okunur:
   `node scripts/aidoctor.mjs --json`
3. Yerel uçları da yokla (anahtar göndermez, yalnız localhost):
   `node scripts/aidoctor.mjs --network`
4. Özel yollar:
   `node scripts/aidoctor.mjs --hermes "<dizin>" --freeagent "<dizin>"`

## Yorumlama

- **HATA** = yapılandırma kırık veya referans çözülmüyor (çıkış 2).
- **UYARI** = riskli ama çalışır (yinelenen env, satır içi anahtar, bağsız Gemini).
- **BİLGİ** = farkındalık (katalog farkı, process-only env).
- Aynı anahtar hem `config.yaml` içinde hem `.env`'de varsa tek kaynağa indirilmesini öner.

## Sınırlar

- Sır değerleri hiçbir modda yazdırılmaz; sanitizer sızıntı görürse rapor üretilmez.
- `--network` yalnız localhost GET yapar, Authorization başlığı göndermez.
- Dosyalara yazmaz; öneri verir, düzeltmeyi kullanıcı onayıyla ayrı iş yap.

## Doğrulama

`node scripts/aidoctor.mjs --version` → `1.0.0`
