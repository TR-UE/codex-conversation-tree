import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript, parseTurns } from '../plugin/codex-conversation-tree/server/transcript.mjs';
import { NativeTree } from '../plugin/codex-conversation-tree/server/native.mjs';

const record = (type, payload) => JSON.stringify({ type, payload, timestamp: '2026-10-14T12:00:00Z' });
const user = (id, turn, text, kinds = ['user.text']) => record('response_item', { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: kinds } });
const answer = (turn, text) => record('response_item', { type: 'message', id: 'a-' + turn, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn } });
const complete = turn => record('event_msg', { type: 'task_complete', turn_id: turn });
const meta = id => record('session_meta', { id, cwd: '/tmp/test-cwd', cli_version: '0.162.1' });

test('only actual user prompts and visible answers become nodes', () => {
  const text = [meta('test-session'), user('instruction', 't1', 'private instructions', ['agents_md.instructions']), record('response_item', { type: 'reasoning', text: 'hidden reasoning' }), user('u1', 't1', 'real question'), answer('t1', 'visible answer'), complete('t1'), record('response_item', { type: 'function_call', arguments: 'secret-tool-argument' })].join('\n');
  const parsed = parseTranscript(text);
  assert.equal(parsed.nodes.length, 1); assert.equal(parsed.nodes[0].question, 'real question'); assert.equal(parsed.nodes[0].answer, 'visible answer'); assert.equal(parsed.nodes[0].forkable, true);
  assert.doesNotMatch(JSON.stringify(parsed.nodes), /private instructions|hidden reasoning|secret-tool-argument/);
});
test('a legacy fork keeps its first session header when copied history contains parent metadata', () => {
  const parsed=parseTranscript([meta('fork'),meta('parent'),user('u1','t1','shared history'),complete('t1')].join('\n'));
  assert.equal(parsed.meta.id,'fork');assert.equal(parsed.nodes[0].nativeThreadId,'fork');
});
test('ambient browser metadata is excluded from the actual question and shared prefix matching', () => {
  const raw='<in-app-browser-context source="ambient-ui-state">\nAutomatically supplied browser context.\n</in-app-browser-context>\n\n## My request:\nCan I prune this branch?';
  const parsed=parseTranscript([meta('test'),user('u1','t1',raw),complete('t1')].join('\n'));
  assert.equal(parsed.nodes[0].question,'Can I prune this branch?');
  const existing=[{...parsed.nodes[0],question:raw}];
  const fork=parseTurns([{id:'t1',status:'completed',items:[{type:'userMessage',id:'wire',content:[{type:'text',text:raw}]}]}],existing);
  assert.equal(fork[0].id,parsed.nodes[0].id);assert.equal(fork[0].question,'Can I prune this branch?');
});
test('interrupted rounds and additional prompts preserve their correct fork boundary', () => {
  const parsed = parseTranscript([meta('test'), user('u1', 't1', 'first'), user('u2', 't1', 'steering'), answer('t1', 'done'), complete('t1'), user('u3', 't2', 'stopped'), record('event_msg', { type: 'turn_aborted', turn_id: 't2' })].join('\n'));
  assert.equal(parsed.nodes.length, 3); assert.equal(parsed.nodes[0].forkable, false); assert.equal(parsed.nodes[1].forkable, true); assert.equal(parsed.nodes[2].status, 'interrupted'); assert.equal(parsed.nodes[2].forkable, false); assert.equal(parsed.nodes[1].parentId, parsed.nodes[0].id);
});
test('paginated fork history reuses shared nodes even when native item IDs differ', () => {
  const old = parseTranscript([meta('parent'), user('msg_old', 't1', 'question'), answer('t1', 'answer'), complete('t1')].join('\n')).nodes;
  const fork = parseTurns([{ id: 't1', status: 'completed', items: [{ type: 'userMessage', id: 'new_wire_id', content: [{ type: 'text', text: 'question' }] }, { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'answer' }, { type: 'reasoning', text: 'never save' }] }], old);
  assert.equal(fork[0].id, old[0].id); assert.equal(fork[0].answer, 'answer'); assert.doesNotMatch(JSON.stringify(fork), /never save/);
});
test('identical repeated prompts in one turn remain separate shared nodes', () => {
  const old = parseTranscript([meta('parent'), user('u1', 't1', 'continue'), user('u2', 't1', 'continue'), complete('t1')].join('\n')).nodes;
  const parsed = parseTurns([{ id: 't1', status: 'completed', items: ['wire1', 'wire2'].map(id => ({ type: 'userMessage', id, content: [{ type: 'text', text: 'continue' }] })) }], old);
  assert.equal(parsed.length, 2); assert.notEqual(parsed[0].id, parsed[1].id); assert.equal(parsed[1].id, old[1].id); assert.equal(parsed[1].parentId, parsed[0].id);
});
test('automatic observer detects a new prompt and final answer without manual save', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tree-test-'));
  const source = path.join(tmp, 'source.jsonl'); fs.writeFileSync(source, [meta('native-test-session'), user('u1', 't1', 'first'), answer('t1', 'one'), complete('t1')].join('\n') + '\n');
  const native = new NativeTree({ dataDir: path.join(tmp, 'data'), codexHome: tmp, codexBinary: 'unused' }); t.after(() => { native.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const tree = native.store.createTree('Observer test'); native.sessions().push({ threadId: 'native-test-session', treeId: tree.id, path: source, recording: true });
  native.syncAll(); assert.equal(tree.nodes.length, 1);
  fs.appendFileSync(source, user('u2', 't2', 'second') + '\n');
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(tree.nodes.length, 2); assert.equal(tree.nodes[1].status, 'running');
  fs.appendFileSync(source, answer('t2', 'two') + '\n' + complete('t2') + '\n');
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(tree.nodes[1].answer, 'two'); assert.equal(tree.nodes[1].status, 'completed');
});
test('root sessions continue importing new turns when their old JSONL stops receiving messages', async t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tree-root-pagination-')),source=path.join(tmp,'old.jsonl');
  fs.writeFileSync(source,[meta('root-pagination-test'),user('old-item','old-turn','old question'),answer('old-turn','old answer'),complete('old-turn')].join('\n'));
  const native=new NativeTree({dataDir:path.join(tmp,'data'),codexHome:tmp,codexBinary:'unused'});clearInterval(native.timer);clearInterval(native.apiTimer);t.after(()=>{native.close();fs.rmSync(tmp,{recursive:true,force:true});});
  const tree=native.store.createTree('Root pagination');const session={threadId:'root-pagination-test',treeId:tree.id,path:source,recording:true};native.sessions().push(session);native.syncAll();
  native.engine.connect=async()=>{};native.engine.rpc=async()=>({data:[{id:'old-turn',status:'completed',items:[{type:'userMessage',id:'canonical-old',content:[{type:'text',text:'old question'}]},{type:'agentMessage',id:'old-answer',phase:'final_answer',text:'old answer'}]},{id:'new-turn',status:'completed',items:[{type:'userMessage',id:'new-item',content:[{type:'text',text:'new question'}]},{type:'agentMessage',id:'new-answer',phase:'final_answer',text:'new answer'}]}],nextCursor:null});
  await native.syncApi(session);native.syncAll();assert.equal(tree.nodes.length,2);assert.equal(tree.nodes[1].answer,'new answer');assert.equal(tree.nodes[1].parentId,tree.nodes[0].id);
});

function pruningFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pruning-test-'));
  const settings = { dataDir: path.join(tmp, 'data'), codexHome: tmp, codexBinary: 'unused' };
  const native = new NativeTree(settings); clearInterval(native.timer); clearInterval(native.apiTimer);
  const instances=[native];t.after(() => { for(const instance of instances)instance.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const tree = native.store.createTree('Pruning test');
  tree.native = { rootThreadId: 'root', forks: [
    { threadId: 'branch-a-test', parentThreadId: 'root', sourceNodeId: 'shared', title: 'Branch A' },
    { threadId: 'branch-b', parentThreadId: 'root', sourceNodeId: 'shared', title: 'Branch B' },
    { threadId: 'child-a', parentThreadId: 'branch-a-test', sourceNodeId: 'only-a', title: 'Child A' }
  ] };
  for (const [threadId, parentThreadId, recording] of [['root', null, false], ['branch-a-test','root',true], ['branch-b','root',true], ['child-a','branch-a-test',true]]) native.sessions().push({ threadId, parentThreadId, recording, treeId: tree.id });
  const makeNode = (id, owner, parentId, bindings) => ({ id, title: id, question: id, status: 'completed', nativeThreadId: owner, parentId, bindings: bindings.map(threadId => ({ threadId, turnId: id })), forkable: true });
  tree.nodes = [makeNode('shared','root',null,['root','branch-a-test','branch-b','child-a']), makeNode('only-a','branch-a-test','shared',['branch-a-test','child-a']), makeNode('only-b','branch-b','shared',['branch-b']), makeNode('only-child','child-a','only-a',['child-a'])];
  native.store.addMemory(tree,{ content:'Keep conclusion A', sourceNodeIds:['only-a'] });
  return { native, tree, settings, instances };
}
test('pruning removes only exclusive branch nodes and descendants, preserving siblings, shared history and memory', t => {
  const { native, tree } = pruningFixture(t), before = structuredClone(tree.memories);
  const pruned = native.branch({ treeId: tree.id, operation:'prune', threadId:'branch-a-test' });
  assert.deepEqual(pruned.tree.nodes.map(n => n.id),['shared','only-b']);
  assert.equal(pruned.tree.prunedNodeCount,2); assert.deepEqual(tree.memories,before);
  assert.equal(tree.nodes.length,4); assert.equal(pruned.tree.native.forks.length,1);
  assert.equal(native.sessions().find(s=>s.threadId==='branch-a-test').recording,false);
  assert.equal(native.sessions().find(s=>s.threadId==='child-a').recording,false);
  assert.equal(native.sessions().find(s=>s.threadId==='branch-b').recording,true);
  assert.throws(()=>native.branch({ treeId:tree.id,operation:'prune',threadId:'root' }),/主分支/);
});
test('nested pruning persists after restart and restoration respects independently pruned descendants', t => {
  const { native, tree, settings, instances } = pruningFixture(t);
  native.branch({ treeId:tree.id,operation:'prune',threadId:'child-a' });
  native.branch({ treeId:tree.id,operation:'prune',threadId:'branch-a-test' });
  native.close();
  const restarted=new NativeTree(settings);clearInterval(restarted.timer);clearInterval(restarted.apiTimer);instances.push(restarted);
  const [child,parent]=restarted.state(tree.id).tree.prunedBranches;
  assert.throws(()=>restarted.branch({ treeId:tree.id,operation:'restore',pruneId:child.id }),/父分支/);
  let view=restarted.branch({ treeId:tree.id,operation:'restore',pruneId:parent.id });
  assert.deepEqual(view.tree.nodes.map(n=>n.id),['shared','only-a','only-b']);
  assert.equal(restarted.sessions().find(s=>s.threadId==='child-a').recording,false);
  view=restarted.branch({ treeId:tree.id,operation:'restore',pruneId:child.id });
  assert.equal(view.tree.nodes.length,4);assert.equal(view.tree.prunedBranches.length,0);
  assert.equal(restarted.sessions().find(s=>s.threadId==='branch-a-test').recording,true);
  assert.equal(restarted.sessions().find(s=>s.threadId==='child-a').recording,true);
  assert.equal(restarted.sessions().find(s=>s.threadId==='root').recording,false);
});
test('pruning cancels commits from in-flight reads and cannot be undone by re-linking', async t => {
  const { native, tree }=pruningFixture(t);let completeRead,readStarted;
  const entered=new Promise(resolve=>readStarted=resolve);
  native.engine.connect=async()=>{};native.engine.rpc=async()=>{readStarted();return new Promise(resolve=>completeRead=resolve);};
  const session=native.sessions().find(s=>s.threadId==='branch-a-test');
  const reading=native.syncApi(session);await entered;
  native.branch({ treeId:tree.id,operation:'prune',threadId:session.threadId });
  completeRead({ data:[{ id:'new-turn',status:'completed',items:[{ type:'userMessage',id:'new-item',content:[{type:'text',text:'should not commit'}]}] }],nextCursor:null });
  await reading;assert.equal(tree.nodes.length,4);
  await assert.rejects(native.link('branch-a-test'),/已剪掉/);
  assert.equal(session.recording,false);
});
test('main branch promotion persists without changing native lineage or shared memory', t => {
  const { native, tree, settings, instances }=pruningFixture(t),before=structuredClone(tree.memories),parents=native.sessions().map(s=>s.parentThreadId);
  const result=native.branch({treeId:tree.id,operation:'promote',threadId:'child-a'});
  assert.equal(result.tree.native.mainThreadId,'child-a');assert.equal(tree.native.rootThreadId,'root');
  assert.deepEqual(tree.memories,before);assert.deepEqual(native.sessions().map(s=>s.parentThreadId),parents);
  native.branch({treeId:tree.id,operation:'promote',threadId:'child-a'});assert.equal(tree.native.mainChanges.length,1);
  native.close();const restarted=new NativeTree(settings);clearInterval(restarted.timer);clearInterval(restarted.apiTimer);instances.push(restarted);
  assert.equal(restarted.state(tree.id).tree.native.mainThreadId,'child-a');assert.deepEqual(restarted.store.tree(tree.id).memories,before);
});
test('pruning the former original main retains the new main, descendants, shared history and memory sources', t => {
  const { native, tree }=pruningFixture(t),before=structuredClone(tree.memories);
  native.branch({treeId:tree.id,operation:'promote',threadId:'branch-a-test'});
  const view=native.branch({treeId:tree.id,operation:'prune',threadId:'root'});
  assert.deepEqual(view.tree.nodes.map(n=>n.id),['shared','only-a','only-child']);
  assert.deepEqual(view.tree.prunedBranches[0].threadIds,['root','branch-b']);
  assert.equal(native.sessions().find(s=>s.threadId==='branch-a-test').recording,true);assert.equal(native.sessions().find(s=>s.threadId==='child-a').recording,true);
  assert.deepEqual(tree.memories,before);assert.equal(tree.nodes.length,4);
  assert.throws(()=>native.branch({treeId:tree.id,operation:'prune',threadId:'branch-a-test'}),/主分支/);
  native.branch({treeId:tree.id,operation:'restore',pruneId:view.tree.prunedBranches[0].id});assert.equal(native.state(tree.id).tree.nodes.length,4);
});
test('restoring a retained path is allowed while its native ancestor remains separately pruned', t => {
  const { native, tree }=pruningFixture(t);
  native.branch({treeId:tree.id,operation:'promote',threadId:'child-a'});
  native.branch({treeId:tree.id,operation:'prune',threadId:'branch-a-test'});
  native.branch({treeId:tree.id,operation:'promote',threadId:'branch-b'});
  const view=native.branch({treeId:tree.id,operation:'prune',threadId:'child-a'});
  const child=view.tree.prunedBranches.find(p=>p.rootThreadId==='child-a');
  const restored=native.branch({treeId:tree.id,operation:'restore',pruneId:child.id});
  assert.equal(native.sessions().find(s=>s.threadId==='child-a').recording,true);assert.equal(native.sessions().find(s=>s.threadId==='branch-a-test').recording,false);
  assert.ok(restored.tree.nodes.some(n=>n.id==='only-child'));
});
test('main promotion rejects another tree, pruned paths, deleted sessions and pending native deletion', t => {
  const { native, tree }=pruningFixture(t);const other=native.store.createTree('Other');
  native.sessions().push({treeId:other.id,threadId:'foreign',parentThreadId:null,recording:false});
  assert.throws(()=>native.branch({treeId:tree.id,operation:'promote',threadId:'foreign'}),/这棵树/);
  native.branch({treeId:tree.id,operation:'prune',threadId:'branch-a-test'});
  assert.throws(()=>native.branch({treeId:tree.id,operation:'promote',threadId:'branch-a-test'}),/恢复/);
  native.sessions().find(s=>s.threadId==='branch-b').nativeDeletedAt='now';assert.throws(()=>native.branch({treeId:tree.id,operation:'promote',threadId:'branch-b'}),/删除/);
  delete native.sessions().find(s=>s.threadId==='branch-b').nativeDeletedAt;
  tree.native.deletions=[{status:'pending'}];assert.throws(()=>native.branch({treeId:tree.id,operation:'promote',threadId:'branch-b'}),/待核验/);
  assert.equal(native.mainThreadId(tree),'root');assert.equal(tree.native.mainChanges,undefined);
});
test('native deletion protects a promoted main and ancestors whose subtree contains it', async t => {
  const { native, tree }=pruningFixture(t),mock=mockDeletionEngine(native);
  native.branch({treeId:tree.id,operation:'promote',threadId:'child-a'});
  await assert.rejects(native.deletion.preview({treeId:tree.id,threadId:'child-a'}),/主分支/);
  await assert.rejects(native.deletion.preview({treeId:tree.id,threadId:'branch-a-test'}),/包含当前主分支/);
  await assert.rejects(native.deletion.preview({treeId:tree.id,threadId:'root'}),/历史来源/);
  assert.equal(mock.deleted.size,0);
  const paths=native.state(tree.id).tree.native.paths;assert.equal(paths.find(p=>p.threadId==='branch-a-test').canDeleteNative,false);assert.equal(paths.find(p=>p.threadId==='branch-b').canDeleteNative,true);
});

function mockDeletionEngine(native, { busy = false, failId = null } = {}) {
  const calls = [], deleted = new Set(); let extra = false;
  native.engine.connect = async () => {};
  native.engine.rpc = async (method, args) => {
    calls.push({ method, args });
    if (method === 'thread/read') return { thread: { id: args.threadId, name: 'Native ' + args.threadId, path: '/test/' + args.threadId + '.jsonl', ephemeral: false, status: { type: 'notLoaded' } } };
    if (method === 'thread/list') return { data: extra && args.ancestorThreadId === 'branch-a-test' && !args.archived ? [{ id: 'spawn-new', name: 'New spawned child', parentThreadId: 'branch-a-test' }] : [], nextCursor: null };
    if (method === 'thread/turns/list') return { data: busy ? [{ id: 'current', status: 'inProgress' }] : [], nextCursor: null };
    if (method === 'thread/delete') { if (args.threadId === failId) throw new Error('Native delete failed'); deleted.add(args.threadId); return {}; }
    throw new Error('Unexpected method ' + method);
  };
  return { calls, deleted, addDescendant: () => { extra = true; } };
}
test('native deletion requires a matching fresh plan and explicit confirmation, and refuses main or busy threads', async t => {
  const { native, tree } = pruningFixture(t), mock = mockDeletionEngine(native);
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });
  assert.equal(plan.threads.length, 2); assert.equal(mock.deleted.size, 0);
  await assert.rejects(native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId }), /明确确认/);
  await assert.rejects(native.deletion.execute({ treeId: tree.id, threadId: 'branch-b', planId: plan.planId, confirmation: '删除原生会话' }), /范围不匹配/);
  native.deletion.plans.get(plan.planId).expiresAt = 0;
  await assert.rejects(native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId, confirmation: '删除原生会话' }), /过期/);
  await assert.rejects(native.deletion.preview({ treeId: tree.id, threadId: 'root' }), /主分支/);
  mockDeletionEngine(native, { busy: true });
  await assert.rejects(native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' }), /正在运行/);
  assert.equal(tree.native.prunes?.length || 0, 0);
});
test('native deletion revalidates descendant scope and does not delete a branch after its range changes', async t => {
  const { native, tree } = pruningFixture(t), mock = mockDeletionEngine(native);
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });mock.addDescendant();
  await assert.rejects(native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId, confirmation: '删除原生会话' }), /范围发生变化/);
  assert.equal(mock.deleted.size, 0);assert.equal(tree.native.prunes?.length || 0, 0);
});
function hiddenFork(settings, id, parent, historyBase = parent, archived = false) {
  const dir = path.join(settings.codexHome, archived ? 'archived_sessions' : 'sessions/2026/10/14');fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-fixture-${id}.jsonl`);
  fs.writeFileSync(file, record('session_meta', { id, forked_from_id: parent, history_mode: 'paginated', history_base: { thread_id: historyBase } })+'\n'+record('response_item', { privateText: 'never import this' })+'\n');return file;
}
test('deletion discovers unlinked empty and archived conversation forks omitted from ancestor listing', async t => {
  const { native, tree, settings } = pruningFixture(t), mock = mockDeletionEngine(native);
  hiddenFork(settings, 'unlinked-fork', 'branch-a-test');
  hiddenFork(settings, 'archived-grandfork', 'unlinked-fork', 'unlinked-fork', true);
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });
  assert.equal(plan.threads.length, 4);assert.ok(plan.threads.some(t=>t.threadId==='archived-grandfork'));
  const result = await native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId, confirmation: '删除原生会话' });
  const calls = mock.calls.filter(c=>c.method==='thread/delete').map(c=>c.args.threadId);
  assert.ok(calls.indexOf('archived-grandfork')<calls.indexOf('unlinked-fork'));assert.ok(calls.indexOf('unlinked-fork')<calls.indexOf('branch-a-test'));
  assert.equal(result.deletionResult.status,'completed');assert.equal(mock.deleted.has('branch-b'),false);
  assert.doesNotMatch(JSON.stringify(native.store.state),/never import this/);
});
test('new unlinked forks invalidate an already confirmed deletion range', async t => {
  const { native, tree, settings } = pruningFixture(t), mock = mockDeletionEngine(native);
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });
  hiddenFork(settings, 'new-native-fork', 'branch-a-test');
  await assert.rejects(native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId, confirmation: '删除原生会话' }), /范围发生变化/);
  assert.equal(mock.deleted.size,0);
});
test('history dependencies outside the selected subtree cannot expand deletion to siblings or other trees', async t => {
  const { native, tree, settings } = pruningFixture(t), mock = mockDeletionEngine(native);
  hiddenFork(settings, 'outside-history-reader', 'other-root', 'branch-a-test');
  await assert.rejects(native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' }), /范围之外.*引用/);
  assert.equal(mock.deleted.size,0);
});
test('existing native writer errors are shown with an actionable explanation', t => {
  const { native, tree } = pruningFixture(t);
  native.branch({ treeId: tree.id, operation:'prune',threadId:'branch-a-test' });
  tree.native.deletions = [{ rootThreadId:'branch-a-test',status:'failed',deletedThreadIds:[],errors:[{ threadId:'branch-a-test',message:'thread branch-a-test already has an active writer' }] }];
  assert.match(native.state(tree.id).tree.prunedBranches[0].nativeDeletion.errors[0].reason,/仍被 Codex 占用/);
});
test('native deletion preview includes paginated archived descendants and rejects an unrelated list result', async t => {
  const { native, tree } = pruningFixture(t), mock = mockDeletionEngine(native);
  const base = native.engine.rpc;let unrelated = false;
  native.engine.rpc = async (method, args) => {
    if (method === 'thread/list' && args.ancestorThreadId === 'branch-a-test' && args.archived) {
      if (unrelated) return { data: [{ id: 'foreign', name: 'Other thread', parentThreadId: 'different-root' }], nextCursor: null };
      return args.cursor ? { data: [{ id: 'archived-grandchild', name: 'Archived grandchild', parentThreadId: 'archived-child' }], nextCursor: null } : { data: [{ id: 'archived-child', name: 'Archived child', parentThreadId: 'branch-a-test' }], nextCursor: 'next' };
    }
    return base(method, args);
  };
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });
  assert.equal(plan.threads.length, 4);assert.ok(plan.threads.some(t => t.threadId === 'archived-grandchild'));
  unrelated = true;await assert.rejects(native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' }), /范围无法确认/);
  assert.equal(mock.deleted.size, 0);
});
test('confirmed native deletion removes descendants first, keeps local records and memory, and cannot be restored or relinked', async t => {
  const { native, tree } = pruningFixture(t), mock = mockDeletionEngine(native), before = structuredClone(tree.memories);
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });
  const result = await native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId, confirmation: '删除原生会话' });
  assert.deepEqual(mock.calls.filter(c => c.method === 'thread/delete').map(c => c.args.threadId), ['child-a', 'branch-a-test']);
  assert.equal(result.deletionResult.status, 'completed');assert.equal(tree.nodes.length, 4);assert.deepEqual(tree.memories, before);
  assert.deepEqual(result.tree.nodes.map(n => n.id), ['shared', 'only-b']);assert.equal(result.tree.prunedBranches[0].nativeDeletedAt !== undefined, true);
  assert.equal(native.sessions().find(s => s.threadId === 'branch-b').nativeDeletedAt, undefined);
  assert.throws(() => native.branch({ treeId: tree.id, operation: 'restore', pruneId: result.tree.prunedBranches[0].id }), /永久删除/);
  await assert.rejects(native.link('branch-a-test'), /永久删除/);
});
test('native deletion reports partial failure and preserves the undeleted parent and sibling', async t => {
  const { native, tree } = pruningFixture(t), mock = mockDeletionEngine(native, { failId: 'branch-a-test' });
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: 'branch-a-test' });
  const result = await native.deletion.execute({ treeId: tree.id, threadId: 'branch-a-test', planId: plan.planId, confirmation: '删除原生会话' });
  assert.equal(result.deletionResult.status, 'partial');assert.deepEqual([...mock.deleted], ['child-a']);
  assert.equal(native.sessions().find(s => s.threadId === 'branch-a-test').nativeDeletedAt, undefined);
  assert.equal(native.sessions().find(s => s.threadId === 'child-a').recording, false);
  const restored = native.branch({ treeId: tree.id, operation: 'restore', pruneId: result.tree.prunedBranches[0].id });
  assert.deepEqual(restored.tree.nodes.map(n => n.id), ['shared', 'only-a', 'only-b']);
  assert.equal(tree.nodes.length, 4);
});
