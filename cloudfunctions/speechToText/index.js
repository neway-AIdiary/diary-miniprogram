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
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
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

  try {
    // 1. 从云存储下载录音文件
    const fileRes = await cloud.downloadFile({ fileID })
    // 2. 调用火山极速版识别（带上小程序端传来的热词）
    const text = await recognizeFlash(fileRes.fileContent, audioFormat, hotwords)
    // 3. 清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    return { text }
  } catch (err) {
    // 出错也清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    return { error: err.message || '语音识别失败' }
  }
}
