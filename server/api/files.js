/**
 * api/files.js - 文件共享 API（含 V0.2 跨节点同步）
 * ===========================================================================
 *
 * 端点：
 *   GET    /api/files            获取文件列表
 *   POST   /api/files            上传文件（multipart）→ 自动推送给所有 peers
 *   GET    /api/files/:id        下载文件
 *   DELETE /api/files/:id        删除文件（V0.2 暂不同步删除，先 todo）
 *   POST   /api/files/receive    [内部] 接收其他节点推送的同步文件
 *
 * ===========================================================================
 * V0.2 跨节点文件同步协议
 * ===========================================================================
 *
 * 触发流程：
 *   1. 用户在 A 上传文件
 *   2. multer 写入 A 的 data/files/<id>_<name>
 *   3. A 的 API 调用 syncToPeers() 把文件副本推给 B、C
 *   4. B、C 的 /api/files/receive 写入各自的 data/files/
 *   5. B、C 各自的 WebSocket 客户端收到 files:changed 推送
 *
 * 安全：
 *   - 用 X-Lattice-Secret 头做轻量鉴权
 *   - 接收端拒绝任何 secret 不匹配的请求
 *   - 防止"恶意节点"往你的 lattice 灌垃圾
 *
 * 局限（MVP 阶段先这样）：
 *   - 不同步删除（A 删了，B 还会留着旧副本）
 *   - 失败不重试（网络抖动就丢）
 *   - 不同步剪贴板/便签/链接（V0.3 再做）
 *
 * ===========================================================================
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const store = require('../store');
const { broadcast } = require('../ws');

const router = express.Router();

/**
 * 共享密钥：从环境变量读取
 * 所有节点必须用相同的 LATTICE_SECRET，否则不能互相同步
 * 不设置则禁用跨节点同步（仅本地）
 */
const SECRET = process.env.LATTICE_SECRET || '';
const NODE_NAME = process.env.LATTICE_NAME || require('os').hostname();

/**
 * multer 配置：内存存储
 *
 * 为什么不用 diskStorage？
 *   - multer 1.x 的 diskStorage 偶尔会因 filename 回调被多次调用而产生 0 字节文件
 *   - 用 memoryStorage 后我们自己写到磁盘，可控性更强
 *   - 大文件略费内存（500MB 限制下可接受）
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },  // 500MB 上限
});

/**
 * 把上传的 buffer 写到磁盘，文件名带时间戳
 * 返回写入的最终文件名（id）
 */
async function saveFileToDisk(file) {
  // 处理中文文件名编码
  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const ts = Date.now();
  const finalName = `${ts}_${originalName}`;
  const finalPath = path.join(store.FILES_DIR, finalName);
  await fsp.writeFile(finalPath, file.buffer);
  return { id: finalName, name: originalName, path: finalPath, size: file.size };
}

/**
 * 校验 secret 头
 * 没设置 SECRET 就放行（兼容 V0.1 行为）
 */
function checkSecret(req, res, next) {
  if (!SECRET) return next();
  const got = req.headers['x-lattice-secret'];
  if (got !== SECRET) {
    return res.status(403).json({ error: 'invalid secret' });
  }
  next();
}

/**
 * GET /api/files
 * 返回文件列表，按修改时间倒序
 */
router.get('/', async (req, res) => {
  const files = await fsp.readdir(store.FILES_DIR);
  const items = await Promise.all(
    files.map(async (f) => {
      const stat = await fsp.stat(path.join(store.FILES_DIR, f));
      return {
        id: f,
        name: f.replace(/^\d+_/, ''),
        size: stat.size,
        mtime: stat.mtimeMs,
        url: `/api/files/${encodeURIComponent(f)}`,
      };
    })
  );
  items.sort((a, b) => b.mtime - a.mtime);
  res.json(items);
});

/**
 * POST /api/files
 * 上传文件
 * 1. multer 暂存到内存
 * 2. 我们写到 data/files/
 * 3. 广播 files:changed
 * 4. 异步推送给所有 peers（V0.2）
 */
router.post('/', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    console.log(`[POST /api/files] 收到 ${files.length} 个文件`);
    files.forEach((f, i) => console.log(`  [${i}] originalname=${f.originalname}, size=${f.size}, buffer.length=${f.buffer?.length}`));
    // 写盘并收集推送需要的元数据
    const savedFiles = [];
    for (const f of files) {
      const saved = await saveFileToDisk(f);
      savedFiles.push(saved);
    }
    broadcast({ type: 'files:changed' });

    // 异步推送
    if (SECRET && savedFiles.length > 0) {
      syncFilesToPeers(savedFiles).catch((e) => {
        console.error('[sync] 推送失败:', e.message);
      });
    }

    res.json({ ok: true, count: savedFiles.length });
  } catch (e) {
    console.error('[POST /api/files] 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/files/receive
 * [内部端点] 其他节点推文件过来时调用
 */
router.post('/receive', checkSecret, upload.array('files', 20), async (req, res) => {
  try {
    const source = req.headers['x-lattice-source'] || 'unknown';
    const files = req.files || [];
    console.log(`[POST /api/files/receive] 收到来自 ${source} 的 ${files.length} 个文件, originalname=${files[0]?.originalname}, buffer.length=${files[0]?.buffer?.length}`);
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

/**
 * GET /api/files/:id
 * 下载文件
 */
router.get('/:id', async (req, res) => {
  // 跳过 /receive 路由冲突
  if (req.params.id === 'receive') return res.status(404).end();

  const filename = req.params.id;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  res.download(path.join(store.FILES_DIR, filename));
});

/**
 * DELETE /api/files/:id
 * 删除文件
 * V0.2 TODO: 广播给所有 peers 同步删除
 */
router.delete('/:id', async (req, res) => {
  const filename = req.params.id;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  try {
    await fsp.unlink(path.join(store.FILES_DIR, filename));
    broadcast({ type: 'files:changed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});

/**
 * ============================================================================
 * 跨节点同步实现
 * ============================================================================
 */

/**
 * 把一组文件推送给所有 peers
 * @param {Array} files - multer 的 files 数组，每项 { path, originalname, size, ... }
 */
async function syncFilesToPeers(files) {
  const peers = store.getPeers();
  if (peers.length === 0) {
    console.log('[sync] 没有 peers，跳过推送');
    return;
  }

  console.log(`[sync] 准备推 ${files.length} 个文件给 ${peers.length} 个 peers`);

  // 并发推送，失败不影响其他
  const results = await Promise.allSettled(
    peers.map((peer) => pushFilesToPeer(peer, files))
  );

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  console.log(`[sync] 推送完成：成功 ${ok}，失败 ${fail}`);
}

/**
 * 推送给单个 peer
 */
function pushFilesToPeer(peer, files) {
  return new Promise((resolve, reject) => {
    try {
      // 构造 boundary
      const boundary = '----LatticeSync' + Date.now() + Math.random().toString(36).slice(2);

      // 拼 multipart body
      // 顺序：[head1, head2, ..., headN, stream1, stream2, ..., streamN, tail]
      // 注意：tail 必须在所有 file stream 写完之后才写
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

      // 计算总长度
      const headLength = headSegments.reduce((s, p) => s + p.length, 0);
      const fileBytes = files.reduce((s, f) => s + f.size, 0);
      const totalLength = headLength + fileBytes + tail.length;

      // 构造请求
      const url = new URL(`http://${peer.ip}:${peer.port}/api/files/receive`);
      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
          'X-Lattice-Secret': SECRET,
          'X-Lattice-Source': NODE_NAME,
        },
      };

      const req = http.request(opts, (res) => {
        let buf = '';
        res.on('data', (d) => buf += d);
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

      // 写所有 head segments
      for (const p of headSegments) {
        req.write(p);
      }

      // 流式写文件，全部完成后再写 tail
      let streamIndex = 0;
      function writeNext() {
        if (streamIndex >= fileStreams.length) {
          // 所有文件流都写完了，再写 tail 结束 multipart
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

module.exports = router;
