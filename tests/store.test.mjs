import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, uid, safePath, inventory } from '../plugin/codex-conversation-tree/server/store.mjs';

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-tree-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new Store(dir); }
function n(parentId = null, memoryVersion = 1) { return { id: uid('node'), parentId, memoryVersion, status: 'completed', files: [], messages: [] }; }

test('a historical parent restores its own files, while siblings and parent remain unchanged', t => {
  const store = fixture(t), tree = store.createTree('测试'), a = n(); tree.nodes.push(a);
  const aw = store.prepare(tree, a); fs.writeFileSync(path.join(aw, 'value.txt'), 'original'); store.snapshot(tree, a);
  const b = n(a.id), c = n(a.id); tree.nodes.push(b, c);
  const bw = store.prepare(tree, b, a); fs.writeFileSync(path.join(bw, 'value.txt'), 'branch B'); fs.writeFileSync(path.join(bw, 'extra.txt'), 'only B'); store.snapshot(tree, b);
  const cw = store.prepare(tree, c, a);
  assert.equal(fs.readFileSync(path.join(cw, 'value.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(cw, 'extra.txt')), false);
  assert.equal(fs.readFileSync(path.join(store.snapshotDir(tree, a), 'value.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(store.snapshotDir(tree, b), 'value.txt'), 'utf8'), 'branch B');
});
test('memory versions and their materials stay pinned and persist across a restart', t => {
  const store = fixture(t), tree = store.createTree('记忆测试', '第一版');
  store.addMaterial(tree, 'old.txt', Buffer.from('old'));
  const a = n(null, 2); tree.nodes.push(a); store.prepare(tree, a); store.snapshot(tree, a);
  store.addMemory(tree, { content: '第三版', sourceNodeIds: [a.id], materials: [] });
  const historical = n(a.id, 2), latest = n(a.id, 3); tree.nodes.push(historical, latest);
  const hw = store.prepare(tree, historical, a), lw = store.prepare(tree, latest, a);
  assert.match(fs.readFileSync(path.join(hw, '_context', 'ROOT_MEMORY.md'), 'utf8'), /第一版/);
  assert.match(fs.readFileSync(path.join(lw, '_context', 'ROOT_MEMORY.md'), 'utf8'), /第三版/);
  assert.equal(fs.readdirSync(path.join(hw, '_context', 'materials')).length, 1);
  assert.equal(fs.readdirSync(path.join(lw, '_context', 'materials')).length, 0);
  store.save(); const restarted = new Store(store.root);
  assert.equal(restarted.tree(tree.id).memories[1].content, '第一版');
  assert.deepEqual(restarted.tree(tree.id).memories[2].sourceNodeIds, [a.id]);
});
test('unfinished turns are marked interrupted on restart and retain partial file state', t => {
  const store = fixture(t), tree = store.createTree(), node = n(); node.status = 'running'; tree.nodes.push(node);
  fs.writeFileSync(path.join(store.prepare(tree, node), 'partial.txt'), 'partial'); store.save();
  const recovered = new Store(store.root).tree(tree.id).nodes[0];
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.snapshotReady, true); assert.ok(recovered.error);
});
test('path traversal and symbolic links cannot enter snapshots', t => {
  const store = fixture(t);
  assert.throws(() => safePath(store.root, '../secret'));
  assert.throws(() => safePath(store.root, '/etc/passwd'));
  fs.symlinkSync('/etc/passwd', path.join(store.root, 'link'));
  assert.throws(() => inventory(store.root), /符号链接/);
});
test('memory source references are validated without creating a version', t => {
  const store = fixture(t), tree = store.createTree();
  assert.throws(() => store.addMemory(tree, { content: 'wrong', sourceNodeIds: ['missing'] }));
  assert.equal(tree.memories.length, 1);
});
