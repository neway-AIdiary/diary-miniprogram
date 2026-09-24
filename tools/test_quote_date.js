/**
 * test_quote_date.js —— 每日一签「日期头」行为测试 [quote-date v2]
 *
 * A. utils/lunarDate.js 纯函数（真实 require）：两历行 / 星期 / 星座边界 / 闰月 / 跨年 /
 *    节气常驻（1.B：当前所处节气段 + emoji，全年级连续性与库数据交叉验证）
 * B. dailyQuote 按日期确定性：getDetail(null, date) 同日恒定、与 pickIndex 一致
 * C. pages/quote/quote.js 页面行为（vm 桩）：默认今天 / ‹›翻日 / 未来钳制 / ?d 入参 /
 *    非法回落 / 跨天重置 / 复制全文不受影响
 * D. 静态断言：wxml/wxss 关键结构与令牌口径（v3 图标+左对齐两行 + 「诗词」行翻日）
 *
 * 红灯纪律：旧版（无 onPrevDay 等）必须「断言红、零崩溃」——C 段全部方法调用前有 hasBehavior 守卫。
 * 运行：node tools/test_quote_date.js（全绿退出码 0）
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
let passCount = 0
let failCount = 0

function ok(cond, msg) {
  if (cond) { passCount++ } else { failCount++; console.log('  ✗ ' + msg) }
}
function rd(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

// 本地日期 → 'YYYY-MM-DD'（与 quote.js 内部实现同口径，测试独立实现）
function dateToStr(d) {
  const m = ('' + (d.getMonth() + 1)).padStart(2, '0')
  const day = ('' + d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}
function pad2(n) { return ('' + n).padStart(2, '0') }

// =====================================================================
console.log('---- A. utils/lunarDate.js 纯函数 ----')
const lunarDate = require('../utils/lunarDate.js')
const solarLunarMod = require('../utils/solarlunar.min.js')
const solarLunar = solarLunarMod.default || solarLunarMod

let h = lunarDate.header(new Date(2026, 8, 21))
ok(h.gregorian === '2026年09月21日', '2026-9-21 gregorian=2026年09月21日（零填充，got ' + h.gregorian + '）')
ok(h.weekday === '星期一', '2026-9-21 weekday=星期一（got ' + h.weekday + '）')
ok(h.constellation === '处女座', '2026-9-21 constellation=处女座（got ' + h.constellation + '）')
ok(h.lunarFull === '丙午年八月十一', '2026-9-21 lunarFull=丙午年八月十一（got ' + h.lunarFull + '）')
ok(h.zodiac === '马', '2026-9-21 zodiac=马（丙午马年，got ' + h.zodiac + '）')
ok(h.termName === '白露' && h.termIcon === '💧', '2026-9-21 节气段=白露💧（1.B 常驻，got ' + h.termName + h.termIcon + '）')

h = lunarDate.header(new Date(2026, 8, 23))
ok(h.termName === '秋分' && h.termIcon === '🍁', '2026-9-23 起进入秋分段🍁（got ' + h.termName + h.termIcon + '）')

h = lunarDate.header(new Date(2024, 1, 10)) // 2024 春节
ok(h.lunarFull === '甲辰年正月初一', '2024-2-10（春节）lunarFull=甲辰年正月初一（got ' + h.lunarFull + '）')
ok(h.zodiac === '龙', '2024-2-10（甲辰）zodiac=龙（got ' + h.zodiac + '）')
ok(h.weekday === '星期六', '2024-2-10 weekday=星期六')
ok(h.termName === '立春' && h.termIcon === '🌱', '2024-2-10 节气段=立春🌱（got ' + h.termName + h.termIcon + '）')

h = lunarDate.header(new Date(2026, 0, 1)) // 农历跨年：公历2026元旦 = 农历乙巳年
ok((h.lunarFull || '').indexOf('乙巳年') === 0, '2026-1-1 干支年仍是乙巳年（跨年正确，got ' + h.lunarFull + '）')
ok(h.termName === '冬至', '2026-1-1 节气段跨年取上一年冬至（got ' + h.termName + '）')

h = lunarDate.header(new Date(2025, 6, 25)) // 2025 闰六月初一
ok((h.lunarFull || '').indexOf('闰六月') >= 0, '2025-7-25 闰六月自带「闰」前缀（got ' + h.lunarFull + '）')

// 星座边界（星座为本地公式）
const CASES = [
  [[3, 20], '双鱼座'], [[3, 21], '白羊座'], [[4, 19], '白羊座'], [[4, 20], '金牛座'],
  [[8, 22], '狮子座'], [[8, 23], '处女座'], [[9, 22], '处女座'], [[9, 23], '天秤座'],
  [[12, 21], '射手座'], [[12, 22], '摩羯座'], [[1, 19], '摩羯座'], [[1, 20], '水瓶座'],
  [[2, 18], '水瓶座'], [[2, 19], '双鱼座']
]
for (const [[m, d], name] of CASES) {
  ok(lunarDate.constellationOf(m, d) === name, '星座边界 ' + m + '.' + d + ' = ' + name +
    '（got ' + lunarDate.constellationOf(m, d) + '）')
}

// 节气常驻全年级验证 [quote-date v2]：2026 全年逐日扫描 termOf（汇总断言，不逐日撑计数）
// 旧版守卫：termOf / v2 字段不存在时精准红、不崩溃
const TERM_NAMES = lunarDate.TERM_NAMES || []
const TERM_ICONS = lunarDate.TERM_ICONS || {}
const termOfFn = typeof lunarDate.termOf === 'function' ? lunarDate.termOf : null
ok(TERM_NAMES.length === 24 && Object.keys(TERM_ICONS).length === 24,
  '节气表 24 项齐备（含 emoji 映射）（旧版此处精准红）')
ok(!!termOfFn && h.termName !== undefined && h.gregorian !== undefined,
  'v2 前置：termOf/新字段存在（旧版此处精准红）')

if (termOfFn && h.gregorian !== undefined) {
  const names = []
  const changeDays = []
  let prevName2 = ''
  let iconBroken = ''
  for (let i = 1; i <= 366; i++) {
    const dt = new Date(2026, 0, i)
    if (dt.getFullYear() !== 2026) break
    const t = lunarDate.termOf(dt)
    if (TERM_ICONS[t.name] !== t.icon || t.icon === '') { iconBroken = dateToStr(dt) + ':' + t.name; break }
    if (t.name !== prevName2) { names.push(t.name); changeDays.push(new Date(dt)); prevName2 = t.name }
  }
  ok(iconBroken === '', '全年逐日节气图标映射有效（首个异常：' + (iconBroken || '无') + '）')
  // 年内扫描首尾可能都是「冬至」（1 月上旬余段 + 12 月下旬新段）→ 环接去重
  if (names.length > 1 && names[0] === names[names.length - 1]) { names.pop(); changeDays.pop() }
  ok(names.length === 24, '2026 年恰好经历 24 个节气段（got ' + names.length + '）')
  const at = TERM_NAMES.indexOf(names[0])
  const rotated = TERM_NAMES.slice(at).concat(TERM_NAMES.slice(0, at))
  ok(names.join(',') === rotated.join(','), '节气段顺序与 24 节气环序一致（首段=' + names[0] + '）')
  // 交点日 = 库的 isTerm/term（新段第一天恰逢节气；首段是上一年延续的段，不参与）
  let crossOk = true
  for (let k = 1; k < changeDays.length; k++) {
    const r = solarLunar.solar2lunar(changeDays[k].getFullYear(), changeDays[k].getMonth() + 1, changeDays[k].getDate())
    if (!r || !r.isTerm || r.term !== names[k]) { crossOk = false; break }
  }
  ok(crossOk, '每个节气段首日 = solarlunar 库的 isTerm 日且节名一致（交叉验证）')
}

// 缺省参数 = 现在（不抛异常即可；具体值随运行日变化，只验结构）
h = lunarDate.header()
ok(h && typeof h.gregorian === 'string' && typeof h.weekday === 'string' &&
   typeof h.constellation === 'string' && typeof h.termName === 'string' &&
   typeof h.lunarFull === 'string' && typeof h.zodiac === 'string',
  'header() 缺省返回完整结构（v2 字段 + zodiac）')

// =====================================================================
console.log('---- B. dailyQuote 按日期确定性 ----')
const dailyQuote = require('../utils/dailyQuote.js')

const D21 = new Date(2026, 8, 21)
const a = dailyQuote.getDetail(null, D21)
const b = dailyQuote.getDetail(null, new Date(2026, 8, 21, 23, 59)) // 同日不同时刻
ok(a.index === b.index && a.body === b.body, '同日不同时刻恒定（确定性取模）')
ok(a.index === dailyQuote.pickIndex(D21), 'getDetail(null, d) 下标 = pickIndex(d)')
const c = dailyQuote.getDetail(null, new Date(2026, 8, 20))
ok(c.index === dailyQuote.pickIndex(new Date(2026, 8, 20)), '相邻天取模口径一致')
ok(typeof a.copyText === 'string' && a.copyText.indexOf(a.head) === 0, 'copyText 自带出处（标题开头）')

// =====================================================================
console.log('---- C. quote.js 页面行为（vm 桩）----')
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Date: Date,
  wx: {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getSystemInfoSync: () => ({ safeArea: { bottom: 0 }, screenHeight: 800 }),
    getWindowInfo: () => ({ safeArea: { bottom: 0 }, screenHeight: 800 }),
    showToast: (o) => { sandbox.__toast = o },
    setClipboardData: (o) => { sandbox.__clip = o },
    navigateTo: () => {},
    reLaunch: () => {}
  }
}
let pageOptions = null
sandbox.Page = (o) => { pageOptions = o }
sandbox.Component = () => {}
sandbox.module = { exports: {} }
sandbox.exports = sandbox.module.exports
sandbox.__filename = path.join(ROOT, 'pages', 'quote', 'quote.js')
sandbox.__dirname = path.join(ROOT, 'pages', 'quote')
vm.createContext(sandbox)
sandbox.require = (p) => require(path.join(ROOT, 'pages', 'quote', p))

vm.runInContext(rd('pages/quote/quote.js'), sandbox, { filename: 'quote.js' })
ok(!!pageOptions, 'Page() 捕获成功')

function makePage() {
  const inst = Object.assign({}, pageOptions)
  inst.data = JSON.parse(JSON.stringify(pageOptions.data))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  return inst
}

const TODAY = new Date()
const TODAY_STR = dateToStr(TODAY)
const YDAY = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 1)
const YDAY_STR = dateToStr(YDAY)

// 旧版守卫（零崩溃纪律）：日期头方法不存在时精准报红并跳过整组
let p = makePage()
const hasBehavior = typeof p.onPrevDay === 'function' && typeof p.onNextDay === 'function' &&
  typeof p.applyDate === 'function'
ok(hasBehavior, 'C 组前置：日期头行为方法存在（旧版此处精准红）')

if (hasBehavior) {
  // 默认 = 今天
  p.onLoad({})
  ok(p.data.dateStr === TODAY_STR, 'onLoad 默认今天（got ' + p.data.dateStr + '）')
  ok(p.data.canNext === false && p.data.canPrev === true, '今天：canNext=false / canPrev=true（3.A 未来禁止）')
  ok(p.data.gregorian === TODAY.getFullYear() + '年' + pad2(TODAY.getMonth() + 1) + '月' + pad2(TODAY.getDate()) + '日',
    'gregorian 零填充口径（YYYY年MM月DD日）')
  ok(/^星期./.test(p.data.weekday) && p.data.weekday.length === 3, 'weekday 三字（星期X）')
  ok(/座$/.test(p.data.constellation), 'constellation 以「座」结尾')
  ok((p.data.lunarFull || '').length > 0, 'lunarFull 非空（1900~2100 内必有农历）')
  ok(typeof TERM_ICONS[p.data.termName] === 'string' && p.data.termIcon === TERM_ICONS[p.data.termName],
    'termName/termIcon 成对且在映射表内（1.B 常驻）')
  ok(p.data.head && p.data.body, '一签内容已渲染（head/body）')
  ok(p.data.index === dailyQuote.pickIndex(TODAY), '今日一签下标 = pickIndex(今天)')

  // ‹ 前一天
  p.onPrevDay()
  ok(p.data.dateStr === YDAY_STR, '‹ 一次 → 昨天（got ' + p.data.dateStr + '）')
  ok(p.data.canNext === true, '过去日期 canNext=true（可翻回来）')
  ok(p.data.body === dailyQuote.getDetail(null, YDAY).body, '昨日正文 = getDetail(null, 昨天)（按日取签）')
  ok(p.data.gregorian === YDAY.getFullYear() + '年' + pad2(YDAY.getMonth() + 1) + '月' + pad2(YDAY.getDate()) + '日',
    '日期头公历行跟随翻日')

  // › 回到今天，再点越界无效
  p.onNextDay()
  ok(p.data.dateStr === TODAY_STR, '› 一次 → 回到今天')
  ok(p.data.canNext === false, '回到今天 canNext=false')
  p.onNextDay()
  ok(p.data.dateStr === TODAY_STR, '今天再点 › 仍停在今天（越界无效）')

  // 连翻两天再连翻回来：结果恒定
  p.onPrevDay(); p.onPrevDay()
  const back2 = p.data.dateStr
  ok(back2 === dateToStr(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 2)), '‹‹ → 前天')
  p.onNextDay(); p.onNextDay()
  ok(p.data.dateStr === TODAY_STR && p.data.body === dailyQuote.getDetail(null, TODAY).body, '翻回今天：内容恒定复原')

  // ?d= 入参
  p = makePage()
  p.onLoad({ d: '9999-01-01' })
  ok(p.data.dateStr === TODAY_STR, '?d 未来日期 → 回落今天（3.A）')
  p = makePage()
  p.onLoad({ d: 'abc' })
  ok(p.data.dateStr === TODAY_STR, '?d 非法字符串 → 回落今天')
  p = makePage()
  p.onLoad({ d: '2026-02-30' })
  ok(p.data.dateStr === TODAY_STR, '?d 不存在的日期（2月30）→ 回落今天（回读校验）')
  p = makePage()
  p.onLoad({ d: '2024-02-10' })
  ok(p.data.dateStr === '2024-02-10' && p.data.gregorian === '2024年02月10日', '?d 合法过去日期 → 直达（2024-2-10）')
  ok(p.data.lunarFull === '甲辰年正月初一', '2024-2-10 农历行=甲辰年正月初一')
  ok(p.data.zodiac === '龙', '2024-2-10 生肖=龙（页面数据透传）')
  ok(p.data.canNext === true, '过去日期 canNext=true')
  ok(p.data.body === dailyQuote.getDetail(null, new Date(2024, 1, 10)).body, '?d 日期的一签 = 按该日取模')

  // ?i= 兼容保留（侧栏入口）
  p = makePage()
  p.onLoad({ i: String(dailyQuote.pickIndex(TODAY)) })
  ok(p.data.index === dailyQuote.pickIndex(TODAY) && p.data.dateStr === TODAY_STR, '?i= 侧栏入口兼容（今天）')

  // 跨天回页面：重置回今天
  p = makePage()
  p.onLoad({ d: '2024-02-10' })
  p._dayKey = '2000-01-01' // 模拟页面停留跨 0 点
  p.onShow()
  ok(p.data.dateStr === TODAY_STR && p.data.canNext === false, '跨天 onShow → 重置回今天（日期头+一签）')

  // 复制全文不受日期头影响
  sandbox.__clip = null
  p.copyAll()
  ok(sandbox.__clip && sandbox.__clip.data === p.data.copyText, 'copyAll 复制 copyText（不受日期头影响）')
}

// =====================================================================
console.log('---- D. 静态断言（wxml/wxss 结构与令牌）----')
const wxml = rd('pages/quote/quote.wxml')
const wxss = rd('pages/quote/quote.wxss')
const qjs = rd('pages/quote/quote.js')

ok(wxml.indexOf('date-head') >= 0 && wxml.indexOf('bindtap="onPrevDay"') >= 0 &&
   wxml.indexOf('bindtap="onNextDay"') >= 0 &&
   wxml.indexOf('<view class="date-nav">') > wxml.indexOf('date-head') &&
   wxml.indexOf('<view class="date-nav">') < wxml.indexOf('date-rule'),
  'wxml [nav-move]：‹›翻日移入日期头（date-nav 在 date-head 与 date-rule 之间、贴右）')
const kindRowSeg = wxml.slice(wxml.indexOf('quote-kind-row'), wxml.indexOf('quote-head'))
ok(wxml.indexOf('quote-kind-row') >= 0 && wxml.indexOf('quote-nav-btn') >= 0 &&
   wxml.indexOf('quote-nav-off') >= 0 && kindRowSeg.indexOf('onPrevDay') === -1,
  'wxml [nav-move]：「诗词」行不再含翻日按钮（已挪至日期头右侧）')
ok(wxml.indexOf('date-big') === -1 && wxml.indexOf('{{dayNum}}') === -1 &&
   wxml.indexOf('date-vert') === -1, 'wxml：旧版大数字/竖排结构整体移除')
ok(wxml.indexOf('date-line1') >= 0 && wxml.indexOf('{{gregorian}}') >= 0 &&
   wxml.indexOf('{{weekday}}') >= 0 && wxml.indexOf('date-cal') === -1 &&
   wxml.indexOf('公历') === -1 && wxml.indexOf('农历') === -1,
  'wxml [quote-date v4]：第一行 = 公历日期 + 星期几，「公历/农历」标签字样清零')
ok(wxml.indexOf('{{lunarFull}}') >= 0 && wxml.indexOf('{{zodiac}} · ') >= 0 &&
   wxml.indexOf('{{constellation}}') >= 0 && wxml.indexOf('{{termName}}') >= 0 &&
   wxml.indexOf('{{zodiac}} · ') > wxml.indexOf('{{lunarFull}}') &&
   wxml.indexOf('{{zodiac}} · ') < wxml.indexOf('{{constellation}}'),
  'wxml [quote-zodiac]：第二行 = 干支日期 + 生肖 + 星座 + 节气（生肖在农历与星座之间）')
ok(wxml.indexOf('wx:if="{{termName}}"') >= 0 && wxml.indexOf('{{termName}}') >= 0 &&
   wxml.indexOf('termIcon') === -1,
  'wxml：节气段绑定且不带 emoji [quote-date v3]（2.A）')
ok(wxml.indexOf('【') === -1, 'wxml：节气不带【】括号（用户明确要求）')
ok(wxml.indexOf('date-icon') >= 0 && wxml.indexOf('date-icon-dot') >= 0 &&
   wxml.indexOf('date-icon-col') >= 0, 'wxml：日历图标（CSS 绘制，含琥珀圆点）在位 [quote-date v3]')
ok(wxml.indexOf('date-text') >= 0 && wxml.indexOf('date-line1') >= 0 &&
   wxml.indexOf('date-line2') >= 0, 'wxml：图标列 + 文字列悬挂缩进（星 ↔ 公 对齐） [quote-date v3]')
ok(wxml.indexOf('date-rule') >= 0 && wxss.indexOf('.date-rule') >= 0 &&
   wxss.indexOf('font-weight: 600;') === -1,
  'wxml/wxss：区隔线在位 + 第1行已去加粗 [quote-date v3.1]')
ok(wxml.indexOf('quote-foot') >= 0 &&
   wxml.indexOf('{{appName}} · 以一灯传诸灯，终至万灯皆明') >= 0,
  'wxml [quote-date v4]：页脚 = {{appName}} · 以一灯传诸灯，终至万灯皆明（无品牌字面量）')
ok(wxss.indexOf('.quote-nav-off') >= 0 && wxss.indexOf('.quote-nav-hover') >= 0,
  'wxss：翻日按钮态（可用/悬停/越界置灰）')
ok(wxss.indexOf('.date-big') === -1 && wxss.indexOf('.date-vert') === -1 &&
   wxss.indexOf('.date-lunar') === -1 && wxss.indexOf('.date-cal') === -1,
  'wxss：旧版大数字/竖排/农历行/「公历农历」小标签样式整体移除')
ok(wxss.indexOf('.date-icon-dot') >= 0 && wxss.indexOf('var(--brand)') >= 0,
  'wxss：琥珀强调收进图标日期圆点 [quote-date v3]')
// 深浅主题：日期头不引入任何写死色值（v2 起点的后续段复核）
const wxssTail = wxss.slice(wxss.indexOf('[quote-date v3]'))
ok(/#[0-9a-fA-F]{3,6}/.test(wxssTail) === false, 'wxss 日期头段零写死色值（深浅主题都走令牌）')
ok(qjs.indexOf('ds < this._todayStr') >= 0, 'quote.js：未来钳制口径（字符串比较）')
ok(qjs.indexOf('dateToStr(d) !== t') >= 0, 'quote.js：非法日期回读校验在位')

// =====================================================================
console.log('\n===== ' + passCount + ' passed, ' + failCount + ' failed =====')
process.exit(failCount > 0 ? 1 : 0)
