# 移动端 App（iOS / Android）

> Lattice 的网页本身就是 PWA，可以直接「加到主屏幕」当 App 用。
> 本文档讲的是：**如何用 Capacitor 把它打包成真·App（可上架 / 独立安装包）**，
> 以及「手机自己当节点」的进阶方案。

---

## 一、可行性结论

| 诉求 | 可行性 | 说明 |
|------|--------|------|
| 手机当**客户端**，连桌面节点 | ✅ 完全可行 | 本文档主线，Capacitor 包一层即可 |
| 手机当**节点**（跑 Lattice 服务） | ⚠️ 可行但受限 | 见文末「进阶：nodejs-mobile」|

---

## 二、客户端 App（推荐，主线）

### 工作原理

App 启动后显示一个「节点选择器」页（`mobile/www/index.html`）：

```
┌─────────────────────┐
│      [Lattice]      │
│  连接到节点          │
│ ┌─────────────────┐ │
│ │ http://192.168.. │ │
│ └─────────────────┘ │
│ [连接]               │
│ 最近连接：           │
│  · 192.168.1.5:7777 │
└─────────────────────┘
```

输入电脑上 Lattice 的局域网地址 → WebView 跳转过去 → 之后就是正常 PWA。
**因为最终页面和 API 同源**（都在 `http://<节点>:7777`），cookie / WebSocket / 文件下载全部正常，**零服务端改动**。

### 准备

1. 安装 Node.js（已有）
2. Android：安装 [Android Studio](https://developer.android.com/studio)（含 SDK）
3. iOS：需要 **macOS + Xcode**（Windows 无法本地打包 iOS，见下文「iOS 云构建」）

### 打包步骤

```bash
# 1. 安装 Capacitor 依赖
npm install

# 2. 添加平台（按需）
npx cap add android      # 生成 android/ 工程
npx cap add ios          # 仅 macOS 上可执行；Windows 会跳过

# 3. 同步 web 资源到原生工程
npx cap sync

# 4. 用 IDE 打开并构建
npx cap open android     # 在 Android Studio 里 Run / Build APK/AAB
npx cap open ios         # 在 Xcode 里 Run / Archive
```

构建产物：

- Android：`android/app/build/outputs/apk/...`（APK 直接安装）或 AAB（上架 Play Store）
- iOS：Xcode → Archive → IPA（上架 App Store）

### 配置要点

- `capacitor.config.json` 里已开 `server.cleartext: true` 和 `android.allowMixedContent: true`，允许 HTTP 局域网访问（Lattice 默认不走 HTTPS）。
- `allowNavigation: ["*"]` 允许 WebView 跳转到任意节点地址。如需收紧，可改成具体的内网网段，如 `["192.168.*:*", "10.*:*", "172.16.*:*", "*.local:*", "localhost:*"]`。
- **iOS 额外一步**：默认禁止 HTTP 明文。在 Xcode 里打开 `ios/App/App/Info.plist`，加入 ATS 例外允许局域网 HTTP：

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

（上架审核时建议只留 `NSAllowsLocalNetworking`，苹果对纯局域网工具通常放行。）

### iOS 云构建（无 Mac 用户）

Windows 上没法跑 Xcode，两个办法：

1. **Expo EAS Build**（推荐）：把 Capacitor 工程用 EAS 托管构建，云端出 IPA。
2. **GitHub Actions**：用 `macos-latest` runner 跑 `xcodebuild archive`，自动出包。

### 切换节点 / 返回选择器

- Android：按系统**返回键**，WebView 历史回退到选择器页。
- iOS：关闭 App 重开，会回到选择器页（选择器是启动页）。

### 加二维码扫码（可选）

选择器页已预留「扫码连接」按钮，需要扫码功能时：

```bash
npm install @capacitor-community/barcode-scanner
npx cap sync
```

装上后按钮自动出现，扫电脑端展示的二维码即可填入地址。

> V0.5 起，电脑端启动时会在终端打印二维码，主页右上角「📱 扫码」按钮也会弹出二维码页面，手机扫一下就能连，不用手抄 IP。

---

## 三、进阶：手机当节点（nodejs-mobile）

> 让手机自己跑 Lattice 服务，两台手机就能互传，不依赖电脑。
> **仅建议 Android 深入做；iOS 因后台限制基本不实用。**

### 可行性

| 平台 | 跑 Node 服务 | 后台保活 | 备注 |
|------|-------------|----------|------|
| Android | ✅ [nodejs-mobile](https://github.com/staltz/nodejs-mobile) | ⚠️ 前台服务，费电 | 可用，需保活 |
| iOS | ✅ nodejs-mobile | ❌ 后台几秒挂起 | 仅前台可用，体验差 |

### 关键限制

1. **iOS 后台挂起**：App 切后台 3~30 秒就被系统冻结，HTTP/UDP 全停。要让手机当节点，必须保持 App 在前台亮屏——基本不可用。
2. **端口绑定**：前台时可绑定 7777，其他设备可访问；后台即失效。
3. **UDP 广播**：前台可广播发现包，后台停止。
4. **体积**：Node 运行时 +30~40MB。
5. **依赖兼容**：`multer`、`ws`、`express` 都能在 nodejs-mobile 跑；`dgram`（UDP 发现）也支持。

### 实现思路（Android）

V0.5 已完成代码侧准备，剩下的是原生打包：

1. **服务已可嵌入**：`server/index.js` 导出 `startServer(options)`，不再在 `require` 时自动启动。`mobile/node-main.js` 是 nodejs-mobile 的入口，已处理好数据目录、端口、静默日志、UDP 开关。
2. **安装插件**：
   ```bash
   npm install nodejs-mobile-capacitor
   npx cap sync
   ```
3. **打包 node 资源**：把 `server/` 和 `mobile/node-main.js` 一起作为 nodejs-mobile 的启动资源（插件会把 `node-assets/` 下的 `main.js` 及其依赖打进 APK）。把 `mobile/node-main.js` 作为入口，`server/` 放在同目录。
4. **原生层注入环境变量**：在启动 node 前，设置：
   - `LATTICE_MOBILE_DATA` = App 私有目录路径（服务把数据写这里）
   - `LATTICE_NAME` = 手机型号 / 用户自定义节点名（可选）
   - `LATTICE_NO_DISCOVERY=1`（iOS 后台场景关掉 UDP 广播）
   - `LATTICE_SECRET`（可选，想让多台手机互同步时设同一个）
5. **启动后用 WebView 加载** `http://127.0.0.1:7777`（本机自连，走的是本机回环，不经过网络）。
6. **Android 用 Foreground Service 保活**（带常驻通知），否则息屏后进程可能被杀。
7. **状态回调**：`node-main.js` 在服务就绪后会 `process.send({ event: 'lattice:ready', url })`，原生层收到后再加载 WebView，避免白屏。

> 提示：`mobile/node-main.js` 默认 `quiet: true`，日志走 `console.log` 进 logcat，调试时 `adb logcat | grep lattice-mobile` 即可看到。

### 为什么 iOS 不建议做

苹果明确限制后台网络服务，且审核会拒「伪装成服务器」的 App。即便用 nodejs-mobile 跑起来，前台一切正常，切后台就断，对「小聚点」这种随时分享的场景体验很差。

**结论**：纯手机场景请准备一台 Android 当常驻节点，或继续用电脑当节点。

---

## 四、和 PWA 的关系

| 形态 | 安装方式 | 离线壳 | 后台 | 上架 |
|------|----------|--------|------|------|
| PWA | 浏览器「加到主屏幕」 | ✅ SW 缓存 | ❌ | ❌ |
| Capacitor App | APK/IPA 安装 | ✅ | ✅（Android） | ✅ |

**大多数场景用 PWA 就够了**。需要上架 / 需要原生扫码 / 需要常驻通知时，再用 Capacitor。
