import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readSettings } from './paths.mjs';

export const pluginName = 'codex-conversation-tree';
export function preparePersonalInstall(source, { home = os.homedir() } = {}) {
  const sourceRoot = path.join(home, 'Desktop/Codex-Conversation-Tree/plugin', pluginName);
  const marketplacePath = path.join(home, '.agents/plugins/marketplace.json');
  const catalog = fs.existsSync(marketplacePath) ? JSON.parse(fs.readFileSync(marketplacePath, 'utf8')) : { name: 'conversation-tree-local', interface: { displayName: '我的本地工具' }, plugins: [] };
  if (!catalog.name || !Array.isArray(catalog.plugins)) throw new Error('现有个人插件目录格式无效，未覆盖它');
  const entry = catalog.plugins.find(p => p.name === pluginName);
  if (entry && path.resolve(home, entry.source?.path || '') !== sourceRoot) throw new Error('个人插件目录已有同名插件，但指向其他源码；未覆盖');
  if (path.resolve(source) !== path.resolve(sourceRoot)) { fs.mkdirSync(path.dirname(sourceRoot), { recursive: true }); fs.cpSync(source, sourceRoot, { recursive: true, dereference: false }); }
  const relative = './' + path.relative(home, sourceRoot).split(path.sep).join('/');
  const plugin = { name: pluginName, source: { source: 'local', path: relative }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' };
  if (entry) Object.assign(entry, plugin); else catalog.plugins.push(plugin);
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  const temporary = marketplacePath + '.tree-install.tmp';fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + '\n');fs.renameSync(temporary, marketplacePath);
  return { sourceRoot, marketplacePath, marketplaceName: catalog.name, pluginId: `${pluginName}@${catalog.name}`, installUrl: `codex://plugins/${pluginName}?marketplacePath=${encodeURIComponent(marketplacePath)}`, startUrl: `codex://new?prompt=${encodeURIComponent(`[@对话树](plugin://${pluginName}@${catalog.name}) 打开对话树面板并记录当前对话。`)}` };
}
export function install(source, options = {}) {
  const result = preparePersonalInstall(source, options), settings = readSettings(result.sourceRoot, options);
  const execOptions = { env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const run = args => execFileSync(settings.codexBinary, args, execOptions).trim();
  const home = options.home || os.homedir();
  const markets = JSON.parse(run(['plugin', 'marketplace', 'list', '--json'])).marketplaces;
  const legacy = path.join(home, 'Desktop/Codex-Conversation-Tree/plugin-marketplace');
  if (markets.some(m => m.name === result.marketplaceName && m.marketplaceSource?.source === legacy)) run(['plugin', 'marketplace', 'remove', result.marketplaceName]);
  // ~/.agents is discovered implicitly. Register only non-default test or
  // custom-home catalog roots; leave other marketplaces intact.
  if (!markets.some(m => m.name === result.marketplaceName && path.resolve(m.root) === path.resolve(home))) run(['plugin', 'marketplace', 'add', home, '--json']);
  const installed = JSON.parse(run(['plugin', 'add', result.pluginId, '--json']));
  // Compatibility registration; the packaged skill can also open the panel
  // through its contained CLI when an existing conversation has stale tools.
  run(['mcp', 'add', 'conversation_tree', '--', '/bin/sh', path.join(result.sourceRoot, 'scripts/launch-node.sh'), path.join(result.sourceRoot, 'server/mcp.mjs'), `--plugin-version=${installed.version}`]);
  fs.mkdirSync(settings.dataDir, { recursive: true });
  const receipt = { ...result, version: installed.version, installedAt: new Date().toISOString(), dataDir: settings.dataDir, note: '重启桌面应用并在新会话中加载插件；已有会话可使用插件内的 CLI 入口。' };
  fs.writeFileSync(path.join(settings.dataDir, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try { console.log(JSON.stringify(install(source), null, 2)); } catch (e) { console.error(e.message);process.exitCode = 1; }
}
