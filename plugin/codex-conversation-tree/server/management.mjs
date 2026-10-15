import { now } from './store.mjs';

// A stopped app-server, a timeout, or an unloaded thread is not evidence of deletion.
export const missingThread = error => /no rollout found|(?:thread|conversation)[^\n]*(?:not found|does not exist|was deleted)|(?:cannot|could not) find (?:thread|conversation)|unknown thread/i.test(error.message || '');
export function displayTitle(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('名称不能为空');
  if (Array.from(value.trim()).length > 100) throw new Error('名称最多 100 个字');
  return value.trim();
}

export class TreeManagement {
  constructor(native) { this.native = native; }
  activeTree(id) {
    const tree = this.native.store.tree(id);
    if (tree.deletedAt) throw new Error('这棵对话树已删除，请先在“管理对话树”中恢复');
    return tree;
  }
  summary(tree, contextTreeId) {
    const sessions = this.native.sessions().filter(s => s.treeId === tree.id);
    const missing = sessions.length > 0 && sessions.every(s => s.nativeDeletedAt || s.sourceStatus === 'missing');
    return { id: tree.id, title: tree.title, nodeCount: this.native.visibleNodes(tree).length, memoryCount: tree.memories.length, updatedAt: tree.updatedAt, deletedAt: tree.deletedAt || null, sourceStatus: missing ? 'missing' : sessions.some(s => !s.nativeDeletedAt && s.sourceStatus === 'available') ? 'available' : 'unknown', isContext: tree.id === contextTreeId };
  }
  selection(treeId, threadId) {
    const all = this.native.store.state.trees;
    const contextSession = threadId ? this.native.sessions().find(s => s.threadId === threadId) : null;
    const own = contextSession && all.find(t => t.id === contextSession.treeId);
    const context = { threadId: threadId || null, treeId: own?.id || null, title: own?.title || null, status: !threadId ? 'none' : !own ? 'unlinked' : own.deletedAt ? 'deleted' : 'linked' };
    const catalog = all.map(t => this.summary(t, own?.id)).sort((a,b) => Number(b.isContext)-Number(a.isContext) || b.updatedAt.localeCompare(a.updatedAt));
    const trees = catalog.filter(t => !t.deletedAt && t.sourceStatus !== 'missing');
    const candidate = treeId ? all.find(t => t.id === treeId) : threadId ? own : all.find(t => t.id === trees[0]?.id);
    const selected = candidate && !candidate.deletedAt ? candidate : null;
    return { selected, context, trees, catalog };
  }
  async manage({ treeId, operation, title, viewTreeId, contextThreadId }) {
    const api = this.native;
    if (operation === 'check_sources') {
      const sourceCheck = await this.checkSources(treeId);
      return { ...api.state(viewTreeId, { threadId: contextThreadId }), sourceCheck };
    }
    const tree = api.store.tree(treeId);
    if (operation === 'rename') {
      this.activeTree(treeId);tree.title = displayTitle(title);tree.updatedAt = now();
    } else if (operation === 'delete') {
      if (api.deletion.executing || tree.native?.deletions?.some(d => d.status === 'pending')) throw new Error('原生删除进行中或结果待核验，请稍后再删除对话树');
      if (api.forkingTrees.get(treeId)) throw new Error('正在创建原生分支，请等待创建完成后再删除对话树');
      if (!tree.deletedAt) {
        tree.deletedAt = now();
        tree.deletedPreviousRecording = api.sessions().filter(s => s.treeId === treeId).map(s => ({ threadId: s.threadId, recording: s.recording }));
        for (const s of api.sessions().filter(s => s.treeId === treeId)) s.recording = false;
      }
    } else if (operation === 'restore') {
      if (!tree.deletedAt) throw new Error('这棵树没有被删除');
      delete tree.deletedAt;
      for (const before of tree.deletedPreviousRecording || []) {
        const s = api.sessions().find(s => s.treeId === treeId && s.threadId === before.threadId);
        if (s && !api.isPruned(s) && !s.nativeDeletedAt && s.sourceStatus !== 'missing') s.recording = before.recording;
        if (s) { api.stats.delete(s.threadId);api.apiSnapshots.delete(s.threadId); }
      }
      delete tree.deletedPreviousRecording;tree.updatedAt = now();
    } else throw new Error('对话树操作无效');
    api.store.save();api.version++;
    return api.state(viewTreeId === treeId && operation === 'delete' ? undefined : viewTreeId, { threadId: contextThreadId });
  }
  setSource(session, status, error = null) {
    const api = this.native, tree = api.store.tree(session.treeId);
    if (session.nativeDeletedAt) return;
    const previous = session.sourceStatus;
    if (status === 'missing' && previous !== 'missing') {
      session.recordingBeforeMissing = tree.deletedAt ? tree.deletedPreviousRecording?.find(s => s.threadId === session.threadId)?.recording : session.recording;
      session.sourceMissingAt = now();session.recording = false;
    }
    if (status === 'available' && previous === 'missing') {
      if (!tree.deletedAt && !api.isPruned(session)) session.recording = Boolean(session.recordingBeforeMissing);
      delete session.recordingBeforeMissing;delete session.sourceMissingAt;
      api.stats.delete(session.threadId);api.apiSnapshots.delete(session.threadId);
    }
    session.sourceStatus = status;session.sourceCheckedAt = now();session.sourceCheckError = error;
    api.store.save();api.version++;
  }
  async probe(session) {
    if (session.nativeDeletedAt) return;
    try {
      const result = await this.native.engine.rpc('thread/read', { threadId: session.threadId, includeTurns: false }, 7000);
      if (result.thread?.id !== session.threadId) throw new Error('原生会话身份无法确认');
      this.setSource(session, 'available');
    } catch (error) {
      this.setSource(session, missingThread(error) ? 'missing' : session.sourceStatus === 'missing' ? 'missing' : 'unknown', error.message);
    }
  }
  async checkSources(treeId) {
    if (this.checking) throw new Error('正在检查原生会话状态，请稍后再试');
    const api = this.native;
    const sessions = api.sessions().filter(s => !s.nativeDeletedAt && (!treeId || s.treeId === treeId)).sort((a,b) => (a.sourceCheckedAt || '').localeCompare(b.sourceCheckedAt || ''));
    if (treeId) api.store.tree(treeId);
    this.checking = true;let checked = 0;
    try {
      await api.engine.connect();
      const deadline = Date.now()+20000, queue = [...sessions];
      await Promise.all(Array.from({ length: Math.min(3,queue.length) }, async() => {
        while (queue.length && Date.now() < deadline) { const session = queue.shift();await this.probe(session);checked++; }
      }));
    } catch (error) {
      for (const session of sessions) this.setSource(session, session.sourceStatus === 'missing' ? 'missing' : 'unknown', error.message);
    } finally { this.checking = false; }
    return { checked, total: sessions.length, remaining: sessions.length-checked };
  }
}
