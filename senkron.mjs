#!/usr/bin/env node
// senkron — workspace araçlarını Qoder skill kopyalarıyla eşitler ve sürüklenmeyi yakalar.
// Kaynak: <root>/<araç>.mjs ve <root>/skills-src/<skill>/SKILL.md

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';

const MAP = {
  'arsiv-denetci': ['arsivci.mjs', 'arsiv-rapor.mjs', 'karsilastir.mjs'],
  'yedekci': ['yedekci.mjs'],
  'aidoctor': ['aidoctor.mjs'],
  'promptscope': ['promptscope.mjs'],
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function existsFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function defaultSkillsDir() {
  return path.join(os.homedir(), '.qoder', 'skills');
}

function checkSync(root, skillsDir, map = MAP) {
  const skills = [];
  let drift = 0;
  for (const [skill, scripts] of Object.entries(map)) {
    const srcSkill = path.join(root, 'skills-src', skill, 'SKILL.md');
    const dstSkill = path.join(skillsDir, skill, 'SKILL.md');
    const items = [];

    const add = (kind, name, src, dst) => {
      if (!existsFile(src)) {
        items.push({ kind, name, status: 'kaynak-yok', src, dst });
        drift++;
        return;
      }
      if (!existsFile(dst)) {
        items.push({ kind, name, status: 'eksik', src, dst });
        drift++;
        return;
      }
      const status = sha256(src) === sha256(dst) ? 'ok' : 'farkli';
      if (status !== 'ok') drift++;
      items.push({ kind, name, status, src, dst });
    };

    add('skill', 'SKILL.md', srcSkill, dstSkill);
    for (const s of scripts) {
      add('script', s, path.join(root, s), path.join(skillsDir, skill, 'scripts', s));
    }

    const dstScriptsDir = path.join(skillsDir, skill, 'scripts');
    if (fs.existsSync(dstScriptsDir)) {
      for (const f of fs.readdirSync(dstScriptsDir)) {
        if (!scripts.includes(f)) {
          items.push({ kind: 'script', name: f, status: 'fazla', src: null, dst: path.join(dstScriptsDir, f) });
          drift++;
        }
      }
    }

    skills.push({ name: skill, dir: path.join(skillsDir, skill), items });
  }
  return { ok: drift === 0, drift, skills };
}

function copyAtomic(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
  fs.renameSync(tmp, dst);
}

function installSync(root, skillsDir, opts = {}) {
  const map = opts.map || MAP;
  const force = !!opts.force;
  const result = { copied: 0, blocked: 0, unchanged: 0, extras: 0, skills: [] };

  for (const [skill, scripts] of Object.entries(map)) {
    const items = [];
    const srcSkill = path.join(root, 'skills-src', skill, 'SKILL.md');
    const dstSkill = path.join(skillsDir, skill, 'SKILL.md');

    const handle = (kind, name, src, dst) => {
      if (!existsFile(src)) {
        items.push({ kind, name, action: 'kaynak-yok' });
        result.blocked++;
        return;
      }
      if (!existsFile(dst)) {
        copyAtomic(src, dst);
        items.push({ kind, name, action: 'kopyalandi' });
        result.copied++;
        return;
      }
      if (sha256(src) === sha256(dst)) {
        items.push({ kind, name, action: 'ayni' });
        result.unchanged++;
        return;
      }
      if (!force) {
        items.push({ kind, name, action: 'farkli-bloklandi' });
        result.blocked++;
        return;
      }
      copyAtomic(src, dst);
      items.push({ kind, name, action: 'guncellendi' });
      result.copied++;
    };

    handle('skill', 'SKILL.md', srcSkill, dstSkill);
    for (const s of scripts) {
      handle('script', s, path.join(root, s), path.join(skillsDir, skill, 'scripts', s));
    }

    const dstScriptsDir = path.join(skillsDir, skill, 'scripts');
    if (fs.existsSync(dstScriptsDir)) {
      for (const f of fs.readdirSync(dstScriptsDir)) {
        if (!scripts.includes(f)) { result.extras++; items.push({ kind: 'script', name: f, action: 'fazla' }); }
      }
    }
    result.skills.push({ name: skill, items });
  }

  result.ok = result.blocked === 0;
  return result;
}

function parseArgs(argv) {
  const opts = {
    action: 'check', force: false, json: false, noColor: false,
    root: process.cwd(), skills: defaultSkillsDir(), help: false, version: false, error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-color') { opts.noColor = true; continue; }
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--check') { opts.action = 'check'; continue; }
    if (a === '--install' || a === '--repair') { opts.action = 'install'; continue; }
    if (a === '--root') { opts.root = path.resolve(argv[++i] || ''); continue; }
    if (a === '--skills') { opts.skills = path.resolve(argv[++i] || ''); continue; }
    opts.error = `Bilinmeyen argüman: ${a}`;
    return opts;
  }
  return opts;
}

function printCheck(r, useColor) {
  const paint = (code, s) => (useColor ? `${code}${s}\u001b[0m` : s);
  console.log('');
  console.log(paint('\u001b[1m', 'Senkron — skill bütünlüğü'));
  for (const s of r.skills) {
    const bad = s.items.filter((i) => i.status !== 'ok');
    console.log(`  ${bad.length === 0 ? paint('\u001b[32m', 'OK  ') : paint('\u001b[31m', 'FARK')} ${s.name}  ${s.items.length} dosya${bad.length ? `, ${bad.length} sorun` : ''}`);
    for (const i of bad) console.log(`    - ${i.name}: ${i.status}`);
  }
  console.log('');
  console.log(r.ok ? paint('\u001b[32m', 'Sonuç: TEMİZ') : paint('\u001b[31m', `Sonuç: ${r.drift} fark — onarmak için --install`));
  console.log('');
}

function printInstall(r, useColor) {
  const paint = (code, s) => (useColor ? `${code}${s}\u001b[0m` : s);
  console.log('');
  console.log(paint('\u001b[1m', 'Senkron — kurulum'));
  for (const s of r.skills) {
    const changed = s.items.filter((i) => i.action !== 'ayni');
    if (changed.length === 0) continue;
    console.log(`  ${s.name}`);
    for (const i of changed) console.log(`    - ${i.name}: ${i.action}`);
  }
  console.log('');
  console.log(`Kopyalanan: ${r.copied}, değişmeyen: ${r.unchanged}, bloklanan: ${r.blocked}, fazla: ${r.extras}`);
  console.log(r.ok ? paint('\u001b[32m', 'Sonuç: TAMAM') : paint('\u001b[33m', 'Sonuç: bazı dosyalar farklı; --force ile güncelleyin'));
  console.log('');
}

function printHelp() {
  console.log(`senkron v${VERSION} — workspace ↔ skill kopyası eşitleme

Kullanım:
  node senkron.mjs [--check | --install] [--force] [--json] [--no-color]
                   [--root <workspace>] [--skills <skill-kökü>]

  --check     Farkları raporlar (varsayılan). Fark varsa çıkış 2.
  --install   Eksik dosyaları kurar; farklı dosyayı --force olmadan ezmez.
  --force     Farklı dosyaların üzerine yazar (skill kopyası yeniden üretilebilir).
  --json      Makine okunur çıktı.

Kaynak: <root>/skills-src/<skill>/SKILL.md ve <root>/<araç>.mjs
Hedef : ~/.qoder/skills/<skill>/{SKILL.md,scripts/}`);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (!fs.existsSync(opts.root)) { console.error(`Workspace yok: ${opts.root}`); process.exitCode = 1; return; }

  const useColor = !opts.noColor && !process.env.NO_COLOR && process.stdout.isTTY;
  if (opts.action === 'check') {
    const r = checkSync(opts.root, opts.skills);
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else printCheck(r, useColor);
    process.exitCode = r.ok ? 0 : 2;
    return;
  }

  const r = installSync(opts.root, opts.skills, { force: opts.force });
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else printInstall(r, useColor);
  process.exitCode = r.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { checkSync, installSync, parseArgs, sha256, MAP, VERSION };
