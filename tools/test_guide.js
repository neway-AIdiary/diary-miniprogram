/**
 * 新手引导回归（utils/guide.js + guide-mask 组件 + 两个页面的接线）
 *
 * 覆盖：
 *   1) 步骤表：5 步、顺序、目标 id 唯一、侧栏前置、跨页标记、文案逐字
 *   2) 文案纪律：不用「您」、不出现技术词、长度上限（引导卡不能写成长文）
 *   3) 状态机：autoStart / start / next / prev / finish / abort / stepBelongsTo
 *      + 存储桩：看过标记的写入与读取、reset 重看、存储异常容错
 *   4) 几何（纯函数）：padRect / placeCard 翻面与夹取 / buildView 空矩形兜底
 *   5) 接线护栏：5 个目标 id 落在正确文件、组件注册、跨页跳转、隐私弹窗串行、
 *      侧栏动画等待、遮罩 z-index 与拦截层
 *   6) 首启弹层串行（G）：隐私弹窗与引导的先后裁决 —— 含 2026-09-18「两个叠着弹」
 *      的根因回归（查询未返回的窗口期必须让路，不能拿「此刻 visible」当判据）
 *   7) 红灯自检：对改动前的备份文件跑同一批护栏，必须不通过（证明断言有区分度）
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const BK = 'C:\\Users\\ThinkPad\\WorkBuddy\\guide-backup-20260918'

let pass = 0
let fail = 0
const failures = []

function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    failures.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
  }
}
function count(s, sub) { return String(s).split(sub).length - 1 }

function read(p) { return fs.readFileSync(p, 'utf8') }
function exists(p) { try { return fs.statSync(p).isFile() } catch (e) { return false } }

const guide = require(path.join(base, 'utils', 'guide.js'))

const PJ = path.join(base, 'pages', 'write', 'write.js')
const PW = path.join(base, 'pages', 'write', 'write.wxml')
const PJSON = path.join(base, 'pages', 'write', 'write.json')
const SJ = path.join(base, 'pages', 'setting', 'setting.js')
const SW = path.join(base, 'pages', 'setting', 'setting.wxml')
const SJSON = path.join(base, 'pages', 'setting', 'setting.json')
const CJ = path.join(base, 'components', 'guide-mask', 'guide-mask.js')
const CW = path.join(base, 'components', 'guide-mask', 'guide-mask.wxml')
const CS = path.join(base, 'components', 'guide-mask', 'guide-mask.wxss')
const PP = path.join(base, 'components', 'privacy-popup', 'privacy-popup.js')

/* ============ 1. 步骤表 ============ */
console.log('== A. 步骤表 ==')
const ids = guide.STEPS.map(s => s.id)
const targets = guide.STEPS.map(s => s.target)
ok(guide.STEPS.length === 5, 'A-1 共 5 步（用户定稿：心情胶囊已去掉）', guide.STEPS.length)
ok(ids.join(',') === 'hold-talk,optimize,archive,summary,theme', 'A-2 顺序 = 用户指定顺序', ids.join(','))
ok(new Set(targets).size === 5, 'A-3 5 个目标选择器各不相同', targets)
ok(targets.every(t => t.indexOf('#guide-') === 0), 'A-4 目标一律用 id（不用类名：侧栏 .s-menu-item 有 5 个会撞车）', targets)
ok(guide.STEPS[0].pre === '' && guide.STEPS[1].pre === '', 'A-5 前两步不需要前置动作（页面默认状态即可）')
ok(guide.STEPS[2].pre === 'sidebar' && guide.STEPS[3].pre === 'sidebar', 'A-6 第 3、4 步在侧栏内 → 必须先开侧栏')
ok(guide.STEPS[0].shape === 'pill', 'A-7 第 1 步（按住说话）用胶囊形高亮孔')
ok(guide.STEPS[3].action === 'goSetting', 'A-8 第 4 步是唯一的跨页点（去设置）', guide.STEPS[3].action)
ok(guide.STEPS[4].page === 'setting' && guide.STEPS.slice(0, 4).every(s => s.page === 'write'),
  'A-9 只有第 5 步属于设置页')
ok(guide.SETTING_URL.indexOf('/pages/setting/setting') !== -1, 'A-10 跨页目标 = 设置页', guide.SETTING_URL)
ok(guide.WRITE_URL === '/pages/write/write', 'A-11 重看引导的回落页 = 写日记页', guide.WRITE_URL)
ok(guide.STEPS[4].buttonText === '开始写日记', 'A-12 最后一步按钮 = 开始写日记', guide.STEPS[4].buttonText)

/* ============ 2. 文案逐字 + 纪律 ============ */
console.log('== B. 文案 ==')
const EXPECT = [
  ['hold-talk', '按住说话，就能记下这一刻',
    '按住不放开始说，松手停止，上滑取消。想打字？点上方正文区域即可。'],
  ['optimize', 'AI 优化，把口语变成顺句',
    '写下内容后它会亮起来。点一下，AI 帮你理通顺、改错字，原意不变。'],
  ['archive', '档案，记住你常提到的人和事',
    '日记里解释过的人名、公司、地名，可以一键备案。以后再提到，AI 就认得它。'],
  ['summary', '智能总结，把一段日子读成一页',
    '你只要说出要求，AI 就会把散落的日记收拢成一份回顾，不用一篇篇翻。'],
  ['theme', '挑一个你看得顺眼的主题',
    '浅色适合白天，深色夜里不刺眼，随时能换回来。']
]
EXPECT.forEach((e, i) => {
  const s = guide.STEPS[i]
  ok(s.id === e[0], 'B-' + (i + 1) + 'a 第 ' + (i + 1) + ' 步 id 未变', s.id)
  ok(s.title === e[1], 'B-' + (i + 1) + 'b 标题逐字一致', s.title)
  ok(s.desc === e[2], 'B-' + (i + 1) + 'c 说明逐字一致（用户 15:47 定稿）', s.desc)
})
const allCopy = guide.STEPS.map(s => s.title + '|' + s.desc).join('\n')
ok(allCopy.indexOf('您') === -1, 'B-6 全篇用「你」不用「您」（与全站文案一致）')
const TECH = ['AES', 'openid', '云函数', 'API', 'pbkdf2', 'token']
ok(TECH.every(t => allCopy.toLowerCase().indexOf(t.toLowerCase()) === -1),
  'B-7 不出现技术词（用户只关心结果，不关心实现）', TECH.filter(t => allCopy.toLowerCase().indexOf(t.toLowerCase()) !== -1))
ok(guide.STEPS.every(s => s.title.length <= 16), 'B-8 标题不超过 16 字（一行放得下）',
  guide.STEPS.map(s => s.title.length))
ok(guide.STEPS.every(s => s.desc.length <= 42), 'B-9 说明不超过 42 字（最多两行）',
  guide.STEPS.map(s => s.desc.length))
ok(guide.STEPS.filter(s => s.buttonText === '跳过').length === 0, 'B-10 跳过是固定配件（写在组件里），不进步骤表')

/* ============ 3. 状态机 ============ */
console.log('== C. 状态机 ==')
guide.abort()
const saveWx = global.wx
delete global.wx

ok(guide.shouldAutoStart() === true, 'C-1 无 wx 环境：按「没看过」处理（宁可多播一次，不要漏播）')
ok(guide.isActive() === false, 'C-2 初始未激活')
const s1 = guide.start()
ok(guide.isActive() === true && s1.id === 'hold-talk', 'C-3 start() 从第 1 步开始', s1 && s1.id)
ok(s1.index === 1 && s1.total === 5, 'C-4 步骤序号 1 / 5（给「1 / 5」用）', [s1.index, s1.total])
const s2 = guide.next()
ok(s2.id === 'optimize' && s2.index === 2, 'C-5 next 推进到第 2 步', s2 && s2.id)
guide.next(); guide.next()
const s5 = guide.next()
ok(s5.id === 'theme' && s5.index === 5 && s5.total === 5, 'C-6 推进到第 5 步', s5 && s5.id)
ok(guide.next() === null, 'C-7 最后一步 next() 返回 null（由页面决定收尾）')
ok(guide.getIndex() === 4, 'C-8 最后一步后下标仍停在第 5 步（不能被 next 越界）', guide.getIndex())
const back = guide.prev()
ok(back.id === 'summary', 'C-9 prev 回退到第 4 步', back && back.id)
ok(guide.stepBelongsTo('write') === true, 'C-10 当前步属于写日记页')
ok(guide.stepBelongsTo('setting') === false, 'C-11 当前步不属于设置页')
guide.finish()
ok(guide.isActive() === false && guide.getIndex() === 0, 'C-12 finish 复位')
guide.start(4)
ok(guide.stepBelongsTo('setting') === true, 'C-13 指定起始步（重看/续接用）生效')
guide.abort()
ok(guide.stepBelongsTo('write') === false, 'C-14 abort 后一切复位')
ok(guide.getStep() === null, 'C-15 未激活时 getStep() 不发散值')

/* 存储桩：看过标记 */
const store = {}
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] }
}
ok(guide.shouldAutoStart() === true, 'C-16 有 wx 且无标记 → 自动播')
guide.start()
guide.finish()
ok(guide.shouldAutoStart() === false, 'C-17 finish 写了「已看过」标记 → 不再自动播', store)
ok(store[guide.DONE_KEY] === 1, 'C-18 标记键名 = guideDone_v1', Object.keys(store))
ok(guide.readDone() === true, 'C-19 readDone() 读得到')
guide.reset()
ok(guide.shouldAutoStart() === true, 'C-20 reset 后恢复自动播（设置页「新手引导」重看入口靠它）')
guide.start()
guide.abort()
ok(guide.shouldAutoStart() === true, 'C-21 abort 不写标记 → 中途失效的下次从头播（不消耗引导）')

/* 存储异常容错 */
global.wx = {
  getStorageSync: () => { throw new Error('boom') },
  setStorageSync: () => { throw new Error('boom') },
  removeStorageSync: () => { throw new Error('boom') }
}
let threw = false
try {
  guide.shouldAutoStart(); guide.start(); guide.finish(); guide.reset(); guide.readDone()
} catch (e) { threw = true }
ok(!threw, 'C-22 存储整体异常时不抛（引导失败绝不能连累页面）')
global.wx = saveWx
if (saveWx === undefined) delete global.wx

/* ============ 4. 几何 ============ */
console.log('== D. 几何 ==')
const spot = guide.padRect({ left: 100, top: 500, width: 200, height: 44 }, 'pill')
ok(spot.left === 94 && spot.top === 494, 'D-1 高亮孔外扩 6px（不贴元素边缘）', [spot.left, spot.top])
ok(spot.width === 212 && spot.height === 56, 'D-2 孔尺寸 = 元素 + 12', [spot.width, spot.height])
ok(spot.radius === 28, 'D-3 胶囊孔圆角 = 高度一半', spot.radius)
ok(guide.padRect({ left: 0, top: 0, width: 10, height: 10 }, 'rect').radius === 10, 'D-4 矩形孔圆角 = 10')

const vp = { width: 375, height: 667, statusBarHeight: 20 }
const low = guide.placeCard({ top: 560, height: 60, left: 60, width: 200 }, vp, 300, 150)
ok(low.side === 'above', 'D-5 目标在下半屏 → 卡片放到上方（不挡住被讲解的东西）', low.side)
const high = guide.placeCard({ top: 120, height: 60, left: 60, width: 200 }, vp, 300, 150)
ok(high.side === 'below', 'D-6 目标在上半屏 → 卡片放到下方', high.side)
ok(high.left === 37.5, 'D-7 卡片水平居中（375 - 300)/2', high.left)
const tiny = guide.placeCard({ top: 4, height: 0, left: 0, width: 0 }, { width: 375, height: 667, statusBarHeight: 20 }, 300, 150)
ok(tiny.top >= 32, 'D-8 上方放不下时不会顶出屏幕（下限 = 状态栏 + 12）', tiny.top)
const huge = guide.placeCard({ top: 640, height: 20, left: 0, width: 0 }, vp, 300, 150)
ok(huge.top + 150 <= 667 - 16 + 0.01, 'D-9 下方放不下时会夹回可视区', huge.top)
const narrow = guide.placeCard({ top: 100, height: 20, left: 0, width: 0 }, { width: 320, height: 667, statusBarHeight: 20 }, 300, 150)
ok(narrow.left === 16, 'D-10 窄屏（320）时卡片左边距不小于 16，且不越右边界', narrow.left)

const v1 = guide.buildView({ left: 100, top: 500, width: 200, height: 44 }, 'pill', { viewport: vp, cardHeight: 150 })
ok(!!v1.spot && v1.card.top === v1.card.top, 'D-11 有矩形时同时给出孔与卡片')
ok(v1.spot.top === 494 && v1.card.side === 'above', 'D-12 孔按目标算、卡片避让目标')
const v2 = guide.buildView(null, 'rect', { viewport: vp, cardHeight: 150 })
ok(v2.spot === null, 'D-13 量不到目标时不画孔（只显示卡片，引导照样能走完）', v2.spot)
ok(!!v2.card && v2.card.top < vp.height, 'D-14 无孔时卡片仍落在屏内')
const v3 = guide.buildView({ left: 1, top: 2, width: 3, height: 4 }, 'rect', { viewport: vp })
ok(!v3.viewport || v3.card.width === guide.CARD_WIDTH, 'D-15 不传视口/卡片尺寸时有默认值', v3.card)

/* measure：拿不到页面实例时静默回调 null，不抛 */
let measured = 'unset'
let mThrew = false
try { guide.measure(null, '#guide-x', (r) => { measured = r }) } catch (e) { mThrew = true }
ok(!mThrew && measured === null, 'D-16 measure 无页面实例时安全回调 null')

/* ============ 5. 接线护栏 ============ */
console.log('== E. 接线 ==')
const pj = read(PJ); const pw = read(PW); const pjson = read(PJSON)
const sj = read(SJ); const sw = read(SW); const sjson = read(SJSON)
const cj = read(CJ); const cw = read(CW); const cs = read(CS); const pp = read(PP)

ok(count(pw, 'id="guide-hold-talk"') === 1, 'E-1 写日记页：按住说话有且只有一个锚点', count(pw, 'id="guide-hold-talk"'))
ok(count(pw, 'id="guide-optimize"') === 1, 'E-2 写日记页：AI 优化锚点唯一', count(pw, 'id="guide-optimize"'))
ok(count(pw, 'id="guide-archive"') === 1, 'E-3 写日记页：侧栏档案锚点唯一', count(pw, 'id="guide-archive"'))
ok(count(pw, 'id="guide-summary"') === 1, 'E-4 写日记页：侧栏智能总结锚点唯一', count(pw, 'id="guide-summary"'))
ok(count(sw, 'id="guide-theme"') === 1, 'E-5 设置页：主题行锚点唯一', count(sw, 'id="guide-theme"'))
ok(count(pw, '<guide-mask') === 1 && count(sw, '<guide-mask') === 1, 'E-6 两页各挂一个引导组件')
ok(pjson.indexOf('guide-mask') !== -1 && sjson.indexOf('guide-mask') !== -1, 'E-7 两页 json 都注册了组件')
ok(count(pj, "require('../../utils/guide.js')") === 1, 'E-8 写日记页只 require 一次 guide', count(pj, "require('../../utils/guide.js')"))
ok(pj.indexOf('this.maybeStartGuide()') !== -1, 'E-9 onShow 里有启动入口')
ok(pj.indexOf('popup.data.visible') !== -1, 'E-10 启动前检查隐私弹窗是否还开着（两弹层不叠着弹）')
ok(pw.indexOf('bind:close="onPrivacyClosed"') !== -1 && pj.indexOf('onPrivacyClosed(e)') !== -1,
  'E-11 隐私弹窗关闭后回调接上引导（串行，不抢弹；[privacy-weather-gate v1] 起收 event 参数）')
ok(count(pp, "triggerEvent('close'") === 2, 'E-12 隐私弹窗「同意」「不同意」都通知关闭（[privacy-weather-gate v1] 起带 { agreed } 标记）', count(pp, "triggerEvent('close'"))
ok(count(pp, "{ agreed: true }") === 1 && count(pp, "{ agreed: false }") === 1,
  'E-12b [privacy-weather-gate v1] close 事件区分同意/不同意（页面据此决定是否补拉定位）')
ok(pj.indexOf("step.pre === 'sidebar'") !== -1, 'E-13 侧栏步骤先开侧栏')
ok(pj.indexOf('showSidebar: true') !== -1 && pj.indexOf('}, () => {') !== -1,
  'E-14 开侧栏后等 setData 回调再计时（抽屉是 transform 过渡，不等动画会量到屏外坐标）')
ok(count(pj, '360') >= 1, 'E-15 侧栏动画等待时长 360ms（> 过渡 300ms）')
ok(count(pj, '300') >= 1, 'E-16 首屏渲染后延迟再量（onShow 立刻量会拿到 0 尺寸）')
ok(pj.indexOf("step.action === 'goSetting'") !== -1, 'E-17 第 4 步按钮触发跨页')
ok(pj.indexOf('wx.navigateTo({ url: guide.SETTING_URL })') !== -1, 'E-18 跨页用 guide.SETTING_URL（单一来源）')
ok(count(pj, 'guide.next()') >= 2, 'E-19 跨页前先推进到第 5 步（到设置页才有步可接）', count(pj, 'guide.next()'))
ok(pj.indexOf('guide.finish()') !== -1, 'E-20 走完/跳过写「已看过」标记')
ok(pj.indexOf('guide.abort()') !== -1, 'E-21 半途失效走 abort（不写标记 → 下次从头播）')
ok(pj.indexOf("guide.stepBelongsTo('write')") !== -1, 'E-22 返回写日记页时判定当前步归属')
ok(sj.indexOf("guide.stepBelongsTo('setting')") !== -1, 'E-23 设置页按归属续接第 5 步')
ok(count(sj, 'guide.finish()') === 1, 'E-24 设置页收尾只写一次标记', count(sj, 'guide.finish()'))
ok(sj.indexOf('restartGuide()') !== -1 && sw.indexOf('bindtap="restartGuide"') !== -1,
  'E-25 设置页有「新手引导」重看入口')
ok(sj.indexOf('guide.reset()') !== -1 && sj.indexOf('wx.reLaunch({ url: guide.WRITE_URL })') !== -1,
  'E-26 重看 = 清标记 + 回写日记页（由那页自动开播）')
ok(sw.indexOf('新手引导') !== -1, 'E-27 重看入口文案 = 新手引导')
ok(['onToggleTheme', 'goToFontSetting', 'goToReminder', 'goToLock', 'goToAbout']
  .every(h => sw.indexOf('bindtap="' + h + '"') !== -1),
  'E-28 新增入口未破坏原有菜单（主题/日记字体/闹钟/日记本密码/关于 都还在）')
ok(sj.indexOf('getCurrentPages().length > 1') !== -1 && sj.indexOf('wx.navigateBack({ delta: 1 })') !== -1,
  'E-29 第 5 步走完回写日记页（「开始写日记」名副其实），且栈内只有本页时不回退')
ok(sj.indexOf('this.endGuide(true)') !== -1 && sj.indexOf('this.endGuide(false)') !== -1,
  'E-30 走完（回写日记页）与跳过（留在本页）行为分开')

/* 组件自身 */
ok(cs.indexOf('z-index: 150') !== -1, 'E-29 引导层 z-index = 150（> 侧栏 101、< 任务态弹层 1000）', 'z-index: 150')
ok(cs.indexOf('0 0 0 9999rpx') !== -1, 'E-30 聚光灯用超大小阴影反向挖孔')
ok(cs.indexOf('transition') !== -1, 'E-31 步骤间移动有过渡（孔位平滑滑动，不是瞬移）')
ok(cw.indexOf('catchtap="noop"') !== -1 && cw.indexOf('catchtouchmove="noop"') !== -1,
  'E-32 拦截层用 catch 绑定吃掉触摸（引导期间不误触页面）')
ok(cw.indexOf('gm-skip') !== -1, 'E-33 每步都有「跳过」')
ok(cw.indexOf("{{step.index}} / {{step.total}}") !== -1, 'E-34 显示「N / 5」进度')
ok(cj.indexOf('guide.buildView') !== -1, 'E-35 组件复用纯函数算位置（不在组件里重写几何逻辑）')
ok(cj.indexOf("triggerEvent('next')") !== -1 && cj.indexOf("triggerEvent('skip')") !== -1,
  'E-36 交互事件抛回页面（组件不自己跳页、不碰存储）')
ok(cj.indexOf('require(') !== -1 && cj.indexOf('wx.getStorageSync') === -1,
  'E-37 组件不读存储（状态归属 utils/guide.js，避免双份真相）')
ok(cw.indexOf('wx:if="{{visible}}"') !== -1 && cw.indexOf('wx:if="{{view.spot}}"') === -1,
  'E-38 组件用 view 判空（无孔时不画孔、卡片照显示）')
ok(cs.indexOf('var(--surface)') !== -1 && cs.indexOf('var(--ink)') !== -1,
  'E-39 卡片颜色走主题令牌（深浅色自动适配）')

/* 目标 id 与步骤表一一对应：步骤表里每个 target 都能在对应页面找到（防两文件脱节） */
const writeTargets = guide.STEPS.filter(s => s.page === 'write').map(s => s.target)
const settingTargets = guide.STEPS.filter(s => s.page === 'setting').map(s => s.target)
ok(writeTargets.every(t => pw.indexOf('id="' + t.slice(1) + '"') !== -1),
  'E-40 步骤表里写日记页的 target 全都能在 write.wxml 找到', writeTargets)
ok(settingTargets.every(t => sw.indexOf('id="' + t.slice(1) + '"') !== -1),
  'E-41 步骤表里设置页的 target 能在 setting.wxml 找到', settingTargets)

/* ===== 首启弹层串行：隐私弹窗在前、引导在后（2026-09-18 线上报障后修） =====
 * 现象：首启两个弹层叠着弹（隐私协议在前，引导 1/5 在后）。
 * 根因：wx.getPrivacySetting 是**异步**的 —— onShow 跑 maybeStartGuide 时回调还没回来，
 *       「此刻 visible = false」被当成「前面没有弹层」→ 直接开播；随后隐私弹窗才冒出来。
 * 修法：判据从「弹窗此刻是否可见」改为「查询是否已有结论」（privacyChecked），
 *       并把裁决抽成纯函数 guide.evalStart —— 下面就是给它的断言。 */
console.log('== G. 首启弹层串行 ==')
const ev = guide.evalStart
ok(ev({ active: false, shouldAuto: true, privacyChecked: false, privacyVisible: false }) === 'wait',
  'G-1 隐私查询还没结论 → 让路等（本次 bug 的正面修复：这个窗口期绝不开播）')
ok(ev({ active: false, shouldAuto: true, privacyChecked: true, privacyVisible: true }) === 'wait',
  'G-2 隐私弹窗正开着 → 让路等（关掉后才接引导）')
ok(ev({ active: false, shouldAuto: true, privacyChecked: true, privacyVisible: false }) === 'start',
  'G-3 已确认无需授权 / 弹窗已关 → 开播')
ok(ev({ active: false, shouldAuto: false, privacyChecked: true, privacyVisible: false }) === 'none',
  'G-4 有「已看过」标记 → 不播（2.A：只看标记）')
ok(ev({ active: false, shouldAuto: false, privacyChecked: false, privacyVisible: false }) === 'none',
  'G-5 不播时也不置「等待」（不留悬空等待态）')
ok(ev({ active: true, belongsHere: true }) === 'resume', 'G-6 已在播且当前步属于本页 → 续播')
ok(ev({ active: true, belongsHere: false }) === 'abort', 'G-7 已在播但当前步不属于本页 → 中止（从设置页返回）')
ok(ev({ active: true, belongsHere: false, privacyChecked: false, privacyVisible: true }) === 'abort',
  'G-8 已在播时先判归属（半途状态优先失效，不因弹层卡在设置页那步）')
ok(ev() === 'none' && ev(null) === 'none', 'G-9 无参/空参不抛（防御）')
ok(ev({ active: false, shouldAuto: true, privacyChecked: false, privacyVisible: true }) === 'wait',
  'G-10 「查询未回 + 弹窗已显示」（极快回调）同样等待，不漏判')

/* 行为级红灯自检：把旧判据复刻出来，证明它在这段异步窗口内必然误判 */
const oldShouldStart = (privacyVisible) => !privacyVisible // 旧逻辑：没看到弹窗就开播
const oldVerdict = oldShouldStart(false)
const newVerdict = ev({ active: false, shouldAuto: true, privacyChecked: false, privacyVisible: false })
ok(oldVerdict === true && newVerdict === 'wait',
  'G-11 红灯自检：同一时刻旧判据开播（→ 叠弹）、新判据等待 —— 断言正对准本次 bug', [oldVerdict, newVerdict])

/* 静态护栏：串行必须真落在代码里，不能只是纯函数好看 */
ok(count(pj, '_privacyChecked') >= 3, 'G-12 写日记页有「查询结论」状态（初始化 / 裁决读取 / 回调置位）', count(pj, '_privacyChecked'))
ok(pj.indexOf('this._privacyChecked = false') !== -1 && pj.indexOf('this._privacyChecked === true') !== -1,
  'G-13 初始化与读取都显式判 true（不把 undefined 当「已有结论」）')
ok(pj.indexOf('this._privacyChecked = false') < pj.indexOf('lock.guard()'),
  'G-14 结论标记在 lock.guard() 之前初始化（提前 return 也不漏）')
ok(pj.indexOf('Promise.resolve(privacyPopup.tryShow())') !== -1,
  'G-15 隐私检查按 Promise 接结论（异步结果才拿得到）')
ok(pj.indexOf('this.onPrivacyChecked(false)') !== -1 && count(pj, 'onPrivacyChecked(') >= 3,
  'G-16 取不到组件时按「无需授权」放行（绝不卡死引导）', count(pj, 'onPrivacyChecked('))
ok(pj.indexOf('const action = guide.evalStart({') !== -1, 'G-17 裁决走 guide.evalStart（单一来源，不在这页重写）')
ok(pj.indexOf("if (action === 'wait') { this._guideWaiting = true; return }") !== -1,
  'G-18 让路时留下「在等」标记')
ok(count(pj, 'this.resumeGuide()') === 3 && pj.indexOf('this.maybeStartGuide()') !== -1,
  'G-19 让路结束（结论回来 / 弹窗关闭 / 定位询问结束）都走 resumeGuide 重新裁决', count(pj, 'this.resumeGuide()'))
ok(pp.indexOf('return new Promise((resolve)') !== -1 && pp.indexOf('resolve(need)') !== -1,
  'G-20 privacy-popup.tryShow 返回结论（Promise<boolean>）')
ok(pp.indexOf('return Promise.resolve(false)') !== -1, 'G-21 旧基础库分支也返回 Promise（不返回 undefined）')
ok(pj.indexOf('this._privacyTimer = setTimeout(') !== -1 && pj.indexOf('clearTimeout(this._privacyTimer)') !== -1,
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
const mBuf = /const GUIDE_AFTER_LOCATE_MS = (\d+)/.exec(pj)
ok(!!mBuf && Number(mBuf[1]) >= 400 && Number(mBuf[1]) <= 500,
  'G2-13 结论后的缓冲落在 400~500ms（用户拍板口径）', mBuf && mBuf[1])
ok(pj.indexOf('privacyVisible: !!(popup && popup.data && popup.data.visible),') !== -1,
  'G2-14 locationSettled 与既有判据并列（不是替换掉隐私判据）')

/* ============ 6. 红灯自检 ============ */
console.log('== F. 红灯自检（对改动前的备份文件，断言必须不通过）==')
const bPW = BK + '\\pages\\write\\write.wxml'
const bPJ = BK + '\\pages\\write\\write.js'
const bPJSON = BK + '\\pages\\write\\write.json'
const bSW = BK + '\\pages\\setting\\setting.wxml'
const bSJ = BK + '\\pages\\setting\\setting.js'
ok(exists(bPW) && exists(bPJ) && exists(bSW) && exists(bSJ) && exists(bPJSON),
  'F-0 备份文件齐全（红灯自检的前提）')
if (exists(bPW)) {
  const t = read(bPW)
  ok(t.indexOf('id="guide-hold-talk"') === -1, 'F-1 改动前：没有引导锚点（断言有区分度）')
  ok(t.indexOf('<guide-mask') === -1, 'F-2 改动前：没挂引导组件')
}
if (exists(bPJSON)) ok(read(bPJSON).indexOf('guide-mask') === -1, 'F-3 改动前：json 未注册组件')
if (exists(bPJ)) {
  const t = read(bPJ)
  ok(t.indexOf('maybeStartGuide') === -1 && t.indexOf("utils/guide.js") === -1, 'F-4 改动前：页面没接线')
}
if (exists(bSW)) ok(read(bSW).indexOf('id="guide-theme"') === -1, 'F-5 改动前：设置页主题行无锚点')
if (exists(bSJ)) ok(read(bSJ).indexOf('restartGuide') === -1, 'F-6 改动前：没有重看入口')

/* 红灯自检（第二轮）：对「含引导但旧判据」的备份 —— 本次叠弹修复的断言必须不通过 */
const B2 = 'C:\\Users\\ThinkPad\\WorkBuddy\\privacyseq-backup-20260918'
const b2PJ = B2 + '\\pages\\write\\write.js'
const b2PP = B2 + '\\components\\privacy-popup\\privacy-popup.js'
const b2GJ = B2 + '\\utils\\guide.js'
ok(exists(b2PJ) && exists(b2PP) && exists(b2GJ), 'H-0 本轮改动前的备份齐全（前提）')
if (exists(b2PJ)) {
  const t = read(b2PJ)
  ok(t.indexOf('_privacyChecked') === -1, 'H-1 改动前：没有「查询结论」判据（只看可见性）→ 断言有区分度')
  ok(t.indexOf('guide.evalStart') === -1, 'H-2 改动前：裁决内联在页面里，无纯函数可测')
  ok(t.indexOf('popup.data.visible') !== -1, 'H-3 改动前：判据就是「此刻 visible」（竞态根源）')
  ok(t.indexOf('onPrivacyChecked') === -1, 'H-4 改动前：不接隐私查询的结论')
}
if (exists(b2GJ)) ok(read(b2GJ).indexOf('evalStart') === -1, 'H-5 改动前：guide.js 无 evalStart')
if (exists(b2PP)) {
  const t = read(b2PP)
  ok(t.indexOf('return new Promise') === -1 && t.indexOf('resolve(need)') === -1,
    'H-6 改动前：tryShow 不返回结论（页面无从得知查询在途）')
}

/* ===== 8. 行为测试：真加载写日记页，跑一遍「首启两个弹层」的时序 =====
 * 静态护栏不够 —— 本次 bug 就是「静态断言全过、行为错」的典型：
 * 页面里确实有「检查隐私弹窗」的代码，只是判据读的是异步未落地的状态。
 * 这节直接把 write.js 加载起来（vm + wx 桩），用手指头把时序按一遍。 */
const flush = () => new Promise((r) => setTimeout(r, 0))
// [privacy-weather-gate v2] 等「定位结论 + 缓冲」走完（GUIDE_AFTER_LOCATE_MS = 450）
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function mkCtx(writeFile) {
  // 每个场景全新模块实例，避免互相污染（页面/工具模块都是单例）
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })

  const store = {}
  const sink = { toasts: [], nav: [], errors: [] }

  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    getStorageInfo: (o) => { o && o.success && o.success({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }) },
    getStorageInfoSync: () => ({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }),
    getWindowInfo: () => ({ statusBarHeight: 20, screenHeight: 812, safeArea: { top: 44, bottom: 778 } }),
    getSystemInfoSync: () => ({ platform: 'devtools', statusBarHeight: 20, screenHeight: 812, safeArea: { top: 44, bottom: 778 } }),
    showToast: (o) => { sink.toasts.push(o && o.title) },
    hideToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    showModal: () => {},
    showActionSheet: () => {},
    navigateTo: (o) => { sink.nav.push((o && o.url) || ''); o && o.success && o.success({}) },
    redirectTo: (o) => { sink.nav.push('REDIRECT:' + ((o && o.url) || '')) },
    reLaunch: (o) => { sink.nav.push('RELAUNCH:' + ((o && o.url) || '')) },
    navigateBack: () => {},
    getLocation: (o) => { o && o.fail && o.fail({ errMsg: '桩：不给定位' }) },
    createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => {} }), exec: (cb) => { cb && cb([]) } }),
    getSetting: (o) => { o && o.success && o.success({ authSetting: {} }) },
    authorize: (o) => { o && o.fail && o.fail({}) },
    getNetworkType: (o) => { o && o.success && o.success({ networkType: 'wifi' }) },
    onNetworkStatusChange: () => {},
    setKeepScreenOn: () => {},
    vibrateShort: () => {},
    getRecorderManager: () => ({ onStart: () => {}, onStop: () => {}, onError: () => {}, start: () => {}, stop: () => {} }),
    cloud: { callFunction: () => Promise.resolve({ result: {} }) },
    getPrivacySetting: (o) => { o && o.success && o.success({ needAuthorization: false }) }
  }
  global.getApp = () => ({ globalData: {} })

  let pageObj = null
  global.Page = (o) => { pageObj = o }

  const dir = path.join(base, 'pages', 'write')
  const fakeRequire = (p) => require(path.resolve(dir, p))
  let loadError = null
  try {
    const src = fs.readFileSync(writeFile || PJ, 'utf8')
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'write.js' })
    wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  } catch (e) { loadError = String((e && e.message) || e) }
  if (!pageObj) return { loadError: loadError || 'Page 未注册', store, sink, page: null, guide: null }

  const page = Object.create(pageObj)
  page.data = Object.assign({}, pageObj.data)
  page.setData = function (d) { Object.assign(this.data, d) }
  // write.js 与断言必须拿到同一个 guide 实例（它就是页面 require 进去的那个）
  const g = require(path.join(base, 'utils', 'guide.js'))
  return { loadError, store, sink, page, guide: g }
}

// 场景跑一页：onLoad + onShow（onShow 包 try，异常记下来当断言）
function boot(ctx) {
  try { ctx.page.onLoad() } catch (e) { ctx.sink.errors.push('onLoad: ' + ((e && e.message) || e)) }
  try { ctx.page.onShow() } catch (e) { ctx.sink.errors.push('onShow: ' + ((e && e.message) || e)) }
}

;(async () => {
  console.log('== I. 行为：首启弹层串行 ==')

  /* 场景 1：首启，隐私查询在途（页面先动、回调后回）—— 本次 bug 的原样复现 */
  {
    const ctx = mkCtx()
    ok(ctx.loadError === null, 'I-1 写日记页可加载（无未定义标识符）', ctx.loadError)
    const g = ctx.guide
    g.abort()
    let resolvePrivacy = null
    const comp = { data: { visible: false }, tryShow: () => new Promise((r) => { resolvePrivacy = r }) }
    ctx.page.selectComponent = () => comp
    boot(ctx)
    ok(ctx.sink.errors.length === 0, 'I-2 onLoad/onShow 无异常（串行逻辑没被别处副作用打断）', ctx.sink.errors)
    ok(ctx.page._privacyChecked === false, 'I-3 查询在途：结论标记仍是 false（异步还没落地）', ctx.page._privacyChecked)
    ok(ctx.page._guideWaiting === true, 'I-4 查询在途 → 引导进入等待（不再抢在隐私弹窗前面）', ctx.page._guideWaiting)
    ok(g.isActive() === false && ctx.page.data.guideVisible === false,
      'I-5 ★ 此刻引导没开播 —— 叠弹的正面修复（旧代码这里已经开播了）')
    // 隐私回调返回：需要授权 → 弹窗显示
    comp.data.visible = true
    resolvePrivacy(true)
    await flush()
    ok(ctx.page._privacyChecked === true, 'I-6 结论落地：需要授权')
    ok(g.isActive() === false && ctx.page.data.guideVisible === false, 'I-7 隐私弹窗显示中 → 引导继续让路')
    // 用户关掉隐私弹窗（同意 / 暂不同意都会触发 bind:close）
    comp.data.visible = false
    ctx.page.onPrivacyClosed()
    ok(g.isActive() === true, 'I-8 隐私弹窗关掉后才开播（先隐私、后引导）')
    ok(g.getStep() && g.getStep().id === 'hold-talk', 'I-9 开播即第 1 步「按住说话」', g.getStep() && g.getStep().id)
    ok(ctx.page._guideWaiting === false, 'I-10 等待态已清（不留悬空标记）')
  }

  /* 场景 2：已同意过（无需授权）→ 不白等，照常开播 */
  {
    const ctx = mkCtx()
    const g = ctx.guide
    g.abort()
    delete ctx.store[g.DONE_KEY]
    const comp = { data: { visible: false }, tryShow: () => Promise.resolve(false) }
    ctx.page.selectComponent = () => comp
    boot(ctx)
    await flush()
    ok(ctx.page._privacyChecked === true, 'I-11 无需授权：结论照样落地（不能因为「不弹」就不给结论）', ctx.page._privacyChecked)
    // [privacy-weather-gate v2] 定位询问也要走一遍「有结论 + 缓冲」：桩里 getLocation 同步失败
    // ⇒ 结论立刻落地，但引导要等缓冲（450ms）走完才开播
    ok(ctx.page._locationSettled === true, 'I-12a 定位询问已出结论（桩：同步失败）')
    ok(g.isActive() === false, 'I-12b 缓冲期内还没开播（等原生弹框收起）')
    await wait(600)
    ok(g.isActive() === true, 'I-12c 缓冲走完 → 开播（不等一个永远不会来的弹窗）')
  }

  /* 场景 3：有「已看过」标记 → 首启不播（2.A 回归） */
  {
    const ctx = mkCtx()
    const g = ctx.guide
    g.markDone()
    const comp = { data: { visible: false }, tryShow: () => Promise.resolve(false) }
    ctx.page.selectComponent = () => comp
    boot(ctx)
    await flush()
    ok(g.isActive() === false, 'I-13 看过标记存在 → 不自动播（重看走设置页入口）')
    ok(!ctx.page._guideWaiting, 'I-14 不播时也不留等待态（从未赋值 ⇒ falsy）', ctx.page._guideWaiting)
  }

  /* 场景 4：取不到隐私组件（组件未注册 / 极端情况）→ 放行，绝不卡死 */
  {
    const ctx = mkCtx()
    const g = ctx.guide
    g.reset()
    ctx.page.selectComponent = () => null
    boot(ctx)
    await flush()
    ok(ctx.page._locationSettled === true, 'I-15a 定位询问已出结论（进了同一条闸门）')
    await wait(600)
    ok(g.isActive() === true, 'I-15b 取不到隐私组件 → 按「无需授权」放行（引导不会被永久卡住）')
  }

  /* 场景 5：中途从设置页返回（当前步不属于本页）→ 中止，不重播 */
  {
    const ctx = mkCtx()
    const g = ctx.guide
    g.reset()
    g.start(4) // 停在第 5 步（设置页那步）
    const comp = { data: { visible: false }, tryShow: () => Promise.resolve(false) }
    ctx.page.selectComponent = () => comp
    boot(ctx)
    await flush()
    ok(g.isActive() === false, 'I-16 从设置页返回 → 半途状态失效（不挂在设置页那步）')
    ok(g.shouldAutoStart() === true, 'I-17 中止不写「已看过」标记（下次从头播）')
  }

  /* 场景 6：红灯自检 —— 拿「改动前的 write.js」跑同一时序：
   * 旧代码在隐私查询在途时就会开播（这就是线上看到的两弹叠着弹）。
   * 若这条断言反而失败，说明前面 I-5 之类的断言其实区分不出修复与否。 */
  {
    const ctx = mkCtx(B2 + '\\pages\\write\\write.js')
    ok(ctx.loadError === null, 'I-18 红灯自检：旧页面可加载', ctx.loadError)
    if (ctx.loadError === null) {
      const g = ctx.guide
      g.abort()
      let resolvePrivacy = null
      const comp = { data: { visible: false }, tryShow: () => new Promise((r) => { resolvePrivacy = r }) }
      ctx.page.selectComponent = () => comp
      boot(ctx)
      ok(g.isActive() === true, 'I-19 红灯自检：旧代码在同一时刻已经开播（两弹叠着弹的真实成因）', g.isActive())
      ok(!ctx.page._guideWaiting, 'I-20 红灯自检：旧代码没有「等待」概念', ctx.page._guideWaiting)
      if (resolvePrivacy) resolvePrivacy(true) // 收尾：别留悬挂 Promise
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

  console.log('\n[test_guide] ' + pass + ' passed, ' + fail + ' failed')
  if (fail) {
    console.log('失败项：')
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
})()
