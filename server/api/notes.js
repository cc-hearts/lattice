/**
 * api/notes.js - 共享便签 API（V0.3 支持跨节点同步）
 * ===========================================================================
 *
 * 端点：
 *   GET    /api/notes        获取所有便签
 *   POST   /api/notes        新建便签 { text, color?, from? }
 *   DELETE /api/notes/:id    删除便签
 *
 * V0.3 跨节点同步：
 *   POST/DELETE 时调用 pushToPeers() 把变更推给所有 peer
 *   接收端在 sync.js 里处理去重和循环防护
 *
 * 数据结构：
 *   {
 *     id: string,        // 短随机 ID
 *     text: string,      // 内容（最长 1000 字符）
 *     color: string,     // 背景色，hex
 *     from: string,      // 署名
 *     ts: number,        // 时间戳
 *   }
 */

const store = require('../store');
const { broadcast } = require('../ws');
const { pushToPeers } = require('../sync');

const MAX_TEXT = 1000;
const MAX_NOTES = 100;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function handler(req, res) {
  const url = req.url || '';

  // GET /api/notes
  if (req.method === 'GET') {
    const notes = await store.readJson(store.NOTES_FILE);
    res.json(notes);
  }
  // POST /api/notes
  else if (req.method === 'POST') {
    const { text, color, from } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });

    const list = await store.readJson(store.NOTES_FILE);
    const item = {
      id: makeId(),
      text: String(text).slice(0, MAX_TEXT),
      color: color || '#fef3c7',
      from: from || 'anonymous',
      ts: Date.now(),
    };
    list.unshift(item);
    await store.writeJson(store.NOTES_FILE, list.slice(0, MAX_NOTES));
    broadcast({ type: 'notes:changed' });
    // V0.3 跨节点同步
    pushToPeers('notes:add', item).catch((e) =>
      console.error('[notes] sync add error:', e.message)
    );
    res.json(item);
  }
  // DELETE /api/notes/:id
  else if (req.method === 'DELETE') {
    const id = url.replace(/^\/+/, '').split('?')[0];
    if (!id) return res.status(400).json({ error: 'id required' });

    const list = await store.readJson(store.NOTES_FILE);
    const next = list.filter((n) => n.id !== id);
    await store.writeJson(store.NOTES_FILE, next);
    broadcast({ type: 'notes:changed' });
    // V0.3 跨节点同步
    pushToPeers('notes:delete', { id }).catch((e) =>
      console.error('[notes] sync delete error:', e.message)
    );
    res.json({ ok: true });
  } else {
    res.status(405).end();
  }
}

module.exports = (req, res, next) => handler(req, res);
