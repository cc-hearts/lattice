/**
 * https.js - HTTPS 支持（V0.5）
 * ===========================================================================
 *
 * 局域网内 HTTP 通常够用，但有些场景必须 HTTPS：
 *   - 浏览器限制：某些 API（如 navigator.clipboard、Service Worker 高级特性）
 *     只在 Secure Context（HTTPS 或 localhost）下可用
 *   - 企业策略：强制 HTTPS
 *   - 内网穿透到公网时
 *
 * 启用方式：
 *   1. LATTICE_HTTPS=1                 → 自动生成自签名证书（最简单）
 *   2. LATTICE_CERT=/path/cert.pem     → 用自己的证书（如 Let's Encrypt / 内网 CA）
 *      LATTICE_KEY=/path/key.pem
 *
 * 自签名证书的注意点：
 *   - 浏览器会提示「不安全」，点「继续访问」即可（局域网工具正常现象）
 *   - 手机 WebView 可能直接拒绝自签名证书，需要在原生层加证书例外
 *   - 因此默认仍推荐 HTTP；只有需要 Secure Context 时才开 HTTPS
 *
 * 证书在首次调用 getCredentials() 时生成/加载并缓存，整个进程生命周期复用。
 * ===========================================================================
 */

const fs = require('fs');
const selfsigned = require('selfsigned');

let cached = null;

/**
 * 是否启用 HTTPS
 * 任一条件为真即启用：
 *   - LATTICE_HTTPS 设了（值非空/非 0）
 *   - LATTICE_CERT + LATTICE_KEY 都设了
 */
function isEnabled() {
  if (process.env.LATTICE_HTTPS && process.env.LATTICE_HTTPS !== '0') return true;
  if (process.env.LATTICE_CERT && process.env.LATTICE_KEY) return true;
  return false;
}

/**
 * 获取 HTTPS 凭据 { cert, key }
 * @param {string[]} [altHosts=[]] - 自签名证书要写入 subjectAltName 的主机/IP
 * @returns {Promise<{cert: Buffer|string, key: Buffer|string}>}
 */
async function getCredentials(altHosts = []) {
  if (cached) return cached;

  const certPath = process.env.LATTICE_CERT;
  const keyPath = process.env.LATTICE_KEY;

  if (certPath && keyPath) {
    // 用户提供的证书
    cached = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    console.log('[https] 使用证书:', certPath);
    return cached;
  }

  // 自动生成自签名证书
  // 把本机 IP / 主机名写进 SAN，浏览器访问对应地址时少一个警告
  const altNames = [
    { type: 2, value: 'localhost' },     // type 2 = DNS
    { type: 2, value: 'lattice.local' },
    { type: 7, value: '127.0.0.1' },      // type 7 = IP
  ];
  for (const h of altHosts) {
    if (!h) continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      altNames.push({ type: 7, value: h });
    } else {
      altNames.push({ type: 2, value: h });
    }
  }

  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const pems = await selfsigned.generate(null, {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: new Date(),
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames,
      },
    ],
  });

  cached = { cert: pems.cert, key: pems.private };
  console.log('[https] 已生成自签名证书，SAN:', altNames.map((n) => n.value).join(', '));
  return cached;
}

module.exports = { isEnabled, getCredentials };
