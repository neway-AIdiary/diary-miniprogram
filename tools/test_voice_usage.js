// tools/test_voice_usage.js
// [voice-usage v1] 流式语音用量记账：补上「客户端直连火山」这条主链路的记账缺口（2026-09-24）
//
// 背景（用户报障）：getAiStats 里 byFn.speechToText.count = 3，但「试了几次语音都没 +1」。
// 根因：语音有两条链路，埋点只加在云函数侧 ——
//   · Android/开发者工具的**火山流式识别由客户端直连**，全程不调任何云函数 ⇒ 用量不可计；
//   · iOS / 流式失败回退经 speechToText 云函数 ⇒ 已由云函数内部记账（那 3 条来自这里）。
// 修法（用户拍板：方案 1 + A + B + C）：客户端只在流式会话收尾上报一次；误触取消、回退整段都不上报。
//
// 分两段：
//   A 静态契约：源码/云函数必须真接线（含「回退链路绝不上报」的反向断言）
//   B 行为场景：流式成功 / 没听清 / 误触 / 未连上回退 / 记账失败不干扰交付
const path = require('path')
const fs = require('fs')
const MOD = path.resolve('utils/voice.js')
const volc = require(path.resolve('utils/volcProto.js'))

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8')
const count = (s, sub) => s.split(sub).length - 1

let pass = 0, fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ===================== A. 静态契约 ===================== */
console.log('[A] 静态契约：源码与云函数接线')
{
  const vj = read('utils/voice.js')

  ok(count(vj, 'function reportVoiceUsage(recognized)') === 1 &&
    count(vj, 'reportVoiceUsage(!!r.text)') === 1,
    'A1 有且仅有一处上报函数定义 + 一处调用', count(vj, 'reportVoiceUsage'))

  ok(vj.indexOf("name: 'logVoiceUsage'") !== -1,
    'A2 上报调用的是新建的 logVoiceUsage 云函数')

  const fn = vj.slice(vj.indexOf('function reportVoiceUsage'), vj.indexOf('// ===== 回退链路'))
  ok(fn.indexOf("mode: 'stream'") !== -1 && fn.indexOf('seconds: sessionSeconds') !== -1 &&
    fn.indexOf('ok: !!recognized') !== -1,
    'A3 上报字段 = mode/seconds/ok（秒数给额度制用）')
  ok(fn.indexOf('await ') === -1 && fn.indexOf('.catch(') !== -1,
    'A4 静默 fire-and-forget：不 await + 带 catch（记账绝不干扰语音交互）')

  ok(fn.indexOf('if (usageReported) return') !== -1,
    'A5 防重入：一次会话只上报一条（finalizeStream 有多条触发路径）')
  ok(fn.indexOf('if (!sessionStreamUsed || sessionBatchUsed) return') !== -1,
    'A6 只在「纯流式」会话上报（未连上/已回退的一律交给云端记账）')
  ok(fn.indexOf('if (cancelRequested) return') !== -1,
    'A7 误触取消不上报（用户 A 口径）')

  ok(vj.indexOf('    socketOpen = true\n') !== -1 &&
    vj.indexOf('sessionStreamUsed = true') > vj.indexOf('    socketOpen = true\n'),
    'A8 「纯流式」标记在 WS 真连上（onOpen）时才置位')

  const tr = vj.slice(vj.indexOf('async function transcribe'), vj.indexOf('function deliver('))
  ok(tr.indexOf('sessionBatchUsed = true') !== -1,
    'A9 回退整段链路标记「已由云端记账」')
  ok(tr.indexOf('reportVoiceUsage') === -1 && tr.indexOf("name: 'logVoiceUsage'") === -1,
    'A10 ★ 回退链路内零客户端上报（防双计的反向断言）')

  ok(vj.indexOf('sessionSeconds = state.seconds') !== -1 &&
    vj.indexOf('sessionSeconds = state.seconds') < vj.indexOf('sessionSeconds = 0\n  sessionStreamUsed'),
    'A11 秒数在 onStop 冻结后再由下一轮 start 复位（顺序不能反）')

  const fin = vj.slice(vj.indexOf('function finalizeStream'), vj.indexOf('// ===== [voice-usage v1] 流式链路用量上报'))
  ok(fin.indexOf('reportVoiceUsage(!!r.text)') !== -1,
    'A12 上报挂在流式收尾（唯一交付点）')

  const cf = read('cloudfunctions/logVoiceUsage/index.js')
  ok(cf.indexOf("fn: 'speechToText'") !== -1 && cf.indexOf("mode: 'stream'") !== -1 &&
    cf.indexOf("source: 'client'") !== -1,
    'A13 云函数侧口径：fn=speechToText + mode=stream + source=client（byFn 可与云端记账相加）')
  ok(cf.indexOf("collection('ai_usage').add") !== -1 && cf.indexOf('catch (e)') !== -1 &&
    cf.indexOf('console.warn') !== -1,
    'A14 写 ai_usage 且失败只 warn（集合缺失不阻塞客户端）')
  ok(cf.indexOf('Math.max(0, Math.min(') !== -1,
    'A15 秒数夹紧 [0,3600]，防脏数据污染额度统计')

  const pkg = read('cloudfunctions/logVoiceUsage/package.json')
  ok(pkg.indexOf('wx-server-sdk') !== -1,
    'A16 package.json 声明 wx-server-sdk（部署须勾「云端安装依赖」）')
}

/* ===================== 行为桩 ===================== */
function freshVoice() {
  delete require.cache[require.resolve(MOD)]
  return require(MOD)
}

const store = {}
function clearStore() { Object.keys(store).forEach((k) => { delete store[k] }) }

// 构造服务端结果帧（Header + Size + JSON 载荷；msgType=0x9、flags=0）
function serverFrame(obj) {
  const payload = volc.utf8Encode(JSON.stringify(obj))
  const buf = new ArrayBuffer(8 + payload.length)
  const u8 = new Uint8Array(buf)
  const dv = new DataView(buf)
  u8[0] = 0x11; u8[1] = 0x90; u8[2] = 0x11; u8[3] = 0x00
  dv.setUint32(4, payload.length)
  u8.set(payload, 8)
  return buf
}

function makeWx(opts) {
  opts = opts || {}
  clearStore()
  const calls = { cloudCalls: [], sender: 0, socketClose: 0, recorderStart: [] }
  let openCb = null, closeCb = null, messageCb = null
  const manager = { _startCb: null, _stopCb: null, _errCb: null, _frameCb: null }
  manager.onStart = (cb) => { manager._startCb = cb }
  manager.onStop = (cb) => { manager._stopCb = cb }
  manager.onError = (cb) => { manager._errCb = cb }
  manager.onFrameRecorded = (cb) => { manager._frameCb = cb }
  manager.onInterruptionBegin = () => {}
  manager.start = (o) => {
    calls.recorderStart.push(o)
    setTimeout(() => { if (manager._startCb) manager._startCb() }, 5)
  }
  manager.stop = () => {
    setTimeout(() => { if (manager._stopCb) manager._stopCb({ tempFilePath: '/tmp/mock.pcm' }) }, 5)
  }

  const task = {
    onOpen: (cb) => { openCb = cb },
    onClose: (cb) => { closeCb = cb },
    onError: () => {},
    onMessage: (cb) => { messageCb = cb },
    send: () => { calls.sender++ },
    close: () => { calls.socketClose++; }
  }

  const wx = {
    getSystemInfoSync: () => ({ platform: opts.platform || 'android' }),
    getSetting: (o) => { if (o && o.success) o.success({ authSetting: { 'scope.record': true } }) },
    cloud: {
      callFunction: (p) => {
        calls.cloudCalls.push({ name: p.name, data: (p.data || null) })
        return new Promise((resolve, reject) => {
          if (p.name === 'logVoiceUsage' && opts.logReject) return reject(new Error('log fail'))
          if (p.name === 'speechToText') return resolve({ result: { text: opts.batchText || '回退识别文字' } })
          resolve({ result: { apiKey: 'KEY', appId: '', accessToken: '' } })
        })
      },
      uploadFile: () => Promise.resolve({ fileID: 'cloud://mock/voice.pcm' })
    },
    authorize: (o) => { setTimeout(() => o.success && o.success(), 0) },
    connectSocket: () => task,
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    getRecorderManager: () => manager,
    showToast: () => {},
    showModal: (o) => { if (o && o.success) o.success({ confirm: false }) },
    openSetting: () => {}
  }
  return {
    wx, calls, task,
    fireOpen: () => openCb && openCb(),
    fireClose: () => closeCb && closeCb(),
    fireMessage: (d) => messageCb && messageCb({ data: d }),
    logCalls: () => calls.cloudCalls.filter((c) => c.name === 'logVoiceUsage'),
    batchCalls: () => calls.cloudCalls.filter((c) => c.name === 'speechToText')
  }
}

// 跑一轮完整流式会话：start → (连上) → 可选结果帧 → 松手 → 服务端关闭收尾
async function streamSession(h, o) {
  o = o || {}
  const delivered = []
  global.getApp = () => ({ globalData: { voiceTarget: { handle: (t) => delivered.push(t) } } })
  const v = freshVoice()
  v.start({ contextText: '' })
  await wait(20)
  if (o.connect !== false) h.fireOpen()
  await wait(o.holdMs || 400)
  if (o.text) h.fireMessage(serverFrame({ result: { text: o.text } }))
  v.stop()
  await wait(30)
  h.fireClose()
  await wait(30)
  return { v, delivered }
}

async function main() {
  /* ===================== B. 流式成功 ===================== */
  console.log('[B] 流式会话识别成功 → 恰好上报一次')
  {
    const h = makeWx({})
    global.wx = h.wx
    const { delivered } = await streamSession(h, { text: '今天去了公园', holdMs: 1200 })
    const logs = h.logCalls()
    ok(delivered.length === 1 && delivered[0] === '今天去了公园', 'B1 识别结果正常交付（上报不影响业务）', JSON.stringify(delivered))
    ok(logs.length === 1, 'B2 恰好上报一次（★ 本次修复的核心）', logs.length)
    ok(logs.length === 1 && logs[0].data && logs[0].data.mode === 'stream' &&
      logs[0].data.ok === true && logs[0].data.seconds >= 1,
      'B3 字段正确：mode=stream / ok=true / seconds≥1（秒数给额度制）', logs.length ? JSON.stringify(logs[0].data) : 'none')
    ok(h.batchCalls().length === 0, 'B4 流式链路不调 speechToText（不重复走云端）')
  }

  /* ===================== C. 没听清也算了 ===================== */
  console.log('[C] 流式会话没听清 → 仍上报（火山时长已消耗）')
  {
    const h = makeWx({})
    global.wx = h.wx
    const { delivered } = await streamSession(h, { text: '' })
    const logs = h.logCalls()
    ok(delivered.length === 0, 'C1 没听清不交付文字')
    ok(logs.length === 1 && logs[0].data.ok === false,
      'C2 仍记一条 ok=false（用户确实用掉了服务时长）', logs.length ? JSON.stringify(logs[0].data) : 'none')
  }

  /* ===================== D. 误触取消 ===================== */
  console.log('[D] 误触（<300ms 松手）→ 不上报')
  {
    const h = makeWx({})
    global.wx = h.wx
    global.getApp = () => ({ globalData: { voiceTarget: { handle: () => {} } } })
    const v = freshVoice()
    v.start({ contextText: '' })
    await wait(20)
    h.fireOpen()
    await wait(30)
    v.stop()               // 按下不足 300ms ⇒ cancelSession
    await wait(40)
    h.fireClose()
    await wait(30)
    ok(h.logCalls().length === 0, 'D1 误触不上报（用户 A 口径：不记无效操作）', h.logCalls().length)
    ok(h.batchCalls().length === 0, 'D2 误触也不触发整段识别')
  }

  /* ===================== E. 未连上 → 回退整段 ===================== */
  console.log('[E] WS 未连上 → 回退整段识别 → 只由云端记账（零双计）')
  {
    const h = makeWx({ batchText: '回退识别文字' })
    global.wx = h.wx
    const { delivered } = await streamSession(h, { connect: false, holdMs: 400 })
    ok(h.batchCalls().length === 1, 'E1 回退链路调用 speechToText 一次', h.batchCalls().length)
    ok(h.logCalls().length === 0,
      'E2 ★ 回退链路不做客户端上报（speechToText 内部已记账 ⇒ 不双计）', h.logCalls().length)
    ok(delivered.length === 1 && delivered[0] === '回退识别文字', 'E3 回退结果正常交付', JSON.stringify(delivered))
  }

  /* ===================== F. 记账失败不干扰 ===================== */
  console.log('[F] 记账失败（云函数异常）→ 静默，业务不受影响')
  {
    const h = makeWx({ logReject: true })
    global.wx = h.wx
    let unhandled = null
    const onUnhandled = (e) => { unhandled = e }
    process.on('unhandledRejection', onUnhandled)
    const { delivered } = await streamSession(h, { text: '记账挂了也要出字', holdMs: 400 })
    await wait(40)
    process.removeListener('unhandledRejection', onUnhandled)
    ok(delivered.length === 1 && delivered[0] === '记账挂了也要出字',
      'F1 上报被拒时文字照常交付（记账绝不阻塞业务）', JSON.stringify(delivered))
    ok(h.logCalls().length === 1, 'F2 上报确实发起了（是「失败」而不是「没发」）', h.logCalls().length)
    ok(!unhandled, 'F3 无未处理的 Promise 拒绝（.catch 兜住了）', unhandled && unhandled.message)
  }

  console.log('\n[test_voice_usage] ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
