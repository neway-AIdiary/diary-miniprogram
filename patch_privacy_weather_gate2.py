# -*- coding: utf-8 -*-
"""
[privacy-weather-gate v2] 首启三弹层串行的最后一环：系统定位授权弹框 ↔ 新手引导（2026-09-24）

现象（真机录屏）：隐私弹窗点「同意并继续」后，**系统定位授权弹框**与新手指引第 1 步同屏。
根因：write.onPrivacyClosed 的 agreed 分支在同一个同步块里做两件事 ——
  ① _locationAllowed=true + loadWeather() → weather.locateWeather() 调 wx.getLocation()
     ⇒ 原生授权弹框当帧弹出（等用户点）
  ② resumeGuide() → maybeStartGuide → startGuide → setTimeout(300) ⇒ 引导遮罩 300ms 后上屏
  ⇒ 定位弹框还在，引导已经画出来 = 同屏。
当年的「弹层串行」只做了两条边（隐私↔定位、隐私↔引导），**定位↔引导这条边从未接**；
而 [privacy-weather-gate v1] 恰把定位放行点挪到「隐私关闭」那一刻，与引导的放行点撞成同一时刻。

用户 2026-09-24 拍板：**方案 1 + 400~500ms 缓冲** ——
  把定位询问纳入引导的让路链，定位有结论后再留一段缓冲（等原生弹框收起动画走完）才放开启引导。

改动（3 源 + 2 测试）：
  A. pages/write/write.js  两个常量（兜底 3000ms / 缓冲 450ms）
  B. pages/write/write.js  onLoad 初始化闸门状态（默认 true = 不拦）
  C. utils/guide.js        evalStart 新增 locationSettled 判据（只认显式 false ⇒ 不传 = 已结论）
  D. utils/guide.js        注释：启动前置条件补第三个弹层
  E. utils/weather.js      locateWeather 支持 onSettle（首次定位调用有结论即回调一次）
  F. pages/write/write.js  refreshWeather 发起定位前关闸（**只在真要发起定位时**，缓存够新不白等）
  G. pages/write/write.js  新增 armLocationGate / onLocationSettled（含兜底 + 缓冲）
  H. pages/write/write.js  maybeStartGuide 把 locationSettled 喂给裁决
  I. tools/test_guide.js   G-19 计数 2→3（新增一个 resumeGuide 调用点）+ G2 段 + 行为场景 7
  J. tools/test_weather_cache.js  E2 容忍新增参数 + C7~C9 锁 onSettle 语义

用法：--check / --write / --restore（全量回滚）/ --restore-src（只回滚源码，留新测试做红灯自检）
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\privacy-weather-gate2-backup-20260924'

WRITE = r'pages\write\write.js'
GUIDE = r'utils\guide.js'
WEATHER = r'utils\weather.js'
T_GUIDE = r'tools\test_guide.js'
T_WCACHE = r'tools\test_weather_cache.js'

# ===== A. write.js：常量 =====================================================
A_OLD = """// 每天媒体限额（防存储爆炸）：图片最多 6 张、视频最多 2 个（含同一天已保存的日记）
const MAX_IMAGES_PER_DAY = 6
const MAX_VIDEOS_PER_DAY = 2
"""
A_NEW = """// 每天媒体限额（防存储爆炸）：图片最多 6 张、视频最多 2 个（含同一天已保存的日记）
const MAX_IMAGES_PER_DAY = 6
const MAX_VIDEOS_PER_DAY = 2

// [privacy-weather-gate v2] 引导的第三个让路对象 = 系统定位授权弹框：
//   兜底：定位回调长时间不来（极端：既不 success 也不 fail）→ 到点放行，绝不让引导永久卡住
const LOCATE_SETTLE_TIMEOUT_MS = 3000
//   缓冲：定位有结论后先停一拍再放引导 —— 原生弹框收起有动画，立刻糊上来观感很差
const GUIDE_AFTER_LOCATE_MS = 450
"""
A_GUARD = "const GUIDE_AFTER_LOCATE_MS = 450"

# ===== B. write.js：onLoad 初始化 ============================================
B_OLD = """    // [privacy-weather-gate v1] 定位放行标记：隐私结论出来且「无需授权/已同意」才允许请求定位
    this._locationAllowed = false
"""
B_NEW = """    // [privacy-weather-gate v1] 定位放行标记：隐私结论出来且「无需授权/已同意」才允许请求定位
    this._locationAllowed = false
    // [privacy-weather-gate v2] 定位询问闸门：true = 已出结论（默认，= 不拦）。
    //   只在**真要发起 wx.getLocation 之前**由 armLocationGate() 置 false（见 refreshWeather）；
    //   缓存够新时 loadWeather 会提前 return、根本不调定位 ⇒ 闸门保持 true，引导不白等。
    this._locationSettled = true
    this._locationTimer = null    // 兜底定时器（定位回调不来时放行）
    this._guideDelayTimer = null  // 结论后的缓冲定时器
"""
B_GUARD = "this._locationSettled = true"

# ===== C. guide.js：evalStart 新增判据 ======================================
C_OLD = """  // 隐私弹窗是首启两个弹层里的第一个：查询没结论 / 弹窗还开着，都让路
  if (!s.privacyChecked) return 'wait'
  if (s.privacyVisible) return 'wait'
  return 'start'
"""
C_NEW = """  // 隐私弹窗是首启两个弹层里的第一个：查询没结论 / 弹窗还开着，都让路
  if (!s.privacyChecked) return 'wait'
  if (s.privacyVisible) return 'wait'
  // [privacy-weather-gate v2] 第三个弹层也要让路：wx.getLocation 触发的**系统定位授权弹框**
  //（原生层，浮在页面之上）。只认显式 false —— 不传（undefined）= 已结论，
  // 老调用点与既有断言（G-3 等）行为逐字不变。
  if (s.locationSettled === false) return 'wait'
  return 'start'
"""
C_GUARD = "if (s.locationSettled === false) return 'wait'"

# ===== D. guide.js：JSDoc 参数 ==============================================
D_OLD = """ *   privacyVisible  隐私弹窗此刻是否可见
 * @returns {'resume'|'abort'|'wait'|'start'|'none'}
"""
D_NEW = """ *   privacyVisible  隐私弹窗此刻是否可见
 *   locationSettled [v2] 定位询问是否已出结论（显式 false = 正在询问 ⇒ 让路；不传 = 已结论）
 * @returns {'resume'|'abort'|'wait'|'start'|'none'}
"""
D_GUARD = "locationSettled [v2] 定位询问是否已出结论"

# ===== D2. guide.js：文件头「启动前置条件」补第三条 ==========================
D2_OLD = " *   - 微信隐私弹窗：privacy-popup 关闭后（bind:close）才启动，绝不两弹窗叠着弹\n"
D2_NEW = (" *   - 微信隐私弹窗：privacy-popup 关闭后（bind:close）才启动，绝不两弹窗叠着弹\n"
          " *   - 系统定位授权弹框 [privacy-weather-gate v2]：wx.getLocation 首次调用会弹原生授权框，\n"
          " *     而它恰在「隐私弹窗关闭」同一刻被触发 ⇒ 引导必须一并等它（判据 = evalStart.locationSettled）。\n"
          " *     完整串行：隐私弹窗 → 定位授权弹框 → 新手引导。\n")
D2_GUARD = "完整串行：隐私弹窗 → 定位授权弹框 → 新手引导。"

# ===== E. weather.js：onSettle 支持 =========================================
E_OLD = """function locateWeather(opts) {
  opts = opts || {}
  const locate = opts.locate || function (cb) {
"""
E_NEW = """function locateWeather(opts) {
  opts = opts || {}
  // [privacy-weather-gate v2] onSettle：**首次**定位调用有结论时回调一次（成功 / 失败 / 空坐标都算），
  // 重试不重复回调。页面靠它判断「系统定位授权弹框已被用户处理完」，再把新手引导放出来
  //（两个弹层不同屏）。回调异常一律吞掉 —— 绝不能因为引导的事影响取天气。
  const onSettle = (typeof opts.onSettle === 'function') ? opts.onSettle : null
  let settled = false
  function markSettled() {
    if (settled) return
    settled = true
    if (onSettle) { try { onSettle() } catch (e) { /* 静默 */ } }
  }
  const locate = opts.locate || function (cb) {
"""
E_GUARD = "const onSettle = (typeof opts.onSettle === 'function') ? opts.onSettle : null"

# ===== F. weather.js：成功分支打结论 ========================================
F_OLD = """      locate({
        success: function (loc) {
          if (!loc || !loc.latitude || !loc.longitude) { resolve(null); return }
"""
F_NEW = """      locate({
        success: function (loc) {
          markSettled()
          if (!loc || !loc.latitude || !loc.longitude) { resolve(null); return }
"""
F_GUARD = "success: function (loc) {\n          markSettled()"

# ===== G. weather.js：失败分支打结论 ========================================
G_OLD = "        fail: function () { resolve(null) }\n"
G_NEW = "        fail: function () { markSettled(); resolve(null) }\n"
G_GUARD = "fail: function () { markSettled(); resolve(null) }"

# ===== H. weather.js：JSDoc =================================================
H_OLD = " * @param {{locate?:function, delays?:number[], timer?:function}} [opts] 可注入依赖（测试用）\n"
H_NEW = " * @param {{locate?:function, delays?:number[], timer?:function, onSettle?:function}} [opts] 可注入依赖（测试用）\n"
H_GUARD = "onSettle?:function}} [opts]"

# ===== I. write.js：refreshWeather 发起定位前关闸 ============================
I_OLD = """  refreshWeather() {
    this._weatherLoading = true
    weather.locateWeather().then((info) => {
"""
I_NEW = """  refreshWeather() {
    this._weatherLoading = true
    // [privacy-weather-gate v2] 真要发起定位了（无缓存 / 缓存不够新）→ 关闸，引导先等；
    //   并借 onSettle 拿「定位询问已出结论」的信号（定位回调是唯一出口）
    this.armLocationGate()
    weather.locateWeather({ onSettle: () => this.onLocationSettled() }).then((info) => {
"""
I_GUARD = "weather.locateWeather({ onSettle: () => this.onLocationSettled() })"

# ===== J. write.js：新增两个方法 ============================================
J_OLD = """  // 指定坐标刷新天气（「添加」面板 → 位置，选完新位置后调用）
  fetchWeather(latitude, longitude) {
"""
J_NEW = """  // ===== [privacy-weather-gate v2] 定位询问闸门（首启三弹层串行的最后一环）=====
  // 背景：wx.getLocation 是隐私接口，首次调用会弹**系统定位授权弹框**（原生层，浮在页面之上）。
  //   它恰在「隐私弹窗关闭」那一刻被 loadWeather 触发，而引导也在同一刻放行 ⇒ 两弹层同屏
  //   （真机录屏 2026-09-24 报障）。修法：定位询问也纳入引导的让路链，严格串行：
  //   隐私弹窗 → 定位授权弹框 → 新手引导。
  /** 关闸：马上要发起定位了，引导先等（同时挂兜底，防止定位回调永不到来）*/
  armLocationGate() {
    this._locationSettled = false
    if (this._locationTimer) clearTimeout(this._locationTimer)
    this._locationTimer = setTimeout(() => this.onLocationSettled(), LOCATE_SETTLE_TIMEOUT_MS)
  },

  /** 定位询问已有结论（成功 / 失败 / 被拒 / 超时都算）→ 缓冲一小段再放引导 */
  onLocationSettled() {
    if (this._locationTimer) { clearTimeout(this._locationTimer); this._locationTimer = null }
    if (this._locationSettled === true) return   // 兜底与真回调抢跑：只放行一次
    this._locationSettled = true
    // 缓冲：原生弹框收起有动画，立刻把引导糊上来观感很差（用户 2026-09-24 拍板 400~500ms）
    if (this._guideDelayTimer) clearTimeout(this._guideDelayTimer)
    this._guideDelayTimer = setTimeout(() => this.resumeGuide(), GUIDE_AFTER_LOCATE_MS)
  },

  // 指定坐标刷新天气（「添加」面板 → 位置，选完新位置后调用）
  fetchWeather(latitude, longitude) {
"""
J_GUARD = "onLocationSettled() {"

# ===== K. write.js：裁决喂入 locationSettled ================================
K_OLD = """      privacyChecked: this._privacyChecked === true,
      privacyVisible: !!(popup && popup.data && popup.data.visible)
    })
"""
K_NEW = """      privacyChecked: this._privacyChecked === true,
      privacyVisible: !!(popup && popup.data && popup.data.visible),
      // [privacy-weather-gate v2] 定位询问没结论前也让路（第三个弹层）；
      // 用 !== false（不给 undefined 当「正在询问」）⇒ 老路径 / 未初始化一律放行
      locationSettled: this._locationSettled !== false
    })
"""
K_GUARD = "locationSettled: this._locationSettled !== false"

# ===== L1. test_guide.js：G-19 计数 2→3 ====================================
L1_OLD = """ok(count(pj, 'this.resumeGuide()') === 2 && pj.indexOf('this.maybeStartGuide()') !== -1,
  'G-19 让路结束（结论回来 / 弹窗关闭）都走 resumeGuide 重新裁决', count(pj, 'this.resumeGuide()'))
"""
L1_NEW = """ok(count(pj, 'this.resumeGuide()') === 3 && pj.indexOf('this.maybeStartGuide()') !== -1,
  'G-19 让路结束（结论回来 / 弹窗关闭 / 定位询问结束）都走 resumeGuide 重新裁决', count(pj, 'this.resumeGuide()'))
"""
L1_GUARD = "'G-19 让路结束（结论回来 / 弹窗关闭 / 定位询问结束）都走 resumeGuide 重新裁决'"

# ===== L2. test_guide.js：新增 G2 段（纯函数 + 静态护栏）===================
L2_OLD = """ok(pj.indexOf('this._privacyTimer = setTimeout(') !== -1 && pj.indexOf('clearTimeout(this._privacyTimer)') !== -1,
  'G-22 查询超时有兜底（极端情况引导不会被永久卡住），且结论一到就撤掉定时器')
"""
L2_NEW = """ok(pj.indexOf('this._privacyTimer = setTimeout(') !== -1 && pj.indexOf('clearTimeout(this._privacyTimer)') !== -1,
  'G-22 查询超时有兜底（极端情况引导不会被永久卡住），且结论一到就撤掉定时器')

/* ===== G2. 第三个弹层：系统定位授权弹框也要让路（[privacy-weather-gate v2]）=====
 * 现象（真机录屏 2026-09-24）：隐私弹窗点「同意并继续」后，定位授权弹框与引导第 1 步同屏。
 * 根因：wx.getLocation 在「隐私弹窗关闭」那一刻被触发（原生弹框当帧弹出），引导也在同一刻放行
 *       —— 当年的两两串行只做了两条边（隐私↔定位、隐私↔引导），定位↔引导这条边从未接。
 * 修法：定位询问纳入让路链 + 结论后 450ms 缓冲（等原生弹框收起动画走完）。 */
console.log('== G2. 定位询问串行 ==')
ok(ev({ active: false, shouldAuto: true, privacyChecked: true, privacyVisible: false, locationSettled: false }) === 'wait',
  'G2-1 定位询问未出结论 → 让路等（本次 bug 的正面修复）')
ok(ev({ active: false, shouldAuto: true, privacyChecked: true, privacyVisible: false, locationSettled: true }) === 'start',
  'G2-2 定位询问已出结论 → 开播（弹框已处理完）')
ok(ev({ active: false, shouldAuto: true, privacyChecked: true, privacyVisible: false }) === 'start',
  'G2-3 不传 locationSettled = 已结论（向后兼容：与上面 G-3 逐字同判）')
ok(ev({ active: false, shouldAuto: true, privacyChecked: false, locationSettled: false }) === 'wait',
  'G2-4 隐私仍在前：两个让路条件同时成立也只回 wait（顺序由页面串起来）')
ok(ev({ active: true, belongsHere: true, locationSettled: false }) === 'resume' &&
  ev({ active: true, belongsHere: false, locationSettled: false }) === 'abort',
  'G2-5 已在播时先判归属（半途失效优先，不被定位闸门挂住）')
const oldLocVerdict = (privacyVisible) => (privacyVisible ? 'wait' : 'start') // 旧判据：只看隐私
ok(oldLocVerdict(false) === 'start' &&
  ev({ active: false, shouldAuto: true, privacyChecked: true, privacyVisible: false, locationSettled: false }) === 'wait',
  'G2-6 红灯自检：同一时刻旧判据开播（→ 与定位弹框同屏）、新判据等待 —— 断言正对准本次 bug')

/* 静态护栏：闸门必须真接线（纯函数好看但没接上 = 白搭） */
ok(pj.indexOf('this._locationSettled = true') !== -1, 'G2-7 写日记页有「定位结论」状态（默认放行）')
ok(pj.indexOf('locationSettled: this._locationSettled !== false') !== -1,
  'G2-8 裁决读它（不把 undefined 当「正在询问」）')
ok(pj.indexOf('this.armLocationGate()') !== -1 && pj.indexOf('armLocationGate() {') !== -1,
  'G2-9 发起定位前关闸（定义 + 调用各一处）')
ok(pj.indexOf('weather.locateWeather({ onSettle: () => this.onLocationSettled() })') !== -1,
  'G2-10 定位结论经 onSettle 回页（weather.js 提供的唯一出口）')
const wgSrc = read(path.join(base, 'utils', 'weather.js'))
ok(wgSrc.indexOf('opts.onSettle') !== -1 && count(wgSrc, 'markSettled()') >= 3,
  'G2-11 weather.locateWeather 支持 onSettle，成功 / 失败 / 空坐标三条路都算结论',
  count(wgSrc, 'markSettled()'))
ok(pj.indexOf('this._locationTimer = setTimeout(() => this.onLocationSettled(), LOCATE_SETTLE_TIMEOUT_MS)') !== -1,
  'G2-12 定位回调超时有兜底（极端情况引导不会被永久卡住）')
const mBuf = /const GUIDE_AFTER_LOCATE_MS = (\\d+)/.exec(pj)
ok(!!mBuf && Number(mBuf[1]) >= 400 && Number(mBuf[1]) <= 500,
  'G2-13 结论后的缓冲落在 400~500ms（用户拍板口径）', mBuf && mBuf[1])
ok(pj.indexOf('privacyVisible: !!(popup && popup.data && popup.data.visible),') !== -1,
  'G2-14 locationSettled 与既有判据并列（不是替换掉隐私判据）')
"""
L2_GUARD = "'G2-1 定位询问未出结论 → 让路等（本次 bug 的正面修复）'"

# ===== M1. test_guide.js：缓冲等待工具 ======================================
M1_OLD = "const flush = () => new Promise((r) => setTimeout(r, 0))\n"
M1_NEW = ("const flush = () => new Promise((r) => setTimeout(r, 0))\n"
          "// [privacy-weather-gate v2] 等「定位结论 + 缓冲」走完（GUIDE_AFTER_LOCATE_MS = 450）\n"
          "const wait = (ms) => new Promise((r) => setTimeout(r, ms))\n")
M1_GUARD = "const wait = (ms) => new Promise((r) => setTimeout(r, ms))"

# ===== M2. test_guide.js：场景 2 断言改为「缓冲后开播」======================
M2_OLD = "    ok(g.isActive() === true, 'I-12 无需授权时引导直接开播（不等一个永远不会来的弹窗）')\n"
M2_NEW = ("    // [privacy-weather-gate v2] 定位询问也要走一遍「有结论 + 缓冲」：桩里 getLocation 同步失败\n"
          "    // ⇒ 结论立刻落地，但引导要等缓冲（450ms）走完才开播\n"
          "    ok(ctx.page._locationSettled === true, 'I-12a 定位询问已出结论（桩：同步失败）')\n"
          "    ok(g.isActive() === false, 'I-12b 缓冲期内还没开播（等原生弹框收起）')\n"
          "    await wait(600)\n"
          "    ok(g.isActive() === true, 'I-12c 缓冲走完 → 开播（不等一个永远不会来的弹窗）')\n")
M2_GUARD = "'I-12a 定位询问已出结论（桩：同步失败）'"

# ===== M3. test_guide.js：场景 4 同理 ======================================
M3_OLD = "    ok(g.isActive() === true, 'I-15 取不到隐私组件 → 按「无需授权」放行（引导不会被永久卡住）')\n"
M3_NEW = ("    ok(ctx.page._locationSettled === true, 'I-15a 定位询问已出结论（进了同一条闸门）')\n"
          "    await wait(600)\n"
          "    ok(g.isActive() === true, 'I-15b 取不到隐私组件 → 按「无需授权」放行（引导不会被永久卡住）')\n")
M3_GUARD = "'I-15a 定位询问已出结论（进了同一条闸门）'"

# ===== M4. test_guide.js：新增场景 7（本次报障的原样复现）==================
M4_OLD = """      if (resolvePrivacy) resolvePrivacy(true) // 收尾：别留悬挂 Promise
    }
  }

  console.log('\\n[test_guide] ' + pass + ' passed, ' + fail + ' failed')
"""
M4_NEW = """      if (resolvePrivacy) resolvePrivacy(true) // 收尾：别留悬挂 Promise
    }
  }

  /* 场景 7：★ 本次报障的原样复现 —— 点「同意并继续」后，定位弹框与引导绝不同屏（v2 修复） */
  {
    const ctx = mkCtx()
    const g = ctx.guide
    g.abort()
    delete ctx.store[g.DONE_KEY]
    let resolvePrivacy = null
    const comp = { data: { visible: false }, tryShow: () => new Promise((r) => { resolvePrivacy = r }) }
    ctx.page.selectComponent = () => comp
    boot(ctx)
    comp.data.visible = true
    resolvePrivacy(true)
    await flush()
    ok(g.isActive() === false, 'I-21 隐私弹窗显示中：引导仍在让路')
    comp.data.visible = false
    ctx.page.onPrivacyClosed({ detail: { agreed: true } }) // 用户点「同意并继续」
    await flush()
    ok(ctx.page._locationSettled === true, 'I-22a 定位询问已出结论（桩：同步失败）')
    ok(g.isActive() === false, 'I-22b ★ 定位弹框被处理完之前，引导绝不开播（不再同屏）')
    await wait(600)
    ok(g.isActive() === true, 'I-23 定位结论 + 缓冲之后才开播（严格串行：隐私 → 定位 → 引导）')
  }

  console.log('\\n[test_guide] ' + pass + ' passed, ' + fail + ' failed')
"""
M4_GUARD = "'I-22b ★ 定位弹框被处理完之前，引导绝不开播（不再同屏）'"

# ===== N1. test_weather_cache.js：E2 容忍新增参数 ==========================
N1_OLD = """  ok(seg.indexOf('weather.locateWeather()') > seg.indexOf('weather.readCache()'),
    'E2 缓存展示在网络请求之前（先秒显、再刷新）')
"""
N1_NEW = """  // [privacy-weather-gate v2] locateWeather 现在带 onSettle 回调（定位结论出口），调用形式变了
  // ⇒ 断言改为容忍参数，判的还是同一件事：网络请求发生在缓存展示之后
  ok(seg.search(/weather\\.locateWeather\\(/) > -1 &&
    seg.search(/weather\\.locateWeather\\(/) > seg.indexOf('weather.readCache()'),
    'E2 缓存展示在网络请求之前（先秒显、再刷新）')
"""
N1_GUARD = "seg.search(/weather\\.locateWeather\\(/) > -1"

# ===== N2. test_weather_cache.js：C7~C9 锁 onSettle 语义 ===================
N2_OLD = """  ok(info === null && ctl.locateCalls === 3,
    'C6 全失败共 3 次尝试（1 + RETRY_DELAYS.length）', ctl.locateCalls)
"""
N2_NEW = """  ok(info === null && ctl.locateCalls === 3,
    'C6 全失败共 3 次尝试（1 + RETRY_DELAYS.length）', ctl.locateCalls)

  /* C7~C9 [privacy-weather-gate v2] onSettle：定位结论出口（引导靠它放行） */
  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = true; ctl.requestOk = false
  let settleCount = 0
  info = await locateWeather({
    locate: makeLocate([false, true]), timer: immTimer, onSettle: () => { settleCount++ }
  })
  ok(settleCount === 1, 'C7 首次失败又重试成功 → onSettle 只回调一次（引导只放行一次）', settleCount)

  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = true; ctl.requestOk = false
  settleCount = 0
  info = await locateWeather({
    locate: makeLocate([true]), timer: immTimer, onSettle: () => { settleCount++ }
  })
  ok(settleCount === 1, 'C8 定位成功 → onSettle 回调一次', settleCount)

  resetStore(); ctl.locateCalls = 0
  settleCount = 0
  info = await locateWeather({
    locate: () => { throw new Error('boom') }, timer: immTimer, onSettle: () => { settleCount++ }
  })
  ok(settleCount === 0 && info === null,
    'C9 定位调用直接抛（回调都没走）→ 不回调，由页面兜底超时放行', settleCount)

  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = true; ctl.requestOk = false
  settleCount = 0
  info = await locateWeather({
    locate: makeLocate([true]), timer: immTimer,
    onSettle: () => { throw new Error('caller boom') }
  })
  ok(info && info.icon === '☀️' && settleCount === 0,
    'C10 onSettle 回调自己抛异常 → 被吞掉，取天气照常完成（引导的事绝不拖累天气）')
"""
N2_GUARD = "'C7 首次失败又重试成功 → onSettle 只回调一次（引导只放行一次）'"

OPS = [
    (WRITE, A_OLD, A_NEW, A_GUARD, 1),
    (WRITE, B_OLD, B_NEW, B_GUARD, 1),
    (GUIDE, C_OLD, C_NEW, C_GUARD, 1),
    (GUIDE, D_OLD, D_NEW, D_GUARD, 1),
    (GUIDE, D2_OLD, D2_NEW, D2_GUARD, 1),
    (WEATHER, E_OLD, E_NEW, E_GUARD, 1),
    (WEATHER, F_OLD, F_NEW, F_GUARD, 1),
    (WEATHER, G_OLD, G_NEW, G_GUARD, 1),
    (WEATHER, H_OLD, H_NEW, H_GUARD, 1),
    (WRITE, I_OLD, I_NEW, I_GUARD, 1),
    (WRITE, J_OLD, J_NEW, J_GUARD, 1),
    (WRITE, K_OLD, K_NEW, K_GUARD, 1),
    (T_GUIDE, L1_OLD, L1_NEW, L1_GUARD, 1),
    (T_GUIDE, L2_OLD, L2_NEW, L2_GUARD, 1),
    (T_GUIDE, M1_OLD, M1_NEW, M1_GUARD, 1),
    (T_GUIDE, M2_OLD, M2_NEW, M2_GUARD, 1),
    (T_GUIDE, M3_OLD, M3_NEW, M3_GUARD, 1),
    (T_GUIDE, M4_OLD, M4_NEW, M4_GUARD, 1),
    (T_WCACHE, N1_OLD, N1_NEW, N1_GUARD, 1),
    (T_WCACHE, N2_OLD, N2_NEW, N2_GUARD, 1),
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
        print('usage: patch_privacy_weather_gate2.py --check|--write|--restore|--restore-src')
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
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
