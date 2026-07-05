# Lattice · 局域网小聚点

> 在同一局域网内，无需互联网，文件、剪贴板、便签、链接随手共享。

## 特性

- 📁 **文件共享** - 拖拽上传，自动列出，所有节点可见可下载
- 🔄 **跨节点自动同步 (V0.2)** - A 上传的文件自动推一份给 B、C，所有节点都有完整副本
- 🔐 **浏览器访问锁** - 启动生成一次性访问码，输入密码才能进页面操作
- 🔒 **节点间密钥鉴权 (V0.4 HMAC 强化)** - 用 `LATTICE_SECRET` + 节点名 + 时间戳签名，防重放防伪造
- 📋 **剪贴板同步 (V0.3 全网同步)** - 一端粘贴，所有设备秒同步
- 📝 **共享便签 (V0.3 全网同步)** - 像便利贴一样，写下就贴上
- 🔗 **链接快传 (V0.3 全网同步)** - 投一个 URL，全员可点
- 🔍 **自动发现** - 同网段自动识别其他节点，不用记 IP
- 🔄 **实时刷新** - WebSocket 推送，对方一动你就看见
- 🚫 **去重 + 循环防护 (V0.3)** - 不会无限循环推送
- 👁️ **文件预览 (V0.4)** - 图片 / PDF / 视频 / 音频 / 文本直接在线看
- 🧱 **分片上传 + 断点续传 (V0.4)** - 大文件切片，失败重试，网络断了接着传
- 🏷️ **标签 + 文件夹 (V0.4)** - 给文件打标签、归类，一键筛选
- 🔍 **文件搜索 (V0.5)** - 按文件名 / 标签 / 文件夹实时筛选，键入即过滤
- 📱 **扫码连接 (V0.5)** - 终端启动即打印二维码，页面也能展示，手机扫一下直连
- 🔐 **HTTPS 支持 (V0.5)** - 一键自签名证书，或自带证书；Secure Context 全功能可用
- 📦 **可嵌入服务 (V0.5)** - 服务模块导出 `startServer()`，Electron / nodejs-mobile 直接复用
- 📱 **PWA 离线缓存 (V0.4)** - 手机「加到主屏幕」像 App 一样用
- 💻 **桌面客户端 (V0.4 Electron)** - 系统托盘常驻，开机自启
- 📦 **移动端 App (V0.4 Capacitor)** - 同一套网页打成 iOS / Android 原生包

## 快速开始

```bash
# 安装依赖
npm install

# 启动
npm start
```

启动后终端会打印一个**访问密码**（形如 `LATTICE-9084-A3C8`）：

```
  🔒 访问密码: LATTICE-9084-A3C8   (本次随机生成, 重启换新)
```

把它告诉要使用的同事。同一局域网的设备浏览器打开 `http://<本机IP>:7777`，在锁屏页输入密码即可进入。

> 密码每次启动都会换新，重启即失效。想用固定密码见下方「配置项」。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `7777` | HTTP 服务端口 |
| `LATTICE_NAME` | 主机名 | 节点名，显示在页头 |
| `LATTICE_PASSWORD` | 随机生成 | 浏览器访问密码；不设则每次启动随机生成并打印到终端 |
| `LATTICE_SECRET` | 空 | 节点间同步密钥；不设则不向其他节点同步 |
| `LATTICE_ALLOWED_NODES` | 空 | V0.4 节点白名单（逗号分隔）；设了只允许指定节点名同步进来 |
| `LATTICE_HTTPS` | 空 | V0.5 设为 `1` 开启 HTTPS（自动生成自签名证书）|
| `LATTICE_CERT` | 空 | V0.5 HTTPS 证书路径（PEM），与 `LATTICE_KEY` 一起用 |
| `LATTICE_KEY` | 空 | V0.5 HTTPS 私钥路径（PEM）|

```bash
# 自定义端口 + 节点名
PORT=8888 LATTICE_NAME=客厅的Mac node server/index.js

# 用固定访问密码（长期使用，免每次抄随机码）
LATTICE_PASSWORD=你家密码 npm start

# 开启跨节点同步（所有节点需设同一个 secret）
LATTICE_SECRET=同步密钥 LATTICE_PASSWORD=访问密码 npm start

# V0.4 进一步收紧：只允许 Alice/Bob 两个节点同步进来
LATTICE_SECRET=同步密钥 LATTICE_ALLOWED_NODES=Alice,Bob npm start

# V0.5 开启 HTTPS（自动生成自签名证书，浏览器提示不安全属正常）
LATTICE_HTTPS=1 LATTICE_PASSWORD=访问密码 npm start

# V0.5 用自己的证书（如内网 CA 签的）
LATTICE_CERT=/path/cert.pem LATTICE_KEY=/path/key.pem npm start
```

## 目录结构

```
lattice/
├── server/           后端
│   ├── index.js      入口
│   ├── auth.js       访问锁（一次性访问码 + session）
│   ├── nodeauth.js   V0.4 节点间 HMAC 鉴权
│   ├── https.js      V0.5 HTTPS 证书（自签名 / 自带）
│   ├── qr.js         V0.5 二维码生成
│   ├── discovery.js  UDP 广播自动发现
│   ├── store.js      本地存储
│   ├── ws.js         WebSocket
│   ├── sync.js       跨节点同步（含重试）
│   └── api/          REST API
├── public/           前端（PWA 主页 + 锁屏页）
│   ├── manifest.json PWA 清单
│   ├── sw.js         Service Worker
│   └── icons/        应用图标（脚本生成）
├── mobile/           V0.4+ 移动端 App（Capacitor）
│   ├── www/          节点选择器页
│   └── node-main.js  V0.5 nodejs-mobile 入口（手机当节点）
├── electron/         V0.4 桌面客户端（Electron）
├── scripts/          工具脚本
│   ├── gen-icons.js  生成 PWA 图标
│   └── selftest.js   自检脚本
├── docs/MOBILE.md    移动端打包指南
└── data/             运行时数据（自动创建）
```

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/login | 登录（输入访问密码，下发 session cookie） 🟢公开 |
| POST | /api/logout | 登出 |
| GET  | /api/auth | 查询当前是否已登录 🟢公开 |
| GET  | /api/info | 节点信息 + 邻居 |
| GET  | /api/files | 文件列表（含标签/文件夹）|
| POST | /api/files | 上传（multipart，<50MB 直传）|
| POST | /api/files/chunk | V0.4 分片上传 |
| GET  | /api/files/chunk-status | V0.4 查询已传分片（断点续传）|
| POST | /api/files/merge | V0.4 合并分片 |
| GET  | /api/files/:id | 下载 / 内联预览（带 Content-Type）|
| GET  | /api/files/:id/preview | V0.4 预览元信息 |
| GET  | /api/qr?text= | V0.5 二维码（默认本节点地址） 🟢公开 |
| DELETE | /api/files/:id | 删除（V0.4 同步删除）|
| PATCH | /api/files/:id/meta | V0.4 更新标签/文件夹 |
| GET  | /api/clipboard | 最新剪贴板 |
| POST | /api/clipboard | 推送剪贴板 |
| GET/POST/DELETE | /api/notes | 便签 CRUD |
| GET/POST/DELETE | /api/links | 链接 CRUD |
| POST | /api/sync | 跨节点同步接收端（HMAC 鉴权） 🟢公开 |

> 除标注 🟢公开 的三个接口外，其余 `/api/*` 均需登录后的 session cookie。
> `/api/sync` 和 `/api/files/receive` 走节点间 HMAC 鉴权，与浏览器锁互不干扰。

## 多端形态

| 形态 | 怎么用 | 场景 |
|------|--------|------|
| 浏览器 | 打开 `http://<IP>:7777` | 临时用 |
| PWA | 浏览器「加到主屏幕」 | 手机日常用，离线可开壳 |
| 桌面客户端 | `npm run electron` | 电脑常驻，托盘后台 |
| 移动 App | Capacitor 打包（见 `docs/MOBILE.md`）| 上架 / 原生扫码 |

## 后续路线

- [x] ~~跨节点文件同步 (V0.2)~~
- [x] ~~便签/剪贴板/链接跨节点同步 (V0.3)~~
- [x] ~~删除跨节点同步 (V0.3)~~
- [x] ~~浏览器访问锁（一次性访问码 + session cookie）~~
- [x] ~~文件预览：图片/PDF/视频/音频/文本 (V0.4)~~
- [x] ~~分片上传 + 断点续传 + 推送重试 (V0.4)~~
- [x] ~~节点间鉴权强化（HMAC + 节点名 + 时间戳）(V0.4)~~
- [x] ~~标签 + 文件夹 (V0.4)~~
- [x] ~~PWA 离线缓存 (V0.4)~~
- [x] ~~桌面客户端 (V0.4 Electron)~~
- [x] ~~移动端 App (V0.4 Capacitor，iOS/Android)~~
- [x] ~~文件搜索 (V0.5)—— 按文件名 / 标签 / 文件夹实时筛选~~
- [x] ~~二维码扫码连接节点 (V0.5)—— 终端打印 + 页面展示 + 手机扫码闭环~~
- [x] ~~HTTPS 支持 (V0.5)—— 自签名证书或自带证书~~
- [x] ~~手机当节点 (V0.5 nodejs-mobile)—— 服务可嵌入，提供 `mobile/node-main.js` 入口；Android 可用，iOS 后台受限~~
- [ ] 节点间文件夹结构同步（目前只同步扁平文件）
- [ ] 便签 / 链接的富文本与图片

## 许可

MIT
