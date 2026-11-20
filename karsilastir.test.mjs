import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareReports, VERSION } from './karsilastir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'karsilastir.mjs');

function report(over = {}) {
  return {
    tool: 'arsivci', root: 'D:\\ARSIV', generatedAt: '2026-10-29T00:00:00.000Z',
    summary: {
      files: 100, bytes: 10000, images: 90, videos: 5, corrupt: 2, zeroByte: 1,
      duplicateGroups: 3, duplicateFiles: 6, duplicateWastedBytes: 1000, unreadable: 0,
      ...over.summary,
    },
    byExt: over.byExt || [
      { ext: '.jpg', count: 90, bytes: 9000 },
      { ext: '.mp4', count: 5, bytes: 1000 },
    ],
  };
}

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'karsilastir-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('iyileşme: fazlalık ve bozuk azalır', () => {
  const r = compareReports(
    report(),
    report({ summary: { duplicateWastedBytes: 400, corrupt: 1 }, byExt: [{ ext: '.jpg', count: 70, bytes: 7000 }] }),
  );
  assert.equal(r.verdict, 'İyileşti');
  assert.equal(r.exitCode, 0);
  const dup = r.deltas.find((d) => d.key === 'duplicateWastedBytes');
  assert.equal(dup.delta, -600);
  assert.equal(dup.pct, -60);
  const ext = r.byExt.find((e) => e.ext === '.jpg');
  assert.equal(ext.countDelta, -20);
});

test('kötüleşme: fazlalık artar', () => {
  const r = compareReports(report(), report({ summary: { duplicateWastedBytes: 2500 } }));
  assert.equal(r.verdict, 'Kötüleşti');
  assert.equal(r.exitCode, 2);
});

test('değişmedi: tüm risk metrikleri aynı', () => {
  const r = compareReports(report(), report());
  assert.equal(r.verdict, 'Değişmedi');
  assert.equal(r.exitCode, 0);
});

test('eski değer 0 iken yüzde hesaplanmaz', () => {
  const r = compareReports(report({ summary: { zeroByte: 0 } }), report({ summary: { zeroByte: 5 } }));
  const z = r.deltas.find((d) => d.key === 'zeroByte');
  assert.equal(z.pct, null);
  assert.equal(z.delta, 5);
});

test('farklı kök uyarı üretir, karşılaştırma sürer', () => {
  const r = compareReports(report(), { ...report(), root: 'E:\\Baska' });
  assert.ok(r.warnings.some((w) => w.includes('kök')));
  assert.equal(r.ok, true);
});

test('CLI: kötüleşme 2, geçersiz JSON 1, sürüm 0', (t) => {
  const dir = mkTmp(t);
  const a = writeJson(dir, 'a.json', report());
  const b = writeJson(dir, 'b.json', report({ summary: { duplicateWastedBytes: 2000 } }));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'bozuk');

  const reg = spawnSync(process.execPath, [CLI, a, b, '--json'], { encoding: 'utf8' });
  assert.equal(reg.status, 2, reg.stderr);
  assert.equal(JSON.parse(reg.stdout).verdict, 'Kötüleşti');

  const invalid = spawnSync(process.execPath, [CLI, a, bad], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);

  const ver = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), VERSION);
});
