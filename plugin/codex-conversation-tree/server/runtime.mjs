import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeTree } from './native.mjs';
import { readSettings } from './paths.mjs';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const settings = readSettings(pluginRoot);
export const VERSION = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).version;
const tokenFile = path.join(settings.dataDir, 'runtime.token');
export function token() {
  fs.mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(tokenFile, 'utf8').trim();
}
const base = `http://127.0.0.1:${settings.port}`;
async function healthy() { try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1200) }); const data = await r.json(); return r.ok && data.app === 'codex-conversation-tree-plugin' && (data.apiVersion === 1 || data.version === VERSION); } catch { return false; } }
export async function ensureRuntime() {
  if (await healthy()) return;
  token();
  const log = fs.openSync(path.join(settings.dataDir, 'runtime.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon'], { cwd: pluginRoot, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` }, detached: true, stdio: ['ignore', log, log] }); child.unref(); fs.closeSync(log);
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); if (await healthy()) return; }
  throw new Error('本地对话树后台未启动，请查看桌面 data/native/runtime.log');
}
export async function action(name, args = {}) {
  await ensureRuntime(); const response = await fetch(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(90000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
export async function openPanel(threadId, title) {
  const data = await action('state', { threadId });
  return threadId && data.context?.status === 'unlinked' ? action('link', { threadId, title }) : data;
}
if (process.argv.includes('--daemon')) {
  const api = new NativeTree(settings), secret = token();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end(); return; }
    const cookieAuth = req.headers.cookie?.split(';').some(c => c.trim() === `tree_local=${secret}`);
    const url = new URL(req.url, base);
    try {
      if (req.method === 'GET' && url.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ app: 'codex-conversation-tree-plugin', version: VERSION, apiVersion: 1 })); return; }
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Set-Cookie', `tree_local=${secret}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'");
        res.end(fs.readFileSync(path.join(pluginRoot, 'ui/panel.html'))); return;
      }
      if (req.headers.authorization !== `Bearer ${secret}` && !cookieAuth) throw new Error('本地请求未授权');
      if (req.method !== 'POST' || url.pathname !== '/api/action') throw new Error('请求不存在');
      const chunks = []; let bytes = 0; for await (const b of req) { bytes += b.length; if (bytes > 500000) throw new Error('请求内容过大'); chunks.push(b); }
      const { name, args = {} } = JSON.parse(Buffer.concat(chunks).toString()); let result;
      if (name === 'state') result = api.state(args.treeId, { threadId: args.threadId });
      else if (name === 'link') result = await api.link(args.threadId, args.title, args.contextThreadId);
      else if (name === 'fork') result = await api.fork(args);
      else if (name === 'memory') result = api.memory(args);
      else if (name === 'pin') result = api.pin(args);
      else if (name === 'branch') result = api.branch(args);
      else if (name === 'tree') result = await api.management.manage(args);
      else if (name === 'deletion_preview') result = await api.deletion.preview(args);
      else if (name === 'deletion_execute') result = await api.deletion.execute(args);
      else if (name === 'hook') result = api.hook(args);
      else if (name === 'pause') { const session = api.sessions().find(s => s.threadId === args.threadId); if (!session) throw new Error('对话没有关联'); session.recording = false; api.store.save(); result = api.state(session.treeId); }
      else if (name === 'diagnostics') result = { ...api.state(), runtimePid: process.pid, pluginRoot, formatAdapter: 'codex-jsonl-0.162', forkEngine: 'thread/fork:lastTurnId' };
      else throw new Error('不支持的操作');
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.message })); }
  });
  server.listen(settings.port, '127.0.0.1', () => { fs.writeFileSync(path.join(settings.dataDir, 'runtime.pid'), String(process.pid)); console.log('对话树本地后台已启动，端口 ' + settings.port); });
  server.on('error', e => { api.close(); console.error(e.code === 'EADDRINUSE' ? '已有对话树后台运行。' : e.message); process.exit(1); });
  function stop() { api.close(); server.close(); setTimeout(() => process.exit(0), 800).unref(); }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
