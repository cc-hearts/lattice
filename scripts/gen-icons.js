/**
 * gen-icons.js - 生成 Lattice PWA 图标（无第三方依赖）
 * ===========================================================================
 * 用 Node 原生 zlib 手写 PNG 编码，画一个"晶格网络"主题图标：
 *   - 靛蓝背景 (#6366f1)
 *   - 4×4 白色节点 + 连线，呼应 "Lattice / 局域网小聚点" 的多节点互联概念
 *
 * 运行：node scripts/gen-icons.js
 * 产物：public/icons/{icon-192,icon-512,apple-touch-icon,maskable-512}.png
 *
 * 为什么不用 sharp / canvas？
 *   - 零依赖，复制项目即可生成
 *   - 图标是程序化绘制的，矢量逻辑，任意尺寸清晰
 * ===========================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/* ----------------------------- 画布抽象层 ----------------------------- */

function createCanvas(size) {
  const buf = Buffer.alloc(size * size * 4); // RGBA
  return { buf, size };
}

function setPixel(c, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  x = Math.round(x); y = Math.round(y);
  const i = (y * c.size + x) * 4;
  c.buf[i] = r; c.buf[i + 1] = g; c.buf[i + 2] = b; c.buf[i + 3] = a;
}

function fillBackground(c, r, g, b) {
  for (let i = 0; i < c.buf.length; i += 4) {
    c.buf[i] = r; c.buf[i + 1] = g; c.buf[i + 2] = b; c.buf[i + 3] = 255;
  }
}

/** 实心圆 —— 用包围盒遍历，距离判定 */
function fillCircle(c, cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  const x0 = Math.floor(cx - radius), x1 = Math.ceil(cx + radius);
  const y0 = Math.floor(cy - radius), y1 = Math.ceil(cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(c, x, y, r, g, b);
    }
  }
}

/** 粗线段 —— 沿路径画一连串圆，简单且端点圆润 */
function drawThickLine(c, x1, y1, x2, y2, thickness, r, g, b) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(len));
  const radius = thickness / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(c, x1 + dx * t, y1 + dy * t, radius, r, g, b);
  }
}

/* ------------------------------- PNG 编码 ------------------------------- */

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(c) {
  const { buf, size } = c;
  const stride = size * 4;
  // 每条扫描线前置 1 字节过滤器（0 = None）
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    buf.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- 绘制图标 ------------------------------- */

/**
 * 画 Lattice 主题：靛蓝底 + 4×4 白色节点网格 + 连线
 * @param designScale 设计在画布中的占比（maskable 需缩小到安全区 ~70%）
 */
function drawLattice(c, designScale = 1) {
  const size = c.size;
  fillBackground(c, 0x63, 0x66, 0xf1);

  const margin = size * 0.18 * designScale;
  const span = size - 2 * margin;
  const N = 4;
  const pos = [];
  for (let i = 0; i < N; i++) pos.push(margin + (span * i) / (N - 1));

  const dotR = size * 0.04 * designScale;
  const lineW = size * 0.02 * designScale;
  const W = [0xff, 0xff, 0xff];

  // 先连线，再画点（点覆盖在线交叉处，更干净）
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i < N - 1) drawThickLine(c, pos[i], pos[j], pos[i + 1], pos[j], lineW, ...W);
      if (j < N - 1) drawThickLine(c, pos[i], pos[j], pos[i], pos[j + 1], lineW, ...W);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) fillCircle(c, pos[i], pos[j], dotR, ...W);
  }
}

/* --------------------------------- 主流程 --------------------------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = [
    { name: 'icon-192.png', size: 192, scale: 1 },
    { name: 'icon-512.png', size: 512, scale: 1 },
    { name: 'maskable-512.png', size: 512, scale: 0.72 }, // 安全区收缩
    { name: 'apple-touch-icon.png', size: 180, scale: 1 },
    { name: 'favicon.png', size: 32, scale: 1 },
  ];

  for (const t of targets) {
    const c = createCanvas(t.size);
    drawLattice(c, t.scale);
    const png = encodePNG(c);
    const out = path.join(OUT_DIR, t.name);
    fs.writeFileSync(out, png);
    console.log(`  ✓ ${t.name}  (${t.size}×${t.size}, ${png.length} bytes)`);
  }

  // 顺带生成一个 SVG 版本（矢量，可在 manifest 中引用）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#6366f1"/>
  <g stroke="#ffffff" stroke-width="10" stroke-linecap="round">
    ${[0, 1, 2].map((i) =>
      `<line x1="${96 + i * 106}" y1="96" x2="${96 + i * 106}" y2="412"/>
       <line x1="96" y1="${96 + i * 106}" x2="412" y2="${96 + i * 106}"/>`
    ).join('')}
  </g>
  ${[0, 1, 2, 3].map((i) =>
    [0, 1, 2, 3].map((j) =>
      `<circle cx="${96 + i * 106}" cy="${96 + j * 106}" r="20" fill="#ffffff"/>`
    ).join('')
  ).join('')}
</svg>`;
  fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), svg);
  console.log('  ✓ icon.svg');
  console.log('\n图标已生成到 public/icons/');
}

main();
