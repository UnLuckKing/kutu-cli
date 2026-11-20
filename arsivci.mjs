#!/usr/bin/env node
// arsivci — fotoğraf/video arşivi denetçisi (salt okunur)
// Sıfır bağımlılık. Hiçbir dosya silmez, taşımaz, değiştirmez.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const MAX_FILES_DEFAULT = 200000;
const HEAD_BYTES_IMAGE = 65536;
const HEAD_BYTES_OTHER = 64;
const TAIL_BYTES = 4096;

const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn', '.hg',
]);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp']);

const EXT_KIND = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg',
  '.png': 'png', '.gif': 'gif', '.webp': 'webp', '.bmp': 'bmp',
  '.tif': 'tiff', '.tiff': 'tiff',
  '.heic': 'heic', '.heif': 'heic', '.avif': 'avif',
  '.mp4': 'mp4', '.mov': 'mp4', '.m4v': 'mp4',
  '.avi': 'avi', '.mkv': 'matroska', '.webm': 'matroska',
};

const C = { reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m', red: '\u001b[31m', yellow: '\u001b[33m', cyan: '\u001b[36m', green: '\u001b[32m' };

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
    root: null, json: false, noColor: false, help: false, version: false,
    maxFiles: MAX_FILES_DEFAULT, error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-color') { opts.noColor = true; continue; }
    if (a.startsWith('--max-files=')) {
      const n = Number(a.slice('--max-files='.length));
      if (!Number.isFinite(n) || n <= 0) { opts.error = 'Geçersiz --max-files değeri.'; return opts; }
      opts.maxFiles = Math.floor(n);
      continue;
    }
    if (a.startsWith('-')) { opts.error = `Bilinmeyen argüman: ${a}`; return opts; }
    if (opts.root) { opts.error = 'Tek bir klasör yolu verin.'; return opts; }
    opts.root = a;
  }
  return opts;
}

// ---------- dosya okuma ----------

async function readHead(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readTail(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const len = Math.min(bytes, size);
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ---------- imza ve boyut ----------

function detectKind(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const fourcc = buf.toString('ascii', 8, 12);
    if (fourcc === 'WEBP') return 'webp';
    if (fourcc === 'AVI ') return 'avi';
  }
  if (buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'matroska';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
      (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A))) return 'tiff';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc', 'hevx'].includes(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    return 'mp4';
  }
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD9 || m === 0xDA) break;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { width: w, height: h };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { width: null, height: null };
}

function dimensions(kind, buf) {
  try {
    if (kind === 'jpeg') return jpegSize(buf);
    if (kind === 'png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (kind === 'gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (kind === 'bmp' && buf.length >= 26) return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    if (kind === 'webp' && buf.length >= 30) {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3);
        const h = 1 + buf.readUIntLE(27, 3);
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ') {
        if (buf[23] === 0x9D && buf[24] === 0x01 && buf[25] === 0x2A) {
          return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
        }
      }
    }
  } catch { /* kısa/bozuk başlık */ }
  return { width: null, height: null };
}

// ---------- EXIF ----------

function readIfd(buf, base, off, u16, u32) {
  if (off < 0 || off + 2 > buf.length) return null;
  const count = u16(off);
  if (count > 512) return null;
  const out = {};
  for (let k = 0; k < count; k++) {
    const e = off + 2 + k * 12;
    if (e + 12 > buf.length) break;
    const tag = u16(e);
    if (tag !== 0x8769 && tag !== 0x9003 && tag !== 0x0132) continue;
    const type = u16(e + 2);
    const n = u32(e + 4);
    const valOff = u32(e + 8);
    if (type === 3 && tag === 0x8769) { out[tag] = u16(e + 8); continue; }
    if (type === 4 && tag === 0x8769) { out[tag] = valOff; continue; }
    if (type === 2) {
      let s = '';
      if (n <= 4) {
        s = buf.toString('ascii', e + 8, e + 8 + n);
      } else {
        const start = base + valOff;
        const end = Math.min(start + n, buf.length, start + 64);
        if (start >= 0 && start < buf.length) s = buf.toString('ascii', start, end);
      }
      out[tag] = s.replace(/\0/g, ' ').trim();
    }
  }
  return out;
}

function exifDate(buf) {
  if (!buf || buf.length < 16) return null;
  let i = -1;
  try { i = buf.indexOf('Exif\0\0'); } catch { return null; }
  if (i < 0) return null;
  const base = i + 6;
  if (base + 8 > buf.length) return null;
  const endian = buf.toString('ascii', base, base + 2);
  if (endian !== 'II' && endian !== 'MM') return null;
  const le = endian === 'II';
  try {
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd0 = base + u32(base + 4);
    const e0 = readIfd(buf, base, ifd0, u16, u32);
    if (!e0) return null;
    if (e0[0x8769]) {
      const e1 = readIfd(buf, base, base + e0[0x8769], u16, u32);
      if (e1 && e1[0x9003]) return normalizeDate(e1[0x9003]);
    }
    if (e0[0x0132]) return normalizeDate(e0[0x0132]);
  } catch { /* bozuk EXIF */ }
  return null;
}

function normalizeDate(s) {
  const m = String(s || '').match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function yearFromName(name) {
  const m = String(name).match(/\b(19\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// ---------- tarama ----------

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function analyzeFile(full, ext, size) {
  const isImage = IMAGE_EXT.has(ext);
  const isVideo = VIDEO_EXT.has(ext);
  const rec = { detected: null, width: null, height: null, captureDate: null, issues: [] };
  if (size === 0) return rec;
  if (!isImage && !isVideo) return rec;
  try {
    const head = await readHead(full, isImage ? HEAD_BYTES_IMAGE : HEAD_BYTES_OTHER);
    rec.detected = detectKind(head);
    const expected = EXT_KIND[ext];
    if (expected && rec.detected !== expected) {
      rec.issues.push(rec.detected ? `uzantı imzası uyuşmuyor (içerik: ${rec.detected})` : 'tanınmayan içerik imzası');
    }
    if (isImage && rec.detected) {
      const d = dimensions(rec.detected, head);
      rec.width = d.width;
      rec.height = d.height;
      if (rec.detected === 'jpeg') rec.captureDate = exifDate(head);
      const tail = await readTail(full, size, TAIL_BYTES);
      if (rec.detected === 'jpeg' && !tail.includes(Buffer.from([0xFF, 0xD9]))) rec.issues.push('JPEG sonu (EOI) eksik');
      if (rec.detected === 'png' && !tail.toString('ascii').includes('IEND')) rec.issues.push('PNG sonu (IEND) eksik');
      if (rec.detected === 'gif' && tail.length > 0 && !tail.includes(0x3B)) rec.issues.push('GIF sonu (0x3B) eksik');
      if (rec.detected === 'webp' && head.length >= 8) {
        const riff = head.readUInt32LE(4) + 8;
        if (Math.abs(riff - size) > 4) rec.issues.push('WebP boyut alanı dosya boyutuyla uyuşmuyor');
      }
    }
  } catch (e) {
    rec.issues.push('okunamadı');
  }
  return rec;
}

async function scanTree(root, opts = {}) {
  const maxFiles = opts.maxFiles || MAX_FILES_DEFAULT;
  const records = [];
  const unreadable = [];
  const skipped = [];
  const stack = [root];
  let dirs = 0;
  let symlinks = 0;
  let truncated = false;
  let done = 0;

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
      if (records.length >= maxFiles) { truncated = true; break; }
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { symlinks++; continue; }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) { skipped.push(full); continue; }
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = await fs.promises.stat(full); } catch (err) {
        unreadable.push({ path: full, code: err.code || 'ERR' });
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const rec = {
        path: full,
        rel: path.relative(root, full),
        name: e.name,
        ext: ext || '(uzantısız)',
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : 'other',
        hash: null,
        hashError: false,
        detected: null,
        width: null,
        height: null,
        captureDate: null,
        issues: [],
        year: null,
      };
      const a = await analyzeFile(full, ext, st.size);
      Object.assign(rec, { detected: a.detected, width: a.width, height: a.height, captureDate: a.captureDate, issues: a.issues });
      records.push(rec);
      done++;
      if (opts.onProgress && done % 500 === 0) opts.onProgress(done, records.length);
    }
    if (truncated) break;
  }

  return { records, dirs, unreadable, skipped, symlinks, truncated };
}

// ---------- kopya bulma ----------

async function hashCandidates(records, onProgress) {
  const bySize = new Map();
  for (const r of records) {
    if (r.size <= 0) continue;
    if (!bySize.has(r.size)) bySize.set(r.size, []);
    bySize.get(r.size).push(r);
  }
  let hashed = 0;
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      try {
        r.hash = await hashFile(r.path);
      } catch {
        r.hashError = true;
      }
      hashed++;
      if (onProgress && hashed % 25 === 0) onProgress(hashed);
    }
  }
}

// ---------- rapor ----------

function buildReport(records, meta, opts) {
  const images = records.filter((r) => r.kind === 'image');
  const videos = records.filter((r) => r.kind === 'video');
  const totalBytes = records.reduce((s, r) => s + r.size, 0);

  const extMap = new Map();
  for (const r of records) {
    const cur = extMap.get(r.ext) || { ext: r.ext, count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += r.size;
    extMap.set(r.ext, cur);
  }
  const byExt = [...extMap.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);

  for (const r of records) {
    if (r.captureDate) r.year = Number(r.captureDate.slice(0, 4));
    else r.year = yearFromName(r.name) || new Date(r.mtimeMs).getFullYear();
  }
  const yearMap = new Map();
  for (const r of records) {
    const cur = yearMap.get(r.year) || { year: r.year, count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += r.size;
    yearMap.set(r.year, cur);
  }
  const byYear = [...yearMap.values()].sort((a, b) => a.year - b.year);

  const hashGroups = new Map();
  for (const r of records) {
    if (!r.hash) continue;
    if (!hashGroups.has(r.hash)) hashGroups.set(r.hash, []);
    hashGroups.get(r.hash).push(r);
  }
  const dupGroups = [...hashGroups.values()].filter((g) => g.length > 1);
  dupGroups.sort((a, b) => (b.length - 1) * b[0].size - (a.length - 1) * a[0].size);
  const dupFiles = dupGroups.reduce((s, g) => s + g.length, 0);
  const dupWasted = dupGroups.reduce((s, g) => s + (g.length - 1) * g[0].size, 0);

  const nameGroups = new Map();
  for (const r of records) {
    const key = r.name.toLowerCase();
    if (!nameGroups.has(key)) nameGroups.set(key, []);
    nameGroups.get(key).push(r);
  }
  const sameName = [...nameGroups.values()].filter((g) => {
    if (g.length < 2) return false;
    const known = g.filter((r) => r.hash);
    if (known.length === g.length && new Set(known.map((r) => r.hash)).size === 1) return false;
    return true;
  }).sort((a, b) => b.length - a.length);

  const corrupt = records.filter((r) => r.issues.length > 0)
    .map((r) => ({ path: r.path, rel: r.rel, reasons: r.issues }));
  const zeroByte = records.filter((r) => r.size === 0).map((r) => ({ path: r.path, rel: r.rel }));
  const hashErrors = records.filter((r) => r.hashError).length;
  const largest = [...records].sort((a, b) => b.size - a.size).slice(0, 15)
    .map((r) => ({ path: r.path, rel: r.rel, size: r.size }));

  const exampleLimit = 10;
  return {
    tool: 'arsivci',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    root: opts.root,
    options: { maxFiles: opts.maxFiles },
    summary: {
      files: records.length,
      dirs: meta.dirs,
      bytes: totalBytes,
      images: images.length,
      videos: videos.length,
      corrupt: corrupt.length,
      zeroByte: zeroByte.length,
      duplicateGroups: dupGroups.length,
      duplicateFiles: dupFiles,
      duplicateWastedBytes: dupWasted,
      unreadable: meta.unreadable.length,
      skippedDirs: meta.skipped.length,
      symlinks: meta.symlinks,
      hashErrors,
      truncated: meta.truncated,
      durationMs: meta.durationMs,
    },
    byExt,
    byYear,
    duplicates: {
      groups: dupGroups.length,
      files: dupFiles,
      wastedBytes: dupWasted,
      examples: dupGroups.slice(0, exampleLimit).map((g) => ({
        hash: g[0].hash,
        size: g[0].size,
        count: g.length,
        files: g.map((r) => r.rel),
      })),
    },
    sameName: {
      groups: sameName.length,
      files: sameName.reduce((s, g) => s + g.length, 0),
      examples: sameName.slice(0, exampleLimit).map((g) => ({
        name: g[0].name,
        count: g.length,
        files: g.map((r) => r.rel),
      })),
    },
    corrupt: corrupt.slice(0, 200),
    zeroByte: zeroByte.slice(0, 200),
    largest,
    unreadable: meta.unreadable.slice(0, 100),
  };
}

async function inspect(root, opts = {}) {
  const started = Date.now();
  const scan = await scanTree(root, opts);
  await hashCandidates(scan.records, opts.onProgress);
  const report = buildReport(scan.records, {
    dirs: scan.dirs,
    unreadable: scan.unreadable,
    skipped: scan.skipped,
    symlinks: scan.symlinks,
    truncated: scan.truncated,
    durationMs: Date.now() - started,
  }, { root, maxFiles: opts.maxFiles || MAX_FILES_DEFAULT });
  return report;
}

// ---------- yazdırma ----------

function paint(code, s, useColor) {
  return useColor ? `${code}${s}${C.reset}` : s;
}

function printReport(report, opts = {}) {
  const useColor = opts.color !== undefined ? opts.color : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const b = (s) => (useColor ? `${C.bold}${s}${C.reset}` : s);
  const d = (s) => (useColor ? `${C.dim}${s}${C.reset}` : s);
  const s = report.summary;

  console.log('');
  console.log(b('Arşiv Denetçisi — salt okunur tarama'));
  console.log(d('-'.repeat(64)));
  console.log(`Klasör : ${report.root}`);
  console.log(`Taranan: ${fmtNum(s.files)} dosya, ${fmtNum(s.dirs)} klasör, ${fmtBytes(s.bytes)}`);
  console.log(`Medya  : ${fmtNum(s.images)} görsel, ${fmtNum(s.videos)} video`);
  console.log(`Süre   : ${(s.durationMs / 1000).toFixed(1)} sn${s.truncated ? ' (dosya sınırına ulaşıldı)' : ''}`);
  console.log('');

  console.log(b('Tür dağılımı (ilk 10)'));
  for (const e of report.byExt.slice(0, 10)) {
    console.log(`  ${e.ext.padEnd(12)} ${fmtNum(e.count).padStart(8)} dosya  ${fmtBytes(e.bytes).padStart(10)}`);
  }
  console.log('');

  console.log(b('Yıla göre'));
  for (const y of report.byYear) {
    console.log(`  ${String(y.year).padEnd(6)} ${fmtNum(y.count).padStart(8)} dosya  ${fmtBytes(y.bytes).padStart(10)}`);
  }
  console.log('');

  console.log(b('Bulgular'));
  if (s.duplicateGroups > 0) {
    console.log(paint(C.yellow, `  Kopya: ${fmtNum(s.duplicateGroups)} grup, ${fmtNum(s.duplicateFiles)} dosya, ${fmtBytes(s.duplicateWastedBytes)} fazlalık`, useColor));
    for (const g of report.duplicates.examples.slice(0, 5)) {
      console.log(`    [${g.count} dosya, ${fmtBytes(g.size)}]`);
      for (const f of g.files.slice(0, 4)) console.log(d(`      ${f}`));
      if (g.files.length > 4) console.log(d(`      ... +${g.files.length - 4}`));
    }
  } else {
    console.log('  Kopya: yok');
  }

  if (report.sameName.groups > 0) {
    console.log(paint(C.cyan, `  Aynı ad: ${fmtNum(report.sameName.groups)} grup, ${fmtNum(report.sameName.files)} dosya`, useColor));
    for (const g of report.sameName.examples.slice(0, 3)) {
      console.log(`    ${g.name} (${g.count})`);
      for (const f of g.files.slice(0, 3)) console.log(d(`      ${f}`));
    }
  }

  if (report.corrupt.length > 0) {
    console.log(paint(C.red, `  Bozuk / kesik / imza uyuşmazlığı: ${fmtNum(s.corrupt)} dosya`, useColor));
    for (const c of report.corrupt.slice(0, 8)) {
      console.log(`    ${c.rel} — ${c.reasons.join(', ')}`);
    }
    if (s.corrupt > 8) console.log(d(`    ... +${s.corrupt - 8}`));
  } else {
    console.log('  Bozuk/kesik/imza sorunu: yok');
  }

  if (s.zeroByte > 0) {
    console.log(paint(C.yellow, `  Sıfır bayt: ${fmtNum(s.zeroByte)} dosya`, useColor));
    for (const z of report.zeroByte.slice(0, 5)) console.log(`    ${z.rel}`);
  }

  if (s.hashErrors > 0) {
    console.log(paint(C.yellow, `  Hash okunamayan: ${fmtNum(s.hashErrors)} dosya (kopya analizine katılmadı)`, useColor));
  }

  if (s.unreadable > 0) {
    console.log(paint(C.yellow, `  Okunamayan: ${fmtNum(s.unreadable)} yol`, useColor));
    for (const u of report.unreadable.slice(0, 3)) console.log(`    ${u.path} (${u.code})`);
  }

  console.log('');
  console.log(b('En büyük dosyalar'));
  for (const f of report.largest.slice(0, 10)) {
    console.log(`  ${fmtBytes(f.size).padStart(10)}  ${f.rel}`);
  }
  console.log('');

  console.log(d('Hiçbir dosya silinmedi, taşınmadı veya değiştirilmedi. Rapor salt okunurdur.'));
  console.log('');
}

function printHelp() {
  console.log(`arsivci v${VERSION} — fotoğraf/video arşivi denetçisi (salt okunur)

Kullanım:
  node arsivci.mjs <klasör> [seçenekler]

Seçenekler:
  --json             Makine okunur çıktı
  --no-color         Renksiz çıktı
  --max-files=N      En fazla N dosya tara (varsayılan ${MAX_FILES_DEFAULT})
  --version          Sürüm
  --help             Bu yardım

Ne yapar:
  - Tür ve yıl bazında envanter
  - Birebir kopyalar (boyut ön filtresi + SHA-256)
  - Aynı adlı dosya grupları (farklı içerik olabilir)
  - Bozuk/kesik dosyalar (imza, JPEG EOI, PNG IEND, GIF sonu, WebP boyutu)
  - Görsel boyutları ve JPEG EXIF tarihi
  - En büyük dosyalar

Güvenlik: hiçbir dosya silinmez, taşınmaz, değiştirilmez; yalnızca okunur.`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (!opts.root) { console.error('Bir klasör yolu gerekli. --help ile kullanım.'); process.exitCode = 1; return; }
  const root = path.resolve(opts.root);
  let st;
  try { st = fs.statSync(root); } catch {
    console.error(`Klasör bulunamadı: ${root}`);
    process.exitCode = 1;
    return;
  }
  if (!st.isDirectory()) { console.error(`Klasör değil: ${root}`); process.exitCode = 1; return; }

  const tty = process.stderr.isTTY && !opts.json;
  const onProgress = (done, total) => {
    if (!tty) return;
    process.stderr.write(`\rTaranıyor: ${fmtNum(done)} dosya (${fmtNum(total)} kayıt)`);
  };

  try {
    const report = await inspect(root, { maxFiles: opts.maxFiles, onProgress });
    if (tty) process.stderr.write('\r\u001b[K');
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, { noColor: opts.noColor });
    process.exitCode = 0;
  } catch (e) {
    if (tty) process.stderr.write('\r\u001b[K');
    console.error('Tarama başarısız:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { parseArgs, detectKind, dimensions, exifDate, analyzeFile, scanTree, inspect, hashFile, fmtBytes, VERSION };
