import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshot, verifySnapshot, listSnapshots, withRetry, isLongPath, VERSION } from './yedekci.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'yedekci.mjs');

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yedekci-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function write(root, rel, data) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

function buildSource(t) {
  const src = mkTmp(t);
  write(src, 'a.txt', 'birinci dosya');
  write(src, 'sub/b.txt', 'ikinci dosya, biraz daha uzun');
  write(src, 'node_modules/skip.txt', 'atlanmalı');
  return src;
}

test('snapshot: kopyalar, manifest yazar, doğrulama temiz', async (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);
  const r = await snapshot(src, dest, {});
  assert.equal(r.ok, true);
  assert.equal(r.files, 2);
  assert.equal(r.copied, 2);
  assert.equal(r.linked, 0);
  assert.ok(fs.existsSync(r.manifest));
  assert.ok(fs.existsSync(path.join(r.snapshotDir, 'sub', 'b.txt')));
  assert.ok(!fs.existsSync(path.join(r.snapshotDir, 'node_modules')));

  const v = await verifySnapshot(r.snapshotDir);
  assert.equal(v.ok, true);
  assert.equal(v.checked, 2);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.changed, []);
  assert.deepEqual(v.extra, []);
});

test('dry-run: hedefe hiçbir şey yazılmaz', async (t) => {
  const src = buildSource(t);
  const dest = path.join(mkTmp(t), 'yok');
  const r = await snapshot(src, dest, { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.files, 2);
  assert.ok(!fs.existsSync(dest));
});

test('incremental: değişmeyen dosyalar hardlink ile bağlanır', async (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);
  const first = await snapshot(src, dest, {});
  assert.equal(first.ok, true);

  const second = await snapshot(src, dest, { incremental: true });
  assert.equal(second.ok, true);
  assert.equal(second.files, 2);
  assert.ok(second.linked >= 1, `en az bir dosya bağlanmalı, gelen: ${second.linked}`);
  assert.equal(second.linked + second.copied, 2);

  const v = await verifySnapshot(second.snapshotDir);
  assert.equal(v.ok, true);
});

test('symlink: bağlantıyı hedefiyle kaydeder ve doğrular', async (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);
  const linkPath = path.join(src, 'baglanti');
  try {
    fs.symlinkSync(path.join(src, 'sub'), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlink oluşturma izni yok');
    return;
  }
  const r = await snapshot(src, dest, {});
  assert.equal(r.ok, true);
  assert.equal(r.files, 2, 'bağlantı hedefi tarama sayılmamalı');
  assert.equal(r.symlinks, 1);
  assert.equal(r.linkRecreated, 1);
  assert.equal(r.linkCopied, 0);
  assert.equal(r.linkErrors, 0);
  assert.ok(fs.lstatSync(path.join(r.snapshotDir, 'baglanti')).isSymbolicLink());
  const snapped = fs.readlinkSync(path.join(r.snapshotDir, 'baglanti'));
  assert.equal(path.resolve(snapped), path.join(r.snapshotDir, 'sub'), 'iç hedef snapshot içine çevrilmeli');

  const v = await verifySnapshot(r.snapshotDir);
  assert.equal(v.ok, true);
  assert.equal(v.linksChecked, 1);

  const manifest = JSON.parse(fs.readFileSync(r.manifest, 'utf8'));
  assert.equal(manifest.links.length, 1);
  assert.equal(manifest.links[0].action, 'link');
  assert.equal(manifest.links[0].external, false);
  assert.equal(manifest.summary.linkRecreated, 1);
});

test('symlink: kaynak dışı hedef external işaretlenir', async (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);
  const outside = mkTmp(t);
  fs.mkdirSync(path.join(outside, 'veri'), { recursive: true });
  const linkPath = path.join(src, 'dis');
  try {
    fs.symlinkSync(path.join(outside, 'veri'), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlink oluşturma izni yok');
    return;
  }
  const r = await snapshot(src, dest, {});
  assert.equal(r.ok, true);
  assert.equal(r.linkRecreated, 1);
  const link = r.links.find((l) => l.rel === 'dis');
  assert.equal(link.external, true);
  const v = await verifySnapshot(r.snapshotDir);
  assert.equal(v.ok, true);
  assert.equal(v.linksChecked, 1);
});

test('verify: değişmiş, eksik ve fazla dosyayı yakalar', async (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);
  const r = await snapshot(src, dest, {});
  assert.equal(r.ok, true);

  fs.writeFileSync(path.join(r.snapshotDir, 'a.txt'), 'bozuldu');
  fs.rmSync(path.join(r.snapshotDir, 'sub', 'b.txt'));
  fs.writeFileSync(path.join(r.snapshotDir, 'fazla.txt'), 'x');

  const v = await verifySnapshot(r.snapshotDir);
  assert.equal(v.ok, false);
  assert.ok(v.changed.some((x) => x.rel.endsWith('a.txt')));
  assert.ok(v.missing.some((x) => x.rel.includes('b.txt')));
  assert.ok(v.extra.some((x) => x.rel === 'fazla.txt'));
});

test('hedef kaynağın içindeyse reddedilir', async (t) => {
  const src = buildSource(t);
  const dest = path.join(src, 'yedek');
  const r = await snapshot(src, dest, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /içinde/);
  assert.ok(!fs.existsSync(dest));
});

test('list: snapshot özetlerini döndürür', async (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);
  const r = await snapshot(src, dest, {});
  const l = await listSnapshots(dest);
  assert.equal(l.ok, true);
  assert.equal(l.snapshots.length, 1);
  assert.equal(l.snapshots[0].files, 2);
  assert.equal(l.snapshots[0].source, path.resolve(src));
  assert.equal(l.snapshots[0].snapshot, path.basename(r.snapshotDir));
});

test('withRetry: geçici hatada yeniden dener, kalıcıda hemen durur', async () => {
  let calls = 0;
  const val = await withRetry(async () => {
    calls++;
    if (calls < 3) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return 'ok';
  }, 3, [1, 1, 1]);
  assert.equal(val, 'ok');
  assert.equal(calls, 3);

  let hard = 0;
  await assert.rejects(async () => withRetry(async () => {
    hard++;
    const e = new Error('yok'); e.code = 'ENOENT'; throw e;
  }, 3, [1, 1, 1]), /yok/);
  assert.equal(hard, 1);
});

test('isLongPath yalnız Windows uzun yolunu işaretler', () => {
  const long = 'C:\\' + 'a'.repeat(260);
  assert.equal(isLongPath(long), process.platform === 'win32');
  assert.equal(isLongPath('C:\\kisa'), false);
});

test('CLI: snapshot 0, bozulmuş snapshot 2, kullanım 1', (t) => {
  const src = buildSource(t);
  const dest = mkTmp(t);

  const ok = spawnSync(process.execPath, [CLI, 'snapshot', src, dest, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const snap = JSON.parse(ok.stdout);
  assert.equal(snap.ok, true);

  const good = spawnSync(process.execPath, [CLI, 'verify', snap.snapshotDir, '--json'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);

  fs.writeFileSync(path.join(snap.snapshotDir, 'a.txt'), 'bozuk');
  const bad = spawnSync(process.execPath, [CLI, 'verify', snap.snapshotDir], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(bad.status, 2);

  const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(usage.status, 1);

  const ver = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), VERSION);
});
