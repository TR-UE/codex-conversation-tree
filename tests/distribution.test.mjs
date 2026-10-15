import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { readSettings } from '../plugin/codex-conversation-tree/server/paths.mjs';
import { preparePersonalInstall } from '../plugin/codex-conversation-tree/server/setup.mjs';

test('portable settings use the new user desktop and preserve per-user preferences outside the package', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-paths-test-'));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plugin = path.join(home, 'package');fs.mkdirSync(plugin);fs.writeFileSync(path.join(plugin, 'settings.json'), '{"port":4321}');
  let settings = readSettings(plugin, { home, env: {} });assert.equal(settings.dataDir, path.join(home, 'Desktop/Codex-Conversation-Tree/data/native'));
  fs.mkdirSync(settings.dataDir, { recursive: true });fs.writeFileSync(path.join(settings.dataDir, 'preferences.json'), JSON.stringify({ codexHome: path.join(home, 'chosen-codex') }));
  settings = readSettings(plugin, { home, env: {} });assert.equal(settings.codexHome, path.join(home, 'chosen-codex'));
  const override = readSettings(plugin, { home, env: { TREE_NATIVE_DATA_DIR: path.join(home, 'test-data'), TREE_NATIVE_CODEX_HOME: path.join(home, 'test-codex'), TREE_NATIVE_PORT: '4396' } });
  assert.equal(override.codexHome, path.join(home, 'test-codex'));assert.equal(override.port, 4396);
});
test('personal installation merges other entries, survives a source move, and preserves conversation data', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-installer-test-'));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'Downloads/plugin');fs.mkdirSync(source, { recursive: true });fs.writeFileSync(path.join(source, 'plugin.json'), '{"name":"codex-conversation-tree","version":"0.4.0"}');
  const catalogPath = path.join(home, '.agents/plugins/marketplace.json');fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const other = { name: 'other-plugin', source: { source: 'local', path: './existing' } };fs.writeFileSync(catalogPath, JSON.stringify({ name: 'my-tools', plugins: [other] }));
  const data = path.join(home, 'Desktop/Codex-Conversation-Tree/data/native');fs.mkdirSync(data, { recursive: true });fs.writeFileSync(path.join(data, 'store.json'), 'existing conversation data');
  const first = preparePersonalInstall(source, { home });fs.renameSync(source, path.join(home, 'Downloads/moved'));
  const second = preparePersonalInstall(first.sourceRoot, { home });assert.equal(second.pluginId, 'codex-conversation-tree@my-tools');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));assert.deepEqual(catalog.plugins[0], other);assert.equal(catalog.plugins.length, 2);
  assert.ok(fs.existsSync(path.join(first.sourceRoot, 'plugin.json')));assert.equal(fs.readFileSync(path.join(data, 'store.json'), 'utf8'), 'existing conversation data');
});
test('MCP discovery stays dormant until an actual tool call', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-dormant-test-')),data = path.join(temp, 'data');
  const child = spawn(process.execPath, [path.resolve('plugin/codex-conversation-tree/server/mcp.mjs')], { env: { ...process.env, TREE_NATIVE_DATA_DIR: data, TREE_NATIVE_PORT: '4396' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill();fs.rmSync(temp, { recursive: true, force: true }); });
  const input = readline.createInterface({ input: child.stdout });let id = 0;const pending = new Map();
  input.on('line', line => { const m = JSON.parse(line), p = pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);} });
  const rpc = (method, params) => new Promise((resolve, reject) => { const n = ++id,timer = setTimeout(() => reject(Error('MCP timeout')), 5000);pending.set(n, { resolve, reject, timer });child.stdin.write(JSON.stringify({ id:n,jsonrpc:'2.0',method,params })+'\n'); });
  await rpc('initialize', { protocolVersion: '2025-11-25' });const list = await rpc('tools/list', {});assert.equal(list.tools.length, 10);
  await rpc('resources/read', { uri: 'ui://conversation-tree/panel.html' });assert.equal(fs.existsSync(data), false);
});
