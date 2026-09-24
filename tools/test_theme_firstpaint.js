/**
 * [theme-firstpaint v1] 主题 / 字体「首帧就位」回归测试
 * 运行：node tools/test_theme_firstpaint.js
 *
 * 症状：深色模式下点进日记本（或其他页），先闪一下浅色页再翻深。
 * 根因：各页 data 的 themeClass / fontStyle 初值是空串，真正赋值在 onShow
 *   （theme.applyTo / setData(fontSetting.buildStyle())），而首帧渲染读的是 data 初值。
 *   且 data 字面量只在页面 JS 模块**首次执行**时求值一次 —— 用户在设置页切主题后再进入
 *   「已加载过」的页面，初值仍是旧的。
 *
 * 修法：utils/firstPaint.js 包装全局 Page（app.js onLaunch 安装）
 *   - 注册期：data 缺 themeClass 补当前主题类；声明了 fontStyle 就填当前字体变量串
 *   - 实例期：包装 onLoad，首行按当前设置重写这两项（渲染前，无二次渲染）
 *
 * 覆盖断言：
 *   A 组：静态（firstPaint 接入 app.js / applyChrome 瞬变 + window 色源 / 16 页
 *        require+applyTo+根节点类 三重 lint 不因 hook 上线而腐化）
 *   B 组：hook 语义（注册期补值 / 实例期修正 / **切主题后重进已注册页也修正** /
 *        onLoad 原逻辑与参数透传 / 幂等 / 无 Page 不炸 / 不污染无 fontStyle 的页面）
 *   C 组：真实页面端到端（summary / write：install 后加载真 JS，data 已首帧就位）
 *   D 组：零回归（theme.js 原有导出与 applyTo 行为不变、页面自身 onShow 修正仍在）
 */
const fs = require('fs')
const path = require('path')

const base = path.resolve(__dirname, '..')
const FP = path.join(base, 'utils', 'firstPaint.js')
const THEME = path.join(base, 'utils', 'theme.js')
const APP = path.join(base, 'app.js')

const PAGES = ['about', 'agreement', 'archive', 'backup', 'detail', 'font-setting', 'index',
  'lock', 'profile', 'quote', 'setting', 'setting-lock', 'setting-reminder', 'summary',
  'summary-result', 'write']

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => fs.existsSync(p)

/* 清掉工程内的 require 缓存（页面 JS / firstPaint 需可重复加载） */
function clearCache() {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })
}

/* ============================================================
 * wx 桩 + Page 捕获（直连：真实模块读 global.wx，页面 JS 读 global.Page）
 * ============================================================ */
const sink = { nav: [], bg: [], toasts: [] }

function installWx(store) {
  sink.nav.length = 0
  sink.bg.length = 0
  sink.toasts.length = 0
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
    setNavigationBarColor: (o) => { sink.nav.push(o) },
    setBackgroundColor: (o) => { sink.bg.push(o) },
    showToast: (o) => { sink.toasts.push((o && o.title) || '') },
    showModal: () => {},
    getWindowInfo: () => ({ safeArea: { bottom: 700 }, screenHeight: 700, windowWidth: 375, statusBarHeight: 20 }),
    getSystemInfoSync: () => ({ safeArea: { bottom: 700 }, screenHeight: 700, windowWidth: 375, statusBarHeight: 20 }),
    getNetworkType: () => {},
    onNetworkStatusChange: () => {},
    createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([null]) }) }), exec: (cb) => cb && cb([]) }),
    nextTick: (fn) => { if (fn) setTimeout(fn, 0) },
    cloud: { init: () => {}, callFunction: () => Promise.resolve({ result: { success: true } }) },
    loadFontFace: () => {},
    navigateTo: () => {}, navigateBack: () => {}, redirectTo: () => {}, switchTab: () => {},
    setNavigationBarTitle: () => {}, setTabBarBadge: () => {}, hideTabBar: () => {}, showTabBar: () => {},
    stopPullDownRefresh: () => {}, setClipboardData: () => {}, getClipboardData: () => {},
    getPrivacySetting: () => {}, requirePrivacyAuthorize: () => {}, onNeedPrivacyAuthorization: () => {},
    getStorage: () => {}, setStorage: () => {}, removeStorage: () => {}
  }
  global.getApp = () => ({ globalData: { userInfo: null, needRefresh: false, aiMode: 'cloud', voiceTarget: null, voiceDraft: null } })
}

/* 加载 firstPaint 并安装（Page 桩就绪后） */
function installFirstPaint() {
  clearCache()
  const captured = []
  global.Page = (o) => { captured.push(o) }
  let fp = null
  let err = null
  try { fp = require(FP) } catch (e) { err = String(e && e.message) }
  let ret = null
  if (fp) { try { ret = fp.install() } catch (e) { err = String(e && e.message) } }
  return { fp, captured, ret, err }
}

/* 实例化一个已注册的页面（模拟小程序：data 深拷贝 + setData + 最小页面方法桩） */
function instantiate(opts) {
  const page = Object.create(opts)
  page.data = JSON.parse(JSON.stringify(opts.data || {}))
  page.setData = function (d) { Object.assign(this.data, d) }
  page.selectComponent = () => null
  page.selectAllComponents = () => []
  page.getOpenerEventChannel = () => ({ on: () => {}, emit: () => {} })
  page.route = ''
  return page
}

/* ============================================================
 * A 组：静态
 * ============================================================ */
console.log('---- A. 静态：接入与既有机制不被腐化 ----')
{
  ok(exists(FP), 'A1 utils/firstPaint.js 存在')

  const app = read(APP)
  ok(app.indexOf("require('./utils/firstPaint.js').install()") !== -1,
    'A2 app.js 安装首帧化（onLaunch，早于任何页面 JS）')
  ok(app.indexOf("require('./utils/theme.js').applyChrome()") !== -1,
    'A3 app.js 在页面首帧前同步窗口底/导航栏（App onShow 早于页面 onLoad）')

  const th = read(THEME)
  ok(th.indexOf('animation: { duration: 0, timingFunc: \'linear\' }') !== -1,
    'A4 applyChrome 关掉导航栏默认渐变（改为瞬变）')
  ok(th.indexOf('frontColor: c.front') !== -1 && th.indexOf('backgroundColor: c.bg') !== -1,
    'A5 导航栏两色仍来自 CHROME（未因加 animation 而丢）')

  // hook 不能替代 onShow 的 applyTo：16 页三重 lint
  const bad = { wxml: [], req: [], apply: [] }
  PAGES.forEach((pg) => {
    const w = read(path.join(base, 'pages', pg, pg + '.wxml'))
    if (w.indexOf('<view class="page {{themeClass}}"') === -1) bad.wxml.push(pg)
    const j = read(path.join(base, 'pages', pg, pg + '.js'))
    if (j.indexOf("require('../../utils/theme.js')") === -1) bad.req.push(pg)
    if (j.indexOf('theme.applyTo(this)') === -1) bad.apply.push(pg)
  })
  ok(bad.wxml.length === 0, 'A6 16 页根节点仍挂 {{themeClass}}: ' + (bad.wxml.join(',') || '全部就位'))
  ok(bad.req.length === 0, 'A7 16 页仍 require theme.js: ' + (bad.req.join(',') || '全部就位'))
  /* 关键：onShow 的 applyTo 管「在设置页改了主题、返回栈内已有页面」的刷新，不许被删 */
  ok(bad.apply.length === 0, 'A8 16 页 onShow 仍调 theme.applyTo(this): ' + (bad.apply.join(',') || '全部就位'))
}

/* ============================================================
 * B 组：hook 语义
 * ============================================================ */
console.log('---- B. hook 语义 ----')
{
  // B0 无 Page 全局：不抛错、返回 false
  {
    clearCache()
    delete global.Page
    let ret = 'throw'
    try { ret = require(FP).install() } catch (e) { ret = 'throw:' + e.message }
    ok(ret === false, 'B0 无 Page 全局时 install 返回 false 且不抛错（降级为 onShow 修正）', ret)
  }

  // B1-B2 安装与幂等
  const storeDark = { yidengji_theme_mode: 'dark' }
  installWx(storeDark)
  const r1 = installFirstPaint()
  ok(!r1.err && r1.fp, 'B1 firstPaint 可加载', r1.err)
  ok(r1.ret === true, 'B2 install() 返回 true（包装生效）', r1.ret)
  const wrappedRef = global.Page
  ok(!!wrappedRef && wrappedRef.__ypFirstPaint === true, 'B3 全局 Page 已带包装标记')
  const r2 = (function () { let v = null; try { v = r1.fp.install() } catch (e) { v = 'throw' } return v })()
  ok(r2 === true && global.Page === wrappedRef, 'B4 重复 install 幂等（不二次包装）')

  // B5 注册期补值（dark）
  global.Page({ data: {}, onLoad() {} })
  const reg = r1.captured[r1.captured.length - 1]
  ok(reg.data.themeClass === 'theme-dark',
    'B5 注册期：无 themeClass 的页面被补成当前主题（dark → theme-dark）', reg.data.themeClass)

  // B6 注册期不覆盖页面自己写的非空值
  global.Page({ data: { themeClass: 'custom-x' }, onLoad() {} })
  const reg2 = r1.captured[r1.captured.length - 1]
  ok(reg2.data.themeClass === 'custom-x', 'B6 注册期不覆盖页面已声明的非空值（只补缺失）', reg2.data.themeClass)

  // B7 注册期 fontStyle：声明了才填，没声明不污染
  global.Page({ data: { fontStyle: '' }, onLoad() {} })
  const reg3 = r1.captured[r1.captured.length - 1]
  ok(typeof reg3.data.fontStyle === 'string' && reg3.data.fontStyle.indexOf('--content-size:') === 0,
    'B7 注册期：声明 fontStyle 的页面被填成当前字体变量串', reg3.data.fontStyle)
  global.Page({ data: {}, onLoad() {} })
  const reg4 = r1.captured[r1.captured.length - 1]
  ok(!('fontStyle' in reg4.data), 'B8 未声明 fontStyle 的页面不被注入该字段（不污染）', Object.keys(reg4.data))

  // B9 实例期：onLoad 首行按当前设置同步
  let probe = 0
  global.Page({ data: {}, onLoad() { probe++ } })
  const opts = r1.captured[r1.captured.length - 1]
  const page = instantiate(opts)
  opts.onLoad.call(page)
  ok(page.data.themeClass === 'theme-dark', 'B9 onLoad 后 data.themeClass = 当前主题', page.data.themeClass)
  ok(probe === 1, 'B10 页面原有 onLoad 逻辑照跑（探针被调用一次）', probe)

  // B11 onLoad 参数透传
  let got = null
  global.Page({ data: {}, onLoad(o) { got = o } })
  const opts11 = r1.captured[r1.captured.length - 1]
  opts11.onLoad.call(instantiate(opts11), { id: '42' })
  ok(got && got.id === '42', 'B11 onLoad(options) 参数原样透传', got)

  // B12 无 onLoad 的页面（about/backup/setting 这类）也被补上 onLoad
  // 守卫：firstPaint.js 缺失时包装器不生效，页面仍无 onLoad —— 精准红而不是 TypeError
  global.Page({ data: {} })
  const opts12 = r1.captured[r1.captured.length - 1]
  if (typeof opts12.onLoad !== 'function') {
    ok(false, 'B12 原本没有 onLoad 的页面也完成首帧同步', '页面无 onLoad（包装器未生效）')
  } else {
    const page12 = instantiate(opts12)
    opts12.onLoad.call(page12)
    ok(page12.data.themeClass === 'theme-dark', 'B12 原本没有 onLoad 的页面也完成首帧同步', page12.data.themeClass)
  }

  // B13 【核心】切主题后重进「已加载过」的页面 —— data 初值已陈旧，onLoad 必须修正
  //      （这正是 data 初值方案做不到、必须靠实例期同步的场景）
  clearCache()
  installWx({ yidengji_theme_mode: 'light' }) // 页面注册时是浅色
  const r3 = installFirstPaint()
  global.Page({ data: {}, onLoad() {} })
  const opts13 = r3.captured[r3.captured.length - 1]
  ok(opts13.data.themeClass === '', 'B13a 注册期（浅色）补值为空串', opts13.data.themeClass)
  global.wx.setStorageSync('yidengji_theme_mode', 'dark') // 用户去设置页切成深色
  const page13 = instantiate(opts13) // 再次进入该页：模块已加载，opts.data 仍是旧值
  opts13.onLoad.call(page13)
  ok(page13.data.themeClass === 'theme-dark',
    'B13b 切主题后重进已注册页面：onLoad 修正为首帧深色（零闪的关键）', page13.data.themeClass)

  // B14 syncNow 不得注入页面没有的 fontStyle（守卫：firstPaint 缺失时精准红）
  if (!r3.fp) {
    ok(false, 'B14 syncNow 不给无 fontStyle 的页面塞字段', 'firstPaint 缺失')
    ok(false, 'B15 syncNow 写入当前主题', 'firstPaint 缺失')
    ok(false, 'B16 seedData 对空 data 不抛错', 'firstPaint 缺失')
  } else {
    const page14 = instantiate({ data: {} })
    r3.fp.syncNow(page14)
    ok(!('fontStyle' in page14.data), 'B14 syncNow 不给无 fontStyle 的页面塞字段', Object.keys(page14.data))
    ok(page14.data.themeClass === 'theme-dark', 'B15 syncNow 写入当前主题', page14.data.themeClass)

    let threw = false
    try { r3.fp.seedData(undefined); r3.fp.seedData(null); r3.fp.seedData({}) } catch (e) { threw = true }
    ok(!threw, 'B16 seedData 对空 data 不抛错')
  }
}

/* ============================================================
 * C 组：真实页面端到端（证明真实页 JS 确实走被包装的 Page）
 * ============================================================ */
console.log('---- C. 真实页面端到端 ----')
function loadRealPage(pg, store) {
  clearCache()
  installWx(store)
  const r = installFirstPaint()
  if (!r.fp || r.err) return { error: 'firstPaint 装配失败: ' + r.err }
  let err = null
  try { require(path.join(base, 'pages', pg, pg + '.js')) } catch (e) { err = String(e && e.message) }
  if (err) return { error: pg + '.js 加载失败: ' + err }
  const opts = r.captured[r.captured.length - 1]
  if (!opts) return { error: pg + ' 未注册 Page' }
  return { opts, fp: r.fp }
}

;['summary', 'write'].forEach((pg) => {
  const dark = loadRealPage(pg, { yidengji_theme_mode: 'dark' })
  ok(!dark.error, 'C ' + pg + ' 可在 hook 下加载', dark.error)
  if (dark.error) return
  ok(dark.opts.data.themeClass === 'theme-dark',
    'C ' + pg + ' 注册期 data.themeClass 已首帧就位（真实页走被包装的 Page）', dark.opts.data.themeClass)
  if ('fontStyle' in dark.opts.data) {
    ok(typeof dark.opts.data.fontStyle === 'string' && dark.opts.data.fontStyle.indexOf('--content-size:') === 0,
      'C ' + pg + ' fontStyle 也被首帧填入', dark.opts.data.fontStyle)
  }
  const p = instantiate(dark.opts)
  /* 真实页 onLoad 还会做页面环境相关的事（弹层、隐私查询、安全区…）。这里只关心
     主题/字体是否已就位，故 onLoad 异常不判红（B 组已用仿页面覆盖「onLoad 后仍正确」语义）。 */
  try { dark.opts.onLoad.call(p, {}) } catch (e) { /* 页面逻辑缺环境，忽略 */ }
  ok(p.data.themeClass === 'theme-dark', 'C ' + pg + ' onLoad 后仍是深色（未回退）', p.data.themeClass)
})

/* ============================================================
 * D 组：零回归
 * ============================================================ */
console.log('---- D. 零回归 ----')
{
  clearCache()
  const store = {}
  installWx(store)
  delete global.Page
  const theme = require(THEME)
  ok(theme.pageClass('dark') === 'theme-dark' && theme.pageClass('light') === '',
    'D1 theme.pageClass 两档不变')
  ok(theme.getMode() === 'light', 'D2 默认 light')
  theme.setMode('dark')
  ok(theme.getMode() === 'dark' && store[theme.KEY] === 'dark', 'D3 setMode 持久化不变')

  const fakePage = { data: {}, setData(d) { Object.assign(this.data, d) } }
  sink.nav.length = 0
  sink.bg.length = 0
  theme.applyTo(fakePage)
  ok(fakePage.data.themeClass === 'theme-dark', 'D4 applyTo: dark → theme-dark')
  ok(sink.nav.length === 1 && sink.nav[0].backgroundColor === '#1B1916' && sink.nav[0].frontColor === '#ffffff',
    'D5 applyTo: 导航栏深色 + 白字（瞬时动画不影响色值）', sink.nav[0])
  ok(sink.bg.length === 1 && sink.bg[0].backgroundColor === '#1B1916', 'D6 applyTo: 窗口底同步', sink.bg[0])

  theme.setMode('light')
  sink.nav.length = 0
  theme.applyTo(fakePage)
  ok(fakePage.data.themeClass === '' && sink.nav[0].backgroundColor === '#EFEBE5',
    'D7 applyTo: light 档回到空串 + 浅色导航栏')

  const exp = ['KEY', 'CHROME', 'getMode', 'setMode', 'pageClass', 'applyChrome', 'applyTo']
  ok(exp.every((k) => theme[k] !== undefined), 'D8 theme.js 原有导出齐全（未因改动丢接口）',
    exp.filter((k) => theme[k] === undefined))
}

console.log('')
console.log(pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
