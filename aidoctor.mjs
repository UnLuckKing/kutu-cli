#!/usr/bin/env node
// aidoctor — yerel AI kurulum denetleyicisi (Hermes + FreeAgent)
// Sıfır bağımlılık, çevrimdışı varsayılan, sır değerlerini asla yazdırmaz.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 3000;

const FREEAGENT_REQUIRED = [
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_BACKUP_API_KEY',
  'TOKENHARBOR_API_KEY',
  'TOKENHARBOR_BASE_URL',
  'TOKENHARBOR_MODEL',
];

const CHECK_IDS = [
  'hermes.path.missing', 'hermes.yaml.unparsed_line', 'hermes.yaml.duplicate_key',
  'hermes.env.missing', 'hermes.env.duplicate_name', 'hermes.env.unresolved_ref',
  'hermes.env.ref_process_only', 'hermes.provider.unknown', 'hermes.custom.unknown',
  'hermes.custom.case_drift', 'hermes.model.api_key_missing', 'hermes.env.orphan_provider_var',
  'hermes.secret.inline_literal', 'hermes.secret.duplicate_env', 'hermes.url.userinfo',
  'hermes.catalog.drift', 'hermes.catalog.invalid', 'hermes.context_cache.invalid',
  'hermes.local.unreachable',
  'freeagent.path.missing', 'freeagent.env.missing', 'freeagent.env.missing_key',
  'freeagent.env.placeholder', 'freeagent.env.duplicate_name', 'freeagent.server.gemini_unwired',
  'freeagent.server.baseurl_userinfo', 'freeagent.server.baseurl_http', 'freeagent.data.invalid',
  'freeagent.data.not_array', 'freeagent.data.truncated', 'freeagent.health.unreachable', 'freeagent.health.models_empty',
  'cross.env.shared_name', 'cross.env.divergent_value',
];

const SEV_ORDER = { HATA: 0, UYARI: 1, BİLGİ: 2 };

const C = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  red: '\u001b[31m', yellow: '\u001b[33m', cyan: '\u001b[36m', green: '\u001b[32m',
};

function parseArgs(argv) {
  const opts = {
    hermes: null, freeagent: null, network: false, json: false,
    noColor: false, help: false, version: false, error: null,
  };
  const takesValue = new Set(['--hermes', '--freeagent']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--version' || a === '-v') { opts.version = true; continue; }
    if (a === '--network') { opts.network = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-color') { opts.noColor = true; continue; }
    if (takesValue.has(a)) {
      const v = inline !== null ? inline : argv[++i];
      if (!v || v.startsWith('-')) { opts.error = `${a} için bir yol gerekli.`; return opts; }
      if (a === '--hermes') opts.hermes = v;
      else opts.freeagent = v;
      continue;
    }
    opts.error = `Bilinmeyen argüman: ${argv[i]}`;
    return opts;
  }
  return opts;
}

function defaultPaths(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const home = env.USERPROFILE || os.homedir();
  return {
    hermes: path.join(local, 'hermes'),
    freeagent: path.join(home, 'Documents', 'FreeAgent'),
  };
}

function resolveTargets(opts, env = process.env) {
  const d = defaultPaths(env);
  let hermes = path.resolve(opts.hermes || d.hermes);
  let freeagent = path.resolve(opts.freeagent || d.freeagent);
  if (fs.existsSync(hermes) && fs.statSync(hermes).isFile()) hermes = path.dirname(hermes);
  if (fs.existsSync(freeagent) && fs.statSync(freeagent).isFile()) freeagent = path.dirname(freeagent);
  return { hermes, freeagent };
}

function readTextFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, code: 'NOT_FILE' };
    const len = Math.min(st.size, MAX_CONFIG_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    return { ok: true, text: buf.toString('utf8').replace(/^\uFEFF/, ''), truncated: st.size > MAX_CONFIG_BYTES };
  } catch (e) {
    return { ok: false, code: e.code || 'ERR' };
  }
}

// ---------- .env ----------

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseEnv(text) {
  const vars = new Map();
  const duplicates = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    let value = m[2].trim();
    if (value.startsWith('#')) value = '';
    value = unquote(value);
    const prev = vars.get(name);
    if (prev) {
      prev.count++;
      prev.lines.push(i + 1);
      prev.value = value;
    } else {
      vars.set(name, { name, value, count: 1, lines: [i + 1] });
    }
  }
  for (const v of vars.values()) if (v.count > 1) duplicates.push({ name: v.name, count: v.count, lines: v.lines });
  return { vars, duplicates, lineCount: lines.length };
}

// ---------- YAML alt küme tarayıcı ----------

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function splitKeyValue(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ')) {
      let key = s.slice(0, i).trim();
      if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
        key = key.slice(1, -1);
      }
      if (!key) return null;
      return { key, value: s.slice(i + 1).trim() };
    }
  }
  return null;
}

function tokenizeYaml(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const tokens = [];
  const issues = [];
  const skipStack = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const ws = raw.match(/^[ \t]*/)[0];
    if (ws.includes('\t')) { issues.push({ line: i + 1, kind: 'tab_indent' }); continue; }
    const indent = ws.length;
    let content = stripComment(raw.slice(indent)).trimEnd();
    if (!content.trim()) continue;
    if (skipStack.length && indent > skipStack[skipStack.length - 1]) continue;
    while (skipStack.length && indent <= skipStack[skipStack.length - 1]) skipStack.pop();
    const t = content.trim();
    if (indent === 0 && (t === '---' || t === '...')) continue;
    tokens.push({ indent, content: t, line: i + 1 });
    const kv = splitKeyValue(t);
    if (kv && /^[|>][0-9+-]*$/.test(kv.value)) skipStack.push(indent);
    if (!kv && t.startsWith('- ') && /^[|>][0-9+-]*$/.test(t.slice(2).trim())) skipStack.push(indent);
  }
  return { tokens, issues, lineCount: lines.length };
}

function parseMap(tokens, start, indent, basePath, dup, issues, virtualFirst) {
  const node = { type: 'map', map: new Map(), path: basePath, indent, line: virtualFirst ? virtualFirst.line : (tokens[start] ? tokens[start].line : 0) };
  let i = start;
  let pending = virtualFirst;
  for (;;) {
    let t;
    if (pending) { t = pending; pending = null; } else {
      if (i >= tokens.length) break;
      const tk = tokens[i];
      if (tk.indent !== indent || tk.content.startsWith('- ')) break;
      t = tk;
      i++;
    }
    const kv = splitKeyValue(t.content);
    if (!kv) { issues.push({ line: t.line, kind: 'unparsed_line' }); continue; }
    const key = kv.key;
    const keyPath = basePath ? `${basePath}.${key}` : key;
    const scalar = { type: 'scalar', value: unquote(kv.value), path: keyPath, line: t.line };
    if (node.map.has(key)) {
      dup.push({ path: basePath || '(kök)', key, line: t.line, firstLine: node.map.get(key).line });
    }
    if (kv.value === '') {
      const nxt = i < tokens.length ? tokens[i] : null;
      // Düz skalerin alt satıra sarılması: "anahtar:\n    deger"
      if (nxt && nxt.indent > indent && !nxt.content.startsWith('- ') && !splitKeyValue(nxt.content)) {
        scalar.value = unquote(nxt.content);
        node.map.set(key, scalar);
        i++;
        continue;
      }
      let child = null;
      if (nxt && nxt.indent > indent) {
        child = parseBlock(tokens, i, nxt.indent, keyPath, dup, issues);
      } else if (nxt && nxt.indent === indent && nxt.content.startsWith('- ')) {
        child = parseList(tokens, i, indent, keyPath, dup, issues);
      }
      if (child) { node.map.set(key, child.node); i = child.next; } else node.map.set(key, scalar);
    } else {
      node.map.set(key, scalar);
    }
  }
  return { node, next: i };
}

function parseList(tokens, start, indent, basePath, dup, issues) {
  const node = { type: 'list', items: [], path: basePath, indent, line: tokens[start].line };
  let i = start;
  let idx = 0;
  while (i < tokens.length && tokens[i].indent === indent && tokens[i].content.startsWith('- ')) {
    const t = tokens[i];
    const rest = t.content.slice(2).trim();
    const itemPath = `${basePath}[${idx}]`;
    if (rest === '') {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const child = parseBlock(tokens, i + 1, tokens[i + 1].indent, itemPath, dup, issues);
        node.items.push(child.node);
        i = child.next;
      } else {
        node.items.push({ type: 'scalar', value: '', path: itemPath, line: t.line });
        i++;
      }
    } else if (splitKeyValue(rest)) {
      const virtual = { indent: indent + 2, content: rest, line: t.line };
      const child = parseMap(tokens, i + 1, indent + 2, itemPath, dup, issues, virtual);
      node.items.push(child.node);
      i = child.next;
    } else {
      node.items.push({ type: 'scalar', value: unquote(rest), path: itemPath, line: t.line });
      i++;
    }
    idx++;
  }
  return { node, next: i };
}

function parseBlock(tokens, start, indent, basePath, dup, issues) {
  if (tokens[start] && tokens[start].content.startsWith('- ')) {
    return parseList(tokens, start, indent, basePath, dup, issues);
  }
  return parseMap(tokens, start, indent, basePath, dup, issues, null);
}

function parseYamlSubset(text) {
  const { tokens, issues, lineCount } = tokenizeYaml(text);
  const dup = [];
  let root = { type: 'map', map: new Map(), path: '', indent: -1, line: 0 };
  if (tokens.length > 0) {
    const res = parseBlock(tokens, 0, tokens[0].indent, '', dup, issues);
    root = res.node;
    for (let k = res.next; k < tokens.length; k++) issues.push({ line: tokens[k].line, kind: 'unparsed_line' });
  }
  return { root, dupKeys: dup, issues, lineCount };
}

// ---------- ağaç yardımcıları ----------

function mapGet(node, key) {
  return node && node.type === 'map' ? node.map.get(key) : undefined;
}
function scalarValue(node) {
  return node && node.type === 'scalar' ? node.value : undefined;
}
function mapEntries(node) {
  return node && node.type === 'map' ? [...node.map.entries()] : [];
}
function listItems(node) {
  return node && node.type === 'list' ? node.items : [];
}
function walkNodes(node, fn, p = '') {
  if (!node) return;
  fn(node, p);
  if (node.type === 'map') for (const [k, v] of node.map) walkNodes(v, fn, p ? `${p}.${k}` : k);
  else if (node.type === 'list') node.items.forEach((v, i) => walkNodes(v, fn, `${p}[${i}]`));
}

// ---------- URL ----------

function maskUrl(value) {
  let s = String(value);
  s = s.replace(/\/\/[^/@\s]+@/, '//***@');
  s = s.replace(/([?&][^=&#\s]+=)[^&#\s]*/g, '$1***');
  return s;
}

function hasUserinfo(url) {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url);
}

function isLocalUrl(url) {
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return '(geçersiz URL)'; }
}

// ---------- sır toplama / maskeleme ----------

function looksSecret(value) {
  const v = String(value || '');
  if (v.length < 12) return false;
  if (/^https?:\/\//i.test(v)) return false;
  if (/^(true|false|null|auto|none)$/i.test(v)) return false;
  if (/^[\d.\-]+$/.test(v)) return false;
  return true;
}

function collectSecrets(ctx) {
  const set = new Set();
  for (const env of [ctx.hermesEnv, ctx.freeagentEnv]) {
    if (!env) continue;
    for (const v of env.vars.values()) if (looksSecret(v.value)) set.add(v.value);
  }
  for (const lit of ctx.inlineLiterals || []) if (looksSecret(lit.value)) set.add(lit.value);
  for (const url of ctx.urls || []) {
    const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i);
    if (m) {
      for (const part of m[1].split(':')) if (part.length >= 4) set.add(part);
    }
  }
  return set;
}

function findLeak(report, secrets) {
  const s = JSON.stringify(report);
  for (const v of secrets) {
    if (v && s.includes(v)) return true;
  }
  return false;
}

// ---------- kontroller ----------

function checkHermes(ctx) {
  const out = [];
  const add = (severity, id, title, detail, evidence = {}, hint = '') =>
    out.push({ id, severity, title, detail, evidence, hint });

  if (!ctx.hermesExists) {
    add('HATA', 'hermes.path.missing', 'Hermes kurulumu bulunamadı',
      `Dizin yok: ${ctx.hermesDir}`, { file: ctx.hermesDir });
    return { findings: out, meta: { path: ctx.hermesDir, exists: false } };
  }

  const configPath = path.join(ctx.hermesDir, 'config.yaml');
  const cfgRead = readTextFile(configPath);
  if (!cfgRead.ok) {
    add('HATA', 'hermes.path.missing', 'config.yaml okunamadı',
      `Dosya yok veya okunamıyor: ${configPath}`, { file: configPath });
    return { findings: out, meta: { path: ctx.hermesDir, exists: false } };
  }

  const parsed = parseYamlSubset(cfgRead.text);
  const root = parsed.root;

  if (parsed.issues.length > 0) {
    add('UYARI', 'hermes.yaml.unparsed_line', 'Ayrıştırılamayan YAML satırları',
      `${parsed.issues.length} satır yapı taramasında anlaşılamadı.`,
      { file: configPath, count: parsed.issues.length },
      'İlk satırlar: ' + parsed.issues.slice(0, 3).map((x) => x.line).join(', '));
  }
  for (const d of parsed.dupKeys.slice(0, 10)) {
    add('HATA', 'hermes.yaml.duplicate_key', 'Yinelenen YAML anahtarı',
      `${d.path} altında "${d.key}" iki kez tanımlı.`, { file: configPath, line: d.line, path: d.path, name: d.key },
      `İlk tanım satır ${d.firstLine}; YAML'de son değer geçersiz kılar.`);
  }

  const envPath = path.join(ctx.hermesDir, '.env');
  if (!ctx.hermesEnv) {
    add('UYARI', 'hermes.env.missing', '.env bulunamadı',
      '${VAR} referansları yalnızca süreç ortamından çözülebilir.', { file: envPath });
  } else {
    for (const d of ctx.hermesEnv.duplicates) {
      add('UYARI', 'hermes.env.duplicate_name', 'Yinelenen .env değişkeni',
        `${d.name} ${d.count} kez tanımlı; son değer geçerli.`, { file: envPath, name: d.name, count: d.count, line: d.lines[d.lines.length - 1] });
    }
  }

  // ${VAR} çözümü — yalnız ayrıştırılmış skaler değerlerden (yorum/blok skaler hariç)
  const varRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const refsFound = [];
  walkNodes(root, (node) => {
    if (node.type !== 'scalar' || typeof node.value !== 'string') return;
    varRe.lastIndex = 0;
    let mm;
    while ((mm = varRe.exec(node.value)) !== null) {
      refsFound.push({ name: mm[1], line: node.line, path: node.path });
    }
  });
  const refNames = new Set(refsFound.map((r) => r.name));
  const reportedRefs = new Set();
  for (const ref of refsFound) {
    const name = ref.name;
    if (reportedRefs.has(name)) continue;
    const inEnv = ctx.hermesEnv && ctx.hermesEnv.vars.has(name);
    const inProc = Object.prototype.hasOwnProperty.call(process.env, name);
    if (!inEnv && !inProc) {
      reportedRefs.add(name);
      add('HATA', 'hermes.env.unresolved_ref', 'Çözülemeyen ortam değişkeni',
        `${'${' + name + '}'} ne .env ne süreç ortamında var.`, { file: configPath, line: ref.line, name });
    } else if (!inEnv && inProc) {
      reportedRefs.add(name);
      add('BİLGİ', 'hermes.env.ref_process_only', 'Değişken yalnız süreç ortamında',
        `${name} .env içinde yok, süreçten geliyor.`, { file: configPath, line: ref.line, name });
    }
  }

  // sağlayıcı çözümlemesi
  const providersNode = mapGet(root, 'providers');
  const providerNames = mapEntries(providersNode).map(([k]) => k);
  const customNode = mapGet(root, 'custom_providers');
  const customNames = listItems(customNode).map((it) => scalarValue(mapGet(it, 'name'))).filter(Boolean);
  const customLower = new Map(customNames.map((n) => [n.toLowerCase(), n]));

  const refs = collectRefs(root);
  for (const ref of refs) {
    const p = ref.provider;
    if (!p || p === 'auto') continue;
    if (p.startsWith('custom:')) {
      const name = p.slice(7);
      if (customNames.includes(name) || providerNames.includes(name)) continue;
      const ci = customLower.get(name.toLowerCase());
      if (ci) {
        add('BİLGİ', 'hermes.custom.case_drift', 'Sağlayıcı adında büyük/küçük harf farkı',
          `${ref.path}: "${p}" ↔ "${ci}"`, { file: configPath, line: ref.line, path: ref.path },
          'Hermes büyük/küçük harfe duyarlı olabilir; aynı yazımı kullanın.');
      } else {
        add('HATA', 'hermes.custom.unknown', 'Bilinmeyen custom sağlayıcı',
          `${ref.path}: "${p}" ne custom_providers ne providers içinde tanımlı.`, { file: configPath, line: ref.line, path: ref.path });
      }
      continue;
    }
    if (providerNames.includes(p) || customNames.includes(p)) continue;
    const ci = customLower.get(p.toLowerCase());
    if (ci) {
      add('BİLGİ', 'hermes.custom.case_drift', 'Sağlayıcı adında büyük/küçük harf farkı',
        `${ref.path}: "${p}" ↔ "${ci}"`, { file: configPath, line: ref.line, path: ref.path });
      continue;
    }
    add('HATA', 'hermes.provider.unknown', 'Bilinmeyen sağlayıcı referansı',
      `${ref.path}: "${p}" providers içinde yok.`, { file: configPath, line: ref.line, path: ref.path });
  }

  const modelNode = mapGet(root, 'model');
  const modelKey = mapGet(modelNode, 'api_key');
  if (!modelKey || !scalarValue(modelKey)) {
    add('HATA', 'hermes.model.api_key_missing', 'model.api_key eksik',
      'Varsayılan model için API anahtarı tanımlı değil.', { file: configPath, path: 'model.api_key' });
  }

  // orphan env adları
  const modelProviderVar = /^(NVIDIA|GEMINI|GOOGLE|TOKENHARBOR|OPENROUTER|ANTHROPIC|OPENAI|XAI|DEEPSEEK|MISTRAL|GROQ)_[A-Z0-9_]*API_KEY$/;
  if (ctx.hermesEnv) {
    for (const v of ctx.hermesEnv.vars.values()) {
      if (!modelProviderVar.test(v.name)) continue;
      if (refNames.has(v.name)) continue;
      if (ctx.freeagentEnv && ctx.freeagentEnv.vars.has(v.name)) continue;
      add('UYARI', 'hermes.env.orphan_provider_var', 'config.yaml içinde referans yok',
        `${v.name} .env içinde tanımlı ama config.yaml hiç ${'${'}...${'}'} referansı taşımıyor.`,
        { file: envPath, name: v.name, line: v.lines[0] },
        'Başka bir bileşen okuyor olabilir; silmeden önce doğrulayın.');
    }
  }

  // satır içi anahtarlar
  const literals = [];
  walkNodes(root, (node) => {
    if (node.type !== 'map') return;
    for (const [k, v] of node.map) {
      if (!/^(api_key|apikey|token|secret|password|auth)$/i.test(k)) continue;
      if (v.type !== 'scalar') continue;
      const val = v.value;
      if (!val || /^\$\{.*\}$/.test(val) || val === 'auto') continue;
      literals.push({ path: v.path, value: val, line: v.line });
    }
  });
  if (literals.length > 0) {
    add('BİLGİ', 'hermes.secret.inline_literal', 'Satır içi API anahtarı',
      `${literals.length} alan config.yaml içinde düz metin anahtar taşıyor (değerler gösterilmez).`,
      { file: configPath, count: literals.length },
      'Anahtarları tek kaynağa taşıyın (.env + ${VAR}).');
  }
  if (ctx.hermesEnv) {
    const reported = new Set();
    for (const lit of literals) {
      for (const v of ctx.hermesEnv.vars.values()) {
        if (reported.has(v.name)) continue;
        if (v.value && v.value === lit.value) {
          reported.add(v.name);
          add('UYARI', 'hermes.secret.duplicate_env', 'Anahtar iki yerde tanımlı',
            `${v.name} ile config.yaml içindeki ${lit.path} aynı değeri taşıyor.`,
            { file: configPath, name: v.name, path: lit.path, line: lit.line },
            'Tek kaynak bırakın; sızıntı yüzeyini azaltır.');
        }
      }
    }
  }

  // URL'ler
  const urls = [];
  walkNodes(root, (node) => {
    if (node.type === 'scalar' && typeof node.value === 'string' && /^https?:\/\//i.test(node.value.trim())) {
      urls.push(node.value.trim());
      if (hasUserinfo(node.value.trim())) {
        add('HATA', 'hermes.url.userinfo', 'URL kimlik bilgisi içeriyor',
          `${node.path}: ${maskUrl(node.value.trim())}`, { file: configPath, line: node.line, path: node.path });
      }
    }
  });

  // katalog
  const catalogPath = path.join(ctx.hermesDir, 'cache', 'model_catalog.json');
  if (fs.existsSync(catalogPath)) {
    const catRead = readTextFile(catalogPath);
    let cat = null;
    if (catRead.ok) { try { cat = JSON.parse(catRead.text); } catch { cat = null; } }
    if (!cat || typeof cat !== 'object' || !cat.providers) {
      add('UYARI', 'hermes.catalog.invalid', 'Model kataloğu okunamadı',
        'cache/model_catalog.json geçerli JSON değil.', { file: catalogPath });
    } else {
      for (const p of providerNames) {
        const cp = cat.providers[p];
        if (!cp) continue;
        const catIds = new Set(
          Array.isArray(cp.models) ? cp.models.map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean) : []
        );
        const cfgModels = mapGet(mapGet(providersNode, p), 'models');
        const cfgIds = new Set(mapEntries(cfgModels).map(([k]) => k));
        let missing = 0;
        let extra = 0;
        for (const id of cfgIds) if (!catIds.has(id)) missing++;
        for (const id of catIds) if (!cfgIds.has(id)) extra++;
        if (missing || extra) {
          add('BİLGİ', 'hermes.catalog.drift', 'Katalog ile yapılandırma farkı',
            `${p}: ${missing} model katalogda yok, ${extra} model yapılandırmada yok.`,
            { file: catalogPath, name: p, count: missing + extra });
        }
      }
    }
  }

  // context_length_cache
  const ctxCachePath = path.join(ctx.hermesDir, 'context_length_cache.yaml');
  if (fs.existsSync(ctxCachePath)) {
    const ccRead = readTextFile(ctxCachePath);
    if (ccRead.ok) {
      const cc = parseYamlSubset(ccRead.text);
      if (cc.issues.length > 0) {
        add('BİLGİ', 'hermes.context_cache.invalid', 'Bağlam uzunluğu önbelleğinde bozuk satır',
          `${cc.issues.length} satır ayrıştırılamadı.`, { file: ctxCachePath, count: cc.issues.length });
      }
    }
  }

  return {
    findings: out,
    meta: { path: ctx.hermesDir, exists: true, lines: cfgRead.text.split(/\r?\n/).length, envVars: ctx.hermesEnv ? ctx.hermesEnv.vars.size : 0 },
    localUrls: [...new Set(urls.filter(isLocalUrl))],
  };
}

function collectRefs(root) {
  const refs = [];
  const push = (node, p) => {
    const v = scalarValue(node);
    if (v) refs.push({ provider: v, path: p, line: node.line });
  };
  const model = mapGet(root, 'model');
  push(mapGet(model, 'provider'), 'model.provider');
  push(mapGet(mapGet(root, 'fallback_model'), 'provider'), 'fallback_model.provider');
  listItems(mapGet(root, 'fallback_providers')).forEach((it, i) =>
    push(mapGet(it, 'provider'), `fallback_providers[${i}].provider`));
  for (const [task, node] of mapEntries(mapGet(root, 'auxiliary'))) push(mapGet(node, 'provider'), `auxiliary.${task}.provider`);
  const council = mapGet(root, 'council');
  listItems(mapGet(council, 'seats')).forEach((it, i) => push(mapGet(it, 'provider'), `council.seats[${i}].provider`));
  push(mapGet(mapGet(council, 'judge'), 'provider'), 'council.judge.provider');
  push(mapGet(mapGet(council, 'chairman'), 'provider'), 'council.chairman.provider');
  const cheap = mapGet(mapGet(root, 'smart_model_routing'), 'cheap_model');
  if (cheap) {
    const v = scalarValue(mapGet(cheap, 'provider'));
    if (v) refs.push({ provider: v, path: 'smart_model_routing.cheap_model.provider', line: mapGet(cheap, 'provider').line });
  }
  return refs;
}

function checkFreeAgent(ctx) {
  const out = [];
  const add = (severity, id, title, detail, evidence = {}, hint = '') =>
    out.push({ id, severity, title, detail, evidence, hint });

  if (!ctx.freeagentExists) {
    add('HATA', 'freeagent.path.missing', 'FreeAgent kurulumu bulunamadı',
      `Dizin yok: ${ctx.freeagentDir}`, { file: ctx.freeagentDir });
    return { findings: out, meta: { path: ctx.freeagentDir, exists: false } };
  }

  const envPath = path.join(ctx.freeagentDir, '.env');
  const env = ctx.freeagentEnv;
  if (!env) {
    add('HATA', 'freeagent.env.missing', '.env bulunamadı',
      'FreeAgent anahtarları .env üzerinden okuyor.', { file: envPath });
  } else {
    for (const name of FREEAGENT_REQUIRED) {
      const v = env.vars.get(name);
      if (!v || !v.value) {
        add('HATA', 'freeagent.env.missing_key', 'Zorunlu anahtar eksik',
          `${name} tanımlı değil veya boş.`, { file: envPath, name });
        continue;
      }
      if (/^(your|replace|changeme|xxx|sk-xxx|todo|<)/i.test(v.value)) {
        add('UYARI', 'freeagent.env.placeholder', 'Yer tutucu değer',
          `${name} gerçek anahtar gibi görünmüyor.`, { file: envPath, name, line: v.lines[0] });
      }
    }
    for (const d of env.duplicates) {
      add('UYARI', 'freeagent.env.duplicate_name', 'Yinelenen .env değişkeni',
        `${d.name} ${d.count} kez tanımlı.`, { file: envPath, name: d.name, count: d.count, line: d.lines[d.lines.length - 1] });
    }

    const bu = env.vars.get('TOKENHARBOR_BASE_URL');
    if (bu && bu.value) {
      if (hasUserinfo(bu.value)) {
        add('HATA', 'freeagent.server.baseurl_userinfo', 'Base URL kimlik bilgisi içeriyor',
          `TOKENHARBOR_BASE_URL: ${maskUrl(bu.value)}`, { file: envPath, name: 'TOKENHARBOR_BASE_URL', line: bu.lines[0] });
      } else if (/^http:\/\//i.test(bu.value) && !isLocalUrl(bu.value)) {
        add('UYARI', 'freeagent.server.baseurl_http', 'Base URL şifresiz HTTP',
          'TOKENHARBOR_BASE_URL https değil.', { file: envPath, name: 'TOKENHARBOR_BASE_URL', line: bu.lines[0] });
      }
    }

    const gem = env.vars.get('GEMINI_API_KEY');
    const serverPath = path.join(ctx.freeagentDir, 'server.js');
    const serverRead = readTextFile(serverPath);
    if (gem && gem.value && serverRead.ok) {
      const wired = /gemini|generativelanguage/i.test(serverRead.text);
      if (!wired) {
        add('UYARI', 'freeagent.server.gemini_unwired', 'Gemini anahtarı bağlı değil',
          'GEMINI_API_KEY tanımlı ama server.js içinde Gemini sağlayıcı kaydı yok.',
          { file: serverPath },
          'Anahtarı kullanmıyorsanız kaldırın; kullanacaksanız MODELS kaydına ekleyin.');
      }
    }
  }

  const convPath = path.join(ctx.freeagentDir, 'data', 'conversations.json');
  if (fs.existsSync(convPath)) {
    const convRead = readTextFile(convPath);
    if (convRead.ok && convRead.truncated) {
      add('BİLGİ', 'freeagent.data.truncated', 'Konuşma dosyası çok büyük',
        'Dosya 8 MB sınırını aştığı için ayrıştırılmadı.', { file: convPath });
    } else {
      let data = null;
      let parseOk = false;
      if (convRead.ok) { try { data = JSON.parse(convRead.text); parseOk = true; } catch { parseOk = false; } }
      if (!parseOk) {
        add('HATA', 'freeagent.data.invalid', 'Konuşma dosyası bozuk',
          'data/conversations.json geçerli JSON değil.', { file: convPath });
      } else if (!Array.isArray(data)) {
        add('HATA', 'freeagent.data.not_array', 'Konuşma dosyası dizi değil',
          'data/conversations.json bir JSON dizisi olmalı.', { file: convPath });
      }
    }
  }

  return {
    findings: out,
    meta: {
      path: ctx.freeagentDir, exists: true,
      envKeys: env ? env.vars.size : 0,
      serverLines: ctx.freeagentServer ? ctx.freeagentServer.split(/\r?\n/).length : 0,
    },
  };
}

function checkCross(ctx) {
  const out = [];
  const add = (severity, id, title, detail, evidence = {}, hint = '') =>
    out.push({ id, severity, title, detail, evidence, hint });
  if (!ctx.hermesEnv || !ctx.freeagentEnv) return { findings: out };
  for (const [name, hv] of ctx.hermesEnv.vars) {
    const fv = ctx.freeagentEnv.vars.get(name);
    if (!fv) continue;
    add('BİLGİ', 'cross.env.shared_name', 'Değişken iki uygulamada da tanımlı',
      `${name} hem Hermes hem FreeAgent .env dosyasında var.`,
      { name, file: 'hermes+freeagent .env' });
    if (hv.value && fv.value && hv.value !== fv.value) {
      add('UYARI', 'cross.env.divergent_value', 'Değişken değerleri farklı',
        `${name} iki dosyada farklı değer taşıyor (değer gösterilmez).`, { name },
        'Döndürme sırasında iki uygulamadan biri eski anahtarla kalabilir.');
    }
  }
  return { findings: out };
}

// ---------- ağ ----------

async function probe(url, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = null, readJson = false) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, status: 0, errorKind: 'no_fetch' };
  try {
    const t0 = Date.now();
    const res = await f(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const out = { ok: res.status < 500, status: res.status, ms: Date.now() - t0 };
    if (readJson && out.ok) {
      try { out.body = await res.json(); } catch { out.body = null; }
    }
    return out;
  } catch (e) {
    const kind = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network';
    return { ok: false, status: 0, errorKind: kind };
  }
}

async function networkChecks(ctx, hermesFindings, freeagentFindings, localUrls) {
  for (const url of localUrls) {
    const r = await probe(url, PROBE_TIMEOUT_MS, ctx.fetchImpl);
    if (!r.ok) {
      hermesFindings.push({
        id: 'hermes.local.unreachable', severity: 'UYARI', title: 'Yerel uç yanıt vermiyor',
        detail: `${hostOf(url)} yanıt vermedi (${r.errorKind || 'HTTP ' + r.status}).`,
        evidence: { file: 'config.yaml' }, hint: 'Yerel servis açık mı, port doğru mu?',
      });
    }
  }
  const healthUrl = 'http://127.0.0.1:4317/api/health';
  const r = await probe(healthUrl, PROBE_TIMEOUT_MS, ctx.fetchImpl, true);
  if (!r.ok) {
    freeagentFindings.push({
      id: 'freeagent.health.unreachable', severity: 'UYARI', title: 'FreeAgent sunucusu kapalı',
      detail: `127.0.0.1:4317 yanıt vermedi (${r.errorKind || 'HTTP ' + r.status}).`,
      evidence: { file: healthUrl }, hint: 'start.cmd ile başlatıp tekrar deneyin.',
    });
    return;
  }
  const models = r.body && typeof r.body === 'object' ? r.body.models : null;
  if (models && typeof models === 'object') {
    let total = 0;
    let configured = 0;
    for (const m of Object.values(models)) {
      for (const p of (m && Array.isArray(m.providers) ? m.providers : [])) {
        total++;
        if (p && p.configured) configured++;
      }
    }
    if (total > 0 && configured === 0) {
      freeagentFindings.push({
        id: 'freeagent.health.models_empty', severity: 'UYARI', title: 'Hiçbir sağlayıcı yapılandırılmamış',
        detail: 'Sunucu ayakta ama tüm sağlayıcılar anahtarsız görünüyor.',
        evidence: { file: healthUrl }, hint: '.env anahtarlarını ve sunucunun yeniden başlatılmasını kontrol edin.',
      });
    }
  }
}

// ---------- rapor ----------

async function runDoctor(opts, deps = {}) {
  const env = deps.env || process.env;
  const targets = resolveTargets(opts, env);
  const hermesExists = fs.existsSync(targets.hermes);
  const freeagentExists = fs.existsSync(targets.freeagent);
  if (!hermesExists && !freeagentExists) {
    const err = new Error('E_HEDEF_YOK');
    err.code = 'E_HEDEF_YOK';
    throw err;
  }

  const hermesCfgPath = path.join(targets.hermes, 'config.yaml');
  const hermesCfgText = hermesExists ? readTextFile(hermesCfgPath) : { ok: false };
  const hermesEnvPath = path.join(targets.hermes, '.env');
  const hermesEnvRead = hermesExists ? readTextFile(hermesEnvPath) : { ok: false };
  const hermesEnv = hermesEnvRead.ok ? parseEnv(hermesEnvRead.text) : null;

  const feEnvPath = path.join(targets.freeagent, '.env');
  const feEnvRead = freeagentExists ? readTextFile(feEnvPath) : { ok: false };
  const feEnv = feEnvRead.ok ? parseEnv(feEnvRead.text) : null;
  const feServerPath = path.join(targets.freeagent, 'server.js');
  const feServerRead = freeagentExists ? readTextFile(feServerPath) : { ok: false };

  const inlineLiterals = [];
  if (hermesCfgText.ok) {
    const parsed = parseYamlSubset(hermesCfgText.text);
    walkNodes(parsed.root, (node) => {
      if (node.type !== 'map') return;
      for (const [k, v] of node.map) {
        if (!/^(api_key|apikey|token|secret|password|auth)$/i.test(k)) continue;
        if (v.type !== 'scalar') continue;
        const val = v.value;
        if (!val || /^\$\{.*\}$/.test(val) || val === 'auto') continue;
        inlineLiterals.push({ path: v.path, value: val, line: v.line });
      }
    });
  }

  const hermesCtx = {
    hermesDir: targets.hermes,
    hermesExists,
    hermesEnv,
    freeagentEnv: feEnv,
    fetchImpl: deps.fetchImpl,
  };
  const h = checkHermes(hermesCtx);

  const feCtx = {
    freeagentDir: targets.freeagent,
    freeagentExists,
    freeagentEnv: feEnv,
    freeagentServer: feServerRead.ok ? feServerRead.text : null,
  };
  const f = checkFreeAgent(feCtx);

  const c = checkCross({ hermesEnv, freeagentEnv: feEnv });

  if (opts.network) {
    const urls = h.localUrls || [];
    await networkChecks({ fetchImpl: deps.fetchImpl }, h.findings, f.findings, urls);
  }

  const findings = [...h.findings, ...f.findings, ...c.findings];
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.id.localeCompare(b.id));
  const errors = findings.filter((x) => x.severity === 'HATA').length;
  const warnings = findings.filter((x) => x.severity === 'UYARI').length;
  const infos = findings.filter((x) => x.severity === 'BİLGİ').length;

  const report = {
    tool: 'aidoctor',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    mode: { network: !!opts.network },
    targets: {
      hermes: h.meta,
      freeagent: f.meta,
    },
    summary: { errors, warnings, infos, exitCode: errors > 0 ? 2 : 0 },
    findings,
    checksRun: CHECK_IDS,
  };

  const secrets = collectSecrets({
    hermesEnv,
    freeagentEnv: feEnv,
    inlineLiterals,
    urls: [],
  });
  if (findLeak(report, secrets)) {
    const err = new Error('E_SIZINTI');
    err.code = 'E_SIZINTI';
    throw err;
  }
  return report;
}

// ---------- yazdırma ----------

function colorize(severity, s, useColor) {
  if (!useColor) return s;
  if (severity === 'HATA') return `${C.red}${s}${C.reset}`;
  if (severity === 'UYARI') return `${C.yellow}${s}${C.reset}`;
  return `${C.cyan}${s}${C.reset}`;
}

function printReport(report, opts = {}) {
  const useColor = opts.color !== undefined ? opts.color : (process.stdout.isTTY && !process.env.NO_COLOR && !opts.noColor);
  const b = (s) => (useColor ? `${C.bold}${s}${C.reset}` : s);
  const d = (s) => (useColor ? `${C.dim}${s}${C.reset}` : s);
  const line = (s) => (useColor ? `${C.dim}${s}${C.reset}` : s);

  console.log('');
  console.log(b('AI Doctor — kurulum denetimi'));
  console.log(line('-'.repeat(60)));
  const t = report.targets;
  console.log(`Hermes    : ${t.hermes.path}  ${t.hermes.exists ? `(var, ${t.hermes.lines || 0} satır, ${t.hermes.envVars} env)` : '(yok)'}`);
  console.log(`FreeAgent : ${t.freeagent.path}  ${t.freeagent.exists ? `(var, ${t.freeagent.envKeys} anahtar)` : '(yok)'}`);
  console.log(`Ağ taraması: ${report.mode.network ? 'açık' : 'kapalı'}`);
  console.log('');

  if (report.findings.length === 0) {
    console.log(colorize('BİLGİ', 'Sorun bulunamadı.', useColor));
    console.log('');
    return;
  }

  for (const sev of ['HATA', 'UYARI', 'BİLGİ']) {
    const group = report.findings.filter((x) => x.severity === sev);
    if (group.length === 0) continue;
    console.log(b(colorize(sev, `${sev} (${group.length})`, useColor)));
    for (const x of group) {
      console.log(`[${x.id}] ${b(x.title)}`);
      console.log(`   ${x.detail}`);
      const ev = [];
      if (x.evidence && x.evidence.file) ev.push(x.evidence.file);
      if (x.evidence && x.evidence.line) ev.push(`satır ${x.evidence.line}`);
      if (ev.length) console.log(d(`   kanıt: ${ev.join(':')}`));
      if (x.hint) console.log(d(`   öneri: ${x.hint}`));
    }
    console.log('');
  }

  const s = report.summary;
  console.log(`${s.errors} hata, ${s.warnings} uyarı, ${s.infos} bilgi — çıkış ${s.exitCode}`);
  console.log(d('Not: değerler hiçbir zaman yazdırılmaz; yalnızca ad, satır ve sayı gösterilir.'));
  console.log('');
}

function printHelp() {
  console.log(`aidoctor v${VERSION} — yerel AI kurulum denetleyicisi

Kullanım:
  node aidoctor.mjs [seçenekler]

Seçenekler:
  --hermes <yol>      Hermes dizini veya config.yaml (varsayılan: %LOCALAPPDATA%\\hermes)
  --freeagent <yol>   FreeAgent dizini (varsayılan: %USERPROFILE%\\Documents\\FreeAgent)
  --network           Yalnız yerel uçları yokla (3 sn, anahtar göndermez)
  --json              Makine okunur çıktı
  --no-color          Renksiz çıktı
  --version           Sürüm
  --help              Bu yardım

Çıkış kodu: 0 = hata yok, 2 = en az bir HATA, 1 = kullanım/ölümcül hata.
Sırlar asla yazdırılmaz: yalnızca değişken adı, satır ve sayı.`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); process.exitCode = 1; return; }
  if (opts.help) { printHelp(); return; }
  if (opts.version) { console.log(VERSION); return; }
  try {
    const report = await runDoctor(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, { noColor: opts.noColor });
    process.exitCode = report.summary.exitCode;
  } catch (e) {
    if (e && e.code === 'E_SIZINTI') {
      console.error('Rapor güvenlik denetiminden geçemedi; çıktı üretilmedi.');
      process.exitCode = 1;
      return;
    }
    if (e && e.code === 'E_HEDEF_YOK') {
      console.error('Ne Hermes ne FreeAgent kurulumu bulundu. --hermes / --freeagent ile yol verin.');
      process.exitCode = 1;
      return;
    }
    console.error('Beklenmeyen hata:', e && e.message ? e.message : String(e));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export {
  parseArgs, parseEnv, parseYamlSubset, maskUrl, hasUserinfo, isLocalUrl,
  checkHermes, checkFreeAgent, checkCross, collectRefs, runDoctor, main,
  VERSION, FREEAGENT_REQUIRED, CHECK_IDS,
};
