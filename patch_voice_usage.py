# -*- coding: utf-8 -*-
"""
[voice-usage v1] 语音用量记账：补上流式链路这个唯一缺口（2026-09-24）

现象：`getAiStats` 显示 `byFn.speechToText.count = 3` 但用户「试了几次语音都没 +1」。
根因（结构性，非 bug）：语音有两条链路，埋点只加在了云函数侧 ——
  · Android 真机 / 开发者工具：**火山流式识别由客户端直连**（wx.connectSocket → openspeech.bytedance.com），
    全程不调用任何云函数 ⇒ 云函数里的 logAiUsage 永远看不到它 ⇒ 用量不可计。
  · iOS / 流式失败回退：录音上传 + speechToText 云函数 ⇒ 已由云函数内部记账（那 3 条来自这里）。
（`getAsrConfig` 有 24h 缓存、预热即拉过，不能当用量记账点。）

用户 2026-09-24 拍板：**方案 1（只补流式缺口）+ A（只在真的用完一次识别时上报）+ B（带秒数）
+ C（新建独立云函数）**：
  · 客户端只在**流式会话收尾**上报一次（成功交付 / 没听清都算 —— 火山时长已消耗）；
  · 误触取消、以及已回退整段链路（speechToText 内部已记账）都不上报 ⇒ **零双计**；
  · 上报静默、不 await、异常吞掉 —— 记账绝不干扰语音交互；
  · 字段 `fn:'speechToText' + mode:'stream' + source:'client'` ⇒ `byFn.speechToText.count`
    天然等于「全部语音次数」（两种 mode 相加），额度制可直接拿它算。

改动（1 源文件 7 处 + 新建 2 文件）：
  A. utils/voice.js  新增会话级记账状态（sessionSeconds / sessionStreamUsed / sessionBatchUsed / usageReported）
  B. utils/voice.js  start() 每轮重置记账状态
  C. utils/voice.js  WS onOpen（真连上）才置 sessionStreamUsed —— 「纯流式」的判据
  D. utils/voice.js  onStop 冻结本次录音秒数（state.seconds 随即被清零）
  E. utils/voice.js  transcribe() 标记「已回退整段」⇒ 抑制流式上报（防双计）
  F. utils/voice.js  finalizeStream() 收尾时上报一次
  G. utils/voice.js  新增 reportVoiceUsage()（守卫 + 静默 fire-and-forget）
  H. cloudfunctions/logVoiceUsage/index.js      新函数：写 ai_usage（fn=speechToText, source=client）
  I. cloudfunctions/logVoiceUsage/package.json  依赖 wx-server-sdk（部署须勾「云端安装依赖」）

用法：--check / --write / --restore（回滚源码）/ --restore-src（只回滚源码，留新测试做红灯自检）
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\voice-usage-backup-20260924'

VOICE = r'utils\voice.js'
CF_MAIN = r'cloudfunctions\logVoiceUsage\index.js'
CF_PKG = r'cloudfunctions\logVoiceUsage\package.json'

# ===== A. voice.js：会话级记账状态 ==========================================
A_OLD = "let streamFinalized = false      // 本次流式会话是否已收尾（防重入）\n"
A_NEW = """let streamFinalized = false      // 本次流式会话是否已收尾（防重入）

// ===== [voice-usage v1] 语音用量记账（商业化埋点）=====
// 流式链路（Android/开发者工具的火山实时识别）**由客户端直连火山、不经过任何云函数**，
// 云函数侧的 logAiUsage 天然覆盖不到它 ⇒ 用量只能由客户端在会话收尾时上报一次。
// 四个标记的分工（缺一个就会出现「少数/多算」）：
//   sessionSeconds   本次录音时长（onStop 冻结，用于额度制的「语音分钟数」）
//   sessionStreamUsed 本次**真的连上过** WS（纯流式判据；没连上就是整段链路，云端已记账）
//   sessionBatchUsed  本次已走整段识别（speechToText 内部已记账）⇒ 抑制流式上报，防双计
//   usageReported    一次会话只上报一条（finalizeStream 有多条触发路径）
let sessionSeconds = 0
let sessionStreamUsed = false
let sessionBatchUsed = false
let usageReported = false
"""
A_GUARD = "let sessionBatchUsed = false"

# ===== B. voice.js：start() 每轮重置 =======================================
B_OLD = "  currentContextText = String((opts && opts.contextText) || '')\n"
B_NEW = """  currentContextText = String((opts && opts.contextText) || '')
  // [voice-usage v1] 新一轮会话：记账状态复位（上一轮的标记绝不能继承）
  sessionSeconds = 0
  sessionStreamUsed = false
  sessionBatchUsed = false
  usageReported = false
"""
B_GUARD = "sessionStreamUsed = false\n  sessionBatchUsed = false\n  usageReported = false"

# ===== C. voice.js：onOpen 置「纯流式」标记 =================================
C_OLD = """    socketOpen = true
    // [hotword-off-critical-path v1] 在此处（而非 connectSocket 之前）构建热词：
"""
C_NEW = """    socketOpen = true
    // [voice-usage v1] 真连上了 ⇒ 本次是「纯流式」会话（用量需客户端上报；
    // 未连上就退整段链路的会话由 speechToText 云函数记账，见 transcribe）
    sessionStreamUsed = true
    // [hotword-off-critical-path v1] 在此处（而非 connectSocket 之前）构建热词：
"""
C_GUARD = "sessionStreamUsed = true\n    // [hotword-off-critical-path v1]"

# ===== D. voice.js：onStop 冻结秒数 ========================================
D_OLD = """    if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
    const duration = state.seconds
"""
D_NEW = """    if (recordTimer) { clearInterval(recordTimer); recordTimer = null }
    const duration = state.seconds
    // [voice-usage v1] 先冻结秒数：state.seconds 下面立刻被清零，而 finalizeStream 稍后才跑
    sessionSeconds = state.seconds
"""
D_GUARD = "sessionSeconds = state.seconds"

# ===== E. voice.js：transcribe 标记「已回退整段」 ==========================
E_OLD = """async function transcribe(filePath, format) {
  state.transcribing = true
"""
E_NEW = """async function transcribe(filePath, format) {
  // [voice-usage v1] 这一路（iOS / 流式失败回退）经 speechToText 云函数识别，
  // 用量已由云函数内部 logAiUsage 记账 ⇒ 客户端**不再重复上报**（防双计）
  sessionBatchUsed = true
  state.transcribing = true
"""
E_GUARD = "sessionBatchUsed = true\n  state.transcribing = true"

# ===== F. voice.js：finalizeStream 收尾上报 =================================
F_OLD = """  state.liveRaw = fullText
  const r = voiceFilter.purify(fullText)
  if (r.text) {
    deliver(r.text, r.count)
"""
F_NEW = """  state.liveRaw = fullText
  const r = voiceFilter.purify(fullText)
  // [voice-usage v1] 流式链路用量上报（唯一记账点）：到这里说明本次确实用完了识别服务
  //（识别出内容 or「没听清」——火山时长都已消耗）。误触取消 / 回退整段会被 reportVoiceUsage 内部拦掉。
  reportVoiceUsage(!!r.text)
  if (r.text) {
    deliver(r.text, r.count)
"""
F_GUARD = "reportVoiceUsage(!!r.text)"

# ===== G. voice.js：reportVoiceUsage 定义 ==================================
G_OLD = "// ===== 回退链路：录音 → 上传 → speechToText 云函数（火山录音文件极速识别）=====\n"
G_NEW = """// ===== [voice-usage v1] 流式链路用量上报 =====
// 这是**客户端唯一**的用量上报点。口径（用户 2026-09-24 拍板）：
//   · 只在真的用完一次识别时上报（成功交付 / 没听清都算：火山时长已消耗）
//   · 误触取消（cancelRequested）、回退整段链路（sessionBatchUsed，云端已记账）一律不上报
//   · 静默 fire-and-forget：不 await、失败吞掉 —— 记账绝不干扰语音交互
function reportVoiceUsage(recognized) {
  if (usageReported) return
  if (!sessionStreamUsed || sessionBatchUsed) return
  if (cancelRequested) return
  usageReported = true
  if (!wx.cloud || !wx.cloud.callFunction) return
  try {
    wx.cloud.callFunction({
      name: 'logVoiceUsage',
      data: {
        mode: 'stream',
        seconds: sessionSeconds,
        ok: !!recognized
      }
    }).catch(() => {})
  } catch (e) { /* 静默：记账失败不影响交付 */ }
}

// ===== 回退链路：录音 → 上传 → speechToText 云函数（火山录音文件极速识别）=====
"""
G_GUARD = "function reportVoiceUsage(recognized) {"

# ===== H/I. 新建云函数 =====================================================
CF_INDEX = """/**
 * 云函数：logVoiceUsage
 * [voice-usage v1] 流式语音用量记账（2026-09-24）
 *
 * 为什么需要它：语音的两条链路里，**火山流式识别由客户端直连**（Android/开发者工具），
 * 全程不调用任何云函数 ⇒ 云函数侧 logAiUsage 覆盖不到 ⇒ 用量不可计。
 * 客户端在流式会话收尾时调本函数上报一次；iOS / 流式失败回退那条路由 speechToText
 * 云函数内部自行记账（本函数不参与），因此**不会双计**。
 *
 * 入参：{ mode:'stream', seconds:number（本次录音秒数，用于额度制的语音分钟数）, ok:boolean（是否识别出内容） }
 * 出参：{ ok:true } / { ok:false, error }  —— 客户端不 await 结果，失败仅告警
 *
 * 写入 ai_usage：fn 固定为 'speechToText'（与云函数侧同一口径 ⇒ byFn.speechToText.count
 * 天然等于全部语音次数），mode='stream'、source='client' 用于区分链路。
 * ⚠️ 集合不存在 / 写失败只 warn，绝不阻塞客户端。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 北京时间自然日键（与 aiSummary / speechToText 内的同款实现保持一致）
function getBeijingDateKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = n => n < 10 ? '0' + n : '' + n
  return now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  // 秒数夹紧 [0, 3600]：一次语音不可能超过 1 小时，防脏数据污染额度统计
  const rawSeconds = parseInt(event && event.seconds, 10)
  const seconds = Math.max(0, Math.min(isNaN(rawSeconds) ? 0 : rawSeconds, 3600))
  try {
    await db.collection('ai_usage').add({
      data: {
        openid: (wxContext && wxContext.OPENID) || 'unknown',
        fn: 'speechToText',
        mode: 'stream',
        source: 'client',
        ok: !(event && event.ok === false),
        seconds: seconds,
        date: getBeijingDateKey(),
        ts: Date.now()
      }
    })
    return { ok: true }
  } catch (e) {
    console.warn('[ai-usage] logVoiceUsage 记账失败(不阻塞):', e && e.message)
    return { ok: false, error: String((e && e.message) || 'log fail') }
  }
}
"""

CF_PACKAGE = """{
  "name": "logVoiceUsage",
  "version": "1.0.0",
  "description": "流式语音用量记账（[voice-usage v1]）：流式链路客户端直连火山、不经云函数，用量由客户端上报",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }
}
"""

NEW_FILES = [(CF_MAIN, CF_INDEX), (CF_PKG, CF_PACKAGE)]

OPS = [
    (VOICE, A_OLD, A_NEW, A_GUARD, 1),
    (VOICE, B_OLD, B_NEW, B_GUARD, 1),
    (VOICE, C_OLD, C_NEW, C_GUARD, 1),
    (VOICE, D_OLD, D_NEW, D_GUARD, 1),
    (VOICE, E_OLD, E_NEW, E_GUARD, 1),
    (VOICE, F_OLD, F_NEW, F_GUARD, 1),
    (VOICE, G_OLD, G_NEW, G_GUARD, 1),
]

ALL_RELS = sorted(set(o[0] for o in OPS))
SRC_RELS = [r for r in ALL_RELS if not r.startswith('tools')]


def load(rel):
    raw = open(os.path.join(WORK, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n'), crlf)


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(WORK, rel), 'wb').write(text.encode('utf-8'))


def backup():
    """幂等备份：目标已存在即早退，绝不覆盖干净备份"""
    made = 0
    for rel in ALL_RELS:
        dst = os.path.join(BK, rel)
        if os.path.exists(dst):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(WORK, rel), dst)
        made += 1
    print('backup: %s (%d files%s)' % (BK, made, '' if made else ', 已存在即跳过'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore', 'restore-src'):
        print('usage: patch_voice_usage.py --check|--write|--restore|--restore-src')
        return 2
    if mode in ('restore', 'restore-src'):
        rels = ALL_RELS if mode == 'restore' else SRC_RELS
        for rel in rels:
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
        return 0

    if mode == 'write':
        backup()

    ok_all = True
    for rel, old, new, guard, expect in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if c_new >= expect:
            print('SKIP(applied)  %-30s guard=%d' % (rel, c_new))
        elif c_old == expect:
            if mode == 'write':
                save(rel, text.replace(old, new), crlf)
            print('OK             %-30s old=%d' % (rel, c_old))
        else:
            ok_all = False
            print('FAIL           %-30s old=%d guard=%d (expect old=%d)' % (rel, c_old, c_new, expect))

    # 新建文件（云函数）：--write 时落盘，--check 只报告状态
    for rel, content in NEW_FILES:
        p = os.path.join(WORK, rel)
        if os.path.exists(p):
            print('EXISTS         %-30s' % rel)
        elif mode == 'write':
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, 'wb').write(content.encode('utf-8'))
            print('CREATED        %-30s' % rel)
        else:
            print('MISSING        %-30s (--write 会创建)' % rel)
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
