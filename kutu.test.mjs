import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, restoreSnapshot, latestSnapshot, listSnapshotsSync, snapshotFailSummary,
  cmdYedekle, writeReport, copyTree, TOOLS, VERSION, DEFAULT_DEST, COMMAND_FLAGS,
} from './kutu.mjs';
import { MANIFEST, snapshot } from './yedekci.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'kutu.mjs');

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kutu-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Gerçekçi manifest: files/links/createdAt dolu, hash'ler diskteki içerikle uyuşur.
// rel biçimi yedekci ile aynı olmalı (Windows'ta yol ayracı ters bölü), yoksa verify "fazla" der.
function writeSnap(root, name, files, extra = {}) {
  const dir = path.join(root, name);
  const entries = [];
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const buf = Buffer.from(body);
    fs.writeFileSync(p, buf);
    const st = fs.statSync(p);
    entries.push({ rel: path.relative(dir, p), size: st.size, mtimeMs: st.mtimeMs, hash: sha(buf), action: 'copied' });
  }
  const links = extra.links || [];
  const manifest = {
    tool: 'yedekci', version: '1.0.0',
    createdAt: extra.createdAt || '2026-11-12T10:00:00.000Z',
    source: extra.source || dir, snapshot: name, mode: extra.mode || 'full',
    files: entries, links,
    summary: {
      files: entries.length, bytes: entries.reduce((a, e) => a + e.size, 0),
      copied: entries.length, linked: 0, skipped: 0, unreadable: 0, symlinks: links.length,
      toolong: 0, links: links.length, linkRecreated: links.length,
      linkCopied: 0, linkErrors: 0, locked: 0, mismatches: 0, errors: 0,
    },
  };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  return dir;
}

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', windowsHide: true, cwd: opts.cwd || HERE,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('CLI: --version sürüm basar, çıkış 0', () => {
  const r = cli(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
});

test('CLI: --help ve -h yardım basar, çıkış 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = cli([flag]);
    assert.equal(r.status, 0, `${flag} çıkış 0 vermeli`);
    assert.match(r.stdout, /kutu v\d+\.\d+\.\d+ — araç takımı tek giriş/);
  }
});

test('CLI: bayraksız çağrı menü basar, çıkış 1', () => {
  const r = cli([]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /kutu v\d+\.\d+\.\d+ — araç takımı tek giriş/);
  assert.match(r.stdout, /yedekle/);
});

test('CLI: bilinmeyen komut hata verir', () => {
  const r = cli(['olmayan-is']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Bilinmeyen komut/);
});

test('parseArgs: komut, bayraklar ve inline değerler', () => {
  const a = parseArgs(['durum', '--json']);
  assert.equal(a.command, 'durum');
  assert.equal(a.json, true);
  assert.equal(a.error, null);

  const b = parseArgs(['yedekle', '--dest=/x/y', '--full']);
  assert.equal(b.dest, '/x/y');
  assert.equal(b.full, true);

  const c = parseArgs(['yedekle', '--dest']);
  assert.match(c.error, /--dest için bir değer gerekli/);

  const d = parseArgs(['durum', '--bilinmeyen']);
  assert.match(d.error, /Bilinmeyen argüman/);

  assert.equal(parseArgs([]).dest, DEFAULT_DEST);
});

test('TOOLS: her yönlendirme hedefi diskte var', () => {
  for (const [name, file] of Object.entries(TOOLS)) {
    assert.ok(fs.existsSync(path.join(HERE, file)), `${name} -> ${file} bulunamadı`);
  }
});

test('restoreSnapshot: dosyaları getirir, manifesti hedefte tutar', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, '2026-11-12_10-00-00_test', { 'a.txt': 'A', 'sub/b.txt': 'BB' });
  const to = path.join(root, 'geri');
  const r = await restoreSnapshot(snap, to);
  assert.equal(r.ok, true);
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(to, 'a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(to, 'sub', 'b.txt'), 'utf8'), 'BB');
  assert.equal(fs.existsSync(path.join(to, MANIFEST)), true);
  assert.equal(r.bytes, 3);
  assert.equal(r.verifyOk, true);
});

test('restoreSnapshot: dolu hedefi ve manifestsiz klasörü reddeder', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's1', { 'a.txt': 'A' });
  const to = path.join(root, 'dolu');
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'var.txt'), 'x');
  const busy = await restoreSnapshot(snap, to);
  assert.equal(busy.ok, false);
  assert.match(busy.error, /Hedef dolu/);

  const sag = path.join(root, 'manifestsiz');
  fs.mkdirSync(sag);
  const bad = await restoreSnapshot(sag, path.join(root, 'hedef2'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Manifest yok/);
});

test('latestSnapshot: en yeni adlı snapshot seçilir', (t) => {
  const root = mkTmp(t);
  writeSnap(root, '2026-11-10_09-00-00_a', { 'a.txt': 'A' }, { createdAt: '2026-11-10T09:00:00.000Z' });
  writeSnap(root, '2026-11-12_11-12-41_b', { 'b.txt': 'B' }, { createdAt: '2026-11-12T11:12:41.000Z' });
  const r = latestSnapshot(root);
  assert.equal(r.ok, true);
  assert.equal(r.name, '2026-11-12_11-12-41_b');
  assert.equal(r.files, 1);
  assert.equal(listSnapshotsSync(root).snapshots.length, 2);
});

test('latestSnapshot: boş veya olmayan hedef hata verir', (t) => {
  const empty = mkTmp(t);
  const r = latestSnapshot(empty);
  assert.equal(r.ok, false);
  assert.match(r.error, /snapshot yok/);
  const missing = latestSnapshot(path.join(empty, 'yok'));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Hedef bulunamadı/);
});

// ---------- F1: kısmi başarısızlıkta sayaçlar ve çıkış 2 ----------

test('F1: snapshotFailSummary gerçek sayaç alanlarını tek satıra döker', () => {
  const line = snapshotFailSummary({
    errors: [{ rel: 'a.txt', code: 'EBUSY', locked: true }],
    mismatches: [{ rel: 'b.txt', kind: 'hash' }],
    toolong: 3, unreadable: 4, linkErrors: 5, locked: 1,
  });
  for (const re of [/uyuşmazsı=1/, /hata=1/, /toolong=3/, /okunamaz=4/, /link hatası=5/, /kilitli=1/]) {
    assert.match(line, re);
  }
  assert.doesNotMatch(line, /undefined/);
});

test('F1: error alanı olmayan kısmi başarısızlık çıkış 2 + sayaç satırı verir', async (t) => {
  const root = mkTmp(t);
  const errs = [];
  const orig = console.error;
  t.after(() => { console.error = orig; });
  console.error = (m) => errs.push(String(m));
  let code;
  try {
    code = await cmdYedekle({
      dest: path.join(root, 'hedef'), src: root, full: false, exclude: [], json: false,
      snapshotImpl: async () => ({
        ok: false, snapshotDir: path.join(root, 'snap'), source: root,
        files: 2, bytes: 2, copied: 2, linked: 0, skipped: 0, unreadable: 1, symlinks: 0, toolong: 0,
        locked: 1, linkRecreated: 0, linkCopied: 0, linkErrors: 2,
        errors: [{ rel: 'a.txt', locked: true }], mismatches: [{ rel: 'b.txt', kind: 'hash' }], links: [],
      }),
    });
  } finally {
    console.error = orig;
  }
  assert.equal(code, 2);
  const out = errs.join('\n');
  assert.doesNotMatch(out, /undefined/);
  assert.match(out, /Kısmi hata  : uyuşmazsı=1, hata=1, toolong=0, okunamaz=1, link hatası=2, kilitli=1/);
});

test('F1: kullanım hatası (error alanı) çıkış 1 ve gerçek mesaj basar', (t) => {
  const root = mkTmp(t);
  const r = cli(['yedekle', '--src', path.join(root, 'yok.pdf'), '--dest', path.join(root, 'd')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Yedek hatası: Kaynak bulunamadı/);
  assert.doesNotMatch(r.stderr, /undefined/);
});

// ---------- F2: geri yükleme hataları yakalanır, yarım kopya temizlenir ----------

test('F2: kopya patlarsa kendi açtığımız hedef silinir, tek satır hata kalır', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's', { 'a.txt': 'A' });
  const to = path.join(root, 'yarim');
  const r = await restoreSnapshot(snap, to, { force: true, copyImpl: () => { throw new Error('kurmaca kopya hatası'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Geri yükleme hatası: kurmaca kopya hatası$/);
  assert.equal(fs.existsSync(to), false);
});

test('F2: önceden var olan hedef klasör asla silinmez', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's', { 'a.txt': 'A' });
  const to = path.join(root, 'kullanici');
  fs.mkdirSync(to);
  const r = await restoreSnapshot(snap, to, { force: true, copyImpl: () => { throw new Error('pat'); } });
  assert.equal(r.ok, false);
  assert.equal(r.cleaned, false);
  assert.equal(fs.existsSync(to), true);
});

test('F2: CLI hatalı hedefte ham Node yığını değil Türkçe tek satır basar', (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's', { 'a.txt': 'A' });
  const dosya = path.join(root, 'engel.txt');
  fs.writeFileSync(dosya, 'x');
  const r = cli(['geri-yukle', '--from', snap, '--to', path.join(dosya, 'alt')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Geri yükleme hatası:/);
  assert.doesNotMatch(r.stderr, /node:internal| {4}at /);
  assert.equal(fs.existsSync(path.join(dosya, 'alt')), false);
});

// ---------- F3: doğrulama önce, bağlar yeniden kurulur, manifest hedefte kalır ----------

test('F3b: sahte hashli snapshot geri yüklemeyi durdurur, --force ile uyuşmazlık raporlanır', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's', { 'a.txt': 'A' });
  const mp = path.join(snap, MANIFEST);
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files[0].hash = 'F'.repeat(64);
  fs.writeFileSync(mp, JSON.stringify(m));

  const to = path.join(root, 'geri');
  const r = await restoreSnapshot(snap, to);
  assert.equal(r.ok, false);
  assert.match(r.error, /Snapshot doğrulanamadı/);
  assert.match(r.error, /--force/);
  assert.equal(fs.existsSync(to), false);

  const f = await restoreSnapshot(snap, path.join(root, 'zorla'), { force: true });
  assert.equal(f.ok, true);
  assert.equal(f.verifyOk, false);
  assert.match(f.verifySummary, /değişmiş=1/);
});

test('F3b: manifest hedefte doğrulanabilir kalır, --no-manifest siler', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's', { 'a.txt': 'A' });
  const kept = path.join(root, 'kalan');
  await restoreSnapshot(snap, kept);
  assert.equal(fs.existsSync(path.join(kept, MANIFEST)), true);
  const stripped = path.join(root, 'silinen');
  const r = await restoreSnapshot(snap, stripped, { noManifest: true });
  assert.equal(fs.existsSync(path.join(stripped, MANIFEST)), false);
  assert.equal(r.manifestKept, false);
});

test('F3a: iç bağ restore ağacına işaret eder, harici bağ maddeleştirilmez', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 's', { 'a.txt': 'A', 'sub/b.txt': 'BB' });
  const sub = path.join(snap, 'sub');
  const internal = path.join(snap, 'bag-ic');
  const external = path.join(snap, 'bag-dis');
  const dishep = path.join(root, 'harici');
  fs.mkdirSync(dishep);
  fs.writeFileSync(path.join(dishep, 'dev.txt'), 'X'.repeat(4096));

  let madeInternal = false;
  let madeExternal = false;
  try { fs.symlinkSync(sub, internal, process.platform === 'win32' ? 'junction' : 'dir'); madeInternal = true; } catch { /* yetki yok */ }
  try { fs.symlinkSync(dishep, external, process.platform === 'win32' ? 'junction' : 'dir'); madeExternal = true; } catch { /* yetki yok */ }

  const links = [];
  if (madeInternal) links.push({ rel: 'bag-ic', target: sub, external: false, isDir: true, action: 'link' });
  if (madeExternal) links.push({ rel: 'bag-dis', target: dishep, external: true, isDir: true, action: 'link' });
  const mp = path.join(snap, MANIFEST);
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.links = links;
  m.summary.links = links.length;
  m.summary.symlinks = links.length;
  fs.writeFileSync(mp, JSON.stringify(m));

  const to = path.join(root, 'geri');
  const r = await restoreSnapshot(snap, to, { force: true });
  assert.equal(r.ok, true);
  if (madeInternal) {
    assert.equal(r.linkRecreated, 1);
    const p = path.join(to, 'bag-ic');
    assert.ok(fs.lstatSync(p).isSymbolicLink(), 'iç bağ yeniden kurulmadı');
    assert.ok(fs.realpathSync(p).startsWith(fs.realpathSync(to)), 'bağ hâlâ snapshot klasörüne işaret ediyor');
    assert.equal(fs.readFileSync(path.join(p, 'b.txt'), 'utf8'), 'BB');
  } else {
    assert.equal(r.linkRecreated, 0);
  }
  if (madeExternal) {
    assert.equal(r.linkSkippedExternal, 1);
    assert.equal(fs.existsSync(path.join(to, 'bag-dis')), false, 'harici bağ maddeleştirildi (veri şişmesi)');
  }
});

test('F3: gerçek snapshot -> geri yükleme uçtan uca döngüsü', (t) => {
  const root = mkTmp(t);
  const src = path.join(root, 'kaynak');
  fs.mkdirSync(path.join(src, 'alt'), { recursive: true });
  fs.writeFileSync(path.join(src, 'not.txt'), 'merhaba');
  fs.writeFileSync(path.join(src, 'alt', 'veri.bin'), Buffer.from('123456789'));
  const dest = path.join(root, 'dest');
  const r = cli(['yedekle', '--src', src, '--dest', dest, '--full']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Doğrulama   : TEMİZ/);

  const g = cli(['geri-yukle', '--dest', dest, '--to', path.join(root, 'geri')]);
  assert.equal(g.status, 0, g.stderr + g.stdout);
  assert.match(g.stdout, /Kaynak      : .*createdAt: /);
  assert.match(g.stdout, /Doğrulama   : TEMİZ/);
  assert.equal(fs.readFileSync(path.join(root, 'geri', 'not.txt'), 'utf8'), 'merhaba');
  assert.equal(fs.readFileSync(path.join(root, 'geri', 'alt', 'veri.bin'), 'utf8'), '123456789');
});

// ---------- F4: createdAt ile sıralama, sayısal sayaç, bozuk manifest sayımı ----------

test('F4: aynı saniyede _2 tuzağı değil createdAt belirler', (t) => {
  const root = mkTmp(t);
  writeSnap(root, '2026-11-12_10-00-00_x_2', { 'a.txt': 'A' }, { createdAt: '2026-11-12T09:00:00.000Z' });
  writeSnap(root, '2026-11-12_10-00-00_x_10', { 'b.txt': 'B' }, { createdAt: '2026-11-12T10:30:00.000Z' });
  const r = latestSnapshot(root);
  assert.equal(r.name, '2026-11-12_10-00-00_x_10');
  assert.equal(r.createdAt, '2026-11-12T10:30:00.000Z');
});

test('F4: createdAt eşitse klasör sayacı sayısal karşılaştırılır', (t) => {
  const root = mkTmp(t);
  const same = '2026-11-12T10:00:00.000Z';
  writeSnap(root, '2026-11-12_10-00-00_x_9', { 'a.txt': 'A' }, { createdAt: same });
  writeSnap(root, '2026-11-12_10-00-00_x_10', { 'b.txt': 'B' }, { createdAt: same });
  assert.equal(latestSnapshot(root).name, '2026-11-12_10-00-00_x_10');
});

test('F4: bozuk manifest sessizce atlanmaz, bad sayılır', (t) => {
  const root = mkTmp(t);
  writeSnap(root, '2026-11-12_10-00-00_ok', { 'a.txt': 'A' });
  const kirik = path.join(root, '2026-11-11_10-00-00_kirik');
  fs.mkdirSync(kirik, { recursive: true });
  fs.writeFileSync(path.join(kirik, MANIFEST), '{ bozuk json');
  const l = listSnapshotsSync(root);
  assert.equal(l.ok, true);
  assert.equal(l.snapshots.length, 1);
  assert.equal(l.bad, 1);
  const r = cli(['geri-yukle', '--dest', root, '--to', path.join(root, 'geri')]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /createdAt/);
});

test('F4: yalnız bozuk manifest varsa hata mesajı sayıyı içerir', (t) => {
  const root = mkTmp(t);
  const d = path.join(root, '2026-11-11_10-00-00_kirik');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, MANIFEST), 'bozuk');
  const r = latestSnapshot(root);
  assert.equal(r.ok, false);
  assert.match(r.error, /1 bozuk/);
});

// ---------- F5: argüman katılığı ----------

test('F5: komuta yabancı bayrak tek satırda reddedilir', () => {
  assert.ok(COMMAND_FLAGS.durum.has('--json'));
  assert.equal(COMMAND_FLAGS.durum.has('--dest'), false);
  const a = parseArgs(['durum', '--dest', '/z', '--full']);
  assert.match(a.error, /^durum komutu --dest kabul etmez\.$/);
  const b = parseArgs(['yedekle', '--force']);
  assert.match(b.error, /^yedekle komutu --force kabul etmez\.$/);
  const c = parseArgs(['geri-yukle', '--to', 'C:/x', '--force', '--no-manifest']);
  assert.equal(c.error, null);
  assert.equal(c.force, true);
  assert.equal(c.noManifest, true);
});

test('F5: bayrak-önce biçimi ve araç yönlendirme korunur', () => {
  const a = parseArgs(['--json', 'durum']);
  assert.equal(a.command, 'durum');
  assert.equal(a.json, true);
  assert.equal(a.error, null);

  const b = parseArgs(['--dest', 'D:/x', 'yedekle']);
  assert.equal(b.error, null);
  assert.equal(b.dest, 'D:/x');
  assert.equal(b.command, 'yedekle');

  const t = parseArgs(['arsiv', '--limit', '5']);
  assert.equal(t.command, 'arsiv');
  assert.deepEqual(t.toolArgs, ['--limit', '5']);
});

test('F5: --version komutla birlikte çalışır, kutu tekrarı uyarılır', () => {
  assert.equal(parseArgs(['--version', 'durum']).error, null);
  assert.equal(parseArgs(['--version', 'durum']).version, true);
  const r = cli(['--version', 'durum']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);

  const k = cli(['kutu', 'durum']);
  assert.equal(k.status, 1);
  assert.match(k.stderr, /kutu'yu tekrar etme/);
});

test('F5: TOOLS tablosunda kutu yok, durum --dest CLI dan sızamaz', () => {
  assert.equal(TOOLS.kutu, undefined);
  const r = cli(['durum', '--dest', '/z', '--full']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /durum komutu --dest kabul etmez/);
});

// ---------- F6: dry-run, exclude, --src ----------

test('F6: --dry-run hedef yazmadan planı gösterir, --exclude kümesi uygulanır', (t) => {
  const root = mkTmp(t);
  const src = path.join(root, 'kaynak');
  fs.mkdirSync(path.join(src, 'atla'), { recursive: true });
  fs.writeFileSync(path.join(src, 'atla', 'x.txt'), 'X');
  fs.writeFileSync(path.join(src, 'kalan.txt'), 'KK');
  const dest = path.join(root, 'dest');
  const r = cli(['yedekle', '--src', src, '--dest', dest, '--dry-run', '--exclude=atla', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout).dryRun;
  assert.equal(plan.dryRun, true);
  assert.equal(plan.files, 1);
  assert.equal(fs.existsSync(dest), false, 'dry-run hedef klasörü oluşturdu');
});

test('F6: --src ve --exclude gerçek yedeğe iletilir', async (t) => {
  const root = mkTmp(t);
  const src = path.join(root, 'kaynak');
  fs.mkdirSync(path.join(src, 'dev'), { recursive: true });
  fs.writeFileSync(path.join(src, 'dev', 'big.bin'), 'Y'.repeat(128));
  fs.writeFileSync(path.join(src, 'kalan.txt'), 'KK');
  const dest = path.join(root, 'dest');
  const logs = [];
  const orig = process.stdout.write;
  t.after(() => { process.stdout.write = orig; });
  process.stdout.write = (m) => logs.push(String(m));
  const code = await cmdYedekle({ dest, src, full: true, exclude: ['dev'], dryRun: false, json: true });
  process.stdout.write = orig;
  assert.equal(code, 0);
  const listed = latestSnapshot(dest);
  assert.equal(listed.ok, true);
  const m = JSON.parse(fs.readFileSync(path.join(listed.snapshotDir, MANIFEST), 'utf8'));
  assert.deepEqual(m.files.map((f) => f.rel), ['kalan.txt']);
});

test('F6: hedef kaynağın içindeyse yedekci hatası F1 biçiminde çıkış 1 verir', (t) => {
  const root = mkTmp(t);
  const src = path.join(root, 'kaynak');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.txt'), 'A');
  const r = cli(['yedekle', '--src', src, '--dest', path.join(src, 'ic')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Yedek hatası: Hedef, kaynağın içinde olamaz/);
});

test('F3a/F4: gerçek snapshot iç bağıyla uçtan uca: bağ yeniden kurulur, en yeni _2 değil _10', async (t) => {
  const root = mkTmp(t);
  const src = path.join(root, 'kaynak');
  fs.mkdirSync(path.join(src, 'veri'), { recursive: true });
  fs.writeFileSync(path.join(src, 'veri', 'a.txt'), 'AAA');
  fs.writeFileSync(path.join(src, 'kayit.txt'), 'KAYIT');
  let madeLink = false;
  try {
    fs.symlinkSync(path.join(src, 'veri'), path.join(src, 'bag'), process.platform === 'win32' ? 'junction' : 'dir');
    madeLink = true;
  } catch { /* yetki yok: bağ alanı olmadan da akış doğrulanır */ }

  const dest = path.join(root, 'dest');
  let first = await snapshot(src, dest, { incremental: false });
  assert.equal(first.ok, true, snapshotFailSummary(first));
  const second = await snapshot(src, dest, { incremental: false });
  assert.equal(second.ok, true);
  if (madeLink) {
    assert.ok(second.links.length >= 1, 'snapshot iç bağı manifeste yazmadı');
    assert.equal(second.links[0].external, false);
  }

  const latest = latestSnapshot(dest);
  assert.equal(latest.name, path.basename(second.snapshotDir), 'createdAt sıralaması yanlış snapshot seçti');
  const secondManifest = JSON.parse(fs.readFileSync(path.join(second.snapshotDir, MANIFEST), 'utf8'));
  assert.equal(latest.createdAt, secondManifest.createdAt, 'createdAt manifest değeriyle uyuşmuyor');
  assert.ok(path.basename(first.snapshotDir) !== path.basename(second.snapshotDir), 'ikinci snapshot aynı klasörü kullandı');

  const to = path.join(root, 'geri');
  const r = await restoreSnapshot(latest.snapshotDir, to);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.verifyOk, true, r.verifySummary);
  assert.equal(fs.readFileSync(path.join(to, 'kayit.txt'), 'utf8'), 'KAYIT');
  if (madeLink) {
    assert.ok(r.linkRecreated + r.linkMaterialized >= 1, 'iç bağ ne kuruldu ne maddeleştirildi');
    if (r.linkRecreated === 1) {
      const p = path.join(to, 'bag');
      assert.ok(fs.realpathSync(p).startsWith(fs.realpathSync(to)));
      assert.equal(fs.readFileSync(path.join(p, 'a.txt'), 'utf8'), 'AAA');
    }
  }
});

test('parseArgs: durum --out kabul eder, yedekle reddeder, değer zorunlu', () => {
  const bos = parseArgs(['durum', '--out', 'kutu-test-sonucu.json']);
  assert.equal(bos.error, null, bos.error);
  assert.equal(bos.outFile, 'kutu-test-sonucu.json');
  const esit = parseArgs(['durum', '--out=rapor/sonuc.json']);
  assert.equal(esit.error, null, esit.error);
  assert.equal(esit.outFile, 'rapor/sonuc.json');
  assert.equal(parseArgs(['durum']).outFile, null, '--out verilmezse dosya yazılmaz');
  const yabanci = parseArgs(['yedekle', '--out', 'x.json']);
  assert.match(String(yabanci.error), /--out/, 'yedekle --out kabul etmemeli');
  const degersiz = parseArgs(['durum', '--out']);
  assert.match(String(degersiz.error), /değer gerekli/);
});

test('writeReport: eksik alt klasörü açar, ayrıştırılır JSON yazar, mutlak yol döner', (t) => {
  const dir = mkTmp(t);
  const hedef = path.join(dir, 'alt', 'kutu-test-sonucu.json');
  const abs = writeReport({ ok: true, summary: { totalTests: 90, failedTests: 0 } }, hedef);
  assert.equal(abs, hedef);
  assert.ok(path.isAbsolute(abs));
  const r = JSON.parse(fs.readFileSync(abs, 'utf8'));
  assert.equal(r.ok, true);
  assert.equal(r.summary.totalTests, 90);
  assert.ok(fs.readFileSync(abs, 'utf8').endsWith('\n'), 'dosya sonu satır sonu bitmeli');
});

test('copyTree: nlink>1 varsayılanda kopyalanır, link:true hedefte inode korur', (t) => {
  const root = mkTmp(t);
  const src = path.join(root, 'kaynak');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.dat'), 'MERHABA');
  fs.linkSync(path.join(src, 'a.dat'), path.join(src, 'b.dat'));
  fs.writeFileSync(path.join(src, 'tek.txt'), 'TEK');

  const kopya = path.join(root, 'kopya');
  const r1 = copyTree(src, kopya, {});
  assert.equal(r1.shared, 2, 'iki dosya zincirde paylaşılıyor olmalı');
  assert.equal(r1.linked, 0, 'bayraksız hardlink kurulmamalı');
  assert.equal(r1.copied, 3);
  assert.ok(r1.sharedBytes > 0, 'kazanç paydasız raporlanmamalı');
  assert.notEqual(fs.statSync(path.join(kopya, 'a.dat')).ino, fs.statSync(path.join(src, 'a.dat')).ino);

  const bag = path.join(root, 'bag');
  const r2 = copyTree(src, bag, { link: true });
  assert.equal(r2.linked, 2, 'nlink>1 iki dosya da bağlanmalı');
  assert.equal(r2.copied, 1, 'nlink==1 dosya kopyalanmalı');
  assert.equal(r2.linkFallback, 0);
  assert.equal(fs.statSync(path.join(bag, 'a.dat')).ino, fs.statSync(path.join(src, 'a.dat')).ino);
  assert.equal(fs.statSync(path.join(bag, 'b.dat')).ino, fs.statSync(path.join(src, 'a.dat')).ino);
  assert.equal(fs.readFileSync(path.join(bag, 'b.dat'), 'utf8'), 'MERHABA');
  assert.equal(fs.readFileSync(path.join(bag, 'tek.txt'), 'utf8'), 'TEK');
});

test('restoreSnapshot: paydasili her kosumda raporlar, link:true hedefe tasir', async (t) => {
  const root = mkTmp(t);
  const snap = writeSnap(root, 'snap', { 'a.dat': 'ZINCIR', 'dup.dat': 'ZINCIR' });
  fs.rmSync(path.join(snap, 'dup.dat'));
  fs.linkSync(path.join(snap, 'a.dat'), path.join(snap, 'dup.dat'));

  const to1 = path.join(root, 'geri1');
  const r1 = await restoreSnapshot(snap, to1);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.sharedFiles, 2, 'zincir paylaşımı ölçülmedi');
  assert.equal(r1.sharedBytes, 12, 'paylaşılan bayt yanlış');
  assert.equal(r1.linkedFiles, 0);
  assert.equal(r1.verifyOk, true, r1.verifySummary);

  const to2 = path.join(root, 'geri2');
  const r2 = await restoreSnapshot(snap, to2, { link: true });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.linkedFiles, 2);
  assert.equal(fs.statSync(path.join(to2, 'a.dat')).ino, fs.statSync(path.join(snap, 'a.dat')).ino);
  assert.equal(r2.verifyOk, true, r2.verifySummary);
});

test('parseArgs: --link yalnız geri-yukle komutunda geçerli', () => {
  assert.equal(parseArgs(['geri-yukle', '--link']).link, true);
  assert.equal(parseArgs(['geri-yukle']).link, false);
  assert.match(String(parseArgs(['yedekle', '--link']).error), /--link/);
  assert.match(String(parseArgs(['durum', '--link']).error), /--link/);
});

test('CLI: --json başarısız geri yükleme ayrıştırılır nesne basar, undefined sızmaz', (t) => {
  const dir = mkTmp(t);
  const r = spawnSync(process.execPath, [CLI, 'geri-yukle', '--dest', path.join(dir, 'yok'), '--json'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /Hedef bulunamadı/);
  assert.ok(!/undefined/.test(`${r.stdout}${r.stderr}`), 'hata nedeni undefined olarak düştü');
});
