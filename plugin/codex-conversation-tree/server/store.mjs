import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const uid = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function safePath(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) fail('文件路径无效');
  const result = path.resolve(root, relative);
  if (result !== path.resolve(root) && !result.startsWith(path.resolve(root) + path.sep)) fail('文件路径超出当前节点');
  return result;
}
export function inventory(dir) {
  const files = [];
  function walk(at, relative = '') {
    if (!fs.existsSync(at)) return;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = path.posix.join(relative, entry.name), p = path.join(at, entry.name);
      if (entry.isSymbolicLink()) fail(`快照不支持符号链接：${rel}`);
      if (entry.isDirectory()) walk(p, rel);
      else if (entry.isFile()) {
        const size = fs.statSync(p).size;
        if (size > 64 * 1024 * 1024) fail(`文件超过快照的 64 MB 限制：${rel}`);
        files.push({ path: rel, size, hash: createHash('sha256').update(fs.readFileSync(p)).digest('hex') });
        if (files.length > 2000) fail('工作目录超过 2000 个文件的快照限制');
      }
    }
  }
  walk(dir);
  if (files.reduce((sum, f) => sum + f.size, 0) > 256 * 1024 * 1024) fail('工作目录超过 256 MB 的快照限制');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function copyWorkspace(from, to) {
  const files = inventory(from);
  fs.mkdirSync(to, { recursive: true });
  for (const file of files) {
    const dest = safePath(to, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(safePath(from, file.path), dest);
  }
  return files;
}
export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'store.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { schemaVersion: 1, trees: [] };
    if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.trees)) fail('数据格式无法读取，请保留数据并查看 README', 500);
    for (const tree of this.state.trees) for (const node of tree.nodes) {
      if (['starting', 'running', 'waiting'].includes(node.status)) {
        node.status = 'interrupted'; node.error = '客户端上次退出时，这个节点尚未完成。可以重新尝试此提问。';
        try { this.snapshot(tree, node); } catch (e) { node.snapshotError = e.message; }
      }
    }
    this.save();
  }
  save() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  tree(id) { const t = this.state.trees.find(t => t.id === id); if (!t) fail('没有找到这棵树', 404); return t; }
  node(tree, id) { const n = tree.nodes.find(n => n.id === id); if (!n) fail('没有找到这个节点', 404); return n; }
  memory(tree, version) { const m = tree.memories.find(m => m.version === version); if (!m) fail('没有找到这个记忆版本', 404); return m; }
  createTree(title = '我的第一棵树', content = '') {
    const tree = { id: uid('tree'), title: title.trim().slice(0, 100) || '未命名的树', createdAt: now(), updatedAt: now(), nodes: [], memories: [{ version: 1, content, sourceNodeIds: [], materials: [], createdAt: now() }] };
    this.state.trees.push(tree); this.save(); return tree;
  }
  addMemory(tree, { content, sourceNodeIds = [], materials }) {
    if (typeof content !== 'string' || content.length > 100000) fail('记忆内容无效或超过 10 万字');
    if (!Array.isArray(sourceNodeIds) || sourceNodeIds.some(id => !tree.nodes.some(n => n.id === id))) fail('记忆来源节点无效');
    const last = tree.memories.at(-1);
    const memory = { version: last.version + 1, content, sourceNodeIds: [...new Set(sourceNodeIds)], materials: materials ?? structuredClone(last.materials), createdAt: now() };
    tree.memories.push(memory); tree.updatedAt = now(); this.save(); return memory;
  }
  workspace(tree, node) { return path.join(this.root, 'trees', tree.id, 'workspaces', node.id); }
  snapshotDir(tree, node) { return path.join(this.root, 'trees', tree.id, 'snapshots', node.id); }
  prepare(tree, node, parent) {
    const workspace = this.workspace(tree, node);
    if (parent) {
      if (!parent.snapshotReady) fail('父节点的文件快照尚未就绪，无法恢复它的状态');
      copyWorkspace(this.snapshotDir(tree, parent), workspace);
    } else fs.mkdirSync(workspace, { recursive: true });
    // Reference materials are selected by the pinned memory version, never inherited accidentally.
    fs.rmSync(path.join(workspace, '_context'), { recursive: true, force: true });
    const context = path.join(workspace, '_context'); fs.mkdirSync(path.join(context, 'materials'), { recursive: true });
    const memory = this.memory(tree, node.memoryVersion);
    fs.writeFileSync(path.join(context, 'ROOT_MEMORY.md'), `# 树根记忆 v${memory.version}\n\n${memory.content}\n`);
    for (const material of memory.materials) fs.copyFileSync(path.join(this.root, 'materials', material.id), path.join(context, 'materials', `${material.id.slice(0, 8)}-${material.name}`));
    node.workspace = workspace;
    return workspace;
  }
  snapshot(tree, node) {
    const source = this.workspace(tree, node);
    if (!fs.existsSync(source)) return;
    const dest = this.snapshotDir(tree, node), temp = dest + '.tmp';
    fs.rmSync(temp, { recursive: true, force: true });
    const files = copyWorkspace(source, temp);
    fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(temp, dest);
    node.files = files; node.snapshotReady = true;
  }
  addMaterial(tree, name, buffer) {
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) fail('请选择不超过 20 MB 的非空文件');
    const clean = path.basename(String(name)).replace(/[\x00-\x1f]/g, '').slice(0, 180);
    if (!clean || clean === '.' || clean === '..') fail('文件名无效');
    const id = createHash('sha256').update(buffer).digest('hex');
    fs.mkdirSync(path.join(this.root, 'materials'), { recursive: true });
    fs.writeFileSync(path.join(this.root, 'materials', id), buffer, { mode: 0o600 });
    const material = { id, name: clean, size: buffer.length, addedAt: now() };
    const last = tree.memories.at(-1);
    if (last.materials.some(m => m.id === id && m.name === clean)) return last;
    return this.addMemory(tree, { content: last.content, sourceNodeIds: last.sourceNodeIds, materials: [...last.materials, material] });
  }
}
