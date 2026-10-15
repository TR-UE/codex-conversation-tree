import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { action, pluginRoot, VERSION } from './runtime.mjs';

const URI = 'ui://conversation-tree/panel.html';
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const tools = [
  { name: 'open_tree_panel', title: '打开对话树', description: '在 Codex 中打开对话树面板。可传入当前 Codex threadId 关联此原生对话；关联后自动记录每轮可见对话，数据仅保存到桌面。', inputSchema: schema({ threadId: str, title: str }), _meta: { ui: { resourceUri: URI, visibility: ['model', 'app'] }, 'openai/outputTemplate': URI, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }], displayMode: 'fullscreen' }, 'openai/widgetAccessible': true } },
  { name: 'tree_state', title: '读取对话树', description: '读取本机已关联的对话树和可见消息，不读取未关联对话。', inputSchema: schema({ treeId: str }), annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'link_thread', title: '关联原生对话', description: '将明确指定的原生 Codex 对话关联到本地对话树并开始自动同步；只用于用户要求管理的对话。', inputSchema: schema({ threadId: str, title: str }, ['threadId']), _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'fork_native_node', title: '从历史节点分叉', description: '通过 Codex 原生 thread/fork 和指定 lastTurnId 创建新分支，保留父对话。仅分叉已完成轮次，不发送新提问，不修改父对话文件。返回 threadId 后可用 Codex 的 navigate_to_codex_page 打开新分支。', inputSchema: schema({ treeId: str, nodeId: str, title: str, memoryMode: { type: 'string', enum: ['historical', 'latest'] } }, ['treeId', 'nodeId']), _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'save_root_memory', title: '保存树根记忆版本', description: '保存用户指定的树根记忆，保留旧版本和来源节点。不要未经用户选择把所有回答纳入记忆。', inputSchema: schema({ treeId: str, content: str, baseVersion: { type: 'integer' }, sourceNodeIds: { type: 'array', items: str }, materialVersion: { type: 'integer' } }, ['treeId', 'content', 'baseVersion']), _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'mark_node', title: '标记节点', description: '为本地节点命名或标记重点，不修改 Codex 原始消息。', inputSchema: schema({ treeId: str, nodeId: str, title: str, pinned: { type: 'boolean' } }, ['treeId', 'nodeId']), _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'manage_branch', title: '设为主分支、剪枝或恢复', description: 'promote 将用户指定的已关联路径设为主分支；原生来源和树根记忆保留。prune 隐藏指定路径并暂停同步，保留当前主分支及其下游；restore 恢复剪枝。promote/prune 需要 threadId，restore 需要 pruneId。不执行原生永久删除。', inputSchema: schema({ treeId: str, operation: { type: 'string', enum: ['promote', 'prune', 'restore'] }, threadId: str, pruneId: str }, ['treeId', 'operation']), _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'preview_native_deletion', title: '预览原生会话删除范围', description: '只读检查指定分支及其子会话的删除范围，返回短时确认方案。不会执行删除。用于面板显示真实会话名称、ID 和不可恢复范围。', inputSchema: schema({ treeId: str, threadId: str }, ['treeId', 'threadId']), annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['model', 'app'] } } },
  { name: 'delete_native_branch', title: '确认永久删除原生会话', description: '仅供面板在用户查看范围并输入确认文字后执行。使用 Codex thread/delete 永久删除指定原生分支及其子会话；保留本地记录和树根记忆。需要有效预览方案，不能代替用户确认。', inputSchema: schema({ treeId: str, threadId: str, planId: str, confirmation: str }, ['treeId', 'threadId', 'planId', 'confirmation']), annotations: { destructiveHint: true, readOnlyHint: false }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'tree_diagnostics', title: '检查插件状态', description: '检查对话树后台、观察器和接口状态，不返回登录凭据。', inputSchema: schema(), annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['model', 'app'] } } }
];
const mapping = { tree_state: 'state', link_thread: 'link', fork_native_node: 'fork', save_root_memory: 'memory', mark_node: 'pin', manage_branch: 'branch', preview_native_deletion: 'deletion_preview', delete_native_branch: 'deletion_execute', tree_diagnostics: 'diagnostics' };
function result(data, summary) { return { content: [{ type: 'text', text: summary || JSON.stringify(data) }], structuredContent: data }; }
async function handle(method, params) {
  if (method === 'initialize') { return { protocolVersion: params.protocolVersion || '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'conversation-tree', version: VERSION }, instructions: '本地对话树仅同步用户显式关联的 Codex 对话。打开面板时传入当前 threadId；历史分叉使用节点真实 turnId，不能用摘要冒充完整分叉。' }; }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'resources/list') return { resources: [{ uri: URI, name: '对话树面板', mimeType: 'text/html;profile=mcp-app' }] };
  if (method === 'resources/templates/list') return { resourceTemplates: [] };
  if (method === 'resources/read') {
    if (params.uri !== URI) throw new Error('资源不存在');
    return { contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: fs.readFileSync(path.join(pluginRoot, 'ui/panel.html'), 'utf8'), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetDescription': '原生 Codex 对话的树形节点和版本化树根记忆。' } }] };
  }
  if (method === 'tools/call') {
    if (!tools.some(t => t.name === params.name)) throw new Error('工具不存在');
    try {
      const args = params.arguments || {};
      if (params.name === 'open_tree_panel') {
        const data = args.threadId ? await action('link', args) : await action('state');
        return { ...result({ treeId: data.tree?.id, nodeCount: data.tree?.nodes.length || 0, recording: data.sessions.some(s => s.recording), local: true }, `对话树面板已准备，记录了 ${data.tree?.nodes.length || 0} 个节点。`), _meta: { panelData: data } };
      }
      const data = await action(mapping[params.name], args);
      return result(data, params.name === 'fork_native_node' ? `已创建原生 Codex 分支。对话 ID：${data.threadId}；继承至轮次：${data.throughTurnId}。请用 navigate_to_codex_page 打开。旧节点没有追溯文件快照，此操作仅分叉对话。` : undefined);
    } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  }
  throw new Error('不支持的方法：' + method);
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  try { const res = await handle(message.method, message.params || {}); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: res }) + '\n'); }
  catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } }) + '\n'); }
});
