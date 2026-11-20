---
name: promptscope
description: Talimat/prompt dosyası risk taraması — kimlik devri, öncelik iddiası, ret bastırma, yetenek sözleşmesi, gizli veri hedefi, gizli sıfır genişlikli karakterler; 0-100 skor ve satır kanıtlı bulgular. Kullanıcı "bu prompt güvenli mi", "talimat dosyasını denetle", "jailbreak mi", "prompt incele", "promptscope" dediğinde kullan.
---

# PromptScope

Bir metin/instruksiyon dosyasının model davranışını devralmaya çalışıp çalışmadığını sezgisel kurallarla işaretler. Karar mercii değil, işaretçidir.

## Betik

`scripts/promptscope.mjs` — sıfır bağımlılık.

## Akış

1. Tek dosya:
   `node scripts/promptscope.mjs "<dosya>" --no-color`
2. Klasör:
   `node scripts/promptscope.mjs "<klasör>" --json`
3. Kuralları listele:
   `node scripts/promptscope.mjs --list-rules`

## Yorumlama

- 0–19 DÜŞÜK, 20–39 ORTA, 40–64 YÜKSEK, 65+ KRİTİK.
- Bulgular kategori + ağırlık + satır kanıtı taşır; skor sezgiseldir.
- Meşru stil dosyaları da düşük skor alabilir; asıl sinyal **kimlik devri + öncelik iddiası + ret bastırma** üçlüsüdür.
- `skipped` dizisi ikili/okunamayan dosyaları bildirir; sessiz atlama yok.

## Sınırlar

- Salt okunur; dosyayı değiştirmez.
- Terminale basılan snippet'lerden kontrol karakterleri temizlenir.
- UTF-16 (BOM'lu) dosyalar desteklenir.

## Doğrulama

`node scripts/promptscope.mjs --version` → `1.0.0`
