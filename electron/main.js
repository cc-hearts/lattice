/**
 * Electron 主进程 - Lattice 桌面客户端（V0.4）
 * ===========================================================================
 *
 * 工作方式：
 *   1. 在主进程内直接 require() 服务器模块，启动 HTTP + WS + UDP 发现
 *      （不开子进程，调试简单，退出时一并清理）
 *   2. 创建 BrowserWindow 加载 http://localhost:<PORT>
 *   3. 关闭窗口时最小化到托盘，右键托盘菜单可显示/退出
 *
 * 运行：
 *   npm run electron        # 开发模式，直接跑
 *   npm run electron:build  # 打包成 exe/dmg/AppImage（需先 npm i -D electron-builder）
 *
 * 与浏览器版的区别：
 *   - 自动启动，不用先开终端 npm start
 *   - 开机自启（系统级配置后）
 *   - 系统托盘常驻，关窗不退出
 *   - 自动选一个空闲端口，避免冲突
 * ===========================================================================
 */

const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');

// 让 lattice 服务把工作目录设到用户目录，避免打包后只读问题
const userDataDir = app.getPath('userData');
process.env.LATTICE_DATA_DIR = process.env.LATTICE_DATA_DIR || path.join(userDataDir, 'data');

// 默认端口可被环境变量覆盖；自动探测空闲端口
let PORT = Number(process.env.PORT) || 7777;

let mainWindow = null;
let tray = null;
let serverStarted = false;

/**
 * 探测一个空闲端口：从 PORT 开始递增尝试
 */
function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const tester = http
        .createServer()
        .once('error', () => tryPort(p + 1))
        .once('listening', () => {
          tester.close(() => resolve(p));
        })
        .listen(p, '0.0.0.0');
    };
    tryPort(start);
  });
}

/**
 * 启动 Lattice 服务（复用 server/ 模块）
 * V0.5：server/index.js 改为导出 startServer()，不再依赖 require 副作用
 */
async function startLatticeServer() {
  // 服务器模块内部用 process.env.PORT，先写好
  process.env.PORT = String(PORT);
  const { startServer } = require('../server/index.js');
  await startServer({ quiet: false });
  serverStarted = true;
}

/**
 * 等待本地 HTTP 服务就绪
 */
function waitForServer(maxRetry = 50) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const check = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/auth`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++n > maxRetry) return reject(new Error('server timeout'));
        setTimeout(check, 100);
      });
    };
    check();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Lattice',
    icon: path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭时最小化到托盘（而非退出）
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'public', 'icons', 'icon-512.png');
  tray = new Tray(iconPath);
  tray.setToolTip('Lattice · 局域网小聚点');

  const menu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    {
      label: '在浏览器中打开',
      click: () => shell.openExternal(`http://127.0.0.1:${PORT}/`),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow && mainWindow.show());
}

app.whenReady().then(async () => {
  try {
    PORT = await findFreePort(PORT);
    await startLatticeServer();
    await waitForServer();
    createWindow();
    createTray();
  } catch (e) {
    // 服务起不来时弹个原生对话框
    const { dialog } = require('electron');
    dialog.showErrorBox('Lattice 启动失败', String(e && e.stack || e));
    app.quit();
  }
});

// macOS: 点击 dock 图标时重新显示窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow && mainWindow.show();
});

// 所有窗口关闭时不退出（托盘常驻）；macOS 行为已内置
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && tray) {
    // 有托盘时不退出，保留后台服务
  }
});
