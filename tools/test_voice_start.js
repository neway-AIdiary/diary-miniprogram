// 临时回归：验证 voice.js 启动提速改动
// A warmup 预热且幂等；B start 立即广播准备态 + 授权通过后正常进录音；
// C 授权期间取消 → connecting 复位且不启动录音；D WSS 建连超时 → 自动回退整段录音(wav)。
const path = require('path')
const MOD = path.resolve('utils/voice.js')

function freshVoice() {
  delete require.cache[require.resolve(MOD)]
  return require(MOD)
}

function makeWx(opts) {
  opts = opts || {}
  const calls = { cloud: 0, auth: 0, socketOpen: 0, socketClose: 0, recorderStart: [], setting: 0 }
  let authSuccess = null, authFail = null, authMode = opts.authMode || 'auto-ok'
  let openCb = null, closeCb = null, errCb = null, messageCb = null
  const manager = { _startCb: null, _stopCb: null, _errCb: null, _frameCb: null }
  manager.onStart = (cb) => { manager._startCb = cb }
  manager.onStop = (cb) => { manager._stopCb = cb }
  manager.onError = (cb) => { manager._errCb = cb }
  manager.onFrameRecorded = (cb) => { manager._frameCb = cb }
  manager.onInterruptionBegin = () => {}
  manager.start = (o) => {
    calls.recorderStart.push(o)
    if (opts.noStartEvent) return
    setTimeout(() => { if (manager._startCb) manager._startCb() }, 5)
  }
  manager.stop = () => {
    calls.recorderStop = (calls.recorderStop || 0) + 1
    setTimeout(() => { if (manager._stopCb) manager._stopCb({ tempFilePath: '/tmp/mock.pcm' }) }, 5)
  }

  const task = {
    onOpen: (cb) => { openCb = cb; if (opts.openAfter != null) setTimeout(() => cb && cb(), opts.openAfter) },
    onClose: (cb) => { closeCb = cb },
    onError: (cb) => { errCb = cb },
    onMessage: (cb) => { messageCb = cb },
    send: (o) => { calls.sent = (calls.sent || 0) + 1 },
    close: (o) => { calls.socketClose++; if (closeCb) setTimeout(() => closeCb(), 5) }
  }

  const wx = {
    getSystemInfoSync: () => ({ platform: opts.platform || 'android' }),
    getSetting: (o) => {
      calls.setting++
      if (o && o.success) o.success({ authSetting: { 'scope.record': opts.recordAuth !== false } })
    },
    cloud: {
      callFunction: (p) => {
        calls.cloud++
        return new Promise((resolve, reject) => {
          if (opts.cloudError) reject(new Error('cloud fail'))
          else resolve({ result: { apiKey: 'KEY_' + calls.cloud, appId: '', accessToken: '' } })
        })
      }
    },
    authorize: (o) => {
      calls.auth++
      authSuccess = o.success; authFail = o.fail
      if (authMode === 'auto-ok') setTimeout(() => o.success && o.success(), 0)
    },
    connectSocket: (o) => { calls.socketTask = task; return task },
    getRecorderManager: () => manager,
    showToast: () => {},
    showModal: (o) => { if (o && o.success) o.success({ confirm: false }) },
    openSetting: () => {}
  }
  wx.__fireAuthOk = () => authSuccess && authSuccess()
  wx.__fireAuthFail = () => authFail && authFail()
  wx.__fireOpen = () => openCb && openCb()
  return { wx, calls, manager, task }
}

let pass = 0, fail = 0
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ===== A. warmup 预热 + 幂等 =====
  console.log('[A] warmup 预热与幂等')
  {
    const h = makeWx({ recordAuth: true })
    global.wx = h.wx
    const v = freshVoice()
    const r1 = await v.warmup()
    assert(r1 === true, '已授权平台 warmup 成功')
    assert(h.calls.cloud === 1, '首次 warmup 调用 1 次云函数')
    await v.warmup()
    assert(h.calls.cloud === 1, '再次 warmup 命中缓存，不再调云函数')
  }
  {
    const h = makeWx({ recordAuth: false })
    global.wx = h.wx
    const v = freshVoice()
    const r2 = await v.warmup()
    assert(r2 === false, '未授权时 warmup 静默跳过（不拉取、不弹框）')
    assert(h.calls.cloud === 0, '未授权不调云函数')
  }

  // ===== B. start 立即准备态 + 正常链路进录音 =====
  console.log('[B] 按下即反馈 + 正常录音启动')
  {
    const h = makeWx({ openAfter: 30 })
    global.wx = h.wx
    const v = freshVoice()
    const snaps = []
    v.onStateChange((s) => snaps.push(Object.assign({}, s)))
    const t0 = Date.now()
    v.start()
    assert(snaps.length > 0 && snaps[snaps.length - 1].connecting === true, 'start 后立即广播 connecting 准备态')
    assert(snaps[snaps.length - 1].liveText === '', 'liveText 已清空')
    await wait(120)
    const st = v.getState()
    assert(st.recording === true, '录音最终进入 recording 态')
    assert(h.calls.recorderStart.length === 1, 'recorder.start 恰好 1 次')
    assert(h.calls.recorderStart[0] && h.calls.recorderStart[0].format === 'pcm', '实时链路用 pcm 格式')
    const connectSeen = snaps.some((s) => s.connecting === true)
    assert(connectSeen, '期间出现过 connecting 广播')
  }

  // ===== C. 授权弹窗期间松手取消 =====
  console.log('[C] 授权期间取消')
  {
    const h = makeWx({ authMode: 'manual' })
    global.wx = h.wx
    const v = freshVoice()
    const snaps = []
    v.onStateChange((s) => snaps.push(Object.assign({}, s)))
    v.start()
    v.stop() // 录音未开始即松手
    h.wx.__fireAuthOk() // 用户之后才点允许
    await wait(20)
    assert(h.calls.recorderStart.length === 0, '取消后不启动录音')
    const st = v.getState()
    assert(st.connecting === false && st.recording === false, '取消后 connecting/recording 复位')
  }

  // ===== D. WSS 建连超时 → 录音不受影响继续录，不重启 =====
  console.log('[D] 建连超时录音不受影响（等待 2.7s）')
  {
    const h = makeWx({ neverOpen: true }) // 不触发 onOpen
    global.wx = h.wx
    const v = freshVoice()
    const t0 = Date.now()
    v.start()
    await wait(100)
    assert(h.calls.recorderStart.length === 1, '录音在按下后立即启动（不等建连）')
    assert(v.getState().recording === true, '按下约 100ms 内已进入录音态')
    await wait(2600)
    const st = v.getState()
    assert(h.calls.socketClose >= 1, '超时后主动 close 连接')
    assert(st.recording === true, '超时后录音继续，不重启不中断')
    assert(h.calls.recorderStart.length === 1, '超时不重启录音（旧逻辑会回退重录 wav）')
    const lastStart = h.calls.recorderStart[h.calls.recorderStart.length - 1]
    assert(lastStart && lastStart.format === 'pcm', '全程同一份 pcm 录音，松手后整段识别兜底')
    console.log('  （按→可录音耗时: ' + (Date.now() - t0 - 2600) + 'ms 量级，不再包含 2.5s 建连等待）')
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
