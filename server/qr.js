/**
 * qr.js - 二维码生成（V0.5）
 * ===========================================================================
 *
 * 用途：
 *   桌面/浏览器端把「本节点访问地址」生成二维码，手机扫码即可连接，
 *   不用手抄 IP 和端口。配合移动端 App 的扫码功能（mobile/www）闭环。
 *
 * 端点：
 *   GET /api/qr?text=xxx   返回 SVG 二维码（公开，无需登录）
 *        - 不带 text 时用 setDefaultText() 设的本节点地址
 *        - text 太长（>1000）会返回 400，二维码容不下
 *
 * 为什么放公开？
 *   手机扫码后跳到节点首页 /login.html，登录是另一道锁。
 *   二维码本身只编码「地址」，不含密码，公开无风险。
 *   而且锁屏页也可能想展示二维码（让未登录的设备扫码），所以不走鉴权门槛。
 * ===========================================================================
 */

const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();

// 默认二维码内容：本节点局域网 URL（启动时由 index.js 设置）
let defaultText = '';

function setDefaultText(t) {
  defaultText = t || '';
}

router.get('/', async (req, res) => {
  try {
    const text = String(req.query.text || defaultText || 'lattice');
    if (text.length > 1000) {
      return res.status(400).json({ error: 'text too long (>1000)' });
    }
    const svg = await QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#1c1917', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, setDefaultText };
