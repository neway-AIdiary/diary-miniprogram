# -*- coding: utf-8 -*-
r"""
patch_hold_fast.py — [hold-fast v1] 按住说话提速三件套（用户 2026-09-22 拍板 1 + 2 + 3）

背景（冷启动「按住说话」弹出偏慢的逐段实测）：
  ① onHoldStart 的 **300ms 防误触 setTimeout** —— 纯等待；
  ② 冷启动 recordAuthed 尚未就绪 ⇒ 走 wx.authorize 桥接往返（权限其实早给了）；
  ③ 录音器启动 100~300ms（不可消除，已与建连并行）；
  ④ voiceSheetIn 上滑动画 250ms；
  ⑤ **浮层的 wx:if 只认 recording || transcribing，connecting 被排除** ——
     于是浮层出现被绑在「录音硬件启动完成」上，而不是「按下」。

本补丁只做用户拍板的 1 + 2 + 3（4 与 6 未获批，不动）：

  **① 浮层纳入 connecting 态**
     pages/{write,archive,summary,detail}.wxml 的 .voice-modal 条件加 `|| connecting`；
     卡片标题/正文改三态文案（connecting →「准备中」/「请稍候…」）。
     ⇒ 浮层在 voice.start() 那一帧即出现（同步 emitState），观感「按下即弹」。

  **② 按下即起录 + 误触后判（replace 300ms 防误触）**
     四个页面的 onHoldStart 不再 setTimeout(300)，按下直接 voice.start()；
     「点按 vs 长按」的判定移进 utils/voice.js#stop()：按压时长 < HOLD_MIN_MS 即整段静默丢弃。
     HOLD_MIN_MS 取 **300（与旧防误触阈值同值）** ⇒ 「多短算点按」的语义逐字不变（零行为回退），
     但录音从按下那一刻开始 ⇒ **开头约 300ms 音频不再被切掉，首字更不易丢**（识别率不降反升）。

  **③ 授权态持久化**
     voice_rec_authed_v1 落盘；冷启动首次按下 loadPersistedAuth() 抄近路，跳过 wx.authorize 往返。
     安全性：warmup 的 getSetting 若说未授权则立刻清标记；真被系统撤销时由
     recorderManager.onError 兜底（清标记 + 给出可操作的权限引导，不干说「重试」）。

新增/加固的失败路径（都是「宁可不用也不留死胡同」）：
  · onStart 的取消刹车**不再限定 volc** —— 否者 iOS 整段链路在误触时会一直录下去；
  · onStop 的整段链路加 cancelRequested 早退 —— 误触/已取消不再弹「说话时间太短」、不再白跑上传。

用法：
  python patch_hold_fast.py --check        # 预检（唯一锚点 + 幂等 sig）
  python patch_hold_fast.py --write        # 落盘（先备份，备份幂等不覆盖）
  python patch_hold_fast.py --restore-src  # 仅还原源码
  python patch_hold_fast.py --restore      # 全部还原
"""
import io
import os
import sys
import shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\hold-fast-backup-20260922'

CRLF = chr(13) + chr(10)
LF = chr(10)

V = 'utils/voice.js'
WJ = 'pages/write/write.js'
WW = 'pages/write/write.wxml'
AJ = 'pages/archive/archive.js'
AW = 'pages/archive/archive.wxml'
SJ = 'pages/summary/summary.js'
SW = 'pages/summary/summary.wxml'
DJ = 'pages/detail/detail.js'
DW = 'pages/detail/detail.wxml'
TV = 'tools/test_voice_start.js'

OPS = []


def op(rel, tag, old, new, sig):
    OPS.append((rel, {'tag': tag, 'old': old, 'new': new, 'sig': sig}))


# ============================================================
# utils/voice.js
# ============================================================

# ---- V1 常量与模块状态 ----
op(V, 'V1 HOLD_MIN_MS + 授权态持久化常量',
   """let asrConfigCache = null        // { apiKey | appId+accessToken, resourceId, fetchedAt }，缓存 24h
let asrConfigPromise = null      // 取配置请求在途去重：预热与首次按下并发时不重复调云函数""",
   """// [hold-fast v1] 按下即起录后的「误触时长下限」：与旧版 300ms 防误触**同值**，
// 保证「多短算点按、多长算长按」的语义逐字不变；不足此值的整段静默丢弃。
const HOLD_MIN_MS = 300
let sessionStartAt = 0           // 本次按下的时刻（stop() 用它和松手时刻求差，判定误触）
const REC_AUTHED_KEY = 'voice_rec_authed_v1'   // 麦克风授权态持久化（跨冷启动，省掉一次 wx.authorize 往返）
let recAuthTrusted = false       // 授权态取自持久化、尚未被本会话的 recorder 证实

let asrConfigCache = null        // { apiKey | appId+accessToken, resourceId, fetchedAt }，缓存 24h
let asrConfigPromise = null      // 取配置请求在途去重：预热与首次按下并发时不重复调云函数""",
   "const HOLD_MIN_MS = 300")

# ---- V2 持久化读写助手 ----
op(V, 'V2 loadPersistedAuth / persistAuth 助手',
   """// 预热：页面可见时提前拉取实时识别鉴权参数（仅已授权 + Android/devtools），""",
   """// [hold-fast v1] 授权态持久化：上次会话已确认授予麦克风时，冷启动首次按住说话
// 不必再走一次 wx.authorize 桥接往返（权限早已授予，那是纯等待）。
// 安全性由两端兜住：① warmup 的 getSetting 若明确未授权 → 立刻清标记；
//                   ② 真被用户在系统设置里撤销 → recorderManager.onError 兜底清理并给可操作引导。
function loadPersistedAuth() {
  if (recordAuthed) return
  try {
    if (wx.getStorageSync(REC_AUTHED_KEY)) {
      recordAuthed = true
      recAuthTrusted = true
    }
  } catch (e) {}
}

function persistAuth(ok) {
  try {
    if (ok) wx.setStorageSync(REC_AUTHED_KEY, 1)
    else wx.removeStorageSync(REC_AUTHED_KEY)
  } catch (e) {}
  if (!ok) recAuthTrusted = false
}

// 预热：页面可见时提前拉取实时识别鉴权参数（仅已授权 + Android/devtools），""",
   'function loadPersistedAuth() {')

# ---- V3a warmup：确认授权后落盘 ----
op(V, 'V3a warmup 确认授权后落盘',
   """          if (rec === true) {
            recordAuthed = true
            // 提前创建录音管理器并注册回调：首次按下省掉一次管理器初始化""",
   """          if (rec === true) {
            recordAuthed = true
            recAuthTrusted = false
            // [hold-fast v1] 确认授权后落盘：下次冷启动首次按下可直接开录，省掉 wx.authorize 往返
            persistAuth(true)
            // 提前创建录音管理器并注册回调：首次按下省掉一次管理器初始化""",
   "// [hold-fast v1] 确认授权后落盘：下次冷启动首次按下可直接开录")

# ---- V3b warmup：明确未授权则清标记 ----
op(V, 'V3b warmup 未授权则清标记',
   """          } else {
            resolve(false)
          }
        },
        fail: () => resolve(false)""",
   """          } else {
            // [hold-fast v1] 系统里已撤销 / 从未授予：清掉持久化标记，避免下次冷启动误信
            persistAuth(false)
            resolve(false)
          }
        },
        fail: () => resolve(false)""",
   "// [hold-fast v1] 系统里已撤销 / 从未授予：清掉持久化标记")

# ---- V4a start：记下按下时刻 ----
op(V, 'V4a start 记录按下时刻',
   """  if (state.recording || state.transcribing) return
  // 记录本次录音的草稿上下文：每次录音都重置（上一段录音的草稿不污染本次）""",
   """  if (state.recording || state.transcribing) return
  // [hold-fast v1] 记下按下时刻：stop() 用它区分「点按（误触）」与「长按（真录）」
  sessionStartAt = Date.now()
  // 记录本次录音的草稿上下文：每次录音都重置（上一段录音的草稿不污染本次）""",
   "// [hold-fast v1] 记下按下时刻：stop() 用它区分")

# ---- V4b start：抄近路读持久化授权态 ----
op(V, 'V4b start 读持久化授权态',
   """  if (recordAuthed) {
    // 已授权过：跳过 authorize 桥接，直接开录（最快路径）""",
   """  // [hold-fast v1] 冷启动第一次按下：先用持久化的授权态抄近路，省掉一次 wx.authorize 桥接往返
  loadPersistedAuth()
  if (recordAuthed) {
    // 已授权过：跳过 authorize 桥接，直接开录（最快路径）""",
   "// [hold-fast v1] 冷启动第一次按下：先用持久化的授权态抄近路")

# ---- V4c authorize 成功 → 落盘 ----
op(V, 'V4c authorize 成功落盘',
   """      success: () => {
        recordAuthed = true
        beginRecording()
      },""",
   """      success: () => {
        recordAuthed = true
        recAuthTrusted = false
        // [hold-fast v1] 落盘：下次冷启动直接信任
        persistAuth(true)
        beginRecording()
      },""",
   "// [hold-fast v1] 落盘：下次冷启动直接信任")

# ---- V4d authorize 失败 → 清标记 ----
op(V, 'V4d authorize 失败清标记',
   """      fail: () => {
        cancelRequested = false""",
   """      fail: () => {
        // [hold-fast v1] 用户拒绝：清掉持久化标记，下次仍走完整授权链路
        persistAuth(false)
        cancelRequested = false""",
   "// [hold-fast v1] 用户拒绝：清掉持久化标记")

# ---- V5 stop 重写（误触判定） + V6 cancelSession ----
op(V, 'V5/V6 stop 误触判定 + cancelSession',
   """function stop() {
  if (state.recording) {
    if (recorderManager) recorderManager.stop()
  } else {
    // 录音还没开始（授权中）就被松手：标记取消
    cancelRequested = true
  }
}""",
   """// [hold-fast v1] 丢弃本次会话（误触）：不识别、不提示、不写正文。
// 已开录 → 交给 onStop 的 cancelRequested 分支静默收尾；
// 尚未开录（鉴权/握手在途）→ 就地复位 connecting，后续 onStart / beginRecording 的
// cancelRequested 分支会继续兜底清理，不会留下「浮层一直挂着」的死胡同。
function cancelSession() {
  cancelRequested = true
  if (state.recording) {
    if (recorderManager) { try { recorderManager.stop() } catch (e) {} }
    return
  }
  if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
  state.connecting = false
  state.recording = false
  state.seconds = 0
  emitState()
}

function stop() {
  // [hold-fast v1] 按下即起录后，「点按」与「长按」的分界在这里判定：
  // 按压时长不足 HOLD_MIN_MS（= 旧版防误触阈值 300ms）视为误触，整段静默丢弃
  // —— 与旧行为（300ms 内松手什么都不发生）语义等价，但浮层已在按下那一刻出现。
  const held = sessionStartAt ? Date.now() - sessionStartAt : HOLD_MIN_MS
  sessionStartAt = 0
  if (held < HOLD_MIN_MS) {
    cancelSession()
    return
  }
  if (state.recording) {
    if (recorderManager) recorderManager.stop()
  } else {
    // 录音还没开始（授权中）就被松手：标记取消
    cancelRequested = true
  }
}""",
   'function cancelSession() {')

# ---- V7 onStart 取消刹车不再限定 volc ----
op(V, 'V7 onStart 取消刹车覆盖整段链路',
   """  recorderManager.onStart(() => {
    if (cancelRequested && activeMode === 'volc') {
      // 用户在链路启动期间已松手，录音此刻才真正开始：立即停止（onStop 走正常收尾）
      try { recorderManager.stop() } catch (e) {}
      return
    }
    beginSession()
    state.liveMode = (activeMode === 'volc')
    emitState()
  })""",
   """  recorderManager.onStart(() => {
    if (cancelRequested) {
      // 用户在链路启动期间已松手（或判定为误触），录音此刻才真正开始：立即停止（onStop 走取消收尾）。
      // [hold-fast v1] 不再限定 volc —— 整段链路（iOS）同样要在这时刹车，否则会一直录下去，
      // 表现为「点一下按钮，浮层反复出现且麦克风不停」。
      try { recorderManager.stop() } catch (e) {}
      return
    }
    beginSession()
    recAuthTrusted = false   // [hold-fast v1] 录音真的起来了 ⇒ 权限已被证实，不再是「信任持久化」状态
    state.liveMode = (activeMode === 'volc')
    emitState()
  })""",
   '// [hold-fast v1] 不再限定 volc —— 整段链路（iOS）同样要在这时刹车')

# ---- V8 onStop 整段链路：已取消则静默丢弃 ----
op(V, 'V8 onStop 整段链路取消早退',
   """    // 整段链路
    if (duration < 1) {""",
   """    // 整段链路
    if (cancelRequested) {
      // [hold-fast v1] 误触/已取消：静默丢弃，既不提示「说话时间太短」，也不白跑一次上传识别
      return
    }
    if (duration < 1) {""",
   '// [hold-fast v1] 误触/已取消：静默丢弃，既不提示')

# ---- V9 onError：信任持久化却起不来 → 可操作引导 ----
op(V, 'V9 onError 持久化信任的失败兜底',
   """    if (activeMode === 'volc' && !streamFinalized) {
      // 流式录音失败：直接收尾
      finalizeStream()
      return
    }
    wx.showToast({ title: '录音失败，请重试', icon: 'none' })
  })""",
   """    // [hold-fast v1] 先处理「信任持久化授权态、却始终没能开录」这一路：
    // recAuthTrusted 为真 ⇒ 本会话从未成功开录 ⇒ 最可能是权限被撤销，或录音被别的应用占用。
    // 清掉标记（下次按下重新走 authorize 链路）并给出可操作引导，而不是干说一句「重试」。
    if (recAuthTrusted) {
      if (activeMode === 'volc' && !streamFinalized) {
        cancelRequested = true   // 抑制 finalizeStream 的「没听清」二次提示
        finalizeStream()
      }
      persistAuth(false)
      wx.showModal({
        title: '录音没能启动',
        content: '可能是麦克风权限已关闭，或录音正被其他应用占用。请检查微信的录音权限后重试。',
        confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.openSetting() }
      })
      return
    }
    if (activeMode === 'volc' && !streamFinalized) {
      // 流式录音失败：直接收尾
      finalizeStream()
      return
    }
    wx.showToast({ title: '录音失败，请重试', icon: 'none' })
  })""",
   'title: \'录音没能启动\',')

# ---- V10 导出 HOLD_MIN_MS ----
op(V, 'V10 导出 HOLD_MIN_MS',
   "module.exports = { start, stop, onStateChange, getState, warmup }",
   "module.exports = { start, stop, onStateChange, getState, warmup, HOLD_MIN_MS }",
   "warmup, HOLD_MIN_MS }")


# ============================================================
# 四个页面：onHoldStart 不再等 300ms（按下即起录）
# ============================================================

op(WJ, 'W1 write 按下即起录',
   """  // 按住开始录音（带300ms防误触）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      // 把当前草稿（textarea 内容）作为"即时上下文"传给语音识别
      // 例如：草稿里已写"王威"，随后口述"把王威改成王伟"——避免"王威"被识别错
      voice.start({ contextText: this.data.content || '' })
    }, 300)
  },""",
   """  // 按住即开始录音
  // [hold-fast v1] 不再等 300ms 防误触：按下立刻起录并出浮层（浮层由 connecting 态驱动）。
  // 「点按 vs 长按」的判定移进 voice.js#stop()（按压不足 HOLD_MIN_MS 的整段静默丢弃），
  // 于是「多短算点按」的语义不变，而开头约 300ms 的音频不再被切掉 ⇒ 首字更不易丢。
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null }
    this._isHolding = true
    // 把当前草稿（textarea 内容）作为"即时上下文"传给语音识别
    // 例如：草稿里已写"王威"，随后口述"把王威改成王伟"——避免"王威"被识别错
    voice.start({ contextText: this.data.content || '' })
  },""",
   '// [hold-fast v1] 不再等 300ms 防误触：按下立刻起录并出浮层')

op(AJ, 'W2 archive 按下即起录',
   """  // 按住开始录音（带300ms防误触；与主页一致：记录起点坐标、复位取消标记）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      // 把当前备注草稿作为"即时上下文"传给语音识别：档案页说话前若已输入了人名/机构名，
      // 这些词会被作为最高优先级热词下发，提升同名实体的识别准确率
      voice.start({ contextText: this.data.quickText || this.data.content || '' })
    }, 300)
  },""",
   """  // 按住即开始录音（[hold-fast v1] 与主页一致：按下不再等 300ms，误触判定移到 voice.js#stop()）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null }
    this._isHolding = true
    // 把当前备注草稿作为"即时上下文"传给语音识别：档案页说话前若已输入了人名/机构名，
    // 这些词会被作为最高优先级热词下发，提升同名实体的识别准确率
    voice.start({ contextText: this.data.quickText || this.data.content || '' })
  },""",
   '与主页一致：按下不再等 300ms')

op(DJ, 'W3 detail 按下即起录',
   """  // 按住开始录音（带 300ms 防误触）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      // 把当前草稿（编辑框内容）作为"即时上下文"传给语音识别，
      // 与历史日记、档案名词一起作为热词下发给火山引擎（解决「王威→王伟」类修改指令识别）
      voice.start({ contextText: this.data.content || '' })
    }, 300)
  },""",
   """  // 按住即开始录音（[hold-fast v1] 按下不再等 300ms，误触判定移到 voice.js#stop()）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null }
    this._isHolding = true
    // 把当前草稿（编辑框内容）作为"即时上下文"传给语音识别，
    // 与历史日记、档案名词一起作为热词下发给火山引擎（解决「王威→王伟」类修改指令识别）
    voice.start({ contextText: this.data.content || '' })
  },""",
   '按下不再等 300ms，误触判定移到 voice.js#stop()')

op(SJ, 'W4 summary 按下即起录',
   """  onHoldStart() {
    this._suppressEnd = false
    this._isHolding = false
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      voice.start({ contextText: this.data.prompt || '' })
    }, 300)
  },""",
   """  onHoldStart() {
    this._suppressEnd = false
    // [hold-fast v1] 按下即起录：不再等 300ms，误触判定移到 voice.js#stop()
    this._isHolding = true
    voice.start({ contextText: this.data.prompt || '' })
  },""",
   '// [hold-fast v1] 按下即起录：不再等 300ms')


# ============================================================
# 四个页面 wxml：浮层纳入 connecting + 三态文案
# ============================================================

_MODAL_OLD = '<view class="voice-modal" wx:if="{{recording || transcribing}}">'
_MODAL_NEW = '<view class="voice-modal" wx:if="{{recording || transcribing || connecting}}">'
_SIG_MODAL = 'wx:if="{{recording || transcribing || connecting}}"'

_TITLE_OLD = "{{transcribing ? '语音识别中' : '正在聆听'}}"
_TITLE_NEW = "{{transcribing ? '语音识别中' : (connecting ? '准备中' : '正在聆听')}}"
_SIG_TITLE = "connecting ? '准备中' : '正在聆听'"

_BODY_OLD = "{{liveText || (recording ? '请说话…' : '识别中…')}}"
_BODY_NEW = "{{liveText || (recording ? '请说话…' : (connecting ? '请稍候…' : '识别中…'))}}"
_SIG_BODY = "connecting ? '请稍候…' : '识别中…'"

for _rel, _name in ((WW, 'write'), (AW, 'archive'), (SW, 'summary'), (DW, 'detail')):
    op(_rel, '%s wxml 浮层纳入 connecting' % _name, _MODAL_OLD, _MODAL_NEW, _SIG_MODAL)
    op(_rel, '%s wxml 标题三态' % _name, _TITLE_OLD, _TITLE_NEW, _SIG_TITLE)
    op(_rel, '%s wxml 正文三态' % _name, _BODY_OLD, _BODY_NEW, _SIG_BODY)


# ============================================================
# tools/test_voice_start.js：用例间隔离存储（授权态现在会持久化）
# ============================================================

op(TV, 'T1 新增 clearStore 助手',
   """// 本机 storage 桩（[person-hotword v1] 起热词链路会读人名表/日记分片）
const store = {}""",
   """// 本机 storage 桩（[person-hotword v1] 起热词链路会读人名表/日记分片）
const store = {}

// [hold-fast v1] 授权态自本次起是**持久化**的（voice_rec_authed_v1）：
// 用例之间必须清空存储，否则上一个用例写下的「已授权」会泄漏到下一个用例
// （症状：recordAuth:false 的用例反而命中已授权快路径，断言全线漂移）。
function clearStore() {
  Object.keys(store).forEach((k) => { delete store[k] })
}""",
   'function clearStore() {')

op(TV, 'T2 makeWx 每例清空存储',
   """function makeWx(opts) {
  opts = opts || {}""",
   """function makeWx(opts) {
  opts = opts || {}
  clearStore()   // [hold-fast v1] 每个用例自带干净存储（授权态持久化后必须隔离）""",
   'clearStore()   // [hold-fast v1] 每个用例自带干净存储')


# ============================================================
# 框架
# ============================================================


def load(rel):
    p = os.path.join(ROOT, rel)
    with io.open(p, 'rb') as f:
        raw = f.read().decode('utf-8')
    crlf = CRLF in raw
    text = raw.replace(CRLF, LF)
    return raw, text, crlf


def save(rel, text, crlf):
    p = os.path.join(ROOT, rel)
    out = text.replace(LF, CRLF) if crlf else text
    with io.open(p, 'wb') as f:
        f.write(out.encode('utf-8'))


def do_backup(rel):
    src = os.path.join(ROOT, rel)
    dst = os.path.join(BACKUP, rel.replace('/', os.sep))
    d = os.path.dirname(dst)
    if not os.path.isdir(d):
        os.makedirs(d)
    # [幂等备份] 已存在就不覆盖：多次 --write 必须保留**最早**（补丁前）的版本，
    # 否则 --restore 会还原成「中间态」，红灯自检会跑一个新旧混血体（9-22 实锤）。
    if os.path.isfile(dst):
        return
    if os.path.isfile(src):
        shutil.copy2(src, dst)


def run(mode):
    do_write = (mode == '--write')
    counts = {'OK': 0, 'SKIP': 0, 'PENDING': 0, 'ERR': 0}
    cache = {}

    for rel, o in OPS:
        if rel not in cache:
            raw, text, crlf = load(rel)
            cache[rel] = {'text': text, 'crlf': crlf, 'dirty': False}
        ent = cache[rel]
        text = ent['text']
        sig = o['sig']
        old = o['old']
        if sig in text:
            st = 'SKIP'
        else:
            n = text.count(old)
            if n == 1:
                ent['text'] = text.replace(old, o['new'], 1)
                ent['dirty'] = True
                st = 'OK'
            elif n == 0:
                st = 'ERR_ANCHOR_MISSING'
            else:
                st = 'ERR_ANCHOR_DUP(%d)' % n
        key = 'ERR' if st.startswith('ERR') else st
        counts[key] += 1
        print('[%s] %s -> %s' % (mode, rel + ' :: ' + o['tag'], st))

    if do_write:
        for rel, ent in cache.items():
            if ent['dirty']:
                do_backup(rel)
                save(rel, ent['text'], ent['crlf'])
                print('[write] %s 已落盘（已备份到 %s）' % (rel, BACKUP))

    print('RESULT: OK=%d SKIP=%d PENDING=%d ERR=%d' % (
        counts['OK'], counts['SKIP'], counts['PENDING'], counts['ERR']))
    return 1 if counts['ERR'] else 0


def restore(include_new):
    files = sorted(set([rel for rel, _ in OPS]))
    for rel in files:
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        if not os.path.isfile(src):
            print('[restore] 缺备份 %s' % rel)
            continue
        dst = os.path.join(ROOT, rel)
        shutil.copy2(src, dst)
        print('[restore] %s' % rel)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--check':
        sys.exit(run('--check'))
    elif mode == '--write':
        sys.exit(run('--write'))
    elif mode == '--restore-src':
        restore(False)
    elif mode == '--restore':
        restore(True)
    else:
        print('用法: --check | --write | --restore-src | --restore')
