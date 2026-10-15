import { findCodex } from '../plugin/codex-conversation-tree/server/paths.mjs';
// Integration test against the real public API in an isolated, disposable
// CODEX_HOME. No account auth or user conversations are read or deleted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { NativeTree } from '../plugin/codex-conversation-tree/server/native.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-tree-delete-smoke-'));
const home = path.join(root, 'codex-home');fs.mkdirSync(home);
process.env.CODEX_HOME = home;
process.env.CODEX_BINARY ||= findCodex();
const native = new NativeTree({ dataDir: path.join(root, 'data'), codexHome: home, codexBinary: process.env.CODEX_BINARY });
clearInterval(native.timer);clearInterval(native.apiTimer);
try {
  await native.engine.connect();
  const { thread: parent } = await native.engine.rpc('thread/start', { cwd: root, ephemeral: false });
  await native.engine.rpc('thread/name/set', { threadId: parent.id, name: 'Disposable parent' });
  const { thread: branch } = await native.engine.rpc('thread/fork', { threadId: parent.id, excludeTurns: true });
  await native.engine.rpc('thread/name/set', { threadId: branch.id, name: 'Disposable branch A' });
  const { thread: sibling } = await native.engine.rpc('thread/fork', { threadId: parent.id, excludeTurns: true });
  await native.engine.rpc('thread/name/set', { threadId: sibling.id, name: 'Disposable sibling B' });
  const { thread: child } = await native.engine.rpc('thread/fork', { threadId: branch.id, excludeTurns: true });
  for (const [thread, name] of [[parent, 'Disposable parent'], [branch, 'Disposable branch A'], [sibling, 'Disposable sibling B'], [child, 'Disposable child A']]) await native.engine.rpc('thread/name/set', { threadId: thread.id, name });
  await native.link(parent.id, 'Isolated native delete test');await native.link(branch.id);await native.link(sibling.id);await native.link(child.id);
  const tree = native.store.state.trees[0];
  tree.native.forks = [{ threadId: branch.id, parentThreadId: parent.id, title: 'Disposable branch A' }, { threadId: sibling.id, parentThreadId: parent.id, title: 'Disposable sibling B' }, { threadId: child.id, parentThreadId: branch.id, title: 'Disposable child A' }];
  tree.nodes.push({ id: 'saved-local-node', title: 'Saved local record', question: 'Test question only', answer: 'Saved local answer', status: 'completed', nativeThreadId: branch.id, bindings: [{ threadId: branch.id }] });
  native.store.addMemory(tree, { content: 'Preserve this local conclusion', sourceNodeIds: ['saved-local-node'] });
  const plan = await native.deletion.preview({ treeId: tree.id, threadId: branch.id });
  assert.equal(plan.threads.length, 2);
  const result = await native.deletion.execute({ treeId: tree.id, threadId: branch.id, planId: plan.planId, confirmation: plan.confirmationText });
  assert.equal(result.deletionResult.status, 'completed');
  assert.equal(fs.existsSync(branch.path), false);assert.equal(fs.existsSync(child.path), false);
  for (const thread of [branch, child]) await assert.rejects(native.engine.rpc('thread/read', { threadId: thread.id, includeTurns: false }), /thread not loaded|not found|no rollout found/);
  for (const thread of [parent, sibling]) { assert.ok(fs.existsSync(thread.path));const read = await native.engine.rpc('thread/read', { threadId: thread.id, includeTurns: false });assert.equal(read.thread.id, thread.id); }
  assert.equal(tree.nodes[0].answer, 'Saved local answer');assert.equal(tree.memories.at(-1).content, 'Preserve this local conclusion');
  const report = { verifiedAt: new Date().toISOString(), profile: 'isolated disposable CODEX_HOME', nativeApi: 'thread/delete', deletedBranchAndChild: true, deletedThreadsUnreadable: true, parentAndSiblingPreserved: true, localRecordsAndMemoryPreserved: true, userConversationsTouched: false };
  const reportPath = path.resolve('docs/native-delete-integration.json');fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');console.log(JSON.stringify(report, null, 2));
} finally { native.close(); }
