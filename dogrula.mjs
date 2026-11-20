#!/usr/bin/env node
// dogrula — çalışma alanındaki *.test.mjs paketlerini koşar ve bilinen araçları dumansız bırakmaz.
// Sıfır bağımlılık, Node >= 20, ESM. Çıktı Türkçe; TAP ayrıştırması yerel ayardan bağımsızdır.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { checkSync } from './senkron.mjs';

const VERSION = '1.0.0';
const TEST_TIMEOUT_MS = 120000;
const SMOKE_TIMEOUT_MS = 30000;
const MAX_BUFFER = 32 * 1024 * 1024;

// Duman listesi sabit sırayla; dosya yoksa o araç hiç listelenmez.
const KNOWN_TOOLS = ['promptscope', 'aidoctor', 'arsivci', 'yedekci', 'arsiv-rapor', 'karsilastir', 'senkron', 'kutu'];

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const C = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', yellow: '\u001b[33m', green: '\u001b[32m',
};

// ---------- argümanlar ----------

function parseArgs(argv) {
  const opts = { json: false, noColor: false, dir: null, help: false, version: false, error: null };
  const takesValue = new Set(['--dir']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-color') { opts.noColor = true; continue; }
    if (takesValue.has(a)) {
      const v = inline !== null ? inline : argv[++i];
      if (!v || v.startsWith('-')) { opts.error = `${a} için bir klasör yolu gerekli.`; return opts; }
      opts.dir = v;
      continue;
    }
    opts.error = `Bilinmeyen argüman: ${argv[i]}`;
    return opts;
  }
  return opts;
}

// ---------- TAP ayrıştırma ----------

// Yerel ayardan bağımsız: yalnız ASCII anahtar + tam sayı. Eksik satırlar 0 sayılır.
// Hem TAP ("# pass 9") hem spec ("i pass 9") özet satırı biçimini kabul eder; son eşleşme kazanır.
export function parseTap(stdout) {
  const text = String(stdout === null || stdout === undefined ? '' : stdout);
  const found = { pass: null, fail: null, skipped: null };
  const re = /^\s*(?:#|\u2139)?\s*(pass|fail|skipped)\s*[:=]?\s*(\d+)\s*$/i;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    found[m[1].toLowerCase()] = Number(m[2]);
  }
  return {
    pass: found.pass === null ? 0 : found.pass,
    fail: found.fail === null ? 0 : found.fail,
    skipped: found.skipped === null ? 0 : found.skipped,
  };
}

// ---------- keşif ----------

function compareNames(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Klasörün doğrudan altındaki *.test.mjs dosyaları, ad sırasına göre, tam yol olarak.
export function discoverSuites(dir = SCRIPT_DIR) {
  const root = path.resolve(dir || SCRIPT_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.test.mjs'))
    .map((e) => path.join(root, e.name))
    .sort((a, b) => compareNames(path.basename(a), path.basename(b)));
}

// ---------- koşum ----------

// Üst süreç bir test koşucusuysa NODE_TEST_CONTEXT taşınır; alt `node --test` bunu görünce
// TAP yerine farklı bir protokolde konuşur. Temiz ortamla çağırmak TAP çıktısını garanti eder.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  return env;
}

function runSuite(file) {
  const started = Date.now();
  let res;
  try {
    res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd: path.dirname(file),
      encoding: 'utf8',
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      // DOGRULA_SELFTEST: dogrula.test.mjs kendi CLI'sini iç içe çağırmasın (özyineleme koruması).
      env: childEnv({ DOGRULA_SELFTEST: '1' }),
    });
  } catch (e) {
    res = { error: e, status: null, stdout: '', stderr: '' };
  }
  const durationMs = Date.now() - started;
  const stdout = String(res.stdout || '');
  const parsed = parseTap(stdout);
  // TAP her koşuda "# tests N" özeti basar; yoksa çıktı okunamamıştır -> sessiz yeşile güvenme.
  const hasSummary = /^\s*(?:#|\u2139)\s*(?:pass|fail|tests)\b/im.test(stdout);
  let status;
  if (res.error || typeof res.status !== 'number') status = 'hata';
  else if (parsed.fail > 0) status = 'başarısız';
  else if (res.status !== 0) status = 'hata';
  else if (!hasSummary) status = 'hata';
  else status = 'geçti';
  return {
    file,
    pass: parsed.pass,
    fail: parsed.fail,
    skipped: parsed.skipped,
    durationMs,
    status,
  };
}

function smokeTool(tool, dir) {
  const file = path.join(dir, `${tool}.mjs`);
  let res;
  try {
    res = spawnSync(process.execPath, [file, '--version'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: SMOKE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: childEnv(),
    });
  } catch {
    return { tool, status: 'hata', version: null };
  }
  const stdout = String(res.stdout || '').trim();
  const stderr = String(res.stderr || '').trim();
  if (!res.error && res.status === 0) {
    const bare = stdout.match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
    if (bare) return { tool, status: 'ok', version: bare[1] };
    // --version yok, araç yardım metnine düşmüş olabilir: sürümü metinden çıkar, atlandı say.
    const any = stdout.match(/\bv?(\d+\.\d+\.\d+)\b/);
    return { tool, status: 'atlandı', version: any ? any[1] : null };
  }
  // Sıfır olmayan çıkış: argüman tanınmadıysa araçta --version yoktur -> atlandı, yoksa hata.
  const hint = `${stdout}\n${stderr}`;
  if (/bilinmeyen argüman|unknown (argument|option)|kullan[ıi]m|usage/i.test(hint)) {
    return { tool, status: 'atlandı', version: null };
  }
  return { tool, status: 'hata', version: null };
}

function runAll(opts) {
  const started = Date.now();
  const dir = path.resolve(opts.dir || SCRIPT_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const err = new Error('E_KLASOR_YOK');
    err.code = 'E_KLASOR_YOK';
    throw err;
  }

  const suites = discoverSuites(dir).map(runSuite);
  const smoke = KNOWN_TOOLS
    .filter((tool) => fs.existsSync(path.join(dir, `${tool}.mjs`)))
    .map((tool) => smokeTool(tool, dir));

  // Skill bütünlüğü yalnız skills-src bulunan gerçek workspace'te denetlenir; geçici test klasörlerinde atlanır.
  let sync = null;
  if (fs.existsSync(path.join(dir, 'skills-src'))) {
    try {
      const skillsDir = process.env.DOGRULA_SKILLS_DIR || path.join(os.homedir(), '.qoder', 'skills');
      sync = checkSync(dir, skillsDir);
    } catch (e) {
      sync = { ok: false, drift: -1, skills: [], error: e && e.message ? e.message : 'check failed' };
    }
  }

  const totalTests = suites.reduce((n, s) => n + s.pass + s.fail, 0);
  const passedTests = suites.reduce((n, s) => n + s.pass, 0);
  const failedTests = suites.reduce((n, s) => n + s.fail, 0);
  const failedSuites = suites.filter((s) => s.status !== 'geçti').length;
  const failedSmoke = smoke.filter((s) => s.status === 'hata').length;
  const ok = failedSuites === 0 && failedSmoke === 0 && (!sync || sync.ok);

  return {
    ok,
    generatedAt: new Date().toISOString(),
    dir,
    suites,
    smoke,
    sync,
    summary: {
      totalTests,
      passedTests,
      failedTests,
      failedSuites,
      failedSmoke,
      skillDrift: sync ? sync.drift : null,
      durationMs: Date.now() - started,
      exitCode: ok ? 0 : 1,
    },
  };
}

// ---------- yazdırma ----------

function pad(s, w, right = false) {
  const str = String(s);
  if (str.length >= w) return str;
  const fill = ' '.repeat(w - str.length);
  return right ? fill + str : str + fill;
}

function fmtMs(ms) {
  return `${Math.round(ms)} ms`;
}

function printReport(report, opts = {}) {
  const useColor = opts.color !== undefined
    ? opts.color
    : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const paint = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);
  const b = (s) => paint(C.bold, s);
  const d = (s) => paint(C.dim, s);
  const line = () => d('-'.repeat(64));

  console.log('');
  console.log(b('Dogrula — test paketi ve araç duman denetimi'));
  console.log(line());
  console.log(`Klasör: ${report.dir}`);
  console.log('');

  if (report.suites.length === 0) {
    console.log(paint(C.yellow, 'Uyarı: klasörde *.test.mjs dosyası bulunamadı.'));
    console.log('');
  } else {
    const rows = report.suites.map((s) => {
      const name = s.status === 'geçti' ? path.basename(s.file) : `${path.basename(s.file)} [${s.status.toUpperCase()}]`;
      return {
        cells: [name, String(s.pass), String(s.fail), fmtMs(s.durationMs)],
        status: s.status,
      };
    });
    const header = ['suite', 'pass', 'fail', 'süre'];
    const w0 = Math.max(header[0].length, ...rows.map((r) => r.cells[0].length));
    const w1 = Math.max(header[1].length, ...rows.map((r) => r.cells[1].length));
    const w2 = Math.max(header[2].length, ...rows.map((r) => r.cells[2].length));
    const w3 = Math.max(header[3].length, ...rows.map((r) => r.cells[3].length));
    const render = (cells) => `${pad(cells[0], w0)}  ${pad(cells[1], w1, true)}  ${pad(cells[2], w2, true)}  ${pad(cells[3], w3, true)}`;

    console.log(b(render(header)));
    console.log(line());
    for (const r of rows) {
      if (r.status === 'geçti') console.log(render(r.cells));
      else console.log(paint(r.status === 'başarısız' ? C.red : C.yellow, render(r.cells)));
    }
    console.log(line());
  }

  if (report.smoke.length > 0) {
    console.log('');
    console.log(b('Duman denetimi (--version)'));
    const sRows = report.smoke.map((s) => [s.tool, s.status, s.version || '-']);
    const h = ['araç', 'durum', 'sürüm'];
    const hw0 = Math.max(h[0].length, ...sRows.map((r) => r[0].length));
    const hw1 = Math.max(h[1].length, ...sRows.map((r) => r[1].length));
    const hw2 = Math.max(h[2].length, ...sRows.map((r) => r[2].length));
    const renderS = (c) => `${pad(c[0], hw0)}  ${pad(c[1], hw1)}  ${pad(c[2], hw2)}`;
    console.log(b(renderS(h)));
    console.log(line());
    for (const r of sRows) {
      if (r[1] === 'ok') console.log(renderS(r));
      else if (r[1] === 'atlandı') console.log(paint(C.yellow, renderS(r)));
      else console.log(paint(C.red, renderS(r)));
    }
    console.log(line());
  }

  const s = report.summary;
  console.log('');
  if (report.sync) {
    const t = report.sync.ok
      ? paint(C.green, 'TEMİZ')
      : paint(C.red, `${report.sync.drift < 0 ? 'kontrol hatası' : `${report.sync.drift} fark`}`);
    console.log(`Skill bütünlüğü : ${t}`);
  }
  console.log(`Toplam test     : ${s.totalTests} (geçen ${s.passedTests}, başarısız ${s.failedTests})`);
  console.log(`Başarısız suite : ${s.failedSuites}`);
  console.log(`Hatalı duman    : ${s.failedSmoke}`);
  console.log(`Süre            : ${fmtMs(s.durationMs)}`);
  if (report.ok) console.log(paint(C.green, `Sonuç: BAŞARILI (çıkış ${s.exitCode})`));
  else console.log(paint(C.red, `Sonuç: BAŞARISIZ (çıkış ${s.exitCode})`));
  console.log('');
}

function printHelp() {
  console.log(`dogrula v${VERSION} — test paketi koşucusu ve araç duman denetleyicisi

Kullanım:
  node dogrula.mjs [seçenekler]

Seçenekler:
  --dir <klasör>   Taranacak klasör (varsayılan: betiğin bulunduğu klasör)
  --json           Makine okunur çıktı
  --no-color       Renksiz çıktı
  --version        Sürüm
  --help           Bu yardım

Davranış:
  · Klasördeki tüm *.test.mjs dosyaları ad sırasına göre koşulur (node --test, TAP).
  · Bilinen araçlar (${KNOWN_TOOLS.join(', ')}) --version ile dumandan geçirilir.
  · skills-src varsa skill kopyaları senkron denetiminden geçirilir (DOGRULA_SKILLS_DIR ile kök değişir).
  · --version desteklemeyen araç "atlandı" sayılır, başarısızlık değildir.
Çıkış kodu: 0 = her şey temiz, 1 = en az bir suite, duman veya skill farkı hatası.`);
}

// ---------- giriş ----------

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exit(1); }
  if (opts.help) { printHelp(); process.exit(0); }
  if (opts.version) { console.log(VERSION); process.exit(0); }
  try {
    const report = runAll(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, { noColor: opts.noColor });
    process.exit(report.summary.exitCode);
  } catch (e) {
    if (e && e.code === 'E_KLASOR_YOK') {
      console.error(`Klasör bulunamadı: ${opts.dir}`);
      process.exit(1);
    }
    console.error('Beklenmeyen hata:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { parseArgs, runSuite, smokeTool, runAll, printReport, main, VERSION, KNOWN_TOOLS, SCRIPT_DIR };
