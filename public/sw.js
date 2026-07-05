/**
 * sw.js - Lattice Service Worker（PWA 离线缓存）
 * ===========================================================================
 *
 * 策略：
 *   1. 应用外壳（HTML/CSS/JS/图标）  → 预缓存 + stale-while-revalidate
 *      离线时也能打开 App 壳子，进锁屏页 / 主界面框架
 *   2. API 数据（/api/*）            → network-first，失败回退缓存
 *      数据要尽量新，但断网时给你看上次的快照
 *   3. 文件下载（/api/files/:id）     → 不缓存（体积大，按需），但已下载的
 *      可被浏览器 HTTP 缓存复用
 *
 * 注意：
 *   - Service Worker 不能缓存 WebSocket，离线时实时推送自然失效，符合预期
 *   - 登录态 cookie 不会被 SW 干预，正常工作
 *   - 更新机制：每次 fetch 时后台拉新版外壳，下次刷新生效（避免卡老版本）
 * ===========================================================================
 */

const VERSION = 'lattice-v1';
const APP_SHELL = [
  '/',
  '/login.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg',
  '/favicon.png',
];

// 安装：预缓存应用外壳，立即激活
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // addAll 是原子的，任一失败会整体回滚；用逐个 add 容错（个别资源 401 也不影响）
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// 激活：清理旧版本缓存，立即接管
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET 请求，其他方法（POST/DELETE 等）直接放行
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // /api/files/:id 下载请求 —— 不缓存，让浏览器 HTTP 缓存处理
  if (url.pathname.startsWith('/api/files/') && !url.pathname.includes('chunk')) {
    return; // 直接走网络
  }

  // /api/* 数据请求 —— network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 应用外壳 —— stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req));
});

/**
 * 网络优先：先请求，失败用缓存兜底
 * 适合数据接口，保证新鲜度，断网有兜底
 */
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    // 只缓存成功的 JSON 响应（避免缓存 401/500）
    if (res.ok) {
      const cache = await caches.open(VERSION + '-api');
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw e;
  }
}

/**
 * 后台更新策略：先返回缓存（快），同时后台拉新版更新缓存
 * 适合应用外壳，秒开且能静默升级
 */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      // 只缓存成功的响应
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => cached); // 网络失败就回退缓存（已在前面返回）
  return cached || network;
}

// 收到主页面发来的更新消息：立即激活新 SW
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
