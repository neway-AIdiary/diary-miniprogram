# -*- coding: utf-8 -*-
r"""
patch_summary_freeze.py —— [summary-freeze v1] 智能总结页「生成中整页冻结」
用户拍板 2026-09-23：生成中该页其他按钮与元素无法点击 / 点击不反应
  ① 静默（去掉 chip 的「正在生成，请稍候」toast）② 生成中禁滚动 ③ 极淡压暗 6%

  python patch_summary_freeze.py --check    预检（只报锚点，不写盘）
  python patch_summary_freeze.py --write    落盘（自动备份，幂等）
  python patch_summary_freeze.py --restore  从备份还原

幂等判据：每个 op 的 guard 串（本批新注入的独有文本）——已存在即 SKIP。
锚点要求：在当前磁盘文本里 count == 1，否则 FAIL（整批不写盘）。
"""

import os
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\summary-freeze-backup-20260923'

WXML = r'pages\summary\summary.wxml'
WXSS = r'pages\summary\summary.wxss'
SJS = r'pages\summary\summary.js'
TJS = r'tools\test_summary_shortcuts.js'

OPS = []

# ============================================================
# 一、summary.wxml —— 冻结遮罩 + textarea disabled
# ============================================================
OPS.append(dict(
    rel=WXML, tag='wxml 冻结遮罩',
    guard=r'class="gen-mask"',
    old=r"""  <!-- 底部固定底栏（与写日记主页 / 详情编辑页 / 档案页结构一致） -->
  <view class="input-bar-wrap">""",
    new=r"""  <!-- [summary-freeze v1] 生成中整页冻结遮罩：吞掉全部点击与滑动（catchtap + catchtouchmove）
       z-index 300 是数值夹逼出来的硬约束：
         · 必须 > 201（range-picker 弹层 200/201）—— 低了盖不住时间胶囊本体与其弹层
         · 必须 < 1000（.voice-modal 语音浮层）—— 高了会盖住浮层，导致「先按住说话 → 再点生成」
           时松手事件被吞、录音永远结束不了
       6% 极淡压暗表示「当前不可操作」：全透明会让用户误判卡死；不加文案/动画（结果区与底栏已有状态） -->
  <view
    class="gen-mask"
    wx:if="{{loading}}"
    catchtap="onFrozenTap"
    catchtouchmove="onFrozenTap"
  ></view>

  <!-- 底部固定底栏（与写日记主页 / 详情编辑页 / 档案页结构一致） -->
  <view class="input-bar-wrap">""",
))

OPS.append(dict(
    rel=WXML, tag='wxml 输入区注释',
    guard=r'[summary-freeze v1] 生成中 disabled',
    old=r"""      <!-- 需求输入区 -->
      <view class="input-card">""",
    new=r"""      <!-- 需求输入区（[summary-freeze v1] 生成中 disabled：textarea 是原生组件，
           同层渲染下未必被遮罩压住，这里必须是第二道闸） -->
      <view class="input-card">""",
))

OPS.append(dict(
    rel=WXML, tag='wxml textarea disabled',
    guard=r'disabled="{{loading}}"',
    old=r"""          value="{{prompt}}"
          bindinput="onPromptInput"
          maxlength="-1"
          auto-height""",
    new=r"""          value="{{prompt}}"
          disabled="{{loading}}"
          bindinput="onPromptInput"
          maxlength="-1"
          auto-height""",
))

# ============================================================
# 二、summary.wxss —— 遮罩样式（z-index 夹逼 + 6% 压暗，深色换白）
# ============================================================
OPS.append(dict(
    rel=WXSS, tag='wxss 遮罩样式',
    guard=r'.gen-mask {',
    old=r"""/* ===== 语音录音浮层 ===== */""",
    new=r"""/* ===== 生成中冻结遮罩 [summary-freeze v1] =====
   生成中整页不可操作：wxml 侧用 catchtap + catchtouchmove 把点击与滑动都吞在遮罩层，
   不再冒泡到下面的时间胶囊 / 输入框 / 快捷模板 / 按住说话。
   ⚠️ z-index 300 是数值夹逼出来的硬约束，改前先看这两条：
     · 必须 > 201（range-picker 弹层 200/201）—— 低了盖不住胶囊本体与其弹层
     · 必须 < 1000（.voice-modal）—— 高了会盖住语音浮层，导致「先按住说话 → 再生成」
       时松手事件被吞、录音无法结束
   6% 极淡压暗：让人看出「现在不能操作」，又不干扰阅读；不加文案/动画（状态已在结果区与底栏）*/
.gen-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 300;
  background: rgba(42, 38, 34, 0.06);
}

/* 深色主题：深色 scrim 在深底上几乎不可见 ⇒ 换极淡白（同样「呼吸级」，只为可感知） */
.theme-dark .gen-mask {
  background: rgba(255, 255, 255, 0.05);
}

/* ===== 语音录音浮层 ===== */""",
))

# ============================================================
# 三、summary.js —— 5 处入口守卫 + 遮罩空接收器
# ============================================================
OPS.append(dict(
    rel=SJS, tag='js onPromptInput 守卫',
    guard=r'// [summary-freeze v1] 生成中冻结整页：不接收输入',
    old=r"""  onPromptInput(e) {
    // [monthly-review v1] 手动改过需求 → 近两月固定区间失效（恢复由顶部胶囊决定）""",
    new=r"""  onPromptInput(e) {
    // [summary-freeze v1] 生成中冻结整页：不接收输入（遮罩已挡，此处是原生 textarea 的兜底）
    if (this.data.loading) return
    // [monthly-review v1] 手动改过需求 → 近两月固定区间失效（恢复由顶部胶囊决定）""",
))

OPS.append(dict(
    rel=SJS, tag='js onHoldStart 守卫',
    guard=r'// [summary-freeze v1] 生成中冻结整页：不起录',
    old=r"""  onHoldStart() {
    this._suppressEnd = false""",
    new=r"""  onHoldStart() {
    // [summary-freeze v1] 生成中冻结整页：不起录
    // ⚠️ onHoldEnd **故意不加守卫** —— 生成开始前已在录音的会话必须能正常松手收尾，否则录音挂死
    if (this.data.loading) return
    this._suppressEnd = false""",
))

OPS.append(dict(
    rel=SJS, tag='js onRangeChange 守卫',
    guard=r'// [summary-freeze v1] 生成中冻结整页：忽略范围变更',
    old=r"""  onRangeChange(e) {
    const d = (e && e.detail) || {}""",
    new=r"""  onRangeChange(e) {
    // [summary-freeze v1] 生成中冻结整页：忽略范围变更
    // （本次生成已取区间快照，生成中改范围只会让用户误以为「改了生效」）
    if (this.data.loading) return
    const d = (e && e.detail) || {}""",
))

OPS.append(dict(
    rel=SJS, tag='js onShortcut 守卫',
    guard=r'// [summary-freeze v1] 生成中冻结整页：静默忽略（静默是用户口径',
    old=r"""  onShortcut(e) {
    const fill = e.currentTarget.dataset.fill""",
    new=r"""  onShortcut(e) {
    // [summary-freeze v1] 生成中冻结整页：静默忽略（静默是用户口径：整页无响应，
    // 不再用 toast 提示「你点错了」；chip 压暗 + 遮罩压暗已给出「不可操作」信号）
    if (this.data.loading) return
    const fill = e.currentTarget.dataset.fill""",
))

OPS.append(dict(
    rel=SJS, tag='js onQuickGenerate 静默改判',
    guard=r'// 用户 2026-09-23 拍板：生成中整页点击不反应（静默是口径的一部分）',
    old=r"""    // 生成中给反馈，不静默早退（本项目铁律：任何早退都要有面板）
    if (this.data.loading) {
      wx.showToast({ title: '正在生成，请稍候', icon: 'none' })
      return
    }""",
    new=r"""    // [summary-freeze v1] 生成中整页冻结：静默早退。
    // 前身是 v1.3 的「给反馈、不静默早退」——那条铁律的初衷是防**静默失败**（用户以为操作生效了），
    // 此处不适用：已有一个生成在跑 + 遮罩压暗 + chip 压暗，用户不会误解为「已按新要求生成」。
    // 用户 2026-09-23 拍板：生成中整页点击不反应（静默是口径的一部分）
    if (this.data.loading) return""",
))

OPS.append(dict(
    rel=SJS, tag='js onFrozenTap 空接收器',
    guard=r'onFrozenTap() {},',
    old=r"""  // ===== 生成总结 =====
  onGenerate() {""",
    new=r"""  // [summary-freeze v1] 冻结遮罩的点击/滑动接收器：**故意空实现**。
  // wxml 里它同时挂在 catchtap 与 catchtouchmove 上 —— 事件在遮罩层就被吃掉（catch 不冒泡），
  // 下面的胶囊/输入框/快捷模板/按住说话因此收不到任何触摸。
  // 这里不做任何事，也绝不允许有副作用（B27 盯这条）
  onFrozenTap() {},

  // ===== 生成总结 =====
  onGenerate() {""",
))

# ============================================================
# 四、tools/test_summary_shortcuts.js —— 契约同步
# ============================================================
OPS.append(dict(
    rel=TJS, tag='test 头注释 v1 段',
    guard=r'[summary-freeze v1] 生成中整页冻结（用户 2026-09-23 拍板：该页面其他按钮和元素',
    old=r""" *       就是谎报，还会把它自己的提示顶掉（B20/B21 盯这条）
 * 用户给定六条（逐字，2026-09-22 二次修订后的现行版本）：""",
    new=r""" *       就是谎报，还会把它自己的提示顶掉（B20/B21 盯这条）
 *   [summary-freeze v1] 生成中整页冻结（用户 2026-09-23 拍板：该页面其他按钮和元素
 *     无法点击、点击不反应）：wxml 加 .gen-mask 遮罩（wx:if=loading + catchtap/catchtouchmove），
 *     5 个入口统一 `if (this.data.loading) return`，textarea 加 disabled；遮罩同时把滑动吞掉（生成中禁滚动）。
 *     ⚠️ 遮罩 z-index 必须夹在 range-picker 弹层(201) 与 .voice-modal(1000) 之间（A27 数值夹逼）
 *     ⚠️ onHoldEnd / appendPrompt **故意不设守卫**（已在录音的会话要能松手收尾、识别结果不能丢字）
 *     ⚠️ 本版取代 v1.3 的「生成中点 chip 给 toast 反馈」：整页冻结语义下静默才对（B12 已改判）
 * 用户给定六条（逐字，2026-09-22 二次修订后的现行版本）：""",
))

OPS.append(dict(
    rel=TJS, tag='test 头注释 B 组段',
    guard=r'[summary-freeze v1] 生成中整页冻结：chip/整句/胶囊/输入框/按住说话逐个验明无反应',
    old=r""" *   B 组：智能总结页行为（点 chip 即生成且 prompt=整句 / **不联动时间范围** /
 *        点整句只填入不生成 / 生成中点 chip 有反馈不重复发 /
 *        [v1.3] 两条确认 toast + 早退时不谎报）""",
    new=r""" *   B 组：智能总结页行为（点 chip 即生成且 prompt=整句 / **不联动时间范围** /
 *        点整句只填入不生成 / [v1.3] 两条确认 toast + 早退时不谎报 /
 *        [summary-freeze v1] 生成中整页冻结：chip/整句/胶囊/输入框/按住说话逐个验明无反应，
 *        并反向验证非生成态照常可用 —— 冻结绝不能把页面冻死（B12/B23~B30））""",
))

OPS.append(dict(
    rel=TJS, tag='test 常量 RPWXSS',
    guard=r"const RPWXSS = path.join(base, 'components', 'range-picker', 'range-picker.wxss')",
    old=r"""const SWXSS = path.join(base, 'pages', 'summary', 'summary.wxss')""",
    new=r"""const SWXSS = path.join(base, 'pages', 'summary', 'summary.wxss')
// [summary-freeze v1] 遮罩 z-index 的夹逼基准之一：range-picker 弹层（201）取自组件自身样式
const RPWXSS = path.join(base, 'components', 'range-picker', 'range-picker.wxss')""",
))

OPS.append(dict(
    rel=TJS, tag='test sink voiceStarts',
    guard=r'calls: 0, voiceStarts: [] }',
    old=r"""  const sink = { toasts: [], nav: [], emitted: [], req: null, calls: 0 }""",
    new=r"""  // [summary-freeze v1] voiceStarts 记录 voice.start 调用：断言「生成中不起录 / 非生成态照常起录」
  const sink = { toasts: [], nav: [], emitted: [], req: null, calls: 0, voiceStarts: [] }""",
))

OPS.append(dict(
    rel=TJS, tag='test voice 桩记录式',
    guard=r"start: (...a) => { sink.voiceStarts.push(a) },",
    old=r"""    'voice.js': { onStateChange: () => () => {}, start: () => {}, stop: () => {}, warmup: () => {} },""",
    new=r"""    'voice.js': {
      onStateChange: () => () => {},
      start: (...a) => { sink.voiceStarts.push(a) },
      stop: () => {},
      warmup: () => {}
    },""",
))

OPS.append(dict(
    rel=TJS, tag='test A26~A28 静态',
    guard=r"'A26 冻结遮罩：wxml 遮罩绑 wx:if=loading",
    old=r"""    ok(src.indexOf('近两月没有日记记录，无法分析') !== -1 && src.indexOf('_reviewRange') !== -1 &&
       src.indexOf("ds.chip === '月度复盘'") !== -1,
      'A24 月度复盘固定近两月：review 标志 + 专属无日记提示在源码')
  }""",
    new=r"""    ok(src.indexOf('近两月没有日记记录，无法分析') !== -1 && src.indexOf('_reviewRange') !== -1 &&
       src.indexOf("ds.chip === '月度复盘'") !== -1,
      'A24 月度复盘固定近两月：review 标志 + 专属无日记提示在源码')

    // ---- [summary-freeze v1] 生成中整页冻结（用户 2026-09-23 拍板）----
    const mIdx = wxml.indexOf('class="gen-mask"')
    const mBlock = mIdx < 0 ? '' : wxml.slice(mIdx, mIdx + 260)
    ok(mIdx !== -1 && mBlock.indexOf('wx:if="{{loading}}"') !== -1 &&
       mBlock.indexOf('catchtap="onFrozenTap"') !== -1 &&
       mBlock.indexOf('catchtouchmove="onFrozenTap"') !== -1 &&
       src.indexOf('onFrozenTap() {},') !== -1,
      'A26 冻结遮罩：wxml 遮罩绑 wx:if=loading + catchtap/catchtouchmove，页面有空接收器', mBlock)
    // 层级夹逼（真机口径）：> range-picker 弹层 ⇒ 盖得住胶囊与其弹层；< 语音浮层 ⇒ 松手事件不被吞
    const maskZ = Number((wxss.match(/\.gen-mask\s*\{[^}]*z-index:\s*(\d+)/) || [])[1])
    const modalZ = Number((wxss.match(/\.voice-modal\s*\{[^}]*z-index:\s*(\d+)/) || [])[1])
    const rpZ = Math.max.apply(null, (read(RPWXSS).match(/z-index:\s*(\d+)/g) || ['0'])
      .map((s) => Number(String(s).replace(/\D/g, ''))))
    ok(maskZ > rpZ && maskZ < modalZ,
      'A27 遮罩 z-index 落在「range-picker 弹层 ' + rpZ + '」与「语音浮层 ' + modalZ + '」之间（实测 ' +
      maskZ + '）—— 低了盖不住胶囊，高了录音松手收不了尾', [maskZ, rpZ, modalZ])
    const taIdx = wxml.indexOf('<textarea')
    const taBlock = taIdx < 0 ? '' : wxml.slice(taIdx, wxml.indexOf('/>', taIdx))
    ok(taBlock.indexOf('disabled="{{loading}}"') !== -1,
      'A28 textarea 生成中 disabled（原生组件：遮罩未必压得住，必须有第二道闸）', taBlock)
  }""",
))

OPS.append(dict(
    rel=TJS, tag='test B12 改判静默',
    guard=r"'B12 生成中点 chip → 静默无反应（[summary-freeze v1] 取代 v1.3 的 toast 反馈）'",
    old=r"""      // ---- 生成中点 chip：有反馈、不重复发、不改写已填内容 ----
      const ctx4 = loadSummaryPage()
      ctx4.page.onLoad()
      ctx4.page.setData({ loading: true, prompt: '原需求' })
      ctx4.sink.toasts.length = 0
      tapChip(ctx4.page, '大事速览')
      await tick(10)
      ok(ctx4.sink.toasts.indexOf('正在生成，请稍候') >= 0,
        'B12 生成中点 chip 给明确反馈（本项目铁律：不静默早退）', ctx4.sink.toasts)""",
    new=r"""      // ---- [summary-freeze v1] 生成中点 chip：静默无反应（用户 2026-09-23 拍板） ----
      // v1.3 曾要求「给明确反馈、不静默早退」，本版按用户口径改为静默：整页冻结时不提示「你点错了」
      const ctx4 = loadSummaryPage()
      ctx4.page.onLoad()
      ctx4.page.setData({ loading: true, prompt: '原需求' })
      ctx4.sink.toasts.length = 0
      tapChip(ctx4.page, '大事速览')
      await tick(10)
      ok(ctx4.sink.toasts.length === 0,
        'B12 生成中点 chip → 静默无反应（[summary-freeze v1] 取代 v1.3 的 toast 反馈）', ctx4.sink.toasts)""",
))

OPS.append(dict(
    rel=TJS, tag='test B23~B30 冻结组',
    guard=r"'B23 生成中改时间范围 → 忽略（胶囊状态不动）'",
    old=r"""      ok(String(ctx8.page.data.error).indexOf('暂无日记') >= 0,
        'B21 早退提示仍由 onGenerate 自己给出（没被我们的 toast 顶掉）', ctx8.page.data.error)
    }
  }""",
    new=r"""      ok(String(ctx8.page.data.error).indexOf('暂无日记') >= 0,
        'B21 早退提示仍由 onGenerate 自己给出（没被我们的 toast 顶掉）', ctx8.page.data.error)

      // ---- [summary-freeze v1] 生成中整页冻结：其余入口逐个验明「点了没反应」 ----
      const frz = loadSummaryPage()
      frz.page.onLoad()
      frz.page.setData({ prompt: '原需求', loading: true })
      frz.sink.toasts.length = 0
      // ① 时间范围胶囊：change 被忽略
      frz.page.onRangeChange({ detail: { range: 'month', customStart: '', customEnd: '' } })
      ok(frz.page._rangeState.range === 'all' && frz.page._rangeState.customStart === '' &&
         frz.page._rangeState.customEnd === '',
        'B23 生成中改时间范围 → 忽略（胶囊状态不动）', frz.page._rangeState)
      // ② 输入框：拒绝输入
      frz.page.onPromptInput({ detail: { value: '生成中偷改的文字' } })
      ok(frz.page.data.prompt === '原需求',
        'B24 生成中输入框不接受输入（textarea disabled + 此处兜底）', frz.page.data.prompt)
      // ③ 快捷模板整句行：不覆盖输入、不弹 toast
      frz.page.onShortcut({ currentTarget: { dataset: { fill: '简要提取里程碑事件' } } })
      ok(frz.page.data.prompt === '原需求' && frz.sink.toasts.length === 0,
        'B25 生成中点整句行 → 既不覆盖输入也不提示（整页冻结）',
        [frz.page.data.prompt, frz.sink.toasts])
      // ④ 按住说话：不起录（否则录音浮层会盖住生成中的页面）
      frz.page.onHoldStart()
      ok(frz.sink.voiceStarts.length === 0 && frz.page._isHolding !== true,
        'B26 生成中按住说话 → 不起录', frz.sink.voiceStarts)
      // ⑤ 遮罩的点击/滑动接收器：故意空实现，绝不能有副作用
      // （旧版无此方法：加存在性守卫，保证红灯自检「精准红、不崩套件」）
      if (typeof frz.page.onFrozenTap !== 'function') {
        ok(false, 'B27 onFrozenTap 存在（旧版此处精准红，不崩套件）')
      } else {
        frz.page.onFrozenTap()
        ok(frz.sink.calls === 0 && frz.sink.toasts.length === 0 && frz.page.data.prompt === '原需求',
          'B27 遮罩 catchtap/catchtouchmove 的接收器是空实现（只吞事件）',
          [frz.sink.calls, frz.sink.toasts])
      }

      // ⑥ 反向：非生成态这些入口必须照常可用 —— 冻结别把页面冻死（防守卫写成常真）
      const live = loadSummaryPage()
      live.page.onLoad()
      live.page.setData({ prompt: '原需求' })
      live.page.onShortcut({ currentTarget: { dataset: { fill: '简要提取里程碑事件' } } })
      ok(live.page.data.prompt === '简要提取里程碑事件' &&
         live.sink.toasts.indexOf('已填入输入框，可修改后生成') >= 0,
        'B28 反向：非生成态点整句行照常填入 + 提示', [live.page.data.prompt, live.sink.toasts])
      live.page.onHoldStart()
      ok(live.sink.voiceStarts.length === 1, 'B29 反向：非生成态按住说话照常起录', live.sink.voiceStarts)
      live.page.onRangeChange({ detail: { range: 'month', customStart: '', customEnd: '' } })
      ok(live.page._rangeState.range === 'month',
        'B30 反向：非生成态时间范围变更照常生效', live.page._rangeState)
    }
  }""",
))


# ============================================================
# 执行器
# ============================================================
def read_text(rel):
    p = os.path.join(ROOT, rel)
    raw = open(p, 'rb').read().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    return p, raw.replace('\r\n', '\n'), nl


def write_text(p, text, nl):
    open(p, 'wb').write(text.replace('\n', nl).encode('utf-8'))


def backup_once(rel):
    """幂等备份：目标已存在即早退（防二次 --write 覆盖干净备份）。"""
    src = os.path.join(ROOT, rel)
    dst = os.path.join(BACKUP, rel.replace('\\', '__'))
    if os.path.exists(dst):
        return 'keep'
    os.makedirs(BACKUP, exist_ok=True)
    shutil.copy2(src, dst)
    return 'new'


def run(write=False):
    by_file = {}
    for op in OPS:
        by_file.setdefault(op['rel'], []).append(op)

    total_ok = total_skip = total_fail = 0
    for rel, ops in by_file.items():
        p, text, nl = read_text(rel)
        applied, skipped, failed = [], [], []
        for op in ops:
            if op['guard'] in text:
                skipped.append(op['tag'])
                continue
            n = text.count(op['old'])
            if n != 1:
                failed.append((op['tag'], n))
                continue
            text = text.replace(op['old'], op['new'])
            applied.append(op['tag'])
        print('--- %s' % rel)
        for t in applied:
            print('    OK   %s' % t)
        for t in skipped:
            print('    SKIP %s (guard 已存在)' % t)
        for t, n in failed:
            print('    FAIL %s (锚点命中 %d 次，需恰好 1 次)' % (t, n))
        total_ok += len(applied)
        total_skip += len(skipped)
        total_fail += len(failed)
        if write and applied and not failed:
            print('    backup: %s' % backup_once(rel))
            write_text(p, text, nl)
    print('== %s: applied=%d skipped=%d failed=%d' %
          ('write' if write else 'check', total_ok, total_skip, total_fail))
    return 1 if total_fail else 0


def restore():
    by_file = []
    for op in OPS:
        if op['rel'] not in by_file:
            by_file.append(op['rel'])
    for rel in by_file:
        src = os.path.join(BACKUP, rel.replace('\\', '__'))
        if not os.path.exists(src):
            print('MISS %s（备份不存在）' % rel)
            return 1
        shutil.copy2(src, os.path.join(ROOT, rel))
        print('restored %s' % rel)
    return 0


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--write':
        sys.exit(run(write=True))
    if mode == '--restore':
        sys.exit(restore())
    sys.exit(run(write=False))
