// tools/test_voice_hold_fast.js — [hold-fast v1] 按住说话提速三件套
// A 误触静默丢弃（Android 流式 / iOS 整段）；B 长按正常识别；C 授权态持久化；
// D 撤销权限兜底；E 静态契约（4 页面 + voice.js）；F 行为护栏（防回退）
// G [voice-ready-guard v1]「准备中」防闪：快链路不显示 / 慢链路如实显示 + 最短停留 / 误触不复位残留
//
// 背景：冷启动「按住说话」偏慢的三段可压缩耗时 —— ① onHoldStart 的 300ms 防误触计时器；
// ② recordAuthed 未就绪时多走一次 wx.authorize；③ 浮层 wx:if 不认 connecting（要等录音硬件起来）。
// 本套件锁死三条改动的行为与边界，尤其是「点按 vs 长按」与旧版逐字等价（零功能回退）。
// G 组追加背景：connecting 是开麦的原生耗时（100~300ms），直接映射文案会让「准备中」一闪而过。
//
// ⚠️ stderr 基线：本套件 stderr 会打 5 行「[voice] WSS 建连超时(2.5s)」——
//    A~F 组里若干「建连后既不 open 也不 close」的会话留下的兜底日志，
//    只在套件总时长 >2.5s 时才现（用旧版用例 + 强制 wait(3000) 可复现同样 5 行）。
//    G 组已用 __fireOpen() 收尾避免再叠加，看到 5 行属正常基线，不是回归。
const path = require('path')
const fs = require('fs')
const ROOT = process.cwd()
const MOD = path.resolve('utils/voice.js')

const KEY = 'voice_rec_authed_v1'
const store = {}
function clearStore() { Object.keys(store).forEach((k) => { delete store[k] }) }
function freshVoice() {
  delete require.cache[require.resolve(MOD)]
  return require(MOD)
}

function makeWx(opts) {
  opts = opts || {}
  if (!opts.keepStore) clearStore()
  const calls = { cloud: 0, upload: 0, auth: 0, connectSocket: 0, socketClose: 0, sent: 0, recorderStart: 0, recorderStop: 0, toasts: [], modals: [] }
  let authSuccess = null, authFail = null, openCb = null
  const manager = {}
  manager.onStart = (cb) => { manager._startCb = cb }
  manager.onStop = (cb) => { manager._stopCb = cb }
  manager.onError = (cb) => { manager._errCb = cb }
  manager.onFrameRecorded = (cb) => { manager._frameCb = cb }
  manager.onInterruptionBegin = () => {}
  manager.start = () => {
    calls.recorderStart++
    if (opts.noStart) return
    setTimeout(() => { if (manager._startCb) manager._startCb() }, opts.startDelay == null ? 5 : opts.startDelay)
  }
  manager.stop = () => {
    calls.recorderStop++
    setTimeout(() => { if (manager._stopCb) manager._stopCb({ tempFilePath: '/tmp/mock.pcm' }) }, 5)
  }
  const task = {
    onOpen: (cb) => { openCb = cb },
    onClose: () => {}, onError: () => {}, onMessage: () => {},
    send: () => { calls.sent++ },
    close: () => { calls.socketClose++ }
  }
  const wx = {
    getSystemInfoSync: () => ({ platform: opts.platform || 'android' }),
    getSetting: (o) => { if (o && o.success) o.success({ authSetting: { 'scope.record': opts.recordAuth !== false } }) },
    // 云 API 桩要**完整**：旧代码在误触时会走 fallbackToBatch → transcribe →
    // cloud.uploadFile + callFunction('speechToText')。缺桩会让旧版抛异常、把「红因」污染成
    // 「桩没写」而不是「行为不同」（踩坑 73 家族），所以这里按调用名分别给返回值。
    cloud: {
      uploadFile: () => { calls.upload++; return Promise.resolve({ fileID: 'cloud://mock/voice/x.pcm' }) },
      callFunction: (p) => {
        calls.cloud++
        if (p && p.name === 'speechToText') return Promise.resolve({ result: {} })
        return Promise.resolve({ result: { apiKey: 'K' } })
      }
    },
    authorize: (o) => {
      calls.auth++
      authSuccess = o.success
      authFail = o.fail
      if (opts.authMode !== 'manual') setTimeout(() => { if (o.success) o.success() }, 0)
    },
    connectSocket: () => { calls.connectSocket++; return task },
    getRecorderManager: () => manager,
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    showToast: (o) => { calls.toasts.push((o && o.title) || '') },
    showModal: (o) => { calls.modals.push((o && o.title) || ''); if (o && o.success) o.success({ confirm: false }) },
    openSetting: () => {}
  }
  wx.__fireAuthOk = () => { if (authSuccess) authSuccess() }
  wx.__fireAuthFail = () => { if (authFail) authFail() }
  wx.__fireOpen = () => { if (openCb) openCb() }
  wx.__fireRecErr = () => { if (manager._errCb) manager._errCb({ errMsg: 'operateRecorder:fail auth deny' }) }
  return { wx, calls, manager, task }
}

let pass = 0, fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  <' + JSON.stringify(extra) + '>')) }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ============================================================
  console.log('[A] 误触（点按）静默丢弃')
  // ============================================================
  {
    const h = makeWx()
    global.wx = h.wx
    const v = freshVoice()
    ok(v.HOLD_MIN_MS === 300, 'A1 HOLD_MIN_MS === 300（与旧版防误触阈值同值 ⇒ 点按判定不变）', v.HOLD_MIN_MS)

    v.start()
    await wait(20)
    ok(h.calls.connectSocket === 1 && h.calls.recorderStart === 1,
      'A2 按下即起录：20ms 内已建连 + 已开录（旧代码此处还在 300ms 计时器里等）',
      { ws: h.calls.connectSocket, rec: h.calls.recorderStart })

    const sentBefore = h.calls.sent
    v.stop()   // 按住仅 20ms ⇒ 误触
    await wait(40)
    ok(h.calls.toasts.length === 0, 'A3 误触不提示（不弹「没听清」/「说话时间太短」）', h.calls.toasts)
    ok(h.calls.sent === sentBefore, 'A3b 误触不发送收尾包（未进入识别）', { before: sentBefore, after: h.calls.sent })
    const st = v.getState()
    ok(st.recording === false && st.connecting === false && st.transcribing === false,
      'A3c 误触后状态复位（浮层不会留在屏幕上）', st)
  }
  {
    // 松开时录音硬件还没起来（授权/初始化在途）：浮层要立刻消失，且迟到 onStart 必须被拦住
    const h = makeWx({ startDelay: 200 })
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    v.stop()
    ok(v.getState().connecting === false, 'A4 未开录前松手 → connecting 立即复位（浮层马上消失，不等硬件）')
    await wait(250)
    ok(v.getState().recording === false, 'A4b 迟到的 onStart 被取消刹车拦住（浮层不会复活）', v.getState().recording)
    ok(h.calls.recorderStop === 1, 'A4c 刹车即 stop（不留一个一直在录的会话）', h.calls.recorderStop)
    ok(h.calls.toasts.length === 0, 'A4d 全程无提示', h.calls.toasts)
  }
  {
    // iOS 整段链路（activeMode='recorder'）：旧代码的刹车限定 volc ⇒ 这里会一直录下去
    const h = makeWx({ platform: 'ios', startDelay: 200 })
    store[KEY] = 1   // 直接信任授权，跳过 authorize，专注测刹车
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    v.stop()
    await wait(250)
    ok(v.getState().recording === false, 'A5 iOS 误触同样刹车（不限定 volc）', v.getState().recording)
    ok(h.calls.toasts.length === 0, 'A5b iOS 误触不弹「说话时间太短」', h.calls.toasts)
  }

  // ============================================================
  console.log('[B] 长按正常进入识别')
  // ============================================================
  {
    const h = makeWx()
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    h.wx.__fireOpen()   // WS 握手成功
    await wait(400)     // 长按 400ms（高于 HOLD_MIN_MS）
    const sentBefore = h.calls.sent
    v.stop()
    await wait(40)
    ok(h.calls.sent > sentBefore, 'B1 长按后正常收尾（发送最后一包 → 进入识别）', { before: sentBefore, after: h.calls.sent })
    ok(h.calls.toasts.indexOf('说话时间太短') === -1, 'B2 长按不误报「太短」')
  }

  // ============================================================
  console.log('[C] 授权态持久化')
  // ============================================================
  {
    const h = makeWx({ recordAuth: true })
    global.wx = h.wx
    const v = freshVoice()
    await v.warmup()
    ok(!!store[KEY], 'C1 warmup 确认授权后落盘（下次冷启动可抄近路）', store[KEY])
  }
  {
    const h = makeWx({ recordAuth: false, keepStore: true })   // 刻意保留上一用例的标记
    global.wx = h.wx
    ok(!!store[KEY], 'C2-pre 上一用例的标记确实还在（前置断言，防「本来就没有」的假绿）')
    const v = freshVoice()
    const r = await v.warmup()
    ok(r === false && h.calls.cloud === 0, 'C2-pre2 未授权时 warmup 仍静默跳过', { r, cloud: h.calls.cloud })
    ok(!store[KEY], 'C2 warmup 明确未授权 → 清掉持久化标记（不会下次冷启动误信）', store[KEY])
  }
  {
    const h = makeWx()
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    ok(h.calls.auth === 1, 'C3 无标记时照旧走 wx.authorize（新装用户不跳步）', h.calls.auth)
    ok(!!store[KEY], 'C3b authorize 成功即落盘', store[KEY])
    v.stop()
  }
  {
    const h = makeWx()
    store[KEY] = 1   // 模拟「上次会话已授权」的落盘状态
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    ok(h.calls.auth === 0, 'C4 冷启动有标记 → 跳过 wx.authorize 桥接（省掉这段往返）', h.calls.auth)
    ok(h.calls.recorderStart === 1, 'C4b 直接开录', h.calls.recorderStart)
    v.stop()
  }

  // ============================================================
  console.log('[D] 信任持久化却起不来 → 可操作兜底')
  // ============================================================
  {
    const h = makeWx({ noStart: true })   // 录音始终起不来
    store[KEY] = 1
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    ok(h.calls.auth === 0, 'D1 信任持久化时确实跳过了 authorize', h.calls.auth)
    h.wx.__fireRecErr()
    await wait(20)
    ok(!store[KEY], 'D2 起不来就清掉持久化标记（下次重新走授权链路）', store[KEY])
    ok(h.calls.modals.indexOf('录音没能启动') > -1, 'D3 给出可操作引导（不是干说「重试」）', h.calls.modals)
    ok(h.calls.toasts.indexOf('录音失败，请重试') === -1, 'D4 不谎报方向（不说含糊的「录音失败」）', h.calls.toasts)
    const st = v.getState()
    ok(st.recording === false && st.connecting === false, 'D5 状态下沉到 idle（不留挂着的浮层）', st)
  }

  // ============================================================
  console.log('[E] 静态契约（4 页面 + voice.js）')
  // ============================================================
  const pages = [
    ['pages/write/write.js', 'write'],
    ['pages/archive/archive.js', 'archive'],
    ['pages/summary/summary.js', 'summary'],
    ['pages/detail/detail.js', 'detail']
  ]
  const views = [
    ['pages/write/write.wxml', 'write'],
    ['pages/archive/archive.wxml', 'archive'],
    ['pages/summary/summary.wxml', 'summary'],
    ['pages/detail/detail.wxml', 'detail']
  ]
  let pagesChecked = 0
  for (let i = 0; i < pages.length; i++) {
    const s = fs.readFileSync(path.join(ROOT, pages[i][0]), 'utf8')
    ok(s.indexOf('voice.start({ contextText:') > -1, 'E1 ' + pages[i][1] + ' 仍以草稿上下文调用 voice.start')
    ok(s.indexOf('_holdTimer = setTimeout') === -1, 'E2 ' + pages[i][1] + ' 已移除 300ms 防误触计时器')
    ok(s.indexOf('voice.stop()') > -1, 'E3 ' + pages[i][1] + ' onHoldEnd 仍调用 voice.stop()（未误改）')
    pagesChecked++
  }
  ok(pagesChecked === 4, 'E0 四个页面都被读到（前置断言，防路径写错导致空转）', pagesChecked)

  const MODAL = 'class="voice-modal" wx:if="{{recording || transcribing || connecting}}"'
  // [voice-ready-guard v1] 浮层文案（标题/正文/按钮说明）一律只认 connectingSlow（慢链路信号），
  // 不再直接吃 connecting —— 否则开麦那 100~300ms 内文案会「准备中 → 正在聆听」闪一下。
  const TITLE = "connectingSlow ? '准备中' : '正在聆听'"
  const BODY = "connectingSlow ? '请稍候…' : (recording || connecting ? '请说话…' : '识别中…')"
  const BTN = "connectingSlow ? '连接中…' : '按住 说话'"
  // 反向断言（精确到完整三元串，防回退）
  const TITLE_OLD = "connecting ? '准备中' : '正在聆听'"
  const BODY_OLD = "{{liveText || (recording ? '请说话…' : (connecting ? '请稍候…' : '识别中…'))}}"
  const BTN_OLD = "(connecting ? '连接中…' : '按住 说话')"
  for (let i = 0; i < views.length; i++) {
    const w = fs.readFileSync(path.join(ROOT, views[i][0]), 'utf8')
    ok(w.indexOf('class="voice-modal"') > -1, 'E4 ' + views[i][1] + ' 前置：浮层节点存在')
    ok(w.indexOf(MODAL) > -1, 'E5 ' + views[i][1] + ' 浮层条件纳入 connecting（按下即弹）')
    ok(w.indexOf(TITLE) > -1, 'E6 ' + views[i][1] + ' 标题只认 connectingSlow（快链路不显示「准备中」）')
    ok(w.indexOf(BODY) > -1, 'E7 ' + views[i][1] + ' 正文只认 connectingSlow（快链路 connecting 与录音同文案）')
    ok(w.indexOf(BTN) > -1, 'E8a ' + views[i][1] + ' 按钮说明只认 connectingSlow')
    ok(w.indexOf(TITLE_OLD) === -1, 'E8b ' + views[i][1] + ' 反向：标题不得再直接吃 connecting')
    ok(w.indexOf(BODY_OLD) === -1, 'E8c ' + views[i][1] + ' 反向：正文不得再直接吃 connecting')
    ok(w.indexOf(BTN_OLD) === -1, 'E8d ' + views[i][1] + ' 反向：按钮说明不得再直接吃 connecting')
  }

  // 卡片骨架固定（write/archive/detail 三页同款结构；summary 卡片结构不同，不在此列）
  const CARD_NEW = "class=\"voice-card {{(connectingSlow || transcribing) ? 'voice-card-processing' : ''}}\""
  const WAVES_IDLE = "class=\"voice-waves {{recording ? '' : 'voice-waves-idle'}}\""
  const WAVES_OLD = "class=\"voice-waves\" wx:if=\"{{recording}}\""
  for (let i = 0; i < views.length; i++) {
    const isCard = views[i][1] === 'write' || views[i][1] === 'archive' || views[i][1] === 'detail'
    if (!isCard) continue
    const w = fs.readFileSync(path.join(ROOT, views[i][0]), 'utf8')
    ok(w.indexOf(CARD_NEW) > -1, 'E8e ' + views[i][1] + ' 卡片样式改由 connectingSlow/transcribing 驱动（开录瞬间零样式变化）')
    ok(w.indexOf(WAVES_IDLE) > -1, 'E8f ' + views[i][1] + ' 波形常驻占位（非录音态隐藏）')
    ok(w.indexOf(WAVES_OLD) === -1, 'E8g ' + views[i][1] + ' 反向：波形不得再带 wx:if（否则撑高卡片）')
    const x = fs.readFileSync(path.join(ROOT, views[i][0].replace('.wxml', '.wxss')), 'utf8')
    ok(x.indexOf('.voice-waves-idle {') > -1, 'E8h ' + views[i][1] + ' wxss 有 .voice-waves-idle（visibility: hidden 仍占位）')
    ok(x.indexOf('.voice-waves-idle .voice-wave {') > -1, 'E8i ' + views[i][1] + ' 占位期停掉波形动画（不空转）')
    // [transcribing-tip v1] 识别态「处理中…」提示移除（2026-09-23 真机反馈：叠在底栏按住说话按钮上）
    ok(w.indexOf('voiceCanceling || transcribing') === -1 && w.indexOf('处理中') === -1,
      'E8j ' + views[i][1] + ' 反向：识别态「处理中」提示已移除（信息与卡片标题重复）')
    ok(w.indexOf('wx:if="{{voiceCanceling}}">松开取消发送') > -1,
      'E8k ' + views[i][1] + ' 取消态「松开取消发送」提示保留（防误触价值）')
  }

  const vSrc = fs.readFileSync(path.join(ROOT, 'utils/voice.js'), 'utf8')
  ok(vSrc.indexOf('recorderManager.onStart(() => {') > -1, 'E8 前置：onStart 回调存在')
  ok(vSrc.indexOf('用户在链路启动期间已松手（或判定为误触）') > -1, 'E9 onStart 取消刹车已改为覆盖整段链路')
  ok(vSrc.indexOf("cancelRequested && activeMode === 'volc'") === -1, 'E10 旧的「仅 volc 才刹车」写法已消失')
  ok(vSrc.indexOf('// [hold-fast v1] 误触/已取消：静默丢弃') > -1, 'E11 onStop 整段链路含取消早退')
  ok(vSrc.indexOf('function cancelSession() {') > -1, 'E12 cancelSession 丢弃会话函数存在')
  ok(vSrc.indexOf('function loadPersistedAuth() {') > -1, 'E13 loadPersistedAuth 存在')
  ok(vSrc.indexOf('persistAuth(false)') > -1, 'E14 清标记路径存在（未授权 / 起不来 两处）')
  ok(vSrc.indexOf('const HOLD_MIN_MS = 300') > -1, 'E15 HOLD_MIN_MS 常量显式写死 300')

  // ============================================================
  console.log('[F] 行为护栏（防回退）')
  // ============================================================
  {
    // 误触之后立刻再长按一次：cancelRequested 不得残留
    const h = makeWx()
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    v.stop()          // 误触
    await wait(40)
    v.start()         // 紧接着长按
    await wait(20)
    h.wx.__fireOpen()
    await wait(400)
    const sentBefore = h.calls.sent
    v.stop()
    await wait(40)
    ok(h.calls.sent > sentBefore,
      'F1 误触后的下一次长按仍能正常进入识别（取消标记不残留）', { before: sentBefore, after: h.calls.sent })
  }
  {
    const h = makeWx({ platform: 'ios' })
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(20)
    ok(h.calls.recorderStart === 1 && h.calls.connectSocket === 0,
      'F2 iOS 走整段链路（不建 WS），按下即起录仍然成立', { rec: h.calls.recorderStart, ws: h.calls.connectSocket })
    ok(h.calls.recorderStart === 1 && h.calls.recorderStop === 0, 'F3 长按中不误停', h.calls.recorderStop)
  }

  // ============================================================
  console.log('[G] [voice-ready-guard v1] 「准备中」防闪（慢链路才显示 / 最短停留 / 复位）')
  // ============================================================
  {
    const vSrc2 = fs.readFileSync(path.join(ROOT, 'utils/voice.js'), 'utf8')
    const vm = freshVoice()
    ok(vm.CONNECT_SLOW_MS === 300, 'G1 CONNECT_SLOW_MS 导出且为 300（快链路阈值）', vm.CONNECT_SLOW_MS)
    ok(vm.CONNECT_SLOW_MIN_SHOW_MS === 400, 'G2 CONNECT_SLOW_MIN_SHOW_MS 导出且为 400（最短停留）', vm.CONNECT_SLOW_MIN_SHOW_MS)
    ok(vSrc2.indexOf('const CONNECT_SLOW_MS = 300') > -1, 'G3 常量显式写死（防被随手改成 0）')
    ok(vSrc2.indexOf('function syncConnectingSlow() {') > -1, 'G4 syncConnectingSlow 存在')
    ok(vSrc2.indexOf('function emitState() {\n  syncConnectingSlow()') > -1, 'G5 挂在 emitState 首行（9 处 connecting 赋值一处覆盖）')
    ok(vSrc2.indexOf('state.connectingSlow = connectingSlow') > -1, 'G6 判定结果同步进 state（订阅方能收到）')
    ok(vSrc2.indexOf('recording || transcribing || connectingSlow') === -1, 'G7 反向：浮层弹出条件不得改用 connectingSlow（按下即弹不变）')
    const sW = fs.readFileSync(path.join(ROOT, 'pages/summary/summary.wxml'), 'utf8')
    ok(sW.indexOf("{{connectingSlow ? 'connecting' : ''}}") > -1, 'G8 summary 按钮类名同步走 connectingSlow')
    ok(sW.indexOf("{{connecting ? 'connecting' : ''}}") === -1, 'G9 反向：summary 不得再直接用 connecting 挂类')
  }
  {
    // 快链路（120ms 开麦，真机常见区间）：connectingSlow 必须全程 false ⇒ 用户看不到「准备中」
    const h = makeWx({ startDelay: 120 })
    global.wx = h.wx
    const v = freshVoice()
    let sawSlow = false
    const off = v.onStateChange((s) => { if (s.connectingSlow) sawSlow = true })
    v.start()
    const s0 = v.getState()
    ok(s0.connecting === true && s0.connectingSlow === false,
      'G10 按下瞬间：浮层条件成立（connecting=true）但不显示「准备中」', { connecting: s0.connecting, slow: s0.connectingSlow })
    await wait(60)
    ok(v.getState().connectingSlow === false, 'G11 60ms 时仍不显示「准备中」')
    await wait(220)
    const s1 = v.getState()
    ok(s1.recording === true && s1.connecting === false, 'G12 120ms 开麦 → 进入录音（文案无需切换）', s1)
    ok(sawSlow === false, 'G13 快链路全程未出现过「准备中」← 本次修复的核心', sawSlow)
    off()
  }
  {
    // 慢链路（noStart：开麦迟迟不来）：超过阈值如实显示「准备中」，且最短停留期不被瞬间切走
    const h = makeWx({ noStart: true })
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(200)
    ok(v.getState().connectingSlow === false, 'G14 200ms 时还不够慢：不显示「准备中」')
    await wait(200)   // t≈400ms
    ok(v.getState().connectingSlow === true, 'G15 超过 300ms：如实显示「准备中」（真慢链路有交代）')
    h.manager._startCb()   // 开麦（状态转 recording）
    await wait(30)
    const s2 = v.getState()
    ok(s2.recording === true && s2.connectingSlow === true,
      'G16 开麦瞬间仍在最短停留窗口内保持显示（不「刚显示就被切走」）', { recording: s2.recording, slow: s2.connectingSlow })
    await wait(500)
    ok(v.getState().connectingSlow === false, 'G17 最短停留结束后收起「准备中」')
    v.stop()
    await wait(60)
  }
  {
    // 连续两次按下：上一轮的慢链路标记不得被本轮继承（否则新会话一上来就显示「准备中」）
    const h = makeWx({ noStart: true })
    global.wx = h.wx
    const v = freshVoice()
    v.start()
    await wait(400)
    ok(v.getState().connectingSlow === true, 'G18 第一轮慢链路已显示「准备中」（前置）')
    v.stop()
    await wait(20)
    v.start()
    const s3 = v.getState()
    ok(s3.connecting === true && s3.connectingSlow === false,
      'G19 新一轮按下瞬间标记已复位（防陈旧标记残留）', { connecting: s3.connecting, slow: s3.connectingSlow })
    v.stop()
    await wait(80)
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
