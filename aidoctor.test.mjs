import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv, parseYamlSubset, runDoctor, VERSION } from './aidoctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'aidoctor.mjs');

function mkTmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aidoctor-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function writeHermes(dir, { config, env, catalog, ctxCache } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.yaml'), config);
  if (env !== undefined) fs.writeFileSync(path.join(dir, '.env'), env);
  if (catalog !== undefined) {
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'model_catalog.json'), catalog);
  }
  if (ctxCache !== undefined) fs.writeFileSync(path.join(dir, 'context_length_cache.yaml'), ctxCache);
}

function writeFreeAgent(dir, { env, server, conversations } = {}) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  if (env !== undefined) fs.writeFileSync(path.join(dir, '.env'), env);
  if (server !== undefined) fs.writeFileSync(path.join(dir, 'server.js'), server);
  if (conversations !== undefined) fs.writeFileSync(path.join(dir, 'data', 'conversations.json'), conversations);
}

const validHermes = () => ({
  config: `model:
  default: m1
  provider: th
  api_key: \${TH_KEY}
providers:
  th:
    api: https://example.com/v1
    api_key: \${TH_KEY}
    models:
      m1: {}
      ns/model:free: {}
custom_providers:
  - name: ThLocal
    base_url: http://localhost:9/v1
    api_key: \${TH_KEY}
fallback_providers:
  - provider: th
    model: m1
  - provider: custom:ThLocal
    model: m1
auxiliary:
  vision:
    provider: auto
    model: ''
council:
  seats:
    - name: a
      provider: ThLocal
  judge:
    provider: th
`,
  env: 'TH_KEY=test-key-1234567890\n',
});

const validFreeAgent = () => ({
  env: [
    'NVIDIA_API_KEY=nv-test-1234567890',
    'GEMINI_API_KEY=gm-test-1234567890',
    'GEMINI_BACKUP_API_KEY=gm2-test-1234567890',
    'TOKENHARBOR_API_KEY=th-test-1234567890',
    'TOKENHARBOR_BASE_URL=https://tokenharbor.ai/v1',
    'TOKENHARBOR_MODEL=qwen3.8-flash',
    '',
  ].join('\n'),
  server: "const PROVIDERS = ['tokenharbor', 'gemini'];\nmodule.exports = {};\n",
  conversations: '[]',
});

function ids(res) {
  return res.findings.map((f) => f.id);
}

test('parseEnv: export, tırnak, yinelenen ad', () => {
  const e = parseEnv('# yorum\nexport A="x y"\nB=1\nA=2\n');
  assert.equal(e.vars.get('A').value, '2');
  assert.equal(e.vars.get('A').count, 2);
  assert.equal(e.vars.get('B').value, '1');
  assert.deepEqual(e.duplicates.map((d) => d.name), ['A']);
});

test('yaml: iki noktalı model kimlikleri ve liste kapsamları', () => {
  const text = `providers:
  p:
    models:
      tokenharbor/deepseek-v4.1-flash:free: {}
      cloudflare-ai/@cf/zai-org/glm-4.7-flash: {}
custom_providers:
  - name: A
    base_url: http://a/v1
  - name: B
    base_url: http://b/v1
`;
  const r = parseYamlSubset(text);
  assert.equal(r.dupKeys.length, 0);
  const models = r.root.map.get('providers').map.get('p').map.get('models');
  assert.ok(models.map.has('tokenharbor/deepseek-v4.1-flash:free'));
  const cps = r.root.map.get('custom_providers').items;
  assert.equal(cps.length, 2);
  assert.equal(cps[1].map.get('name').value, 'B');
});

test('yaml: yinelenen anahtar aynı kapsamda yakalanır', () => {
  const r = parseYamlSubset('model:\n  default: a\n  default: b\n');
  assert.equal(r.dupKeys.length, 1);
  assert.equal(r.dupKeys[0].key, 'default');
});

test('yaml: blok skaler içindeki satırlar anahtar sayılmaz', () => {
  const text = `a:
  b: |
    sahte: anahtar
    diger: deger
  c: son
`;
  const r = parseYamlSubset(text);
  assert.equal(r.dupKeys.length, 0);
  assert.equal(r.issues.length, 0);
  assert.equal(r.root.map.get('a').map.get('c').value, 'son');
});

test('temiz kurulum: bulgu yok, çıkış 0', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  writeHermes(h, validHermes());
  writeFreeAgent(f, validFreeAgent());
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  assert.deepEqual(res.findings, []);
  assert.equal(res.summary.exitCode, 0);
});

test('çözülemeyen ${VAR} ve bilinmeyen custom sağlayıcı HATA üretir', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  writeHermes(h, {
    config: `model:
  default: m
  provider: custom:ghost
  api_key: \${MISSING_KEY}
providers:
  p:
    api: https://example.com/v1
`,
    env: '',
  });
  writeFreeAgent(f, validFreeAgent());
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  const found = ids(res);
  assert.ok(found.includes('hermes.env.unresolved_ref'));
  assert.ok(found.includes('hermes.custom.unknown'));
  assert.ok(!found.includes('hermes.model.api_key_missing'));
  assert.equal(res.summary.exitCode, 2);
});

test('case drift BİLGİ, unknown değil', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  const cfg = validHermes();
  cfg.config = cfg.config.replace('provider: custom:ThLocal', 'provider: custom:thlocal');
  writeHermes(h, cfg);
  writeFreeAgent(f, validFreeAgent());
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  assert.ok(ids(res).includes('hermes.custom.case_drift'));
  assert.ok(!ids(res).includes('hermes.custom.unknown'));
});

test('orphan env, duplicate env, satır içi anahtar', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  const cfg = validHermes();
  cfg.config = cfg.config.replace('api_key: ${TH_KEY}\nproviders:', 'api_key: sk-INLINE-123456789\nproviders:');
  cfg.env = 'TH_KEY=test-key-1234567890\nXAI_ORPHAN_API_KEY=zzz-1234567890\nXAI_ORPHAN_API_KEY=zzz-1234567890\n';
  writeHermes(h, cfg);
  writeFreeAgent(f, validFreeAgent());
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  const found = ids(res);
  assert.ok(found.includes('hermes.secret.inline_literal'));
  assert.ok(found.includes('hermes.env.orphan_provider_var'));
  assert.ok(found.includes('hermes.env.duplicate_name'));
});

test('URL userinfo maskelenir', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  const cfg = validHermes();
  cfg.config = cfg.config.replace('api: https://example.com/v1', 'api: https://user:pass@example.com/v1');
  writeHermes(h, cfg);
  writeFreeAgent(f, validFreeAgent());
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  assert.ok(ids(res).includes('hermes.url.userinfo'));
  const json = JSON.stringify(res);
  assert.ok(!json.includes('user:pass'));
  assert.ok(json.includes('***@'));
});

test('FreeAgent: eksik anahtar, http url, bozuk veri', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  writeHermes(h, validHermes());
  writeFreeAgent(f, {
    env: 'TOKENHARBOR_API_KEY=th-test-1234567890\nTOKENHARBOR_BASE_URL=http://example.com/v1\nTOKENHARBOR_MODEL=x\n',
    server: 'module.exports = {};\n',
    conversations: '{bozuk',
  });
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  const found = ids(res);
  assert.ok(found.includes('freeagent.env.missing_key'));
  assert.ok(found.includes('freeagent.server.baseurl_http'));
  assert.ok(found.includes('freeagent.data.invalid'));
});

test('Gemini anahtarı var, server.js bağsız → uyarı', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  writeHermes(h, validHermes());
  const fa = validFreeAgent();
  fa.server = 'module.exports = {};\n';
  writeFreeAgent(f, fa);
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  assert.ok(ids(res).includes('freeagent.server.gemini_unwired'));
});

test('redaksiyon: dikilen sırlar raporda görünmez', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  const cfg = validHermes();
  cfg.config = cfg.config
    .replace('api_key: ${TH_KEY}\nproviders:', 'api_key: sk-PLANTED-123456789\nproviders:')
    .replace('api: https://example.com/v1', 'api: https://u:p@example.com/v1');
  cfg.env = 'TH_KEY=sk-PLANTED-123456789\n';
  writeHermes(h, cfg);
  const fa = validFreeAgent();
  fa.env += 'EXTRA_SECRET=sk-PLANTED-123456789\n';
  writeFreeAgent(f, fa);
  const res = await runDoctor({ hermes: h, freeagent: f, network: false }, { env: {} });
  const json = JSON.stringify(res);
  assert.ok(!json.includes('sk-PLANTED-123456789'));
  assert.ok(!json.includes('u:p@'));
});

test('ağ kapalıyken fetch çağrılmaz', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  writeHermes(h, validHermes());
  writeFreeAgent(f, validFreeAgent());
  let calls = 0;
  await runDoctor({ hermes: h, freeagent: f, network: false }, {
    env: {},
    fetchImpl: () => { calls++; return Promise.resolve({ status: 200, json: async () => ({}) }); },
  });
  assert.equal(calls, 0);
});

test('ağ açıkken yalnız yerel uçlar yoklanır', async (t) => {
  const h = mkTmp(t);
  const f = mkTmp(t);
  writeHermes(h, validHermes());
  writeFreeAgent(f, validFreeAgent());
  const urls = [];
  const res = await runDoctor({ hermes: h, freeagent: f, network: true }, {
    env: {},
    fetchImpl: (url) => {
      urls.push(String(url));
      return Promise.resolve({ status: 200, json: async () => ({ models: { m: { providers: [{ configured: true }] } } }) });
    },
  });
  assert.ok(urls.some((u) => u.includes('localhost:9')));
  assert.ok(urls.some((u) => u.includes('4317')));
  assert.ok(!ids(res).includes('hermes.local.unreachable'));
  assert.ok(!ids(res).includes('freeagent.health.unreachable'));
});

test('CLI: sürüm, yardım, bilinmeyen bayrak', () => {
  const v = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), VERSION);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('Kullanım'));
  const bad = spawnSync(process.execPath, [CLI, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('CLI: temiz kurulum 0, hatalı kurulum 2', (t) => {
  const h1 = mkTmp(t);
  const f1 = mkTmp(t);
  writeHermes(h1, validHermes());
  writeFreeAgent(f1, validFreeAgent());
  const ok = spawnSync(process.execPath, [CLI, '--hermes', h1, '--freeagent', f1, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.summary.exitCode, 0);

  const h2 = mkTmp(t);
  writeHermes(h2, { config: 'model:\n  default: m\n', env: '' });
  const bad = spawnSync(process.execPath, [CLI, '--hermes', h2, '--freeagent', f1, '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
