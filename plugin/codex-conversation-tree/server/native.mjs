import fs from 'node:fs';
import path from 'node:path';
import { Store, now, uid } from './store.mjs';
import { Codex } from './codex.mjs';
import { parseTranscript, parseTurns } from './transcript.mjs';
import { NativeDeletion } from './deletion.mjs';

export class NativeTree {
  constructor(settings) {
    this.settings = settings; this.store = new Store(settings.dataDir);
    this.store.state.nativeSessions ||= [];
    process.env.CODEX_BINARY ||= settings.codexBinary;
    this.engine = this.newEngine(); this.forkEngines = new Set();
    this.deletion = new NativeDeletion(this);
    this.stats = new Map(); this.apiSnapshots = new Map(); this.visibleSnapshots = new Map(); this.apiInFlight = new Set(); this.version = 0; this.lastError = null;
    for (const s of this.sessions()) delete s.syncing;
    this.syncAll();
    this.timer = setInterval(() => { try { this.syncAll(); } catch (e) { this.lastError = e.message; } }, 900);
    this.apiTimer = setInterval(() => { for (const s of this.sessions().filter(s => s.recording)) void this.syncApi(s).catch(e => { s.error = e.message; }); }, 3000);
  }
  sessions() { return this.store.state.nativeSessions; }
  mainThreadId(tree) { return tree.native?.mainThreadId || tree.native?.rootThreadId; }
  threadTitle(tree, id) { return tree.native?.forks?.find(f => f.threadId === id)?.title || (id === tree.native?.rootThreadId ? `原始主线 · ${tree.title}` : `分支 · ${id.slice(0, 8)}`); }
  descendantIds(tree, id, retainMain = false) {
    const ids = new Set([id]), main = this.mainThreadId(tree);let changed = true;
    while (changed) {
      changed = false;
      for (const s of this.sessions().filter(s => s.treeId === tree.id)) if (ids.has(s.parentThreadId) && !ids.has(s.threadId) && !(retainMain && s.threadId === main)) { ids.add(s.threadId);changed = true; }
    }
    return ids;
  }
  promoteMain({ treeId, threadId }) {
    const tree = this.store.tree(treeId), session = this.sessions().find(s => s.treeId === tree.id && s.threadId === threadId);
    if (!tree.native?.rootThreadId) throw new Error('此树尚未确认原生会话来源，暂不能设置主分支');
    if (!session) throw new Error('只能将这棵树中已关联的会话设为主分支');
    if (session.nativeDeletedAt || this.isPruned(session)) throw new Error('请先恢复这条分支，已删除的原生会话不能设为主分支');
    if (this.deletion.executing || tree.native?.deletions?.some(d => d.status === 'pending')) throw new Error('原生删除进行中或结果待核验，暂不能切换主分支');
    const previous = this.mainThreadId(tree);
    if (previous === threadId) return this.state(tree.id);
    tree.native.mainThreadId = threadId;
    tree.native.mainChanges ||= [];tree.native.mainChanges.push({ fromThreadId: previous, toThreadId: threadId, changedAt: now() });
    tree.updatedAt = now();this.store.save();this.version++;
    return this.state(tree.id);
  }
  paths(tree) {
    return this.sessions().filter(s => s.treeId === tree.id).map(s => {
      const containsMain = this.descendantIds(tree, s.threadId).has(this.mainThreadId(tree));
      const isMain = s.threadId === this.mainThreadId(tree), isOrigin = s.threadId === tree.native?.rootThreadId;
      return { threadId: s.threadId, title: this.threadTitle(tree, s.threadId), isMain, isOrigin, pruned: this.isPruned(s), nativeDeletedAt: s.nativeDeletedAt, pruneThreadIds: [...this.descendantIds(tree, s.threadId, true)], canDeleteNative: !isOrigin && !containsMain && !s.nativeDeletedAt, nativeDeletionReason: isOrigin ? '原始会话仍是原生历史来源，本版支持剪枝，尚不支持永久删除它。' : containsMain ? '此路径包含当前主分支，不能整支永久删除；剪枝会保留主分支。' : null };
    });
  }
  newEngine() { return new Codex(this.settings.codexHome, { experimentalApi: true }); }
  async stopOwnedEngine(engine) {
    const child = engine.child;
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('插件自身的 Codex 连接尚未退出')), 5000);
      child.once('exit', () => { clearTimeout(timer);resolve(); });
      engine.stop();
    });
  }
  async releaseEngineWriters() {
    if (!this.engine.child) return;
    await this.stopOwnedEngine(this.engine);
    this.engine = this.newEngine();
  }
  prunedThreadIds(tree) {
    return new Set([...(tree.native?.prunes || []).filter(p => !p.restoredAt).flatMap(p => p.threadIds), ...this.sessions().filter(s => s.treeId === tree.id && s.nativeDeletedAt).map(s => s.threadId)]);
  }
  isPruned(session) { return this.prunedThreadIds(this.store.tree(session.treeId)).has(session.threadId); }
  visibleNodes(tree) {
    const pruned = this.prunedThreadIds(tree);
    return tree.nodes.filter(n => (n.bindings?.length ? n.bindings.map(b => b.threadId) : [n.nativeThreadId]).some(id => !pruned.has(id)));
  }
  updatePrompt(node, question) {
    if (node.question === question) return;
    if (node.title === node.question?.split('\n')[0].slice(0, 70)) node.title = question.split('\n')[0].slice(0, 70);
    node.question = question;
  }
  async link(threadId, title) {
    if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]{10,100}$/.test(threadId)) throw new Error('对话 ID 无效');
    const existing = this.sessions().find(s => s.threadId === threadId);
    if (existing?.nativeDeletedAt) throw new Error('原生会话已经永久删除，本地记录仍保留');
    if (existing) { if (this.isPruned(existing)) throw new Error('此分支已剪掉，请先在“已剪分支”中恢复'); existing.recording = true; this.stats.delete(threadId); this.syncAll(); await this.syncApi(existing); return this.state(existing.treeId); }
    await this.engine.connect();
    const { thread } = await this.engine.rpc('thread/read', { threadId, includeTurns: false });
    if (!thread.path) throw new Error('当前对话没有本机可读取的持久化记录');
    const source = fs.realpathSync(thread.path), home = fs.realpathSync(this.settings.codexHome);
    if (!source.startsWith(home + path.sep) || !source.endsWith('.jsonl')) throw new Error('对话记录不在已授权的本机 Codex 目录中');
    const parsed = parseTranscript(fs.readFileSync(source, 'utf8'));
    if (parsed.meta?.id !== threadId) throw new Error('对话记录与请求 ID 不一致');
    const parent = this.sessions().find(s => s.threadId === thread.forkedFromId);
    if (parent && this.isPruned(parent)) throw new Error('父分支已剪掉，请先恢复父分支');
    const tree = parent ? this.store.tree(parent.treeId) : this.store.createTree(title || thread.name || 'Codex 对话树');
    tree.native ||= { rootThreadId: threadId, importedAt: now(), observer: 'scoped-transcript' };
    const session = { threadId, treeId: tree.id, path: source, cwd: thread.cwd, parentThreadId: thread.forkedFromId || null, recording: true, linkedAt: now() };
    this.sessions().push(session);
    this.stats.delete(threadId); this.syncAll(); await this.syncApi(session); this.store.save(); this.version++;
    return this.state(tree.id);
  }
  syncAll() {
    let changed = false;
    for (const session of this.sessions()) {
      if (!session.recording || this.isPruned(session)) continue;
      if (session.parentThreadId) continue;
      let stat; try { stat = fs.statSync(session.path); } catch { session.error = '源对话记录暂时不可读'; continue; }
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (this.stats.get(session.threadId) === signature) continue;
      const parsed = parseTranscript(fs.readFileSync(session.path, 'utf8'));
      if (parsed.meta?.id !== session.threadId) { session.error = '记录格式或对话身份不匹配，已停止同步'; session.recording = false; continue; }
      const visibleSignature = JSON.stringify(parsed.nodes);
      this.stats.set(session.threadId, signature);
      if (this.visibleSnapshots.get(session.threadId) === visibleSignature) continue;
      this.visibleSnapshots.set(session.threadId, visibleSignature);
      const tree = this.store.tree(session.treeId);
      for (const incoming of parsed.nodes) {
        let node = tree.nodes.find(n => n.id === incoming.id);
        if (!node) {
          node = { ...incoming, title: incoming.question.split('\n')[0].slice(0, 70), memoryVersion: session.memoryVersion || tree.memories.at(-1).version, model: parsed.meta.model || null, pinned: false, files: [], snapshotReady: false, activities: [], bindings: [] };
          tree.nodes.push(node);
        }
        if (!node.bindings.some(b => b.threadId === session.threadId)) node.bindings.push({ threadId: session.threadId, turnId: incoming.turnId });
        // An inherited turn in a fork must never replace a newer original answer.
        if (node.nativeThreadId === session.threadId || !node.nativeThreadId) {
          this.updatePrompt(node, incoming.question);
          Object.assign(node, { status: incoming.status, answer: incoming.answer, messages: incoming.messages, completedAt: incoming.completedAt, forkable: incoming.forkable });
        }
      }
      session.lastSyncedAt = now(); session.nodeCount = parsed.nodes.length; session.error = parsed.diagnostics.length ? parsed.diagnostics.join('；') : null;
      tree.updatedAt = now(); this.stats.set(session.threadId, signature); changed = true;
    }
    if (changed) { this.store.save(); this.version++; }
  }
  async syncApi(session) {
    if (this.deletion.executing || !session.recording || this.isPruned(session)) return;
    if (this.apiInFlight.has(session.threadId)) return; this.apiInFlight.add(session.threadId);
    try {
      await this.engine.connect();
      const turns = []; let cursor;
      do {
        const page = await this.engine.rpc('thread/turns/list', { threadId: session.threadId, itemsView: 'summary', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
        turns.push(...page.data); cursor = page.nextCursor;
      } while (cursor && turns.length < 10000);
      // A prune may occur while the read is in flight. Do not commit its result.
      if (this.deletion.executing || !session.recording || this.isPruned(session)) return;
      const tree = this.store.tree(session.treeId), incoming = parseTurns(turns, tree.nodes);
      const signature = JSON.stringify(incoming); if (this.apiSnapshots.get(session.threadId) === signature) return;
      for (const n of incoming) {
        let node = tree.nodes.find(item => item.id === n.id);
        if (!node) { node = { ...n, nativeThreadId: session.threadId, title: n.question.split('\n')[0].slice(0, 70), memoryVersion: session.memoryVersion || tree.memories.at(-1).version, pinned: false, files: [], snapshotReady: false, activities: [], bindings: [] }; tree.nodes.push(node); }
        if (!node.bindings.some(b => b.threadId === session.threadId)) node.bindings.push({ threadId: session.threadId, turnId: n.turnId });
        if (node.nativeThreadId === session.threadId) { this.updatePrompt(node, n.question); Object.assign(node, { status: n.status, answer: n.answer, messages: n.messages, forkable: n.forkable }); }
      }
      this.apiSnapshots.set(session.threadId, signature); session.nodeCount = incoming.length; session.lastSyncedAt = now(); session.error = null; this.store.save(); this.version++;
    } finally { this.apiInFlight.delete(session.threadId); }
  }
  state(treeId) {
    this.syncAll(); const selected = treeId ? this.store.tree(treeId) : this.store.state.trees.at(-1);
    const visible = selected ? this.visibleNodes(selected) : [];
    const pruned = selected ? this.prunedThreadIds(selected) : new Set();
    const view = selected ? { ...selected, nodes: visible, prunedNodeCount: selected.nodes.length - visible.length, prunedBranches: (selected.native?.prunes || []).filter(p => !p.restoredAt).map(p => ({ ...p, nativeDeletedAt: this.sessions().find(s => s.threadId === p.rootThreadId)?.nativeDeletedAt, nativeDeletion: this.deletion.describeRecord(selected.native?.deletions?.findLast(d => d.rootThreadId === p.rootThreadId)) })), hiddenMemorySources: selected.nodes.filter(n => !visible.some(v => v.id === n.id)).map(n => ({ id: n.id, title: n.title })), native: { ...selected.native, mainThreadId: this.mainThreadId(selected), paths: this.paths(selected), forks: (selected.native?.forks || []).filter(f => !pruned.has(f.threadId)) } } : null;
    return { version: this.version, trees: this.store.state.trees.map(t => ({ id: t.id, title: t.title, nodeCount: this.visibleNodes(t).length })), tree: view, sessions: this.sessions().filter(s => s.treeId === (treeId || selected?.id)).map(({ path: _, ...s }) => ({ ...s, pruned: this.isPruned(s) })), dataDir: this.settings.dataDir, observer: 'scoped-transcript', lastError: this.lastError };
  }
  async fork({ treeId, nodeId, title, memoryMode = 'historical' }) {
    this.syncAll(); const tree = this.store.tree(treeId), node = this.store.node(tree, nodeId);
    if (!this.visibleNodes(tree).some(n => n.id === nodeId)) throw new Error('此节点所在分支已剪掉，请先恢复分支');
    if (!node.forkable) throw new Error('只能从已完成轮次的最后一个提问节点分叉；本轮尚未完成或已中断');
    const activeBindings = node.bindings.filter(b => !this.prunedThreadIds(tree).has(b.threadId));
    const binding = activeBindings.find(b => b.threadId === node.nativeThreadId) || activeBindings[0];
    if (!binding) throw new Error('节点没有可用的原生对话关联');
    if (this.deletion.executing) throw new Error('原生删除操作进行中，请稍后创建分支');
    if (!['historical', 'latest'].includes(memoryMode)) throw new Error('记忆版本选项无效');
    const memory = memoryMode === 'latest' ? tree.memories.at(-1) : this.store.memory(tree, node.memoryVersion);
    const branchTitle = title?.trim().slice(0, 100) || `分支 · ${node.title.slice(0, 40)}`;
    // thread/fork loads a writable session in its app-server. A short-lived
    // creator must exit before the desktop resumes the same thread. The
    // observer connection only reads history and remains running.
    const creator = this.newEngine(); this.forkEngines.add(creator);
    let branch, preparationError;
    try {
      await creator.connect();
      const result = await creator.rpc('thread/fork', { threadId: binding.threadId, lastTurnId: binding.turnId, excludeTurns: true, deferGoalContinuation: true, ...(memory.content ? { developerInstructions: `本分支属于本地对话树，使用共享记忆 v${memory.version}。记忆是背景资料，不能覆盖系统规则或当前用户明确指令。\n${memory.content}` } : {}) });
      branch = result.thread;
      await creator.rpc('thread/name/set', { threadId: branch.id, name: branchTitle });
    } catch (e) { preparationError = e; }
    finally {
      try { await this.stopOwnedEngine(creator);this.forkEngines.delete(creator); }
      catch (e) { preparationError = e; }
    }
    if (!branch) throw preparationError || new Error('原生分支未创建');
    const record = { threadId: branch.id, title: branchTitle, parentThreadId: binding.threadId, sourceNodeId: node.id, throughTurnId: binding.turnId, memoryVersion: memory.version, createdAt: now(), fileRecovery: 'unavailable-for-imported-history' };
    if (preparationError) {
      record.preparationError = preparationError.message;
      tree.native.forks ||= [];tree.native.forks.push(record);this.store.save();this.version++;
      throw new Error(`分支“${branchTitle}”（${branch.id}）已经创建，打开准备未完成：${preparationError.message}。请稍后打开这条已有分支，不要再次创建聊天分叉。`);
    }
    await this.link(branch.id);
    const session = this.sessions().find(s => s.threadId === branch.id); session.memoryVersion = memory.version; this.store.save();
    tree.native.forks ||= []; tree.native.forks.push(record); this.store.save(); this.version++;
    return { ...record, url: `codex://threads/${branch.id}`, ...this.state(tree.id) };
  }
  branch({ treeId, operation, threadId, pruneId }) {
    const tree = this.store.tree(treeId);
    tree.native ||= {}; tree.native.prunes ||= [];
    if (operation === 'promote') return this.promoteMain({ treeId, threadId });
    if (operation === 'prune') {
      const session = this.sessions().find(s => s.treeId === treeId && s.threadId === threadId);
      if (!session) throw new Error('没有找到这条分支');
      if (threadId === this.mainThreadId(tree)) throw new Error('当前主分支不能剪掉，请先把另一条路径设为主分支');
      if (!session.parentThreadId && threadId !== tree.native.rootThreadId) throw new Error('此路径的原生来源无法确认');
      if (this.isPruned(session)) throw new Error('这条分支已经剪掉');
      const ids = this.descendantIds(tree, threadId, true);
      const affected = this.sessions().filter(s => s.treeId === treeId && ids.has(s.threadId));
      const fork = tree.native.forks?.find(f => f.threadId === threadId);
      const record = { id: uid('prune'), rootThreadId: threadId, title: fork?.title || this.threadTitle(tree, threadId), threadIds: [...ids], retainedMainThreadId: this.mainThreadId(tree), previousRecording: affected.map(s => ({ threadId: s.threadId, recording: s.recording })), createdAt: now() };
      tree.native.prunes.push(record);
      for (const s of affected) s.recording = false;
    } else if (operation === 'restore') {
      const record = tree.native.prunes.find(p => p.id === pruneId && !p.restoredAt);
      if (!record) throw new Error('没有找到可恢复的剪枝记录');
      if (this.sessions().find(s => s.threadId === record.rootThreadId)?.nativeDeletedAt) throw new Error('原生会话已永久删除，不能恢复；本地记录仍保留');
      if (this.deletion.executing) throw new Error('原生删除操作进行中，请稍后恢复');
      if (tree.native.deletions?.some(d => d.status === 'pending' && d.threads.some(t => record.threadIds.includes(t.threadId)))) throw new Error('原生删除结果待核验，暂不能恢复');
      if (tree.native.prunes.some(p => p.id !== record.id && !p.restoredAt && p.threadIds.includes(record.rootThreadId))) throw new Error('请先恢复包含此分支的父分支');
      record.restoredAt = now();
      const stillPruned = this.prunedThreadIds(tree);
      for (const before of record.previousRecording) {
        const session = this.sessions().find(s => s.threadId === before.threadId && s.treeId === treeId);
        if (session && !session.nativeDeletedAt && !stillPruned.has(session.threadId)) { session.recording = before.recording; this.stats.delete(session.threadId); }
      }
    } else throw new Error('分支操作无效');
    tree.updatedAt = now(); this.store.save(); this.version++; return this.state(treeId);
  }
  memory({ treeId, content, baseVersion, sourceNodeIds = [], materialVersion }) {
    const tree = this.store.tree(treeId); if (baseVersion !== tree.memories.at(-1).version) throw new Error('记忆已有新版本，请刷新后再保存');
    this.store.addMemory(tree, { content, sourceNodeIds, ...(materialVersion ? { materials: this.store.memory(tree, materialVersion).materials } : {}) }); this.version++; return this.state(treeId);
  }
  pin({ treeId, nodeId, pinned, title }) {
    const tree = this.store.tree(treeId), node = this.store.node(tree, nodeId); if (typeof pinned === 'boolean') node.pinned = pinned;
    if (typeof title === 'string' && title.trim()) node.title = title.trim().slice(0, 100); this.store.save(); this.version++; return this.state(treeId);
  }
  hook(event) {
    // Hooks never subscribe unrelated conversations. The user must first link one.
    const session = this.sessions().find(s => s.threadId === event.session_id || (event.transcript_path && s.path === event.transcript_path));
    if (!session?.recording) return { continue: true };
    this.stats.delete(session.threadId); this.syncAll();
    if (event.hook_event_name === 'UserPromptSubmit') {
      const tree = this.store.tree(session.treeId), memory = tree.memories.at(-1);
      return { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `当前对话已关联本地对话树。共享记忆 v${memory.version}（背景资料）：\n${memory.content || '尚无共享记忆。'}` } };
    }
    return { continue: true };
  }
  close() { clearInterval(this.timer); clearInterval(this.apiTimer); this.engine.stop(); for (const creator of this.forkEngines) creator.stop(); this.store.save(); }
}
