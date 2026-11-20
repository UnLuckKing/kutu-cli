import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkSync, installSync, VERSION } from './senkron.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'senkron.mjs');

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'senkron-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture(t) {
  const root = mkTmp(t);
  const skills = mkTmp(t);
  write(path.join(root, 'skills-src', 'test-skill', 'SKILL.md'), '# test\n');
  write(path.join(root, 'a.mjs'), 'export const x = 1;\n');
  const map = { 'test-skill': ['a.mjs'] };
  return { root, skills, map };
}

test('check: eksik dosyaları fark olarak görür', (t) => {
  const { root, skills, map } = fixture(t);
  const r = checkSync(root, skills, map);
  assert.equal(r.ok, false);
  assert.equal(r.drift, 2);
  const statuses = r.skills[0].items.map((i) => i.status);
  assert.deepEqual(statuses.sort(), ['eksik', 'eksik']);
});

test('install: eksikleri kurar, check temizlenir', (t) => {
  const { root, skills, map } = fixture(t);
  const ins = installSync(root, skills, { map });
  assert.equal(ins.ok, true);
  assert.equal(ins.copied, 2);
  assert.ok(fs.existsSync(path.join(skills, 'test-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skills, 'test-skill', 'scripts', 'a.mjs')));

  const chk = checkSync(root, skills, map);
  assert.equal(chk.ok, true);
  assert.equal(chk.drift, 0);
});

test('farklı dosya: force olmadan bloklanır, force ile güncellenir', (t) => {
  const { root, skills, map } = fixture(t);
  installSync(root, skills, { map });
  const dst = path.join(skills, 'test-skill', 'scripts', 'a.mjs');
  fs.writeFileSync(dst, 'bozuldu');

  const chk = checkSync(root, skills, map);
  assert.equal(chk.ok, false);
  assert.ok(chk.skills[0].items.some((i) => i.status === 'farkli'));

  const blocked = installSync(root, skills, { map });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, 1);
  assert.equal(fs.readFileSync(dst, 'utf8'), 'bozuldu');

  const forced = installSync(root, skills, { map, force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.copied, 1);
  assert.equal(fs.readFileSync(dst, 'utf8'), 'export const x = 1;\n');
});

test('fazla dosya drift sayılır', (t) => {
  const { root, skills, map } = fixture(t);
  installSync(root, skills, { map });
  fs.writeFileSync(path.join(skills, 'test-skill', 'scripts', 'fazla.mjs'), 'x');
  const chk = checkSync(root, skills, map);
  assert.equal(chk.ok, false);
  assert.ok(chk.skills[0].items.some((i) => i.status === 'fazla'));
});

test('CLI: fark 2, onarım sonrası 0, sürüm 0', (t) => {
  const { root, skills } = fixture(t);
  // CLI sabit MAP kullanır; gerçek workspace'i geçici skill köküne kurar.
  const realRoot = path.dirname(fileURLToPath(import.meta.url));
  const drift = spawnSync(process.execPath, [CLI, '--check', '--root', realRoot, '--skills', skills, '--json'], { encoding: 'utf8' });
  assert.equal(drift.status, 2, drift.stderr);
  assert.equal(JSON.parse(drift.stdout).ok, false);

  const ins = spawnSync(process.execPath, [CLI, '--install', '--root', realRoot, '--skills', skills, '--json'], { encoding: 'utf8' });
  assert.equal(ins.status, 0, ins.stderr);
  const clean = spawnSync(process.execPath, [CLI, '--check', '--root', realRoot, '--skills', skills, '--json'], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).ok, true);
  assert.equal(root.length > 0, true);

  const ver = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), VERSION);
});
