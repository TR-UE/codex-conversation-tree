// Exercise the distributable package with a disposable profile and simulated
// desktop. Never install a test entry into the user's real catalog or profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-clean-install-'));
const home = path.join(root, 'new-user'), profile = path.join(root, 'codex-profile');
fs.mkdirSync(profile, { recursive: true });
const source = path.join(root, 'Downloads/Conversation Tree/codex-conversation-tree');
fs.mkdirSync(path.dirname(source), { recursive: true });
if (process.argv[2]) execFileSync('/usr/bin/unzip', ['-q', path.resolve(process.argv[2]), '-d', path.dirname(source)]);
else fs.cpSync(path.resolve('plugin/codex-conversation-tree'), source, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'));
const installer = path.join(source, '安装.command');
assert.ok(fs.existsSync(installer), 'ZIP must preserve the exact UTF-8 installer filename');
assert.ok(fs.statSync(installer).mode & 0o111, 'ZIP installer must retain executable permissions');
const catalogPath = path.join(home, '.agents/plugins/marketplace.json');
fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
const other = { name: 'another-local-tool', source: { source: 'local', path: './Existing/tool' } };
fs.writeFileSync(catalogPath, JSON.stringify({ name: 'tree-clean-install-test', plugins: [other] }));
const data = path.join(home, 'Desktop/Codex-Conversation-Tree/data/native');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'preserved-fixture.txt'), 'Existing local material');
process.env.CODEX_HOME = profile;
process.env.TREE_NATIVE_DATA_DIR = data;
process.env.TREE_NATIVE_PORT = '4396';
process.env.CODEX_BINARY ||= 'codex';
process.env.PATH = path.dirname(process.execPath) + path.delimiter + process.env.PATH;
let child;
try {
  const { install } = await import(pathToFileURL(path.join(source, 'server/setup.mjs')));
  const receipt = install(source, { home });
  assert.equal(receipt.version, manifest.version);
  const installed = JSON.parse(execFileSync(process.env.CODEX_BINARY, ['plugin', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).installed.find(p => p.pluginId === receipt.pluginId);
  assert.equal(installed.enabled, true);assert.equal(installed.installed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalogPath, 'utf8')).plugins[0], other);
  assert.equal(fs.readFileSync(path.join(data, 'preserved-fixture.txt'), 'utf8'), 'Existing local material');
  const launch = path.join(receipt.sourceRoot, 'scripts/launch-node.sh');
  child = spawn('/bin/sh', [launch, path.join(receipt.sourceRoot, 'server/mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const input = readline.createInterface({ input: child.stdout }), pending = new Map();let id = 0;
  input.on('line', line => { const message = JSON.parse(line), item = pending.get(message.id);if(item){clearTimeout(item.timer);pending.delete(message.id);message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);} });
  const rpc = (method, params) => new Promise((resolve, reject) => { const key = ++id,timer = setTimeout(() => reject(Error('MCP timeout')), 8000);pending.set(key,{ resolve,reject,timer });child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-11-25' });assert.equal(init.serverInfo.version, manifest.version);
  const tools = await rpc('tools/list', {});assert.equal(tools.tools.length, 10);
  const doctor = JSON.parse(execFileSync('/bin/sh', [launch, path.join(receipt.sourceRoot, 'server/cli.mjs'), 'doctor'], { encoding: 'utf8' }));
  assert.equal(doctor.dataDir, data);assert.equal(doctor.runtime, null);
  const report = { verifiedAt: new Date().toISOString(), version: manifest.version, input: process.argv[2] ? 'unpacked ZIP' : 'source copy', isolatedProfile: true, sourcePathContainsSpaces: true, installedAndEnabled: true, otherCatalogEntriesPreserved: true, existingDataPreserved: true, relocatedPackageMcpTools: tools.tools.length, discoveryDoesNotStartRecording: true, nodeRuntime: doctor.node, userConversationsTouched: false };
  fs.writeFileSync(path.resolve('docs/clean-install-verification.json'), JSON.stringify(report, null, 2) + '\n');console.log(JSON.stringify(report, null, 2));
} finally { child?.kill();fs.rmSync(root, { recursive: true, force: true }); }
