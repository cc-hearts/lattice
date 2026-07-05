/**
 * nodeauth.js - 节点间鉴权强化（V0.4）
 * ===========================================================================
 *
 * 替代原来「裸 LATTICE_SECRET 头」的弱方案。新的鉴权链：
 *
 *   请求头：
 *     X-Lattice-Node: <来源节点名>
 *     X-Lattice-Ts:   <Unix 毫秒时间戳>
 *     X-Lattice-Sig:  HMAC-SHA256(secret, node + '|' + ts)
 *     （旧版）X-Lattice-Secret: <明文 secret>   ← 向后兼容
 *
 *   校验顺序：
 *     1. 没设 LATTICE_SECRET → 直接放行（兼容纯单机模式）
 *     2. 带 X-Lattice-Sig → 走新流程：
 *        a. 时间戳窗口 ±60s（防重放）
 *        b. HMAC 重算并比对（防伪造）
 *        c. 节点名在白名单内（如果设了 LATTICE_ALLOWED_NODES）
 *        d. 节点名不能是自己（防回环伪造）
 *     3. 否则带 X-Lattice-Secret → 走旧流程：明文比对（向后兼容，建议尽快迁移）
 *     4. 都没有 → 403
 *
 * 为什么这样设计？
 *   - HMAC 不在线缆上传明文密钥，即便被嗅探也拿不到 secret
 *   - 时间戳窗口防重放攻击（抓包重放最多有效 60s）
 *   - 节点名白名单防「知道 secret 的陌生节点」乱入（可选）
 *   - 保留旧路径，老节点升级前不会断
 * ===========================================================================
 */

const crypto = require('crypto');

const SECRET = process.env.LATTICE_SECRET || '';
const NODE_NAME = process.env.LATTICE_NAME || require('os').hostname();

// 允许的节点名白名单（逗号分隔），不设则允许任何带正确签名的节点
const ALLOWED_NODES = process.env.LATTICE_ALLOWED_NODES
  ? process.env.LATTICE_ALLOWED_NODES.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

// 时间戳容差（毫秒）：时钟漂移 + 网络延迟
const TS_WINDOW_MS = 60 * 1000;

/**
 * 计算签名
 * 输入是「节点名|时间戳」，用 secret 做 HMAC-SHA256，输出 hex
 */
function sign(node, ts) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${node}|${ts}`)
    .digest('hex');
}

/**
 * 生成一组节点鉴权头（给推送方用）
 * @param {string} [node] - 节点名，默认本节点
 * @returns {Object} headers
 */
function makeAuthHeaders(node = NODE_NAME) {
  if (!SECRET) return {};
  const ts = Date.now();
  return {
    'X-Lattice-Node': node,
    'X-Lattice-Ts': String(ts),
    'X-Lattice-Sig': sign(node, ts),
    // 向后兼容：同时带明文 secret，让还没升级的节点也能认
    'X-Lattice-Secret': SECRET,
  };
}

/**
 * Express 中间件：校验节点鉴权
 * 用法：router.post('/receive', nodeAuth, handler)
 */
function nodeAuth(req, res, next) {
  // 没设 secret → 单机模式，放行
  if (!SECRET) return next();

  const node = req.headers['x-lattice-node'];
  const ts = req.headers['x-lattice-ts'];
  const sig = req.headers['x-lattice-sig'];

  // 新流程：HMAC 签名
  if (sig && node && ts) {
    // 1. 时间戳窗口
    const delta = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(delta) || delta > TS_WINDOW_MS) {
      return res.status(403).json({ error: 'stale timestamp', delta });
    }
    // 2. 签名比对
    const expected = sign(node, ts);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(403).json({ error: 'bad signature' });
    }
    // 3. 不能伪造成本节点（防回环）
    if (node === NODE_NAME) {
      return res.status(403).json({ error: 'self-impersonation' });
    }
    // 4. 白名单
    if (ALLOWED_NODES && !ALLOWED_NODES.includes(node)) {
      return res.status(403).json({ error: 'node not allowed', node });
    }
    req.latticeSource = node;
    return next();
  }

  // 旧流程：明文 secret（向后兼容）
  const plain = req.headers['x-lattice-secret'];
  if (plain && plain === SECRET) {
    req.latticeSource = node || 'legacy';
    return next();
  }

  return res.status(403).json({ error: 'invalid node auth' });
}

module.exports = {
  SECRET,
  NODE_NAME,
  ALLOWED_NODES,
  sign,
  makeAuthHeaders,
  nodeAuth,
};
