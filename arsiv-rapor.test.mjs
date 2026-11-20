import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHtml, VERSION } from './arsiv-rapor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'arsiv-rapor.mjs');

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arsiv-rapor-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function fixture(root = 'D:\\ARSIV') {
  return {
    tool: 'arsivci', version: '1.0.0', generatedAt: '2026-10-29T00:00:00.000Z',
    root,
    summary: {
      files: 10, dirs: 2, bytes: 2048, images: 8, videos: 1, corrupt: 1, zeroByte: 1,
      duplicateGroups: 1, duplicateFiles: 2, duplicateWastedBytes: 1024,
      unreadable: 0, skippedDirs: 1, symlinks: 0, truncated: false, durationMs: 1500,
    },
    byExt: [{ ext: '.jpg', count: 8, bytes: 1024 }, { ext: '.mp4', count: 1, bytes: 900 }],
    byYear: [{ year: 2021, count: 5, bytes: 800 }],
    duplicates: { groups: 1, files: 2, wastedBytes: 1024, examples: [{ hash: 'abc', size: 1024, count: 2, files: ['a.jpg', 'b.jpg'] }] },
    sameName: { groups: 0, files: 0, examples: [] },
    corrupt: [{ path: 'D:\\ARSIV\\bozuk.jpg', rel: 'bozuk.jpg', reasons: ['JPEG sonu (EOI) eksik'] }],
    zeroByte: [{ path: 'D:\\ARSIV\\bos.txt', rel: 'bos.txt' }],
    largest: [{ path: 'D:\\ARSIV\\a.jpg', rel: 'a.jpg', size: 1024 }],
    unreadable: [],
  };
}

test('renderHtml bölümleri üretir', () => {
  const html = renderHtml(fixture());
  assert.ok(html.includes('Arşiv Raporu'));
  assert.ok(html.includes('D:\\ARSIV'));
  assert.ok(html.includes('Kopya grupları'));
  assert.ok(html.includes('Tür dağılımı'));
  assert.ok(html.includes('bozuk.jpg'));
  assert.ok(html.includes('Salt okunur rapor'));
  assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org[^"']*/g, '')), 'dış URL olmamalı');
});

test('HTML escape: script enjeksiyonu çalışmaz', () => {
  const html = renderHtml(fixture('<script>alert(1)</script>'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('boş diziler çökmez', () => {
  const r = fixture();
  r.byExt = []; r.byYear = []; r.corrupt = []; r.zeroByte = []; r.largest = []; r.unreadable = [];
  r.duplicates = { groups: 0, files: 0, wastedBytes: 0, examples: [] };
  r.sameName = { groups: 0, files: 0, examples: [] };
  const html = renderHtml(r);
  assert.ok(html.includes('Kayıt yok'));
});

test('CLI: geçersiz girdi 1, geçerli girdi dosya yazar', (t) => {
  const dir = mkTmp(t);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'bozuk');
  const badRun = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf8' });
  assert.equal(badRun.status, 1);

  const notArsiv = path.join(dir, 'x.json');
  fs.writeFileSync(notArsiv, JSON.stringify({ tool: 'baska', summary: {} }));
  assert.equal(spawnSync(process.execPath, [CLI, notArsiv], { encoding: 'utf8' }).status, 1);

  const input = path.join(dir, 'rapor.json');
  fs.writeFileSync(input, JSON.stringify(fixture()));
  const run = spawnSync(process.execPath, [CLI, input, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(out.output));
  assert.ok(fs.readFileSync(out.output, 'utf8').includes('Arşiv Raporu'));

  const ver = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), VERSION);
});
