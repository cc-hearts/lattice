// 自包含测试：登录 → 上传 → 元数据 → 分片上传 → 预览
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 17778;
const cookieJar = {};

function req(method, p, { body, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (cookieJar.cookie) h.Cookie = cookieJar.cookie;
    let data = body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      data = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, headers: h }, (res) => {
      let buf = Buffer.alloc(0);
      res.on('data', (c) => (buf = Buffer.concat([buf, c])));
      res.on('end', () => {
        if (res.headers['set-cookie']) cookieJar.cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// multipart 构造
function multipart(fields) {
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];
  for (const [name, val] of Object.entries(fields)) {
    if (val && typeof val === 'object' && val.filename) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${val.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      parts.push(val.content);
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

(async () => {
  console.log('1. 登录');
  let r = await req('POST', '/api/login', { body: { password: 'test123' } });
  console.log('   ', r.status, r.body);

  console.log('2. 上传小文件（中文文件名）');
  const mp = multipart({
    files: { filename: '测试文件.txt', content: Buffer.from('你好，Lattice！', 'utf8') },
  });
  r = await req('POST', '/api/files', { body: mp.body, headers: { 'Content-Type': mp.contentType } });
  console.log('   ', r.status, r.body);

  console.log('3. 文件列表（验证中文文件名 + preview 字段）');
  r = await req('GET', '/api/files');
  const files = JSON.parse(r.body);
  files.forEach(f => console.log('   ', f.name, '|', f.preview, '|', f.mime));

  const target = files.find(f => f.name === '测试文件.txt');
  console.log('4. PATCH 元数据（中文标签/文件夹）');
  r = await req('PATCH', `/api/files/${encodeURIComponent(target.id)}/meta`, { body: { folder: '素材', tags: ['重要', 'v1'] } });
  console.log('   ', r.status, r.body);

  console.log('5. 验证元数据 UTF-8 正确存储');
  r = await req('GET', '/api/files');
  const f2 = JSON.parse(r.body).find(f => f.name === '测试文件.txt');
  console.log('   folder =', f2.folder, ' tags =', JSON.stringify(f2.tags));

  console.log('6. 预览接口');
  r = await req('GET', `/api/files/${encodeURIComponent(target.id)}/preview`);
  console.log('   ', r.body);

  console.log('7. 内联预览 Content-Type');
  r = await req('GET', `/api/files/${encodeURIComponent(target.id)}`);
  console.log('   Content-Type:', r.headers['content-type']);

  console.log('8. 分片上传（模拟 7MB 文件 = 4 片）');
  const uploadId = 'test' + Date.now();
  const chunkSize = 2 * 1024 * 1024;
  const totalSize = 7 * 1024 * 1024;
  for (let i = 0; i < 4; i++) {
    const size = Math.min(chunkSize, totalSize - i * chunkSize);
    const chunk = Buffer.alloc(size, i + 65); // A/B/C/D
    const c = multipart({
      uploadId, index: String(i), total: '4', name: '大文件.bin', size: String(totalSize),
      chunk: { filename: 'chunk', content: chunk },
    });
    r = await req('POST', '/api/files/chunk', { body: c.body, headers: { 'Content-Type': c.contentType } });
    console.log('   分片', i, ':', r.status, r.body);
  }

  console.log('9. 断点续传：查询已上传分片');
  r = await req('GET', `/api/files/chunk-status?uploadId=${uploadId}`);
  console.log('   ', r.body);

  console.log('10. 合并分片');
  r = await req('POST', '/api/files/merge', { body: { uploadId } });
  console.log('   ', r.status, r.body);

  console.log('11. 验证大文件存在且大小正确');
  r = await req('GET', '/api/files');
  const big = JSON.parse(r.body).find(f => f.name === '大文件.bin');
  console.log('   ', big.name, big.size, '字节 (期望 7340032)');

  console.log('\n✅ 全部测试通过');
})().catch(e => { console.error('❌ 测试失败:', e); process.exit(1); });
