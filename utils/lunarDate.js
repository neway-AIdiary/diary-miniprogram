/**
 * lunarDate —— 每日一签「日期头」的数据源 [quote-date v1]
 *
 * - 农历/星期来自 utils/solarlunar.min.js（solarlunar v3.1.0，纯前端本地换算，
 *   支持 1900.1.31 ~ 2100.12.31；离线可用、零域名、零审核）
 * - 星座为本地公式（公历月日分界），与农历库解耦
 * - 纯函数：不碰 setData / wx.*，可被 tools/test_quote_date.js 直接单测
 * - 拍板口径 [quote-date v2]：1.B 节气常驻（显示当前所处节气段 + emoji 图标，不要【】）；
 *   农历行带干支年（丙午年八月十一）；2.A ‹›翻日紧贴「诗词」标签右侧（结构与样式在页面层）
 */

const solarLunarMod = require('./solarlunar.min.js')
const solarLunar = solarLunarMod.default || solarLunarMod

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

// 星座分界（公历）：每项 = [起始月, 起始日, 星座名]；落在起始日及之后归该星座，
// 否则归上一个。默认摩羯座（1.1~1.19 的跨年段 + 12.22~12.31 都由匹配/默认覆盖）。
const CONSTELLATION_STARTS = [
  [1, 20, '水瓶座'], [2, 19, '双鱼座'], [3, 21, '白羊座'], [4, 20, '金牛座'],
  [5, 21, '双子座'], [6, 22, '巨蟹座'], [7, 23, '狮子座'], [8, 23, '处女座'],
  [9, 23, '天秤座'], [10, 24, '天蝎座'], [11, 23, '射手座'], [12, 22, '摩羯座']
]

function constellationOf(month, day) {
  let name = '摩羯座' // 默认：1.1~1.19 与 12.22~12.31
  for (let i = 0; i < CONSTELLATION_STARTS.length; i++) {
    const it = CONSTELLATION_STARTS[i]
    if (month > it[0] || (month === it[0] && day >= it[1])) name = it[2]
  }
  return name
}

// ===== 24 节气 [quote-date v2]（1.B 节气常驻：显示当前所处节气段）=====
// 顺序与 solarlunar getTerm(y, n) 的 n=1..24 一一对应（n=1 小寒 … n=24 冬至）
const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'
]

// 节气 emoji 图标（工程图标字体无节气刻面，按用户提供的清单映射）
const TERM_ICONS = {
  立春: '🌱', 雨水: '🌧️', 惊蛰: '🐛', 春分: '🌍', 清明: '🌿', 谷雨: '🌾',
  立夏: '☀️', 小满: '🌾', 芒种: '🌾', 夏至: '☀️', 小暑: '🔥', 大暑: '🌞',
  立秋: '🍂', 处暑: '💨', 白露: '💧', 秋分: '🍁', 寒露: '💧', 霜降: '❄️',
  立冬: '🍂', 小雪: '❄️', 大雪: '☃️', 冬至: '🌑', 小寒: '🥶', 大寒: '⛄'
}

// 某天所处的节气段 = 最近一个已到的节气（当天恰逢节气算新段第一天）。
// 年内从 n=24 往回扫（节气日期年内严格递增，命中即返回）；
// 1 月上旬小寒之前扫不到 → 跨年取上一年冬至（12 月下旬）。
function termOf(date) {
  const d = date instanceof Date ? date : new Date()
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  try {
    for (let n = 24; n >= 1; n--) {
      const td = solarLunar.getTerm(y, n)
      if (!(td >= 1 && td <= 31)) continue // 速查表异常兜底
      const nm = Math.ceil(n / 2)
      if (m > nm || (m === nm && day >= td)) {
        return { name: TERM_NAMES[n - 1], icon: TERM_ICONS[TERM_NAMES[n - 1]] || '' }
      }
    }
  } catch (e) { /* 超出支持区间：走下方跨年兜底 */ }
  try {
    const td = solarLunar.getTerm(y - 1, 24)
    if (td >= 1 && td <= 31) return { name: '冬至', icon: TERM_ICONS['冬至'] || '' }
  } catch (e) { /* 同上，最终返回空段 */ }
  return { name: '', icon: '' }
}

/**
 * 日期头视图模型 [quote-date v2]
 * @param {Date} date 本地日期（缺省 = 现在）
 * @returns {{gregorian:string, weekday:string, constellation:string, termName:string,
 *            termIcon:string, lunarFull:string}}
 *          gregorian = '2026年09月21日'（零填充）；lunarFull = '丙午年八月十一'
 *          （干支年，solarlunar 以立春分界）；termName/icon = 当前所处节气段（1.B 常驻）
 */
function header(date) {
  const d = date instanceof Date ? date : new Date()
  const y = d.getFullYear()
  const pad = x => (x < 10 ? '0' + x : '' + x)
  const m = d.getMonth() + 1
  const day = d.getDate()
  let weekday = ''
  let lunarFull = ''
  try {
    const r = solarLunar.solar2lunar(y, m, day)
    if (r) {
      if (r.ncWeek) weekday = r.ncWeek
      if (r.gzYear && r.monthCn && r.dayCn) {
        lunarFull = r.gzYear + '年' + r.monthCn + r.dayCn
      }
    }
  } catch (e) {
    // 超出 1900~2100 支持区间等异常：农历缺省，页面仍显示公历/星期/星座（不阻塞渲染）
  }
  if (!weekday) weekday = WEEKDAYS[d.getDay()] // 兜底：库异常时星期走原生计算
  const term = termOf(d)
  return {
    gregorian: y + '年' + pad(m) + '月' + pad(day) + '日',
    weekday: weekday,
    constellation: constellationOf(m, day),
    termName: term.name,
    termIcon: term.icon,
    lunarFull: lunarFull
  }
}

module.exports = {
  header,
  constellationOf,
  termOf,
  TERM_NAMES,
  TERM_ICONS
}
