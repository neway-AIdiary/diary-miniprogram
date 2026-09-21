/**
 * tools/test_index_sort.js
 * [index-sort v1] 日记本「正序 / 倒序」排序按钮 的回归套件。
 * 用户拍板：1.A 箭头字符 + 小字；2.B 导出跟随列表。
 *
 * 覆盖：
 *   A. utils/storage.js#sortDiariesByTimeAsc 纯函数
 *      （升序 / 无日期与非法日期仍沉底 / 不改入参 / 返回新数组 / 与 Desc 序镜像 / 边界与幂等）
 *   B. index.wxml + index.wxss 静态契约（按钮位置、状态文案、类名双向对齐、走主题令牌）
 *   C. pages/index 行为（vm 桩）
 *      （默认倒序 / 双向切换 / 范围×搜索叠加 / 篇数与计数不变 / 无日期两向都沉底 / resetFilters 归位）
 *   D. 导出跟随列表（2.B）：搜索态与范围态传已排序列表；全量态传当前顺序（mock transfer 捕获）
 *   E. utils/transfer.js#exportToWord 第三参行为（子集态不传即原样；传 asc 则按时间重排；重排幂等）
 *
 * 运行：node tools/test_index_sort.js（全绿退出码 0）
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let passCount = 0
let failCount = 0
function ok(cond, msg) {
  if (cond) { passCount++ } else { failCount++; console.log('  x ' + msg) }
}
// 行为断言帮手：方法缺失或抛异常 → 判红但不中断（红灯自检纪律：断言红、零崩溃）
function tryIt(fn, msg) {
  let val
  try {
    val = fn()
  } catch (e) {
    ok(false, msg + ' [抛异常 ' + (e && e.message) + ']')
    return null
  }
  ok(!!val, msg)
  return val
}

// ---- wx 桩（内存存储）----
const clone = (v) => JSON.parse(JSON.stringify(v))
let memStore = {}
let modalAnswer = true
function freshWx() {
  memStore = {}
  modalAnswer = true
  global.wx = {
    getStorageSync: (k) => (k in memStore ? clone(memStore[k]) : ''),
    setStorageSync: (k, v) => { memStore[k] = clone(v) },
    removeStorageSync: (k) => { delete memStore[k] },
    getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10 * 1024, keys: Object.keys(memStore) }),
    showModal: () => {}, showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    navigateTo: () => {}, reLaunch: () => {}, stopPullDownRefresh: () => {},
    getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 375, windowHeight: 700 }),
    getWindowInfo: () => ({ safeArea: { bottom: 0 }, screenHeight: 800 }),
    onThemeChange: () => {}, cloud: null
  }
}
freshWx()
function requireFresh(mod) {
  const p = path.join(ROOT, mod)
  delete require.cache[require.resolve(p)]
  return require(p)
}

// =====================================================================
console.log('---- A. utils/storage.js#sortDiariesByTimeAsc 纯函数 ----')
const storage = requireFresh('utils/storage.js')
const hasAsc = typeof storage.sortDiariesByTimeAsc === 'function'
ok(hasAsc, 'sortDiariesByTimeAsc 已导出')
// 红灯守卫：旧版无此函数时补一个「原样返回」的空实现 ⇒ 失败表现为断言红而非崩溃
if (!hasAsc) storage.sortDiariesByTimeAsc = (list) => (Array.isArray(list) ? list.slice() : [])

const T = (y, m, d, h) => new Date(y, m - 1, d, h || 0).toISOString()
// 基准 = Desc 序（storage.getAllDiaries 的口径：新→旧，无日期沉底）
const ROW = [
  { id: 'n', created_at: T(2026, 9, 20, 10) },  // 最新
  { id: 'n2', created_at: T(2026, 9, 10, 10) },
  { id: 'm', created_at: T(2026, 6, 15, 10) },
  { id: 'o', created_at: T(2025, 3, 1, 10) },   // 最旧
  { id: 'u', created_at: '' },                  // 无日期
  { id: 'bad', created_at: 'not-a-date' }       // 非法日期
]
const ids = (l) => l.map((d) => d.id).join(',')
const descIds = ids(ROW)
ok(descIds === 'n,n2,m,o,u,bad', '前置：入参为 Desc 序（无日期/非法日期在末尾）')

let asc = storage.sortDiariesByTimeAsc(ROW)
ok(ids(asc) === 'o,m,n2,n,u,bad', 'asc = 旧→新，且无日期/非法日期仍沉底')
ok(asc !== ROW, 'asc 返回新数组（不与入参同引用）')
ok(ids(ROW) === descIds, 'asc 不改动入参顺序')
ok(asc[0] === ROW[3] && asc[3] === ROW[0], '元素为同一对象引用（不是深拷贝，页面 data 可安全复用）')
ok(ids(asc.slice(0, 4)) === ids(ROW.slice(0, 4).slice().reverse()), '有日期部分 = Desc 序的严格反转（镜像口径）')

// 幂等：asc 的结果再 asc 一次仍相同（按时间重排，而非「反转数组」）
ok(ids(storage.sortDiariesByTimeAsc(asc)) === ids(asc), 'asc 幂等（重复调用结果不变）')
// 与页面判据同源：无日期判定用 isNaN(new Date(x).getTime())
ok(!isNaN(new Date(asc[4].created_at).getTime()) === false, '沉底项确实是无日期（判据与 index.js 一致）')

ok(ids(storage.sortDiariesByTimeAsc([])) === '', '空数组 → 空数组')
ok(storage.sortDiariesByTimeAsc([]).length === 0, '空数组长度 0')
ok(Array.isArray(storage.sortDiariesByTimeAsc(null)) && storage.sortDiariesByTimeAsc(null).length === 0, 'null → 空数组')
ok(Array.isArray(storage.sortDiariesByTimeAsc(undefined)) && storage.sortDiariesByTimeAsc(undefined).length === 0, 'undefined → 空数组')
ok(Array.isArray(storage.sortDiariesByTimeAsc('x')) && storage.sortDiariesByTimeAsc('x').length === 0, '非数组 → 空数组')
ok(ids(storage.sortDiariesByTimeAsc([{ id: 'solo', created_at: T(2026, 1, 1) }])) === 'solo', '单元素原样')
ok(ids(storage.sortDiariesByTimeAsc([{ id: 'u1', created_at: '' }, { id: 'u2', created_at: '' }])) === 'u1,u2',
  '全部无日期 → 保持相对顺序（稳定）')
ok(ids(storage.sortDiariesByTimeAsc([{ id: 'a', created_at: T(2026, 5, 1, 9) }, { id: 'b', created_at: T(2026, 5, 1, 9) }])) === 'a,b',
  '同时间戳 → 保持相对顺序（稳定）')
// 描述符字段不能被误改
const withExtra = [{ id: 'x', created_at: T(2026, 2, 2), title: '带标题', content: 'c' }]
ok(storage.sortDiariesByTimeAsc(withExtra)[0].title === '带标题', '返回元素保留原有字段')

// =====================================================================
console.log('---- B. index.wxml / index.wxss 静态契约 ----')
const wxml = rd('pages/index/index.wxml')
const wxss = rd('pages/index/index.wxss')

ok(wxml.indexOf('class="sort-toggle"') !== -1, 'wxml：排序按钮在位')
ok(wxml.indexOf('bindtap="onToggleSort"') !== -1, 'wxml：点击绑到 onToggleSort')
ok(wxml.indexOf("{{sortOrder === 'asc' ? '\u2191' : '\u2193'}}") !== -1,
  'wxml：箭头随状态切换（1.A 用字符，非图标字体）')
ok(wxml.indexOf("{{sortOrder === 'asc' ? '正序' : '倒序'}}") !== -1, 'wxml：文字标签随状态切换')
ok(wxml.indexOf('sort-toggle') !== -1 && wxml.indexOf('ri ri-sort') === -1,
  'wxml：未引入需要重做字体子集的排序图标（1.A 口径）')

// 位置：必须在 search-box 内、且排在 search-clear 之后（× 在左、排序在右）
const boxStart = wxml.indexOf('class="search-box"')
const boxEnd = wxml.indexOf('</view>', boxStart)
const btnPos = wxml.indexOf('class="sort-toggle"')
const clrPos = wxml.indexOf('class="search-clear')
ok(boxStart !== -1 && btnPos > boxStart && btnPos < boxEnd, 'wxml：按钮在搜索框内部（用户圈的位置）')
ok(clrPos !== -1 && btnPos > clrPos, 'wxml：按钮排在 × 清空之后（常驻最右，搜索时 × 在其左）')

for (const cls of ['.sort-toggle {', '.sort-toggle-arrow {', '.sort-toggle-label {', '.sort-toggle-hover {']) {
  ok(wxss.indexOf(cls) !== -1, 'wxss：样式 ' + cls + ' 在位')
}
ok(wxss.indexOf('border-left: 2rpx solid var(--ink-faint);') !== -1,
  'wxss：分隔竖线 2rpx + --ink-faint（[index-ui2 v1] 加明显，仍走令牌）')
ok(wxss.indexOf('border-left: 1rpx solid var(--line);') === -1, 'wxss：旧的 1rpx/--line 淡竖线已消失')
ok(wxss.indexOf('.sort-toggle-arrow {\n  font-size: 26rpx;\n  color: var(--brand);') !== -1,
  'wxss：箭头用品牌色（走令牌，不用硬编码色值）')
ok(wxss.indexOf('.search-clear {') !== -1, 'wxss：原有 × 清空样式未被破坏')
for (const c of ['sort-toggle', 'sort-toggle-arrow', 'sort-toggle-label']) {
  ok(wxml.indexOf('class="' + c + '"') !== -1 && wxss.indexOf('.' + c + ' {') !== -1,
    '类名 ' + c + ' 在 wxml 与 wxss 双向对齐')
}

// =====================================================================
console.log('---- C. pages/index 行为（vm 桩）----')
const exportCalls = []
let pageOptions = null
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  getApp: () => ({ globalData: {} }),
  wx: global.wx
}
// 捕获导出调用参数（不跑真实 transfer，专注本页传参口径）
const transferMock = {
  exportToWord: function (onEmpty, list, sortOrder) {
    exportCalls.push({ onEmpty: onEmpty, list: list, sortOrder: sortOrder })
  },
  importFromFile: function () {}
}
sandbox.Page = (o) => { pageOptions = o }
sandbox.Component = () => {}
sandbox.module = { exports: {} }
sandbox.exports = sandbox.module.exports
sandbox.__filename = path.join(ROOT, 'pages', 'index', 'index.js')
sandbox.__dirname = path.join(ROOT, 'pages', 'index')
vm.createContext(sandbox)
sandbox.require = (p) => {
  if (String(p).indexOf('transfer.js') !== -1) return transferMock
  return require(path.join(ROOT, 'pages', 'index', p))
}
sandbox.wx = global.wx
vm.runInContext(rd('pages/index/index.js'), sandbox, { filename: 'index.js' })
ok(!!pageOptions, 'Page() 捕获成功')

const D_NEW = T(2026, 9, 20, 10)
const D_NEW2 = T(2026, 9, 10, 10)
const D_MID = T(2026, 6, 15, 10)
const D_OLD = T(2025, 3, 1, 10)
function baseData() {
  return {
    diaries: [],
    allDiaries: [
      { id: 'n', title: '九月最新', content: '九月爬山', created_at: D_NEW, tags: [], weather: null },
      { id: 'n2', title: '九月中', content: '九月开会', created_at: D_NEW2, tags: [], weather: null },
      { id: 'm', title: '六月中期', content: '六月出差', created_at: D_MID, tags: [], weather: null },
      { id: 'o', title: '去年三月', content: '三月看花', created_at: D_OLD, tags: [], weather: null },
      { id: 'u', title: '无日期', content: '无日期内容', created_at: '', tags: [], weather: null }
    ],
    rangeDiaries: [], rangeKey: 'all', rangeCs: '', rangeCe: '', rangeLabel: '全部时间',
    rangeCount: 0, undatedCount: 1,
    searchKeyword: '', isSearching: false, searchCount: 0,
    isEmpty: false, loading: false
  }
}
function makePage(data) {
  const inst = Object.assign({}, pageOptions)
  inst.data = JSON.parse(JSON.stringify(data))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  inst.selectComponent = () => null
  return inst
}

// 旧版无 onToggleSort：兜底为「不切换」而不是直接调用 ⇒ 后续顺序断言自然判红，而非 TypeError 崩溃
function toggleSort(pp) {
  if (typeof pp.onToggleSort === 'function') pp.onToggleSort()
  return pp
}

let p = makePage(baseData())
const hasToggle = typeof p.onToggleSort === 'function'
tryIt(() => typeof p.applyRange === 'function', 'applyRange 存在')

// --- C1 默认顺序（旧版也应成立：作为「没被改坏」的护栏）---
tryIt(() => { p.applyRange(); return true }, 'applyRange 可执行')
ok(ids(p.data.diaries) === 'n,n2,m,o,u', '默认展示 = 新→旧（倒序），无日期沉底')
ok(ids(p.data.rangeDiaries) === ids(p.data.diaries), 'rangeDiaries 与 diaries 同顺序')
ok(p.data.rangeCount === 5, '篇数 5')
ok(p.data.sortOrder === undefined || p.data.sortOrder === 'desc', '未定义时按 desc 处理（向后兼容）')

// --- C2 双向切换（新功能）---
tryIt(() => hasToggle, 'onToggleSort 方法存在')
tryIt(() => { toggleSort(p); return p.data.sortOrder === 'asc' }, '点一次 → sortOrder = asc')
ok(ids(p.data.diaries) === 'o,m,n2,n,u', '正序展示 = 旧→新，且无日期仍沉底（不靠反转数组）')
ok(ids(p.data.rangeDiaries) === 'o,m,n2,n,u', 'rangeDiaries 同步为正序（导出要用到）')
ok(p.data.diaries.length === 5 && p.data.rangeCount === 5, '切换只改顺序、不改篇数')
ok(p.data.isSearching === false && p.data.searchCount === 0, '非搜索态切换不产生搜索态副作用')

tryIt(() => { toggleSort(p); return p.data.sortOrder === 'desc' }, '再点一次 → 回到 desc')
ok(ids(p.data.diaries) === 'n,n2,m,o,u', '回到倒序，与初始完全一致')

for (let i = 0; i < 5; i++) toggleSort(p)
ok(p.data.sortOrder === 'asc' && ids(p.data.diaries) === 'o,m,n2,n,u', '奇数次切换后为正序（奇偶性正确）')
for (let i = 0; i < 5; i++) toggleSort(p)
ok(p.data.sortOrder === 'desc' && ids(p.data.diaries) === 'n,n2,m,o,u', '偶数次切换后回倒序')

// --- C3 与范围 / 搜索叠加 ---
p = makePage(baseData())
p.setData({ rangeKey: 'month' })
p.applyRange()
ok(ids(p.data.rangeDiaries) === 'n,n2', '范围（本月）= 2 篇，倒序')
toggleSort(p)
ok(ids(p.data.rangeDiaries) === 'n2,n', '范围内切换正序 → 只有顺序变，内容仍是范围内 2 篇')
ok(p.data.rangeCount === 2, '范围计数不受排序影响')

p.setData({ searchKeyword: '九月' })
p.applySearch('九月')
ok(p.data.isSearching === true && p.data.searchCount === 2, '范围内搜索命中 2 篇')
ok(ids(p.data.diaries) === 'n2,n', '搜索态继承当前正序（搜索是保序 filter）')
toggleSort(p)
ok(ids(p.data.diaries) === 'n,n2', '搜索态下切换 → 结果顺序跟随，篇数不变')
ok(p.data.searchCount === 2 && p.data.rangeCount === 2, '切换后两个计数都不变')

p = makePage(baseData())
toggleSort(p)
p.setData({ searchKeyword: '九月' })
p.applySearch('九月')
ok(p.data.searchCount === 2 && ids(p.data.diaries) === 'n2,n', '全部范围 + 搜索 + 正序 三叠加正确')

// 无日期在「范围内」被排除，但在 all 范围下两向都沉底
p = makePage(baseData())
p.applyRange()
toggleSort(p)
const lastDiary = p.data.diaries[p.data.diaries.length - 1]
ok(!!lastDiary && lastDiary.id === 'u', '正序下无日期仍在列表最末')
p.applySearch('无日期')
ok(p.data.searchCount === 1 && !!p.data.diaries[0] && p.data.diaries[0].id === 'u',
  '无日期篇仍可被搜到（排序不影响检索）')

// --- C4 resetFilters 归位（钉住「先归位排序、再 reset 范围」的顺序）---
p = makePage(baseData())
toggleSort(p)
p.setData({ rangeKey: 'month' })
p.applyRange()
ok(p.data.sortOrder === 'asc' && ids(p.data.rangeDiaries) === 'n2,n', '前置：正序 + 本月范围')
// 模拟真实组件：reset() 会同步 emit change → 页面 onRangeChange → applyRange
p.selectComponent = () => ({
  reset: function () {
    p.onRangeChange({ detail: { range: 'all', label: '全部时间', customStart: '', customEnd: '' } })
  }
})
p.resetFilters()
ok(p.data.sortOrder === 'desc', 'resetFilters 把排序归位为倒序')
ok(p.data.rangeKey === 'all' && p.data.searchKeyword === '', 'resetFilters 同时清掉范围与搜索')
ok(ids(p.data.diaries) === 'n,n2,m,o,u', '归位后列表回到全量倒序（证明先归位再 reset 的顺序正确）')
ok(p.data.rangeCount === 5, '归位后范围计数为全量')

// =====================================================================
console.log('---- D. 导出跟随列表（2.B）----')
// 真实初始 data 含 sortOrder:'desc'（C 段刻意不带该字段，用于验证向后兼容）
p = makePage(Object.assign(baseData(), { sortOrder: 'desc' }))
p.applyRange()
exportCalls.length = 0
global.wx.showModal = (o) => { if (o && o.success) o.success({ confirm: true }) }
sandbox.wx = global.wx
p.onExportDiaries()
ok(exportCalls.length === 1, '全量态导出只调用一次 exportToWord')
ok((exportCalls[0] || {}).sortOrder === 'desc', '全量态把当前顺序（desc）传给 exportToWord')
ok((exportCalls[0] || {}).list === null || (exportCalls[0] || {}).list === undefined,
  '全量态不传 list（保持「带档案节」的全量导出路径）')

toggleSort(p)
exportCalls.length = 0
p.onExportDiaries()
ok((exportCalls[0] || {}).sortOrder === 'asc', '切正序后，全量导出传 asc')

p = makePage(Object.assign(baseData(), { sortOrder: 'desc' }))
p.setData({ rangeKey: 'month' })
p.applyRange()
toggleSort(p)
exportCalls.length = 0
p.onExportDiaries()
ok((exportCalls[0] || {}).list && ids((exportCalls[0] || {}).list) === 'n2,n', '范围态导出用已排序列表（跟随列表）')
ok((exportCalls[0] || {}).sortOrder === undefined, '范围态不再重复传顺序（列表已排好，避免二次处理）')

p = makePage(Object.assign(baseData(), { sortOrder: 'desc' }))
p.applyRange()
toggleSort(p)
p.setData({ searchKeyword: '九月' })
p.applySearch('九月')
exportCalls.length = 0
p.onExportDiaries()
ok((exportCalls[0] || {}).list && ids((exportCalls[0] || {}).list) === 'n2,n', '搜索态导出用已排序的搜索结果')
ok((exportCalls[0] || {}).list.length === p.data.searchCount, '导出篇数 = 搜索结果篇数')

// =====================================================================
;(async function () {
  console.log('---- E. utils/transfer.js#exportToWord 第三参行为 ----')
  // 关键：先取 storage 实例并打桩，再加载 transfer ⇒ transfer 内部 require 命中同一实例
  freshWx()
  const storageRef = requireFresh('utils/storage.js')
  let capturedIds = null
  let capturedArchives = 'UNSET'
  storageRef.getAllDiaries = () => ROW.slice()
  storageRef.buildWordFileName = () => 'x.docx'
  storageRef.getArchives = () => { capturedArchives = null; return null }
  storageRef.buildDocx = (list, imgBin, videoMap, archives) => {
    capturedIds = ids(list)
    capturedArchives = archives
    return Buffer.from('PK')
  }
  let wrote = null
  global.wx.getFileSystemManager = () => ({ writeFile: (o) => { wrote = o; o.success && o.success() } })
  global.wx.openDocument = (o) => { o.success && o.success() }
  global.wx.showModal = () => {}
  global.wx.env = { USER_DATA_PATH: '/tmp' }
  const transfer = require(path.join(ROOT, 'utils', 'transfer.js'))
  ok(typeof transfer.exportToWord === 'function', 'transfer.exportToWord 可加载')

  const SUB = [ROW[0], ROW[2], ROW[3]] // n, m, o（页面已排好的顺序，原样传入）
  transfer.exportToWord(null, SUB)
  await new Promise((r) => setTimeout(r, 20))
  ok(capturedIds === 'n,m,o', '子集态不传 sortOrder → 原样导出（其他调用方零影响）')
  ok(capturedArchives === null || capturedArchives === 'UNSET', '子集态不带档案节（原有契约未变）')

  capturedIds = null
  transfer.exportToWord(null, SUB, 'asc')
  await new Promise((r) => setTimeout(r, 20))
  ok(capturedIds === 'o,m,n', '传 asc → 文档按旧→新重排')

  capturedIds = null
  transfer.exportToWord(null, SUB, 'desc')
  await new Promise((r) => setTimeout(r, 20))
  ok(capturedIds === 'n,m,o', "传 desc → 保持原序（仅 asc 触发重排）")

  capturedIds = null
  const alreadyAsc = [ROW[3], ROW[2], ROW[0]]
  transfer.exportToWord(null, alreadyAsc, 'asc')
  await new Promise((r) => setTimeout(r, 20))
  ok(capturedIds === 'o,m,n', 'asc 重排幂等（已排好的列表再排一次结果不变）')

  ok(!!wrote && wrote.data && wrote.data.length > 0, '导出链路走通（writeFile 收到 buffer）')

  console.log('index-sort: ' + passCount + ' passed, ' + failCount + ' failed')
  process.exit(failCount ? 1 : 0)
})()
