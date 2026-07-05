/**
 * node-main.js - nodejs-mobile 入口（V0.5）
 * ===========================================================================
 *
 * 让手机自己当一个 Lattice 节点，两台手机/手机+电脑 互传，
 * 不依赖电脑常驻。
 *
 * 工作方式：
 *   原生壳（Android）用 nodejs-mobile-capacitor 插件启动一个 Node 运行时，
 *   执行本文件。本文件 require 同一份 server/ 代码，把 HTTP/WS/UDP 服务跑起来，
 *   数据写到 App 私有目录。原生 UI（WebView）加载 http://127.0.0.1:7777 自连。
 *
 * 部署：
 *   1. npm install nodejs-mobile-capacitor
 *   2. npx cap sync
 *   3. 把 server/ 复制到 android/app/src/main/assets/nodejs-mobile/ （或用插件配置）
 *   4. 插件启动时传入 { args: ['mobile/node-main.js'] }
 *
 *   详见 docs/MOBILE.md「进阶：手机当节点」一节。
 *
 * 限制（重要）：
 *   - iOS：App 切后台 3~30 秒被系统冻结，HTTP/UDP 全停，仅前台可用
 *   - Android：需用 Foreground Service（带常驻通知）保活，否则息屏后可能被杀
 *   - 因此本文件默认 noDiscovery=false（保留 UDP 发现），iOS 上可传 noDiscovery:true
 * ===========================================================================
 */

// nodejs-mobile 把 App 私有目录路径放进 LATTICE_MOBILE_DATA 环境变量
// （由原生层注入；找不到则退回相对路径，方便桌面调试）
const path = require('path');
const dataDir = process.env.LATTICE_MOBILE_DATA || path.join(__dirname, '..', 'data');

// 节点名：手机型号 / 自定义（原生层可注入 LATTICE_NAME）
if (!process.env.LATTICE_NAME) {
  process.env.LATTICE_NAME = '手机节点';
}

// 端口：前台绑 7777，其他设备访问 http://<手机IP>:7777
if (!process.env.PORT) {
  process.env.PORT = '7777';
}

// 单机模式默认不开节点间同步（手机当节点时一般单机用；
// 想让多台手机互相同步，原生层注入 LATTICE_SECRET 即可）
const { startServer } = require('../server/index.js');

startServer({
  dataDir,
  // 手机上 stdout 会被插件重定向到 logcat，没必要打横幅
  quiet: true,
  // iOS 后台挂起时 UDP 广播无意义，原生层可注入 LATTICE_NO_DISCOVERY=1 关掉
  noDiscovery: process.env.LATTICE_NO_DISCOVERY === '1',
}).then(({ url }) => {
  // 通知原生层服务已就绪（nodejs-mobile-capacitor 的 eventChannel）
  if (typeof process.send === 'function') {
    process.send({ event: 'lattice:ready', url });
  }
  // 兜底：也写一行普通日志，logcat 可见
  console.log('[lattice-mobile] ready at', url);
}).catch((err) => {
  console.error('[lattice-mobile] 启动失败:', err);
  if (typeof process.send === 'function') {
    process.send({ event: 'lattice:error', error: String(err) });
  }
});

// 原生层退出信号：清理资源
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
