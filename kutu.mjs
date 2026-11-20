#!/usr/bin/env node
// kutu — araç takımının tek girişi: durum, yedekle, geri-yükle ve alt araç yönlendirmesi.
// Sıfır bağımlılık, Node >= 20, ESM. Kaynak dosyalara yalnız okuma; geri-yükle yeni klasöre yazar.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { runAll } from './dogrula.mjs';
import { snapshot, verifySnapshot, listSnapshots, fmtBytes, MANIFEST } from './yedekci.mjs';

const VERSION = '1.0.0';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEST = process.env.KUTU_BACKUP_DEST || path.join(os.homedir(), 'kutu-backups');

// Yönlendirme tablosu: komut -> araç dosyası.
const TOOLS = {
  prompt: 'promptscope.mjs',
  ai: 'aidoctor.mjs',
  arsiv: 'arsivci.mjs',
  rapor: 'arsiv-rapor.mjs',
  karsilastir: 'karsilastir.mjs',
  yedek: 'yedekci.mjs',
  dogrula: 'dogrula.mjs',
  senkron: 'senkron.mjs',
};

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// ---------- argümanlar ----------

// Komut başına kabul edilen bayraklar; yabancı bayrak sessiz no-op olmasın diye reddedilir.
const COMMAND_FLAGS = {
  durum: new Set(['--json', '--out']),
  yedekle: new Set(['--dest', '--src', '--full', '--dry-run', '--exclude', '--json']),
  'geri-yukle': new Set(['--dest', '--from', '--to', '--force', '--no-manifest', '--link', '--json']),
};
const GLOBAL_FLAGS = new Set(['--help', '-h', '--version', '-v']);
const VALUE_FLAGS = new Set(['--dest', '--src', '--from', '--to', '--exclude', '--out']);

function parseArgs(argv) {
  const out = {
    command: null, dest: DEFAULT_DEST, src: null, to: null, from: null,
    full: false, dryRun: false, exclude: [], force: false, noManifest: false, link: false,
    json: false, help: false, version: false, error: null, toolArgs: [], outFile: null,
  };
  const positionals = [];
  const flags = [];
  const args = argv.slice();
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (typeof raw !== 'string' || !raw.startsWith('-')) { positionals.push(raw); continue; }
    let name = raw;
    let value = null;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 0) { name = raw.slice(0, eq); value = raw.slice(eq + 1); }
    if (VALUE_FLAGS.has(name) && value === null) {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) { out.error = `${name} için bir değer gerekli.`; return out; }
      value = next;
      i++;
    }
    flags.push([name, value]);
  }

  out.command = positionals.length > 0 ? positionals[0] : null;
  if (out.command === 'kutu') {
    out.error = "kutu'yu tekrar etme: komutu doğrudan ver (node kutu.mjs durum).";
    return out;
  }
  if (out.command && TOOLS[out.command]) {
    const at = args.indexOf(out.command);
    out.toolArgs = at < 0 ? [] : args.filter((_, k) => k !== at);
    return out;
  }
  if (positionals.length > 1) { out.error = `Bilinmeyen argüman: ${positionals[1]}`; return out; }
  if (out.version || out.help) return out;

  const allowed = out.command ? COMMAND_FLAGS[out.command] : null;
  for (const [name, value] of flags) {
    if (GLOBAL_FLAGS.has(name)) {
      if (name === '--help' || name === '-h') out.help = true;
      else out.version = true;
      continue;
    }
    if (!allowed) { out.error = `Bilinmeyen argüman: ${name}`; return out; }
    if (!allowed.has(name)) {
      const knownElsewhere = Object.values(COMMAND_FLAGS).some((set) => set.has(name));
      out.error = knownElsewhere ? `${out.command} komutu ${name} kabul etmez.` : `Bilinmeyen argüman: ${name}`;
      return out;
    }
    if (VALUE_FLAGS.has(name) && (value === null || String(value).trim() === '')) {
      out.error = `${name} için bir değer gerekli.`;
      return out;
    }
    switch (name) {
      case '--json': out.json = true; break;
      case '--full': out.full = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--force': out.force = true; break;
      case '--no-manifest': out.noManifest = true; break;
      case '--link': out.link = true; break;
      case '--dest': out.dest = value; break;
      case '--src': out.src = value; break;
      case '--from': out.from = value; break;
      case '--to': out.to = value; break;
      case '--exclude': for (const x of String(value).split(',')) if (x.trim()) out.exclude.push(x.trim()); break;
      case '--out': out.outFile = String(value).trim(); break;
      default: break;
    }
  }
  return out;
}

// ---------- geri yükleme ----------

// snapshot() kısmi başarısızlıkta error alanı dönmez; nedenler sayaçlarda kalır.
function snapshotFailSummary(r) {
  const errors = Array.isArray(r.errors) ? r.errors.length : Number(r.errors || 0);
  const mismatches = Array.isArray(r.mismatches) ? r.mismatches.length : Number(r.mismatches || 0);
  return `uyuşmazsı=${mismatches}, hata=${errors}, toolong=${Number(r.toolong || 0)}, okunamaz=${Number(r.unreadable || 0)}, link hatası=${Number(r.linkErrors || 0)}, kilitli=${Number(r.locked || 0)}`;
}

function verifySummary(v) {
  return `eksik=${(v.missing || []).length}, değişmiş=${(v.changed || []).length}, fazla=${(v.extra || []).length}, bağ=${(v.links || []).length}`;
}

// Raporu hem ekrana hem dosyaya aynı içerikle yazar; dönen değer mutlak yol.
function writeReport(obj, file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
  return abs;
}

// Ağacı elle kopyalar: içeriği aynı inode'u paylaşan dosyalar (nlink>1) varsayılan olarak
// kopyalanır, --link verilirse kaynak inode'a bağlanır. Bağlar (symlink/junction) atlanır;
// onlar manifest üzerinden restoreSnapshot'ta kurulur.
function copyTree(from, to, opts = {}) {
  const res = { copied: 0, linked: 0, linkFallback: 0, shared: 0, sharedBytes: 0, warnings: [] };
  const walk = (s, d, depth) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (isLink(sp)) continue;
      if (e.isDirectory()) { walk(sp, dp, depth + 1); continue; }
      let st;
      try { st = fs.statSync(sp); } catch { res.warnings.push(`  okunamayan dosya atlandı: ${path.relative(from, sp)}`); continue; }
      if (st.nlink > 1) { res.shared++; res.sharedBytes += st.size; }
      if (opts.link && st.nlink > 1) {
        try { fs.linkSync(sp, dp); res.linked++; continue; }
        catch (e) { res.linkFallback++; res.warnings.push(`  hardlink kurulamadı (${e.code || 'ERR'}), kopyalandı: ${path.relative(from, sp)}`); }
      }
      fs.copyFileSync(sp, dp); res.copied++;
    }
  };
  walk(from, to, 0);
  return res;
}

// Snapshot'ı yeni klasöre döner: önce kaynağı doğrular, bağları yeniden kurar, manifesti hedefte tutar.
async function restoreSnapshot(snapshotDir, targetDir, opts = {}) {
  const from = path.resolve(snapshotDir);
  const to = path.resolve(targetDir);
  const manifestPath = path.join(from, MANIFEST);
  if (!fs.existsSync(manifestPath)) return { ok: false, error: `Manifest yok: ${from}` };

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, error: `Manifest okunamadı: ${from} (${e.message})` }; }

  if (to === from) return { ok: false, error: `Kaynak ve hedef aynı: ${from}` };

  if (!opts.force) {
    const pre = await verifySnapshot(from);
    if (!pre.ok) {
      const why = pre.error ? pre.error : verifySummary(pre);
      return { ok: false, error: `Snapshot doğrulanamadı (${from}): ${why}. Zorlamak için --force ver.` };
    }
  }

  const existedBefore = fs.existsSync(to);
  if (existedBefore && fs.readdirSync(to).length > 0) {
    return { ok: false, error: `Hedef dolu, boş klasör ver: ${to}` };
  }

  const links = manifest.links || [];
  const warnings = [];
  let createdByUs = false;
  let linkRecreated = 0;
  let linkSkippedExternal = 0;
  let linkMaterialized = 0;
  let linkFailed = 0;
  let files = 0;
  let bytes = 0;
  const noCopy = { copied: 0, linked: 0, linkFallback: 0, shared: 0, sharedBytes: 0, warnings: [] };
  let copyRes = noCopy;

  try {
    if (!existedBefore) { fs.mkdirSync(to, { recursive: true }); createdByUs = true; }
    // Bağlar kopyaya dahil edilmez; hepsi manifestten elle kurulur.
    copyRes = opts.copyImpl ? (opts.copyImpl(from, to) || noCopy) : copyTree(from, to, { link: !!opts.link });
    for (const w of copyRes.warnings || []) warnings.push(w);

    for (const l of links) {
      const target = path.join(to, l.rel);
      if (l.action === 'error') { linkFailed++; warnings.push(`  bağ yedekte de yoktu: ${l.rel}`); continue; }
      if (l.action === 'copied-link') { linkMaterialized++; continue; }
      if (l.external) { linkSkippedExternal++; continue; }
      const rebased = path.resolve(to, path.relative(from, path.resolve(l.target)));
      const source = path.resolve(l.target);
      try {
        if (!inside(to, rebased)) throw Object.assign(new Error('bağ hedefi snapshot dışına taşıyor'), { code: 'EXDEV' });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(rebased, target, l.isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
        linkRecreated++;
      } catch (e) {
        try {
          fs.cpSync(source, target, { recursive: true, dereference: true });
          linkMaterialized++;
          warnings.push(`  bağ kurulamadı (${e.code || 'ERR'}), maddeleştirildi: ${l.rel}`);
        } catch (e2) {
          fs.rmSync(target, { recursive: true, force: true });
          linkFailed++;
          warnings.push(`  bağ kurulamadı ve maddeleştirilemedi (${e2.code || 'ERR'}): ${l.rel}`);
        }
      }
    }

    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else if (dir === to && e.name === MANIFEST) continue;
        else {
          try { files++; bytes += fs.statSync(p).size; } catch { /* okunamayan girdi sayılmaz */ }
        }
      }
    };
    walk(to);
  } catch (e) {
    // Yarım kopyayı yalnız kendi oluşturduğumuz klasörde temizle.
    if (createdByUs) fs.rmSync(to, { recursive: true, force: true });
    return { ok: false, error: `Geri yükleme hatası: ${e.message}`, from, to, cleaned: createdByUs };
  }

  const verify = await verifySnapshot(to);
  const fileIssues = [...(verify.missing || []), ...(verify.changed || []), ...(verify.extra || [])];
  const verifyOk = fileIssues.length === 0;
  if (opts.noManifest) fs.rmSync(path.join(to, MANIFEST), { force: true });

  return {
    ok: true, from, to, files, bytes,
    createdAt: manifest.createdAt || null,
    mode: manifest.mode || 'bilinmiyor',
    manifestKept: !opts.noManifest,
    linkRecreated, linkSkippedExternal, linkMaterialized, linkFailed, warnings,
    linkedFiles: copyRes.linked, copiedFiles: copyRes.copied, linkFallback: copyRes.linkFallback,
    sharedFiles: copyRes.shared, sharedBytes: copyRes.sharedBytes,
    verifyOk, verifySummary: verifySummary(verify), fileIssues,
  };
}

// Ad sayacı (_2 / _10) aynı saniyede çakıştığı için sıralama manifest createdAt ile yapılır.
function nameCounter(name) {
  const m = /_(\d+)$/.exec(String(name));
  return m ? Number(m[1]) : 0;
}

function sortSnapshots(snaps) {
  return snaps.sort((a, b) => {
    const ka = String(a.createdAt || '');
    const kb = String(b.createdAt || '');
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ca = nameCounter(a.snapshot);
    const cb = nameCounter(b.snapshot);
    if (ca !== cb) return ca - cb;
    return String(a.snapshot).localeCompare(String(b.snapshot));
  });
}

function listSnapshotsSync(dest) {
  let entries;
  try { entries = fs.readdirSync(dest, { withFileTypes: true }); }
  catch { return { ok: false, error: `Hedef bulunamadı: ${dest}`, dest, snapshots: [], bad: 0 }; }
  const snaps = [];
  let bad = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mp = path.join(dest, e.name, MANIFEST);
    if (!fs.existsSync(mp)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(mp, 'utf8')); }
    catch { bad++; continue; }
    snaps.push({
      snapshot: m.snapshot || e.name,
      createdAt: m.createdAt || null,
      source: m.source || null,
      files: m.summary ? m.summary.files : 0,
      bytes: m.summary ? m.summary.bytes : 0,
      mode: m.mode || 'full',
    });
  }
  sortSnapshots(snaps);
  return { ok: true, dest, snapshots: snaps, bad };
}

function latestSnapshot(dest) {
  const r = listSnapshotsSync(dest);
  if (!r.ok || r.snapshots.length === 0) {
    const why = r.bad > 0 ? `${dest} içinde okunabilir manifest yok (${r.bad} bozuk).` : `${dest} içinde snapshot yok.`;
    return { ok: false, error: r.error || why, bad: r.bad };
  }
  const last = r.snapshots[r.snapshots.length - 1];
  return {
    ok: true, snapshotDir: path.join(dest, last.snapshot), name: last.snapshot,
    files: last.files, bytes: last.bytes, mode: last.mode, createdAt: last.createdAt, bad: r.bad,
  };
}

// ---------- komutlar ----------

async function cmdDurum(opts) {
  const report = await runAll({ dir: SCRIPT_DIR });
  const s = report.summary;
  const snaps = listSnapshotsSync(opts.dest);
  const snapLine = snaps.ok
    ? `${snaps.snapshots.length} snapshot${snaps.bad > 0 ? `, ${snaps.bad} bozuk manifest` : ''}`
    : 'hedef yok';
  const payload = { ...report, snapshots: snaps };
  const written = opts.outFile ? writeReport(payload, opts.outFile) : null;
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }
  console.log('');
  console.log(`Kutu — durum  (${report.dir})`);
  console.log('-'.repeat(48));
  console.log(`Test        : ${s.passedTests}/${s.totalTests} geçen, ${s.failedTests} başarısız (${report.suites.length} suite)`);
  console.log(`Duman       : ${report.smoke.length - s.failedSmoke}/${report.smoke.length} araç, ${s.failedSmoke} hata`);
  console.log(`Skill       : ${report.sync ? (report.sync.ok ? 'TEMİZ' : `${report.sync.drift < 0 ? 'kontrol hatası' : `${report.sync.drift} fark`}`) : 'kaynak klasör yok'}`);
  console.log(`Yedek       : ${snapLine}  (${opts.dest})`);
  console.log(`Süre        : ${Math.round(s.durationMs)} ms`);
  console.log(`Sonuç       : ${report.ok ? 'BAŞARILI' : 'BAŞARISIZ'}`);
  if (written) console.log(`Rapor       : ${written}`);
  console.log('');
  return s.exitCode;
}

async function cmdYedekle(opts) {
  const source = opts.src ? path.resolve(opts.src) : SCRIPT_DIR;
  const excludes = new Set(opts.exclude.map((x) => String(x).toLowerCase()));
  // snapshotImpl/kopyalama noktaları test enjeksiyonu içindir; varsayılan gerçek yedekci.
  const r = await (opts.snapshotImpl || snapshot)(source, opts.dest, { incremental: !opts.full, dryRun: !!opts.dryRun, excludes });

  if (!r.ok) {
    if (r.error) { console.error(`Yedek hatası: ${r.error}`); return 1; }
    console.error('');
    console.error('Kutu — yedekle');
    console.error('-'.repeat(48));
    console.error(`Snapshot    : ${r.snapshotDir}`);
    console.error(`Kısmi hata  : ${snapshotFailSummary(r)}`);
    console.error('');
    return 2;
  }

  if (r.dryRun) {
    if (opts.json) { process.stdout.write(JSON.stringify({ dryRun: r }, null, 2) + '\n'); return 0; }
    console.log('');
    console.log('Kutu — yedekle (plan, hiçbir şey yazılmadı)');
    console.log('-'.repeat(48));
    console.log(`Kaynak      : ${r.source}`);
    console.log(`Hedef       : ${r.dest}`);
    console.log(`Dosya       : ${r.files} / ${fmtBytes(r.bytes)}`);
    console.log(`Plan        : ${r.wouldCopy} kopya + ${r.wouldLink} bağ`);
    console.log(`Bağ         : ${r.symlinks} symlink/junction`);
    console.log(`Atlanan     : ${r.skipped} klasör, ${r.toolong} çok uzun, ${r.unreadable} okunamaz`);
    console.log('');
    return 0;
  }

  const v = await verifySnapshot(r.snapshotDir);
  if (opts.json) { process.stdout.write(JSON.stringify({ snapshot: r, verify: v }, null, 2) + '\n'); return v.ok ? 0 : 1; }
  let mode = 'bilinmiyor';
  try { mode = JSON.parse(fs.readFileSync(path.join(r.snapshotDir, MANIFEST), 'utf8')).mode || 'bilinmiyor'; } catch { /* manifest okunamazsa mod bilinmiyor kalır */ }
  console.log('');
  console.log('Kutu — yedekle');
  console.log('-'.repeat(48));
  console.log(`Snapshot    : ${r.snapshotDir}`);
  console.log(`Mod         : ${mode}  (${r.linked} bağ + ${r.copied} kopya, ${r.files} dosya / ${fmtBytes(r.bytes)})`);
  console.log(`Doğrulama   : ${v.ok ? 'TEMİZ' : 'SORUN VAR'}`);
  for (const x of (v.missing || []).slice(0, 5)) console.log(`  eksik: ${x.rel}`);
  for (const x of (v.changed || []).slice(0, 5)) console.log(`  değişmiş: ${x.rel}`);
  console.log('');
  return v.ok ? 0 : 2;
}

async function cmdGeriYukle(opts) {
  const fail = (msg) => {
    const text = msg || 'Geri yükleme başarısız: neden bildirilmedi.';
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: text }, null, 2) + '\n');
    else console.error(text);
    return 1;
  };
  const src = opts.from ? { ok: true, snapshotDir: path.resolve(opts.from) } : latestSnapshot(opts.dest);
  if (!src.ok) return fail(src.error);
  const to = path.resolve(opts.to || path.join(process.cwd(), `geri-yukle-${stamp()}`));

  let r;
  try { r = await restoreSnapshot(src.snapshotDir, to, { force: !!opts.force, noManifest: !!opts.noManifest, link: !!opts.link }); }
  catch (e) { return fail(`Geri yükleme hatası: ${e.message}`); }
  if (!r.ok) return fail(r.error);

  if (opts.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return r.verifyOk ? 0 : 2; }
  console.log('');
  console.log('Kutu — geri yükleme tatbikatı');
  console.log('-'.repeat(48));
  console.log(`Kaynak      : ${r.from}${r.createdAt ? `  (createdAt: ${r.createdAt})` : ''}`);
  console.log(`Hedef       : ${r.to}`);
  console.log(`Gelen       : ${r.files} dosya / ${fmtBytes(r.bytes)}  (mod: ${r.mode})`);
  const zincir = r.sharedFiles ? `, zincirde ${r.sharedFiles} dosya / ${fmtBytes(r.sharedBytes)} paylaşılıyor${r.linkedFiles ? ' (korundu)' : ' (kopyalandı; --link ile korunur)'}` : '';
  console.log(`Hardlink    : ${r.linkedFiles} bağlandı, ${r.copiedFiles} kopyalandı${r.linkFallback ? `, ${r.linkFallback} vazgeçiş` : ''}${zincir}`);
  console.log(`Bağlar      : ${r.linkRecreated} kuruldu, ${r.linkSkippedExternal} atlandı (harici hedef), ${r.linkMaterialized} maddeleştirildi, ${r.linkFailed} kayıp`);
  console.log(`Manifest    : ${r.manifestKept ? 'hedefte tutuldu' : 'silindi (--no-manifest)'}`);
  for (const w of r.warnings.slice(0, 8)) console.log(w);
  console.log(`Doğrulama   : ${r.verifyOk ? 'TEMİZ' : `UYUŞMAZLIK (${r.verifySummary})`}`);
  for (const x of r.fileIssues.slice(0, 5)) console.log(`  ${x.reason || 'fazla'}: ${x.rel}`);
  if (r.manifestKept) console.log(`Manifest    : node yedekci.mjs verify "${r.to}"`);
  console.log(`Doğrula     : node dogrula.mjs --dir "${r.to}"`);
  console.log('');
  return r.verifyOk ? 0 : 2;
}

function cmdArac(name, rest) {
  const file = path.join(SCRIPT_DIR, TOOLS[name]);
  const res = spawnSync(process.execPath, [file, ...rest], {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  });
  return typeof res.status === 'number' ? res.status : 1;
}

function printHelp() {
  console.log(`kutu v${VERSION} — araç takımı tek giriş

Kullanım:
  node kutu.mjs <komut> [seçenekler]
  node kutu.mjs [seçenekler] <komut>

Komutlar:
  durum                 test + duman + skill bütünlüğü + yedek özeti
  yedekle               kaynak klasörü hedefe doğrulamalı yedekle (hedef: ~/kutu-backups)
  geri-yukle            son snapshot'ı boş bir klasöre geri yükle (tatbikat)
  <araç> [arg...]       araca ilet: ${Object.keys(TOOLS).join(', ')}

Seçenekler (komuta özeldir, yabancı bayrak reddedilir):
  durum                 : --json --out <dosya>
  yedekle               : --dest <yol> --src <yol> --full --dry-run --exclude=a,b --json
  geri-yukle            : --dest <yol> --from <yol> --to <yol> --force --no-manifest --link --json
  ortak                 : --help, -h, --version, -v

  --dest <yol>          yedek hedefi (varsayılan: ${DEFAULT_DEST})
  --src <yol>           yedeklenecek kaynak (varsayılan: kutu klasörü)
  --from <yol>          belirli snapshot klasörü
  --to <yol>            geri yükleme hedefi (varsayılan: ./geri-yukle-<zaman>)
  --full                artımlı değil, tam kopya
  --dry-run             hiçbir şey yazmadan planı göster
  --exclude=a,b         ek atlanacak klasör adları
  --force               snapshot doğrulanamasa bile geri yükle
  --no-manifest         geri yüklenen klasörde manifesti sil (doğrulanabilirlik kaybolur)
  --json                makine okunur çıktı

Çıkış kodu: 0 = temiz, 1 = kullanım/hata, 2 = doğrulama uyuşmazlığı.`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.version) { console.log(VERSION); process.exitCode = 0; return; }
  if (opts.command && TOOLS[opts.command]) { process.exitCode = cmdArac(opts.command, opts.toolArgs); return; }
  if (!opts.command || opts.help) { printHelp(); process.exitCode = opts.help ? 0 : 1; return; }
  let code;
  if (opts.command === 'durum') code = await cmdDurum(opts);
  else if (opts.command === 'yedekle') code = await cmdYedekle(opts);
  else if (opts.command === 'geri-yukle') code = await cmdGeriYukle(opts);
  else { console.error(`Bilinmeyen komut: ${opts.command}`); code = 1; }
  process.exitCode = code;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export {
  parseArgs, restoreSnapshot, latestSnapshot, listSnapshotsSync, sortSnapshots, nameCounter,
  snapshotFailSummary, cmdDurum, cmdYedekle, cmdGeriYukle, cmdArac, printHelp, main, writeReport, copyTree,
  TOOLS, VERSION, DEFAULT_DEST, SCRIPT_DIR, COMMAND_FLAGS,
};
