import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectKind, dimensions, exifDate, inspect, VERSION } from './arsivci.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'arsivci.mjs');

function pngBytes(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const len = Buffer.alloc(4); len.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR', 'ascii');
  const data = Buffer.alloc(13);
  data.writeUInt32BE(w, 0); data.writeUInt32BE(h, 4);
  data[8] = 8; data[9] = 6;
  const crc = Buffer.alloc(4);
  const endLen = Buffer.alloc(4);
  const endType = Buffer.from('IEND', 'ascii');
  return Buffer.concat([sig, len, type, data, crc, endLen, endType, crc]);
}

function jpegMiddle(w, h) {
  const head = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08]);
  const dims = Buffer.alloc(4);
  dims.writeUInt16BE(h, 0); dims.writeUInt16BE(w, 2);
  return Buffer.concat([head, dims, Buffer.from([0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
}

function jpegBytes(w, h, { eoi = true } = {}) {
  const parts = [Buffer.from([0xFF, 0xD8]), jpegMiddle(w, h)];
  if (eoi) parts.push(Buffer.from([0xFF, 0xD9]));
  return Buffer.concat(parts);
}

function exifJpeg(w, h, dateStr) {
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x2A, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40);
  tiff.write(dateStr, 44, 'ascii');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), len, payload, jpegMiddle(w, h), Buffer.from([0xFF, 0xD9])]);
}

function gifBytes(w, h) {
  const head = Buffer.from('GIF89a', 'ascii');
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(w, 0); dims.writeUInt16LE(h, 2);
  return Buffer.concat([head, dims, Buffer.from([0x00, 0x00, 0x00, 0x3B])]);
}

function webpBytes(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b[20] = 0;
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arsivci-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function write(root, rel, data) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return full;
}

function buildFixture(t) {
  const root = mkTmp(t);
  write(root, 'a.png', pngBytes(100, 50));
  write(root, 'dup/a2.png', pngBytes(100, 50));
  write(root, 'b.jpg', exifJpeg(640, 480, '2021:07:14 12:33:01'));
  write(root, 'broken.jpg', jpegBytes(320, 240, { eoi: false }));
  write(root, 'fake.png', Buffer.from('bu bir metin', 'utf8'));
  write(root, 'empty.bin', Buffer.alloc(0));
  write(root, 't1.txt', Buffer.from('merhaba', 'utf8'));
  write(root, 't2.txt', Buffer.from('merhaba', 'utf8'));
  write(root, 'p1/photo.jpg', jpegBytes(100, 50));
  write(root, 'p2/photo.jpg', jpegBytes(200, 100));
  const old = write(root, 'old.txt', Buffer.from('eski not', 'utf8'));
  const d = new Date('2019-05-06T12:00:00Z');
  fs.utimesSync(old, d, d);
  write(root, 'node_modules/skip.png', pngBytes(10, 10));
  return root;
}

test('imza ve boyut: png, jpeg, gif, webp', () => {
  const png = pngBytes(1920, 1080);
  assert.equal(detectKind(png), 'png');
  assert.deepEqual(dimensions('png', png), { width: 1920, height: 1080 });

  const jpg = jpegBytes(640, 480);
  assert.equal(detectKind(jpg), 'jpeg');
  assert.deepEqual(dimensions('jpeg', jpg), { width: 640, height: 480 });

  const gif = gifBytes(320, 200);
  assert.equal(detectKind(gif), 'gif');
  assert.deepEqual(dimensions('gif', gif), { width: 320, height: 200 });

  const webp = webpBytes(800, 600);
  assert.equal(detectKind(webp), 'webp');
  assert.deepEqual(dimensions('webp', webp), { width: 800, height: 600 });

  assert.equal(detectKind(Buffer.from('metin')), null);
});

test('EXIF tarihi okunur', () => {
  const jpg = exifJpeg(640, 480, '2021:07:14 12:33:01');
  assert.equal(exifDate(jpg), '2021-07-14');
  assert.equal(exifDate(jpegBytes(10, 10)), null);
});

test('inspect: envanter, kopya, bozuk, sıfır bayt, yıl', async (t) => {
  const root = buildFixture(t);
  const r = await inspect(root, {});
  assert.equal(r.summary.files, 11);
  assert.equal(r.summary.images, 7);
  assert.equal(r.summary.truncated, false);

  assert.equal(r.summary.duplicateGroups, 2);
  assert.equal(r.summary.duplicateFiles, 4);
  assert.ok(r.summary.duplicateWastedBytes > 0);

  assert.ok(r.corrupt.some((c) => c.rel.endsWith('broken.jpg') && c.reasons.some((x) => x.includes('EOI'))));
  assert.ok(r.corrupt.some((c) => c.rel.endsWith('fake.png')));
  assert.equal(r.summary.zeroByte, 1);

  assert.ok(r.byYear.some((y) => y.year === 2021));
  assert.ok(r.byYear.some((y) => y.year === 2019));

  const sameName = r.sameName.examples.find((g) => g.name === 'photo.jpg');
  assert.ok(sameName, 'aynı adlı photo.jpg grubu olmalı');
  assert.equal(sameName.count, 2);

  assert.ok(r.summary.skippedDirs >= 1, 'node_modules atlanmalı');
  assert.ok(!r.byExt.some((e) => e.ext === '.png' && e.count > 3));
});

test('inspect: dosya sınırı ve boş klasör', async (t) => {
  const root = mkTmp(t);
  for (let i = 0; i < 5; i++) write(root, `f${i}.txt`, Buffer.from(`veri ${i}`, 'utf8'));
  const r = await inspect(root, { maxFiles: 3 });
  assert.equal(r.summary.files, 3);
  assert.equal(r.summary.truncated, true);

  const empty = mkTmp(t);
  const r2 = await inspect(empty, {});
  assert.equal(r2.summary.files, 0);
  assert.deepEqual(r2.byExt, []);
});

test('symlink sayılır, hedefi taranmaz', async (t) => {
  const root = mkTmp(t);
  write(root, 'alt/x.txt', Buffer.from('x', 'utf8'));
  try {
    fs.symlinkSync(path.join(root, 'alt'), path.join(root, 'baglanti'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlink oluşturma izni yok');
    return;
  }
  const r = await inspect(root, {});
  assert.equal(r.summary.files, 1, 'bağlantı hedefi ikinci kez sayılmamalı');
  assert.equal(r.summary.symlinks, 1);
});

test('CLI: JSON çıktısı ve çıkış kodları', (t) => {
  const root = buildFixture(t);
  const ok = spawnSync(process.execPath, [CLI, root, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const r = JSON.parse(ok.stdout);
  assert.equal(r.tool, 'arsivci');
  assert.equal(r.summary.files, 11);
  assert.equal(r.duplicates.groups, 2);

  const noArg = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(noArg.status, 1);

  const missing = spawnSync(process.execPath, [CLI, path.join(root, 'yok')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);

  const ver = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), VERSION);
});
