// utils/volcProto.js
// 火山引擎流式语音识别 v3 二进制分帧协议编解码（纯函数，无微信 API 依赖，可在 Node 单测）。
//
// 帧结构（整数一律大端）：
//   Header(4B) + [Sequence(4B)] + PayloadSize(4B) + Payload
// Header 各字节：
//   [0] 0x11                  协议版本 1 + header 长度 1（即 4 字节）
//   [1] (type << 4) | flags   消息类型与标志
//   [2] (序列化 << 4) | 压缩   客户端 JSON 帧=0x10；音频裸流帧=0x00
//   [3] 0x00                  保留
// 消息类型：1=full client request（首帧参数）
//           2=audio only（音频帧）
//           9=full server response（识别结果）
//           15=error（服务端错误帧）
// flags：0=无 sequence；1=正 sequence（带序号，首帧/音频帧/部分结果帧）；2=最后一包（负包，无 sequence）
//
// 实测（2026-08-31，bigmodel_async 线上验证）序号规则：
//   服务端按消息条数自动计数——首帧参数帧必须带 sequence=1，
//   音频帧从 sequence=2 起递增，负包不带序号。
//   服务端结果帧两种形态：flags=0 → header+size+payload；flags 含 bit0 → header+seq+size+payload。

// ---------- UTF-8 编解码（小程序环境无 TextEncoder/TextDecoder，手写兜底） ----------

function utf8Encode(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    // 代理对 → 码点
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00)
        i += 1
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return new Uint8Array(out)
}

function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b < 0xc0) {
      i += 1 // 无效字节，跳过
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f)
      const hi = 0xd800 + ((cp - 0x10000) >> 10)
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff)
      out += String.fromCharCode(hi, lo)
      i += 4
    }
  }
  return out
}

// ---------- 客户端帧构造 ----------

/**
 * 首帧：full client request（JSON 参数）
 * 结构：Header(4B) + Sequence(4B=1) + PayloadSize(4B) + JSON
 * 注意：首帧必须带正序号 1（服务端按消息条数自动计数，缺序号会报
 *       "autoAssignedSequence mismatch" 错误帧并断开连接）
 */
function buildRequestFrame(paramsObj) {
  const payload = utf8Encode(JSON.stringify(paramsObj))
  const buf = new ArrayBuffer(12 + payload.length)
  const dv = new DataView(buf)
  dv.setUint8(0, 0x11)
  dv.setUint8(1, 0x11) // type=1(full request), flags=1(带正序号)
  dv.setUint8(2, 0x10) // JSON 序列化，不压缩
  dv.setUint8(3, 0x00)
  dv.setUint32(4, 1)   // sequence = 1（固定，首帧）
  dv.setUint32(8, payload.length)
  new Uint8Array(buf).set(payload, 12)
  return buf
}

/**
 * 音频帧：audio only（正 sequence 递增）
 * 结构：Header(4B) + Sequence(4B) + PayloadSize(4B) + PCM
 * @param {ArrayBuffer} pcmArrayBuffer 裸 PCM 数据
 * @param {number} seq 正整数序号（首帧参数帧占用 1，音频帧从 2 递增）
 */
function buildAudioFrame(pcmArrayBuffer, seq) {
  const payload = new Uint8Array(pcmArrayBuffer)
  const buf = new ArrayBuffer(12 + payload.length)
  const dv = new DataView(buf)
  dv.setUint8(0, 0x11)
  dv.setUint8(1, 0x21) // type=2(audio only), flags=1(正 seq)
  dv.setUint8(2, 0x00) // 无序列化，不压缩
  dv.setUint8(3, 0x00)
  dv.setUint32(4, seq)
  dv.setUint32(8, payload.length)
  new Uint8Array(buf).set(payload, 12)
  return buf
}

/**
 * 最后一包（负包）：标志音频发送结束，空 payload
 * 结构：Header(4B) + PayloadSize(4B=0)
 */
function buildLastFrame() {
  const buf = new ArrayBuffer(8)
  const dv = new DataView(buf)
  dv.setUint8(0, 0x11)
  dv.setUint8(1, 0x22) // type=2(audio only), flags=2(最后一包)
  dv.setUint8(2, 0x00)
  dv.setUint8(3, 0x00)
  dv.setUint32(4, 0)
  return buf
}

// ---------- 服务端帧解析 ----------

/**
 * 解析结果帧 JSON 载荷
 * result.text —— 累计识别全文（result_type=full）
 * result.definite —— 定稿标记（若服务端返回）
 * 结尾帧只有 audio_info.duration、无 text：返回 text='' 由调用方忽略
 */
function parseResultJson(bytes) {
  let json
  try {
    json = JSON.parse(utf8Decode(bytes))
  } catch (e) {
    return null
  }
  const text = json.result && typeof json.result.text === 'string' ? json.result.text : ''
  const definite = !!(json.result && json.result.definite)
  return { type: 'result', text: text, definite: definite }
}

/**
 * 解析服务端帧
 * @param {ArrayBuffer|string} data onMessage 回调数据
 * @returns {{type:'result',text:string}|{type:'error',code:number,message:string}|null}
 *   result —— 识别结果帧（result.text 为累计全文）
 *   error  —— 服务端错误帧
 */
function parseServerFrame(data) {
  if (!data || typeof data === 'string') return null
  let u8
  try {
    u8 = new Uint8Array(data)
  } catch (e) {
    return null
  }
  if (u8.length < 8) return null
  const dv = new DataView(data)
  const msgType = (u8[1] & 0xf0) >> 4

  if (msgType === 0x9) {
    // full server response：flags=0 → Header+Size+Payload；flags 含 bit0 → Header+Seq+Size+Payload
    const flags = u8[1] & 0x0f
    const hasSeq = (flags & 0x01) !== 0
    if (hasSeq) {
      if (u8.length < 12) return null
      const size = dv.getUint32(8)
      if (size < 0 || 12 + size > u8.length) return null
      return parseResultJson(u8.subarray(12, 12 + size))
    }
    const size = dv.getUint32(4)
    if (size < 0 || 8 + size > u8.length) return null
    return parseResultJson(u8.subarray(8, 8 + size))
  }

  if (msgType === 0xf) {
    // 错误帧: Header(4B) + ErrorCode(4B) + PayloadSize(4B) + 消息
    const code = dv.getUint32(4)
    let message = ''
    if (u8.length >= 12) {
      const size = dv.getUint32(8)
      if (size > 0 && 12 + size <= u8.length) {
        try {
          message = utf8Decode(u8.subarray(12, 12 + size))
        } catch (e) {}
      }
    }
    return { type: 'error', code: code, message: message }
  }

  return null
}

module.exports = {
  utf8Encode: utf8Encode,
  utf8Decode: utf8Decode,
  buildRequestFrame: buildRequestFrame,
  buildAudioFrame: buildAudioFrame,
  buildLastFrame: buildLastFrame,
  parseServerFrame: parseServerFrame
}
