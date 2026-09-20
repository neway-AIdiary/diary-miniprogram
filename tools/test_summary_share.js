/**
 * 总结结果页分享对齐回归 [summary-share-align v1]
 * 运行：node tools/test_summary_share.js
 *
 * 用户拍板（2026-09-20）：
 *   ① 确认分享 → 先落库 → 海报二维码指向这篇日记（落库失败不生成海报）；
 *   ② 转发卡片先落库，卡片直达详情页，不配「取消分享删草稿」；
 *   ③ 确认分享完成（海报已存相册/文字已复制）后，与【保存】同款回到日记本；
 *   ④ 分享视图模型与落库口径对齐：正文带【总结需求】【分析范围】说明头、心情标签同源；
 *   ⑤ 其他页面（详情页等）的分享行为零变化。
 *
 * 覆盖断言：
 *   S 组：组件静态护栏（needSavedDiary / needsave 分流 / continueShare / shared 事件 / wxml 接线）
 *   A 组：shareDiary 与 buildDiaryData 逐字对齐（正文说明头 + 心情三值 + 说明头幂等）
 *   B 组：落库行为（ensureDiarySaved 幂等 / onShareNeedSave 成败两路 / 转发卡片路径）
 *   C 组：分享完成回日记本（shared → _saving + markWritten + reLaunch）
 *   D 组：已落库后【保存】/【编辑】不产生第二份
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const SHEET = path.join(base, 'components', 'share-sheet', 'share-sheet.js')
const PAGE_JS = path.join(base, 'pages', 'summary-result', 'summary-result.js')
const PAGE_WXML = path.join(base, 'pages', 'summary-result', 'summary-result.wxml')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
const read = (p) => fs.readFileSync(p, 'utf8')

function clearCache() {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })
}

/** 加载 summary-result 页面并造实例；opts.overrides 按 require 路径子串替换模块 */
function loadPage(opts) {
  opts = opts || {}
  clearCache()
  const store = opts.store || {}
  const sink = { toasts: [], nav: [], relaunch: [], markWritten: [], errors: [] }
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
    showToast: (o) => { sink.toasts.push((o && o.title) || '') },
    showLoading: () => {}, hideLoading: () => {},
    navigateTo: (o) => { sink.nav.push(o || {}) },
    reLaunch: (o) => { sink.relaunch.push(o || {}) },
    onThemeChange: () => {},
    getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 375, windowHeight: 700 }),
    cloud: null
  }
  const globalData = { needRefresh: false }
  global.getApp = () => ({ globalData })

  let pageObj = null
  global.Page = (o) => { pageObj = o }

  const reminderStub = { callMarkWritten: (k) => { sink.markWritten.push(k) } }
  const overrides = Object.assign({ 'reminder.js': reminderStub }, opts.overrides || {})
  const dir = path.join(base, 'pages', 'summary-result')
  const fakeRequire = (p) => {
    for (const k of Object.keys(overrides)) {
      if (p.indexOf(k) >= 0) return overrides[k]
    }
    return require(path.resolve(dir, p))
  }

  let page = null
  try {
    const src = fs.readFileSync(PAGE_JS, 'utf8')
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'summary-result.js' })
    wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  } catch (e) {
    return { page: null, sink, store, globalData, loadError: String(e && e.message) }
  }
  if (!pageObj) return { page: null, sink, store, globalData, loadError: 'Page 未注册' }

  page = Object.create(pageObj)
  page.data = JSON.parse(JSON.stringify(pageObj.data))
  page.setData = function (d) { Object.assign(this.data, d) }
  // 默认组件桩：记录 continueShare 收到的 diary（用例可覆盖）
  page.selectComponent = () => ({ continueShare: (d) => { sink.continued = d } })
  return { page, sink, store, globalData, loadError: null }
}

const PAYLOAD = {
  content: '◆ 运动篇\n本周跑步三次，状态回升。',
  prompt: '总结我的运动情况',
  rangeText: '最近一个月',
  diaryCount: 5
}

function initPage(opts) {
  const ctx = loadPage(opts)
  if (ctx.loadError || !ctx.page) return ctx
  ctx.page.initFromPayload(Object.assign({}, PAYLOAD))
  return ctx
}

// ============================================================
console.log('== S) 组件静态护栏（share-sheet.js + wxml 接线） ==')
{
  const sheetSrc = read(SHEET)
  const wxml = read(PAGE_WXML)

  ok(sheetSrc.indexOf("needSavedDiary: { type: Boolean, value: false }") !== -1,
    'S1 组件新增 needSavedDiary 属性（默认 false：其他页面零变化）')
  ok(sheetSrc.indexOf("if (this._needSavedDiary()) { this.triggerEvent('needsave'); return }") !== -1,
    'S2 确认分享海报/复制两路都先经 needsave 分流')
  ok((sheetSrc.match(/_needSavedDiary\(\)/g) || []).length >= 3,
    'S3 _needSavedDiary 判定被 confirmShare 两路复用')
  ok(sheetSrc.indexOf('continueShare(diaryOverride)') !== -1 &&
     sheetSrc.indexOf("if (diaryOverride) this.setData({ diary: diaryOverride })") !== -1,
    'S4 continueShare 支持页面回传最新 diary（同步替换，规避属性更新时序）')
  ok(sheetSrc.indexOf("this.triggerEvent('shared', { action: 'poster' })") !== -1,
    'S5 海报保存成功后触发 shared 事件')
  ok(sheetSrc.indexOf("this.triggerEvent('shared', { action: 'text' })") !== -1,
    'S6 复制成功后触发 shared 事件')
  ok(sheetSrc.indexOf("needSavedDiary && !(this.data.diary && this.data.diary.id)") !== -1,
    'S7 只有「声明 need-saved-diary 且无 id」才请页面落库（详情页有 id 永不触发）')

  ok(wxml.indexOf('need-saved-diary="{{true}}"') !== -1, 'S8 wxml 声明 need-saved-diary')
  ok(wxml.indexOf('bind:needsave="onShareNeedSave"') !== -1, 'S9 wxml 接线 bindsave')
  ok(wxml.indexOf('bind:shared="onShareSheetShared"') !== -1, 'S10 wxml 接线 shared')
  ok(wxml.indexOf('id="shareSheet"') !== -1, 'S11 wxml 给组件挂 id（selectComponent 回调）')
}

// ============================================================
console.log('== A) shareDiary 与落库口径对齐 ==')
{
  const ctx = initPage()
  ok(!ctx.loadError && ctx.page, 'A0 页面可加载并初始化', ctx.loadError)
  const sd = ctx.page.data.shareDiary

  ok(sd.content.indexOf('【总结需求】总结我的运动情况') === 0 &&
     sd.content.indexOf('【分析范围】共读取最近一个月 5 篇日记进行分析') > 0,
    'A1 分享正文以说明头开头（总结需求 + 分析范围）', sd.content.slice(0, 60))
  ok(sd.content === ctx.page.buildDiaryData().content,
    'A2 shareDiary.content 与 buildDiaryData().content 逐字一致')
  ok(sd.content.indexOf('◆ 运动篇') > 0, 'A3 说明头之后是总结正文')

  const util = require(path.join(base, 'utils', 'util.js'))
  ok(sd.moodText === util.getMoodLabel('neutral') && sd.moodText.indexOf('一般') >= 0,
    'A4 心情文案与保存后同源（neutral）', sd.moodText)
  ok(sd.moodColor === util.getMoodColor('neutral') && sd.moodBg === util.getMoodBg('neutral'),
    'A5 心情颜色/底色与保存后同源')

  // 说明头幂等：正文已带说明头时不重复拼
  const ctx2 = loadPage()
  ctx2.page.initFromPayload(Object.assign({}, PAYLOAD, {
    content: '【总结需求】已有\n【分析范围】已有\n\n◆ 正文'
  }))
  const sd2 = ctx2.page.data.shareDiary
  ok((sd2.content.match(/【总结需求】/g) || []).length === 1,
    'A6 正文已带说明头时不重复拼接（幂等）', sd2.content.slice(0, 30))
}

// ============================================================
console.log('== B) 确认分享/转发先落库 ==')
{
  // 旧代码没有这些方法时记为「断言红」并收场，而不是让测试进程崩掉
  const ctx0 = loadPage()
  if (!ctx0.page || typeof ctx0.page.ensureDiarySaved !== 'function') {
    ok(false, 'B0 ensureDiarySaved 等分享落库方法存在（旧版缺失即红）')
    console.log('\nsummary share align (old code): ' + pass + ' passed, ' + fail + ' failed')
    process.exit(1)
  }

  // ensureDiarySaved 幂等
  const ctx = initPage()
  const id1 = ctx.page.ensureDiarySaved()
  const list1 = ctx.page.data && ctx.store['diaries']
  ok(!!id1, 'B1 ensureDiarySaved 返回日记 id', id1)
  ok(Array.isArray(list1) && list1.length === 1 && list1[0].entryType === 'summary',
    'B2 落库为 entryType=summary 的总结日记')
  const id2 = ctx.page.ensureDiarySaved()
  const list2 = ctx.store['diaries']
  ok(id2 === id1 && list2.length === 1, 'B3 重复调用幂等（不产生第二份）')

  // onShareNeedSave 成功路：shareDiary 补 id + continueShare 带新 diary
  const ctx3 = initPage()
  let continued = null
  ctx3.page.selectComponent = () => ({ continueShare: (d) => { continued = d } })
  ctx3.page.onShareNeedSave()
  ok(!!ctx3.page.data.shareDiary.id, 'B4 onShareNeedSave 后 shareDiary.id 已补上', ctx3.page.data.shareDiary.id)
  ok(continued && continued.id === ctx3.page.data.shareDiary.id,
    'B5 continueShare 被回调且带最新 diary（海报二维码即指向这篇日记）')
  ok(ctx3.store['diaries'].length === 1, 'B6 落库只发生一次')

  // onShareNeedSave 失败路：storage 桩 saveDiary 返回 null
  const ctx4 = loadPage({
    overrides: { 'storage.js': { saveDiary: () => null, getAllDiaries: () => [] } }
  })
  ctx4.page.initFromPayload(Object.assign({}, PAYLOAD))
  let continued4 = null
  ctx4.page.selectComponent = () => ({ continueShare: (d) => { continued4 = d } })
  ctx4.page.onShareNeedSave()
  ok(ctx4.sink.toasts.indexOf('保存失败') !== -1, 'B7 落库失败弹「保存失败」')
  ok(ctx4.page.data.showSharePanel === false, 'B8 失败时收起分享面板')
  ok(continued4 === null, 'B9 失败时绝不继续生成海报（二维码不落无码布局误导）')

  // 转发卡片：先落库，路径直达详情页
  const ctx5 = initPage()
  const share = ctx5.page.onShareAppMessage()
  ok(share.path.indexOf('/pages/detail/detail?id=') === 0 && share.path.indexOf('&share=1') > 0,
    'B10 转发卡片直达已落库日记的详情页', share.path)
  ok(ctx5.store['diaries'].length === 1, 'B11 转发卡片已先落库')
  ok(share.title === ctx5.page.data.title, 'B12 卡片标题保持「X月X日 AI总结」口径', share.title)
}

// ============================================================
console.log('== C) 分享完成 → 与【保存】同款回日记本 ==')
console.log('== D) 已落库后【保存】/【编辑】不产生第二份 ==')
// C/D 涉及页面内 600ms 定时器，而页面定时器触发时读的是「当时的全局 wx」——
// 两组不能并行挂定时器（否则后一组替换全局桩导致前一组 reLaunch 落错 sink），改为顺序阶段。

function phaseC(done) {
  const ctx = initPage()
  ctx.page.onShareNeedSave() // 先走落库
  ctx.page.onShareSheetShared()
  ok(ctx.page._saving === true && ctx.page.data.busy === true,
    'C1 shared 后进入保存完成态（busy 置灰防重复）')
  ok(ctx.sink.markWritten.length === 1, 'C2 上报今天已写（与【保存】一致）', ctx.sink.markWritten)
  setTimeout(() => {
    ok(ctx.sink.relaunch.length === 1 &&
       ctx.sink.relaunch[0].url === '/pages/index/index',
      'C3 600ms 后 reLaunch 回日记本（清掉总结页栈）', ctx.sink.relaunch)

    // 落库失败时 shared 不跳转（该路无定时器，可同阶段做）
    const ctxF = loadPage({
      overrides: { 'storage.js': { saveDiary: () => null, getAllDiaries: () => [] } }
    })
    ctxF.page.initFromPayload(Object.assign({}, PAYLOAD))
    ctxF.page.onShareSheetShared()
    ok(ctxF.sink.relaunch.length === 0 && ctxF.page._saving !== true,
      'C4 落库失败：不跳转不置忙（留在本页）')
    done()
  }, 700)
}

function phaseD(done) {
  const ctx = initPage()
  ctx.page.ensureDiarySaved()
  ctx.page.onSave()
  ok(ctx.store['diaries'].length === 1, 'D1 已落库后点【保存】不再重复落库')
  setTimeout(() => {
    ok(ctx.sink.relaunch.length === 1, 'D2 且按保存完成流程回日记本')

    const ctx2 = initPage()
    ctx2.page.ensureDiarySaved()
    ctx2.page.onEdit()
    const list = ctx2.store['diaries']
    ok(list.length === 1, 'D3 已落库后点【编辑】不再落新草稿')
    ok(ctx2.sink.nav.length === 1 &&
       ctx2.sink.nav[0].url.indexOf('/pages/detail/detail?id=') === 0 &&
       ctx2.sink.nav[0].url.indexOf('edit=1') > 0 &&
       ctx2.sink.nav[0].url.indexOf('draft=1') === -1,
      'D4 直接编辑那篇真日记（不带 draft=1，取消不删除）', ctx2.sink.nav)
    done()
  }, 700)
}

phaseC(() => phaseD(() => {
  console.log('\nsummary share align: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}))

// 兜底：定时器链中断也要退出
setTimeout(() => {
  console.log('\nsummary share align (timeout): ' + pass + ' passed, ' + fail + ' failed')
  process.exit(1)
}, 8000)
