# -*- coding: utf-8 -*-
"""[voice-ready-guard v1] 按住说话「准备中」防闪

背景（用户真机反馈）：
  「按住说话」在「聆听中」之前有个「准备中」状态，每次都一闪而过，浮层显得不连贯。

根因（代码实测）：
  utils/voice.js#start() 一按下就置 state.connecting = true（浮层立即弹「准备中/请稍候…」），
  等录音硬件真正起来（recorderManager.onStart → beginSession()）才翻成 recording ⇒ 标题跳到
  「正在聆听/请说话…」。两态之间只隔**开麦的原生耗时**（真机常见 100~300ms），所以必然一闪而过；
  同一瞬间还有三处视觉同时变化，叠加成「两段式跳动」：
    ① 文案硬切（标题 + 正文 + 底部按钮说明）
    ② 卡片样式 .voice-card-processing 由 `!recording` 驱动 ⇒ 底色/描边/标题色一起换
    ③ 波形 .voice-waves 带 wx:if ⇒ 出现时撑高 64rpx，把整张卡片顶上去

修法（用户拍板 1 + 2）：
  1. 状态词「慢了才出现」：新增呈现层信号 connectingSlow —— connecting 持续 ≥ CONNECT_SLOW_MS(300ms)
     才置真；浮层文案/卡片样式一律只认 connectingSlow ⇒ 快链路下用户全程只看到「正在聆听」，
     「准备中」永不出现；真慢链路（首次授权等）如实显示。另加「最短停留」CONNECT_SLOW_MIN_SHOW_MS(400ms)：
     一旦显示就不立刻切走，避免阈值边缘（如 350ms 才连上）出现第二次闪。
  2. 骨架固定：卡片样式改由 connectingSlow/transcribing 驱动（开录瞬间零样式变化）；
     波形改为「常驻占位 + 非录音态隐藏」，高度恒定 ⇒ 开录时卡片不再被顶动。
  connectingSlow **不参与任何录音/识别/超时逻辑**，纯呈现层；connecting 本身语义（浮层立即弹出）不变。

用法：
  python patch_voice_ready_guard.py --check     # 预检（默认）
  python patch_voice_ready_guard.py --write     # 落盘（自动备份，幂等）
  python patch_voice_ready_guard.py --restore   # 从备份还原
"""
import io, os, sys, shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\语音准备中防闪-backup-20260923'
OUT = os.path.join(ROOT, 'patch_voice_ready_guard_out.txt')

V = 'utils/voice.js'
W = 'pages/write/write.wxml'
A = 'pages/archive/archive.wxml'
D = 'pages/detail/detail.wxml'
S = 'pages/summary/summary.wxml'
WX = 'pages/write/write.wxss'
AX = 'pages/archive/archive.wxss'
DX = 'pages/detail/detail.wxss'

# ---------------------------------------------------------------- voice.js
OLD_NOTE = "// 注意：净化（删语气词）是第一层处理，AI 优化（写日记页的润色按钮）是第二层，互不替代。"
NEW_NOTE = OLD_NOTE + """
//
// [voice-ready-guard v1] 「准备中」防闪：connecting 是**开麦/建链的原生耗时**（真机常见 100~300ms），
// 直接映射到浮层文案必然「准备中 → 正在聆听」一闪而过。这里把 connecting（真实状态）与
// connectingSlow（呈现层信号）拆开：
//   · 按下后 300ms 内 connecting 就结束（多数情况）⇒ connectingSlow 恒为 false，用户全程只看到「正在聆听」
//   · 超过 300ms ⇒ 显示「准备中」；且一旦显示，最短停留 400ms，避免「刚显示就被切走」的第二段闪
// connectingSlow 不参与任何录音/识别/超时逻辑，只驱动浮层文案与卡片样式（可安全忽略）。
// 浮层的 wx:if 仍然只认 recording || transcribing || connecting ⇒ 按下即弹的响应感不变。"""

OLD_STATE = "  connecting: false,  // 实时链路建立中（授权→取配置→WS建连），按钮显示「连接中」"
NEW_STATE = OLD_STATE + """
  connectingSlow: false,  // [voice-ready-guard v1] connecting 已持续够久（呈现层：慢链路才显示「准备中」，快链路全程「正在聆听」）"""

OLD_HOLD = "const HOLD_MIN_MS = 300"
NEW_HOLD = OLD_HOLD + """
// [voice-ready-guard v1] 慢链路判定与最短停留（只影响呈现，见文件头说明）
const CONNECT_SLOW_MS = 300          // connecting 超过它才允许显示「准备中」
const CONNECT_SLOW_MIN_SHOW_MS = 400 // 一旦显示「准备中」，至少停留这么久（防阈值边缘的第二次闪）
let connectingSlowTimer = null       // 显示计时器（到点才置 connectingSlow=true）
let connectingSlowHoldTimer = null   // 最短停留计时器（延迟收起）
let connectingSlow = false           // 判定结果，同步进 state.connectingSlow
let connectingSlowShownAt = 0        // 本次「准备中」开始显示的时刻"""

OLD_EMIT = """// 向所有订阅页面广播当前状态
function emitState() {
  const snapshot = Object.assign({}, state)"""
NEW_EMIT = """// [voice-ready-guard v1] 按 state.connecting 起/停「慢链路」计时器，并把结果同步进 state。
// 挂在 emitState 里而不是 9 处赋值点逐处插桩：所有改 connecting 的分支后面都紧跟一次 emitState
// （beginSession / beginRecording 取消分支 / authorize fail / cancelSession / onStop / onError /
// onOpen / finalizeStream），一处覆盖全部路径 ⇒ 少插桩、少出错。
// 递归安全：内层 emitState 再进来时 connectingSlow 已为 true，不会重复排显示计时器。
function syncConnectingSlow() {
  if (state.connecting) {
    // 新链路建立中：先把「延迟收起」作废（否则会把新一轮的标记提前关掉）
    if (connectingSlowHoldTimer) { clearTimeout(connectingSlowHoldTimer); connectingSlowHoldTimer = null }
    if (!connectingSlow && !connectingSlowTimer) {
      connectingSlowTimer = setTimeout(() => {
        connectingSlowTimer = null
        if (state.connecting) {
          connectingSlow = true
          connectingSlowShownAt = Date.now()
          emitState()
        }
      }, CONNECT_SLOW_MS)
    }
  } else {
    if (connectingSlowTimer) { clearTimeout(connectingSlowTimer); connectingSlowTimer = null }
    if (connectingSlow && Date.now() - connectingSlowShownAt < CONNECT_SLOW_MIN_SHOW_MS) {
      // 已显示且未满最短停留：延迟收起（只排一次），期间继续保持显示
      if (!connectingSlowHoldTimer) {
        connectingSlowHoldTimer = setTimeout(() => {
          connectingSlowHoldTimer = null
          emitState()
        }, CONNECT_SLOW_MIN_SHOW_MS - (Date.now() - connectingSlowShownAt))
      }
      state.connectingSlow = true
      return
    }
    connectingSlow = false
  }
  state.connectingSlow = connectingSlow
}

// 向所有订阅页面广播当前状态
function emitState() {
  syncConnectingSlow()
  const snapshot = Object.assign({}, state)"""

OLD_START = """  state.connecting = true
  emitState()"""
NEW_START = """  // [voice-ready-guard v1] 新一轮按下：慢链路标记连同两个计时器一起复位
  // （否则上一轮的标记会被本轮继承 ⇒ 新会话一上来就显示「准备中」）
  if (connectingSlowTimer) { clearTimeout(connectingSlowTimer); connectingSlowTimer = null }
  if (connectingSlowHoldTimer) { clearTimeout(connectingSlowHoldTimer); connectingSlowHoldTimer = null }
  connectingSlow = false
  connectingSlowShownAt = 0
  state.connecting = true
  state.connectingSlow = false
  emitState()"""

OLD_ERRLIT = "    state = { recording: false, transcribing: false, seconds: 0, connecting: false, liveText: '', liveRaw: '', liveRemoved: 0, liveMode: false }"
NEW_ERRLIT = """    if (connectingSlowTimer) { clearTimeout(connectingSlowTimer); connectingSlowTimer = null }
    if (connectingSlowHoldTimer) { clearTimeout(connectingSlowHoldTimer); connectingSlowHoldTimer = null }
    connectingSlow = false
    connectingSlowShownAt = 0
    state = { recording: false, transcribing: false, seconds: 0, connecting: false, connectingSlow: false, liveText: '', liveRaw: '', liveRemoved: 0, liveMode: false }"""

OLD_EXPORT = "module.exports = { start, stop, onStateChange, getState, warmup, HOLD_MIN_MS }"
NEW_EXPORT = "module.exports = { start, stop, onStateChange, getState, warmup, HOLD_MIN_MS, CONNECT_SLOW_MS, CONNECT_SLOW_MIN_SHOW_MS }"

# ---------------------------------------------------------------- 4 页共用文案
OLD_TITLE = "{{transcribing ? '语音识别中' : (connecting ? '准备中' : '正在聆听')}}"
NEW_TITLE = "{{transcribing ? '语音识别中' : (connectingSlow ? '准备中' : '正在聆听')}}"

OLD_BODY = "{{liveText || (recording ? '请说话…' : (connecting ? '请稍候…' : '识别中…'))}}"
# 快链路的 connecting 与 recording 同文案（都说「请说话…」）：省掉的正是那一闪
NEW_BODY = "{{liveText || (connectingSlow ? '请稍候…' : (recording || connecting ? '请说话…' : '识别中…'))}}"

OLD_BTN = "(connecting ? '连接中…' : '按住 说话')"
NEW_BTN = "(connectingSlow ? '连接中…' : '按住 说话')"

# ---------------------------------------------------------------- 三页卡片结构（write/archive/detail 同款）
OLD_CARD = """<view class="voice-card {{recording ? '' : 'voice-card-processing'}}">"""
NEW_CARD = """<view class="voice-card {{(connectingSlow || transcribing) ? 'voice-card-processing' : ''}}">"""

OLD_WAVES = """<view class="voice-waves" wx:if="{{recording}}">"""
NEW_WAVES = """<view class="voice-waves {{recording ? '' : 'voice-waves-idle'}}">"""

# write / archive 独有的波形注释（detail 没有这行注释），随改动同步更新说明
OLD_WAVES_NOTE = "<!-- 音频波形（仅在录音中显示） -->"
NEW_WAVES_NOTE = "<!-- 音频波形（常驻占位、非录音态隐藏 ⇒ 开录时卡片不会被顶动；见 voice.wxss 的 .voice-waves-idle） -->"

# ---------------------------------------------------------------- summary 独有
OLD_CLS = "{{connecting ? 'connecting' : ''}}"
NEW_CLS = "{{connectingSlow ? 'connecting' : ''}}"

OLD_WAVES_CSS = """.voice-waves {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  margin-top: 20rpx;
  height: 44rpx;
}"""
NEW_WAVES_CSS = OLD_WAVES_CSS + """

/* [voice-ready-guard v1] 波形占位：非录音态也保留这 64rpx（20 外边距 + 44 高），
   否则录音一开始波形出现会把整张卡片顶上去，与文案切换叠加成「两段式跳动」。
   占位期间同时停掉动画，避免空转。 */
.voice-waves-idle {
  visibility: hidden;
}

.voice-waves-idle .voice-wave {
  animation: none;
}"""

OPS = [
    # ---- voice.js
    (V, OLD_NOTE, NEW_NOTE, '[voice-ready-guard v1] 「准备中」防闪：connecting 是**开麦/建链的原生耗时**'),
    (V, OLD_STATE, NEW_STATE, 'connectingSlow: false,  // [voice-ready-guard v1] connecting 已持续够久'),
    (V, OLD_HOLD, NEW_HOLD, 'const CONNECT_SLOW_MIN_SHOW_MS = 400'),
    (V, OLD_EMIT, NEW_EMIT, 'function syncConnectingSlow() {'),
    (V, OLD_START, NEW_START, '// [voice-ready-guard v1] 新一轮按下：慢链路标记连同两个计时器一起复位'),
    (V, OLD_ERRLIT, NEW_ERRLIT, "connecting: false, connectingSlow: false, liveText: ''"),
    (V, OLD_EXPORT, NEW_EXPORT, 'HOLD_MIN_MS, CONNECT_SLOW_MS, CONNECT_SLOW_MIN_SHOW_MS }'),
    # ---- write / archive / detail（同款结构）
    (W, OLD_TITLE, NEW_TITLE, "connectingSlow ? '准备中' : '正在聆听'"),
    (W, OLD_BODY, NEW_BODY, "connectingSlow ? '请稍候…' : (recording || connecting ? '请说话…'"),
    (W, OLD_CARD, NEW_CARD, "(connectingSlow || transcribing) ? 'voice-card-processing'"),
    (W, OLD_WAVES, NEW_WAVES, 'voice-waves {{recording ? \'\' : \'voice-waves-idle\'}}'),
    (W, OLD_WAVES_NOTE, NEW_WAVES_NOTE, '音频波形（常驻占位、非录音态隐藏'),
    (W, OLD_BTN, NEW_BTN, "connectingSlow ? '连接中…' : '按住 说话'"),
    (A, OLD_TITLE, NEW_TITLE, "connectingSlow ? '准备中' : '正在聆听'"),
    (A, OLD_BODY, NEW_BODY, "connectingSlow ? '请稍候…' : (recording || connecting ? '请说话…'"),
    (A, OLD_CARD, NEW_CARD, "(connectingSlow || transcribing) ? 'voice-card-processing'"),
    (A, OLD_WAVES, NEW_WAVES, 'voice-waves {{recording ? \'\' : \'voice-waves-idle\'}}'),
    (A, OLD_WAVES_NOTE, NEW_WAVES_NOTE, '音频波形（常驻占位、非录音态隐藏'),
    (A, OLD_BTN, NEW_BTN, "connectingSlow ? '连接中…' : '按住 说话'"),
    (D, OLD_TITLE, NEW_TITLE, "connectingSlow ? '准备中' : '正在聆听'"),
    (D, OLD_BODY, NEW_BODY, "connectingSlow ? '请稍候…' : (recording || connecting ? '请说话…'"),
    (D, OLD_CARD, NEW_CARD, "(connectingSlow || transcribing) ? 'voice-card-processing'"),
    (D, OLD_WAVES, NEW_WAVES, 'voice-waves {{recording ? \'\' : \'voice-waves-idle\'}}'),
    (D, OLD_BTN, NEW_BTN, "connectingSlow ? '连接中…' : '按住 说话'"),
    # ---- summary（卡片结构不同）
    (S, OLD_TITLE, NEW_TITLE, "connectingSlow ? '准备中' : '正在聆听'"),
    (S, OLD_BODY, NEW_BODY, "connectingSlow ? '请稍候…' : (recording || connecting ? '请说话…'"),
    (S, OLD_BTN, NEW_BTN, "connectingSlow ? '连接中…' : '按住 说话'"),
    (S, OLD_CLS, NEW_CLS, "{{connectingSlow ? 'connecting' : ''}}"),
    # ---- 三页 wxss：波形占位
    (WX, OLD_WAVES_CSS, NEW_WAVES_CSS, '.voice-waves-idle {'),
    (AX, OLD_WAVES_CSS, NEW_WAVES_CSS, '.voice-waves-idle {'),
    (DX, OLD_WAVES_CSS, NEW_WAVES_CSS, '.voice-waves-idle {'),
]

log = []


def load(p):
    raw = io.open(p, 'r', encoding='utf-8', newline='').read()
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n') if crlf else raw), crlf


def save(p, text, crlf):
    io.open(p, 'w', encoding='utf-8', newline='').write(text.replace('\n', '\r\n') if crlf else text)


def backup_once(rel):
    """--write 自动备份：幂等（已存在即早退，绝不覆盖干净备份）"""
    s = os.path.join(ROOT, rel.replace('/', os.sep))
    d = os.path.join(BACKUP, rel.replace('/', os.sep))
    if not os.path.exists(d):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
        return 'backup->' + rel
    return 'backup skip(已存在) ' + rel


def main():
    mode = 'check'
    for a in sys.argv[1:]:
        if a in ('--check', '--write', '--restore'):
            mode = a.lstrip('-')

    if mode == 'restore':
        for rel in sorted(set(o[0] for o in OPS)):
            d = os.path.join(BACKUP, rel.replace('/', os.sep))
            s = os.path.join(ROOT, rel.replace('/', os.sep))
            if not os.path.exists(d):
                log.append('RESTORE MISSING(无备份) ' + rel)
                continue
            shutil.copy2(d, s)
            log.append('RESTORE ' + rel)
        return

    texts, crlfs = {}, {}
    for rel in sorted(set(o[0] for o in OPS)):
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        texts[rel], crlfs[rel] = load(p)

    applied, skipped, failed = 0, 0, 0
    for rel, old, new, guard in OPS:
        t = texts[rel]
        if guard in t:
            log.append('SKIP(已应用) %-26s %s' % (rel, guard[:44]))
            skipped += 1
            continue
        n = t.count(old)
        if n != 1:
            log.append('FAIL(锚点命中 %d 次，应为 1) %-26s %s' % (n, rel, old[:60].replace('\n', '⏎')))
            failed += 1
            continue
        texts[rel] = t.replace(old, new, 1)
        log.append('%-6s %-26s %s' % ('APPLY' if mode == 'write' else 'CHECK', rel, guard[:44]))
        applied += 1

    if mode == 'write' and failed == 0:
        for rel in sorted(set(o[0] for o in OPS)):
            log.append(backup_once(rel))
        for rel in sorted(set(o[0] for o in OPS)):
            save(os.path.join(ROOT, rel.replace('/', os.sep)), texts[rel], crlfs[rel])
        log.append('WROTE %d 文件' % len(set(o[0] for o in OPS)))

    log.append('汇总: %s applied=%d skipped=%d failed=%d' % (mode, applied, skipped, failed))
    if mode != 'write':
        log.append('（预检模式，未写盘）' if mode == 'check' else '')
    io.open(OUT, 'w', encoding='utf-8').write('\n'.join(log) + '\n')
    sys.exit(1 if failed else 0)


main()
