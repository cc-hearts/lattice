# Lattice 使用演示

> 从零到跑起来，5 分钟搞定。

## 1. 安装和启动

```bash
# 进入项目目录
cd "C:/Users/73624/WorkBuddy AI/2026-07-04-23-22-21/lattice"

# 安装依赖（首次）
npm install

# 启动
npm start
```

看到这样的输出就成功了：

```
  Lattice 已启动
  本机访问: http://localhost:7777
  节点名:  YOUR-PC
  按 Ctrl+C 退出

[discovery] 监听 UDP 9999，每 5s 广播一次
```

## 2. 浏览器打开

```
http://localhost:7777
```

你会看到一个简洁的 4 Tab 页面。

## 3. 多设备测试（关键一步）

要测"局域网共享"必须 **2 台以上设备**。建议：

- **手机 + 电脑**：连同一 WiFi
- **2 台电脑**：连同一路由器
- **虚拟机 + 主机**：网络设成"桥接模式"

**步骤**：

1. 在主机的终端找到你的 IP：
   - Windows: `ipconfig`，找 IPv4 Address（一般是 192.168.x.x）
   - Mac/Linux: `ifconfig` 或 `ip addr`

2. 另一台设备的浏览器访问：
   ```
   http://192.168.x.x:7777
   ```

3. 两边应该都能看到对方的节点名出现在右上角。

## 4. 四个功能怎么用

### 📁 文件
- 拖文件到虚线框，或点击选择
- 上传后两边都自动出现
- 点"下载"按钮直接存到本地

### 📋 剪贴板
- 在文本框粘贴内容 → 点"同步到所有节点"
- 其他人打开页面就能看到

### 📝 便签
- 输入文字、选个颜色、写个署名
- 像便利贴一样贴上，鼠标移上去显示删除按钮

### 🔗 链接
- 贴个 URL，可选填标题
- 投出去后所有人能一键打开

## 5. 进阶启动方式

### 自定义端口
```bash
PORT=8888 npm start
```

### 自定义节点名
```bash
LATTICE_NAME=客厅的Mac npm start
```

### V0.2 跨节点文件同步（推荐开启）

设置共享密钥后，**A 上传的文件会自动推一份给 B、C**，所有节点都有完整副本：

```bash
LATTICE_SECRET=mysecret123 LATTICE_NAME=Alice PORT=7777 npm start
```

所有节点必须用**相同的 `LATTICE_SECRET`**，否则不能互相同步。不设置则只在本机工作。

测试三节点：
```bash
# 终端 1 (Alice)
LATTICE_SECRET=secret123 LATTICE_NAME=Alice PORT=7777 LATTICE_DATA_DIR=./data-alice node server/index.js

# 终端 2 (Bob)
LATTICE_SECRET=secret123 LATTICE_NAME=Bob PORT=7778 LATTICE_DATA_DIR=./data-bob node server/index.js

# 终端 3 (Carol)
LATTICE_SECRET=secret123 LATTICE_NAME=Carol PORT=7779 LATTICE_DATA_DIR=./data-carol node server/index.js
```

在 Alice 上传文件 → Bob 和 Carol 的 `data-xxx/files/` 下会自动出现副本。

### Windows 后台启动（开机自启思路）
可以创建一个 `start.bat`：
```bat
@echo off
cd "C:\Users\73624\WorkBuddy AI\2026-07-04-23-22-21\lattice"
npm start
```
把这个快捷方式放到 `shell:startup` 文件夹就能开机自启。

## 6. 常见问题

**Q: 另一台设备访问不到？**
- 检查防火墙：Windows Defender 防火墙可能拦截了 7777 端口
- 临时放行（PowerShell 管理员）：
  ```powershell
  New-NetFirewallRule -DisplayName "Lattice" -Direction Inbound -LocalPort 7777 -Protocol TCP -Action Allow
  ```
- 确认两台设备在同一网段（IP 前 3 段相同）

**Q: 看不到其他节点？**
- 路由器的"AP 隔离"功能会阻止设备互访，关掉它
- 企业 WiFi 通常禁止设备互访，改用家用路由器

**Q: 上传大文件失败？**
- 默认限制 500MB，在 `server/api/files.js` 里改 `fileSize`
- 浏览器超时也有关，Chrome 默认无限制但 nginx 反代后会有

**Q: 数据存在哪？怎么备份？**
- 全部在 `data/` 文件夹
- 直接复制整个 `data/` 就是备份

**Q: 怎么让所有数据全网同步（每个节点都有）？**
- 当前 MVP 是"各存各的"，文件只在上传的那台机器
- 后续 V0.2 可以加：上传后通过 HTTP 推一份给其他节点

## 7. 下一步开发建议

按这个顺序做最有价值：

1. **加 HTTPS**（局域网内其实 HTTP 够用，但浏览器某些 API 要求 HTTPS）
2. **加文件预览**（图片直接显示，PDF 在线看）
3. **加 PWA**（手机可以"添加到主屏幕"像 App 一样用）
4. **加跨节点同步**（文件上传后自动推给其他节点）
5. **加桌面客户端**（Electron 打包，开机自启，系统托盘）

需要我帮你做哪个？直接说就行。
