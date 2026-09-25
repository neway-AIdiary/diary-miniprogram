# -*- coding: utf-8 -*-
"""
[asr-nostream v1] iOS 回退链路升级：speechToText 优先流式 2.0「流式输入模式」整段识别
  A. cloudfunctions/speechToText/index.js：
     - 新增 recognizeNostream（WS bigmodel_nostream + 资源ID volc.seedasr.sauc.duration，
       内联分帧协议，result 兼容对象/数组，取最后一帧累计全文）；
     - main 流程：优先 nostream，失败且在预算内回退 flash（极速版），保证可用性
  B. cloudfunctions/speechToText/package.json：加 ws 依赖 + 修正过期描述（百度 ASR → 火山）
  C. tools/test_ai_usage.js：Module._load 屏蔽真实 ws（让其即刻失败走 flash 回退路径，保测试确定性）

用法：--check / --write / --restore-src
"""
import os
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = 'speech-nostream-backup-20260924'
FILES = [
    'cloudfunctions/speechToText/index.js',
    'cloudfunctions/speechToText/package.json',
    'tools/test_ai_usage.js',
]

NEW_BLOCK = '''// ===== [asr-nostream v1] 流式 2.0「流式输入模式」整段识别（iOS 回退链路升级）=====
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

// WAV → 裸 PCM：解析 RIFF 头定位 data 块（兼容带 LIST 等扩展块的录制器），异常退回固定偏移
function wavToPcm(buf) {
  try {
    if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
      let off = 12
      while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4)
        const size = buf.readUInt32LE(off + 4)
        if (id === 'data') {
          const start = off + 8
          if (start + size <= buf.length) return buf.slice(start, start + size)
        }
        off += 8 + size + (size % 2)
      }
    }
  } catch (e) {}
  return buf.slice(44)
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
    const pcm = format === 'pcm' ? audioBuffer : wavToPcm(audioBuffer)
    const request = { model_name: 'bigmodel', enable_punc: true, enable_itn: true }
    if (Array.isArray(hotwords) && hotwords.length) {
      // 流式输入模式热词直传上限 5000 词（远高于双向流式的 100 tokens / flash 的 50）
      request.corpus = {
        context: JSON.stringify({ hotwords: hotwords.slice(0, 5000).map(w => ({ word: String(w) })) })
      }
    }
    const full = {
      user: { uid: 'diary_miniprogram' },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
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

'''

MAIN_OLD = '''    const text = await recognizeFlash(fileRes.fileContent, audioFormat, hotwords)'''
MAIN_NEW = '''    // [asr-nostream v1] 优先流式 2.0 整段识别（更准、更快、更便宜）；
    // 失败且总耗时在预算内时回退极速版 flash（另一商品线，仍有余量），保证可用性
    let text
    try {
      text = await recognizeNostream(fileRes.fileContent, audioFormat, hotwords)
    } catch (eNostream) {
      if (Date.now() - startedAt > FLASH_FALLBACK_BUDGET_MS) throw eNostream
      text = await recognizeFlash(fileRes.fileContent, audioFormat, hotwords)
    }'''

PKG_DESC_OLD = '''  "description": "语音识别云函数（百度 ASR）",'''
PKG_DESC_NEW = '''  "description": "语音识别云函数（火山流式 2.0 整段识别 + 极速版回退）",'''

PKG_DEP_OLD = '''  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }'''
PKG_DEP_NEW = '''  "dependencies": {
    "wx-server-sdk": "~2.6.3",
    "ws": "^8.18.0"
  }'''

TEST_HOOK_OLD = '''Module._load = function (request) {
  if (request === 'wx-server-sdk') return sdk
  if (request === 'https') return fakeHttps
  return origLoad.apply(this, arguments)
}'''
TEST_HOOK_NEW = '''Module._load = function (request) {
  if (request === 'wx-server-sdk') return sdk
  if (request === 'https') return fakeHttps
  // [asr-nostream v1] 屏蔽真实 ws：speechToText 优先流式 2.0，此处令其即刻失败走 flash 回退路径
  if (request === 'ws') throw new Error('mock: ws blocked')
  return origLoad.apply(this, arguments)
}'''

OPS = [
    {
        'file': 'cloudfunctions/speechToText/index.js',
        'old': '// [ai-usage v1] 商业化埋点：每次语音识别写一条 ai_usage（绝不阻塞业务返回）',
        'new': NEW_BLOCK + '// [ai-usage v1] 商业化埋点：每次语音识别写一条 ai_usage（绝不阻塞业务返回）',
        'guard': "const NOSTREAM_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'",
    },
    {
        'file': 'cloudfunctions/speechToText/index.js',
        'old': MAIN_OLD,
        'new': MAIN_NEW,
        'guard': 'if (Date.now() - startedAt > FLASH_FALLBACK_BUDGET_MS) throw eNostream',
    },
    {
        'file': 'cloudfunctions/speechToText/package.json',
        'old': PKG_DESC_OLD,
        'new': PKG_DESC_NEW,
        'guard': '语音识别云函数（火山流式 2.0 整段识别 + 极速版回退）',
    },
    {
        'file': 'cloudfunctions/speechToText/package.json',
        'old': PKG_DEP_OLD,
        'new': PKG_DEP_NEW,
        'guard': '"ws": "^8.18.0"',
    },
    {
        'file': 'tools/test_ai_usage.js',
        'old': TEST_HOOK_OLD,
        'new': TEST_HOOK_NEW,
        'guard': "if (request === 'ws') throw new Error('mock: ws blocked')",
    },
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return raw.replace('\r\n', '\n'), crlf


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(ROOT, rel), 'wb').write(text.encode('utf-8'))


def do_backup():
    dst = os.path.join(ROOT, BACKUP)
    if os.path.isdir(dst):
        return False
    os.makedirs(dst)
    for rel in FILES:
        src = os.path.join(ROOT, rel)
        d = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(src, d)
    return True


def check(verbose=True):
    ok = True
    loaded = {}
    for rel in set(op['file'] for op in OPS):
        loaded[rel], _ = load(rel)
    for i, op in enumerate(OPS, 1):
        text = loaded[op['file']]
        if op['guard'] in text:
            status = 'SKIP(已应用)'
        elif text.count(op['old']) == 1:
            status = 'OK'
        else:
            status = 'FAIL(锚点 %d 次)' % text.count(op['old'])
            ok = False
        if verbose:
            print('op%d %s %s' % (i, status, op['file']))
    return ok


def write():
    do_backup()
    # 只加载一次（防补丁九坑之五：重复 load 冲回磁盘原样）
    loaded = {}
    for rel in set(op['file'] for op in OPS):
        loaded[rel], crlf = load(rel)
        loaded[rel + ':crlf'] = crlf
    for i, op in enumerate(OPS, 1):
        text = loaded[op['file']]
        if op['guard'] in text:
            print('op%d SKIP(已应用)' % i)
            continue
        n = text.count(op['old'])
        if n != 1:
            print('op%d FAIL(锚点 %d 次)' % (i, n))
            return 1
        loaded[op['file']] = text.replace(op['old'], op['new'], 1)
        print('op%d OK' % i)
    for rel in set(op['file'] for op in OPS):
        save(rel, loaded[rel], loaded[rel + ':crlf'])
    print('written.')
    return 0


def restore_src():
    dst = os.path.join(ROOT, BACKUP)
    if not os.path.isdir(dst):
        print('no backup dir: ' + BACKUP)
        return 1
    for rel in FILES:
        src = os.path.join(dst, rel)
        if not os.path.exists(src):
            print('missing in backup: ' + rel)
            continue
        shutil.copy2(src, os.path.join(ROOT, rel))
        print('restored: ' + rel)
    return 0


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--check':
        sys.exit(0 if check() else 1)
    elif mode == '--write':
        sys.exit(write())
    elif mode == '--restore-src':
        sys.exit(restore_src())
    else:
        print(__doc__)
        sys.exit(2)
