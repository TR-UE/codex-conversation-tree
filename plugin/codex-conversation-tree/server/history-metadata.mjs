import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Read session headers only. Empty native forks are omitted from thread/list,
// and ancestorThreadId covers spawned agents, not conversation forks.
async function header(file) {
  const source = fs.createReadStream(file);
  let input = source;
  if (file.endsWith('.zst')) {
    if (!zlib.createZstdDecompress) { source.destroy();throw new Error('存在压缩的原生会话记录，需要 Node.js 24 以上才能确认完整删除范围'); }
    input = source.pipe(zlib.createZstdDecompress());
  }
  try {
    return await new Promise((resolve, reject) => {
      const chunks = [];let bytes = 0;
      source.on('error', reject);input.on('error', reject);
      input.on('data', chunk => {
        const end = chunk.indexOf(10), piece = end < 0 ? chunk : chunk.subarray(0, end);
        bytes += piece.length;
        if (bytes > 512 * 1024) { reject(new Error('会话元数据过大，无法确认删除范围'));input.destroy();source.destroy();return; }
        chunks.push(piece);
        if (end >= 0) { resolve(Buffer.concat(chunks).toString('utf8'));input.destroy();source.destroy(); }
      });
      input.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  } finally { input.destroy();source.destroy(); }
}

export async function scanHistoryMetadata(codexHome) {
  const result = new Map();
  async function walk(dir) {
    let files;try { files = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return;throw e; }
    for (const entry of files) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file);continue; }
      if (!/^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) continue;
      if (!entry.isFile()) throw new Error('会话记录包含符号链接，无法确认删除范围');
      let line;try { line = await header(file); } catch (e) { if (e.code === 'ENOENT') continue;throw e; }
      if (!line) throw new Error('有原生会话尚未写入元数据，请稍后重新预览');
      let meta;try { const row = JSON.parse(line);if (row.type === 'session_meta') meta = row.payload; } catch {}
      if (!meta?.id) throw new Error('原生会话元数据格式无法识别，未执行删除');
      const spawnParent = meta.source?.subAgent?.thread_spawn?.parent_thread_id;
      const item = { threadId: meta.id, forkedFromId: meta.forked_from_id || null, parentThreadId: meta.forked_from_id || spawnParent || null, historyBaseId: meta.history_base?.thread_id || null };
      const old = result.get(item.threadId);
      if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error('同一原生会话存在不同历史引用，无法确认删除范围');
      result.set(item.threadId, item);
    }
  }
  await walk(path.join(codexHome, 'sessions'));
  await walk(path.join(codexHome, 'archived_sessions'));
  return result;
}
