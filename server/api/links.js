/**
 * api/links.js - 链接快传 API（V0.3 支持跨节点同步）
 * ===========================================================================
 *
 * 端点：
 *   GET    /api/links        获取所有链接
 *   POST   /api/links        投递新链接 { url, title?, from? }
 *   DELETE /api/links/:id    删除链接
 *
 * V0.3 跨节点同步：POST/DELETE 时同步给所有 peer
 */

const store = require('../store');
const { broadcast } = require('../ws');
const { pushToPeers } = require('../sync');

const MAX_TITLE = 200;
const MAX_LINKS = 50;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function handler(req, res) {
  if (req.method === 'GET') {
    const list = await store.readJson(store.LINKS_FILE);
    res.json(list);
  } else if (req.method === 'POST') {
    const { url, title, from } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url required' });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'invalid url' });
    }

    const list = await store.readJson(store.LINKS_FILE);
    const item = {
      id: makeId(),
      url,
      title: (title || url).slice(0, MAX_TITLE),
      from: from || 'anonymous',
      ts: Date.now(),
    };
    list.unshift(item);
    await store.writeJson(store.LINKS_FILE, list.slice(0, MAX_LINKS));
    broadcast({ type: 'links:changed' });
    // V0.3 跨节点同步
    pushToPeers('links:add', item).catch((e) =>
      console.error('[links] sync add error:', e.message)
    );
    res.json(item);
  } else if (req.method === 'DELETE') {
    const id = (req.url || '').replace(/^\/+/, '').split('?')[0];
    const list = await store.readJson(store.LINKS_FILE);
    await store.writeJson(store.LINKS_FILE, list.filter((l) => l.id !== id));
    broadcast({ type: 'links:changed' });
    // V0.3 跨节点同步
    pushToPeers('links:delete', { id }).catch((e) =>
      console.error('[links] sync delete error:', e.message)
    );
    res.json({ ok: true });
  } else {
    res.status(405).end();
  }
}

module.exports = (req, res, next) => {
  if (['GET', 'POST', 'DELETE'].includes(req.method)) return handler(req, res);
  next();
};
