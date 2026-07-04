/**
 * api/clipboard.js - 剪贴板同步 API（V0.3 支持跨节点同步）
 * ===========================================================================
 *
 * 端点：
 *   GET  /api/clipboard    获取最新一条
 *   POST /api/clipboard    推送新内容 { text, from }
 *
 * V0.3 跨节点同步：POST 时调 pushToPeers 推给所有 peer
 */

const store = require('../store');
const { broadcast } = require('../ws');
const { pushToPeers } = require('../sync');

const MAX_LENGTH = 5000;
const MAX_HISTORY = 20;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function handler(req, res) {
  if (req.method === 'GET') {
    const list = await store.readJson(store.CLIPBOARD_FILE);
    res.json(list[0] || null);
  } else if (req.method === 'POST') {
    const { text, from } = req.body || {};
    if (typeof text !== 'string' || !text) {
      return res.status(400).json({ error: 'text required' });
    }

    const list = await store.readJson(store.CLIPBOARD_FILE);
    const item = {
      id: makeId(),
      text: text.slice(0, MAX_LENGTH),
      from: from || 'anonymous',
      ts: Date.now(),
    };
    list.unshift(item);
    await store.writeJson(store.CLIPBOARD_FILE, list.slice(0, MAX_HISTORY));
    broadcast({ type: 'clipboard:changed' });
    // V0.3 跨节点同步
    pushToPeers('clipboard:set', item).catch((e) =>
      console.error('[clipboard] sync error:', e.message)
    );
    res.json({ ok: true });
  } else {
    res.status(405).end();
  }
}

module.exports = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'POST') return handler(req, res);
  next();
};
