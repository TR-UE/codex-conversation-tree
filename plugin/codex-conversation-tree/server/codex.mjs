import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import os from 'node:os';

export class Codex extends EventEmitter {
  constructor(home, options = {}) { super(); this.home = home; this.options = options; this.counter = 0; this.pending = new Map(); this.requests = new Map(); this.status = 'disconnected'; this.ready = null; }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => { this.ready = null; this.status = 'error'; this.error = error.message; throw error; });
    return this.ready;
  }
  async start() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const existingAuth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    const localAuth = path.join(this.home, 'auth.json');
    if (!fs.existsSync(localAuth) && fs.existsSync(existingAuth) && existingAuth !== localAuth) fs.symlinkSync(existingAuth, localAuth);
    this.status = 'connecting';
    this.child = spawn(process.env.CODEX_BINARY || 'codex', ['app-server', '--listen', 'stdio://', '-c', 'features.memories=false', '-c', 'features.multi_agent=false'], { env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`, CODEX_HOME: this.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => this.disconnected(error));
    this.child.on('exit', code => this.disconnected(new Error(`Codex 连接已关闭（${code ?? '终止'}）`)));
    // Never persist stderr: runtime logs can include paths and authentication details.
    this.child.stderr.on('data', () => {});
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && !msg.method) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })); else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        this.requests.set(String(msg.id), msg); this.emit('request', msg);
      } else if (msg.method) this.emit('notification', msg);
    });
    await this.rpc('initialize', { clientInfo: { name: 'codex_conversation_tree', title: '对话树', version: '0.1.0' }, ...(this.options.experimentalApi ? { capabilities: { experimentalApi: true } } : {}) });
    this.send({ method: 'initialized', params: {} });
    const [account, models] = await Promise.all([this.rpc('account/read', { refreshToken: false }), this.rpc('model/list', { limit: 100 })]);
    this.account = account.account ? { type: account.account.type, planType: account.account.planType ?? null } : null;
    this.models = models.data.filter(m => !m.hidden);
    this.status = 'connected'; this.error = null; this.emit('status');
  }
  send(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex 尚未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  rpc(method, params = {}, timeout = 60000) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  answer(id, result) {
    const request = this.requests.get(String(id)); if (!request) throw new Error('该请求已失效');
    this.send({ id: request.id, result }); this.requests.delete(String(id));
  }
  disconnected(error) {
    this.status = 'disconnected'; this.error = error.message; this.ready = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.requests.clear(); this.emit('disconnect', error);
  }
  stop() { this.child?.kill('SIGTERM'); }
}
