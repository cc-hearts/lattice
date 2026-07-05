# 桌面客户端打包（Windows / macOS）

> Lattice 桌面端用 **Electron** 包一层：主进程内直接跑 `server/` 的 HTTP/WS/UDP 服务，
> `BrowserWindow` 加载 `http://127.0.0.1:<端口>`。关窗最小化到托盘，不退出。
>
> V0.5 起 `server/index.js` 导出 `startServer()`，Electron 主进程（`electron/main.js`）以
> 可嵌入方式复用同一份服务代码，不再依赖 `require` 副作用。

---

## 一、开发模式

```bash
npm install          # 首次需要（见下「依赖注意」）
npm run electron     # 直接启动，自带调试
```

启动后：
- 自动探测空闲端口（避免 7777 被占用），终端打印访问密码和二维码
- 系统托盘出现 Lattice 图标，关窗最小化到托盘
- 数据写到 `userData/data`（不是项目里的 `data/`），卸载 App 不会残留

## 二、打包成安装包

```bash
# Windows：生成 NSIS 安装包（dist/Lattice Setup x.x.x.exe）
npm run electron:dist

# 仅打未压缩目录（快，用于验证打包链路）
npm run electron:build
```

产物在 `dist/`（已 gitignore，不入库）：

| 文件 | 说明 |
|------|------|
| `Lattice Setup 0.5.0.exe` | NSIS 安装器，双击安装，可选安装目录 |
| `win-unpacked/Lattice.exe` | 免安装版，整个文件夹拷走即用 |
| `latest.yml` + `.blockmap` | 自动更新元数据（搭配 electron-updater 用） |

## 三、依赖注意（重要）

### 1. Electron 二进制下载

`npm install` 时 electron 的 postinstall 要从 GitHub 下载二进制，国内网络常超时。
用淘宝镜像：

```bash
# 一次性补下载（已装依赖但二进制缺失时）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

# 或安装时直接设
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

### 2. Windows 打包的符号链接坑（winCodeSign）

**现象**：`npm run electron:dist` 报错：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权
  .../winCodeSign/<hash>/darwin/10.12/lib/libcrypto.dylib
```

**原因**：electron-builder 解压 `winCodeSign` 缓存时，里面带的 macOS 符号链接
（`.dylib`）在 Windows 上需要「创建符号链接」权限，普通用户没有。

**三种解法**（任选其一）：

1. **已默认采用**：`package.json` 的 `build.win.signAndEditExecutable: false`
   跳过签名+改 exe 资源步骤，winCodeSign 就不会被解压。本地自建、无代码签名
   证书的场景用这个最省事（Lattice 默认就是这种）。
2. **以管理员身份**运行终端再打包（能创建符号链接）。
3. **开启 Windows 开发者模式**：设置 → 隐私和安全性 → 开发者选项 → 开发者模式，
   之后普通用户也能建符号链接，一劳永逸。

> 想给 exe 做正式代码签名（消除 SmartScreen 警告）时，把 `signAndEditExecutable`
> 改回 `true` 并配 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 指向证书，按解法 2/3 处理
> 符号链接权限。

### 3. electron-builder 辅助二进制

打包时还要下 `nsis`、`winCodeSign` 等，国内同样可能慢/超时，用镜像：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 四、macOS 打包

**必须在 macOS 上打**（electron-builder 无法在 Windows 交叉编译 .dmg，签名/公证也依赖
macOS 工具链）。

在 Mac 上：

```bash
npm install
npm run electron:dist    # 产出 dist/Lattice-0.5.0.dmg
```

`package.json` 已配 `mac.target: dmg`。若要上架，额外配 `mac.identity` /
`mac.notarize` 做苹果公证。

## 五、和「直接 npm start」的区别

| 形态 | 启动 | 数据目录 | 托盘 | 自启 |
|------|------|----------|------|------|
| `npm start` | 命令行 node | 项目 `data/` | ❌ | ❌ |
| Electron 开发 `npm run electron` | 命令行 electron | `userData/data` | ✅ | ❌ |
| Electron 安装包 | 双击 exe | `userData/data` | ✅ | 系统级配置后可 |

桌面客户端适合「常驻后台、开机就用」的场景；临时用 `npm start` 更轻量。
