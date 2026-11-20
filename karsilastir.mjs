#!/usr/bin/env node
// karsilastir — iki arsivci JSON raporunu karşılaştırır (temizlik öncesi/sonrası).
// Sıfır bağımlılık, salt okunur.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const nf = new Intl.NumberFormat('tr-TR');
const fmtNum = (n) => nf.format(Number(n) || 0);

function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const KEYS = [
  ['files', 'Dosya', 'count'],
  ['bytes', 'Boyut', 'bytes'],
  ['images', 'Görsel', 'count'],
  ['videos', 'Video', 'count'],
  ['corrupt', 'Bozuk', 'count'],
  ['zeroByte', 'Sıfır bayt', 'count'],
  ['duplicateGroups', 'Kopya grubu', 'count'],
  ['duplicateFiles', 'Kopya dosya', 'count'],
  ['duplicateWastedBytes', 'Kopya fazlalığı', 'bytes'],
  ['unreadable', 'Okunamayan', 'count'],
];

function num(report, key) {
  const v = report && report.summary ? report.summary[key] : 0;
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function compareReports(oldR, newR) {
  const warnings = [];
  if (!oldR || oldR.tool !== 'arsivci') warnings.push('Eski rapor arsivci biçiminde değil.');
  if (!newR || newR.tool !== 'arsivci') warnings.push('Yeni rapor arsivci biçiminde değil.');
  if ((oldR && oldR.root) !== (newR && newR.root)) warnings.push('Raporların kök klasörleri farklı.');

  const deltas = KEYS.map(([key, label, kind]) => {
    const oldV = num(oldR, key);
    const newV = num(newR, key);
    return {
      key, label, kind,
      old: oldV, new: newV,
      delta: newV - oldV,
      pct: oldV === 0 ? null : Math.round(((newV - oldV) / oldV) * 1000) / 10,
    };
  });

  const extMap = new Map();
  for (const e of (oldR && Array.isArray(oldR.byExt) ? oldR.byExt : [])) {
    extMap.set(e.ext, { ext: e.ext, oldCount: Number(e.count) || 0, oldBytes: Number(e.bytes) || 0, newCount: 0, newBytes: 0 });
  }
  for (const e of (newR && Array.isArray(newR.byExt) ? newR.byExt : [])) {
    const cur = extMap.get(e.ext) || { ext: e.ext, oldCount: 0, oldBytes: 0, newCount: 0, newBytes: 0 };
    cur.newCount = Number(e.count) || 0;
    cur.newBytes = Number(e.bytes) || 0;
    extMap.set(e.ext, cur);
  }
  const byExt = [...extMap.values()]
    .map((e) => ({ ...e, countDelta: e.newCount - e.oldCount, bytesDelta: e.newBytes - e.oldBytes }))
    .filter((e) => e.countDelta !== 0 || e.bytesDelta !== 0)
    .sort((a, b) => Math.abs(b.bytesDelta) - Math.abs(a.bytesDelta));

  const dupOld = num(oldR, 'duplicateWastedBytes');
  const dupNew = num(newR, 'duplicateWastedBytes');
  const corOld = num(oldR, 'corrupt');
  const corNew = num(newR, 'corrupt');
  const zeroOld = num(oldR, 'zeroByte');
  const zeroNew = num(newR, 'zeroByte');

  const regressed = (dupNew > dupOld || corNew > corOld || zeroNew > zeroOld);
  const improved = (dupNew < dupOld || corNew < corOld || zeroNew < zeroOld);
  const verdict = regressed ? 'Kötüleşti' : improved ? 'İyileşti' : 'Değişmedi';
  const why = regressed
    ? 'Kopya fazlalığı, bozuk veya sıfır bayt sayısı arttı.'
    : improved
      ? 'Kopya fazlalığı, bozuk veya sıfır bayt sayısı azaldı.'
      : 'İzlenen üç risk metriği de aynı kaldı.';

  return {
    ok: true,
    old: { root: oldR && oldR.root, generatedAt: oldR && oldR.generatedAt },
    new: { root: newR && newR.root, generatedAt: newR && newR.generatedAt },
    deltas, byExt, warnings, verdict, why,
    exitCode: regressed ? 2 : 0,
  };
}

function parseArgs(argv) {
  const opts = { files: [], json: false, noColor: false, help: false, version: false, error: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-color') { opts.noColor = true; continue; }
    if (a.startsWith('-')) { opts.error = `Bilinmeyen argüman: ${a}`; return opts; }
    opts.files.push(a);
  }
  return opts;
}

function readReport(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function signed(v, kind) {
  const s = kind === 'bytes' ? fmtBytes(Math.abs(v)) : fmtNum(Math.abs(v));
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${s}`;
}

function printReport(r, opts = {}) {
  const useColor = opts.color !== undefined ? opts.color : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const paint = (code, s) => (useColor ? `${code}${s}\u001b[0m` : s);
  const b = (s) => paint('\u001b[1m', s);
  const d = (s) => paint('\u001b[2m', s);

  console.log('');
  console.log(b('Arşiv Karşılaştırma'));
  console.log(d('-'.repeat(62)));
  console.log(`Eski: ${r.old.root}  ${r.old.generatedAt || ''}`);
  console.log(`Yeni: ${r.new.root}  ${r.new.generatedAt || ''}`);
  console.log('');
  console.log(b('Metrikler'));
  for (const x of r.deltas) {
    const delta = x.kind === 'bytes' ? signed(x.delta, 'bytes') : signed(x.delta, 'count');
    const pct = x.pct === null ? '' : ` (${x.pct > 0 ? '+' : ''}${x.pct}%)`;
    console.log(`  ${x.label.padEnd(18)} ${String(x.old).padStart(10)} → ${String(x.new).padStart(10)}   ${delta}${pct}`);
  }
  if (r.byExt.length > 0) {
    console.log('');
    console.log(b('Tür farkları'));
    for (const e of r.byExt.slice(0, 15)) {
      console.log(`  ${e.ext.padEnd(12)} ${signed(e.countDelta, 'count').padStart(8)} dosya  ${signed(e.bytesDelta, 'bytes')}`);
    }
  }
  console.log('');
  const color = r.verdict === 'İyileşti' ? '\u001b[32m' : r.verdict === 'Kötüleşti' ? '\u001b[31m' : '\u001b[36m';
  console.log(`Sonuç: ${paint(color, r.verdict)} — ${r.why}`);
  for (const w of r.warnings) console.log(paint('\u001b[33m', `Uyarı: ${w}`));
  console.log('');
}

function printHelp() {
  console.log(`karsilastir v${VERSION} — iki arsivci raporunu karşılaştırır

Kullanım:
  node karsilastir.mjs <eski.json> <yeni.json> [--json] [--no-color]

Çıktı: metrik farkları, tür bazlı değişim, verdi (İyileşti/Kötüleşti/Değişmedi).
Çıkış kodu: 0 = karşılaştırıldı, 2 = kötüleşme, 1 = kullanım/JSON hatası.`);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (opts.files.length !== 2) { console.error('İki JSON yolu gerekli. --help ile kullanım.'); process.exitCode = 1; return; }

  let oldR;
  let newR;
  try {
    oldR = readReport(path.resolve(opts.files[0]));
    newR = readReport(path.resolve(opts.files[1]));
  } catch (e) {
    console.error('Rapor okunamadı veya geçerli JSON değil:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  const r = compareReports(oldR, newR);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else printReport(r, { noColor: opts.noColor });
  process.exitCode = r.exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { compareReports, parseArgs, VERSION };
