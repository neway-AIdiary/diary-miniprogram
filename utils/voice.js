// utils/voice.js
// 全局语音识别模块，供各页面复用（写日记页底部语音按钮、档案页麦克风按钮）。
//
// 双链路设计：
// 1. 实时链路（优先，仅 Android 真机/开发者工具）：
//    火山引擎流式语音识别（豆包大模型，双向流式优化版，二进制分帧协议，见 volcProto.js）：
//    wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
//    录音 pcm 16kHz/16bit/单声道，onFrameRecorded 每帧封装成音频帧实时推送；
//    服务端 result_type=full 持续回传累计全文，每次回传先过 voiceFilter 净化层
//    （删语气词/自言自语），页面同步显示净化后文字；
//    松手发送「最后一包」（负包），等服务端返回最终全文并关闭连接后整体净化交付。
// 2. 回退链路（iOS 端 / websocket 失败 / 云端未配置参数）：
//    录音 → 云存储上传 → speechToText 云函数（火山录音文件极速识别 flash），
//    结果同样先净化再交付。
//
// 注意：净化（删语气词）是第一层处理，AI 优化（写日记页的润色按钮）是第二层，互不替代。

const voiceFilter = require('./voiceFilter.js')
const volcProto = require('./volcProto.js')
const hotwords = require('./hotwords.js')

let recorderManager = null
let stateHandlers = []
let state = {
  recording: false,
  transcribing: false,
  seconds: 0,
  connecting: false,  // 实时链路建立中（授权→取配置→WS建连），按钮显示「连接中」
  // ===== 实时链路 =====
  liveText: '',      // 当前净化后的实时识别文本（用户所见）
  liveRaw: '',       // 原始识别文本（存档/回溯用）
  liveRemoved: 0,    // 本次说话已过滤的语气词/自言自语数量
  liveMode: false    // true=实时链路（边说边出字），false=整段识别中
}
let recordTimer = null
// 当前录音链路：'volc'（火山流式实时识别）| 'recorder'（录音+云函数整段识别）
let activeMode = null
// 授权弹窗期间用户已松手：授权通过后不再开始录音
let cancelRequested = false
let platformCache = null           // getSystemInfoSync 结果缓存（canStream 每按一次都调 sync 接口，属无效开销）
let recordAuthed = false           // 本次会话已授予麦克风权限：跳过重复 authorize 桥接，按下即可直接开录
let pendingFrames = []             // WS 握手期间录音已产生的音频帧，建连成功后按序补发（不丢开头）
// 当前录音的即时上下文：按住的页面把 textarea 草稿内容传进来，作为最高优先级热词来源。
// 典型场景：用户在草稿里已经写下"王威"，念"把王威改成王伟"时防止"王威"被听错。
let currentContextText = ''

// ===== 火山流式实时识别链路状态 =====
let asrConfigCache = null        // { apiKey | appId+accessToken, resourceId, fetchedAt }，缓存 24h
let asrConfigPromise = null      // 取配置请求在途去重：预热与首次按下并发时不重复调云函数
let socketTask = null
let socketOpen = false
let socketConnectTimer = null    // WSS 建连超时兜底：2.5s 未连上自动关连接回退整段识别
let wsFailed = false             // websocket 出错标记
let fullText = ''                // 服务端累计识别全文（result_type=full，原始文本）
let audioSeq = 1                 // 消息序号：首帧参数帧=1，音频帧从 2 递增（服务端按条数自动计数）
let finishSent = false           // 已发送最后一包（负包）
let finishWaitTimer = null       // 服务端 4s 未关闭连接的兜底定时器
let streamFinalized = false      // 本次流式会话是否已收尾（防重入）

// 开始一次录音会话：置状态并启动秒数计时器
function beginSession() {
  state.connecting = false
  state.recording = true
  state.seconds = 0
  if (recordTimer) clearInterval(recordTimer)
  recordTimer = setInterval(() => {
    state.seconds += 1
    emitState()
  }, 1000)
}

// 向所有订阅页面广播当前状态
function emitState() {
  const snapshot = Object.assign({}, state)
  for (let i = 0; i < stateHandlers.length; i++) {
    try {
      stateHandlers[i](snapshot)
    } catch (e) {}
  }
}

// 是否支持流式实时识别：仅 Android 真机与开发者工具（录音可输出 pcm 帧）
function canStream() {
  if (platformCache) return platformCache === 'android' || platformCache === 'devtools'
  try {
    platformCache = wx.getSystemInfoSync().platform
  } catch (e) {
    platformCache = ''
  }
  return platformCache === 'android' || platformCache === 'devtools'
}

// 从云函数获取火山鉴权参数（缓存 24h；密钥不进代码包）。
// 幂等：命中缓存立即返回；请求在途则复用同一 Promise，预热与按下并发时不会重复调云函数。
function getAsrConfig() {
  const cached = asrConfigCache
  if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) {
    return Promise.resolve(cached)
  }
  if (!asrConfigPromise) {
    asrConfigPromise = wx.cloud.callFunction({ name: 'getAsrConfig' }).then((res) => {
      const r = res.result || {}
      if (r.error) throw new Error(r.error)
      asrConfigCache = {
        apiKey: r.apiKey || '',
        appId: r.appId || '',
        accessToken: r.accessToken || '',
        resourceId: r.resourceId || 'volc.bigasr.sauc.duration',
        fetchedAt: Date.now()
      }
      return asrConfigCache
    }).then(
      (v) => { asrConfigPromise = null; return v },
      (e) => { asrConfigPromise = null; throw e }
    )
  }
  return asrConfigPromise
}

// 预热：页面可见时提前拉取实时识别鉴权参数（仅已授权 + Android/devtools），
// 让首次「按住说话」跳过云函数网络等待，直接建 WebSocket 开始录音。
// 未授权时不主动弹授权框（避免打扰），等首次按下再走完整链路。
function warmup() {
  if (!canStream()) return Promise.resolve(false)
  if (asrConfigCache) return Promise.resolve(true)
  return new Promise((resolve) => {
    try {
      wx.getSetting({
        success: (s) => {
          const rec = s && s.authSetting && s.authSetting['scope.record']
          if (rec === true) {
            recordAuthed = true
            // 提前创建录音管理器并注册回调：首次按下省掉一次管理器初始化
            try { initRecorder() } catch (e) {}
            getAsrConfig().then(() => resolve(true), () => resolve(false))
          } else {
            resolve(false)
          }
        },
        fail: () => resolve(false)
      })
    } catch (e) {
      resolve(false)
    }
  })
}

// ===== 实时链路：建连 =====
// 只负责建 WS（录音已在 start() 里并行启动，见下）；onOpen 后补发握手期间缓存的音频帧
function openAsrSocket(cfg) {
  if (cancelRequested) return
  activeMode = 'volc'
  openSocket(cfg)
}

function openSocket(cfg) {
  // 热词直传（按自然日缓存，构建为本地存储读取，毫秒级）：
  // 在 connectSocket 前构建，耗时落在建连等待期，不占录音关键路径。
  // 包含三段来源（高→低优先级）：
  //   ① 当前编辑框草稿里的词（currentContextText，按页面 onHoldStart 透传）
  //   ② 档案名词（按天缓存）
  //   ③ 近十天日记高频词（按天缓存）
  let hotwordList = []
  try {
    hotwordList = hotwords.get(false, { contextText: currentContextText })
    if (hotwordList.length) {
      const c = hotwords.getLastCount()
      console.log('[voice] 热词已注入:', hotwordList.length, '个（档案', c.archive, '+ 日记高频', c.keyword, '+ 草稿', '）')
    }
  } catch (e) { /* 热词构建失败不影响录音 */ }

  // 火山 v3 鉴权放在 WebSocket 握手 HTTP header（云函数下发，不进代码包）
  const headers = {}
  if (cfg.apiKey) {
    // 新版控制台：单 X-Api-Key
    headers['X-Api-Key'] = cfg.apiKey
  } else {
    // 旧版控制台：AppID + Access Token
    headers['X-Api-App-Key'] = String(cfg.appId)
    headers['X-Api-Access-Key'] = cfg.accessToken
  }
  headers['X-Api-Resource-Id'] = cfg.resourceId
  headers['X-Api-Connect-Id'] = 'cid' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)

  let task
  try {
    task = wx.connectSocket({
      url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      header: headers,
      fail: () => {
        if (socketConnectTimer) { clearTimeout(socketConnectTimer); socketConnectTimer = null }
        wsFailed = true
      }
    })
  } catch (e) {
    wsFailed = true
    return
  }
  socketTask = task

  // 建连超时保护：2.5s 仍未 open 即放弃流式（录音不受影响，继续录；松手后走整段识别）。
  // 连接成功/出错/关闭时都会清除本定时器
  if (socketConnectTimer) clearTimeout(socketConnectTimer)
  socketConnectTimer = setTimeout(() => {
    socketConnectTimer = null
    if (socketOpen || wsFailed) return
    console.warn('[voice] WSS 建连超时(2.5s)，关闭连接，本段将走整段识别')
    wsFailed = true
    try { if (task) task.close({}) } catch (e) {}
  }, 2500)

  task.onOpen(() => {
    if (socketConnectTimer) { clearTimeout(socketConnectTimer); socketConnectTimer = null }
    if (wsFailed) {
      // 超时已触发才 open：放弃流式
      try { task.close({}) } catch (e) {}
      return
    }
    if (cancelRequested) {
      // 建连耗时期间用户已松手：放弃本次会话
      try { task.close({}) } catch (e) {}
      socketTask = null
      activeMode = null
      state.connecting = false
      emitState()
      return
    }
    socketOpen = true
    // 首帧：full client request（JSON 参数）
    // - enable_punc 开启标点：净化层依赖标点分句
    // - result_type=full：服务端每次回传累计全文，丢包不丢内容，净化层整体重跑即可
    // - enable_ddc 服务端语义顺滑关闭：语气词过滤由本地净化层负责，保证用户实时可见、可控
    const reqParams = {
      model_name: 'bigmodel',
      enable_punc: true,
      enable_itn: true,
      enable_ddc: false,
      result_type: 'full'
    }
    // 热词直传：发音相近的词优先识别为热词（人名/机构名/常说词汇），从源头减少错字。
    // 格式按火山文档：request.corpus.context = JSON 字符串 {"hotwords":[{"word":"..."}]}
    if (hotwordList && hotwordList.length) {
      reqParams.corpus = {
        context: JSON.stringify({ hotwords: hotwordList.map(w => ({ word: w })) })
      }
    }
    sendBuffer(volcProto.buildRequestFrame({
      user: { uid: 'diary_miniprogram', platform: 'weapp' },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      request: reqParams
    }))
    audioSeq = 1 // 首帧已占用序号 1，音频帧从 2 起
    // 补发「按→连接就绪」期间录音已产出的帧，避免开头丢字
    if (pendingFrames.length) {
      for (let i = 0; i < pendingFrames.length; i++) {
        audioSeq += 1
        sendBuffer(volcProto.buildAudioFrame(pendingFrames[i], audioSeq))
      }
      pendingFrames = []
    }
  })

  task.onMessage((res) => { handleWsMessage(res.data) })

  task.onError((err) => {
    if (socketConnectTimer) { clearTimeout(socketConnectTimer); socketConnectTimer = null }
    console.warn('[voice] 流式连接失败（常见原因：合法域名未配置 / 火山服务未开通 45000030）:', err && err.errMsg)
    wsFailed = true
    socketOpen = false
    socketTask = null
    // 录音已在进行（或用户已松手）：不打断，onStop 统一走整段识别收尾
    if (state.recording || cancelRequested) return
    if (finishSent || streamFinalized) finalizeStream()
  })

  task.onClose(() => {
    if (socketConnectTimer) { clearTimeout(socketConnectTimer); socketConnectTimer = null }
    socketOpen = false
    if (activeMode !== 'volc') return
    if (state.recording) {
      // 录音中连接断开：录音继续，松手后整段识别
      wsFailed = true
      return
    }
    socketTask = null
    if (cancelRequested && !fullText) {
      // 已取消且无识别内容：仅清理，不交付不提示
      activeMode = null
      state.connecting = false
      emitState()
      return
    }
    if (finishSent || streamFinalized) {
      // 正常链路：负包后服务端发完最终结果并关闭连接 → 收尾交付
      finalizeStream()
    }
    // 建连阶段断开且未开始录音：录音仍由 start() 的并行启动兜底，松手 onStop 处理
  })
}

function sendBuffer(buf) {
  if (!socketOpen || !socketTask) return
  try {
    socketTask.send({ data: buf, fail: () => {} })
  } catch (e) {}
}

// ===== 实时链路：结果处理 =====
function handleWsMessage(data) {
  const frame = volcProto.parseServerFrame(data)
  if (!frame) return

  if (frame.type === 'result') {
    // 累计全文实时回传：整体过净化层后展示
    if (frame.text) {
      fullText = frame.text
      updateLive()
    }
  } else if (frame.type === 'error') {
    // 服务端错误帧（如 45000081 等包超时、55000031 服务器繁忙）
    console.warn('[voice] 火山服务端错误帧 code=' + frame.code + ':', frame.message)
    wsFailed = true
    // 录音不打断：本段继续录完，松手 onStop 统一用完整文件走整段识别
    if (!state.recording && !streamFinalized) finalizeStream()
  }
}

// 实时展示 = 当前累计全文，整体过一遍净化层
function updateLive() {
  const r = voiceFilter.purify(fullText)
  state.liveRaw = fullText
  state.liveText = r.text
  state.liveRemoved = r.count
  emitState()
}

// 松手/录音结束：发送「最后一包」（负包），等服务端返回最终全文并关闭连接
function finishStream() {
  if (finishSent) return
  finishSent = true
  sendBuffer(volcProto.buildLastFrame())
  // 兜底：服务端 4s 未关闭连接则强制收尾，避免结果丢失
  finishWaitTimer = setTimeout(() => {
    if (!state.recording) finalizeStream()
  }, 4000)
}

// 流式会话收尾：最终全文 → 净化 → 交付（或提示没听清）
function finalizeStream() {
  if (streamFinalized) return
  streamFinalized = true
  state.connecting = false
  if (finishWaitTimer) { clearTimeout(finishWaitTimer); finishWaitTimer = null }
  if (socketTask) {
    try { socketTask.close({ code: 1000 }) } catch (e) {}
    socketTask = null
  }
  socketOpen = false

  state.liveRaw = fullText
  const r = voiceFilter.purify(fullText)
  if (r.text) {
    deliver(r.text, r.count)
  } else if (!cancelRequested) {
    // 仅在正常会话（非用户提前松手取消）时提示没听清
    wx.showToast({ title: '没听清，再试一次', icon: 'none' })
  }
}

// ===== 回退链路：录音 → 上传 → speechToText 云函数（火山录音文件极速识别）=====
// 回退录音由 start() 直接启动（iOS 走 wav；流式失败时沿用已开始的 pcm 录音，见 onStop→fallbackToBatch）
function initRecorder() {
  if (recorderManager) return
  recorderManager = wx.getRecorderManager()

  recorderManager.onStart(() => {
    if (cancelRequested && activeMode === 'volc') {
      // 用户在链路启动期间已松手，录音此刻才真正开始：立即停止（onStop 走正常收尾）
      try { recorderManager.stop() } catch (e) {}
      return
    }
    beginSession()
    state.liveMode = (activeMode === 'volc')
    emitState()
  })

  // 每帧 PCM 数据回调（仅 Android/devtools 且设置 frameSize 时触发）
  recorderManager.onFrameRecorded((res) => {
    if (activeMode !== 'volc') return
    const frame = res.frameBuffer
    if (!frame) return
    if (socketOpen && socketTask && !wsFailed) {
      audioSeq += 1
      sendBuffer(volcProto.buildAudioFrame(frame, audioSeq))
    } else if (!wsFailed && socketTask && pendingFrames.length < 120) {
      // WS 尚在握手：先缓存（约 120 帧≈19s 上限，握手 2.5s 超时远用不完），open 后补发
      pendingFrames.push(frame)
    }
  })

  recorderManager.onStop((res) => {
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
    const duration = state.seconds
    state.recording = false
    state.connecting = false
    state.seconds = 0
    emitState()

    if (activeMode === 'volc') {
      if (cancelRequested) {
        // 录音启动前已取消（如链路启动期间快速松手）：整段丢弃，不识别不提示
        if (socketTask) { try { socketTask.close({}) } catch (e) {} socketTask = null }
        socketOpen = false
        activeMode = null
        pendingFrames = []
        return
      }
      if (wsFailed || !socketOpen) {
        // websocket 异常/未连上：用刚录好的 pcm 文件走整段识别回退
        fallbackToBatch(res.tempFilePath)
      } else {
        // 正常：发最后一包（负包）等待最终结果
        finishStream()
      }
      return
    }

    // 整段链路
    if (duration < 1) {
      wx.showToast({ title: '说话时间太短', icon: 'none' })
      return
    }
    transcribe(res.tempFilePath, 'wav')
  })

  recorderManager.onError(() => {
    if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
    state = { recording: false, transcribing: false, seconds: 0, connecting: false, liveText: '', liveRaw: '', liveRemoved: 0, liveMode: false }
    emitState()
    if (activeMode === 'volc' && !streamFinalized) {
      // 流式录音失败：直接收尾
      finalizeStream()
      return
    }
    wx.showToast({ title: '录音失败，请重试', icon: 'none' })
  })
}

// 流式链路失败 → 用已录好的 pcm 文件整段识别
function fallbackToBatch(filePath) {
  activeMode = 'recorder'
  if (!filePath) {
    wx.showToast({ title: '语音识别失败，请重试', icon: 'none' })
    return
  }
  transcribe(filePath, 'pcm')
}

// 上传录音并调用 speechToText 云函数识别，结果先净化再交给页面
async function transcribe(filePath, format) {
  state.transcribing = true
  emitState()
  try {
    const cloudPath = `voice/${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${format === 'pcm' ? 'pcm' : 'wav'}`
    const uploadRes = await wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: filePath
    })

    const res = await wx.cloud.callFunction({
      name: 'speechToText',
      data: {
        fileID: uploadRes.fileID,
        format: format || 'wav',
        // 热词随请求上传：与流式链路同源（草稿上下文 + 档案名词优先 + 近十天高频词，token 预算 100），
        // build 内部按自然日缓存基础词，草稿上下文每次按 currentContextText 重算，本地毫秒级返回
        hotwords: (() => {
          try {
            const hw = hotwords.build({ contextText: currentContextText })
            return (hw && hw.words) || []
          } catch (e) {
            return []
          }
        })()
      }
    })

    const result = res.result || {}
    if (result.error) {
      console.warn('[voice] speechToText 返回错误:', result.error)
      wx.showToast({ title: result.error, icon: 'none', duration: 3000 })
    } else if (result.text) {
      // 回退链路同样先净化（第一层处理），再交给页面
      const r = voiceFilter.purify(result.text.trim())
      deliver(r.text, r.count)
    } else {
      wx.showToast({ title: '没听清，再试一次', icon: 'none' })
    }
  } catch (err) {
    console.warn('[voice] 识别链路异常:', err)
    const msg = String((err && (err.errMsg || err.message)) || '')
    let tip = '语音识别失败'
    if (msg.indexOf('Cannot find module') >= 0 || msg.indexOf('wx-server-sdk') >= 0) {
      // 云函数上传时没带依赖：必须用「上传并部署：云端安装依赖」重新部署
      tip = '云函数缺依赖：请右键speechToText选「上传并部署：云端安装依赖」'
    } else if (msg.indexOf('cloud.callFunction:fail') >= 0 && (msg.indexOf('not found') >= 0 || msg.indexOf('FUNCTIONS_NOT_FOUND') >= 0 || msg.indexOf('-404011') >= 0)) {
      tip = '云函数未部署：请上传部署 speechToText'
    } else if (msg.indexOf('cloud.callFunction:fail') >= 0) {
      tip = '云函数调用失败，详情见控制台日志'
    } else if (msg) {
      tip = '语音识别失败：' + msg.slice(0, 40)
    }
    wx.showToast({ title: tip, icon: 'none', duration: 3500 })
  } finally {
    state.transcribing = false
    emitState()
  }
}

// 把识别结果交给当前页面注册的语音目标；
// 没有目标页面时（如日记本/我的页），暂存草稿并跳转到写日记页
function deliver(text, removedCount) {
  const app = getApp()
  const target = app.globalData.voiceTarget
  const payload = { text: text, removed: removedCount || 0, raw: state.liveRaw || text }
  if (target && typeof target.handle === 'function') {
    target.handle(payload.text, payload)
    return
  }
  app.globalData.voiceDraft = (app.globalData.voiceDraft || '') + (app.globalData.voiceDraft ? ' ' : '') + text
  wx.showToast({ title: '已带入写日记页', icon: 'none' })
  setTimeout(() => { wx.reLaunch({ url: '/pages/write/write' }) }, 600)
}

// 开始录音（带麦克风授权）：Android/devtools 走火山流式实时识别，其余走整段识别。
// 提速设计（按→开始录音只差一次 recorderManager.start）：
// ①录音不再等 WS 建连：授权一通过立即 recorderManager.start，用户马上可说话；
//   WS 建连并行进行，握手期间音频帧先入 pendingFrames，连上后按序补发（不丢开头）；
// ②授权标记缓存（recordAuthed）：已授权过的会话跳过 authorize 桥接调用，直接开录；
// ③鉴权参数与录音并行拉取（缓存/在途请求复用），不阻塞开录；
// ④WS 失败/超时不再重启录音：录音一直进行，松手后用完整 pcm 文件走整段识别；
// ⑤按下即广播「连接中」准备态，用户有即时反馈。
//
// opts.contextText（可选）：按住时编辑框里的草稿文本（textarea 内容）。
//   用于把草稿里的词放进"已下发热词"，避免语音指令中相同词被错听。
//   例：先写"王威"，再口述"把王威改成王伟"——把"王威"作为热词传入火山 ASR。
function start(opts) {
  if (state.recording || state.transcribing) return
  // 记录本次录音的草稿上下文：每次录音都重置（上一段录音的草稿不污染本次）
  currentContextText = String((opts && opts.contextText) || '')
  cancelRequested = false
  // 新一轮录音：清空上次的实时识别文本，浮层从空白开始
  state.liveText = ''
  state.liveRaw = ''
  state.liveRemoved = 0
  state.connecting = true
  emitState()

  const stream = canStream()
  activeMode = stream ? 'volc' : 'recorder'
  if (stream) {
    // 复位本次流式会话
    wsFailed = false
    fullText = ''
    audioSeq = 1
    finishSent = false
    streamFinalized = false
    pendingFrames = []
    if (finishWaitTimer) { clearTimeout(finishWaitTimer); finishWaitTimer = null }
    // 鉴权参数拉取 + WS 建连，与录音启动并行（握手期间用户已经在说话）
    getAsrConfig().then((cfg) => {
      if (cancelRequested || wsFailed) return
      openAsrSocket(cfg)
    }).catch(() => {
      // 云端未配置/取配置失败：录音继续，松手后整段识别
      wsFailed = true
    })
  }

  const beginRecording = () => {
    if (cancelRequested) {
      // 授权期间已松手：不启动录音，清理会话
      if (socketTask) { try { socketTask.close({}) } catch (e) {} socketTask = null }
      socketOpen = false
      activeMode = null
      state.connecting = false
      emitState()
      return
    }
    initRecorder()
    if (stream) {
      // 火山流式要求 pcm；frameSize 触发 onFrameRecorded（握手期间帧先进缓存）
      recorderManager.start({
        duration: 60000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'pcm',
        frameSize: 5   // 5KB ≈ 160ms @ 16kHz/16bit/单声道，落在火山建议的 100~200ms 分包区间
      })
    } else {
      // iOS 等回退链路：整段录音，松手后 wav 上传识别
      recorderManager.start({
        duration: 60000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'wav'
      })
    }
  }

  if (recordAuthed) {
    // 已授权过：跳过 authorize 桥接，直接开录（最快路径）
    beginRecording()
  } else {
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        recordAuthed = true
        beginRecording()
      },
      fail: () => {
        cancelRequested = false
        state.connecting = false
        socketOpen = false
        if (socketTask) { try { socketTask.close({}) } catch (e) {} socketTask = null }
        activeMode = null
        emitState()
        wx.showModal({
          title: '需要麦克风权限',
          content: '语音输入需要使用麦克风录音，请在设置中开启权限',
          confirmText: '去设置',
          success: (r) => { if (r.confirm) wx.openSetting() }
        })
      }
    })
  }
}

function stop() {
  if (state.recording) {
    if (recorderManager) recorderManager.stop()
  } else {
    // 录音还没开始（授权中）就被松手：标记取消
    cancelRequested = true
  }
}

// 订阅录音状态；返回取消订阅函数
function onStateChange(handler) {
  stateHandlers.push(handler)
  handler(Object.assign({}, state))
  return () => {
    const i = stateHandlers.indexOf(handler)
    if (i > -1) stateHandlers.splice(i, 1)
  }
}

function getState() {
  return Object.assign({}, state)
}

module.exports = { start, stop, onStateChange, getState, warmup }
