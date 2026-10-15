import fs from 'node:fs';
import path from 'node:path';
import { action, ensureRuntime, settings, pluginRoot } from './runtime.mjs';

const [command = 'doctor', ...args] = process.argv.slice(2);
const value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
try {
  if (command === 'open') {
    const threadId = value('--thread-id');
    const data = threadId ? await action('link', { threadId }) : await action('state');
    console.log(JSON.stringify({ panelUrl: `http://127.0.0.1:${settings.port}/`, treeId: data.tree?.id, threadId: threadId || null, nodeCount: data.tree?.nodes.length || 0, dataDir: settings.dataDir }, null, 2));
  } else if (command === 'start') { await ensureRuntime();console.log(JSON.stringify({ panelUrl: `http://127.0.0.1:${settings.port}/` })); }
  else if (command === 'doctor') {
    let health = null;try { const r = await fetch(`http://127.0.0.1:${settings.port}/health`, { signal: AbortSignal.timeout(1000) });health = await r.json(); } catch {}
    const receipt = path.join(settings.dataDir, 'installation.json');
    console.log(JSON.stringify({ pluginRoot, node: process.versions.node, codexBinary: settings.codexBinary, dataDir: settings.dataDir, personalMarketplace: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')).marketplacePath : null, runtime: health, nativeMcpAppsView: 'requires host render verification' }, null, 2));
  } else throw new Error('支持 open --thread-id <真实对话ID>、start、doctor；此入口不提供永久删除命令。');
} catch (e) { console.error(e.message);process.exitCode = 1; }
