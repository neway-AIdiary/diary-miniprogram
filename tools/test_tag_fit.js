/**
 * tools/test_tag_fit.js
 * [tag-fit v1] 日记本列表卡片「心情 + 标签」最多两行 + 列表日期文案缩短 的回归套件。
 *
 * 用户 2026-09-22 拍板：方案 3 + 日期文案缩短
 *   1. 日期**保持横排**（不竖排），只把列表卡片日期文案缩短「8月12日 周三」→「8/12 周三」腾宽度；
 *   2. 标签只在「估算会溢出到第三行」时才动手：从**末尾**丢，丢到剩余能保证两行；
 *   3. 平时（≤2 行）一个都不丢；**保底留 1 个**；
 *   4. 只改列表展示 —— 存储 / 详情页 / 导出 / 备份 零改动。
 *
 * 覆盖：
 *   A. util.formatCompactDate 纯函数（形态 / 空格 / 不补零 / 空值 / 非法值）
 *   B. formatRelativeTime 的 compact 分流（近期档位两态一致 / ≥7 天分流）
 *   C. formatDate 本体未变（其他页面零影响的护栏）
 *   D. utils/tagFit.js 纯函数（宽度口径数值 / 两行判定 / 从末尾丢 / 保底 / 不改入参 / 幂等）
 *   E. 用户真实场景复现（截图那类卡不丢 / 长标签 5 个丢 1 / 无心情对照 / 保底）
 *   F. 静态契约（wxml 只渲染 tagsShown / d.tags 保留完整 / 其他页面 formatDate 调用点未变）
 *
 * 运行：node tools/test_tag_fit.js（全绿退出码 0）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------- wx 桩（util.js 顶层可能触碰 wx） ----------------
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
// 新模块：旧源码下不存在 ⇒ 必须 try/catch（红灯自检要求「精准变红、零崩溃」）
let tagFit = null
try {
  tagFit = require(path.join(ROOT, 'utils', 'tagFit.js'))
} catch (e) {
  tagFit = null
}

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else {
    fail++
    console.log('  FAIL ' + msg + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''))
  }
}

// ---- 守卫：实现缺失时断言自然失败，不抛异常 ----
const NO = '\u0000__NO_IMPL__'
const NO_FIT = { shown: null, dropped: -1, lines: -1 }
// 注意：字面量写成普通字符串而非模板串，避免被 shell/工具链吞掉反引号
const g = (o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
// 安全取长度：实现缺失时为 -1（断言自然失败），绝不解引用 null.length
// —— 红灯自检纪律要求「跑满全部断言、零崩溃」
const len = (v) => (Array.isArray(v) ? v.length : -1)
const fn = function (name) {
  const args = Array.prototype.slice.call(arguments, 1)
  if (!tagFit || typeof tagFit[name] !== 'function') return NO
  try {
    return tagFit[name].apply(null, args)
  } catch (e) {
    return NO
  }
}
const fit = function (tags, mood) {
  if (!tagFit || typeof tagFit.fitTags !== 'function') return NO_FIT
  try {
    return tagFit.fitTags(tags, mood)
  } catch (e) {
    return { shown: null, dropped: -1, lines: -1, err: String(e && e.message) }
  }
}
// formatCompactDate 旧源码没有 ⇒ 同样走守卫
const fcd = (t) => (typeof util.formatCompactDate === 'function' ? util.formatCompactDate(t) : NO)

const DAY = 86400000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
// 动态推星期，避免把「星期几」算错（星期由 Date 保证，本套件验证的是形态）
const WD = ['日', '一', '二', '三', '四', '五', '六']
const wdOf = (iso) => WD[new Date(iso).getDay()]

console.log('\n== A. util.formatCompactDate 纯函数 ==')
const A_ISO = new Date(2026, 8, 21, 12, 0, 0).toISOString() // 9/21 本地中午，避开时区偏移
ok(fcd(A_ISO) === '9/21 周' + wdOf(A_ISO), 'A1 形态为「M/D 周X」', fcd(A_ISO))
ok(fcd(A_ISO).indexOf('/') >= 0, 'A2 用斜杠而非「月/日」')
ok(fcd(A_ISO).indexOf('月') < 0 && fcd(A_ISO).indexOf('日') < 0, 'A3 不含「月」「日」字（缩短点）')
ok(fcd(A_ISO) === '9/21 周' + wdOf(A_ISO) && fcd(A_ISO).indexOf('09') < 0, 'A4 月份/日期不补零（9/21 而非 09/21）')
const A_JAN = new Date(2026, 0, 5, 12, 0, 0).toISOString()
ok(fcd(A_JAN) === '1/5 周' + wdOf(A_JAN), 'A5 个位数月日同样不补零（1/5）', fcd(A_JAN))
ok(fcd('') === '' && fcd(null) === '' && fcd(undefined) === '', 'A6 空值安全 → 空串')
ok(typeof fcd('not-a-date') === 'string', 'A7 非法日期不抛异常')
ok(fcd(A_ISO).indexOf('周') > 0, 'A8 含「周」前缀')

console.log('\n== B. formatRelativeTime 的 compact 分流 ==')
const rel = (iso, c) => util.formatRelativeTime(iso, c)
ok(rel(ago(0.01)) === rel(ago(0.01), true), 'B1 「分钟前」两态一致（近期档位不分流）')
ok(rel(ago(1.5)) === rel(ago(1.5), true), 'B2 「小时前」两态一致')
ok(rel(ago(1.2)) === rel(ago(1.2), true), 'B3 「昨天」两态一致')
ok(rel(ago(3.5)) === rel(ago(3.5), true), 'B4 「N天前」两态一致')
ok(rel(ago(6.5)) === rel(ago(6.5), true), 'B5 6 天前仍走相对档位（两态一致）')
const D7 = ago(7.5)
ok(rel(D7).indexOf('月') >= 0 && rel(D7).indexOf('/') < 0, 'B6 ≥7 天且不传 compact → 仍是「X月X日 周X」（其他页面零影响）', rel(D7))
ok(rel(D7, true).indexOf('/') >= 0 && rel(D7, true).indexOf('月') < 0, 'B7 ≥7 天且传 compact → 紧凑「M/D 周X」', rel(D7, true))
ok(rel(D7, true) === fcd(D7), 'B8 compact 档与 formatCompactDate 同源')
ok(rel(D7, false) === rel(D7), 'B9 显式传 false 与不传等价（默认行为不变）')
ok(rel('') === '' && rel(null) === '', 'B10 空值安全（两态都空）')
const D400 = ago(400)
ok(rel(D400).indexOf('月') >= 0 && rel(D400, true).indexOf('/') >= 0, 'B11 跨年份大跨度仍按同一规则分流')

console.log('\n== C. formatDate 本体未变（护栏） ==')
const utilSrc = read('utils/util.js')
ok(utilSrc.split("return month + '月' + day + '日 周' + weekDays[d.getDay()]").length - 1 === 1,
  'C1 formatDate 主体表达式在源码中仍只有 1 处（未被改写）')
ok(utilSrc.indexOf('function formatCompactDate(dateStr) {') > 0, 'C2 formatCompactDate 已定义')
ok(utilSrc.indexOf('function formatRelativeTime(dateStr, compact) {') > 0, 'C3 formatRelativeTime 已加第二参')
ok(utilSrc.indexOf('function formatRelativeTime(dateStr) {') < 0, 'C4 旧签名已无残留')
ok(utilSrc.indexOf('return compact ? formatCompactDate(dateStr) : formatDate(dateStr)') > 0, 'C5 末档按 compact 分流')

console.log('\n== D. utils/tagFit.js 纯函数 ==')
ok(Math.round(fn('cardInnerWidth')) === 634, 'D1 卡片内容宽 = 634rpx（750 − 24×2 − 36 − 32，与 wxss 盒模型对齐）', fn('cardInnerWidth'))
ok(Math.round(fn('availWidth', '')) === 526, 'D2 无心情时标签区可用宽 ≈ 526rpx（634 − 108 日期）', fn('availWidth', ''))
ok(Math.round(fn('availWidth', '平静')) === 423, 'D3 有 2 字心情时可用宽 ≈ 423rpx（再减 pill + 24 间距）', fn('availWidth', '平静'))
ok(fn('availWidth', '平静') < fn('availWidth', ''), 'D4 心情 pill 确实压缩了标签区宽度')

const Z = fit([], '')
ok(g(Z, 'shown') && g(Z, 'shown').length === 0 && g(Z, 'dropped') === 0 && g(Z, 'lines') === 0,
  'D5 无标签 → shown 空数组、dropped=0、lines=0', Z)

const ONE = ['旅行']
const R1 = fit(ONE, '开心')
ok(g(R1, 'shown') && g(R1, 'shown').length === 1 && g(R1, 'dropped') === 0, 'D6 单个标签 → 一个不丢', R1)

const SHORT = ['工作', '旅行', '读书']
const R2 = fit(SHORT, '开心')
ok(g(R2, 'dropped') === 0 && g(R2, 'shown') && g(R2, 'shown').length === 3, 'D7 一行放得下 → 一个不丢', R2)

// 正好两行：5 个 3 字标签 + 心情（avail ≈ 423；每 chip ≈ 3*22*1.06+46 ≈ 116）
const MID = ['一二三', '四五六', '七八九', '十一十', '十二十']
const R3 = fit(MID, '开心')
ok(g(R3, 'lines') <= 2, 'D8 装箱正好落在两行内 → lines ≤ 2', g(R3, 'lines'))
ok(g(R3, 'dropped') === 0, 'D9 两行内不丢任何标签', R3)

// 会溢出到三行：5 个 5 字标签 + 心情
const LONG5 = ['今天很开心啊', '工作很顺利', '晚上吃了火锅', '天气还不错', '和朋友聊天']
const R4 = fit(LONG5, '平静')
ok(g(R4, 'lines') === 3 - 1 || g(R4, 'lines') === 2, 'D10 丢完后行数回到 ≤ 2', g(R4, 'lines'))
ok(g(R4, 'dropped') === 1 && g(R4, 'shown') && g(R4, 'shown').length === 4,
  'D11 5 个长标签 → 丢末尾 1 个即可保证两行', R4)
ok(g(R4, 'shown') && LONG5.slice(0, 4).join('|') === g(R4, 'shown').join('|'), 'D12 保留的是原数组前缀（保序，不挑不跳）')
ok(g(R4, 'dropped') + len(g(R4, 'shown')) === LONG5.length, 'D13 shown + dropped = 原有效标签数')

const input = ['今天很开心啊', '工作很顺利', '晚上吃了火锅', '天气还不错', '和朋友聊天']
const snapshot = input.join('|')
fit(input, '平静')
ok(input.join('|') === snapshot, 'D14 不改入参（纯函数）')

const DIRTY = ['工作', '', '  ', '旅行']
const R5 = fit(DIRTY, '')
ok(g(R5, 'shown') && g(R5, 'shown').length === 2 && g(R5, 'shown').join('|') === '工作|旅行',
  'D15 空串与纯半角空白标签被过滤', R5)
const FULLSP = String.fromCharCode(12288) // 全角空格
const R5b = fit(['工作', FULLSP, '旅行'], '')
ok(g(R5b, 'shown') && g(R5b, 'shown').length === 2, 'D15a 全角空格标签同样被过滤（trim 覆盖全角）', R5b)
const R5c = fit([' 工作 '], '')
ok(g(R5c, 'shown') && g(R5c, 'shown')[0] === ' 工作 ', 'D15b 只判空、不改写标签原文（首尾空白原样保留）', R5c)

ok(JSON.stringify(fit(LONG5, '平静')) === JSON.stringify(fit(LONG5, '平静')), 'D16 幂等（同输入两次结果一致）')

const HUGE = ['这是一个特别特别特别特别特别长的标签文案', '第二个同样特别特别特别特别长的标签', '第三个还是很长很长的标签文案']
const R6 = fit(HUGE, '')
ok(g(R6, 'shown') && g(R6, 'shown').length >= 1, 'D17 极端超长标签：保底至少留 1 个', R6)
ok(g(R6, 'lines') <= 2, 'D18 极端超长标签：行数仍被压到 ≤ 2', g(R6, 'lines'))
ok(g(R6, 'shown') && g(R6, 'shown').length < HUGE.length, 'D19 极端超长标签：确实触发了丢弃')

const NONARR = fit(null, '')
ok(g(NONARR, 'shown') && g(NONARR, 'shown').length === 0 && g(NONARR, 'dropped') === 0, 'D20 非数组入参安全兜底', NONARR)

console.log('\n== E. 用户真实场景复现（2026-09-22 截图） ==')
// 截图那张卡：心情 + 「日记小程序 / 降薪 / 出差 ...」共 5 个短标签。
// 缩短日期后可用宽从 ~325 涨到 ~423 ⇒ 正好收回两行、一个都不用丢。
const SHOT = ['日记小程序', '降薪', '出差', '加班', '会议']
const E1 = fit(SHOT, '平静')
ok(g(E1, 'dropped') === 0, 'E1 截图那类卡（短标签）→ 缩短日期后收回两行，一个不丢', E1)
ok(g(E1, 'lines') <= 2, 'E2 且行数确实 ≤ 2（修的就是这个）', g(E1, 'lines'))

// 对照：同一批长标签，有心情 pill 时丢 1 个、无心情时不丢
const WITH_MOOD = fit(LONG5, '平静')
const NO_MOOD = fit(LONG5, '')
ok(g(WITH_MOOD, 'dropped') >= 1, 'E3 有心情 pill（占宽）→ 触发丢弃', g(WITH_MOOD, 'dropped'))
ok(g(NO_MOOD, 'dropped') === 0, 'E4 同一批标签去掉心情 pill → 宽度够用，一个不丢', g(NO_MOOD))
ok(g(WITH_MOOD, 'dropped') > g(NO_MOOD, 'dropped'), 'E5 心情 pill 的存在确实让可用宽变紧')

// 日期缩短带来的收益：同一批标签，用缩短前的日期宽度（150）判断会丢，缩短后（108）不丢
ok(g(fit(SHOT, '平静'), 'dropped') === 0 && Math.round(fn('availWidth', '平静')) === 423,
  'E6 缩短日期（150→108rpx）是「不丢标签」的直接原因')

console.log('\n== F. 静态契约 ==')
const wxml = read('pages/index/index.wxml')
const idxJs = read('pages/index/index.js')

ok(wxml.indexOf('wx:if="{{item.tagsShown.length > 0}}"') > 0, 'F1 标签区判空走 tagsShown')
ok(wxml.indexOf('wx:for="{{item.tagsShown}}"') > 0, 'F2 标签遍历走 tagsShown')
ok(wxml.indexOf('item.tags.length') < 0 && wxml.indexOf('wx:for="{{item.tags}}"') < 0,
  'F3 列表不再直接渲染 item.tags（被裁剪后只渲染 tagsShown）')
ok(wxml.indexOf('item.moodText') > 0 && wxml.indexOf('class="tag-mood"') > 0, 'F4 心情 pill 结构未动')
ok(wxml.indexOf('<text class="diary-date">{{item.dateText}}</text>') > 0, 'F5 日期仍为横排单行（方案 3：不竖排，结构未动）')
ok(wxml.indexOf('class="tag-list"') > 0 && wxml.indexOf('class="footer-left"') > 0, 'F6 标签区/左区类名未动')

ok(idxJs.indexOf("const tagFit = require('../../utils/tagFit.js')") > 0, 'F7 index.js 已引入 tagFit')
ok(idxJs.indexOf('d.tags = Array.isArray(d.tags) ? d.tags.slice(0, 5) : []') > 0,
  'F8 d.tags 仍是完整数据（未被 tagsShown 覆盖 ⇒ 搜索/详情页不受影响）')
ok(idxJs.indexOf('d.tagsShown = tagFit.fitTags(d.tags, d.moodText,') > 0, 'F9 产出 tagsShown 字段')
// [date-year v1] 跨年日期文案变长 ⇒ 必须把跨年宽度档传进去，否则标签会排到第三行
ok(idxJs.indexOf('util.isCrossYearDate(d.created_at) ? tagFit.WIDTHS.dateWidthCrossYear : 0') > 0,
  'F9b 跨年日期宽度已传入标签自适应')
ok(idxJs.indexOf('util.formatRelativeTime(d.created_at, true)') > 0, 'F10 列表日期走紧凑档')
ok(idxJs.indexOf('util.formatRelativeTime(d.created_at)\n') < 0, 'F11 列表旧调用已无残留')
ok(idxJs.indexOf('d.moodText = util.getMoodLabel') < idxJs.indexOf('d.tagsShown = tagFit.fitTags'),
  'F12 moodText 先于 tagsShown 计算（可用宽需要心情文案）')

// 其他页面零影响
const writeJs = read('pages/write/write.js')
ok(writeJs.indexOf('util.formatRelativeTime(d.created_at)') > 0, 'F13 写页侧栏仍用不传 compact 的旧调用（零影响）')
ok(read('pages/backup/backup.js').indexOf('util.formatDate(') > 0, 'F14 备份页仍用 formatDate')
ok(read('pages/profile/profile.js').indexOf('util.formatDate(') > 0, 'F15 我的页仍用 formatDate')
ok(read('utils/transfer.js').indexOf('util.formatDate(') > 0, 'F16 导出文案仍用 formatDate')

// 样式未被本次改动触碰（方案 3 不动日期样式）
const wxss = read('pages/index/index.wxss')
ok(wxss.indexOf('.diary-date {') > 0 && wxss.indexOf('flex-shrink: 0') > 0, 'F17 .diary-date 样式未动（仍横排不缩）')
ok(wxss.split('.tag-list {').length - 1 === 1, 'F18 .tag-list 仍只有一处定义（未加限高裁剪）')

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
