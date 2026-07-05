/**
 * api/files.js - 文件共享 API（V0.4）
 * ===========================================================================
 *
 * 端点：
 *   GET    /api/files                 获取文件列表（含元数据：标签/文件夹）
 *   POST   /api/files                 上传文件（multipart，小文件直传）→ 自动推 peers
 *   GET    /api/files/:id             下载文件（带正确 Content-Type，支持预览）
 *   GET    /api/files/:id/preview     预览信息（返回类型 + 直链）
 *   DELETE /api/files/:id             删除文件（V0.4 同步删除 + 清理元数据）
 *   PATCH  /api/files/:id/meta        更新文件元数据 { tags?, folder? } V0.4
 *
 *   --- 分片上传（断点续传，V0.4）---\n *   POST   /api/files/chunk           上传一个分片 { uploadId, index, total, name, size }
 *   GET    /api/files/chunk-status    查询已上传分片 ?uploadId=&total=
 *   POST   /api/files/merge           合并分片成完整文件 → 推 peers
 *
 *   POST   /api/files/receive         [内部] 接收其他节点推送的同步文件
 *
 * ===========================================================================
 * V0.4 主要增强
 * ===========================================================================
 * 1. 文件预览：根据扩展名返回 Content-Type，图片/PDF/视频/音频/文本可直接预览
 * 2. 分片上传 + 断点续传：大文件切片上传，失败可查询已上传分片后继续
 * 3. 标签 + 文件夹：filemeta.json 记录每个文件的 tags[] 和 folder
 * 4. 跨节点鉴权：使用 nodeauth（HMAC + 节点名 + 时间戳）
 * 5. 删除同步：DELETE 时通过 sync 协议通知 peers 一并删除
 * ===========================================================================
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const { URL } = require('url');
const store = require('../store');
const { broadcast } = require('../ws');
const { pushToPeers } = require('../sync');
const { makeAuthHeaders, nodeAuth } = require('../nodeauth');

const router = express.Router();

const SECRET = process.env.LATTICE_SECRET || '';
const NODE_NAME = process.env.LATTICE_NAME || require('os').hostname();

// 分片上传配置
const CHUNK_SIZE = 2 * 1024 * 1024;          // 2MB / 片
const MAX_CHUNKS = 500;                       // 最多 500 片 ≈ 1GB
const MAX_TOTAL = 1024 * 1024 * 1024;         // 单文件上限 1GB
const CHUNK_TTL_MS = 2 * 60 * 60 * 1000;      // 未完成分片 2 小时后清理

/**
 * multer 配置：内存存储
 * 大文件请走 /api/files/chunk 分片通道，这里只处理小文件直传
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },  // 直传上限 50MB
});

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

/** 中文文件名修正：multer 默认 latin1，转 utf8 */
function decodeName(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

/** 写文件到磁盘，返回元信息 */
async function saveFileToDisk(file) {
  const originalName = decodeName(file.originalname);
  const ts = Date.now();
  const finalName = `${ts}_${originalName}`;
  const finalPath = path.join(store.FILES_DIR, finalName);
  await fsp.writeFile(finalPath, file.buffer);
  return { id: finalName, name: originalName, path: finalPath, size: file.size };
}

/** 根据扩展名推断 MIME（Node 自带 mime 类型表有限，自己补一份常用映射） */
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/** 文件预览类型分类（前端据此决定预览方式） */
function previewKind(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) return 'audio';
  if (['.txt', '.md', '.json', '.csv', '.xml', '.html'].includes(ext)) return 'text';
  return null; // 不可预览，只能下载
}

/** 路径安全校验：防目录穿越 */
function safeName(filename) {
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  return filename;
}

/** 读取文件元数据 map：{ id -> meta } */
async function loadMetaMap() {
  const arr = await store.readJson(store.FILEMETA_FILE);
  const map = Object.create(null);
  for (const m of arr) map[m.id] = m;
  return map;
}

/** 写回元数据 */
async function saveMetaMap(map) {
  const arr = Object.values(map);
  await store.writeJson(store.FILEMETA_FILE, arr);
}

/* -------------------------------------------------------------------------- */
/* 路由：分片上传（断点续传）—— 必须在 /:id 之前定义，避免被通配匹配          */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/files/chunk
 * 上传一个分片
 * multipart: fields { uploadId, index, total, name, size }  file: chunk
 *
 * uploadId 由前端生成（随机串），同一文件所有分片用同一个 uploadId
 * 分片存到 data/.chunks/<uploadId>/<index>
 */
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHUNK_SIZE + 64 * 1024 }, // 留点余量
});

router.post('/chunk', chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, index, total, name, size } = req.body || {};
    if (!uploadId || !name || !req.file) {
      return res.status(400).json({ error: 'uploadId, name, chunk required' });
    }
    const idx = Number(index);
    const tot = Number(total);
    const sz = Number(size);
    if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_CHUNKS) {
      return res.status(400).json({ error: 'invalid index' });
    }
    if (Number.isFinite(sz) && sz > MAX_TOTAL) {
      return res.status(413).json({ error: 'file too large' });
    }

    const chunkDir = path.join(store.CHUNKS_DIR, uploadId);
    await fsp.mkdir(chunkDir, { recursive: true });
    // 写分片：<index>，并把元信息写到 meta.json
    // 注意：name 是 multipart 文本字段，multer 已按 UTF-8 解码，不能再 decodeName
    await fsp.writeFile(path.join(chunkDir, String(idx)), req.file.buffer);
    await fsp.writeFile(
      path.join(chunkDir, 'meta.json'),
      JSON.stringify({ name: String(name), total: tot, size: sz, ts: Date.now() })
    );

    res.json({ ok: true, index: idx, total: tot });
  } catch (e) {
    console.error('[chunk] 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/files/chunk-status?uploadId=xxx&total=N
 * 查询已上传哪些分片 → 前端断点续传时跳过已传的
 */
router.get('/chunk-status', async (req, res) => {
  const { uploadId } = req.query;
  if (!uploadId || uploadId.includes('/') || uploadId.includes('..')) {
    return res.status(400).json({ error: 'invalid uploadId' });
  }
  const chunkDir = path.join(store.CHUNKS_DIR, uploadId);
  let uploaded = [];
  let meta = null;
  try {
    const entries = await fsp.readdir(chunkDir);
    uploaded = entries
      .filter((f) => /^\d+$/.test(f))
      .map((f) => Number(f))
      .sort((a, b) => a - b);
    try {
      meta = JSON.parse(await fsp.readFile(path.join(chunkDir, 'meta.json'), 'utf8'));
    } catch {}
  } catch {
    // 目录不存在：还没开始传
  }
  res.json({ uploadId, uploaded, meta });
});

/**
 * POST /api/files/merge
 * 合并所有分片为完整文件，推送给 peers
 * body: { uploadId }
 */
router.post('/merge', async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId || uploadId.includes('/') || uploadId.includes('..')) {
      return res.status(400).json({ error: 'invalid uploadId' });
    }
    const chunkDir = path.join(store.CHUNKS_DIR, uploadId);
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(chunkDir, 'meta.json'), 'utf8'));
    } catch {
      return res.status(400).json({ error: 'no such upload' });
    }
    const total = meta.total;
    if (!Number.isFinite(total)) {
      return res.status(400).json({ error: 'invalid total' });
    }

    // 校验分片齐全
    const have = (await fsp.readdir(chunkDir)).filter((f) => /^\d+$/.test(f)).map(Number);
    if (have.length < total) {
      return res.status(400).json({ error: 'chunks incomplete', have: have.length, total });
    }

    // 合并写最终文件
    const ts = Date.now();
    const finalName = `${ts}_${meta.name}`;
    const finalPath = path.join(store.FILES_DIR, finalName);
    const out = fs.createWriteStream(finalPath);
    for (let i = 0; i < total; i++) {
      const chunkPath = path.join(chunkDir, String(i));
      const buf = await fsp.readFile(chunkPath);
      await new Promise((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise((resolve) => out.end(resolve));

    const finalStat = await fsp.stat(finalPath);

    // 清理分片
    await fsp.rm(chunkDir, { recursive: true, force: true });

    broadcast({ type: 'files:changed' });

    // 推送给 peers（用文件流式推送，复用 syncFilesToPeers）
    if (SECRET) {
      syncFilesToPeers([{ id: finalName, name: meta.name, path: finalPath, size: finalStat.size }]).catch((e) =>
        console.error('[sync] 推送合并文件失败:', e.message)
      );
    }

    res.json({ ok: true, id: finalName, name: meta.name, size: finalStat.size });
  } catch (e) {
    console.error('[merge] 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* 路由：列表 / 直传 / 下载 / 预览 / 删除 / 元数据                              */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/files
 * 返回文件列表，附 tags / folder，按修改时间倒序
 */
router.get('/', async (req, res) => {
  const files = await fsp.readdir(store.FILES_DIR);
  const metaMap = await loadMetaMap();
  const items = await Promise.all(
    files.map(async (f) => {
      const stat = await fsp.stat(path.join(store.FILES_DIR, f));
      const meta = metaMap[f] || {};
      return {
        id: f,
        name: f.replace(/^\d+_/, ''),
        size: stat.size,
        mtime: stat.mtimeMs,
        url: `/api/files/${encodeURIComponent(f)}`,
        preview: previewKind(f.replace(/^\d+_/, '')),
        mime: getMime(f.replace(/^\d+_/, '')),
        tags: meta.tags || [],
        folder: meta.folder || '',
      };
    })
  );
  items.sort((a, b) => b.mtime - a.mtime);
  res.json(items);
});

/**
 * POST /api/files
 * 小文件直传（<50MB），大文件请走 /api/files/chunk
 */
router.post('/', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    const savedFiles = [];
    for (const f of files) {
      const saved = await saveFileToDisk(f);
      savedFiles.push(saved);
    }
    broadcast({ type: 'files:changed' });

    if (SECRET && savedFiles.length > 0) {
      syncFilesToPeers(savedFiles).catch((e) => console.error('[sync] 推送失败:', e.message));
    }
    res.json({ ok: true, count: savedFiles.length });
  } catch (e) {
    console.error('[POST /api/files] 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/files/:id
 * 下载 / 内联预览。带正确 Content-Type，?download=1 强制下载
 */
router.get('/:id', async (req, res) => {
  const filename = safeName(req.params.id);
  if (!filename) return res.status(400).json({ error: 'invalid filename' });

  const fp = path.join(store.FILES_DIR, filename);
  try {
    await fsp.access(fp);
  } catch {
    return res.status(404).json({ error: 'not found' });
  }

  const displayName = filename.replace(/^\d+_/, '');
  const mime = getMime(displayName);
  const forceDownload = req.query.download !== undefined;

  if (forceDownload) {
    return res.download(fp, displayName);
  }
  // 内联预览：图片/PDF/视频/音频/文本直接在浏览器打开
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  // 缓存：文件名带时间戳，内容不变，可长期缓存
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(fp).pipe(res);
});

/**
 * GET /api/files/:id/preview
 * 返回预览元信息（前端据此构造预览 UI）
 */
router.get('/:id/preview', async (req, res) => {
  const filename = safeName(req.params.id);
  if (!filename) return res.status(400).json({ error: 'invalid filename' });
  const displayName = filename.replace(/^\d+_/, '');
  res.json({
    id: filename,
    name: displayName,
    kind: previewKind(displayName),
    mime: getMime(displayName),
    url: `/api/files/${encodeURIComponent(filename)}`,
  });
});

/**
 * DELETE /api/files/:id
 * 删除文件 + 清理元数据 + 同步给 peers
 */
router.delete('/:id', async (req, res) => {
  const filename = safeName(req.params.id);
  if (!filename) return res.status(400).json({ error: 'invalid filename' });
  try {
    await fsp.unlink(path.join(store.FILES_DIR, filename));
  } catch (e) {
    return res.status(404).json({ error: 'not found' });
  }
  // 清理元数据
  const metaMap = await loadMetaMap();
  delete metaMap[filename];
  await saveMetaMap(metaMap);

  broadcast({ type: 'files:changed' });
  // V0.4 同步删除
  if (SECRET) {
    pushToPeers('files:delete', { id: filename }).catch((e) =>
      console.error('[files] sync delete error:', e.message)
    );
  }
  res.json({ ok: true });
});

/**
 * PATCH /api/files/:id/meta
 * 更新文件元数据 { tags?, folder? }
 */
router.patch('/:id/meta', async (req, res) => {
  const filename = safeName(req.params.id);
  if (!filename) return res.status(400).json({ error: 'invalid filename' });
  const { tags, folder } = req.body || {};

  const metaMap = await loadMetaMap();
  const existing = metaMap[filename] || { id: filename, tags: [], folder: '' };
  if (Array.isArray(tags)) {
    existing.tags = tags.map(String).slice(0, 20);
  }
  if (typeof folder === 'string') {
    existing.folder = folder.slice(0, 100);
  }
  existing.id = filename;
  metaMap[filename] = existing;
  await saveMetaMap(metaMap);

  broadcast({ type: 'files:changed' });
  // 同步元数据
  if (SECRET) {
    pushToPeers('filemeta:update', existing).catch((e) =>
      console.error('[files] sync meta error:', e.message)
    );
  }
  res.json(existing);
});

/* -------------------------------------------------------------------------- */
/* 路由：跨节点接收（V0.4 用 nodeAuth）                                        */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/files/receive
 * [内部端点] 其他节点推文件过来时调用
 */
router.post('/receive', nodeAuth, upload.array('files', 20), async (req, res) => {
  try {
    const source = req.latticeSource || 'unknown';
    const files = req.files || [];
    for (const f of files) {
      await saveFileToDisk(f);
    }
    console.log(`[sync] 收到来自 ${source} 的 ${files.length} 个文件`);
    broadcast({ type: 'files:changed' });
    res.json({ ok: true, count: files.length });
  } catch (e) {
    console.error('[POST /api/files/receive] 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/* 跨节点文件推送实现                                                          */
/* -------------------------------------------------------------------------- */

async function syncFilesToPeers(files) {
  const peers = store.getPeers();
  if (peers.length === 0) {
    console.log('[sync] 没有 peers，跳过推送');
    return;
  }
  console.log(`[sync] 准备推 ${files.length} 个文件给 ${peers.length} 个 peers`);
  const results = await Promise.allSettled(
    peers.map((peer) => pushFilesToPeer(peer, files))
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  console.log(`[sync] 推送完成：成功 ${ok}，失败 ${fail}`);
}

/**
 * 推送给单个 peer —— multipart 流式推送 + V0.4 HMAC 鉴权头
 */
function pushFilesToPeer(peer, files) {
  return new Promise((resolve, reject) => {
    try {
      const boundary = '----LatticeSync' + Date.now() + Math.random().toString(36).slice(2);
      const headSegments = [];
      const fileStreams = [];

      for (const f of files) {
        headSegments.push(
          Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="files"; filename="${encodeURIComponent(f.name)}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
          )
        );
        fileStreams.push(fs.createReadStream(f.path));
      }
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

      const headLength = headSegments.reduce((s, p) => s + p.length, 0);
      const fileBytes = files.reduce((s, f) => s + f.size, 0);
      const totalLength = headLength + fileBytes + tail.length;

      const url = new URL(`http://${peer.ip}:${peer.port}/api/files/receive`);
      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
          ...makeAuthHeaders(),
        },
      };

      const req = http.request(opts, (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[sync] ✓ ${peer.name} (${peer.ip}:${peer.port})`);
            resolve();
          } else {
            reject(new Error(`${peer.name} returned ${res.statusCode}: ${buf}`));
          }
        });
      });

      req.on('error', (e) => reject(e));

      for (const p of headSegments) req.write(p);

      let streamIndex = 0;
      function writeNext() {
        if (streamIndex >= fileStreams.length) {
          req.write(tail);
          req.end();
          return;
        }
        const s = fileStreams[streamIndex++];
        s.on('data', (chunk) => req.write(chunk));
        s.on('end', writeNext);
        s.on('error', (e) => reject(e));
      }
      writeNext();
    } catch (e) {
      reject(e);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 分片临时目录定期清理                                                        */
/* -------------------------------------------------------------------------- */

setInterval(async () => {
  try {
    const entries = await fsp.readdir(store.CHUNKS_DIR).catch(() => []);
    const now = Date.now();
    for (const uploadId of entries) {
      const dir = path.join(store.CHUNKS_DIR, uploadId);
      const stat = await fsp.stat(dir).catch(() => null);
      if (stat && now - stat.mtimeMs > CHUNK_TTL_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
        console.log(`[chunk] 清理过期分片: ${uploadId}`);
      }
    }
  } catch (e) {
    // 静默失败，清理不影响主流程
  }
}, 30 * 60 * 1000).unref();

module.exports = router;
