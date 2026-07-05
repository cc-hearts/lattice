/**
 * auth.js - 浏览器访问鉴权（一次性访问码 + session cookie）
 * ============================================================================
 *
 * 解决什么问题：
 *   Lattice 监听 0.0.0.0，同网段任何人打开 http://<IP>:7777 就能操作。
 *   本模块给"浏览器访问"加一把锁：启动时生成一次性访问码并打印到终端，
 *   用户在锁屏页输入正确后下发 session cookie，之后所有 /api 与 /ws 凭 cookie 放行。
 *
 * 和 LATTICE_SECRET 的关系：
 *   LATTICE_SECRET 是"节点之间同步"用的（X-Lattice-Secret 头），在 sync.js 里校验。
 *   本模块是"人用浏览器访问"用的，两套互不干扰，/api/sync 不经过这里。
 *
 * 密码来源：
 *   - 设了 LATTICE_PASSWORD → 用它（固定，适合长期使用）
 *   - 没设 → 启动时随机生成一个，本次运行有效，重启换新（一次性）
 *
 * 会话机制：
 *   - 验证通过 → 生成随机 token 存内存 Map → 下发 cookie
 *   - cookie: lattice_session=<token>; HttpOnly; SameSite=Lax; Path=/
 *   - 不设 Max-Age → session cookie，关浏览器即失效
 *   - 服务重启 → Map 清空 → 即使 cookie 还在也认不了，需重新登录（配合一次性密码）
 * ============================================================================
 */

const crypto = require('crypto');
const express = require('express');

const COOKIE_NAME = 'lattice_session';

/**
 * 生成 4 位大写 hex 片段
 */
function hexPart() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

/**
 * 访问密码
 * - 优先用环境变量 LATTICE_PASSWORD（固定）
 * - 没设则随机生成形如 LATTICE-1A2B-3C4D 的一次性密码
 */
const PASSWORD_IS_RANDOM = !process.env.LATTICE_PASSWORD;
const PASSWORD = process.env.LATTICE_PASSWORD || `LATTICE-${hexPart()}-${hexPart()}`;

/**
 * 会话 token 存储：Map<token, { createdAt }>
 * 不设过期 —— session cookie 关浏览器即失效；服务重启 Map 清空。
 */
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 从 Cookie 头里解析 lattice_session 的值
 * 没装 cookie-parser，自己用正则取，够用且零依赖
 */
function parseToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)lattice_session=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * 判断 token 是否有效
 */
function isTokenValid(token) {
  if (!token) return false;
  return sessions.has(token);
}

/**
 * requireAuth 中间件
 * - 已登录：next()
 * - 未登录 + /api/*：返回 401 JSON（前端 fetch 拦截器会跳锁屏页）
 * - 未登录 + 页面：重定向到 /login.html
 */
function requireAuth(req, res, next) {
  const token = parseToken(req.headers.cookie);
  if (isTokenValid(token)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized', login: true });
  }
  return res.redirect('/login.html');
}

const router = express.Router();

/**
 * POST /api/login  { password }
 * 验证密码，成功下发 session cookie
 */
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== PASSWORD) {
    return res.status(401).json({ ok: false, error: '密码错误' });
  }
  const token = generateToken();
  sessions.set(token, { createdAt: Date.now() });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ ok: true });
});

/**
 * POST /api/logout
 * 清除当前会话
 */
router.post('/logout', (req, res) => {
  const token = parseToken(req.headers.cookie);
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

/**
 * GET /api/auth
 * 检查当前是否已登录（供前端判断）
 */
router.get('/auth', (req, res) => {
  const token = parseToken(req.headers.cookie);
  res.json({ loggedIn: isTokenValid(token) });
});

module.exports = {
  COOKIE_NAME,
  PASSWORD,
  PASSWORD_IS_RANDOM,
  requireAuth,
  isTokenValid,
  parseToken,
  router,
};
