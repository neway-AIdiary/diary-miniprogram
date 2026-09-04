/**
 * utils/crypto.js — 纯 JS 加密模块（无外部依赖，小程序 / Node 通用）
 *
 * 用途：「云端加密备份」——明文日记永远不离开设备：
 *   1. 备份密码 + 随机盐 → PBKDF2-HMAC-SHA256 派生 256 位 AES 密钥（密码/密钥都不上传）
 *   2. 日记 JSON → AES-256-CBC（PKCS7 填充）加密 → 随机 IV 拼在密文前 → Base64
 *   3. 服务器只存：密文、盐、校验器（由密钥再哈希而来，无法反推密码/密钥/原文）
 *
 * 导出：
 *   ITERATIONS            PBKDF2 迭代次数（20000）
 *   sha256(bytes)         SHA-256 摘要（Uint8Array 32B）
 *   sha256Hex(bytes)      SHA-256 十六进制字符串
 *   hmacSha256(key, msg)  HMAC-SHA256
 *   pbkdf2(password, salt, iterations, dkLen)  密钥派生
 *   randomBytes(n)        随机字节
 *   encryptToBase64(plainStr, key32)   AES-256-CBC 加密 → base64(IV+密文)
 *   decryptFromBase64(b64, key32)      解密 → 原字符串（密码错/数据损坏时抛异常）
 *   utf8Encode / utf8Decode / bytesToBase64 / base64ToBytes
 */

// ================= UTF-8 =================
function utf8Encode(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    // 代理对（emoji 等 4 字节字符）
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1)
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00)
        i++
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
    } else if (code < 0x10000) {
      out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    } else {
      out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    }
  }
  return new Uint8Array(out)
}

function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    let code
    if (b < 0x80) {
      code = b; i++
    } else if (b < 0xE0) {
      code = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F); i += 2
    } else if (b < 0xF0) {
      code = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F); i += 3
    } else {
      code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F); i += 4
    }
    if (code >= 0x10000) {
      code -= 0x10000
      out += String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF))
    } else {
      out += String.fromCharCode(code)
    }
  }
  return out
}

// ================= Base64 =================
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes) {
  let out = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i]
    const b2 = i + 1 < len ? bytes[i + 1] : 0
    const b3 = i + 2 < len ? bytes[i + 2] : 0
    out += B64_CHARS[b1 >> 2]
    out += B64_CHARS[((b1 & 3) << 4) | (b2 >> 4)]
    out += i + 1 < len ? B64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '='
    out += i + 2 < len ? B64_CHARS[b3 & 63] : '='
  }
  return out
}

const B64_LOOKUP = (function () {
  const t = new Uint8Array(256)
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i
  t['-'.charCodeAt(0)] = 62  // 兼容 URL-safe
  t['_'.charCodeAt(0)] = 63
  return t
})()

function base64ToBytes(str) {
  let s = String(str || '').replace(/[^A-Za-z0-9+/=_\-]/g, '').replace(/=+$/, '')
  const len = s.length
  const outLen = (len * 3) >> 2
  const out = new Uint8Array(outLen)
  let idx = 0
  for (let i = 0; i < len; i += 4) {
    const c1 = i < len ? B64_LOOKUP[s.charCodeAt(i)] : 0
    const c2 = i + 1 < len ? B64_LOOKUP[s.charCodeAt(i + 1)] : 0
    const c3 = i + 2 < len ? B64_LOOKUP[s.charCodeAt(i + 2)] : 0
    const c4 = i + 3 < len ? B64_LOOKUP[s.charCodeAt(i + 3)] : 0
    const n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4
    if (idx < outLen) out[idx++] = (n >> 16) & 0xFF
    if (idx < outLen) out[idx++] = (n >> 8) & 0xFF
    if (idx < outLen) out[idx++] = n & 0xFF
  }
  return out
}

// ================= 随机字节 =================
let _randCounter = 0
function randomBytes(n) {
  const out = new Uint8Array(n)
  // Node 测试环境用系统级安全随机
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
      const req = typeof require === 'function' ? require('crypto') : null
      if (req && req.randomBytes) {
        const b = req.randomBytes(n)
        for (let i = 0; i < n; i++) out[i] = b[i]
        return out
      }
    } catch (e) { /* 降级 */ }
  }
  // 小程序环境：wx.getRandomValues 为异步，这里用多源熵混合（盐/IV 场景足够）
  const t = Date.now()
  for (let i = 0; i < n; i++) {
    _randCounter = (_randCounter + 1) % 0xFFFF
    const r = Math.floor(Math.random() * 0x10000)
    const tick = (t + i * 7919 + _randCounter * 104729) & 0xFFFF
    out[i] = (r ^ tick ^ ((Math.random() * 0x100) | 0)) & 0xFF
  }
  return out
}

// ================= SHA-256 =================
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }

function sha256(bytes) {
  const msgLen = bytes.length
  const bitLenHi = Math.floor(msgLen / 0x20000000)
  const bitLenLo = (msgLen << 3) >>> 0
  // 填充：消息 + 0x80 + 0x00… + 64 位长度
  const padded = new Uint8Array(((msgLen + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[msgLen] = 0x80
  const dv = padded.length - 8
  padded[dv] = (bitLenHi >>> 24) & 0xFF
  padded[dv + 1] = (bitLenHi >>> 16) & 0xFF
  padded[dv + 2] = (bitLenHi >>> 8) & 0xFF
  padded[dv + 3] = bitLenHi & 0xFF
  padded[dv + 4] = (bitLenLo >>> 24) & 0xFF
  padded[dv + 5] = (bitLenLo >>> 16) & 0xFF
  padded[dv + 6] = (bitLenLo >>> 8) & 0xFF
  padded[dv + 7] = bitLenLo & 0xFF

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Int32Array(64)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0
      d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }

  const out = new Uint8Array(32)
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7]
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (hs[i] >>> 24) & 0xFF
    out[i * 4 + 1] = (hs[i] >>> 16) & 0xFF
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xFF
    out[i * 4 + 3] = hs[i] & 0xFF
  }
  return out
}

function bytesToHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  return s
}

function sha256Hex(bytes) { return bytesToHex(sha256(bytes)) }

// ================= HMAC-SHA256 =================
function hmacSha256(key, msg) {
  let k = key
  if (k.length > 64) k = sha256(k)
  const ipad = new Uint8Array(64 + msg.length)
  const opad = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    const kb = i < k.length ? k[i] : 0
    ipad[i] = kb ^ 0x36
    opad[i] = kb ^ 0x5C
  }
  ipad.set(msg, 64)
  const inner = sha256(ipad)
  opad.set(inner, 64)
  return sha256(opad)
}

// ================= PBKDF2-HMAC-SHA256 =================
function pbkdf2(password, salt, iterations, dkLen) {
  const pw = typeof password === 'string' ? utf8Encode(String(password)) : password
  iterations = iterations || 20000
  dkLen = dkLen || 32
  const blocks = Math.ceil(dkLen / 32)
  const out = new Uint8Array(dkLen)
  const saltBuf = salt instanceof Uint8Array ? salt : utf8Encode(String(salt))

  for (let block = 1; block <= blocks; block++) {
    // U1 = HMAC(P, S || INT(block))
    const s1 = new Uint8Array(saltBuf.length + 4)
    s1.set(saltBuf)
    s1[saltBuf.length] = (block >>> 24) & 0xFF
    s1[saltBuf.length + 1] = (block >>> 16) & 0xFF
    s1[saltBuf.length + 2] = (block >>> 8) & 0xFF
    s1[saltBuf.length + 3] = block & 0xFF
    let u = hmacSha256(pw, s1)
    const t = new Uint8Array(u)
    for (let c = 2; c <= iterations; c++) {
      u = hmacSha256(pw, u)
      for (let i = 0; i < 32; i++) t[i] ^= u[i]
    }
    const copy = Math.min(32, dkLen - (block - 1) * 32)
    out.set(t.subarray(0, copy), (block - 1) * 32)
  }
  return out
}

// ================= AES-256（S-box 由代码生成，避免手写表出错）=================
// GF(2^8) 乘 2（模 x^8+x^4+x^3+x+1 = 0x11B）
function xt(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1B : 0)) & 0xFF }

// GF(2^8) 乘法
function gmul(a, b) {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a = xt(a)
    b >>= 1
  }
  return r & 0xFF
}

// 生成 S-box / 逆 S-box：乘法逆元 + 仿射变换
const SBOX = (function () {
  const exp = new Array(256)
  const log = new Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x = gmul(x, 3)
  }
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    // 乘法逆元：exp 表下标 255-log[i] 会越界（i=1 时 log=0），单独处理
    let inv = i === 0 ? 0 : (i === 1 ? 1 : exp[255 - log[i]])
    // 仿射变换：b = inv ^ rotl(inv,1) ^ rotl(inv,2) ^ rotl(inv,3) ^ rotl(inv,4) ^ 0x63
    let s = inv
    for (let j = 0; j < 4; j++) {
      inv = ((inv << 1) | (inv >>> 7)) & 0xFF
      s ^= inv
    }
    box[i] = s ^ 0x63
  }
  return box
})()

const INV_SBOX = (function () {
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i++) box[SBOX[i]] = i
  return box
})()

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36, 0x6C, 0xD8]

// AES-256 密钥扩展：Nk=8 → 60 个 32 位字（展开为 4 字节数组）
function expandKey(key32) {
  const Nk = 8
  const words = new Uint8Array(4 * 4 * 15)  // Nr+1 = 15 轮密钥
  words.set(key32.subarray(0, 32))
  let size = 32
  let rconIdx = 0
  while (size < words.length) {
    let t0 = words[size - 4], t1 = words[size - 3], t2 = words[size - 2], t3 = words[size - 1]
    if (size % 32 === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t0
      t0 = SBOX[t1] ^ RCON[rconIdx++]
      t1 = SBOX[t2]
      t2 = SBOX[t3]
      t3 = SBOX[tmp]
    } else if (size % 32 === 16) {
      // AES-256 额外 SubWord
      t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3]
    }
    words[size] = words[size - 32] ^ t0
    words[size + 1] = words[size - 31] ^ t1
    words[size + 2] = words[size - 30] ^ t2
    words[size + 3] = words[size - 29] ^ t3
    size += 4
  }
  return words
}

// 加密单个 16 字节块（state 按列主序：state[r + 4c] = in[r + 4c]）
function encryptBlock(block, roundKeys) {
  const s = new Uint8Array(16)
  s.set(block)
  // 初始轮密钥
  for (let i = 0; i < 16; i++) s[i] ^= roundKeys[i]

  for (let round = 1; round <= 14; round++) {
    const rk = round * 16
    // SubBytes + ShiftRows（合并执行）
    const t = new Uint8Array(16)
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        t[r + 4 * c] = SBOX[s[r + 4 * ((c + r) % 4)]]
      }
    }
    if (round < 14) {
      // MixColumns
      for (let c = 0; c < 4; c++) {
        const a0 = t[4 * c], a1 = t[4 * c + 1], a2 = t[4 * c + 2], a3 = t[4 * c + 3]
        s[4 * c] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3
        s[4 * c + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3
        s[4 * c + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3)
        s[4 * c + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2)
      }
    } else {
      s.set(t)
    }
    // AddRoundKey
    for (let i = 0; i < 16; i++) s[i] ^= roundKeys[rk + i]
  }
  return s
}

// 解密单个 16 字节块（逆序）
function decryptBlock(block, roundKeys) {
  const s = new Uint8Array(16)
  s.set(block)
  // 初始（最后一轮）密钥
  const lastKey = 14 * 16
  for (let i = 0; i < 16; i++) s[i] ^= roundKeys[lastKey + i]

  for (let round = 13; round >= 0; round--) {
    const rk = round * 16
    // InvShiftRows + InvSubBytes（合并）
    const t = new Uint8Array(16)
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        // 正向 ShiftRows 是 s'[r][c] = s[r][(c+r)%4]，逆向：s[r][(c+r)%4] = in[r][c]
        t[r + 4 * ((c + r) % 4)] = INV_SBOX[s[r + 4 * c]]
      }
    }
    // AddRoundKey
    for (let i = 0; i < 16; i++) s[i] = t[i] ^ roundKeys[rk + i]
    if (round > 0) {
      // InvMixColumns
      for (let c = 0; c < 4; c++) {
        const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3]
        s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)
        s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)
        s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)
        s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)
      }
    }
  }
  return s
}

function pkcs7Pad(data) {
  const pad = 16 - (data.length % 16)
  const out = new Uint8Array(data.length + pad)
  out.set(data)
  for (let i = data.length; i < out.length; i++) out[i] = pad
  return out
}

function pkcs7Unpad(data) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error('备份密文格式错误')
  const pad = data[data.length - 1]
  if (pad < 1 || pad > 16) throw new Error('备份密文格式错误')
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error('备份密文格式错误')
  }
  return data.subarray(0, data.length - pad)
}

/**
 * AES-256-CBC 加密字符串 → base64(IV(16B) + 密文)
 */
function encryptToBase64(plainStr, key32) {
  const rk = expandKey(key32)
  const iv = randomBytes(16)
  const padded = pkcs7Pad(utf8Encode(String(plainStr)))
  const out = new Uint8Array(16 + padded.length)
  out.set(iv)
  let prev = iv
  for (let off = 0; off < padded.length; off += 16) {
    const blockIn = new Uint8Array(16)
    for (let i = 0; i < 16; i++) blockIn[i] = padded[off + i] ^ prev[i]
    const enc = encryptBlock(blockIn, rk)
    out.set(enc, 16 + off)
    prev = enc
  }
  return bytesToBase64(out)
}

/**
 * base64(IV+密文) → AES-256-CBC 解密 → 原字符串
 * 密码错误或数据损坏时抛异常（PKCS7 校验兜底）
 */
function decryptFromBase64(b64, key32) {
  const data = base64ToBytes(b64)
  if (data.length < 32 || (data.length - 16) % 16 !== 0) throw new Error('备份密文格式错误')
  const rk = expandKey(key32)
  const iv = data.subarray(0, 16)
  const out = new Uint8Array(data.length - 16)
  let prev = iv
  for (let off = 16; off < data.length; off += 16) {
    const dec = decryptBlock(data.subarray(off, off + 16), rk)
    for (let i = 0; i < 16; i++) out[off - 16 + i] = dec[i] ^ prev[i]
    prev = data.subarray(off, off + 16)
  }
  return utf8Decode(pkcs7Unpad(out))
}

module.exports = {
  ITERATIONS: 20000,
  utf8Encode: utf8Encode,
  utf8Decode: utf8Decode,
  bytesToBase64: bytesToBase64,
  base64ToBytes: base64ToBytes,
  bytesToHex: bytesToHex,
  randomBytes: randomBytes,
  sha256: sha256,
  sha256Hex: sha256Hex,
  hmacSha256: hmacSha256,
  pbkdf2: pbkdf2,
  encryptToBase64: encryptToBase64,
  decryptFromBase64: decryptFromBase64,
  // 内部原语（供回归测试对照；业务代码勿用）
  _internal: {
    SBOX: SBOX,
    INV_SBOX: INV_SBOX,
    expandKey: expandKey,
    encryptBlock: encryptBlock,
    decryptBlock: decryptBlock,
    gmul: gmul
  }
}
