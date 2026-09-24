/**
 * [theme-transition v1] 深色模式「切页跳闪浅色一下」——转场底层回归测试
 * 运行：node tools/test_theme_transition.js
 *
 * 症状：深色模式下点任意入口切页，转场那一瞬先闪一整屏浅色，再翻深。
 * 根因（firstPaint 修不到的那一层）：
 *   app.wxss 的 page{ background-color: var(--bg) } —— `.theme-dark` 挂在页面根节点
 *   (.page) 上，page 元素吃不到深色令牌，恒为浅色 #EFEBE5；而转场时新页面 WXML 尚未
 *   上屏，露出的正是 page 元素这一层。
 * 修法：
 *   1) page 元素背景 → transparent，转场期露出「窗口底」（applyChrome 的
 *      wx.setBackgroundColor 全局设置、切页不重置 ⇒ 深色下 #1B1916）
 *   2) 页面 json 里写死的浅色 navigationBarBackgroundColor / backgroundColor 删除，
 *      颜色统一交运行时（否则进页时静态值把深色冲回浅色）
 *   3) 下拉回弹 loading 三点（静态 backgroundTextStyle=dark）运行时跟随主题
 *
 * 覆盖断言：
 *   A 组：静态（page 让位落地 / 令牌与基底未被误删 / 页面 json 清理且仍是合法 JSON）
 *   B 组：行为（applyChrome 深浅两档三件套 / 显式传参 / 老基础库缺 API 时降级不炸）
 *   C 组：前提不变量（page 让位后不得漏底：窗口底色必须 == 页面底色、16 页根视图仍满高带底）
 *   D 组：零回归（app.js 预置窗口底 + firstPaint 仍在）
 */
const fs = require('fs')
const path = require('path')

const base = path.resolve(__dirname, '..')
const APPWXSS = path.join(base, 'app.wxss')
const APPJSON = path.join(base, 'app.json')
const APPJS = path.join(base, 'app.js')
const THEME = path.join(base, 'utils', 'theme.js')
const FP = path.join(base, 'utils', 'firstPaint.js')

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
const jsonOf = (p) => JSON.parse(read(p))

/* 读页面 wxss 并递归展开 @import（about / setting-lock 复用 setting.wxss 的 .page 规则，
   不展开会误判「无 .page 规则」） */
function wxssOf(pg) {
  const seen = Object.create(null)
  function load(p) {
    if (seen[p]) return ''
    seen[p] = true
    let t = ''
    try { t = read(p) } catch (e) { return '' }
    return t.replace(/@import\s+["']([^"']+)["']\s*;/g, (m, rel) => {
      const abs = rel.charAt(0) === '/' ? path.join(base, rel) : path.resolve(path.dirname(p), rel)
      return load(abs)
    })
  }
  return load(path.join(base, 'pages', pg, pg + '.wxss'))
}

/* 取 CSS 规则块内容（从 header 之后第一个 '{' 到配对 '}'） */
function blockOf(css, header) {
  const i = css.indexOf(header)
  if (i === -1) return null
  const start = css.indexOf('{', i)
  if (start === -1) return null
  let depth = 0
  for (let k = start; k < css.length; k++) {
    if (css[k] === '{') depth++
    else if (css[k] === '}') { depth--; if (depth === 0) return css.slice(start + 1, k) }
  }
  return null
}

/* ============================================================
 * A 组：静态
 * ============================================================ */
console.log('---- A. 静态：page 让位落地 + 令牌/基底未被误删 ----')
{
  const css = read(APPWXSS)
  const pageBlock = blockOf(css, 'page {')
  const darkBlock = blockOf(css, '.theme-dark {')

  ok(!!pageBlock, 'A1 app.wxss 能解析出 page{} 块')
  ok(!!pageBlock && pageBlock.indexOf('background-color: transparent;') !== -1,
    'A2 page 元素背景已放权（background-color: transparent）')
  ok(css.indexOf('background-color: var(--bg);') === -1,
    'A3 全文不再有 page 层浅色底 background-color: var(--bg);（反向断言）')
  ok(!!pageBlock && pageBlock.indexOf('[theme-transition v1]') !== -1,
    'A4 page{} 块内留有可追溯标记 [theme-transition v1]')

  // 令牌与排版基底未被连带改坏
  ok(!!pageBlock && pageBlock.indexOf('--bg:            #EFEBE5;') !== -1,
    'A5 浅色 --bg 令牌仍在（#EFEBE5）')
  ok(!!pageBlock && pageBlock.indexOf('font-family: var(--font-body);') !== -1,
    'A6 排版基底 font-family 仍在')
  ok(!!pageBlock && pageBlock.indexOf('color: var(--ink);') !== -1,
    'A7 排版基底 color 仍在')
  ok(!!darkBlock && darkBlock.indexOf('--bg:            #1B1916;') !== -1,
    'A8 深色 --bg 令牌仍在（#1B1916）')
  ok(!!blockOf(css, '.container {') && blockOf(css, '.container {').indexOf('background: var(--bg)') !== -1,
    'A9 .container 仍自带底色（未被连带改坏）')

  const th = read(THEME)
  ok(th.indexOf('const m = mode || getMode()') !== -1 && th.indexOf('const c = CHROME[m] || CHROME.light') !== -1,
    'A10 applyChrome 取出 mode 变量（供下拉回弹三点复用）')
  ok(th.indexOf("wx.setBackgroundTextStyle({ textStyle: m === 'dark' ? 'light' : 'dark' })") !== -1,
    'A11 下拉回弹三点跟随主题（深色 light / 浅色 dark）')

  // 页面 json 清理
  const jSummary = read(path.join(base, 'pages', 'summary', 'summary.json'))
  const jFont = read(path.join(base, 'pages', 'font-setting', 'font-setting.json'))
  const jRemind = read(path.join(base, 'pages', 'setting-reminder', 'setting-reminder.json'))
  ok(jSummary.indexOf('navigationBarBackgroundColor') === -1, 'A12 summary.json 不再写死导航栏底色')
  ok(jSummary.indexOf('"backgroundColor"') === -1, 'A13 summary.json 不再写死页面级窗口底')
  ok(jFont.indexOf('navigationBarBackgroundColor') === -1, 'A14 font-setting.json 不再写死导航栏底色')
  ok(jRemind.indexOf('navigationBarBackgroundColor') === -1, 'A15 setting-reminder.json 不再写死导航栏底色')
  ok(jSummary.indexOf('#F8F4EE') === -1 && jFont.indexOf('#F8F4EE') === -1 && jRemind.indexOf('#F8F4EE') === -1,
    'A16 三处页面 json 都不再出现浅色字面量 #F8F4EE')

  // 删除不得伤到别的配置，且必须仍是合法 JSON
  let parseBad = []
  const jsonPaths = [APPJSON].concat(PAGES.map((pg) => path.join(base, 'pages', pg, pg + '.json')))
  jsonPaths.forEach((p) => { try { jsonOf(p) } catch (e) { parseBad.push(path.basename(p)) } })
  ok(parseBad.length === 0, 'A17 app.json + 16 页 json 全部仍是合法 JSON: ' + (parseBad.join(',') || '全部通过'))

  const s = jsonOf(path.join(base, 'pages', 'summary', 'summary.json'))
  ok(s.usingComponents && s.usingComponents['range-picker'] === '/components/range-picker/range-picker',
    'A18 summary.json 组件注册未被误删（range-picker）')
  ok(s.navigationBarTitleText === '智能总结' && s.navigationBarTextStyle === 'black',
    'A19 summary.json 标题与文字色保留')
  ok(jsonOf(path.join(base, 'pages', 'font-setting', 'font-setting.json')).navigationBarTitleText === '日记字体'
    && jsonOf(path.join(base, 'pages', 'setting-reminder', 'setting-reminder.json')).navigationBarTitleText === '闹钟提醒',
    'A20 另两页标题保留')

  // 全站页面 json 都不再由静态决定导航栏底色
  const withStatic = PAGES.filter((pg) => {
    const t = read(path.join(base, 'pages', pg, pg + '.json'))
    return t.indexOf('navigationBarBackgroundColor') !== -1
  })
  ok(withStatic.length === 0, 'A21 16 页 json 均无页面级导航栏底色（统一交运行时）: ' + (withStatic.join(',') || '全部干净'))
}

/* ============================================================
 * B 组：行为（theme.applyChrome / applyTo）
 * ============================================================ */
console.log('---- B. 行为：三件套深浅两档 + 降级 ----')

function installWx(store, drop) {
  drop = drop || []
  const sink = { nav: [], bg: [], text: [] }
  const api = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v },
    setNavigationBarColor: (o) => { sink.nav.push(o) },
    setBackgroundColor: (o) => { sink.bg.push(o) },
    setBackgroundTextStyle: (o) => { sink.text.push(o) }
  }
  drop.forEach((k) => { delete api[k] })
  global.wx = api
  return sink
}

function freshTheme(store, drop) {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })
  const sink = installWx(store, drop)
  return { theme: require(THEME), sink }
}

/* 红灯自检友好：源码缺这几次调用时取 null，而不是索引 undefined 抛 TypeError
   （换回备份版必须「精准变红、零崩溃」） */
const navOf = (sink) => (sink.nav[0] && sink.nav[0].backgroundColor) || null
const styleOf = (sink) => (sink.text[0] && sink.text[0].textStyle) || null

{
  // B1-B3 深色档
  {
    const r = freshTheme({ yidengji_theme_mode: 'dark' })
    r.theme.applyChrome()
    ok(r.sink.nav.length === 1 && r.sink.nav[0].backgroundColor === '#1B1916' && r.sink.nav[0].frontColor === '#ffffff',
      'B1 深色：导航栏 #1B1916 + 白字（瞬变）', r.sink.nav[0])
    ok(r.sink.nav[0] && r.sink.nav[0].animation && r.sink.nav[0].animation.duration === 0,
      'B2 深色：导航栏动画时长为 0（不许慢慢变深）', r.sink.nav[0] && r.sink.nav[0].animation)
    ok(r.sink.bg.length === 1 && r.sink.bg[0].backgroundColor === '#1B1916',
      'B3 深色：窗口底 = 页面底色（转场期露出的就是它）', r.sink.bg[0])
    ok(r.sink.text.length === 1 && r.sink.text[0].textStyle === 'light',
      'B4 深色：下拉回弹三点 = light', r.sink.text[0])
  }

  // B5-B6 浅色档
  {
    const r = freshTheme({ yidengji_theme_mode: 'light' })
    r.theme.applyChrome()
    ok(r.sink.nav[0] && r.sink.nav[0].backgroundColor === '#EFEBE5' && r.sink.nav[0].frontColor === '#000000',
      'B5 浅色：导航栏 #EFEBE5 + 黑字', r.sink.nav[0])
    ok(r.sink.bg.length === 1 && r.sink.bg[0].backgroundColor === '#EFEBE5',
      'B6 浅色：窗口底 #EFEBE5', r.sink.bg[0])
    ok(r.sink.text.length === 1 && r.sink.text[0].textStyle === 'dark',
      'B7 浅色：下拉回弹三点 = dark', r.sink.text[0])
  }

  // B8-B9 显式传参（不读 storage）
  {
    const r = freshTheme({ yidengji_theme_mode: 'light' })
    r.theme.applyChrome('dark')
    ok(navOf(r.sink) === '#1B1916' && styleOf(r.sink) === 'light',
      'B8 applyChrome("dark") 显式传参生效（三点也跟随实参）', [navOf(r.sink), styleOf(r.sink)])
    r.sink.nav.length = 0; r.sink.bg.length = 0; r.sink.text.length = 0
    r.theme.applyChrome('light')
    ok(navOf(r.sink) === '#EFEBE5' && styleOf(r.sink) === 'dark',
      'B9 applyChrome("light") 显式传参生效')
    r.sink.nav.length = 0; r.sink.bg.length = 0; r.sink.text.length = 0
    r.theme.applyChrome('bogus')
    ok(navOf(r.sink) === '#EFEBE5',
      'B10 applyChrome("bogus") 回落浅色（CHROME 兜底未破）', navOf(r.sink))
  }

  // B11-B13 老基础库缺 API 时降级不炸
  {
    const r1 = freshTheme({ yidengji_theme_mode: 'dark' }, ['setBackgroundTextStyle'])
    let threw = false
    try { r1.theme.applyChrome() } catch (e) { threw = true }
    ok(!threw, 'B11 无 setBackgroundTextStyle（老基础库）不抛错')
    ok(r1.sink.nav.length === 1 && r1.sink.bg.length === 1, 'B12 缺该 API 时导航栏/窗口底照常设置')

    const r2 = freshTheme({ yidengji_theme_mode: 'dark' }, ['setBackgroundColor'])
    threw = false
    try { r2.theme.applyChrome() } catch (e) { threw = true }
    ok(!threw, 'B13 无 setBackgroundColor 不抛错')
    ok(r2.sink.nav.length === 1 && r2.sink.text.length === 1, 'B14 缺该 API 时导航栏/三点照常设置')

    const r3 = freshTheme({ yidengji_theme_mode: 'dark' }, ['setNavigationBarColor'])
    threw = false
    try { r3.theme.applyChrome() } catch (e) { threw = true }
    ok(!threw && r3.sink.bg.length === 0 && r3.sink.text.length === 0,
      'B15 无 setNavigationBarColor 时整体早退、不抛错（保持原语义）')
  }

  // B16-B18 applyTo 回归
  {
    const r = freshTheme({ yidengji_theme_mode: 'dark' })
    const fake = { data: {}, setData(d) { Object.assign(this.data, d) } }
    r.theme.applyTo(fake)
    ok(fake.data.themeClass === 'theme-dark', 'B16 applyTo 深色：根节点类 theme-dark')
    ok(r.sink.nav.length === 1 && r.sink.bg.length === 1 && r.sink.text.length === 1,
      'B17 applyTo 深色：三件套各一次（不重复调用）',
      { nav: r.sink.nav.length, bg: r.sink.bg.length, text: r.sink.text.length })

    r.sink.nav.length = 0; r.sink.bg.length = 0; r.sink.text.length = 0
    r.theme.setMode('light')
    r.theme.applyTo(fake)
    ok(fake.data.themeClass === '' && navOf(r.sink) === '#EFEBE5' && styleOf(r.sink) === 'dark',
      'B18 applyTo 浅色：空串 + 浅色三件套')
  }
}

/* ============================================================
 * C 组：前提不变量（page 让位后不得漏底）
 * ============================================================ */
console.log('---- C. 前提不变量：让位后不许漏底 ----')
{
  const css = read(APPWXSS)
  const pageBg = (blockOf(css, 'page {') || '').match(/--bg:\s*(#[0-9A-Fa-f]{6})/)
  const darkBg = (blockOf(css, '.theme-dark {') || '').match(/--bg:\s*(#[0-9A-Fa-f]{6})/)

  const th = read(THEME)
  const chrome = {}
  ;['light', 'dark'].forEach((k) => {
    const m = th.match(new RegExp(k + ":\\s*\\{\\s*bg:\\s*'(#[0-9A-Fa-f]{6})'"))
    chrome[k] = m ? m[1] : null
  })

  /* 关键：转场期露出的窗口底必须与页面底同色，否则浅色/深色下都会看到一条色差 */
  ok(!!pageBg && chrome.light === pageBg[1],
    'C1 窗口底(浅色) == page 令牌 --bg，浅色下让位后零色差', { chrome: chrome.light, token: pageBg && pageBg[1] })
  ok(!!darkBg && chrome.dark === darkBg[1],
    'C2 窗口底(深色) == .theme-dark 令牌 --bg，深色下让位后零色差', { chrome: chrome.dark, token: darkBg && darkBg[1] })

  /* 每页根视图必须满高 + 自带底色，否则 page 让位后会露出窗口底/白边。
     about / setting-lock 的 .page 来自 @import "../setting/setting.wxss"，故递归展开后再判。 */
  const badBg = []
  const badH = []
  PAGES.forEach((pg) => {
    const b = blockOf(wxssOf(pg), '.page {')
    if (!b) { badBg.push(pg + '(无.page规则)'); badH.push(pg + '(无.page规则)'); return }
    if (b.indexOf('background: var(--bg)') === -1) badBg.push(pg)
    if (!/(min-height|height):\s*100vh/.test(b)) badH.push(pg)
  })
  ok(badBg.length === 0, 'C3 16 页根视图 .page 都自带底色: ' + (badBg.join(',') || '全部就位'))
  ok(badH.length === 0, 'C4 16 页根视图 .page 都满高（100vh）: ' + (badH.join(',') || '全部就位'))
}

/* ============================================================
 * D 组：零回归
 * ============================================================ */
console.log('---- D. 零回归 ----')
{
  const app = read(APPJS)
  ok(app.indexOf("require('./utils/theme.js').applyChrome()") !== -1,
    'D1 app.js onShow 仍在任何页面渲染前预置窗口底/导航栏')
  ok(fs.existsSync(FP), 'D2 utils/firstPaint.js 仍在（WXML 首帧层修复未被回退）')

  const theme = freshTheme({}, []).theme
  const exp = ['KEY', 'CHROME', 'getMode', 'setMode', 'pageClass', 'applyChrome', 'applyTo']
  ok(exp.every((k) => theme[k] !== undefined), 'D3 theme.js 导出齐全',
    exp.filter((k) => theme[k] === undefined))
  ok(theme.getMode() === 'light' && theme.pageClass('dark') === 'theme-dark' && theme.pageClass('light') === '',
    'D4 主题两档语义不变')
}

console.log('')
console.log(pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
