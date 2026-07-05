/**
 * preload.js - Electron 预加载脚本
 * 当前不暴露额外 API，仅保留 contextIsolation 隔离
 * 后续可在此暴露桌面专属能力（如：系统通知、文件拖拽路径）
 */
window.latticeDesktop = {
  version: '0.4.0',
  platform: process.platform,
};
