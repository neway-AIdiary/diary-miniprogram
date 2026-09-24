/**
 * tools/test_cross_year.js
 * [cross-year v1] 跨年场景专项回归套件（2026-09-24）
 *
 * 用户拍板：跨年审计的 1.2.3 三项「只修有跨年情况的，同一年内不用修」。
 * 本套件的每一条断言都成对出现：**跨年行为已修正** + **同年行为一字未变**。
 *
 * 覆盖：
 *   A. calculateStreak 去掉 365 硬封顶（源码抽取 + 行为）
 *      —— 跨年连续 400 天 ⇒ 400（旧版 365）；同年数据集 ⇒ 与旧算法逐字一致
 *   B. util.isCrossYearDate / formatCompactDate 跨年补年份（同年零变化）
 *   C. utils/tagFit.js 跨年日期宽度档（默认档不变 / 跨年档收窄 / 真的会多丢标签）
 *   D. dateRange.rangeText 跨年区间两端带年份（同年零变化）
 *   E. 静态契约（列表页真把跨年宽度传进去了；365 封顶已绝迹）
 *
 * 运行：node tools/test_cross_year.js（全绿退出码 0）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------- wx 桩（模块顶层可能触碰 wx） ----------------
const store = {}
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
  showToast: () => {},
  showModal: () => {},
  cloud: null
}
global.getApp = () => ({ globalData: {} })

const util = require(path.join(ROOT, 'utils', 'util.js'))
const tagFit = require(path.join(ROOT, 'utils', 'tagFit.js'))
const dateRange = require(path.join(ROOT, 'utils', 'dateRange.js'))

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else {
    fail++
    console.log('  FAIL ' + msg + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''))
  }
}

const NO = '\u0000__NO_IMPL__'
const DAY = 86400000

// =====================================================================
console.log('\n== A. calculateStreak 去掉 365 硬封顶 ==')

// 源码抽取：calculateStreak 是 storage.js 内部函数（不导出），从源码里取实现来跑行为
let newStreak = null
const storageSrc = read('utils/storage.js')
const m = storageSrc.match(/function calculateStreak\(list\) \{[\s\S]*?\n\}/)
if (m) {
  try {
    newStreak = new Function('return (' + m[0] + ')')()
  } catch (e) {
    newStreak = null
  }
}
ok(typeof newStreak === 'function', 'A1 能从 storage.js 抽取 calculateStreak 实现', m ? 'match' : 'no-match')

// 旧算法（改动前）：for (let i = 0; i < 365; i++)
function oldStreak(list) {
  if (!list.length) return 0
  const dateSet = new Set()
  list.forEach(d => {
    const date = new Date(d.created_at)
    dateSet.add(date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate())
  })
  let streak = 0
  const today = new Date()
  for (let i = 0; i < 365; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
    if (dateSet.has(key)) streak++
    else if (i > 0) break
  }
  return streak
}

// 构造「从今天起往前 n 天连续」的日记
const noonToday = new Date()
noonToday.setHours(12, 0, 0, 0)
function dailyList(n, stepDays) {
  const out = []
  const step = stepDays || 1
  for (let i = 0; i < n; i++) {
    out.push({ created_at: new Date(noonToday.getTime() - i * step * DAY).toISOString() })
  }
  return out
}

const safe = (fn, list) => { try { return fn ? fn(list) : NO } catch (e) { return NO } }

// A2 同年：连续 6 天（含今天）—— 新旧必须一致，且都等于 6
const L6 = dailyList(6)
ok(safe(newStreak, L6) === 6 && oldStreak(L6) === 6, 'A2 同年连续 6 天 = 6（新旧一致）',
  { n: safe(newStreak, L6), o: oldStreak(L6) })

// A3 同年：断档（今天、昨天、前天、再跳 5 天）—— 新旧一致
const LBreak = dailyList(3).concat(dailyList(1, 8))
ok(safe(newStreak, LBreak) === oldStreak(LBreak), 'A3 同年断档：新旧结果一致',
  { n: safe(newStreak, LBreak), o: oldStreak(LBreak) })

// A4 ★ 跨年：连续 400 天 ⇒ 新版 400，旧版被钉死在 365
const L400 = dailyList(400)
ok(safe(newStreak, L400) === 400, 'A4 跨年连续 400 天 = 400（旧版封顶 365）', safe(newStreak, L400))
ok(oldStreak(L400) === 365, 'A5 旧算法在同一数据集上确实封顶 365（证明 A4 是修复而非等价）', oldStreak(L400))

// A6 非闰年 366 天（正好跨过一整年）
const L366 = dailyList(366)
ok(safe(newStreak, L366) === 366 && oldStreak(L366) === 365, 'A6 连续 366 天：新版 366 / 旧版 365',
  { n: safe(newStreak, L366), o: oldStreak(L366) })

// A7 空列表 / 无今天（今天未写）：行为不变
ok(safe(newStreak, []) === 0 && oldStreak([]) === 0, 'A7 空列表 = 0（不变）')
const LNoToday = dailyList(1).slice(0, 0) // []
ok(safe(newStreak, LNoToday) === oldStreak(LNoToday), 'A8 空数据集新旧一致')
const LFutureOnly = [{ created_at: new Date(noonToday.getTime() + 3 * DAY).toISOString() }]
ok(safe(newStreak, LFutureOnly) === 0, 'A9 只有未来日期 = 0（不会误判连续）', safe(newStreak, LFutureOnly))

// =====================================================================
console.log('\n== B. util 跨年日期（formatCompactDate / isCrossYearDate） ==')
const WD = ['日', '一', '二', '三', '四', '五', '六']
const wdOf = (iso) => WD[new Date(iso).getDay()]
const thisYear = new Date().getFullYear()
const isoOf = (y, mo, d) => new Date(y, mo - 1, d, 12, 0, 0).toISOString()

const cyFn = typeof util.isCrossYearDate === 'function' ? util.isCrossYearDate : null
ok(typeof cyFn === 'function', 'B1 util.isCrossYearDate 已导出')

// 同年：不带年份（零视觉变化）
const ISO_THIS = isoOf(thisYear, 3, 7)
ok(typeof util.formatCompactDate === 'function' &&
  util.formatCompactDate(ISO_THIS) === '3/7 周' + wdOf(ISO_THIS),
  'B2 同年紧凑日期不带年份「3/7 周X」', util.formatCompactDate(ISO_THIS))

// 跨年：带年份（四位年 + /）
const ISO_LAST = isoOf(thisYear - 1, 12, 20)
ok(util.formatCompactDate(ISO_LAST) === (thisYear - 1) + '/12/20 周' + wdOf(ISO_LAST),
  'B3 跨年紧凑日期带年份「YYYY/12/20 周X」', util.formatCompactDate(ISO_LAST))

// 明年（未来年份）同样带年份
const ISO_NEXT = isoOf(thisYear + 1, 1, 5)
ok(util.formatCompactDate(ISO_NEXT) === (thisYear + 1) + '/1/5 周' + wdOf(ISO_NEXT),
  'B4 未来年份同样带年份（不补零）', util.formatCompactDate(ISO_NEXT))

ok(cyFn && cyFn(ISO_LAST) === true && cyFn(ISO_THIS) === false, 'B5 isCrossYearDate 判定跨年 / 同年')
ok(cyFn && cyFn('') === false && cyFn(null) === false && cyFn('乱码') === false,
  'B6 isCrossYearDate 空值 / 非法值 = false（不抛错）')

// 护栏：formatDate（完整格式）本体未变 —— 其他页面零影响
ok(util.formatDate(ISO_THIS) === '3月7日 周' + wdOf(ISO_THIS) &&
  util.formatDate(ISO_LAST) === '12月20日 周' + wdOf(ISO_LAST),
  'B7 formatDate 本体未变（跨年也不带年份 — 其他页面口径不动）', util.formatDate(ISO_LAST))

// formatRelativeTime 的近期档位不因跨年改动而变化
const t = util.formatRelativeTime(new Date(Date.now() - 2 * DAY).toISOString(), true)
ok(t === '2天前', 'B8 近期档位仍走「N天前」', t)

// =====================================================================
console.log('\n== C. tagFit 跨年日期宽度档 ==')
const W = tagFit.WIDTHS
ok(W && W.dateWidthCrossYear === 210, 'C1 跨年日期宽度档 = 210rpx', W && W.dateWidthCrossYear)
ok(Math.round(tagFit.availWidth('')) === 526, 'C2 不传 dateW ⇒ 沿用同年档 108（526rpx 不变）',
  Math.round(tagFit.availWidth('')))
ok(Math.round(tagFit.availWidth('', W.dateWidthCrossYear)) === 424,
  'C3 传跨年档 ⇒ 可用宽收窄到 424rpx（634 − 210）', Math.round(tagFit.availWidth('', W.dateWidthCrossYear)))
const TAGS = ['旅行的意义在于发现', '记录生活的点滴瞬间', '那些微不足道的事']
const fitSame = tagFit.fitTags(TAGS, '')
const fitCross = tagFit.fitTags(TAGS, '', W.dateWidthCrossYear)
const fitUndef = tagFit.fitTags(TAGS, '', undefined)
ok(fitSame.dropped === 0, 'C4 同年档：3 个长标签 2 行放下，一个不丢', fitSame.dropped)
ok(fitUndef.dropped === 0 && fitUndef.shown.join('|') === fitSame.shown.join('|'),
  'C5 传 undefined 与不传等价（既有调用零变化）')
ok(fitCross.dropped > 0, 'C6 跨年档：同样标签必须丢——这就是列表页要传参的原因', fitCross.dropped)
ok(fitCross.shown.length >= 1, 'C7 跨年档仍保底留 1 个')
ok(fitSame.shown.length === 3 && fitCross.shown.length < 3, 'C8 同年 3 个 / 跨年少于此',
  [fitSame.shown.length, fitCross.shown.length])

// =====================================================================
console.log('\n== D. dateRange.rangeText 跨年区间 ==')
ok(dateRange.rangeText('custom', '2026-08-01', '2026-08-31') === '8月1日 至 8月31日',
  'D1 同年区间不带年份（原口径不变）')
ok(dateRange.rangeText('custom', '2025-12-20', '2026-01-05') === '2025年12月20日 至 2026年1月5日',
  'D2 跨年区间两端带年份')
ok(dateRange.rangeText('custom', '2026-12-31', '2027-01-01') === '2026年12月31日 至 2027年1月1日',
  'D3 恰跨年界（12/31 → 1/1）两端带年份')
ok(dateRange.rangeText('custom', '2027-01-05', '2027-12-20') === '1月5日 至 12月20日',
  'D4 都在同一年（即使是未来年）不带年份')
ok(dateRange.rangeText('custom', '', '') === '所选时间段', 'D5 未完成选择兜底不变')
ok(dateRange.rangeText('month') === '本月' && dateRange.rangeText('lastMonth') === '上月',
  'D6 其他档位文案不变')

// =====================================================================
console.log('\n== E. 静态契约 ==')
const idxJs = read('pages/index/index.js')
ok(idxJs.indexOf('util.isCrossYearDate(d.created_at) ? tagFit.WIDTHS.dateWidthCrossYear : 0') > 0,
  'E1 列表页把跨年日期宽度传给了标签自适应')
ok(idxJs.indexOf('d.dateText = util.formatRelativeTime(d.created_at, true)') > 0,
  'E2 列表页日期文案仍走 formatRelativeTime(compact)')
ok(read('utils/storage.js').indexOf('for (let i = 0; i < 365; i++)') === -1,
  'E3 365 硬封顶已从 storage.js 绝迹')
ok(storageSrc.indexOf('[streak-uncap v1]') > 0, 'E4 streak 修复带标记 [streak-uncap v1]')
ok(read('utils/util.js').indexOf('isCrossYearDate,') > 0, 'E5 util 导出清单含 isCrossYearDate')
ok(read('utils/tagFit.js').indexOf('dateWidthCrossYear') > 0, 'E6 tagFit 含跨年宽度档')

// =====================================================================
console.log('\n---- 汇总 ----')
console.log('SUITES test_cross_year, passed ' + pass + ', failed ' + fail)
process.exit(fail ? 1 : 0)
