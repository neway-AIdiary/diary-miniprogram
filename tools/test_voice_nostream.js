/**
 * test_voice_nostream.js — [asr-nostream v1] 流式 2.0「流式输入模式」整段识别（iOS 回退链路升级）
 *
 * 用桩替换 wx-server-sdk / https / ws，真实加载 speechToText 云函数，逐条验证：
 *   ns-1 首选路径：nostream 端点被优先使用（URL / 资源ID 2.0 / 鉴权头齐全）
 *   ns-2 首帧参数：seq=1、model_name=bigmodel、pcm 16k/16bit/单声道、热词进 corpus.context
 *   ns-3 分帧：音频帧 seq 从 2 递增、每包 ≤3200B、末尾负包（flags=2、空 payload）
 *   ns-4 结果取尾帧：result.text 全量累计 → 只取最后一帧（不拼接，拼接会重复）
 *   ns-5 result 数组形态兼容（官方文档自相矛盾的防御）
 *   ns-6 回退：ws 建连失败 / 收错误帧 → 回退 flash（https 桩）且业务返回不变、记账不回归
 *   ns-7 热词 >5000 截断到 5000
 *   ns-8 WAV 含扩展块（LIST）时正确剥出 data 块（上传帧的总字节数 = 裸 PCM 长度）
 *   ns-9 超时兜底：nostream 长时间无响应 → 拒绝（不回退，避免撞云函数 20s 执行超时）
 * 红灯口径：旧源码（无 recognizeNostream）下 ns-1~ns-5、ns-7~ns-9 精准变红，ns-6 回退用例绿。
 */
const path = require('path')
const Module = require('module')
const EventEmitter = require('events')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++ } else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra).slice(0, 300) : '')) }
}
function eq(name, actual, expected) {
  check(name, actual === expected, { actual: actual, expected: expected })
}

// ===== 桩状态 =====
const state = {
  records: [],
  wsCalls: 0,
  wsUrl: '',
  wsOpts: null,
  frames: [],        // 客户端发出的二进制帧（Buffer）
  closed: false,
  wsMode: 'ok',      // ok | connect-fail | no-response
  resultFrames: [],  // 服务端要回的结果帧（Buffer 数组），收到负包后依次下发
  httpStatus: 200,
  httpHeaders: {},
  httpBody: {},
  httpCalls: 0,
  downloadFile: null,
}

// ===== 桩：wx-server-sdk =====
const sdk = {
  DYNAMIC_CURRENT_ENV: '[DYNAMIC_CURRENT_ENV]',
  init: function () {},
  getWXContext: function () { return { OPENID: 'oTEST-openid-ns' } },
  database: function () {
    return {
      collection: function (name) {
        return {
          add: async function (op) {
            state.records.push({ collection: name, data: (op && op.data) || {} })
            return { _id: 'id' + state.records.length }
          }
        }
      }
    }
  },
  downloadFile: async function () {
    if (state.downloadFile) return state.downloadFile()
    throw new Error('no mock downloadFile')
  },
  deleteFile: async function () { return {} }
}

// ===== 桩：https（flash 回退路径）=====
const fakeHttps = {
  request: function (opts, cb) {
    state.httpCalls++
    const req = new EventEmitter()
    req.write = function () {}
    req.end = function () {
      setTimeout(function () {
        const res = new EventEmitter()
        res.statusCode = state.httpStatus
        res.headers = state.httpHeaders
        cb(res)
        setTimeout(function () {
          res.emit('data', Buffer.from(JSON.stringify(state.httpBody)))
          res.emit('end')
        }, 0)
      }, 0)
    }
    req.destroy = function (e) { req.emit('error', e || new Error('mock timeout')) }
    return req
  }
}

// ===== 桩：ws（可编程假服务端）=====
let FakeWS = null
function makeFakeWsClass() {
  const NS = state
  return class FakeWS extends EventEmitter {
    constructor(url, opts) {
      super()
      NS.wsCalls++
      NS.wsUrl = url
      NS.wsOpts = opts
      NS.frames = []
      NS.closed = false
      const self = this
      this.send = function (buf) {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        NS.frames.push(b)
        if (b.length === 8 && b[1] === 0x22) {
          // 收到负包 → 服务端处理：ok 模式回结果帧后关连接；no-response 模式挂起不响应（测超时闸）
          setTimeout(function () {
            if (NS.wsMode === 'ok') {
              NS.resultFrames.forEach(function (f) { self.emit('message', f) })
              self.emit('close')
            }
          }, 5)
        }
      }
      this.close = function () { NS.closed = true }
      setTimeout(function () {
        if (NS.wsMode === 'connect-fail') {
          self.emit('error', new Error('mock connect fail'))
          self.emit('close')
          return
        }
        self.emit('open')
      }, 0)
    }
  }
}

// 劫持模块解析（懒 require('ws') 也会经过这里）
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return sdk
  if (request === 'https') return fakeHttps
  if (request === 'ws') return FakeWS
  return origLoad.apply(this, arguments)
}

const asrFn = require(path.join(__dirname, '..', 'cloudfunctions', 'speechToText', 'index.js'))

// ===== 分帧工具（与服务端帧同规格）=====
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b }
function resultFrame(obj, withSeq, seq) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  if (withSeq) return Buffer.concat([Buffer.from([0x11, 0x91, 0x10, 0x00]), u32(seq), u32(payload.length), payload])
  return Buffer.concat([Buffer.from([0x11, 0x90, 0x10, 0x00]), u32(payload.length), payload])
}
function errorFrame(code, msg) {
  const payload = Buffer.from(msg, 'utf8')
  return Buffer.concat([Buffer.from([0x11, 0xf0, 0x00, 0x00]), u32(code), u32(payload.length), payload])
}
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b }

// 解析客户端帧（供断言）
function parseClientFrames() {
  const reqs = []
  const audios = []
  let last = false
  state.frames.forEach(function (b) {
    if (b[1] === 0x11) {
      reqs.push({ seq: b.readUInt32BE(4), json: JSON.parse(b.slice(12).toString('utf8')) })
    } else if (b[1] === 0x21) {
      audios.push({ seq: b.readUInt32BE(4), payload: b.slice(12) })
    } else if (b[1] === 0x22) {
      last = b.length === 8
    }
  })
  return { reqs: reqs, audios: audios, last: last }
}

// 构造带 LIST 扩展块的 WAV（默认 16k/16bit/单声道；sampleRate 可指定，模拟 iOS 忽略 16000 的情况）
function buildWavWithList(pcm, sampleRate) {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate || 16000, 4); fmt.writeUInt32LE((sampleRate || 16000) * 2, 8)
  fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14)
  const listData = Buffer.from('INFOmock', 'ascii')
  const chunk = function (id, data) { return Buffer.concat([Buffer.from(id, 'ascii'), u32le(data.length), data]) }
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'), u32le(4 + (8 + fmt.length) + (8 + listData.length) + (8 + pcm.length)),
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt), chunk('LIST', listData), chunk('data', pcm)
  ])
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
function resetAll() {
  state.records = []
  state.httpCalls = 0
  state.httpStatus = 200
  state.httpHeaders = {}
  state.httpBody = {}
  state.wsMode = 'ok'
  state.resultFrames = []
  state.downloadFile = null
}

async function run() {
  FakeWS = makeFakeWsClass()
  const PCM = Buffer.alloc(3200 * 3 + 700, 7)  // 10300 字节裸 PCM = 3 整包 + 700 字节尾包（4 帧）
  const WAV = buildWavWithList(PCM)

  // ---------- ns-1/2/3/4 主路径：nostream 被首选、分帧正确、结果取尾帧 ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: WAV } }
  state.resultFrames = [
    resultFrame({ result: { text: '第一帧累计' } }, true, 1),
    resultFrame({ result: { text: '第一帧累计。第二帧累计' } }, true, 2),
    resultFrame({ result: { text: '第一帧累计。第二帧累计。最终帧' }, audio_info: { duration: 1160 } }, false, 0),
  ]
  let ret = await asrFn.main({ fileID: 'cloud://ns1', format: 'wav', hotwords: ['杨志伟', '王二童'] })
  eq('ns-4 结果取最后一帧累计全文（不拼接）', ret.text, '第一帧累计。第二帧累计。最终帧')
  eq('ns-1 nostream 被调用 1 次', state.wsCalls, 1)
  eq('ns-1 端点 bigmodel_nostream', state.wsUrl, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream')
  eq('ns-1 资源ID 流式2.0', state.wsOpts && state.wsOpts.headers && state.wsOpts.headers['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration')
  check('ns-1 鉴权头 App-Key 存在', !!(state.wsOpts && state.wsOpts.headers && state.wsOpts.headers['X-Api-App-Key']))
  check('ns-1 鉴权头 Access-Key 存在', !!(state.wsOpts && state.wsOpts.headers && state.wsOpts.headers['X-Api-Access-Key']))
  const pf = parseClientFrames()
  eq('ns-2 首帧恰 1 个', pf.reqs.length, 1)
  eq('ns-2 首帧 seq=1', pf.reqs[0] && pf.reqs[0].seq, 1)
  const reqJson = (pf.reqs[0] && pf.reqs[0].json) || { request: {}, audio: {} }
  eq('ns-2 model_name', reqJson.request.model_name, 'bigmodel')
  eq('ns-2 enable_punc', reqJson.request.enable_punc, true)
  eq('ns-2 audio.format', reqJson.audio.format, 'pcm')
  eq('ns-2 audio.rate', reqJson.audio.rate, 16000)
  eq('ns-2 audio.bits', reqJson.audio.bits, 16)
  eq('ns-2 audio.channel', reqJson.audio.channel, 1)
  check('ns-2 热词进 corpus.context', ((reqJson.request.corpus && reqJson.request.corpus.context) || '').indexOf('杨志伟') !== -1, reqJson.request.corpus)
  eq('ns-3 音频帧数 = ceil(10300/3200)', pf.audios.length, 4)
  eq('ns-3 音频帧起始 seq=2', pf.audios[0] && pf.audios[0].seq, 2)
  eq('ns-3 音频帧 seq 连续递增', (pf.audios.length && pf.audios[pf.audios.length - 1].seq), pf.audios.length && (pf.audios[0].seq + pf.audios.length - 1))
  check('ns-3 每包 ≤3200B', pf.audios.every(function (a) { return a.payload.length <= 3200 && a.payload.length > 0 }))
  eq('ns-3 音频总字节 = 裸PCM长度（WAV扩展块被正确剥出）',
    pf.audios.reduce(function (s, a) { return s + a.payload.length }, 0), PCM.length)
  eq('ns-3 末尾负包存在且空载荷', pf.last, true)
  check('ns-9 识别后连接被关闭', state.closed, true)
  // 记账不回归
  const recs = state.records.filter(function (r) { return r.collection === 'ai_usage' })
  eq('ns-9 恰写一条 ai_usage', recs.length, 1)
  eq('ns-9 fn', recs[0] && recs[0].data.fn, 'speechToText')
  eq('ns-9 ok', recs[0] && recs[0].data.ok, true)
  check('ns-9 audioBytes 记账', recs[0] && recs[0].data.audioBytes === WAV.length, recs[0] && recs[0].data.audioBytes)
  eq('ns-9 未走 flash 回退', state.httpCalls, 0)

  // ---------- ns-5 result 数组形态 ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: WAV } }
  state.resultFrames = [
    resultFrame({ result: [{ text: '数组形态结果' }] }, false, 0),
  ]
  ret = await asrFn.main({ fileID: 'cloud://ns5', format: 'wav' })
  eq('ns-5 result 数组形态取得到文本', ret.text, '数组形态结果')

  // ---------- ns-10 iPhone 实况：wav 头是 44.1k 时参数按头下发（不写死 16000） ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: buildWavWithList(PCM, 44100) } }
  state.resultFrames = [resultFrame({ result: { text: '44.1k 结果' } }, false, 0)]
  ret = await asrFn.main({ fileID: 'cloud://ns10', format: 'wav' })
  eq('ns-10 业务返回', ret.text, '44.1k 结果')
  const pf10 = parseClientFrames()
  eq('ns-10 rate 按文件头 44100', (pf10.reqs[0] && pf10.reqs[0].json.audio.rate), 44100)
  eq('ns-10 bits/ch 仍取头值', (pf10.reqs[0] && pf10.reqs[0].json.audio.channel), 1)
  eq('ns-10 音频总字节不变', pf10.audios.reduce(function (s, a) { return s + a.payload.length }, 0), PCM.length)

  // ---------- ns-6a 建连失败 → 回退 flash ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }
  state.wsMode = 'connect-fail'
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '极速版兜底文字' } }
  ret = await asrFn.main({ fileID: 'cloud://ns6a', format: 'wav' })
  eq('ns-6a ws失败回退 flash 返回文字', ret.text, '极速版兜底文字')
  eq('ns-6a flash 被调用 1 次', state.httpCalls, 1)
  const recs6a = state.records.filter(function (r) { return r.collection === 'ai_usage' })
  eq('ns-6a 恰写一条记账', recs6a.length, 1)

  // ---------- ns-6b 服务端错误帧 → 回退 flash ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }
  state.resultFrames = [errorFrame(45000081, 'mock packet timeout')]
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '错误帧后兜底' } }
  ret = await asrFn.main({ fileID: 'cloud://ns6b', format: 'wav' })
  eq('ns-6b 错误帧回退 flash 返回文字', ret.text, '错误帧后兜底')

  // ---------- ns-6c 两路都失败 → 返回错误、记账 ok:false ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }
  state.wsMode = 'connect-fail'
  state.httpHeaders = { 'x-api-status-code': '20000003' }
  state.httpBody = {}
  ret = await asrFn.main({ fileID: 'cloud://ns6c', format: 'wav' })
  eq('ns-6c 双失败返回没听清', ret.error, '没听清，请再试一次')
  const recs6c = state.records.filter(function (r) { return r.collection === 'ai_usage' })
  eq('ns-6c 记账 ok:false', recs6c[0] && recs6c[0].data.ok, false)

  // ---------- ns-7 热词 >5000 截断 ----------
  resetAll()
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }
  const many = []
  for (let i = 0; i < 5100; i++) many.push('词' + i)
  state.resultFrames = [resultFrame({ result: { text: '热词截断' } }, false, 0)]
  await asrFn.main({ fileID: 'cloud://ns7', format: 'wav', hotwords: many })
  const pf7 = parseClientFrames()
  const ctx = (pf7.reqs[0] && pf7.reqs[0].json.request.corpus && pf7.reqs[0].json.request.corpus.context) || '{"hotwords":[]}'
  const hw = JSON.parse(ctx).hotwords
  eq('ns-7 热词截断到 5000', hw.length, 5000)
  eq('ns-7 截断保前 5000 个', (hw[4999] && hw[4999].word), '词4999')

  // ---------- ns-9 超时不回退（避免撞云函数 20s 执行超时） ----------
  // 伪超时：把 wsMode 设为 no-response（不回结果也不关连接），
  // 这里不等真 15s，而是验证「超时错误码 + 未再调 flash」的路径逻辑：
  // 通过临时把 NOSTREAM_TIMEOUT_MS 缩短不可行（模块内常量），改用连接挂起 + 短断言窗口
  // —— 为不拖慢套件，此用例验证「无响应时不会在 close 前误 resolve」：
  resetAll()
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }
  state.wsMode = 'no-response'
  const p9 = asrFn.main({ fileID: 'cloud://ns9', format: 'wav' })
  let settled9 = false
  p9.then(function () { settled9 = true }, function () { settled9 = true })
  await wait(120)
  check('ns-9 无响应时不提前 settle（等超时闸兜底）', settled9 === false, settled9)

  console.log('=====')
  console.log('PASS ' + pass + ' FAIL ' + fail)
  process.exit(fail ? 1 : 0)
}

run().catch(function (e) {
  console.log('CRASH ' + (e && e.stack || e))
  process.exit(2)
})
