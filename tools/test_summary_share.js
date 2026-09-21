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
 *   E 组：海报字号分层 [poster-font v1]（说明头 25px 浅灰 / 正文 29px + 段落首行缩进）
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
// [shard-storage v1] 日记按年份分格存储：断言读取走「分格 + 旧格」并集
function storeAllDiaries(st) {
  const out = []
  Object.keys(st).forEach(k => {
    if (/^diaries(_\d{4})?$/.test(k) && Array.isArray(st[k])) out.push(...st[k])
  })
  return out
}

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
console.log('== E) 海报正文分层：说明头小一号 + 段落首行缩进 [poster-font v1] ==')
{
  const sheetSrc2 = read(SHEET)
  const share = require(path.join(base, 'utils', 'share.js'))

  ok(sheetSrc2.indexOf("ctx.font = '400 29px sans-serif'") !== -1 &&
     sheetSrc2.indexOf('lineH: 48') !== -1 &&
     sheetSrc2.indexOf("'400 33px sans-serif'") === -1,
    'E1 正文降到 29px / 行高 48（整卡降一档，33px 已无残留）')
  ok(sheetSrc2.indexOf("kind: 'brief'") !== -1 &&
     sheetSrc2.indexOf("ctx.font = '400 25px sans-serif'") !== -1,
    'E2 说明头拆成 brief 块，25px 再小一号')
  ok(sheetSrc2.indexOf("kind: 'brief'") !== -1 && sheetSrc2.indexOf("'#8A8F8C'") !== -1,
    'E3 说明头浅灰弱化（与正文深墨分层）')
  ok(sheetSrc2.indexOf("'400 27px sans-serif'") === -1,
    'E4 心情/天气同步降到 25px（27px 已无残留）')
  ok(sheetSrc2.indexOf('share.splitPosterBrief(') !== -1 &&
     sheetSrc2.indexOf('share.indentParas(') !== -1,
    'E5 分层与缩进都走 utils/share.js 纯函数（可单测、页面无关）')
  ok(sheetSrc2.indexOf('share.MAX_POSTER_LINES - briefLines') !== -1,
    'E6 说明头行数计入行数上限（不顶穿 canvas 像素上限）')

  const spb = (typeof share.splitPosterBrief === 'function') ? share.splitPosterBrief : null
  const ind = (typeof share.indentParas === 'function') ? share.indentParas : null
  ok(!!spb, 'E7 splitPosterBrief 已导出（旧版缺失即红）')
  ok(!!ind, 'E8 indentParas 已导出（旧版缺失即红）')

  const briefText = '【总结需求】根据我的日记总结一下\n【分析范围】共读取全部时间 141 篇日记进行分析' +
    '\n根据日记内容，你是一个：\n中年离职员工，经历裁员。'
  const sp = spb ? spb(briefText) : { brief: '', body: '' }
  ok(sp.brief.indexOf('【总结需求】') === 0 && sp.brief.indexOf('【分析范围】') > 0,
    'E9 说明头两行整体归入 brief', sp.brief)
  ok(sp.body.indexOf('根据日记内容') === 0 && sp.brief.indexOf('根据日记内容') === -1,
    'E10 正文从说明头之后开始（brief / body 不重叠）', sp.body)

  const sp2 = spb ? spb('今天天气不错\n心情很好') : { brief: '', body: '' }
  ok(sp2.brief === '' && sp2.body === '今天天气不错\n心情很好',
    'E11 无说明头的普通正文：brief 空、body 全文（普通日记海报零变化）', sp2.brief)

  const sp3 = spb ? spb('【总结需求】只有需求没有正文') : { brief: '', body: '' }
  ok(sp3.brief === '' && sp3.body === '【总结需求】只有需求没有正文',
    'E12 只有说明头没有正文时回退当正文（不画空海报）', sp3.brief)

  const ind1 = ind ? ind('第一段\n\n第二段') : ''
  ok(!!ind && ind1 === '　第一段\n\n　第二段',
    'E13 每个段落首字空一个字（全角空格），空行不缩进', JSON.stringify(ind1))
  const ind2 = ind ? ind(ind1) : ''
  ok(!!ind && ind1 !== '' && ind2 === ind1, 'E14 缩进幂等（已缩进的行不重复加）')
  ok(ind ? ind('单段正文') === '　单段正文' : false, 'E15 只有一个段落时同样缩进')

  ok(share.MAX_SUMMARY_LEN === 600 && share.MAX_POSTER_LINES === 40,
    'E16 海报字数/行数上限不变（600 字 / 40 行）')
}

// ============================================================
console.log('== F) 天气与心情同行 [poster-weather-inline v1] ==')
{
  const sheetSrc3 = read(SHEET)
  ok(sheetSrc3.indexOf("kind: 'weather', y: y - 54, x: PAD + moodW + 24, w: wW") !== -1,
    'F1 有心情时天气块落在心情同行右侧（x = PAD + moodW + 24）')
  ok(sheetSrc3.indexOf('ctx.fillText(model.weather, b.x || PAD, b.y)') !== -1,
    'F2 绘制按块自带 x（无 x 回落 PAD，兼容独立行）')
  ok(sheetSrc3.indexOf('moodW + 24 + wW <= MAXW') !== -1,
    'F3 放不下时回落独立行（宽度守卫在位）')
  ok(sheetSrc3.indexOf('y += 46') !== -1,
    'F4 独立行路径保留（无心情日记的天气仍是单独一行）')
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
  const list1 = ctx.page.data && storeAllDiaries(ctx.store)
  ok(!!id1, 'B1 ensureDiarySaved 返回日记 id', id1)
  ok(Array.isArray(list1) && list1.length === 1 && list1[0].entryType === 'summary',
    'B2 落库为 entryType=summary 的总结日记')
  const id2 = ctx.page.ensureDiarySaved()
  const list2 = storeAllDiaries(ctx.store)
  ok(id2 === id1 && list2.length === 1, 'B3 重复调用幂等（不产生第二份）')

  // onShareNeedSave 成功路：shareDiary 补 id + continueShare 带新 diary
  const ctx3 = initPage()
  let continued = null
  ctx3.page.selectComponent = () => ({ continueShare: (d) => { continued = d } })
  ctx3.page.onShareNeedSave()
  ok(!!ctx3.page.data.shareDiary.id, 'B4 onShareNeedSave 后 shareDiary.id 已补上', ctx3.page.data.shareDiary.id)
  ok(continued && continued.id === ctx3.page.data.shareDiary.id,
    'B5 continueShare 被回调且带最新 diary（海报二维码即指向这篇日记）')
  ok(storeAllDiaries(ctx3.store).length === 1, 'B6 落库只发生一次')

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
  ok(storeAllDiaries(ctx5.store).length === 1, 'B11 转发卡片已先落库')
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
  ok(storeAllDiaries(ctx.store).length === 1, 'D1 已落库后点【保存】不再重复落库')
  setTimeout(() => {
    ok(ctx.sink.relaunch.length === 1, 'D2 且按保存完成流程回日记本')

    const ctx2 = initPage()
    ctx2.page.ensureDiarySaved()
    ctx2.page.onEdit()
    const list = storeAllDiaries(ctx2.store)
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
