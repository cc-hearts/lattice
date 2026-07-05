# Lattice · 局域网小聚点

> 在同一局域网内，无需互联网，文件、剪贴板、便签、链接随手共享。

## 特性

- 📁 **文件共享** - 拖拽上传，自动列出，所有节点可见可下载
- 🔄 **跨节点自动同步 (V0.2)** - A 上传的文件自动推一份给 B、C，所有节点都有完整副本
- 🔐 **浏览器访问锁** - 启动生成一次性访问码，输入密码才能进页面操作
- 🔒 **节点间密钥鉴权** - 用 `LATTICE_SECRET` 防止陌生节点乱推同步数据
- 📋 **剪贴板同步 (V0.3 全网同步)** - 一端粘贴，所有设备秒同步
- 📝 **共享便签 (V0.3 全网同步)** - 像便利贴一样，写下就贴上
- 🔗 **链接快传 (V0.3 全网同步)** - 投一个 URL，全员可点
- 🔍 **自动发现** - 同网段自动识别其他节点，不用记 IP
- 🔄 **实时刷新** - WebSocket 推送，对方一动你就看见
- 🚫 **去重 + 循环防护 (V0.3)** - 不会无限循环推送

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

```bash
# 自定义端口 + 节点名
PORT=8888 LATTICE_NAME=客厅的Mac node server/index.js

# 用固定访问密码（长期使用，免每次抄随机码）
LATTICE_PASSWORD=你家密码 npm start

# 开启跨节点同步（所有节点需设同一个 secret）
LATTICE_SECRET=同步密钥 LATTICE_PASSWORD=访问密码 npm start
```

## 目录结构

```
lattice/
├── server/           后端
│   ├── index.js      入口
│   ├── auth.js       访问锁（一次性访问码 + session）
│   ├── discovery.js  UDP 广播自动发现
│   ├── store.js      本地存储
│   ├── ws.js         WebSocket
│   ├── sync.js       跨节点同步
│   └── api/          REST API
├── public/           前端（主页 + 锁屏页）
└── data/             运行时数据（自动创建）
```

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/login | 登录（输入访问密码，下发 session cookie） 🟢公开 |
| POST | /api/logout | 登出 |
| GET  | /api/auth | 查询当前是否已登录 🟢公开 |
| GET  | /api/info | 节点信息 + 邻居 |
| GET  | /api/files | 文件列表 |
| POST | /api/files | 上传（multipart） |
| GET  | /api/files/:id | 下载 |
| DELETE | /api/files/:id | 删除 |
| GET  | /api/clipboard | 最新剪贴板 |
| POST | /api/clipboard | 推送剪贴板 |
| GET/POST/DELETE | /api/notes | 便签 CRUD |
| GET/POST/DELETE | /api/links | 链接 CRUD |
| POST | /api/sync | 跨节点同步接收端（用 `LATTICE_SECRET`） 🟢公开 |

> 除标注 🟢公开 的三个接口外，其余 `/api/*` 均需登录后的 session cookie。
> `/api/sync` 走节点间 `LATTICE_SECRET` 头校验，与浏览器锁互不干扰。

## 后续路线

- [x] ~~跨节点文件同步 (V0.2)~~
- [x] ~~便签/剪贴板/链接跨节点同步 (V0.3)~~
- [x] ~~删除跨节点同步 (V0.3)~~
- [x] ~~浏览器访问锁（一次性访问码 + session cookie）~~
- [ ] 失败重试 + 断点续传
- [ ] 文件预览（图片/PDF/视频）
- [ ] 节点间鉴权强化（基于节点名 + 共享密钥）
- [ ] PWA 离线缓存
- [ ] 桌面客户端（Electron）
- [ ] 文件夹结构 + 标签

## 许可

MIT
