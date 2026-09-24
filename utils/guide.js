/**
 * 新手引导（5 步）：写日记页 2 步 → 侧栏 2 步 → 设置页 1 步
 *
 * 用户 2026-09-18 拍板的三个口径：
 *   - 跨页策略 1.B：第 5 步「主题」在设置页 —— 第 4 步的按钮「去设置」直接 navigateTo 过去，
 *     到设置页后由本模块的内存状态续接（**不落盘半途状态**：冷启动即失效，没看完的下次从头来）
 *   - 触发时机 2.A：只看「是否看过」标记（guideDone_v1）。首启自动播一次，老用户升级也会看一次；
 *     设置页另有「新手引导」入口可随时重看（reset() + reLaunch 到写日记页）
 *   - 遮罩形态 3.A：聚光灯遮罩（`box-shadow: 0 0 0 9999rpx` 挖孔）+ 文案卡
 *
 * 启动前置条件（两页各自判断）：
 *   - 日记本密码：lock.guard() 已拦截（未解锁根本进不来）
 *   - 微信隐私弹窗：privacy-popup 关闭后（bind:close）才启动，绝不两弹窗叠着弹
 *   - 系统定位授权弹框 [privacy-weather-gate v2]：wx.getLocation 首次调用会弹原生授权框，
 *     而它恰在「隐私弹窗关闭」同一刻被触发 ⇒ 引导必须一并等它（判据 = evalStart.locationSettled）。
 *     完整串行：隐私弹窗 → 定位授权弹框 → 新手引导。
 *   - 名词备案弹窗：引导期间不会出现（首启无日记），但写日记页仍加了在途判断
 *
 * 页面契约：目标元素必须带 id（见每步 target），且必须**唯一**。
 *   侧栏的 `.s-menu-item` 有 5 个（档案/智能总结/设置/本地备份/云端备份），
 *   靠类名定位必然撞车 —— 所以这里一律用 id。
 *
 * 文案纪律：统一用「你」不用「您」；说明不出现技术词（云函数 / AES / openid 等）。
 */

const DONE_KEY = 'guideDone_v1'

// 高亮孔外扩：让孔比元素本身略大一圈，视觉上不贴边
const SPOT_PAD = 6
// 文案卡默认宽度（px）：按 375 设计宽度取 300，左右各留 ~37
const CARD_WIDTH = 300
// 卡片与高亮孔的间距、卡片与屏幕边缘的最小间距
const CARD_GAP = 14
const EDGE = 16

/**
 * 步骤表。字段：
 *   id        唯一标识（测试与调试用）
 *   page      'write' | 'setting'（该步所属页面）
 *   target    目标元素 id 选择器（必须唯一）
 *   pre       'sidebar' = 该步展示前必须先打开侧栏（其坐标要等抽屉滑出动画结束才准）
 *   shape     'pill' = 胶囊形高亮孔（圆形两端）| 'rect'
 *   buttonText 主按钮文案
 *   action    'goSetting' = 点主按钮跨页跳到设置页（1.B 的唯一跨页点）
 *   title/desc 文案
 */
const STEPS = [
  {
    id: 'hold-talk',
    page: 'write',
    target: '#guide-hold-talk',
    pre: '',
    shape: 'pill',
    buttonText: '下一步',
    action: '',
    title: '按住说话，就能记下这一刻',
    desc: '按住不放开始说，松手停止，上滑取消。想打字？点上方正文区域即可。'
  },
  {
    id: 'optimize',
    page: 'write',
    target: '#guide-optimize',
    pre: '',
    shape: 'rect',
    buttonText: '下一步',
    action: '',
    title: 'AI 优化，把口语变成顺句',
    desc: '写下内容后它会亮起来。点一下，AI 帮你理通顺、改错字，原意不变。'
  },
  {
    id: 'archive',
    page: 'write',
    target: '#guide-archive',
    pre: 'sidebar',
    shape: 'rect',
    buttonText: '下一步',
    action: '',
    title: '档案，记住你常提到的人和事',
    desc: '日记里解释过的人名、公司、地名，可以一键备案。以后再提到，AI 就认得它。'
  },
  {
    id: 'summary',
    page: 'write',
    target: '#guide-summary',
    pre: 'sidebar',
    shape: 'rect',
    buttonText: '去设置',
    action: 'goSetting',
    title: '智能总结，把一段日子读成一页',
    desc: '你只要说出要求，AI 就会把散落的日记收拢成一份回顾，不用一篇篇翻。'
  },
  {
    id: 'theme',
    page: 'setting',
    target: '#guide-theme',
    pre: '',
    shape: 'rect',
    buttonText: '开始写日记',
    action: '',
    title: '挑一个你看得顺眼的主题',
    desc: '浅色适合白天，深色夜里不刺眼，随时能换回来。'
  }
]

// 跨页跳转目标（第 5 步所在页）
const SETTING_URL = '/pages/setting/setting?guide=1'
// 写日记页路径（重看引导时 reLaunch 回来）
const WRITE_URL = '/pages/write/write'

// 「半途状态」只在内存：冷启动即失效（不落盘 → 不会出现"上次看到第 3 步"的怪异续接）
let active = false
let index = 0

// ===== 存储（无 wx 环境静默降级） =====

function readDone() {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) return !!wx.getStorageSync(DONE_KEY)
  } catch (e) { /* 读取失败按「没看过」处理：宁可多播一次，不要漏播 */ }
  return false
}

function markDone() {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(DONE_KEY, 1)
  } catch (e) { /* 写入失败不阻塞：本次会话已看过，下次还会播一次 */ }
}

function reset() {
  try {
    if (typeof wx !== 'undefined' && wx.removeStorageSync) wx.removeStorageSync(DONE_KEY)
  } catch (e) { /* 忽略 */ }
}

// ===== 状态机（纯逻辑，可单测） =====

/** 是否该自动播放（= 没看过标记） */
function shouldAutoStart() {
  return !readDone()
}

function isActive() {
  return active
}

function total() {
  return STEPS.length
}

function getIndex() {
  return index
}

/** 当前步骤（含 1 起算的序号，供「1 / 5」展示）；未激活一律返回 null（防止页面拿到「幽灵步骤」） */
function getStep() {
  if (!active) return null
  const s = STEPS[index]
  if (!s) return null
  return Object.assign({}, s, { index: index + 1, total: STEPS.length })
}

/**
 * 开始引导
 * @param {Number} from 起始步下标（默认 0）
 */
function start(from) {
  active = true
  index = (typeof from === 'number' && from >= 0 && from < STEPS.length) ? Math.floor(from) : 0
  return getStep()
}

/** 下一步；已是最后一步则返回 null（由调用方决定收尾） */
function next() {
  if (index >= STEPS.length - 1) return null
  index += 1
  return getStep()
}

function prev() {
  if (index <= 0) return null
  index -= 1
  return getStep()
}

/** 走完 / 跳过：写标记并复位（跳过也算看过，不再打扰） */
function finish() {
  active = false
  index = 0
  markDone()
}

/** 中途失效（如返回写日记页时当前步属于设置页）：不写标记 → 下次进入从头播 */
function abort() {
  active = false
  index = 0
}

/** 当前步是否属于某页（跨页续接的判断依据） */
function stepBelongsTo(page) {
  const s = STEPS[index]
  return !!(active && s && s.page === page)
}

/**
 * 首启开播裁决（纯逻辑，可单测）—— 页面把状态全喂进来，这里只回动作。
 *
 * 为什么单独立这个函数（2026-09-18 踩的坑）：
 *   写日记页原先用「隐私弹窗此刻 visible」当让路判据。但 wx.getPrivacySetting 是
 *   **异步**的：onShow 跑 maybeStartGuide() 时回调还没回来，visible 仍是 false，
 *   于是判定「前面没弹层」直接开播；几十毫秒后隐私弹窗才冒出来 → 两个叠着弹。
 *   教训：**异步状态没落地前不能当判据** —— 改用「查询是否有结论」（privacyChecked）
 *   代表「弹窗可能出现」，比「当前是否可见」更早、也更保守。
 *
 * @param {object} s
 *   active          引导是否已在播（guide.isActive()）
 *   belongsHere     在播时当前步是否属于本页（guide.stepBelongsTo(page)）
 *   shouldAuto      是否还没有「已看过」标记（guide.shouldAutoStart()）
 *   privacyChecked  隐私查询是否已有结论（未回来前一律不算数）
 *   privacyVisible  隐私弹窗此刻是否可见
 *   locationSettled [v2] 定位询问是否已出结论（显式 false = 正在询问 ⇒ 让路；不传 = 已结论）
 * @returns {'resume'|'abort'|'wait'|'start'|'none'}
 *   resume 继续播当前步｜abort 中途失效｜wait 让路等隐私弹窗｜start 开播｜none 不动
 */
function evalStart(s) {
  s = s || {}
  if (s.active) return s.belongsHere ? 'resume' : 'abort'
  if (!s.shouldAuto) return 'none'
  // 隐私弹窗是首启两个弹层里的第一个：查询没结论 / 弹窗还开着，都让路
  if (!s.privacyChecked) return 'wait'
  if (s.privacyVisible) return 'wait'
  // [privacy-weather-gate v2] 第三个弹层也要让路：wx.getLocation 触发的**系统定位授权弹框**
  //（原生层，浮在页面之上）。只认显式 false —— 不传（undefined）= 已结论，
  // 老调用点与既有断言（G-3 等）行为逐字不变。
  if (s.locationSettled === false) return 'wait'
  return 'start'
}

// ===== 几何计算（纯函数，可单测） =====

function toNum(v, def) {
  const n = Number(v)
  return isFinite(n) ? n : def
}

/** 高亮孔：目标矩形外扩 SPOT_PAD，pill 形状取高的一半做圆角 */
function padRect(rect, shape) {
  const pad = SPOT_PAD
  const width = toNum(rect.width, 0) + pad * 2
  const height = toNum(rect.height, 0) + pad * 2
  return {
    left: toNum(rect.left, 0) - pad,
    top: toNum(rect.top, 0) - pad,
    width: width,
    height: height,
    radius: shape === 'pill' ? height / 2 : 10
  }
}

/**
 * 文案卡位置：目标在上半屏 → 卡片放下方；在下半屏 → 放上方；
 * 该侧放不下就翻面，两面都放不下则夹在可视区内（绝不出屏）。
 */
function placeCard(spot, viewport, cardWidth, cardHeight) {
  const vp = viewport || {}
  const vh = toNum(vp.height, 667)
  const vw = toNum(vp.width, 375)
  const topLimit = toNum(vp.statusBarHeight, 20) + 12
  const bottomLimit = vh - cardHeight - EDGE
  const below = spot.top + spot.height + CARD_GAP
  const above = spot.top - cardHeight - CARD_GAP
  const centerY = spot.top + spot.height / 2
  let side = centerY > vh / 2 ? 'above' : 'below'
  let top = side === 'above' ? above : below
  if (top < topLimit || top > bottomLimit) {
    const alt = side === 'above' ? below : above
    if (alt >= topLimit && alt <= bottomLimit) {
      top = alt
      side = side === 'above' ? 'below' : 'above'
    } else {
      top = Math.min(Math.max(top, topLimit), bottomLimit)
    }
  }
  let left = (vw - cardWidth) / 2
  if (left < EDGE) left = EDGE
  if (left > vw - cardWidth - EDGE) left = Math.max(EDGE, vw - cardWidth - EDGE)
  return { left: left, top: top, side: side, width: cardWidth }
}

/** 屏幕信息（wx.getWindowInfo 优先，旧基础库回落 getSystemInfoSync） */
function getViewport() {
  try {
    const w = (typeof wx !== 'undefined' && wx.getWindowInfo)
      ? wx.getWindowInfo()
      : ((typeof wx !== 'undefined' && wx.getSystemInfoSync) ? wx.getSystemInfoSync() : null)
    if (w) {
      return {
        width: toNum(w.windowWidth, 375),
        height: toNum(w.windowHeight, 667),
        statusBarHeight: toNum(w.statusBarHeight, 20)
      }
    }
  } catch (e) { /* 取值失败用兜底尺寸 */ }
  return { width: 375, height: 667, statusBarHeight: 20 }
}

/**
 * 由目标矩形算出「高亮孔 + 文案卡」的位置
 * @param {Object|null} rect 目标矩形（拿不到时给 null：只显示居中的卡片，不画孔）
 * @param {String} shape 'pill' | 'rect'
 * @param {Object} opts  { viewport, cardWidth, cardHeight }
 * @return {Object|null} { spot, card, viewport }；visible 才有意义
 */
function buildView(rect, shape, opts) {
  const o = opts || {}
  const vp = o.viewport || getViewport()
  const cardWidth = toNum(o.cardWidth, CARD_WIDTH)
  const cardHeight = toNum(o.cardHeight, 176)
  if (!rect) {
    // 目标拿不到（小屏被压盖 / 元素不存在）：卡片放到偏下位置，仍可完成引导
    const spot = { top: vp.height * 0.66, height: 0 }
    return { spot: null, card: placeCard(spot, vp, cardWidth, cardHeight), viewport: vp }
  }
  const spot = padRect(rect, shape)
  return { spot: spot, card: placeCard(spot, vp, cardWidth, cardHeight), viewport: vp }
}

/**
 * 测量页面里的目标元素（页面实例 + 选择器）
 * boundingClientRect 返回的是**视口坐标**（已含页面滚动影响），
 * 而我们用 position: fixed 的遮罩层，坐标系天然一致 → 直接使用，不要再减 scrollTop。
 */
function measure(page, selector, cb) {
  if (!page || typeof page.createSelectorQuery !== 'function') {
    cb(null)
    return
  }
  try {
    const q = page.createSelectorQuery()
    q.select(selector).boundingClientRect()
    q.exec(function (res) {
      const r = res && res[0]
      if (!r || !r.width || !r.height) { cb(null); return }
      cb({ left: r.left, top: r.top, width: r.width, height: r.height })
    })
  } catch (e) {
    cb(null)
  }
}

module.exports = {
  DONE_KEY,
  STEPS,
  SETTING_URL,
  WRITE_URL,
  SPOT_PAD,
  CARD_WIDTH,
  shouldAutoStart,
  isActive,
  total,
  getIndex,
  getStep,
  start,
  next,
  prev,
  finish,
  abort,
  stepBelongsTo,
  evalStart,
  reset,
  markDone,
  readDone,
  padRect,
  placeCard,
  buildView,
  getViewport,
  measure
}
