import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTap, discoverSuites, VERSION } from './dogrula.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'dogrula.mjs');

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dogrula-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('parseTap: normal TAP özeti', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: bir şey',
    'ok 1 - bir şey',
    '# Subtest: öteki',
    'not ok 2 - öteki',
    '1..2',
    '# tests 2',
    '# suites 0',
    '# pass 1',
    '# fail 1',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 12.5',
  ].join('\n');
  assert.deepEqual(parseTap(tap), { pass: 1, fail: 1, skipped: 0 });
});

test('parseTap: sıfır test', () => {
  const tap = ['TAP version 13', '1..0', '# tests 0', '# pass 0', '# fail 0', '# skipped 0'].join('\r\n');
  assert.deepEqual(parseTap(tap), { pass: 0, fail: 0, skipped: 0 });
});

test('parseTap: eksik satırlar 0 sayılır, çöp girdi çökmez', () => {
  assert.deepEqual(parseTap('# pass 7'), { pass: 7, fail: 0, skipped: 0 });
  assert.deepEqual(parseTap('# fail 3'), { pass: 0, fail: 3, skipped: 0 });
  assert.deepEqual(parseTap('# skipped 2'), { pass: 0, fail: 0, skipped: 2 });
  assert.deepEqual(parseTap(''), { pass: 0, fail: 0, skipped: 0 });
  assert.deepEqual(parseTap(null), { pass: 0, fail: 0, skipped: 0 });
  assert.deepEqual(parseTap('rastgele metin\nok 1 - x'), { pass: 0, fail: 0, skipped: 0 });
});

test('parseTap: test adı içinde geçen sayılar özetle karışmaz', () => {
  const tap = ['ok 1 - pass 5 kuralı', 'ok 2 - 1..2', '# pass 2', '# fail 0'].join('\n');
  assert.deepEqual(parseTap(tap), { pass: 2, fail: 0, skipped: 0 });
});

test('parseTap: son özet satırı kazanır (uçbirim artıkları)', () => {
  const tap = ['# pass 4', '# fail 0', '# pass 9', '# fail 1'].join('\n');
  assert.deepEqual(parseTap(tap), { pass: 9, fail: 1, skipped: 0 });
});

test('parseTap: spec raporlayıcı biçimi de okunur', () => {
  const out = ['\u2139 tests 3', '\u2139 pass 3', '\u2139 fail 0', '\u2139 skipped 1'].join('\n');
  assert.deepEqual(parseTap(out), { pass: 3, fail: 0, skipped: 1 });
});

test('discoverSuites: gerçek klasördeki paketleri bulur ve sıralar', () => {
  const suites = discoverSuites(HERE);
  const names = suites.map((f) => path.basename(f));
  for (const expected of ['promptscope.test.mjs', 'aidoctor.test.mjs', 'arsivci.test.mjs', 'yedekci.test.mjs', 'dogrula.test.mjs']) {
    assert.ok(names.includes(expected), `eksik: ${expected}`);
  }
  assert.ok(names.every((n) => n.endsWith('.test.mjs')), 'yalnız .test.mjs dönmeli');
  assert.ok(suites.every((f) => path.isAbsolute(f) && fs.existsSync(f)), 'yollar tam ve var olmalı');
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en'));
  assert.deepEqual(names, sorted);
});

test('discoverSuites: yalnız .test.mjs, alt klasöre inmez', (t) => {
  const dir = mkTmp(t);
  fs.writeFileSync(path.join(dir, 'b.test.mjs'), '');
  fs.writeFileSync(path.join(dir, 'a.test.mjs'), '');
  fs.writeFileSync(path.join(dir, 'arac.mjs'), '');
  fs.writeFileSync(path.join(dir, 'notlar.md'), '');
  fs.mkdirSync(path.join(dir, 'alt'));
  fs.writeFileSync(path.join(dir, 'alt', 'c.test.mjs'), '');
  assert.deepEqual(discoverSuites(dir), [path.join(dir, 'a.test.mjs'), path.join(dir, 'b.test.mjs')]);
  assert.deepEqual(discoverSuites(path.join(dir, 'yok')), []);
});

// CLI duman testi: dogrula.test.mjs kendisi de çalışma alanında keşfedilir.
// dogrula.mjs bu testi koşarken DOGRULA_SELFTEST=1 verir; o durumda iç içe spawn
// özyinelemeye yol açacağı için test atlanır. Doğrudan `node --test dogrula.test.mjs`
// koşusunda ise geçici ve boş bir klasör verilir; orada dogrula.test.mjs yoktur,
// dolayısıyla özyineleme oluşmaz ve koşu hızlı biter.
test('CLI: --json çıktısı ayrıştırılır ve ok alanı boolean', (t) => {
  if (process.env.DOGRULA_SELFTEST === '1') {
    t.skip('dogrula.mjs içinden koşuluyor; iç içe spawn özyinelemesini önlemek için atlandı');
    return;
  }
  const dir = mkTmp(t);
  fs.writeFileSync(
    path.join(dir, 'ornek.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('geçer', () => assert.equal(1, 1));\n",
  );

  const r = spawnSync(process.execPath, [CLI, '--json', '--dir', dir], {
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.suites));
  assert.equal(report.suites.length, 1);
  assert.equal(report.suites[0].pass, 1);
  assert.equal(report.suites[0].fail, 0);
  assert.equal(report.suites[0].status, 'geçti');
  assert.equal(typeof report.generatedAt, 'string');
  assert.ok(report.summary && report.summary.totalTests === 1);
  assert.equal(report.summary.failedSuites, 0);
});

test('CLI: --version sürümü yazar', () => {
  const r = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
});

test('CLI: olmayan klasör 1 ile çıkar', () => {
  const r = spawnSync(process.execPath, [CLI, '--json', '--dir', path.join(os.tmpdir(), 'dogrula-yok-klasor')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Klasör bulunamadı/);
});
