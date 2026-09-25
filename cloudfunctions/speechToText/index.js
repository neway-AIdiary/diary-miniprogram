const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ===== 火山引擎 录音文件极速识别（flash）=====
// 文档：https://www.volcengine.com/docs/6561/1631584
// 一次 HTTP 请求即返回识别结果，无需 submit/query 轮询；音频 base64 放 JSON body。
//
// 需在云函数环境变量配置（新旧版控制台二选一）：
//   新版：VOLC_ASR_API_KEY
//   旧版：VOLC_ASR_APP_ID + VOLC_ASR_ACCESS_TOKEN

// 兜底密钥：未配置环境变量时使用（与 getAsrConfig 保持一致）
// 2026-08-31 实测有效的火山旧版双 Key（App ID + Access Token）
const FALLBACK_APP_ID = '7992637022'
const FALLBACK_ACCESS_TOKEN = '_KDN_ncc9T4ydrv2mn4XhjiegwBOtNp7'

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// 鉴权 header（新旧版控制台兼容）
function buildAuthHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
    'X-Api-Request-Id': uuid(),
    'X-Api-Sequence': '-1'
  }
  const apiKey = process.env.VOLC_ASR_API_KEY || ''
  const appId = process.env.VOLC_ASR_APP_ID || FALLBACK_APP_ID
  const accessToken = process.env.VOLC_ASR_ACCESS_TOKEN || FALLBACK_ACCESS_TOKEN
  if (apiKey) {
    headers['X-Api-Key'] = apiKey
  } else if (appId && accessToken) {
    headers['X-Api-App-Key'] = String(appId)
    headers['X-Api-Access-Key'] = accessToken
  }
  return headers
}

// pcm 裸流补 44 字节 WAV 头（16kHz/16bit/单声道）——flash 接口不支持裸 pcm
function pcmToWav(pcm) {
  const header = Buffer.alloc(44)
  const sampleRate = 16000
  const bitsPerSample = 16
  const channels = 1
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)                     // fmt 块长度
  header.writeUInt16LE(1, 20)                      // PCM 编码
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28) // byte rate
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32)              // block align
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * 调用火山极速版识别
 * @param {Buffer} audioBuffer 录音文件内容
 * @param {'wav'|'pcm'} format wav（整段链路）或 pcm（流式链路失败回退）
 * @param {string[]} [hotwords] 热词列表（档案名词+近十天高频词，与流式链路同源）
 */
function recognizeFlash(audioBuffer, format, hotwords) {
  const finalBuf = format === 'pcm' ? pcmToWav(audioBuffer) : audioBuffer
  const request = {
    model_name: 'bigmodel',
    enable_punc: true,
    enable_itn: true
  }
  // 热词直传：request.corpus.context（与流式接口 bigmodel_async 同款写法），
  // 发音相近的词优先识别成热词，提升人名等专名准确率
  if (Array.isArray(hotwords) && hotwords.length) {
    request.corpus = {
      context: JSON.stringify({ hotwords: hotwords.slice(0, 50).map(w => ({ word: String(w) })) })
    }
  }
  const body = JSON.stringify({
    user: { uid: 'diary_miniprogram' },
    audio: { data: finalBuf.toString('base64') },
    request: request
  })

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openspeech.bytedance.com',
      path: '/api/v3/auc/bigmodel/recognize/flash',
      method: 'POST',
      headers: Object.assign(buildAuthHeaders(), {
        'Content-Length': Buffer.byteLength(body)
      })
    }, (res) => {
      // 按字节块收集后一次性整体 UTF-8 解码，避免多字节字符被切在块边界时变成乱码
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8')
        const code = res.headers['x-api-status-code']
        let json = null
        try { json = JSON.parse(data) } catch (e) {}
        if (code === '20000000' && json && json.result && json.result.text) {
          resolve(json.result.text)
        } else if (code === '20000003') {
          reject(new Error('没听清，请再试一次'))
        } else if (code === '45000030') {
          reject(new Error('火山服务未开通：请到控制台开通「录音文件极速识别」并绑定到当前应用'))
        } else if (code === '45000001' || code === '45000002' || code === '45000151') {
          reject(new Error('火山鉴权失败(' + code + ')：请检查 API Key 是否正确、是否属于绑定了语音服务的应用'))
        } else {
          reject(new Error('识别错误(' + code + ')：' + ((json && (json.message || json.msg)) || '未知错误')))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ===== [asr-nostream v1] 流式 2.0「流式输入模式」整段识别（iOS 回退链路升级）=====
// 端点 bigmodel_nostream：整段音频快速推完 → 服务端整体识别 → 返回累计全文。
// 2026-09-24 真实服务端实测（29.7s 录音）：全速推完 18ms、端到端 7.5s、无 45000081 包超时；
// result 为对象，result.text 为全量累计文本，取最后一帧即可（不可拼接，会重复）。
// 分帧协议与客户端 utils/volcProto.js 同款（首帧参数 seq=1、音频帧 seq>=2、负包结束），
// 此处内联实现：云函数侧要兼容 result 数组形态与 Buffer 大端解析，不与客户端共用代码。
// ws 依赖懒加载：未安装（含本机单测环境）即刻失败 → main 流程回退 flash（极速版）。

const NOSTREAM_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
const NOSTREAM_RESOURCE_ID = 'volc.seedasr.sauc.duration'
const NOSTREAM_TIMEOUT_MS = 15000      // 识别阶段上限（云函数执行超时 20s：识别 15s + 收尾 1s + 余量）
const FLASH_FALLBACK_BUDGET_MS = 8000  // 失败时已耗超过此预算则不再回退 flash（回退也来不及）

// WAV 解析：定位 data 块（兼容带 LIST 等扩展块的录制器）并读取 fmt 块实际参数。
// ⚠️ iOS 的 recorderManager 可能忽略 sampleRate 参数（实际录出的不是 16000），
//    音频参数必须按文件头实际值下发 —— 写死 16000 会让服务端把 44.1k 当 16k 处理，
//    时长被放大 ~2.8 倍 ⇒ nostream 处理超时（2026-09-24 iPhone「识别超时」的根因）。
//    flash 接口服务端自己读 wav 头，所以这个错位在 flash 时代从未暴露。
function parseWav(buf) {
  try {
    if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
      let rate = 0
      let bits = 0
      let channels = 0
      let off = 12
      while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4)
        const size = buf.readUInt32LE(off + 4)
        if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
          channels = buf.readUInt16LE(off + 10)
          rate = buf.readUInt32LE(off + 12)
          bits = buf.readUInt16LE(off + 22)
        } else if (id === 'data') {
          const start = off + 8
          if (start + size <= buf.length) {
            return { pcm: buf.slice(start, start + size), rate: rate, bits: bits, channels: channels }
          }
        }
        off += 8 + size + (size % 2)
      }
    }
  } catch (e) {}
  return null
}

function wavToPcm(buf) {
  const parsed = parseWav(buf)
  return parsed ? parsed.pcm : buf.slice(44)
}

function u32be(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

function nostreamFrameRequest(paramsObj) {
  const payload = Buffer.from(JSON.stringify(paramsObj), 'utf8')
  return Buffer.concat([Buffer.from([0x11, 0x11, 0x10, 0x00]), u32be(1), u32be(payload.length), payload])
}

function nostreamFrameAudio(chunk, seq) {
  return Buffer.concat([Buffer.from([0x11, 0x21, 0x00, 0x00]), u32be(seq), u32be(chunk.length), chunk])
}

function nostreamFrameLast() {
  return Buffer.from([0x11, 0x22, 0x00, 0x00, 0, 0, 0, 0])
}

// 解析服务端帧：full server response(9) / error(15)；result 兼容对象与数组两种形态
// （官方文档对 result 自相矛盾：参数表标 list、示例是对象，实测 2.0 为对象）
function nostreamParseServer(buf) {
  if (!buf || buf.length < 4) return null
  const msgType = (buf[1] & 0xf0) >> 4
  const flags = buf[1] & 0x0f
  if (msgType === 0x9) {
    const off = (flags & 0x01) ? 12 : 8  // flags bit0 → 带 sequence
    if (buf.length < off) return null
    const size = buf.readUInt32BE(off - 4)
    if (off + size > buf.length) return null
    let json
    try { json = JSON.parse(buf.slice(off, off + size).toString('utf8')) } catch (e) { return null }
    let text = ''
    const r = json.result
    if (r && typeof r === 'object') {
      const item = Array.isArray(r) ? r[r.length - 1] : r
      if (item && typeof item.text === 'string') text = item.text
    }
    return { type: 'result', text: text }
  }
  if (msgType === 0xf) {
    const code = buf.readUInt32BE(4)
    let msg = ''
    if (buf.length >= 12) {
      const size = buf.readUInt32BE(8)
      if (size > 0 && 12 + size <= buf.length) {
        try { msg = buf.slice(12, 12 + size).toString('utf8') } catch (e) {}
      }
    }
    return { type: 'error', code: code, message: msg }
  }
  return null
}

function recognizeNostream(audioBuffer, format, hotwords) {
  return new Promise((resolve, reject) => {
    let WebSocket
    try { WebSocket = require('ws') } catch (e) {
      return reject(new Error('ws 模块不可用'))
    }
    // 音频参数按文件头实际值下发（pcm 裸流来自 16k 录音恒为 16k，wav 以头为准）
    const wavInfo = format === 'pcm' ? null : parseWav(audioBuffer)
    const pcm = wavInfo ? wavInfo.pcm : audioBuffer
    const audioMeta = {
      rate: (wavInfo && wavInfo.rate) || 16000,
      bits: (wavInfo && wavInfo.bits) || 16,
      channel: (wavInfo && wavInfo.channels) || 1
    }
    console.log('[asr-nostream] pcm=%dB rate=%s bits=%s ch=%s', pcm.length, audioMeta.rate, audioMeta.bits, audioMeta.channel)
    const request = { model_name: 'bigmodel', enable_punc: true, enable_itn: true }
    if (Array.isArray(hotwords) && hotwords.length) {
      // 流式输入模式热词直传上限 5000 词（远高于双向流式的 100 tokens / flash 的 50）
      request.corpus = {
        context: JSON.stringify({ hotwords: hotwords.slice(0, 5000).map(w => ({ word: String(w) })) })
      }
    }
    const full = {
      user: { uid: 'diary_miniprogram' },
      audio: { format: 'pcm', rate: audioMeta.rate, bits: audioMeta.bits, channel: audioMeta.channel },
      request: request
    }
    let ws
    try {
      ws = new WebSocket(NOSTREAM_URL, {
        headers: {
          'X-Api-App-Key': String(process.env.VOLC_ASR_APP_ID || FALLBACK_APP_ID),
          'X-Api-Access-Key': process.env.VOLC_ASR_ACCESS_TOKEN || FALLBACK_ACCESS_TOKEN,
          'X-Api-Resource-Id': NOSTREAM_RESOURCE_ID,
          'X-Api-Request-Id': uuid(),
          'X-Api-Connect-Id': uuid()
        },
        handshakeTimeout: 5000
      })
    } catch (e) { return reject(e) }
    let settled = false
    let timer = null
    let lastText = ''
    let firstError = null
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      try { ws.close() } catch (e) {}
      fn(arg)
    }
    timer = setTimeout(() => finish(reject, new Error('识别超时(NOSTREAM)')), NOSTREAM_TIMEOUT_MS)
    ws.on('open', () => {
      try {
        ws.send(nostreamFrameRequest(full))
        // 实测服务端不要求实时节奏：29.7s 音频全速推完仅 18ms，无 45000081 包超时
        const CHUNK = 3200  // 100ms @ 16kHz/16bit/单声道
        let seq = 2         // 首帧参数帧占 1，音频帧从 2 递增
        for (let off = 0; off < pcm.length; off += CHUNK) {
          ws.send(nostreamFrameAudio(pcm.slice(off, off + CHUNK), seq++))
        }
        ws.send(nostreamFrameLast())
      } catch (e) { finish(reject, e) }
    })
    ws.on('message', (data) => {
      const parsed = nostreamParseServer(data)
      if (!parsed) return
      if (parsed.type === 'result') {
        if (parsed.text) lastText = parsed.text  // 全量累计文本：只保留最后一帧
      } else if (parsed.type === 'error' && !firstError) {
        firstError = new Error('NOSTREAM 错误(' + parsed.code + '): ' + parsed.message)
      }
    })
    ws.on('error', (e) => { if (!firstError) firstError = e })
    ws.on('close', () => {
      if (firstError) return finish(reject, firstError)
      if (lastText) return finish(resolve, lastText)
      finish(reject, new Error('没听清，请再试一次'))
    })
  })
}

// [ai-usage v1] 商业化埋点：每次语音识别写一条 ai_usage（绝不阻塞业务返回）
function getBeijingDateKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = n => n < 10 ? '0' + n : '' + n
  return now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
}
async function logAiUsage(fields) {
  try {
    const wxContext = cloud.getWXContext()
    await cloud.database().collection('ai_usage').add({
      data: Object.assign({
        openid: (wxContext && wxContext.OPENID) || 'unknown',
        fn: 'speechToText',
        date: getBeijingDateKey(),
        ts: Date.now()
      }, fields)
    })
  } catch (e) {
    console.warn('[ai-usage] speechToText 记账失败(不阻塞):', e && e.message)
  }
}

// ===== [ai-usage v2] 收尾加速：清理临时文件 ‖ 记账，并行发起 + 有界等待 =====
// 识别成功后只剩两件杂事，彼此不依赖 ⇒ 并行发起只等一次往返（旧版「先删文件、再记账」白等一跳）。
// 更要紧的是给它们设等待上限：云库/云存储抖动时先返回识别结果，别让收尾把整次识别拖到函数执行超时
// （iOS 长录音「云函数调用失败」的成因之一就是收尾被计入执行时长）。
// ⚠️ 不能改成 fire-and-forget：云函数返回后运行时会冻结，未完成的写入会丢；
//    且 test_ai_usage 的 st-2/st-3/st-4 锁的就是「返回前记账已落库」。
//    故用 Promise.all + 超时闸：正常情况（各约 100ms 往返）在上限内完成，行为与串行时期一致。
const TAIL_WAIT_MS = 1000

async function flushTail(fileID, usageFields) {
  const cleanup = (async () => {
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
  })()
  const accounting = logAiUsage(usageFields)
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn('[ai-usage] speechToText 收尾等待超时(>' + TAIL_WAIT_MS + 'ms)，先返回识别结果')
      resolve()
    }, TAIL_WAIT_MS)
  })
  try {
    await Promise.race([Promise.all([cleanup, accounting]), guard])
  } finally {
    if (timer) { clearTimeout(timer); timer = null }
  }
}

exports.main = async (event) => {
  const { fileID, format, hotwords } = event
  const audioFormat = format === 'pcm' ? 'pcm' : 'wav'  // 流式回退传 pcm，默认 wav

  if (!fileID) {
    return { error: '缺少音频文件' }
  }

  const apiKey = process.env.VOLC_ASR_API_KEY || ''
  const appId = process.env.VOLC_ASR_APP_ID || FALLBACK_APP_ID
  const accessToken = process.env.VOLC_ASR_ACCESS_TOKEN || FALLBACK_ACCESS_TOKEN
  if (!apiKey && !(appId && accessToken)) {
    // 清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    return { error: '未配置火山ASR密钥' }
  }

  const startedAt = Date.now()
  try {
    // 1. 从云存储下载录音文件
    const fileRes = await cloud.downloadFile({ fileID })
    // 2. 调用火山极速版识别（带上小程序端传来的热词）
    // [asr-nostream v1] 优先流式 2.0 整段识别（更准、更快、更便宜）；
    // 失败且总耗时在预算内时回退极速版 flash（另一商品线，仍有余量），保证可用性
    let text
    try {
      text = await recognizeNostream(fileRes.fileContent, audioFormat, hotwords)
    } catch (eNostream) {
      if (Date.now() - startedAt > FLASH_FALLBACK_BUDGET_MS) throw eNostream
      text = await recognizeFlash(fileRes.fileContent, audioFormat, hotwords)
    }
    // 3) [ai-usage v2] 收尾：清理临时文件 ‖ 记账，并行 + 有界等待（见 flushTail）
    await flushTail(fileID, { ok: true, audioBytes: fileRes.fileContent.length, costMs: Date.now() - startedAt })
    return { text }
  } catch (err) {
    // [ai-usage v2] 出错也收尾：清理临时文件 ‖ 记账（并行 + 有界等待）
    await flushTail(fileID, { ok: false, error: String((err && err.message) || 'asr error').slice(0, 120), costMs: Date.now() - startedAt })
    return { error: err.message || '语音识别失败' }
  }
}
