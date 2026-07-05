/**
 * Lattice - 局域网内的小聚点
 * ===========================================================================
 * 入口文件：负责组装所有模块，并启动三个服务：
 *   1. HTTP(S) 服务    - 静态文件 + REST API（V0.5 可选 HTTPS）
 *   2. WebSocket 服务  - 实时推送变更通知给浏览器
 *   3. UDP 广播服务    - 自动发现同网段的其他 Lattice 节点
 *
 * 启动方式：
 *   直接运行：  node server/index.js
 *   自定义：    PORT=8888 LATTICE_NAME=客厅的Mac node server/index.js
 *
 * 可嵌入（V0.5）：
 *   const { startServer } = require('./server');
 *   await startServer({ port: 7777, name: '手机', dataDir: '/app/data', quiet: true });
 *   供 Electron 桌面端、nodejs-mobile 移动端复用同一份服务逻辑。
 *
 * 架构图：
 *
 *   ┌──────────────┐   HTTP(S) ┌──────────────┐   UDP广播   ┌──────────────┐
 *   │   浏览器     │ ◄───────► │  本机服务     │ ◄────────► │ 其他节点     │
 *   │ (public/)    │  WS       │ (server/)    │   9999     │  (LAN)       │
 *   └──────────────┘           └──────────────┘            └──────────────┘
 *                                  │
 *                                  ▼
 *                            data/ 文件夹
 *                            (文件 + JSON)
 */

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const cors = require('cors');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

/**
 * 获取本机的局域网 IPv4 地址
 * 优先返回第一个非内部、非虚拟的 IPv4 地址
 * @returns {string} 形如 "192.168.1.100"，找不到则返回 "127.0.0.1"
 *
 * 为什么不用 ipconfig/ifconfig？
 *   - 跨平台，Node 原生支持
 *   - 比子进程调用快 1000 倍
 *   - 解析逻辑可控（跳过虚拟网卡、APIPA 169.254.x.x 等）
 */
function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // 跳过内部回环、IPv6、非 running
      if (net.family !== 'IPv4' || net.internal) continue;
      // 跳过 APIPA（169.254.x.x，没连上路由器时系统自己分配的）
      if (net.address.startsWith('169.254.')) continue;
      return net.address;
    }
  }
  return '127.0.0.1';
}

/**
 * 主函数：异步启动所有服务
 * 使用 async 是因为 store.init() 需要等待目录创建
 *
 * @param {Object} [options]
 * @param {number} [options.port]        覆盖 PORT
 * @param {string} [options.name]        覆盖 LATTICE_NAME
 * @param {string} [options.dataDir]     覆盖 LATTICE_DATA_DIR
 * @param {string} [options.secret]      覆盖 LATTICE_SECRET（节点间同步密钥）
 * @param {string} [options.password]    覆盖 LATTICE_PASSWORD（浏览器访问密码）
 * @param {boolean} [options.quiet=false] 静默模式：不打印启动横幅（嵌入式场景用）
 * @param {boolean} [options.noDiscovery=false] 不启动 UDP 发现（nodejs-mobile iOS 后台受限时用）
 * @returns {Promise<{server: Object, app: Object, url: string}>}
 */
async function startServer(options = {}) {
  // 1. 把 options 写进 env，让子模块在 require 时读到
  //    子模块（store/auth/nodeauth/sync/files）都在 require 顶部读 env，
  //    所以必须在 require 它们之前设好。
  if (options.port != null) process.env.PORT = String(options.port);
  if (options.name != null) process.env.LATTICE_NAME = options.name;
  if (options.dataDir != null) process.env.LATTICE_DATA_DIR = options.dataDir;
  if (options.secret != null) process.env.LATTICE_SECRET = options.secret;
  if (options.password != null) process.env.LATTICE_PASSWORD = options.password;

  const quiet = !!options.quiet;
  const noDiscovery = !!options.noDiscovery;

  // 2. require 子模块（require 有缓存，重复调用零成本）
  const { startDiscovery } = require('./discovery');     // UDP 自动发现
  const { attachWebSocket } = require('./ws');             // WebSocket 实时推送
  const filesApi = require('./api/files');                 // 文件 API
  const clipboardApi = require('./api/clipboard');         // 剪贴板 API
  const notesApi = require('./api/notes');                 // 便签 API
  const linksApi = require('./api/links');                 // 链接 API
  const { router: syncRouter } = require('./sync');        // 跨节点同步路由（V0.3）
  const auth = require('./auth');                          // 浏览器访问鉴权（一次性访问码）
  const store = require('./store');                        // 存储层
  const httpsUtil = require('./https');                    // V0.5 HTTPS 证书
  const qr = require('./qr');                              // V0.5 二维码

  // 配置：可从环境变量覆盖
  const PORT = Number(process.env.PORT) || 7777;
  // 节点名默认用本机主机名，可通过 LATTICE_NAME 自定义
  const NODE_NAME = process.env.LATTICE_NAME || os.hostname();
  const lanIP = getLocalIPv4();
  const useHttps = httpsUtil.isEnabled();

  // 3. 初始化存储（创建 data/ 目录和初始 JSON 文件）
  await store.init();

  // 4. 创建 Express 应用
  const app = express();

  // 跨域支持：方便本地开发时前端用别的端口调试
  app.use(cors());

  // 解析 JSON 请求体，限制 5MB（便签/剪贴板够用）
  app.use(express.json({ limit: '5mb' }));

  // 5. 设置二维码默认内容（本节点局域网 URL）
  const nodeUrl = `${useHttps ? 'https' : 'http'}://${lanIP}:${PORT}`;
  qr.setDefaultText(nodeUrl);

  // 6. 挂载中间件 & 路由
  // 顺序很关键：公开路由 → 鉴权门槛 → 受保护路由
  //
  //   公开：/api/login  /api/logout  /api/auth  （auth.router）
  //         /api/sync   （节点间同步，用 LATTICE_SECRET，不走浏览器锁）
  //         /api/qr     （V0.5 二维码，只编码地址不含密码）
  //         /login.html （锁屏页本身要能打开）
  //   门槛：auth.requireAuth（未登录 → API 返 401，页面跳 /login.html）
  //   保护：静态资源 + 浏览器用 REST API
  app.use('/api', auth.router);                       // 登录 / 登出 / 状态
  app.use('/api/sync', syncRouter);                   // V0.3 跨节点同步接收端
  app.use('/api/qr', qr.router);                      // V0.5 二维码（公开）
  app.get('/login.html', (req, res) => {              // 锁屏页（已登录则跳主页）
    const token = auth.parseToken(req.headers.cookie);
    if (auth.isTokenValid(token)) return res.redirect('/');
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });

  // PWA 资源公开访问：manifest、service worker、图标
  // 即使未登录也要能加载，否则手机端无法「添加到主屏幕」
  app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'manifest.json'));
  });
  app.get('/sw.js', (req, res) => {
    // SW 必须不缓存，否则更新推不下去
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });
  app.get('/favicon.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'icons', 'favicon.png'));
  });

  app.use(auth.requireAuth);                          // ← 鉴权门槛

  // 静态文件服务：public/ 目录下的 HTML/CSS/JS（走到这里说明已登录）
  // 访问 http://localhost:7777/ 就会返回 public/index.html
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 浏览器用 REST API（子模块自己处理具体路径）
  app.use('/api/files', filesApi);
  app.use('/api/clipboard', clipboardApi);
  app.use('/api/notes', notesApi);
  app.use('/api/links', linksApi);

  /**
   * 健康检查 + 节点信息接口
   * 前端每 5 秒调用一次，用来显示“我在线”和“邻居有几个”
   * V0.5 增加 lanIp / url / https 字段，供前端展示二维码用
   */
  app.get('/api/info', (req, res) => {
    res.json({
      name: NODE_NAME,           // 本节点名
      port: PORT,                // 本节点端口
      version: '0.5.0',          // 协议版本
      peers: store.getPeers(),   // 通过 UDP 发现的邻居
      lanIp: lanIP,              // V0.5 局域网 IP
      url: nodeUrl,              // V0.5 完整访问 URL
      https: useHttps,           // V0.5 是否走 HTTPS
    });
  });

  // 7. 创建 HTTP(S) Server 并挂载 WebSocket
  // WebSocket 路径是 /ws，浏览器通过 new WebSocket('ws(s)://host/ws') 连接
  let server;
  if (useHttps) {
    const credentials = await httpsUtil.getCredentials([lanIP, os.hostname(), 'localhost']);
    server = https.createServer(credentials, app);
  } else {
    server = http.createServer(app);
  }
  const wss = new WebSocketServer({ server, path: '/ws' });
  attachWebSocket(wss);

  /**
   * 8. 启动服务，监听 0.0.0.0（所有网卡接口）
   * 用 0.0.0.0 而不是 127.0.0.1 是因为局域网内其他设备要能访问
   */
  await new Promise((resolve, reject) => {
    server.listen(PORT, '0.0.0.0', () => resolve());
    server.once('error', reject);
  });

  if (!quiet) {
    const scheme = useHttps ? 'https' : 'http';
    console.log(`\n  Lattice 已启动`);
    console.log(`  本机访问: ${scheme}://localhost:${PORT}`);
    console.log(`  局域网访问: ${nodeUrl}    ← 给同网段其他设备用`);
    console.log(`  节点名:  ${NODE_NAME}`);
    if (useHttps) {
      console.log(`  🔒 HTTPS 已开启（自签名证书，浏览器提示不安全属正常）`);
    }
    console.log(`  🔒 访问密码: ${auth.PASSWORD}` +
      (auth.PASSWORD_IS_RANDOM ? '   (本次随机生成, 重启换新)' : '   (来自 LATTICE_PASSWORD)'));
    console.log(`     把密码发给要使用的设备, 在锁屏页输入即可进入`);
    // V0.5 终端打印二维码：手机扫码直达，免抄 IP
    try {
      const termQr = await QRCode.toString(nodeUrl, { type: 'terminal', small: true });
      console.log(`  📱 扫码连接:`);
      console.log(termQr.split('\n').map((l) => '    ' + l).join('\n'));
    } catch {
      // 终端不支持颜色字符也没关系，URL 已经打印在上面
    }
    console.log(`  按 Ctrl+C 退出\n`);
  }

  // 9. 启动 UDP 广播发现（nodejs-mobile iOS 后台受限时可关闭）
  if (!noDiscovery) {
    startDiscovery({ port: PORT, name: NODE_NAME });
  }

  return { server, app, url: nodeUrl };
}

// 直接运行时自动启动；被 require 时由调用方决定何时 startServer()
if (require.main === module) {
  startServer().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = { startServer, getLocalIPv4 };
