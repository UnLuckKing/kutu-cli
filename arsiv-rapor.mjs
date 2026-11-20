#!/usr/bin/env node
// arsiv-rapor — arsivci JSON çıktısını tek dosyalık HTML raporuna çevirir.
// Sıfır bağımlılık; tüm dinamik değerler HTML-escape edilir.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const nf = new Intl.NumberFormat('tr-TR');

function fmtNum(n) {
  return nf.format(Number(n) || 0);
}

function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function table(headers, rows) {
  const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`;
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="empty">Kayıt yok</td></tr>`;
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderHtml(report) {
  const s = report.summary || {};
  const root = report.root || '(bilinmiyor)';
  const escRoot = esc(root);
  const byExt = Array.isArray(report.byExt) ? report.byExt : [];
  const byYear = Array.isArray(report.byYear) ? report.byYear : [];
  const dup = report.duplicates || { examples: [] };
  const sameName = report.sameName || { examples: [] };
  const corrupt = Array.isArray(report.corrupt) ? report.corrupt : [];
  const zeroByte = Array.isArray(report.zeroByte) ? report.zeroByte : [];
  const largest = Array.isArray(report.largest) ? report.largest : [];
  const unreadable = Array.isArray(report.unreadable) ? report.unreadable : [];

  const cards = [
    ['Dosya', fmtNum(s.files)],
    ['Boyut', fmtBytes(s.bytes)],
    ['Görsel', fmtNum(s.images)],
    ['Video', fmtNum(s.videos)],
    ['Kopya fazlalığı', fmtBytes(s.duplicateWastedBytes)],
    ['Bozuk / imza', fmtNum(s.corrupt)],
  ].map(([label, value]) => `<div class="card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');

  const extRows = byExt.slice(0, 15).map((e) => [esc(e.ext), fmtNum(e.count), fmtBytes(e.bytes)]);
  const yearRows = byYear.map((y) => [esc(y.year), fmtNum(y.count), fmtBytes(y.bytes)]);
  const dupRows = (dup.examples || []).map((g) => [
    fmtNum(g.count), fmtBytes(g.size),
    `<ul>${(g.files || []).slice(0, 8).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`,
  ]);
  const nameRows = (sameName.examples || []).slice(0, 10).map((g) => [
    esc(g.name), fmtNum(g.count),
    `<ul>${(g.files || []).slice(0, 5).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`,
  ]);
  const corruptRows = corrupt.map((c) => [esc(c.rel || c.path), esc((c.reasons || []).join(', '))]);
  const zeroRows = zeroByte.map((z) => [esc(z.rel || z.path)]);
  const largestRows = largest.slice(0, 15).map((f) => [esc(f.rel || f.path), fmtBytes(f.size)]);
  const unreadableRows = unreadable.slice(0, 20).map((u) => [esc(u.path), esc(u.code || '')]);

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Arşiv Raporu — ${escRoot}</title>
<style>
  :root { --fg:#1b1f24; --bg:#f6f7f9; --card:#fff; --line:#d8dde4; --muted:#5b6572; --accent:#2f6fdf; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8eaed; --bg:#14171a; --card:#1d2125; --line:#333a41; --muted:#9aa4b2; --accent:#6ea8ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px; font:15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width:1100px; margin:0 auto; }
  header { margin-bottom:24px; }
  h1 { margin:0 0 6px; font-size:26px; }
  h2 { margin:32px 0 10px; font-size:18px; }
  .meta { color:var(--muted); font-size:13px; word-break:break-all; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin:20px 0 8px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card strong { display:block; margin-top:6px; font-size:20px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  td ul { margin:0; padding-left:18px; }
  .empty { color:var(--muted); font-style:italic; }
  footer { margin-top:32px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:14px; }
  @media print { body { background:#fff; padding:0; } .card, table { break-inside:avoid; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Arşiv Raporu</h1>
    <div class="meta">${escRoot}</div>
    <div class="meta">Tarama: ${esc(report.generatedAt || '')} · Süre: ${esc(((s.durationMs || 0) / 1000).toFixed(1))} sn${s.truncated ? ' · dosya sınırına ulaşıldı' : ''}</div>
  </header>
  <section class="cards">${cards}</section>

  <h2>Tür dağılımı</h2>
  ${table(['Uzantı', 'Dosya', 'Boyut'], extRows)}

  <h2>Yıla göre</h2>
  ${table(['Yıl', 'Dosya', 'Boyut'], yearRows)}

  <h2>Kopya grupları (${fmtNum((dup.examples || []).length)} örnek / ${fmtNum(dup.groups)} grup)</h2>
  ${table(['Dosya sayısı', 'Boyut', 'Dosyalar'], dupRows)}

  <h2>Aynı ad grupları</h2>
  ${table(['Ad', 'Adet', 'Dosyalar'], nameRows)}

  <h2>Bozuk / kesik / imza uyuşmazlığı</h2>
  ${table(['Dosya', 'Neden'], corruptRows)}

  <h2>Sıfır bayt</h2>
  ${table(['Dosya'], zeroRows)}

  <h2>En büyük dosyalar</h2>
  ${table(['Dosya', 'Boyut'], largestRows)}

  <h2>Okunamayan yollar</h2>
  ${table(['Yol', 'Kod'], unreadableRows)}

  <footer>Salt okunur rapor; hiçbir dosya değiştirilmedi. arsivci uyumlu · arsiv-rapor v${esc(VERSION)}</footer>
</main>
</body>
</html>
`;
}

function parseArgs(argv) {
  const opts = { input: null, out: null, open: false, json: false, help: false, version: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--open') { opts.open = true; continue; }
    if (a === '-o' || a === '--out') { opts.out = argv[++i] || null; continue; }
    if (a.startsWith('-')) { opts.error = `Bilinmeyen argüman: ${a}`; return opts; }
    if (opts.input) { opts.error = 'Tek bir JSON yolu verin.'; return opts; }
    opts.input = a;
  }
  return opts;
}

function printHelp() {
  console.log(`arsiv-rapor v${VERSION} — arsivci JSON raporunu HTML'e çevirir

Kullanım:
  node arsiv-rapor.mjs <arsivci.json> [-o cikti.html] [--open] [--json]

Seçenekler:
  -o, --out <yol>  Çıktı dosyası (varsayılan: girdi adı + .html)
  --open           Raporu varsayılan tarayıcıda açar
  --json           Konsola küçük özet yazar
  --version        Sürüm
  --help           Bu yardım

Çıkış kodu: 0 = başarılı, 1 = girdi/çıktı hatası.`);
}

function openFile(file) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (!opts.input) { console.error('Girdi JSON yolu gerekli. --help ile kullanım.'); process.exitCode = 1; return; }

  const input = path.resolve(opts.input);
  let raw;
  try { raw = fs.readFileSync(input, 'utf8'); } catch {
    console.error(`Dosya okunamadı: ${input}`);
    process.exitCode = 1;
    return;
  }
  let report;
  try { report = JSON.parse(raw); } catch {
    console.error('Girdi geçerli JSON değil.');
    process.exitCode = 1;
    return;
  }
  if (!report || report.tool !== 'arsivci' || typeof report.summary !== 'object' || report.summary === null) {
    console.error('Girdi arsivci raporu değil (tool="arsivci" ve summary bekleniyor).');
    process.exitCode = 1;
    return;
  }

  const out = path.resolve(opts.out || input.replace(/\.json$/i, '') + (opts.out ? '' : '.html'));
  const html = renderHtml(report);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, 'utf8');
  } catch (e) {
    console.error('Yazılamadı:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  if (opts.open) { try { openFile(out); } catch { /* tarayıcı açılamadı */ } }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, input, output: out, bytes: Buffer.byteLength(html, 'utf8') }));
  } else {
    console.log('');
    console.log(`Rapor yazıldı: ${out}`);
    console.log(`Girdi: ${input}`);
    console.log('Hiçbir dosya değiştirilmedi.');
    console.log('');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { renderHtml, esc, fmtBytes, parseArgs, VERSION };
