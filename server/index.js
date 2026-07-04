/**
 * Lattice - 局域网内的小聚点
 * ===========================================================================
 * 入口文件：负责组装所有模块，并启动三个服务：
 *   1. HTTP 服务      - 静态文件 + REST API
 *   2. WebSocket 服务 - 实时推送变更通知给浏览器
 *   3. UDP 广播服务   - 自动发现同网段的其他 Lattice 节点
 *
 * 启动方式：
 *   node server/index.js
 *   PORT=8888 LATTICE_NAME=客厅的Mac node server/index.js
 *
 * 架构图：
 *
 *   ┌──────────────┐   HTTP    ┌──────────────┐   UDP广播   ┌──────────────┐
 *   │   浏览器     │ ◄──────► │  本机服务     │ ◄────────► │ 其他节点     │
 *   │ (public/)    │  WS      │ (server/)    │   9999     │  (LAN)       │
 *   └──────────────┘          └──────────────┘            └──────────────┘
 *                                  │
 *                                  ▼
 *                            data/ 文件夹
 *                            (文件 + JSON)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const os = require('os');
const { WebSocketServer } = require('ws');

// 引入各功能模块
const { startDiscovery } = require('./discovery');     // UDP 自动发现
const { attachWebSocket } = require('./ws');             // WebSocket 实时推送
const filesApi = require('./api/files');                 // 文件 API
const clipboardApi = require('./api/clipboard');         // 剪贴板 API
const notesApi = require('./api/notes');                 // 便签 API
const linksApi = require('./api/links');                 // 链接 API
const { router: syncRouter } = require('./sync');        // 跨节点同步路由（V0.3）
const store = require('./store');                        // 存储层

// 配置：可从环境变量覆盖
const PORT = process.env.PORT || 7777;
// 节点名默认用本机主机名，可通过 LATTICE_NAME 自定义
const NODE_NAME = process.env.LATTICE_NAME || os.hostname();

/**
 * 主函数：异步启动所有服务
 * 使用 async 是因为 store.init() 需要等待目录创建
 */
async function main() {
  // 1. 初始化存储（创建 data/ 目录和初始 JSON 文件）
  await store.init();

  // 2. 创建 Express 应用
  const app = express();

  // 跨域支持：方便本地开发时前端用别的端口调试
  app.use(cors());

  // 解析 JSON 请求体，限制 5MB（便签/剪贴板够用）
  app.use(express.json({ limit: '5mb' }));

  // 静态文件服务：public/ 目录下的 HTML/CSS/JS 直接对外提供
  // 访问 http://localhost:7777/ 就会返回 public/index.html
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 3. 挂载 REST API
  // 注意：/api/files 等子模块自己处理具体路径
  app.use('/api/files', filesApi);
  app.use('/api/clipboard', clipboardApi);
  app.use('/api/notes', notesApi);
  app.use('/api/links', linksApi);
  app.use('/api/sync', syncRouter);  // V0.3 跨节点同步接收端

  /**
   * 健康检查 + 节点信息接口
   * 前端每 5 秒调用一次，用来显示"我在线"和"邻居有几个"
   */
  app.get('/api/info', (req, res) => {
    res.json({
      name: NODE_NAME,           // 本节点名
      port: PORT,                // 本节点端口
      version: '0.1.0',          // 协议版本
      peers: store.getPeers(),   // 通过 UDP 发现的邻居
    });
  });

  // 4. 创建 HTTP Server 并挂载 WebSocket
  // WebSocket 路径是 /ws，浏览器通过 new WebSocket('ws://host/ws') 连接
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  attachWebSocket(wss);

  /**
   * 5. 启动 HTTP 服务，监听 0.0.0.0（所有网卡接口）
   * 用 0.0.0.0 而不是 127.0.0.1 是因为局域网内其他设备要能访问
   */
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Lattice 已启动`);
    console.log(`  本机访问: http://localhost:${PORT}`);
    console.log(`  节点名:  ${NODE_NAME}`);
    console.log(`  按 Ctrl+C 退出\n`);
  });

  // 6. 启动 UDP 广播发现
  startDiscovery({ port: PORT, name: NODE_NAME });
}

// 启动入口：捕获异常防止静默失败
main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
