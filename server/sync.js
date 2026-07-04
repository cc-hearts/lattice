/**
 * sync.js - 跨节点数据同步（V0.3）
 * ===========================================================================
 *
 * 提供两个能力：
 *   1. pushToPeers(type, payload)  - 把数据变更推给所有 peer
 *   2. /api/sync 接收端点          - 接收其他节点推过来的变更，写入本地存储
 *
 * 支持的同步类型：
 *   - notes:add         { id, text, color, from, ts }     新增便签
 *   - notes:delete      { id }                            删除便签
 *   - clipboard:set     { id, text, from, ts }            设置剪贴板最新
 *   - links:add         { id, url, title, from, ts }      新增链接
 *   - links:delete      { id }                            删除链接
 *
 * 循环防护（关键）：
 *   每个事件都带 source（来源节点）。接收端记录已处理的事件 ID，
 *   30 秒内重复收到直接丢弃，避免无限循环（A→B→C→A→B→C...）。
 *
 * 去重：
 *   便签/链接/剪贴板都带 id，已存在则跳过。
 *
 * ===========================================================================
 */

const express = require('express');
const http = require('http');
const { URL } = require('url');
const store = require('./store');
const { broadcast } = require('./ws');

const router = express.Router();

const SECRET = process.env.LATTICE_SECRET || '';
const NODE_NAME = process.env.LATTICE_NAME || require('os').hostname();

/**
 * 已处理事件缓存（防止循环）
 * key = "<source>:<eventId>:<type>"，value = 处理时间
 * 30 秒后过期
 */
const recentEvents = new Map();

function isRecentlyProcessed(source, type, id) {
  const key = `${source}:${type}:${id}`;
  const ts = recentEvents.get(key);
  if (!ts) return false;
  if (Date.now() - ts > 30000) {
    recentEvents.delete(key);
    return false;
  }
  return true;
}

function markProcessed(source, type, id) {
  const key = `${source}:${type}:${id}`;
  recentEvents.set(key, Date.now());
}

/**
 * 鉴权
 */
function checkSecret(req, res, next) {
  if (!SECRET) return next();
  if (req.headers['x-lattice-secret'] !== SECRET) {
    return res.status(403).json({ error: 'invalid secret' });
  }
  next();
}

/**
 * 解析 body（JSON）
 */
router.use(express.json({ limit: '1mb' }));

/**
 * POST /api/sync
 * 接收其他节点推过来的数据变更
 */
router.post('/', checkSecret, async (req, res) => {
  try {
    const { type, payload, source, eventId } = req.body || {};

    if (!type || !payload || !source || !eventId) {
      return res.status(400).json({ error: 'type, payload, source, eventId required' });
    }

    // 循环防护
    if (isRecentlyProcessed(source, type, eventId)) {
      return res.json({ ok: true, skipped: 'recent' });
    }

    // 分发到对应的存储
    const result = await dispatch(type, payload);

    if (result.applied) {
      markProcessed(source, type, eventId);
      // 通知本地浏览器刷新
      broadcast({ type: result.notifyEvent });
    }

    res.json({ ok: true, applied: result.applied });
  } catch (e) {
    console.error('[sync] 错误:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 根据 type 把数据写入对应存储
 * @returns { applied: boolean, notifyEvent: string }
 */
async function dispatch(type, payload) {
  // 便签
  if (type === 'notes:add') {
    const list = await store.readJson(store.NOTES_FILE);
    if (list.find((n) => n.id === payload.id)) {
      return { applied: false, notifyEvent: 'notes:changed' };
    }
    list.unshift(payload);
    await store.writeJson(store.NOTES_FILE, list.slice(0, 100));
    return { applied: true, notifyEvent: 'notes:changed' };
  }

  if (type === 'notes:delete') {
    const list = await store.readJson(store.NOTES_FILE);
    const next = list.filter((n) => n.id !== payload.id);
    await store.writeJson(store.NOTES_FILE, next);
    return { applied: true, notifyEvent: 'notes:changed' };
  }

  // 剪贴板
  if (type === 'clipboard:set') {
    const list = await store.readJson(store.CLIPBOARD_FILE);
    if (list.find((c) => c.id === payload.id)) {
      return { applied: false, notifyEvent: 'clipboard:changed' };
    }
    list.unshift(payload);
    await store.writeJson(store.CLIPBOARD_FILE, list.slice(0, 20));
    return { applied: true, notifyEvent: 'clipboard:changed' };
  }

  // 链接
  if (type === 'links:add') {
    const list = await store.readJson(store.LINKS_FILE);
    if (list.find((l) => l.id === payload.id)) {
      return { applied: false, notifyEvent: 'links:changed' };
    }
    list.unshift(payload);
    await store.writeJson(store.LINKS_FILE, list.slice(0, 50));
    return { applied: true, notifyEvent: 'links:changed' };
  }

  if (type === 'links:delete') {
    const list = await store.readJson(store.LINKS_FILE);
    await store.writeJson(store.LINKS_FILE, list.filter((l) => l.id !== payload.id));
    return { applied: true, notifyEvent: 'links:changed' };
  }

  return { applied: false, notifyEvent: 'noop' };
}

/**
 * ============================================================================
 * 推送工具（给 notes/clipboard/links 模块用）
 * ============================================================================
 */

/**
 * 把数据变更推送给所有 peer
 * @param {string} type - 事件类型，如 'notes:add'
 * @param {object} payload - 数据载荷
 * @returns {Promise<{ok: number, fail: number}>}
 */
async function pushToPeers(type, payload) {
  if (!SECRET) {
    // 没设密钥就不同步
    return { ok: 0, fail: 0, skipped: 'no-secret' };
  }

  const peers = store.getPeers();
  if (peers.length === 0) {
    return { ok: 0, fail: 0, skipped: 'no-peers' };
  }

  const eventId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const body = JSON.stringify({ type, payload, source: NODE_NAME, eventId });

  console.log(`[sync] 推送 ${type} 给 ${peers.length} 个 peers`);

  const results = await Promise.allSettled(
    peers.map((peer) => postJson(peer, '/api/sync', body))
  );

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  console.log(`[sync] 推送 ${type} 完成：成功 ${ok}，失败 ${fail}`);
  return { ok, fail };
}

/**
 * POST JSON 到 peer
 */
function postJson(peer, path, body) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(`http://${peer.ip}:${peer.port}${path}`);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Lattice-Secret': SECRET,
          'X-Lattice-Source': NODE_NAME,
        },
        timeout: 5000,
      }, (res) => {
        let buf = '';
        res.on('data', (d) => buf += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf);
          } else {
            reject(new Error(`${peer.name} returned ${res.statusCode}: ${buf}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { router, pushToPeers };
