import { createHash } from 'node:crypto';
export const nativeNodeId = messageId => 'node_' + createHash('sha256').update(messageId).digest('hex').slice(0, 32);
export function visiblePrompt(text) {
  return String(text || '').trim().replace(/^<in-app-browser-context\s+source=["']ambient-ui-state["'][^>]*>[\s\S]*?<\/in-app-browser-context>\s*(?:## My request:\s*)?/, '').trim();
}

// Versioned adapter for Codex 0.162 JSONL. It reads user-visible messages only;
// system/developer context, hidden reasoning and tool arguments never enter our store.
export function parseTranscript(text) {
  const nodes = [], byTurn = new Map(), completed = new Map(), aborted = new Set();
  let meta = null, activeTurn = null, diagnostics = [];
  const records = text.split('\n');
  for (let i = 0; i < records.length; i++) {
    const line = records[i]; if (!line.trim()) continue;
    let record; try { record = JSON.parse(line); } catch { if (i < records.length - 1) diagnostics.push('有一条记录无法解析'); continue; }
    const p = record.payload || {};
    if (record.type === 'session_meta') { meta ||= p; continue; }
    if (record.type === 'event_msg') {
      if (p.type === 'task_started') activeTurn = p.turn_id;
      if (p.type === 'task_complete') completed.set(p.turn_id, { answer: p.last_agent_message || p.last_assistant_message || '', at: p.completed_at || record.timestamp });
      if (p.type === 'turn_aborted') aborted.add(p.turn_id);
      continue;
    }
    if (record.type !== 'response_item' || p.type !== 'message') continue;
    const metadata = p.internal_chat_message_metadata_passthrough || {};
    const turnId = metadata.turn_id || activeTurn;
    const content = (p.content || []).filter(c => ['input_text', 'output_text', 'text'].includes(c.type)).map(c => c.text || '').join('\n');
    if (p.role === 'user') {
      const kinds = metadata.content_item_kinds || [];
      if (kinds.length ? !kinds.some(k => k === 'user.text' || k === 'user.image') : /^(# AGENTS\.md instructions|<environment_context>|<external_codex_apps_open_page>)/.test(content)) continue;
      const question = visiblePrompt(content);
      if (!question || !turnId || !p.id) continue;
      const n = { id: nativeNodeId(p.id), nativeMessageId: p.id, turnId, question, createdAt: record.timestamp, messages: [], nativeThreadId: meta?.id, status: 'running' };
      nodes.push(n); if (!byTurn.has(turnId)) byTurn.set(turnId, []); byTurn.get(turnId).push(n);
    }
    if (p.role === 'assistant' && ['commentary', 'final_answer'].includes(p.phase)) {
      const turns = byTurn.get(turnId); const n = turns?.at(-1);
      if (n && content.trim()) n.messages.push({ id: p.id, phase: p.phase, text: content });
    }
  }
  let parentId = null;
  for (const n of nodes) {
    n.parentId = parentId; parentId = n.id;
    n.status = completed.has(n.turnId) ? 'completed' : aborted.has(n.turnId) ? 'interrupted' : 'running';
    n.answer = n.messages.filter(m => m.phase === 'final_answer').map(m => m.text).join('\n\n');
    if (!n.answer && completed.has(n.turnId) && byTurn.get(n.turnId).at(-1).id === n.id) n.answer = completed.get(n.turnId).answer;
    n.completedAt = completed.get(n.turnId)?.at;
    n.forkable = n.status === 'completed' && byTurn.get(n.turnId).at(-1).id === n.id;
    n.forkBoundary = 'turn';
  }
  return { meta, nodes, diagnostics, format: 'codex-jsonl-0.162' };
}

export function parseTurns(turns, existingNodes = []) {
  const nodes = [], matchedIds = new Set(); let parentId = null;
  for (const turn of turns) {
    const users = (turn.items || []).filter(i => i.type === 'userMessage');
    for (let index = 0; index < users.length; index++) {
      const item = users[index], question = visiblePrompt((item.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n'));
      if (!question) continue;
      const existing = existingNodes.find(n => n.turnId === turn.id && visiblePrompt(n.question) === question && !matchedIds.has(n.id));
      const id = existing?.id || nativeNodeId(item.id || `${turn.id}:${index}`);
      matchedIds.add(id);
      const messages = index === users.length - 1 ? (turn.items || []).filter(i => i.type === 'agentMessage' && ['commentary', 'final_answer'].includes(i.phase)).map(i => ({ id: i.id, phase: i.phase, text: i.text || '' })) : [];
      const createdAt = existing?.createdAt || (turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : new Date().toISOString());
      nodes.push({ id, nativeMessageId: item.id, parentId, turnId: turn.id, question, createdAt, messages, answer: messages.filter(m => m.phase === 'final_answer').map(m => m.text).join('\n\n'), status: turn.status === 'inProgress' ? 'running' : turn.status, forkable: turn.status === 'completed' && index === users.length - 1, forkBoundary: 'turn' });
      parentId = id;
    }
  }
  return nodes;
}
