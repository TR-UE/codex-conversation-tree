import { now, uid } from './store.mjs';
import { scanHistoryMetadata } from './history-metadata.mjs';

const CONFIRMATION = '删除原生会话';
const parentOf = thread => thread.parentThreadId || thread.source?.subAgent?.thread_spawn?.parent_thread_id;
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

export function explainDeletionFailure(message = '') {
  if (/already has an active writer/i.test(message)) return '会话仍被 Codex 占用。请在 Codex 中关闭或归档对应对话，释放占用后重新预览删除；反复点击不会解除占用。';
  if (/forked history still references it/i.test(message)) return '仍有其他原生分支引用此会话的历史。请重新预览完整子分支范围；范围之外的引用会阻止删除。';
  return message;
}

export class NativeDeletion {
  constructor(native) { this.native = native; this.plans = new Map(); this.executing = false; }
  describeRecord(record) { return record ? { ...record, errors: record.errors.map(e => ({ ...e, reason: explainDeletionFailure(e.message) })) } : undefined; }
  branchSessions(tree, threadId) {
    this.native.activeTree(tree.id);
    const all = this.native.sessions().filter(s => s.treeId === tree.id);
    const root = all.find(s => s.threadId === threadId);
    if (threadId === this.native.mainThreadId(tree)) throw new Error('当前主分支不能永久删除，请先切换主分支');
    if (tree.native?.rootThreadId === threadId) throw new Error('原始会话仍是原生历史来源，本版支持剪枝，尚不支持永久删除它');
    if (!root || !root.parentThreadId) throw new Error('只能删除已关联的原生分支');
    if (root.nativeDeletedAt) throw new Error('此分支的原生会话已经删除');
    const ids = new Set([threadId]); let changed = true;
    while (changed) { changed = false; for (const s of all) if (ids.has(s.parentThreadId) && !ids.has(s.threadId)) { ids.add(s.threadId); changed = true; } }
    if (ids.has(this.native.mainThreadId(tree))) throw new Error('删除范围包含当前主分支，不能整支永久删除；可剪枝并保留主分支');
    return all.filter(s => ids.has(s.threadId) && !s.nativeDeletedAt);
  }
  async scope(treeId, threadId) {
    const tree = this.native.store.tree(treeId), sessions = this.branchSessions(tree, threadId);
    await this.native.engine.connect();
    const metadata = await scanHistoryMetadata(this.native.settings.codexHome);
    const family = new Map(sessions.map(s => [s.threadId, { threadId: s.threadId, parentThreadId: s.parentThreadId, forkedFromId: s.parentThreadId }]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of metadata.values()) if (!family.has(entry.threadId) && family.has(entry.parentThreadId)) { family.set(entry.threadId, entry);changed = true; }
      if (family.size > 1000) throw new Error('子会话数量过多，暂不执行整支删除');
    }
    // Native fork lineage determines the subtree. A history reference alone
    // does not authorize adding another tree or sibling to deletion.
    for (const entry of metadata.values()) if (family.has(entry.historyBaseId) && !family.has(entry.threadId)) {
      const { thread: other } = await this.native.engine.rpc('thread/read', { threadId: entry.threadId, includeTurns: false });
      throw new Error(`删除范围之外的会话“${other.name || entry.threadId}”仍引用此分支的历史，未执行删除。请先单独处理该引用。`);
    }
    const threads = new Map(), rootIds = [...family.values()].filter(s => s.threadId === threadId || s.forkedFromId).map(s => s.threadId);
    for (const id of rootIds) {
      const { thread } = await this.native.engine.rpc('thread/read', { threadId: id, includeTurns: false });
      if (thread.ephemeral || !thread.path) throw new Error('此会话没有可永久删除的本机记录');
      if (thread.forkedFromId && family.get(id)?.parentThreadId !== thread.forkedFromId) throw new Error('原生分叉来源发生变化，未执行删除');
      threads.set(id, { threadId: id, title: thread.name || tree.native?.forks?.find(f => f.threadId === id)?.title || `分支 · ${id.slice(0, 8)}`, coveredBy: [id] });
      const descendants = [];
      for (const archived of [false, true]) {
        let cursor;
        do {
          const page = await this.native.engine.rpc('thread/list', { ancestorThreadId: id, archived, sourceKinds, limit: 100, ...(cursor ? { cursor } : {}) });
          descendants.push(...page.data); cursor = page.nextCursor;
          if (descendants.length > 1000) throw new Error('子会话数量过多，暂不执行整支删除');
        } while (cursor);
      }
      // Reject an ignored filter rather than accepting unrelated threads.
      const parents = new Map(descendants.map(t => [t.id, parentOf(t)]));
      for (const child of descendants) {
        if (child.id === id) continue;
        let parent = parentOf(child); const seen = new Set([child.id]);
        while (parent && parent !== id && !seen.has(parent)) { seen.add(parent); parent = parents.get(parent); }
        if (parent !== id) throw new Error('Codex 返回的子会话范围无法确认，未执行删除');
        const old = threads.get(child.id);
        threads.set(child.id, { threadId: child.id, title: child.name || `子会话 · ${child.id.slice(0, 8)}`, coveredBy: [...new Set([...(old?.coveredBy || []), id])] });
      }
    }
    // Include empty spawned children as well; the public list may omit them.
    for (const entry of family.values()) if (!threads.has(entry.threadId)) {
      let parent = entry.parentThreadId;const seen = new Set([entry.threadId]);
      while (parent && !rootIds.includes(parent) && !seen.has(parent)) { seen.add(parent);parent = family.get(parent)?.parentThreadId; }
      if (!parent || !rootIds.includes(parent)) throw new Error('子会话的删除归属无法确认，未执行删除');
      const { thread } = await this.native.engine.rpc('thread/read', { threadId: entry.threadId, includeTurns: false });
      threads.set(entry.threadId, { threadId: entry.threadId, title: thread.name || `子会话 · ${entry.threadId.slice(0, 8)}`, coveredBy: [parent] });
    }
    for (const entry of threads.values()) {
      if (this.native.store.state.trees.some(t => t.native?.rootThreadId === entry.threadId || this.native.mainThreadId(t) === entry.threadId)) throw new Error('删除范围包含受保护的主分支或历史来源，未执行删除');
      const { thread } = await this.native.engine.rpc('thread/read', { threadId: entry.threadId, includeTurns: false });
      if (thread.status?.type === 'active') throw new Error('删除范围内有会话正在运行，请等该轮结束后再操作');
      const turns = await this.native.engine.rpc('thread/turns/list', { threadId: entry.threadId, itemsView: 'notLoaded', sortDirection: 'desc', limit: 1 });
      if (turns.data.some(t => t.status === 'inProgress')) throw new Error('删除范围内有会话正在运行，请等该轮结束后再操作');
    }
    const linkedIds = new Set(rootIds);
    const nodeCount = tree.nodes.filter(n => (n.bindings?.length ? n.bindings.map(b => b.threadId) : [n.nativeThreadId]).every(id => linkedIds.has(id))).length;
    // Forks are deleted separately; spawned descendants are covered by Codex.
    const depth = id => { let d = 0, s = family.get(id); const seen = new Set(); while (s && s.threadId !== threadId && !seen.has(s.threadId)) { seen.add(s.threadId); d++; s = family.get(s.parentThreadId); } return d; };
    return { treeId, rootThreadId: threadId, rootIds: rootIds.sort((a, b) => depth(b) - depth(a)), threads: [...threads.values()].sort((a, b) => a.threadId.localeCompare(b.threadId)), nodeCount };
  }
  async preview({ treeId, threadId }) {
    if (this.executing) throw new Error('已有原生删除操作进行中');
    const scope = await this.scope(treeId, threadId), planId = uid('delete_plan'), expiresAt = Date.now() + 5 * 60 * 1000;
    for (const [id, p] of this.plans) if (p.expiresAt < Date.now()) this.plans.delete(id);
    this.plans.set(planId, { ...scope, expiresAt });
    return { planId, treeId, rootThreadId: threadId, expiresAt, nodeCount: scope.nodeCount, threads: scope.threads.map(({ coveredBy: _, ...t }) => t), confirmationText: CONFIRMATION };
  }
  async execute({ treeId, threadId, planId, confirmation }) {
    if (confirmation !== CONFIRMATION) throw new Error('必须明确确认永久删除原生会话');
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt < Date.now() || plan.treeId !== treeId || plan.rootThreadId !== threadId) throw new Error('删除确认已过期或范围不匹配，请重新预览');
    if (this.executing) throw new Error('已有原生删除操作进行中');
    this.executing = true; this.plans.delete(planId);
    try {
      // This plugin never starts model turns. Restart only its own CLI
      // connection to release idle writers retained by earlier thread/fork.
      // Do not interfere with the desktop's processes or file locks.
      await this.native.releaseEngineWriters();
      const current = await this.scope(treeId, threadId);
      if (JSON.stringify(current.threads.map(t => t.threadId)) !== JSON.stringify(plan.threads.map(t => t.threadId)) || JSON.stringify(current.rootIds) !== JSON.stringify(plan.rootIds)) throw new Error('分支范围发生变化，请重新查看并确认');
      const tree = this.native.store.tree(treeId);
      if (!this.native.isPruned(this.native.sessions().find(s => s.threadId === threadId))) this.native.branch({ treeId, operation: 'prune', threadId });
      const record = { id: uid('native_delete'), rootThreadId: threadId, threads: plan.threads.map(({ coveredBy: _, ...t }) => t), startedAt: now(), status: 'pending', deletedThreadIds: [], errors: [] };
      tree.native.deletions ||= []; tree.native.deletions.push(record); this.native.store.save();
      for (const id of plan.rootIds) {
        try {
          await this.native.engine.rpc('thread/delete', { threadId: id });
          const deleted = plan.threads.filter(t => t.coveredBy.includes(id)).map(t => t.threadId);
          record.deletedThreadIds = [...new Set([...record.deletedThreadIds, ...deleted])];
          for (const session of this.native.sessions()) if (deleted.includes(session.threadId)) { session.nativeDeletedAt = now(); session.recording = false; }
          this.native.store.save();
        } catch (e) { record.errors.push({ threadId: id, message: e.message, reason: explainDeletionFailure(e.message) }); break; }
      }
      record.status = record.errors.length ? record.deletedThreadIds.length ? 'partial' : 'failed' : 'completed';
      record.completedAt = now(); tree.updatedAt = now(); this.native.store.save(); this.native.version++;
      return { ...this.native.state(treeId), deletionResult: this.describeRecord(record) };
    } finally { this.executing = false; }
  }
}
