/**
 * tools/test_date_range.js
 * [range-toolbar v1] 日期范围公共层 + 日记本工具行改造 的回归套件。
 * 覆盖：
 *   A. utils/dateRange.js 纯函数（RANGE_LIST / labelOf / resolveRange / filterByRange /
 *      rangeDateKeys / rangeText，含 now 注入、边界日、无日期排除）
 *   B. components/range-picker 静态契约（选完即生效、取消丢弃草稿、rp- 前缀）
 *   C. pages/index 接线（工具行 / 四态导出 / 范围提示 / 范围空态 / 导入清范围）
 *   D. pages/summary 接线（旧弹层移除 / 公共口径）
 *   E. index.js 行为测试（vm 桩：范围×搜索联动、导出四态标题、清除范围）
 * 运行：node tools/test_date_range.js（全绿退出码 0）
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

// =====================================================================
console.log('---- A. utils/dateRange.js 纯函数 ----')
const dateRange = require('../utils/dateRange.js')

ok(Array.isArray(dateRange.RANGE_LIST) && dateRange.RANGE_LIST.length === 5, 'RANGE_LIST 5 项')
ok(dateRange.RANGE_LIST.map(r => r.key).join(',') === 'all,month,lastMonth,week7,custom', 'key 顺序固定')
ok(dateRange.RANGE_LIST[4].label === '自定义起止日期', 'custom 选项文案「自定义起止日期」')

ok(dateRange.labelOf('all') === '全部时间', 'labelOf(all)')
ok(dateRange.labelOf('week7') === '近 7 天', 'labelOf(week7)')
ok(dateRange.labelOf('custom') === '自定义日期', 'labelOf(custom) → 短文案「自定义日期」')

// now 注入：2026-09-20 12:00（周日）
const NOW = new Date(2026, 8, 20, 12, 0, 0)

let r = dateRange.resolveRange('all', '', '', NOW)
ok(r.start === null && r.end === null, 'all → 双 null（不限）')

r = dateRange.resolveRange('month', '', '', NOW)
ok(r.start === new Date(2026, 8, 1).getTime(), 'month start = 本月1日 00:00')
ok(r.end === null, 'month 无上限')

r = dateRange.resolveRange('lastMonth', '', '', NOW)
ok(r.start === new Date(2026, 7, 1).getTime(), 'lastMonth start = 上月1日')
ok(r.end === new Date(2026, 8, 1).getTime() - 1, 'lastMonth end = 上月最后一毫秒')

r = dateRange.resolveRange('week7', '', '', NOW)
ok(r.start === new Date(2026, 8, 14).getTime(), 'week7 start = 7天前 00:00（9月14日）')
ok(r.end === null, 'week7 无上限')

r = dateRange.resolveRange('custom', '2026-08-01', '2026-08-31', NOW)
ok(r.start === new Date(2026, 7, 1, 0, 0, 0).getTime(), 'custom start = cs 00:00')
ok(r.end === new Date(2026, 7, 31, 23, 59, 59, 999).getTime(), 'custom end = ce 23:59:59.999（闭区间）')

r = dateRange.resolveRange('custom', '2026-08-01', '', NOW)
ok(r.start === null && r.end === null, 'custom 未选完 → 双 null（未完成不生效）')

function ts(y, m, d, hh, mm, ss) { return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0).getTime() }
const LIST = [
  { id: 1, created_at: new Date(ts(2026, 9, 1, 8)).toISOString() },   // 本月
  { id: 2, created_at: new Date(ts(2026, 9, 20, 23, 59)).toISOString() }, // 今天深夜
  { id: 3, created_at: new Date(ts(2026, 8, 15, 10)).toISOString() }, // 上月
  { id: 4, created_at: new Date(ts(2026, 3, 5, 10)).toISOString() },  // 更早
  { id: 5, created_at: '' },                                          // 无日期
  { id: 6, created_at: 'not-a-date' }                                 // 非法日期
]

ok(dateRange.filterByRange(LIST, 'all', '', '', NOW) === LIST, 'all 原样返回（同引用，不过滤不排序）')

r = dateRange.filterByRange(LIST, 'month', '', '', NOW)
ok(r.map(d => d.id).join(',') === '1,2', 'month：含 9月1日早8点与今天深夜，排除上月/更早/无日期')

r = dateRange.filterByRange(LIST, 'lastMonth', '', '', NOW)
ok(r.map(d => d.id).join(',') === '3', 'lastMonth：只含 8月15日')

r = dateRange.filterByRange(LIST, 'week7', '', '', NOW)
ok(r.map(d => d.id).join(',') === '2', 'week7：只含今天（9月1日已是 7 天外）')

r = dateRange.filterByRange(LIST, 'custom', '2026-08-01', '2026-08-15', NOW)
ok(r.map(d => d.id).join(',') === '3', 'custom 闭区间：含 ce 当天任意时刻')

r = dateRange.filterByRange(LIST, 'custom', '2026-09-01', '2026-09-01', NOW)
ok(r.map(d => d.id).join(',') === '1', 'custom 单日区间命中')

r = dateRange.filterByRange(LIST, 'custom', '', '', NOW)
ok(r === LIST, 'custom 未完成 → 视为不限（原样返回）')

r = dateRange.rangeDateKeys('custom', '2026-08-01', '2026-08-31', NOW)
ok(r.start === '2026-08-01' && r.end === '2026-08-31', 'rangeDateKeys(custom) 原样回传')
r = dateRange.rangeDateKeys('month', '', '', NOW)
ok(r.start === '2026-09-01' && r.end === '2026-09-20', 'rangeDateKeys(month)')
r = dateRange.rangeDateKeys('lastMonth', '', '', NOW)
ok(r.start === '2026-08-01' && r.end === '2026-08-31', 'rangeDateKeys(lastMonth)')
r = dateRange.rangeDateKeys('week7', '', '', NOW)
ok(r.start === '2026-09-14' && r.end === '2026-09-20', 'rangeDateKeys(week7)')
r = dateRange.rangeDateKeys('all', '', '', NOW)
ok(r.start === '' && r.end === '', 'rangeDateKeys(all) → 空串')

ok(dateRange.rangeText('month') === '本月', 'rangeText(month)')
ok(dateRange.rangeText('custom', '2026-08-01', '2026-08-31') === '8月1日 至 8月31日', 'rangeText(custom)')
ok(dateRange.rangeText('custom', '', '') === '所选时间段', 'rangeText(custom 未完成) 兜底')
ok(dateRange.rangeText('all') === '全部时间', 'rangeText(all)')
// [date-year v1] 跨年区间两端带年份；同年区间保持原样（上方 8月1日 至 8月31日 断言）
ok(dateRange.rangeText('custom', '2025-12-20', '2026-01-05') === '2025年12月20日 至 2026年1月5日',
  'rangeText(custom 跨年) 两端带年份')
ok(dateRange.rangeText('custom', '2026-12-20', '2027-01-05') === '2026年12月20日 至 2027年1月5日',
  'rangeText(custom 跨年) 跨到再下一年同样带年份')

// =====================================================================
console.log('---- B. components/range-picker 静态契约 ----')
const CP = 'components/range-picker/range-picker'
ok(fs.existsSync(path.join(ROOT, CP + '.js')) &&
   fs.existsSync(path.join(ROOT, CP + '.wxml')) &&
   fs.existsSync(path.join(ROOT, CP + '.wxss')) &&
   fs.existsSync(path.join(ROOT, CP + '.json')), '组件四件套存在')
ok(JSON.parse(rd(CP + '.json')).component === true, '组件 json component:true')

const cpjs = rd(CP + '.js')
ok(cpjs.indexOf("require('../../utils/dateRange.js')") !== -1, '组件口径唯一来源 = utils/dateRange.js')
ok(cpjs.indexOf('_tryApplyCustom') !== -1 && cpjs.indexOf('_emit') !== -1, '选完即生效逻辑存在')
ok(cpjs.indexOf("triggerEvent('change'") !== -1, '对外只发 change 事件')
ok(cpjs.indexOf('getRange()') !== -1 && cpjs.indexOf('reset()') !== -1, '提供 getRange/reset 方法')
ok(cpjs.indexOf("开始日期不能晚于结束日期") !== -1, '起止倒置有拦截')
ok(cpjs.indexOf('_snapshot') !== -1, '弹层打开有快照（取消丢弃草稿）')

const cpwxml = rd(CP + '.wxml')
ok(cpwxml.indexOf('draftKey') !== -1, '弹层内草稿选项机制（未生效不污染已生效范围）')
ok(cpwxml.indexOf('sheet-btn') === -1 && cpwxml.indexOf('confirmRange') === -1, 'no-confirm-btn: 无确定按钮（4.A 选完即生效）')
ok(cpwxml.indexOf('closeSheet') !== -1, '点遮罩关闭（丢弃未生效草稿）')

const cpwxss = rd(CP + '.wxss')
ok(cpwxss.indexOf('.rp-pill') !== -1 && cpwxss.indexOf('.rp-sheet') !== -1, '样式 rp- 前缀')
ok(cpwxss.indexOf('.range-pill') === -1 && cpwxss.indexOf('.range-sheet') === -1, '无旧类名残留（防拷贝忘改）')
ok(cpwxss.indexOf('padding: 10rpx 28rpx') !== -1, '胶囊视觉沿用旧样式（padding 10/28）')
ok(cpwxss.indexOf('env(safe-area-inset-bottom)') !== -1, '弹层底部安全区适配保留')

// =====================================================================
console.log('---- C. pages/index 接线 ----')
const ijson = JSON.parse(rd('pages/index/index.json'))
ok(ijson.usingComponents && ijson.usingComponents['range-picker'] === '/components/range-picker/range-picker', 'index.json 注册 range-picker')

const iwxml = rd('pages/index/index.wxml')
ok(iwxml.indexOf('<range-picker id="rangePicker"') !== -1 && iwxml.indexOf('bind:change="onRangeChange"') !== -1, 'index.wxml 接入组件')
ok(iwxml.indexOf('stats-bar') === -1 && iwxml.indexOf('总日记') === -1 && iwxml.indexOf('连续天数') === -1, '统计栏整体删除')
ok(iwxml.indexOf('toolbar-row') !== -1 && iwxml.indexOf('导出以下日记') !== -1 && iwxml.indexOf('导入以前日记') !== -1, '工具行 + 两个操作块名称都显示（导入文案 = 导入以前日记）[index-ui2 v1]')
ok(iwxml.indexOf('search-action') === -1, '搜索栏旧图标按钮已移除')
ok(iwxml.indexOf('rangeKey !== \'all\'') !== -1 && iwxml.indexOf('清除范围') !== -1, '范围提示行（可一键清除）')
ok(iwxml.indexOf('该日期范围内没有日记') !== -1 && iwxml.indexOf('undatedCount') !== -1, '范围空态 + 无日期篇数提示')
ok(iwxml.indexOf('class="empty-import"') === -1, '空态「导入日记」按钮已移出日记本页 [empty-import-move v1]')
ok(iwxml.indexOf('暂无日记，导入你之前的日记或者直接写一篇吧') !== -1,
  '空态文案与写日记页侧栏统一（拍板 1.B）')

const ijs = rd('pages/index/index.js')
ok(ijs.indexOf("require('../../utils/dateRange.js')") !== -1, 'index.js 引入公共口径')
ok(ijs.indexOf('stats') === -1 && ijs.indexOf('getStats') === -1, 'stats / getStats 调用清除')
ok(ijs.indexOf('applyRange()') !== -1 && ijs.indexOf('onRangeChange(e)') !== -1 && ijs.indexOf('clearRange()') !== -1, '范围三方法存在')
ok(ijs.indexOf('dateRange.filterByRange') !== -1, '过滤走公共纯函数')
ok(ijs.indexOf('rangeDiaries.filter') !== -1 && ijs.indexOf('this.data.allDiaries.filter') === -1, '搜索在范围集上进行')
ok(ijs.indexOf("'导出范围内搜索结果'") !== -1 && ijs.indexOf("'导出该日期范围的日记'") !== -1, 'export-titles: 四态导出标题齐备')
ok(ijs.indexOf("title === '导出全部日记'") === -1 && ijs.indexOf("'导出全部日记'") !== -1, '全量导出标题保留')
ok(ijs.indexOf('rp.reset()') !== -1, '导入成功后清范围（组件 reset）')

const iwxss = rd('pages/index/index.wxss')
ok(iwxss.indexOf('.stats-bar') === -1 && iwxss.indexOf('.stat-num') === -1, '统计栏样式删除')
ok(iwxss.indexOf('.search-action') === -1, '旧图标按钮样式删除')
ok(iwxss.indexOf('.toolbar-action') !== -1 && iwxss.indexOf('.toolbar-action-text') !== -1, '工具行操作块样式存在')
// [index-ui2 v1] 名称加粗一号：20 -> 22rpx + 600；同时加宽操作块防 nowrap 溢出
ok(iwxss.indexOf('.toolbar-action-text {\n  font-size: 22rpx;\n  font-weight: 600;') !== -1,
  '导出/导入名称加粗一号（22rpx + font-weight 600）')
ok(iwxss.indexOf('.toolbar-action {') !== -1 && iwxss.indexOf('width: 140rpx;') !== -1,
  '操作块加宽到 140rpx（容纳 6 字 22rpx 半粗，不溢出）')

// =====================================================================
console.log('---- D. pages/summary 接线 ----')
const sjson = JSON.parse(rd('pages/summary/summary.json'))
ok(sjson.usingComponents && sjson.usingComponents['range-picker'] === '/components/range-picker/range-picker', 'summary.json 注册 range-picker')

const swxml = rd('pages/summary/summary.wxml')
ok(swxml.indexOf('<range-picker id="rangePicker"') !== -1, 'summary.wxml 接入组件')
ok(swxml.indexOf('range-sheet') === -1 && swxml.indexOf('range-mask') === -1 && swxml.indexOf('sheet-btn') === -1 && swxml.indexOf('filter-row') === -1, '旧内联弹层整体移除')

const sjs = rd('pages/summary/summary.js')
ok(sjs.indexOf('RANGE_LIST') === -1 && sjs.indexOf('filterDiaries') === -1, '旧选项表/过滤函数移除')
ok(sjs.indexOf('getRangeDate') === -1 && sjs.indexOf('getRangeText') === -1, '旧起止键/文案函数移除（走公共口径）')
ok(sjs.indexOf('showRangePicker') === -1, '旧弹层状态移除')
ok(sjs.indexOf('this._rangeState') !== -1 && sjs.indexOf('onRangeChange(e)') !== -1, '范围状态由组件 change 维护')
ok(sjs.indexOf('dateRange.filterByRange') !== -1 && sjs.indexOf('dateRange.rangeDateKeys') !== -1 && sjs.indexOf('dateRange.rangeText') !== -1, '三个公共函数接入')

const swxss = rd('pages/summary/summary.wxss')
ok(swxss.indexOf('.filter-row') === -1 && swxss.indexOf('.range-pill') === -1 && swxss.indexOf('.range-sheet') === -1 && swxss.indexOf('.sheet-btn') === -1, '旧弹层样式删除（已入组件）')
ok(swxss.indexOf('.input-card') !== -1, '本页其余样式不受影响')

// =====================================================================
console.log('---- E. index.js 行为测试（vm 桩）----')
// 桩全局环境后加载 pages/index/index.js，直接驱动页面方法验证范围×搜索联动与四态导出
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  getApp: () => ({ globalData: {} }),
  wx: {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getWindowInfo: () => ({ safeArea: { bottom: 0 }, screenHeight: 800 }),
    getSystemInfoSync: () => ({ safeArea: { bottom: 0 }, screenHeight: 800 }),
    showToast: (o) => { sandbox.__toast = o },
    showModal: (o) => { sandbox.__modal = o },
    stopPullDownRefresh: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    navigateTo: () => {},
    reLaunch: () => {},
    cloud: {},
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager: () => ({ writeFile: () => {} }),
    shareFileMessage: () => {}
  }
}
let pageOptions = null
sandbox.Page = (o) => { pageOptions = o }
sandbox.Component = () => {}
sandbox.require = require
sandbox.module = { exports: {} }
sandbox.exports = sandbox.module.exports
sandbox.__filename = path.join(ROOT, 'pages', 'index', 'index.js')
sandbox.__dirname = path.join(ROOT, 'pages', 'index')
vm.createContext(sandbox)
// 让 index.js 内的 require('../../utils/...') 正确解析：注入以 __dirname 为基准的 require
sandbox.require = (p) => require(path.join(ROOT, 'pages', 'index', p))

const idxSrc = rd('pages/index/index.js')
vm.runInContext(idxSrc, sandbox, { filename: 'index.js' })
ok(!!pageOptions, 'Page() 捕获成功')

// 构造页面实例：注入桩 data（跳过 loadData / storage 依赖）
function makePage(data) {
  const inst = Object.assign({}, pageOptions)
  inst.data = JSON.parse(JSON.stringify(data))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  inst.selectComponent = () => null // 无组件环境：clearRange/reset 走 setData 兜底路径
  return inst
}

// 模拟 onSearchInput 的完整行为：先写 searchKeyword 再过滤（applySearch 自身不写 keyword）
function doSearch(p, kw) {
  p.setData({ searchKeyword: kw })
  p.applySearch(kw)
}

const D1 = new Date(ts(2026, 9, 1, 8)).toISOString()      // 9月1日
const D2 = new Date(ts(2026, 8, 15, 10)).toISOString()    // 8月15日
const D3 = new Date(ts(2026, 9, 19, 9)).toISOString()     // 9月19日
const BASE_DATA = {
  diaries: [], allDiaries: [
    { id: 'a', title: '九月爬山', content: '九月爬山去了', created_at: D1, tags: [], weather: null },
    { id: 'b', title: '八月游泳', content: '八月游泳', created_at: D2, tags: [], weather: null },
    { id: 'c', title: '九月开会', content: '九月开会说爬山', created_at: D3, tags: [], weather: null },
    { id: 'd', title: '无日期', content: '无日期内容', created_at: '', tags: [], weather: null }
  ],
  rangeDiaries: [], rangeKey: 'all', rangeCs: '', rangeCe: '', rangeLabel: '全部时间',
  rangeCount: 0, undatedCount: 0,
  searchKeyword: '', isSearching: false, searchCount: 0, isEmpty: false, loading: false
}

let p = makePage(BASE_DATA)
// 旧版守卫（零崩溃纪律）：行为方法不存在时精准报红并跳过整组，不让旧版直接抛异常
const hasBehavior = typeof p.applyRange === 'function' && typeof p.onRangeChange === 'function' &&
  typeof p.clearRange === 'function' && typeof p.onExportDiaries === 'function'
ok(hasBehavior, 'E 组前置：范围行为方法存在（旧版此处精准红）')

if (hasBehavior) {
p.applyRange()
ok(p.data.rangeCount === 4 && p.data.diaries.length === 4, 'all：全量 4 篇（含无日期）')

// 切换到「本月」：清搜索、排除 8月与无日期
sandbox.__toast = null
p.onRangeChange({ detail: { range: 'month', label: '本月', customStart: '', customEnd: '' } })
ok(p.data.rangeKey === 'month' && p.data.searchKeyword === '', '切范围后搜索被清空')
ok(p.data.rangeCount === 2 && p.data.diaries.map(d => d.id).join(',') === 'a,c', '本月：2 篇（无日期被排除）')

// 搜索在范围内进行：「爬山」命中的 b 在 8 月（范围外）→ 只有 a/c 命中
doSearch(p, '爬山')
ok(p.data.isSearching === true && p.data.searchCount === 2 && p.data.diaries.map(d => d.id).join(',') === 'a,c', '搜索在范围内进行（8月的游泳篇不出现）')

// 清搜索回到范围集
p.clearSearch()
ok(p.data.diaries.length === 2 && p.data.isSearching === false, '清搜索 → 回范围集（不是全量）')

// 切回全部：无日期回来
p.onRangeChange({ detail: { range: 'all', label: '全部时间', customStart: '', customEnd: '' } })
ok(p.data.rangeCount === 4 && p.data.diaries.length === 4, '切回全部时间：无日期篇回来')

// 自定义范围 9月19日~9月20日：只有 c
p.onRangeChange({ detail: { range: 'custom', label: '自定义日期', customStart: '2026-09-19', customEnd: '2026-09-20' } })
ok(p.data.rangeCount === 1 && p.data.diaries.map(d => d.id).join(',') === 'c', '自定义范围命中单篇')

// ---- 导出四态标题 ----
sandbox.__modal = null
p.onExportDiaries()
ok(sandbox.__modal && sandbox.__modal.title === '导出该日期范围的日记' && sandbox.__modal.content.indexOf('1 篇') !== -1, '四态①：范围内导出（标题+篇数）')

doSearch(p, '开会')
sandbox.__modal = null
p.onExportDiaries()
ok(sandbox.__modal && sandbox.__modal.title === '导出范围内搜索结果', '四态②：范围内搜索导出标题')

p.onRangeChange({ detail: { range: 'all', label: '全部时间', customStart: '', customEnd: '' } })
doSearch(p, '游泳')
sandbox.__modal = null
p.onExportDiaries()
ok(sandbox.__modal && sandbox.__modal.title === '导出搜索结果', '四态③：搜索结果导出标题')

p.clearSearch()
sandbox.__modal = null
p.onExportDiaries()
ok(sandbox.__modal && sandbox.__modal.title === '导出全部日记' && sandbox.__modal.content.indexOf('4 篇') !== -1, '四态④：全部导出（含无日期）')

// 范围内无结果导出拦截
p.onRangeChange({ detail: { range: 'custom', label: '自定义日期', customStart: '2020-01-01', customEnd: '2020-01-02' } })
sandbox.__toast = null
p.onExportDiaries()
ok(sandbox.__toast && sandbox.__toast.title === '该日期范围内没有日记，无可导出', '范围内无日记 → 导出拦截')

// 清除范围（无组件桩 → setData 兜底路径）
p.clearRange()
ok(p.data.rangeKey === 'all' && p.data.rangeCount === 4, '清除范围 → 回全部时间')
} // end if (hasBehavior)

// =====================================================================
console.log('---- F. 胶囊右侧说明文字 [range-detail v1] ----')
const iwxmlF = rd('pages/index/index.wxml')
ok(iwxmlF.indexOf('diary-detail="{{true}}"') !== -1, 'index.wxml 开启 diary-detail')
const swxmlF = rd('pages/summary/summary.wxml')
ok(swxmlF.indexOf('diary-detail') === -1, 'summary.wxml 不开启 diary-detail（保持原样）')

const cpjsF = rd(CP + '.js')
ok(cpjsF.indexOf('diaryDetail: { type: Boolean, value: false }') !== -1, '组件属性 diaryDetail 默认 false')
ok(cpjsF.indexOf("this.setData({ detail: '所有日记' })") !== -1, 'attached 初始即显示「所有日记」')
ok(cpjsF.indexOf("detail: this._detailFor('all', '', '')") !== -1, 'reset() 也回「所有日记」')

let compOptionsF = null
const sandboxF = {
  console: console,
  Component: (o) => { compOptionsF = o }
}
sandboxF.require = (p) => require(path.join(ROOT, 'components', 'range-picker', p))
sandboxF.module = { exports: {} }
sandboxF.exports = sandboxF.module.exports
sandboxF.__filename = path.join(ROOT, 'components', 'range-picker', 'range-picker.js')
sandboxF.__dirname = path.join(ROOT, 'components', 'range-picker')
vm.createContext(sandboxF)
vm.runInContext(cpjsF, sandboxF, { filename: 'range-picker.js' })
const hasDetailFor = !!compOptionsF && typeof compOptionsF.methods._detailFor === 'function'
ok(hasDetailFor, 'F 组前置：组件 _detailFor 存在（旧版此处精准红）')

if (hasDetailFor) {
  function makeComp(diaryDetail) {
    return {
      properties: { diaryDetail: diaryDetail },
      _detailFor: compOptionsF.methods._detailFor
    }
  }
  const on = makeComp(true)
  ok(on._detailFor('all', '', '') === '所有日记', '全部时间 → 所有日记')
  ok(on._detailFor('month', '', '') === '本月日记', '本月 → 本月日记')
  ok(on._detailFor('lastMonth', '', '') === '上月日记', '上月 → 上月日记')
  ok(on._detailFor('week7', '', '') === '近 7 天日记', '近 7 天 → 近 7 天日记')
  ok(on._detailFor('custom', '2026-09-19', '2026-09-20') === '9月19日 至 9月20日', '自定义 → 起止日期')
  ok(on._detailFor('custom', '2026-09-19', '2026-09-20').indexOf('日记') === -1, '自定义文案不含「日记」字样')
  ok(on._detailFor('custom', '', '') === '', '自定义未完成 → 空文案')
  const off = makeComp(false)
  ok(off._detailFor('all', '', '') === '' && off._detailFor('month', '', '') === '', '总结页（默认 false）：非自定义无说明文字')
  ok(off._detailFor('custom', '2026-09-19', '2026-09-20') === '9月19日 至 9月20日', '总结页：自定义仍显示起止')
}

// =====================================================================
console.log('---- 结果 ----')
console.log(passCount + ' passed, ' + failCount + ' failed')
if (failCount > 0) process.exit(1)
