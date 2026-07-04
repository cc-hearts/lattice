/**
 * discovery.js - UDP 广播自动发现
 * ===========================================================================
 *
 * 原理：
 *   每个节点每 5 秒向 255.255.255.255:9999 广播一个心跳包
 *   心跳包内容：{ magic: 'LATTICE_V1', name, port, ts }
 *   同网段所有节点都能收到，自动把自己登记到 peers 列表
 *
 * 为什么用 UDP 广播？
 *   - 零配置：用户不用记 IP
 *   - 局域网内路由器默认会转发广播包（除非刻意屏蔽）
 *   - 性能开销小：每秒 1 个小包，几十个字节
 *
 * 局限（先知道，后续可优化）：
 *   - 跨网段不生效（如在不同 WiFi / 子网）
 *   - 某些企业 WiFi 会屏蔽广播
 *   - IPv6 不支持（v4 足够 MVP）
 *
 * 心跳包格式（JSON）：
 *   {
 *     "magic": "LATTICE_V1",  // 协议标识，过滤非 lattice 流量
 *     "name": "客厅的Mac",     // 节点名
 *     "port": 7777,           // HTTP 端口
 *     "ts": 1234567890        // 时间戳（调试用）
 *   }
 */

const dgram = require('dgram');
const store = require('./store');

const BROADCAST_ADDR = '255.255.255.255';   // 局域网广播地址
const DISCOVERY_PORT = 9999;                 // 固定的发现端口
const HEARTBEAT_INTERVAL = 5000;             // 5 秒发一次心跳
const MAGIC = 'LATTICE_V1';                  // 协议标识

/**
 * 启动 UDP 发现服务
 * @param {Object} opts
 * @param {number} opts.port - 本节点 HTTP 端口
 * @param {string} opts.name - 本节点名
 */
function startDiscovery({ port, name }) {
  // 创建 UDP socket，reuseAddr 允许多个进程绑同一端口（调试时方便）
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    console.error('[discovery] socket error:', err.message);
  });

  /**
   * 收到任何 UDP 包的回调
   * - 解析 JSON
   * - magic 不对就忽略（可能是别的协议占用 9999 端口）
   * - 是 lattice 节点就登记
   */
  socket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());

      // 协议校验
      if (data.magic !== MAGIC) return;

      // 忽略自己广播的回声（虽然 UDP 一般收不到自己的包，但防御性写一下）
      if (data.name === name) return;

      // 登记到 peers
      const peers = store.upsertPeer({
        name: data.name,
        ip: rinfo.address,   // rinfo.address 是发送方 IP
        port: data.port,     // 业务 HTTP 端口，不是 UDP 端口
      });

      console.log(`[discovery] 发现节点: ${data.name} @ ${rinfo.address}:${data.port} (共 ${peers.length})`);
    } catch (e) {
      // 解析失败：忽略非 lattice 流量
    }
  });

  /**
   * 绑定端口 + 开始广播
   * bind 后才能 send 到广播地址
   */
  socket.bind(DISCOVERY_PORT, () => {
    // 关键：必须 setBroadcast(true) 才能发广播包
    socket.setBroadcast(true);

    console.log(`[discovery] 监听 UDP ${DISCOVERY_PORT}，每 ${HEARTBEAT_INTERVAL / 1000}s 广播一次`);

    // 定时广播心跳
    setInterval(() => {
      const payload = Buffer.from(JSON.stringify({
        magic: MAGIC,
        name,
        port,
        ts: Date.now(),
      }));
      // 第二个参数是发送目标的 IP 和端口
      socket.send(payload, 0, payload.length, DISCOVERY_PORT, BROADCAST_ADDR);
    }, HEARTBEAT_INTERVAL);
  });
}

module.exports = { startDiscovery };
