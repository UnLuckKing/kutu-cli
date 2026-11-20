---
name: yedekci
description: Doğrulamalı yedekleme — snapshot kopyası, SHA-256 manifest, artımlı hardlink, symlink/junction koruma, verify ile eksik/değişmiş/fazla dosya tespiti. Kullanıcı "yedek al", "snapshot", "D:'ye yedekle", "yedek doğrula", "silmeden önce yedekle" dediğinde kullan. Kaynak dosyalara asla yazmaz; hedefe yazmadan önce kullanıcıdan onay ister.
---

# Yedekçi

Kaynağı yalnız okur, hedefe snapshot yazar ve yazdığını yeniden okuyup doğrular.

## Betik

`scripts/yedekci.mjs` — sıfır bağımlılık, Node >= 20.

## Akış

1. Hedefi ve kapsamı netleştir. Varsayılan öneri: `~/kutu-backups/<proje>`.
2. **Yazmadan önce onay al** (kaynak, hedef, tahmini boyut).
3. Kuru çalıştırma:
   `node scripts/yedekci.mjs snapshot "<kaynak>" "<hedef>" --dry-run`
4. Gerçek snapshot (aynı sürücüde artımlı):
   `node scripts/yedekci.mjs snapshot "<kaynak>" "<hedef>" --incremental`
5. Doğrula:
   `node scripts/yedekci.mjs verify "<snapshot-klasörü>"`
6. Envanter:
   `node scripts/yedekci.mjs list "<hedef>"`

## Davranış

- Her dosyanın SHA-256'sı manifeste yazılır; kopya yazıldıktan sonra yeniden okunup hash karşılaştırılır.
- `--incremental` yalnız aynı sürücüde hardlink bağlar; başarısız olursa kopyalar.
- Symlink/junction'lar hedefiyle kaydedilir; kaynak ağacı içindeki hedefler snapshot içine çevrilir (kendi kendine yeterli yedek). Kaynak dışı hedefler `external: true` ile işaretlenir.
- Eksik anahtar yok: `verify` çıkış 2 = eksik/değişmiş/fazla.

## Sınırlar

- Hiçbir silme yok; snapshot klasörleri yalnız eklenir.
- Hedef kaynağın içindeyse araç reddeder.
- Hedefte yer olduğunu kontrol et; büyük arşivlerde önce `--dry-run`.
- Dış linkler yedekten bağımsızdır; raporda görünür.

## Doğrulama

`node scripts/yedekci.mjs --version` → `1.0.0`
