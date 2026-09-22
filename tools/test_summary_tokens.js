/**
 * [summary-token-cap v1] 测试：AI 总结输出上限提升（2000 → 5000）+ 输出截断如实上报
 * 运行：node tools/test_summary_tokens.js
 *
 * 用户拍板（2026-09-22）：1（max_tokens = 5000）+ 3（检测 finish_reason='length' 并提示）
 * 背景：需求「按时间线提取日记中的事件」的结果写到一半被硬切断 ——
 *       aiSummary 里 max_tokens: 2000 是「输出」上限（输入侧 365 篇 / 50000 字符都没触到）。
 *       旧版对「输出被截断」毫无感知：照常返回、前端照常展示 ⇒ 用户以为结果就长这样。
 *
 * 覆盖断言：
 *   A 组：云函数 aiSummary 静态（MAX_OUTPUT_TOKENS=5000 生效 / finish_reason 检测 / outputTruncated 返回 /
 *        输入侧裁剪标记与请求体一字未动）
 *   B 组：结果页行为（outputTruncated 透传 → data / 说明头如实标注 / 分享与落库仍逐字一致）
 *   C 组：智能总结页行为（云函数桩返回 outputTruncated → payload 透传；缺字段时回落 false）
 *   D 组：零回归（正常结果不加字、不改口径；说明头分层仍认得出这两行）
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const CLOUD = path.join(base, 'cloudfunctions', 'aiSummary', 'index.js')
const SJS = path.join(base, 'pages', 'summary', 'summary.js')
const RJS = path.join(base, 'pages', 'summary-result', 'summary-result.js')
const RWXML = path.join(base, 'pages', 'summary-result', 'summary-result.wxml')
const RWXSS = path.join(base, 'pages', 'summary-result', 'summary-result.wxss')

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

// [shard-storage v1] 日记按年份分格存储：断言读取走「分格 + 旧格」并集
function storeAllDiaries(st) {
  const out = []
  Object.keys(st).forEach(k => {
    if (/^diaries(_\d{4})?$/.test(k) && Array.isArray(st[k])) out.push(...st[k])
  })
  return out
}

// ============================================================
// 载入「总结结果」页（vm + wx 桩），opts.overrides 按 require 路径子串替换模块
// ============================================================
function loadResultPage(opts) {
  opts = opts || {}
  clearCache()
  const store = opts.store || {}
  const sink = { toasts: [], nav: [], relaunch: [], markWritten: [] }
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

  const overrides = Object.assign(
    { 'reminder.js': { callMarkWritten: (k) => { sink.markWritten.push(k) } } },
    opts.overrides || {})
  const dir = path.join(base, 'pages', 'summary-result')
  const fakeRequire = (p) => {
    for (const k of Object.keys(overrides)) {
      if (p.indexOf(k) >= 0) return overrides[k]
    }
    return require(path.resolve(dir, p))
  }

  try {
    const src = read(RJS)
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'summary-result.js' })
    wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  } catch (e) {
    return { page: null, sink, store, globalData, loadError: String(e && e.message) }
  }
  if (!pageObj) return { page: null, sink, store, globalData, loadError: 'Page 未注册' }

  const page = Object.create(pageObj)
  page.data = JSON.parse(JSON.stringify(pageObj.data))
  page.setData = function (d) { Object.assign(this.data, d) }
  page.selectComponent = () => ({ continueShare: () => {} })
  return { page, sink, store, globalData, loadError: null }
}

const RPAYLOAD = {
  content: '◆ 大事记\n· 7月22日 自驾返回北京，全程约十一个小时。',
  prompt: '按时间线提取日记中的事件',
  rangeText: '最近一个月',
  diaryCount: 5
}

function initResult(opts) {
  const ctx = loadResultPage(opts)
  if (ctx.loadError || !ctx.page) return ctx
  ctx.page.initFromPayload(Object.assign({}, RPAYLOAD, (opts && opts.payload) || {}))
  return ctx
}

// ============================================================
// 载入「智能总结」页（vm + wx 桩）：验证 payload 透传
// ============================================================
const DIARY = {
  id: 'd1', title: '七月的一天', content: '今天自驾返回北京，全程十一个小时。',
  created_at: new Date().toISOString(), mood: 'happy', tags: []
}

function loadSummaryPage(opts) {
  opts = opts || {}
  clearCache()
  const store = opts.store || {}
  const sink = { toasts: [], nav: [], emitted: [], req: null }
  const globalData = { needRefresh: false, summaryResult: null }
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
    showToast: (o) => { sink.toasts.push((o && o.title) || '') },
    getWindowInfo: () => ({ safeArea: { bottom: 700 }, screenHeight: 700, windowWidth: 375 }),
    getSystemInfoSync: () => ({ safeArea: { bottom: 700 }, screenHeight: 700 }),
    navigateTo: (o) => {
      sink.nav.push(o || {})
      if (o && o.success) {
        o.success({ eventChannel: { emit: (n, p) => sink.emitted.push({ name: n, payload: p }) } })
      }
    },
    cloud: {
      callFunction: (o) => {
        sink.req = o
        return Promise.resolve({ result: opts.cloudResult || { success: true, summaryText: '正文', diaryCount: 1 } })
      }
    }
  }
  global.getApp = () => ({ globalData })

  let pageObj = null
  global.Page = (o) => { pageObj = o }

  const overrides = Object.assign({
    'voice.js': { onStateChange: () => () => {}, start: () => {}, stop: () => {}, warmup: () => {} },
    'fontSetting.js': { buildStyle: () => '' },
    'theme.js': { applyTo: () => {} },
    'lock.js': { guard: () => false },
    'storage.js': { getAllDiaries: () => (opts.diaries || [DIARY]) }
  }, opts.overrides || {})
  const dir = path.join(base, 'pages', 'summary')
  const fakeRequire = (p) => {
    for (const k of Object.keys(overrides)) {
      if (p.indexOf(k) >= 0) return overrides[k]
    }
    return require(path.resolve(dir, p))
  }

  try {
    const src = read(SJS)
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'summary.js' })
    wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  } catch (e) {
    return { page: null, sink, globalData, loadError: String(e && e.message) }
  }
  if (!pageObj) return { page: null, sink, globalData, loadError: 'Page 未注册' }

  const page = Object.create(pageObj)
  page.data = JSON.parse(JSON.stringify(pageObj.data))
  page.setData = function (d) { Object.assign(this.data, d) }
  return { page, sink, globalData, loadError: null }
}

const tick = (n) => new Promise((r) => setTimeout(r, n || 5))

// ============================================================
async function main() {
  // ----------------------------------------------------------
  console.log('== A) 云函数 aiSummary：输出上限与截断检测 ==')
  {
    const cloud = read(CLOUD)

    ok(cloud.indexOf('const MAX_OUTPUT_TOKENS = 5000') !== -1,
      'A1 输出上限常量为 5000（拍板 1）')
    ok(cloud.indexOf('max_tokens: MAX_OUTPUT_TOKENS') !== -1,
      'A2 请求体 max_tokens 改用常量')
    ok(cloud.indexOf('max_tokens: 2000') === -1,
      'A3 旧的 2000 已无残留（不再悄悄截断）')
    ok(cloud.indexOf("choice.finish_reason === 'length'") !== -1,
      'A4 检测 finish_reason=length（输出被截断的唯一可靠信号）')
    ok(cloud.indexOf('outputTruncated: choice.finish_reason') !== -1,
      'A5 成功返回体带 outputTruncated')

    const iFlag = cloud.indexOf('outputTruncated: choice.finish_reason')
    const iSuccess = cloud.indexOf('success: true')
    const iModel = cloud.indexOf("model: MODEL")
    ok(iSuccess > -1 && iModel > -1 && iFlag > iSuccess,
      'A6 位置断言：outputTruncated 在 success 返回体内（前置锚点存在，防假绿）',
      { iSuccess, iFlag, iModel })

    ok(cloud.indexOf('truncated: ctx.count < diaries.length') !== -1,
      'A7 输入侧裁剪标记（truncated）一字未动')
    ok(cloud.indexOf('const MAX_DIARIES = 365') !== -1 &&
       cloud.indexOf('const MAX_CONTEXT_CHARS = 50000') !== -1,
      'A8 输入侧上限不变（365 篇 / 50000 字符）—— 本次问题不在输入')
    ok(cloud.indexOf('temperature: 0.7') !== -1 && cloud.indexOf('model: MODEL') !== -1,
      'A9 请求体其余字段未被牵连')
    ok(cloud.indexOf('const choice = (res.body.choices && res.body.choices[0]) || {}') !== -1,
      'A10 choices 取值走 choice 局部变量（空响应不炸）')
  }

  // ----------------------------------------------------------
  console.log('== B) 结果页：截断透传 + 说明头如实标注 ==')
  {
    const ctx = initResult({ payload: { outputTruncated: true } })
    ok(!ctx.loadError && ctx.page, 'B0 结果页可加载并初始化', ctx.loadError)
    ok(ctx.page.data.outputTruncated === true, 'B1 data.outputTruncated 已置起')
    ok(ctx.page.data.truncated === false, 'B2 未误置输入侧 truncated（两种不完整分开）')

    const brief = ctx.page.buildBriefBlock()
    ok(brief.indexOf('【分析范围】共读取最近一个月 5 篇日记进行分析（内容较长，本次生成未完成）') !== -1,
      'B3 说明头如实标注「内容较长，本次生成未完成」', brief)
    ok(brief.indexOf('【总结需求】按时间线提取日记中的事件') === 0,
      'B4 说明头首行仍是总结需求（格式未变）')

    const diaryData = ctx.page.buildDiaryData()
    ok(diaryData.content.indexOf('（内容较长，本次生成未完成）') !== -1,
      'B5 落库正文自带截断说明（事后可追溯）')
    ok(diaryData.content === ctx.page.data.shareDiary.content,
      'B6 分享正文与落库正文仍逐字一致（summary-share-align 未被打破）')
    ok(diaryData.entryType === 'summary' && diaryData.tags.join() === 'AI总结',
      'B7 落库标记不变（不参与下一轮 AI 总结）')

    // 两种「不完整」同时出现：合并成一条括号，用分号分隔
    const ctx2 = initResult({ payload: { truncated: true, outputTruncated: true } })
    const brief2 = ctx2.page.buildBriefBlock()
    ok(brief2.indexOf('（日记较多，已选取最近部分；内容较长，本次生成未完成）') !== -1,
      'B8 两种不完整合并为一条括号（分号分隔，不出现双括号）', brief2)

    // 说明头分层仍认得出：截断说明写在第二行内，不新增第三行
    const share = require(path.join(base, 'utils', 'share.js'))
    const sp = (typeof share.splitPosterBrief === 'function')
      ? share.splitPosterBrief(ctx2.page.buildDiaryData().content) : { brief: '', body: '' }
    ok(sp.brief.split('\n').length === 2,
      'B9 海报说明头仍是两行（截断说明并入第二行，不破坏分层）', sp.brief)
  }

  // ----------------------------------------------------------
  console.log('== C) 智能总结页：payload 透传（行为级） ==')
  {
    const ctx = loadSummaryPage({
      cloudResult: {
        success: true,
        summaryText: '◆ 大事记\n· 7月22日 自驾返回北京。',
        diaryCount: 1,
        outputTruncated: true
      }
    })
    if (!ctx.page || typeof ctx.page.onGenerate !== 'function') {
      ok(false, 'C0 智能总结页可加载（旧版缺失即红）', ctx.loadError)
    } else {
      ctx.page.onLoad()
      ctx.page.setData({ prompt: '按时间线提取日记中的事件' }) // 未填需求时 onGenerate 会早退
      ctx.page.onGenerate()
      await tick(10)
      const emitted = ctx.sink.emitted.length ? ctx.sink.emitted[0] : null
      ok(!!emitted && emitted.name === 'summaryResult',
        'C1 生成成功仍走 summaryResult 事件通道', ctx.sink.emitted)
      const p = (emitted && emitted.payload) || {}
      ok(p.outputTruncated === true, 'C2 云函数 outputTruncated=true 已透传进 payload', p.outputTruncated)
      ok(!!p.content && p.prompt === ctx.page.data.prompt,
        'C3 正文与需求照旧传递（透传不干扰既有字段）')
      ok(!ctx.globalData.summaryResult || ctx.globalData.summaryResult.outputTruncated === true,
        'C4 全局兜底结果同样带 outputTruncated')
    }

    // 老云函数（不返回 outputTruncated）→ 回落 false，不出现 undefined 字面量
    const ctx2 = loadSummaryPage({
      cloudResult: { success: true, summaryText: '正文', diaryCount: 1 }
    })
    if (!ctx2.page || typeof ctx2.page.onGenerate !== 'function') {
      ok(false, 'C5 智能总结页可加载（旧版缺失即红）', ctx2.loadError)
    } else {
      ctx2.page.onLoad()
      ctx2.page.setData({ prompt: '按时间线提取日记中的事件' })
      ctx2.page.onGenerate()
      await tick(10)
      const p2 = (ctx2.sink.emitted.length ? ctx2.sink.emitted[0].payload : {}) || {}
      ok(p2.outputTruncated === false, 'C5 未部署的新云函数/老返回 → 回落 false', p2.outputTruncated)
    }
  }

  // ----------------------------------------------------------
  console.log('== D) 零回归：正常结果不加字、不改口径 ==')
  {
    const src = read(SJS)
    ok(src.indexOf('outputTruncated: !!r.outputTruncated') !== -1,
      'D1 智能总结页只做透传（不是就地判断）')

    const ctx = initResult()
    ok(ctx.page.data.outputTruncated === false, 'D2 正常结果 outputTruncated 为 false')
    ok(ctx.page.buildBriefBlock() ===
      '【总结需求】按时间线提取日记中的事件\n【分析范围】共读取最近一个月 5 篇日记进行分析',
      'D3 正常结果说明头逐字不变（无新增括号）', ctx.page.buildBriefBlock())
    ok(ctx.page.buildDiaryData().content.indexOf('【分析范围】共读取最近一个月 5 篇日记进行分析（') === -1,
      'D4 正常结果绝不出现多余括注')

    const wxml = read(RWXML)
    ok(wxml.indexOf('wx:if="{{outputTruncated}}"') !== -1 && wxml.indexOf('class="sr-trunc-hint"') !== -1,
      'D5 提示行受 wx:if 控制（正常情况不渲染）')
    ok(wxml.indexOf('{{truncated ? \'（日记较多，已选取最近部分）\' : \'\'}}') !== -1,
      'D6 原有「已选取最近部分」提示保留')
    ok(read(RWXSS).indexOf('.sr-trunc-hint {') !== -1,
      'D7 提示行样式已定义（不裸奔）')
    ok(read(RWXSS).indexOf('--brand-deep') !== -1,
      'D8 提示行走主题令牌（暗色主题同样可读）')
  }

  console.log('\nsummary token cap: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
