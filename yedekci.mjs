#!/usr/bin/env node
// yedekci — doğrulamalı yedekleme (snapshot + SHA-256 manifest)
// Kaynak dosyalar asla değiştirilmez. Hedefe yazar, sonra kopyayı yeniden okuyup doğrular.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const MANIFEST = '.yedek-manifest.json';
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);
const MAX_WIN_PATH = 250;

const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn', '.hg',
]);

const C = { reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m', red: '\u001b[31m', yellow: '\u001b[33m', green: '\u001b[32m', cyan: '\u001b[36m' };
const nf = new Intl.NumberFormat('tr-TR');
const fmtNum = (n) => nf.format(n);

function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function parseArgs(argv) {
  const opts = {
    cmd: null, args: [], dryRun: false, incremental: false,
    excludes: new Set(), json: false, noColor: false, help: false, version: false, error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-color') { opts.noColor = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--incremental') { opts.incremental = true; continue; }
    if (a.startsWith('--exclude=')) {
      for (const name of a.slice('--exclude='.length).split(',')) {
        if (name.trim()) opts.excludes.add(name.trim().toLowerCase());
      }
      continue;
    }
    if (a.startsWith('-')) { opts.error = `Bilinmeyen argüman: ${a}`; return opts; }
    if (!opts.cmd) { opts.cmd = a; continue; }
    opts.args.push(a);
  }
  return opts;
}

// ---------- yardımcılar ----------

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sanitizeName(name) {
  return String(name || 'kaynak').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 60) || 'kaynak';
}

function timestampName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function isLongPath(p) {
  return process.platform === 'win32' && path.resolve(p).length > MAX_WIN_PATH;
}

async function withRetry(fn, attempts = 3, delays = [50, 150, 300]) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!e || !RETRY_CODES.has(e.code)) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delays[i] ?? 300));
    }
  }
  throw last;
}

async function scanFiles(root, excludes = new Set()) {
  const files = [];
  const links = [];
  const skipped = [];
  const unreadable = [];
  const toolong = [];
  const stack = [root];
  let dirs = 0;
  let symlinks = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    dirs++;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      unreadable.push({ path: dir, code: e.code || 'ERR' });
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (isLongPath(full)) { toolong.push(full); continue; }
      if (e.isSymbolicLink()) {
        symlinks++;
        let linkTarget = null;
        try { linkTarget = await fs.promises.readlink(full); } catch (err) {
          unreadable.push({ path: full, code: err.code || 'ERR' });
          continue;
        }
        let isDir = false;
        try { isDir = (await fs.promises.stat(full)).isDirectory(); } catch { /* kırık bağlantı */ }
        links.push({ rel: path.relative(root, full), abs: full, target: linkTarget, isDir });
        continue;
      }
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (SKIP_DIRS.has(lower) || excludes.has(lower)) { skipped.push(full); continue; }
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = await fs.promises.stat(full); } catch (err) {
        unreadable.push({ path: full, code: err.code || 'ERR' });
        continue;
      }
      files.push({ rel: path.relative(root, full), abs: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return { files, links, dirs, skipped, symlinks, unreadable, toolong };
}

async function latestSnapshot(dest) {
  let entries;
  try { entries = await fs.promises.readdir(dest, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(dest, e.name);
    if (fs.existsSync(path.join(dir, MANIFEST))) candidates.push(dir);
  }
  candidates.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return candidates.length ? candidates[candidates.length - 1] : null;
}

async function readManifest(snapshotDir) {
  const text = await fs.promises.readFile(path.join(snapshotDir, MANIFEST), 'utf8');
  return JSON.parse(text);
}

// ---------- snapshot ----------

async function snapshot(srcInput, destInput, opts = {}) {
  const src = path.resolve(srcInput);
  const dest = path.resolve(destInput);
  const excludes = opts.excludes || new Set();

  if (src === dest || isInside(src, dest)) {
    return { ok: false, error: 'Hedef, kaynağın içinde olamaz.' };
  }
  let st;
  try { st = fs.statSync(src); } catch { return { ok: false, error: `Kaynak bulunamadı: ${src}` }; }
  if (!st.isDirectory()) return { ok: false, error: `Kaynak klasör değil: ${src}` };

  const scan = await scanFiles(src, excludes);
  const prevDir = opts.incremental ? await latestSnapshot(dest) : null;
  let prevFiles = new Map();
  if (prevDir) {
    try {
      const pm = await readManifest(prevDir);
      prevFiles = new Map((pm.files || []).map((f) => [f.rel, f]));
    } catch { prevFiles = new Map(); }
  }

  const plan = scan.files.map((f) => {
    const prev = prevFiles.get(f.rel);
    const canLink = !!(prevDir && prev && prev.hash && prev.size === f.size && prev.mtimeMs === f.mtimeMs);
    return { ...f, canLink, prevHash: prev ? prev.hash : null };
  });

  const totalBytes = plan.reduce((s, f) => s + f.size, 0);
  const wouldLink = plan.filter((f) => f.canLink).length;

  if (opts.dryRun) {
    return {
      ok: true, dryRun: true, source: src, dest,
      files: plan.length, bytes: totalBytes,
      wouldCopy: plan.length - wouldLink, wouldLink,
      symlinks: scan.links.length, toolong: scan.toolong.length,
      skipped: scan.skipped.length, unreadable: scan.unreadable.length,
    };
  }

  await fs.promises.mkdir(dest, { recursive: true });
  const baseName = `${timestampName()}_${sanitizeName(path.basename(src))}`;
  let snapshotDir = path.join(dest, baseName);
  let n = 2;
  while (fs.existsSync(snapshotDir)) snapshotDir = path.join(dest, `${baseName}_${n++}`);
  await fs.promises.mkdir(snapshotDir, { recursive: true });

  const entries = [];
  const errors = [];
  const mismatches = [];
  let copied = 0;
  let linked = 0;
  let done = 0;

  for (const f of plan) {
    const target = path.join(snapshotDir, f.rel);
    let action = 'copied';
    let expected = null;
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (f.canLink) {
        try {
          await withRetry(() => fs.promises.link(path.join(prevDir, f.rel), target));
          action = 'linked';
          expected = f.prevHash;
          linked++;
        } catch {
          action = 'copied';
        }
      }
      if (action === 'copied') {
        expected = await withRetry(() => hashFile(f.abs));
        await withRetry(() => fs.promises.copyFile(f.abs, target));
        copied++;
      }
      const actual = await withRetry(() => hashFile(target));
      if (actual !== expected) {
        mismatches.push({ rel: f.rel, kind: 'hash' });
      }
      entries.push({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, hash: expected, action });
    } catch (e) {
      const locked = !!(e && RETRY_CODES.has(e.code));
      errors.push({ rel: f.rel, code: e.code || 'ERR', locked });
      entries.push({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, hash: null, action: 'error' });
    }
    done++;
    if (opts.onProgress && done % 200 === 0) opts.onProgress(done, plan.length);
  }

  const linkEntries = [];
  let linkRecreated = 0;
  let linkCopied = 0;
  let linkErrors = 0;

  for (const l of scan.links) {
    const target = path.join(snapshotDir, l.rel);
    let usedTarget = l.target;
    let external = false;
    const resolved = path.resolve(path.dirname(l.abs), l.target);
    if (isInside(src, resolved)) {
      const relTarget = path.relative(src, resolved);
      usedTarget = path.join(snapshotDir, relTarget);
    } else {
      external = true;
      if (process.platform === 'win32' && l.isDir) usedTarget = resolved;
    }
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.promises.symlink(usedTarget, target, l.isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
        linkEntries.push({ rel: l.rel, target: usedTarget, external, isDir: l.isDir, action: 'link' });
        linkRecreated++;
        continue;
      } catch (linkErr) {
        if (!l.isDir) {
          const st2 = await fs.promises.stat(l.abs).catch(() => null);
          if (st2 && st2.isFile()) {
            await withRetry(() => fs.promises.copyFile(l.abs, target));
            const h = await withRetry(() => hashFile(target));
            linkEntries.push({ rel: l.rel, target: usedTarget, external, isDir: false, action: 'copied-link', size: st2.size, hash: h });
            linkCopied++;
            continue;
          }
        }
        throw linkErr;
      }
    } catch (e) {
      linkErrors++;
      linkEntries.push({ rel: l.rel, target: usedTarget, external, isDir: l.isDir, action: 'error', code: e.code || 'ERR' });
    }
  }

  const manifest = {
    tool: 'yedekci', version: VERSION, createdAt: new Date().toISOString(),
    source: src, snapshot: path.basename(snapshotDir),
    mode: prevDir ? 'incremental' : 'full',
    files: entries,
    links: linkEntries,
    summary: {
      files: entries.length, bytes: totalBytes, copied, linked,
      skipped: scan.skipped.length, unreadable: scan.unreadable.length, symlinks: scan.symlinks,
      toolong: scan.toolong.length,
      links: linkEntries.length, linkRecreated, linkCopied, linkErrors,
      locked: errors.filter((e) => e.locked).length,
      mismatches: mismatches.length, errors: errors.length,
    },
  };
  await fs.promises.writeFile(path.join(snapshotDir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    ok: errors.length === 0 && mismatches.length === 0 && scan.unreadable.length === 0 && linkErrors === 0 && scan.toolong.length === 0,
    dryRun: false, source: src, dest, snapshotDir, manifest: path.join(snapshotDir, MANIFEST),
    files: entries.length, bytes: totalBytes, copied, linked,
    skipped: scan.skipped.length, unreadable: scan.unreadable.length, symlinks: scan.symlinks,
    toolong: scan.toolong.length,
    locked: errors.filter((e) => e.locked).length,
    linkRecreated, linkCopied, linkErrors, links: linkEntries,
    errors, mismatches,
  };
}

// ---------- verify ----------

async function verifySnapshot(snapshotDirInput) {
  const snapshotDir = path.resolve(snapshotDirInput);
  let manifest;
  try {
    manifest = await readManifest(snapshotDir);
  } catch (e) {
    return { ok: false, error: `Manifest okunamadı: ${snapshotDir}\\${MANIFEST}` };
  }
  const missing = [];
  const changed = [];
  const extra = [];
  const linkIssues = [];
  for (const f of manifest.files || []) {
    const target = path.join(snapshotDir, f.rel);
    if (!isInside(snapshotDir, path.resolve(target))) {
      changed.push({ rel: f.rel, reason: 'geçersiz yol' });
      continue;
    }
    if (f.action === 'error') { missing.push({ rel: f.rel, reason: 'kopyalanamadı' }); continue; }
    let st;
    try { st = await fs.promises.stat(target); } catch { missing.push({ rel: f.rel, reason: 'yok' }); continue; }
    if (st.size !== f.size) { changed.push({ rel: f.rel, reason: 'boyut' }); continue; }
    let h;
    try { h = await withRetry(() => hashFile(target)); } catch { changed.push({ rel: f.rel, reason: 'okunamadı' }); continue; }
    if (h !== f.hash) changed.push({ rel: f.rel, reason: 'hash' });
  }

  for (const l of manifest.links || []) {
    const target = path.join(snapshotDir, l.rel);
    if (!isInside(snapshotDir, path.resolve(target))) { linkIssues.push({ rel: l.rel, reason: 'geçersiz yol' }); continue; }
    if (l.action === 'error') { linkIssues.push({ rel: l.rel, reason: 'oluşturulamadı' }); continue; }
    if (l.action === 'copied-link') {
      let st;
      try { st = await fs.promises.stat(target); } catch { linkIssues.push({ rel: l.rel, reason: 'yok' }); continue; }
      if (st.size !== l.size) { linkIssues.push({ rel: l.rel, reason: 'boyut' }); continue; }
      let h;
      try { h = await withRetry(() => hashFile(target)); } catch { linkIssues.push({ rel: l.rel, reason: 'okunamadı' }); continue; }
      if (h !== l.hash) linkIssues.push({ rel: l.rel, reason: 'hash' });
      continue;
    }
    let st;
    try { st = await fs.promises.lstat(target); } catch { linkIssues.push({ rel: l.rel, reason: 'yok' }); continue; }
    if (!st.isSymbolicLink()) { linkIssues.push({ rel: l.rel, reason: 'bağlantı değil' }); continue; }
    let actual = null;
    try { actual = await fs.promises.readlink(target); } catch { linkIssues.push({ rel: l.rel, reason: 'okunamadı' }); continue; }
    if (actual !== l.target) linkIssues.push({ rel: l.rel, reason: 'hedef farklı' });
  }

  const known = new Set([
    ...(manifest.files || []).map((f) => f.rel),
    ...(manifest.links || []).map((l) => l.rel),
  ]);
  const scan = await scanFiles(snapshotDir, new Set());
  for (const f of scan.files) {
    if (f.rel === MANIFEST) continue;
    if (!known.has(f.rel)) extra.push({ rel: f.rel });
  }
  for (const l of scan.links) {
    if (!known.has(l.rel)) extra.push({ rel: l.rel });
  }
  const ok = missing.length === 0 && changed.length === 0 && extra.length === 0 && linkIssues.length === 0;
  return {
    ok, snapshotDir, source: manifest.source, createdAt: manifest.createdAt,
    checked: (manifest.files || []).length,
    linksChecked: (manifest.links || []).length,
    missing, changed, extra, links: linkIssues,
  };
}

// ---------- list ----------

async function listSnapshots(destInput) {
  const dest = path.resolve(destInput);
  let entries;
  try { entries = await fs.promises.readdir(dest, { withFileTypes: true }); }
  catch { return { ok: false, error: `Hedef bulunamadı: ${dest}` }; }
  const snaps = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(dest, e.name);
    if (!fs.existsSync(path.join(dir, MANIFEST))) continue;
    try {
      const m = await readManifest(dir);
      snaps.push({
        snapshot: m.snapshot || e.name,
        createdAt: m.createdAt,
        source: m.source,
        files: m.summary ? m.summary.files : (m.files || []).length,
        bytes: m.summary ? m.summary.bytes : 0,
        mode: m.mode || 'full',
      });
    } catch { /* bozuk manifest listelenmez */ }
  }
  snaps.sort((a, b) => String(a.snapshot).localeCompare(String(b.snapshot)));
  return { ok: true, dest, snapshots: snaps };
}

// ---------- yazdırma ----------

function paint(code, s, useColor) {
  return useColor ? `${code}${s}${C.reset}` : s;
}

function printSnapshot(r, opts = {}) {
  const useColor = opts.color !== undefined ? opts.color : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const b = (s) => (useColor ? `${C.bold}${s}${C.reset}` : s);
  const d = (s) => (useColor ? `${C.dim}${s}${C.reset}` : s);
  console.log('');
  console.log(b('Yedekçi — snapshot'));
  console.log(d('-'.repeat(60)));
  console.log(`Kaynak : ${r.source}`);
  console.log(`Hedef  : ${r.snapshotDir || r.dest}`);
  if (r.dryRun) {
    console.log(`Plan   : ${fmtNum(r.files)} dosya, ${fmtBytes(r.bytes)} — ${fmtNum(r.wouldCopy)} kopyalanacak, ${fmtNum(r.wouldLink)} bağlanacak`);
    console.log(d('Dry-run: hiçbir dosya yazılmadı.'));
    console.log('');
    return;
  }
  console.log(`Dosya  : ${fmtNum(r.files)} (${fmtBytes(r.bytes)}) — ${fmtNum(r.copied)} kopya, ${fmtNum(r.linked)} bağlantı`);
  const sev = r.ok ? C.green : C.yellow;
  console.log(`Doğrulama: ${paint(sev, r.ok ? 'TEMİZ' : `${r.mismatches.length} uyuşmazlık, ${r.errors.length} hata`, useColor)}`);
  if (r.errors.length) for (const e of r.errors.slice(0, 5)) console.log(`  hata: ${e.rel} (${e.code})${e.locked ? ' [kilitli]' : ''}`);
  if (r.locked) console.log(d(`Kilitli dosya: ${r.locked} (3 kez denendi)`));
  if (r.mismatches.length) for (const m of r.mismatches.slice(0, 5)) console.log(`  uyuşmazlık: ${m.rel}`);
  if (r.symlinks) {
    console.log(d(`Symlink: ${r.symlinks} — yeniden: ${r.linkRecreated}, kopya: ${r.linkCopied}, hata: ${r.linkErrors}`));
  }
  if (r.skipped || r.unreadable || r.toolong) {
    console.log(d(`Atlanan klasör: ${r.skipped}, okunamayan: ${r.unreadable}, uzun yol: ${r.toolong || 0}`));
  }
  console.log(d(`Manifest: ${r.manifest}`));
  console.log('');
}

function printVerify(r, opts = {}) {
  const useColor = opts.color !== undefined ? opts.color : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const b = (s) => (useColor ? `${C.bold}${s}${C.reset}` : s);
  const d = (s) => (useColor ? `${C.dim}${s}${C.reset}` : s);
  console.log('');
  console.log(b('Yedekçi — doğrulama'));
  console.log(d('-'.repeat(60)));
  if (!r.ok && r.error) { console.log(paint(C.red, r.error, useColor)); console.log(''); return; }
  console.log(`Snapshot: ${r.snapshotDir}`);
  console.log(`Kontrol : ${fmtNum(r.checked)} dosya${r.linksChecked ? `, ${fmtNum(r.linksChecked)} symlink` : ''}`);
  console.log(`Sonuç   : ${paint(r.ok ? C.green : C.red, r.ok ? 'TEMİZ' : 'SORUN VAR', useColor)}`);
  for (const x of r.missing.slice(0, 8)) console.log(`  eksik: ${x.rel} (${x.reason})`);
  for (const x of r.changed.slice(0, 8)) console.log(`  değişmiş: ${x.rel} (${x.reason})`);
  for (const x of r.extra.slice(0, 8)) console.log(`  fazla: ${x.rel}`);
  for (const x of (r.links || []).slice(0, 8)) console.log(`  bağlantı: ${x.rel} (${x.reason})`);
  const totalIssues = r.missing.length + r.changed.length + r.extra.length + (r.links || []).length;
  if (totalIssues > 24) console.log(d(`  ... +${totalIssues - 24}`));
  console.log('');
}

function printList(r, opts = {}) {
  const useColor = opts.color !== undefined ? opts.color : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const b = (s) => (useColor ? `${C.bold}${s}${C.reset}` : s);
  console.log('');
  console.log(b(`Yedekçi — snapshot listesi (${r.snapshots.length})`));
  for (const s of r.snapshots) {
    console.log(`  ${s.snapshot}  ${fmtNum(s.files)} dosya  ${fmtBytes(s.bytes)}  ${s.mode}`);
  }
  console.log('');
}

function printHelp() {
  console.log(`yedekci v${VERSION} — doğrulamalı yedekleme

Kullanım:
  node yedekci.mjs snapshot <kaynak> <hedef> [--incremental] [--dry-run] [--exclude=a,b]
  node yedekci.mjs verify <snapshot-klasörü>
  node yedekci.mjs list <hedef>

Seçenekler:
  --incremental   Önceki snapshot'la aynı boyut+tarihli dosyaları hardlink ile bağla
                  (yalnız aynı sürücüde; başarısız olursa kopyalar)
  --dry-run       Hiçbir şey yazma; yalnızca planı göster
  --exclude=a,b   Ek olarak atlanacak klasör adları (virgülle)
  --json          Makine okunur çıktı
  --no-color      Renksiz çıktı
  --version       Sürüm
  --help          Bu yardım

Davranış:
  - Kaynak dosyalar asla değiştirilmez; yalnız okunur.
  - Her dosyanın SHA-256'sı manifeste yazılır.
  - Kopya yazıldıktan sonra yeniden okunur ve hash karşılaştırılır.
  - verify, snapshot'ı manifeste karşı denetler (eksik/değişmiş/fazla).

Çıkış kodu: 0 = temiz, 2 = uyuşmazlık/eksik, 1 = kullanım hatası.`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (!opts.cmd) { console.error('Komut gerekli: snapshot | verify | list. --help ile kullanım.'); process.exitCode = 1; return; }

  try {
    if (opts.cmd === 'snapshot') {
      if (opts.args.length !== 2) { console.error('Kullanım: snapshot <kaynak> <hedef>'); process.exitCode = 1; return; }
      const [src, dest] = opts.args;
      const tty = process.stderr.isTTY && !opts.json;
      const onProgress = (done, total) => { if (tty) process.stderr.write(`\rYedekleniyor: ${fmtNum(done)}/${fmtNum(total)}`); };
      const r = await snapshot(src, dest, { dryRun: opts.dryRun, incremental: opts.incremental, excludes: opts.excludes, onProgress });
      if (tty) process.stderr.write('\r\u001b[K');
      if (!r.ok && r.error) { console.error(r.error); process.exitCode = 1; return; }
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else printSnapshot(r, { noColor: opts.noColor });
      process.exitCode = r.ok ? 0 : 2;
      return;
    }

    if (opts.cmd === 'verify') {
      if (opts.args.length !== 1) { console.error('Kullanım: verify <snapshot-klasörü>'); process.exitCode = 1; return; }
      const r = await verifySnapshot(opts.args[0]);
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else printVerify(r, { noColor: opts.noColor });
      process.exitCode = r.ok ? 0 : 2;
      return;
    }

    if (opts.cmd === 'list') {
      if (opts.args.length !== 1) { console.error('Kullanım: list <hedef>'); process.exitCode = 1; return; }
      const r = await listSnapshots(opts.args[0]);
      if (!r.ok) { console.error(r.error); process.exitCode = 1; return; }
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else printList(r, { noColor: opts.noColor });
      process.exitCode = 0;
      return;
    }

    console.error(`Bilinmeyen komut: ${opts.cmd}`);
    process.exitCode = 1;
  } catch (e) {
    console.error('Beklenmeyen hata:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { parseArgs, scanFiles, snapshot, verifySnapshot, listSnapshots, hashFile, withRetry, isLongPath, fmtBytes, VERSION, MANIFEST };
