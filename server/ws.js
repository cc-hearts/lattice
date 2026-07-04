/**
 * ws.js - WebSocket 实时推送
 * ===========================================================================
 *
 * 用途：
 *   当一个节点的数据发生变化时（文件上传、便签添加等），
 *   其他所有节点的浏览器应该立即看到，而不是靠轮询。
 *
 * 工作方式：
 *   1. 浏览器打开页面时建立 ws://host/ws 连接
 *   2. 服务端 api/* 路由调用 broadcast({ type: 'files:changed' })
 *   3. 所有连着的客户端都会收到推送
 *   4. 客户端根据 type 决定刷新哪个 Tab
 *
 * 事件类型约定：
 *   - files:changed       文件列表有变化
 *   - clipboard:changed   剪贴板有变化
 *   - notes:changed       便签有变化
 *   - links:changed       链接有变化
 *
 * 注意：
 *   - 这是"通知"机制，不传具体数据，客户端收到后自己重新拉取
 *   - 简单可靠，数据一致性由客户端轮询兜底
 */

const clients = new Set();

/**
 * 挂载到 WebSocketServer
 * 在 server/index.js 中调用
 */
function attachWebSocket(wss) {
  wss.on('connection', (ws) => {
    clients.add(ws);

    // 关闭/出错时清理
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));

    // 连接后打个招呼（调试用，也可用于鉴权挑战）
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

    console.log(`[ws] 新客户端连接，当前在线: ${clients.size}`);
  });
}

/**
 * 向所有连接的客户端广播事件
 * @param {Object} event - { type: 'xxx:changed', ...其他可选字段 }
 */
function broadcast(event) {
  const msg = JSON.stringify({ ...event, ts: Date.now() });

  for (const ws of clients) {
    // readyState === 1 表示 OPEN
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch (e) {
        // 单个客户端失败不影响其他
      }
    }
  }
}

module.exports = { attachWebSocket, broadcast };
