/**
 * utils/zipWriter.js
 * 纯 JS 生成 zip 包（STORED 不压缩模式），用于把 OOXML 部件打包成标准 .docx 文件。
 * 零依赖：CRC32 / UTF-8 编码 / base64 解码 / JPEG·PNG 尺寸解析 全部内置。
 * 生成的 zip 符合 PKWare APPNOTE 规范，Word / WPS / 微信预览均可直接打开。
 */

// ---------- 字符编码 ----------

// UTF-8 字符串 → Uint8Array
function strToBytes(str) {
  const out = []
  for (let i = 0; i < String(str).length; i++) {
    let code = String(str).codePointAt(i)
    if (code > 0xFFFF) i++
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

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// base64 字符串 → Uint8Array（用于图片二进制内嵌 docx）
function base64ToBytes(b64) {
  const s = String(b64).replace(/[^A-Za-z0-9+/]/g, '')
  const out = []
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_CHARS.indexOf(s[i]) << 18) |
      (B64_CHARS.indexOf(s[i + 1]) << 12) |
      ((i + 2 < s.length ? B64_CHARS.indexOf(s[i + 2]) : 0) << 6) |
      (i + 3 < s.length ? B64_CHARS.indexOf(s[i + 3]) : 0)
    out.push((n >> 16) & 0xFF)
    if (i + 2 < s.length && s[i + 2] !== '=') out.push((n >> 8) & 0xFF)
    if (i + 3 < s.length && s[i + 3] !== '=') out.push(n & 0xFF)
  }
  return new Uint8Array(out)
}

// ---------- CRC32 ----------

let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

function crc32(bytes) {
  const t = crcTable()
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// ---------- zip 打包（STORED 模式，无需压缩算法） ----------

// DOS 日期时间（zip 规范：日期 1980 基准）
function dosDateTime(date) {
  const d = date || new Date()
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF
  const day = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  return { time: time, date: day }
}

/**
 * 打包 zip（ArrayBuffer）
 * @param {Array} files [{name: string, data: Uint8Array}]
 * @returns {ArrayBuffer}
 */
function buildZip(files) {
  const list = files || []
  const now = dosDateTime(new Date())
  const parts = []      // 顺序写入的字节块
  const centrals = []   // 中央目录记录
  let offset = 0

  list.forEach(f => {
    const nameB = strToBytes(f.name)
    const data = f.data
    const crc = crc32(data)

    // ---- Local File Header（30 字节 + 文件名）----
    const lh = new Uint8Array(30 + nameB.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)   // 签名 PK\x03\x04
    lv.setUint16(4, 20, true)           // 版本
    lv.setUint16(6, 0x0800, true)       // 标志：UTF-8 文件名
    lv.setUint16(8, 0, true)            // 压缩方式：STORED
    lv.setUint16(10, now.time, true)
    lv.setUint16(12, now.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // 压缩后大小
    lv.setUint32(22, data.length, true) // 原始大小
    lv.setUint16(26, nameB.length, true)
    lv.setUint16(28, 0, true)           // extra 长度
    lh.set(nameB, 30)
    parts.push(lh, data)

    // ---- Central Directory 记录（46 字节 + 文件名）----
    const ch = new Uint8Array(46 + nameB.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)   // 签名 PK\x01\x02
    cv.setUint16(4, 20, true)           // 制作版本
    cv.setUint16(6, 20, true)           // 需要版本
    cv.setUint16(8, 0x0800, true)       // 标志：UTF-8
    cv.setUint16(10, 0, true)           // STORED
    cv.setUint16(12, now.time, true)
    cv.setUint16(14, now.date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    // 30 extra / 32 comment / 34 磁盘号 / 36 内部属性 / 38 外部属性 均为 0
    cv.setUint32(42, offset, true)      // 本地头偏移
    ch.set(nameB, 46)
    centrals.push(ch)

    offset += lh.length + data.length
  })

  // ---- 拼接 ----
  let centralSize = 0
  centrals.forEach(c => { centralSize += c.length })
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)     // 签名 PK\x05\x06
  // 4/6 磁盘号 0；8/10 本卷条目数
  ev.setUint16(8, list.length, true)
  ev.setUint16(10, list.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)        // 中央目录起始偏移
  ev.setUint16(20, 0, true)             // 注释长度

  const total = offset + centralSize + 22
  const out = new Uint8Array(total)
  let pos = 0
  parts.concat(centrals).concat([eocd]).forEach(p => {
    out.set(p, pos)
    pos += p.length
  })
  return out.buffer
}

// ---------- 图片尺寸解析（docx 内图片按原始比例排版，避免拉伸变形） ----------

function parseImageSize(bytes) {
  try {
    if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
      // JPEG：逐段扫描 SOF marker（C0-CF，排除 C4/C8/CC）
      let i = 2
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xFF) { i++; continue }
        const marker = bytes[i + 1]
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return {
            h: (bytes[i + 5] << 8) | bytes[i + 6],
            w: (bytes[i + 7] << 8) | bytes[i + 8]
          }
        }
        const len = (bytes[i + 2] << 8) | bytes[i + 3]
        if (len <= 0) break
        i += 2 + len
      }
    } else if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) {
      // PNG：IHDR 固定在 16-23 字节
      return {
        w: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
        h: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
      }
    }
  } catch (e) { /* 尺寸解析失败按默认 4:3 处理 */ }
  return null
}

module.exports = {
  strToBytes,
  base64ToBytes,
  crc32,
  buildZip,
  parseImageSize
}
