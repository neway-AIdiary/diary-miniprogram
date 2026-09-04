/**
 * tools/test_crypto.js — utils/crypto.js 回归测试（Node 环境）
 * 对照标准实现：node:crypto 的 SHA-256 / HMAC / PBKDF2 / AES-256-CBC
 * 运行：node tools/test_crypto.js
 */
const nodeCrypto = require('crypto')
const c = require('../utils/crypto.js')

let pass = 0
let fail = 0

function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')) }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

// ===== 1. SHA-256 标准向量 =====
console.log('[1] SHA-256')
assert('sha256("")', c.sha256Hex(new Uint8Array(0)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
assert('sha256("abc")', c.sha256Hex(c.utf8Encode('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
const long = c.utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
assert('sha256(56字节消息)', c.sha256Hex(long) === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
// 长消息（多块 + 与 node 对照）
const big = new Uint8Array(100000)
for (let i = 0; i < big.length; i++) big[i] = i & 0xFF
assert('sha256(100KB 随机对照)', c.sha256Hex(big) === nodeCrypto.createHash('sha256').update(big).digest('hex'))

// ===== 2. HMAC-SHA256（RFC 4231）=====
console.log('[2] HMAC-SHA256')
const rfcKey = new Uint8Array(20).fill(0x0b)
const rfcOut = c.bytesToHex(c.hmacSha256(rfcKey, c.utf8Encode('Hi There')))
assert('RFC4231 case1', rfcOut === 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7', rfcOut)
const case2 = c.bytesToHex(c.hmacSha256(c.utf8Encode('Jefe'), c.utf8Encode('what do ya want for nothing?')))
assert('RFC4231 case2', case2 === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', case2)
// 长密钥（>64B 走先哈希分支）与 node 对照
const bigKey = new Uint8Array(131).fill(0xAA)
const hm = c.bytesToHex(c.hmacSha256(bigKey, c.utf8Encode('Test Using Larger Than Block-Size Key - Hash Key First')))
assert('长密钥对照 node', hm === nodeCrypto.createHmac('sha256', Buffer.from(bigKey)).update('Test Using Larger Than Block-Size Key - Hash Key First').digest('hex'))

// ===== 3. PBKDF2-HMAC-SHA256 =====
console.log('[3] PBKDF2-HMAC-SHA256')
function pbkdf2Hex(p, s, iter, len) {
  return c.bytesToHex(c.pbkdf2(p, c.utf8Encode(s), iter, len))
}
assert('RFC向量 c=1', pbkdf2Hex('password', 'salt', 1, 32) === '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b')
assert('RFC向量 c=2', pbkdf2Hex('password', 'salt', 2, 32) === 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43')
assert('RFC向量 c=4096', pbkdf2Hex('password', 'salt', 4096, 32) === 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a')
// 与 node 对照（中文密码 + 迭代 2000）
const nodePb = nodeCrypto.pbkdf2Sync('日记密码123', 'saltbytes', 2000, 48, 'sha256').toString('hex')
assert('中文密码+48字节 对照 node', pbkdf2Hex('日记密码123', 'saltbytes', 2000, 48) === nodePb)

// ===== 4. AES-256-CBC 对照 node（随机 100 轮，双向）=====
console.log('[4] AES-256-CBC 对照 node')
let aesOk = true
let aesBad = ''
for (let round = 0; round < 100; round++) {
  const key = c.randomBytes(32)
  const iv = c.randomBytes(16)
  const len = 1 + Math.floor(Math.random() * 300)
  // 生成 utf8 安全的随机明文（含中文与 ascii）
  let plain = ''
  while (plain.length < len) {
    plain += Math.random() < 0.5 ? String.fromCharCode(0x4E00 + Math.floor(Math.random() * 500)) : String.fromCharCode(0x20 + Math.floor(Math.random() * 90))
  }
  plain = plain.slice(0, len)
  const plainBytes = c.utf8Encode(plain)

  // 方向 A：node 加密 → 我们解密
  const nodeCipher = nodeCrypto.createCipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv))
  const ct = Buffer.concat([nodeCipher.update(Buffer.from(plainBytes)), nodeCipher.final()])
  const blob = c.bytesToBase64(new Uint8Array([...iv, ...ct]))
  if (c.decryptFromBase64(blob, key) !== plain) { aesOk = false; aesBad = 'A round ' + round; break }

  // 方向 B：我们加密 → node 解密
  const ours = c.encryptToBase64(plain, key)
  const raw = Buffer.from(c.base64ToBytes(ours))
  const dec = nodeCrypto.createDecipheriv('aes-256-cbc', Buffer.from(key), raw.subarray(0, 16))
  const out = Buffer.concat([dec.update(raw.subarray(16)), dec.final()]).toString('utf8')
  if (out !== plain) { aesOk = false; aesBad = 'B round ' + round; break }
}
assert('100 轮随机双向对照', aesOk, aesBad)

// ===== 5. 完整 API：encryptToBase64 / decryptFromBase64（中英文+emoji+长文）=====
console.log('[5] 完整加密 API roundtrip')
const key32 = c.randomBytes(32)
const samples = [
  '你好，日记',
  'emoji 😀🥰 测试 🌈✨',
  'line1\nline2\n\t中文「引号」&<html>',
  'x'.repeat(100000) + '末尾中文',
  JSON.stringify({ diaries: [{ title: '测试', content: '今天心情不错 😀', mood: 'happy' }], archives: [] })
]
let rtOk = true
for (const s of samples) {
  const enc = c.encryptToBase64(s, key32)
  const dec = c.decryptFromBase64(enc, key32)
  if (dec !== s) { rtOk = false; break }
}
assert('5 组样例 roundtrip（含 100KB 长文）', rtOk)

// 密码错误必须抛异常（PKCS7 校验兜底）
let threw = false
try {
  c.decryptFromBase64(c.encryptToBase64('秘密日记', key32), c.randomBytes(32))
} catch (e) { threw = true }
assert('错误密钥解密抛异常', threw)

// base64 URL-safe 与空白字符兼容
const enc2 = c.encryptToBase64('测试', key32).replace(/\+/g, '-').replace(/\//g, '_')
assert('URL-safe base64 兼容', c.decryptFromBase64(enc2, key32) === '测试')

// ===== 6. 端到端模拟：密码派生 → 加密 → 重建密钥解密 =====
console.log('[6] 端到端（密码 → 密钥 → 密文 → 解密）')
const pwd = '我的备份密码'
const salt = c.randomBytes(16)
const k1 = c.pbkdf2(pwd, salt, c.ITERATIONS, 32)
const payload = JSON.stringify({ diaries: [{ content: '云端备份隐私测试 😀' }] })
const blob = c.encryptToBase64(payload, k1)
const verifier = c.sha256Hex(new Uint8Array([...k1, ...c.utf8Encode('ai-diary-backup-verify')]))
const k2 = c.pbkdf2(pwd, salt, c.ITERATIONS, 32)  // 模拟另一台设备用同密码重建
assert('同密码重建密钥一致', c.bytesToHex(k1) === c.bytesToHex(k2))
assert('重建密钥可解密', c.decryptFromBase64(blob, k2) === payload)
assert('校验器可复现', c.sha256Hex(new Uint8Array([...k2, ...c.utf8Encode('ai-diary-backup-verify')])) === verifier)
// PBKDF2 与 node 对照（同参数）
assert('派生密钥对照 node', c.bytesToHex(k1) === nodeCrypto.pbkdf2Sync(pwd, Buffer.from(salt), c.ITERATIONS, 32, 'sha256').toString('hex'))

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
