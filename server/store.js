/**
 * store.js - 存储抽象层
 * ===========================================================================
 * 职责：
 *   1. 创建并管理 data/ 目录
 *   2. 提供 JSON 文件的读写工具
 *   3. 维护内存中的"邻居节点"列表
 *
 * 为什么不用数据库？
 *   - MVP 阶段，JSON 文件 + 文件夹足够
 *   - 部署零依赖，复制即用
 *   - 后续要换 SQLite / PostgreSQL 也很容易
 *
 * data/ 目录结构：
 *   data/
 *   ├── files/          # 上传的文件实体（multer 直接写这里）
 *   ├── .chunks/        # 分片上传的临时分片（上传完成后清理）
 *   ├── notes.json      # 便签数据
 *   ├── clipboard.json  # 剪贴板历史（最多 20 条）
 *   ├── links.json      # 链接数据
 *   ├── filemeta.json   # 文件元数据（标签/文件夹）V0.4
 *   └── peers.json      # 邻居节点（当前版本不持久化，仅内存）
 */

const fs = require('fs/promises');     // 异步文件操作
const fsSync = require('fs');          // 同步文件操作（仅用于 existsSync 探测）
const path = require('path');

// 路径常量：统一管理，方便后续迁移
// 默认在项目下的 data/，可通过环境变量 LATTICE_DATA_DIR 覆盖（多节点测试用）
const DATA_DIR = process.env.LATTICE_DATA_DIR
  ? path.resolve(process.env.LATTICE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const CHUNKS_DIR = path.join(DATA_DIR, '.chunks');   // V0.4 分片上传临时目录
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const CLIPBOARD_FILE = path.join(DATA_DIR, 'clipboard.json');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const FILEMETA_FILE = path.join(DATA_DIR, 'filemeta.json');  // V0.4 文件元数据
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');

/**
 * 内存中的 peers 列表
 * 用 Map 而不是对象：插入/删除 O(1)，键名不会被误改
 * value 结构：{ name, ip, port, lastSeen }
 */
let peers = new Map();

/**
 * 初始化：创建目录和占位文件
 * 这个函数是幂等的，可以反复调用
 */
async function init() {
  // 创建目录（recursive: true 表示父目录不存在也一起建）
  for (const dir of [DATA_DIR, FILES_DIR, CHUNKS_DIR]) {
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  // 创建空的 JSON 文件（如果不存在）
  for (const f of [NOTES_FILE, CLIPBOARD_FILE, LINKS_FILE, FILEMETA_FILE, PEERS_FILE]) {
    if (!fsSync.existsSync(f)) {
      await fs.writeFile(f, '[]');
    }
  }
}

/**
 * 读取 JSON 文件
 * 容错：文件不存在或损坏时返回空数组，而不是抛错
 */
async function readJson(file) {
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * 写入 JSON 文件
 * 用 null, 2 格式化输出，方便人眼查看
 */
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

/**
 * 更新或新增一个 peer
 * @param {Object} peer - { name, ip, port }
 * @returns {Array} 更新后的全部 peer 列表
 *
 * 顺便清理 30 秒没心跳的"僵尸"节点
 */
function upsertPeer({ name, ip, port }) {
  peers.set(name, { name, ip, port, lastSeen: Date.now() });

  // 清理超时节点（30 秒没更新视为离线）
  const now = Date.now();
  for (const [n, p] of peers) {
    if (now - p.lastSeen > 30000) {
      peers.delete(n);
    }
  }

  return Array.from(peers.values());
}

/**
 * 获取当前所有 peer
 */
function getPeers() {
  return Array.from(peers.values());
}

module.exports = {
  init,
  DATA_DIR,
  FILES_DIR,
  CHUNKS_DIR,
  // 文件读写工具
  readJson,
  writeJson,
  // 文件路径常量
  NOTES_FILE,
  CLIPBOARD_FILE,
  LINKS_FILE,
  FILEMETA_FILE,
  // peer 管理
  upsertPeer,
  getPeers,
};
