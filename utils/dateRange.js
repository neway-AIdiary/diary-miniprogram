/**
 * utils/dateRange.js
 * 日期范围公共口径（唯一来源）：日记本页（pages/index）与智能总结页（pages/summary）共用。
 * 范围 key：all | month | lastMonth | week7 | custom
 * 区间语义：闭区间 [start, end]（毫秒）；null 表示该侧不限。
 * 无日期/非法 created_at 在非 all 范围下自然排除（列表沉底展示，不算入任何区间）。
 */

const DAY = 86400000

// 弹层选项（顺序即展示顺序）
const RANGE_LIST = [
  { key: 'all', label: '全部时间' },
  { key: 'month', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'week7', label: '近 7 天' },
  { key: 'custom', label: '自定义起止日期' }
]

// 胶囊上的短文案（custom 选中后统一显示「自定义日期」，区间由 detail 文案展示）
function labelOf(range) {
  if (range === 'custom') return '自定义日期'
  const item = RANGE_LIST.find(r => r.key === range)
  return item ? item.label : '全部时间'
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// key → { start, end } 毫秒区间（null = 不限）
// 口径沿用旧 pages/summary 的 filterDiaries：
//   month     本月 1 日 00:00 起（无上限）
//   lastMonth 上月 1 日 00:00 ~ 本月 1 日 00:00 前（含上月最后一毫秒）
//   week7     今天 00:00 往前推 6 天（含今天，共 7 天）
//   custom    [cs 00:00:00.000, ce 23:59:59.999]（cs/ce 任一缺失 → 不限，视为未完成）
function resolveRange(range, customStart, customEnd, now) {
  const n = now || new Date()
  if (range === 'month') {
    return { start: new Date(n.getFullYear(), n.getMonth(), 1).getTime(), end: null }
  }
  if (range === 'lastMonth') {
    return {
      start: new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime(),
      end: new Date(n.getFullYear(), n.getMonth(), 1).getTime() - 1
    }
  }
  if (range === 'week7') {
    return { start: startOfDay(n) - 6 * DAY, end: null }
  }
  if (range === 'custom') {
    if (!customStart || !customEnd) return { start: null, end: null }
    return {
      start: new Date(customStart + 'T00:00:00').getTime(),
      end: new Date(customEnd + 'T23:59:59.999').getTime()
    }
  }
  return { start: null, end: null } // all
}

// 按范围过滤日记列表；all 原样返回（不过滤、不排序）
function filterByRange(list, range, customStart, customEnd, now) {
  const r = resolveRange(range, customStart, customEnd, now)
  if (r.start == null && r.end == null) return list
  return list.filter(d => {
    const t = new Date(d && d.created_at).getTime()
    if (isNaN(t)) return false
    if (r.start != null && t < r.start) return false
    if (r.end != null && t > r.end) return false
    return true
  })
}

// 云函数 aiSummary 入参用的起止日期键（沿用旧 getRangeDate 口径）
function rangeDateKeys(range, customStart, customEnd, now) {
  const n = now || new Date()
  const pad = x => (x < 10 ? '0' + x : '' + x)
  const key = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  if (range === 'custom' && customStart && customEnd) return { start: customStart, end: customEnd }
  if (range === 'month') {
    return { start: key(new Date(n.getFullYear(), n.getMonth(), 1)), end: key(n) }
  }
  if (range === 'lastMonth') {
    return {
      start: key(new Date(n.getFullYear(), n.getMonth() - 1, 1)),
      end: key(new Date(n.getFullYear(), n.getMonth(), 0))
    }
  }
  if (range === 'week7') {
    return { start: key(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6)), end: key(n) }
  }
  return { start: '', end: '' }
}

// 范围文案（沿用旧 getRangeText 口径，如「本月 / 近 7 天 / 9月1日 至 9月11日」）
function rangeText(range, customStart, customEnd) {
  if (range === 'month') return '本月'
  if (range === 'lastMonth') return '上月'
  if (range === 'week7') return '近 7 天'
  if (range === 'custom') {
    const cn = s => {
      const d = new Date(s + 'T00:00:00')
      return isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '月' + d.getDate() + '日'
    }
    const a = cn(customStart)
    const b = cn(customEnd)
    return (a && b) ? a + ' 至 ' + b : '所选时间段'
  }
  return '全部时间'
}

module.exports = { RANGE_LIST, labelOf, resolveRange, filterByRange, rangeDateKeys, rangeText, DAY }
