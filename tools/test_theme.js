/**
 * 主题（浅色/深色）回归测试
 * 覆盖：theme.js 行为、深浅色令牌对齐、根节点类注入、磨砂令牌化、深色继承重置、写死白字。
 * 运行：node tools/test_theme.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0

function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) }
}

function rd(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/* 取选择器块体：注释感知 + 花括号配平（注释里出现 { } 不会误截断） */
function blockOf(src, selector) {
  const i = src.indexOf(selector + ' {')
  if (i === -1) return null
  let j = src.indexOf('{', i) + 1
  let depth = 1
  let out = ''
  while (j < src.length && depth > 0) {
    if (src[j] === '/' && src[j + 1] === '*') { // 整段跳过注释
      const e = src.indexOf('*/', j + 2)
      if (e === -1) break
      j = e + 2
      continue
    }
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) break }
    out += src[j]
    j++
  }
  return out
}

/* 从 wxss 里提取选择器块内的自定义属性 */
function tokensOf(src, selector) {
  const body = blockOf(src, selector)
  if (body === null) return null
  const map = {}
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g
  let m
  while ((m = re.exec(body)) !== null) map[m[1]] = m[2].trim()
  return map
}

console.log('---- A. theme.js 行为 ----')
const themePath = path.join(ROOT, 'utils', 'theme.js')
delete require.cache[require.resolve(themePath)]

// 无 wx 环境：不得抛错
const themeNoWx = require(themePath)
ok(themeNoWx.getMode() === 'light', '无 wx 环境回落 light 不抛错')
ok(themeNoWx.pageClass('dark') === 'theme-dark', 'pageClass(dark) = theme-dark')
ok(themeNoWx.pageClass('light') === '', 'pageClass(light) = 空串')
ok(themeNoWx.getMode() === 'light' && themeNoWx.pageClass() === '', '无 wx 环境下取值链路完整')

// 有 wx 环境
const calls = { nav: [], bg: [], store: {} }
global.wx = {
  getStorageSync(k) { return calls.store[k] },
  setStorageSync(k, v) { calls.store[k] = v },
  setNavigationBarColor(o) { calls.nav.push(o) },
  setBackgroundColor(o) { calls.bg.push(o) }
}
delete require.cache[require.resolve(themePath)]
const theme = require(themePath)

ok(theme.getMode() === 'light', '默认 light')
ok(theme.pageClass() === '', '默认档根节点类 = 空串（不吃类）')

const fakePage = { data: {}, setData(d) { Object.assign(this.data, d) } }
theme.applyTo(fakePage)
ok(fakePage.data.themeClass === '', 'applyTo: light 档 themeClass = 空串')
ok(calls.nav.length === 1 && calls.nav[0].backgroundColor === '#EFEBE5', 'applyTo: light 导航栏 = #EFEBE5')
ok(calls.bg.length === 1 && calls.bg[0].backgroundColor === '#EFEBE5', 'applyTo: light 窗口底 = #EFEBE5')

theme.setMode('dark')
ok(theme.getMode() === 'dark', 'setMode(dark) 持久化')
ok(calls.store[theme.KEY] === 'dark', '存储键写入 dark')
theme.applyTo(fakePage)
ok(fakePage.data.themeClass === 'theme-dark', 'applyTo: dark 档 themeClass = theme-dark')
const lastNav = calls.nav[calls.nav.length - 1]
ok(lastNav.backgroundColor === '#1B1916' && lastNav.frontColor === '#ffffff', 'applyTo: dark 导航栏 = #1B1916 + 白字')
theme.setMode('light')

/* 非法值回落 */
global.wx.setStorageSync(theme.KEY, 'blue')
ok(theme.getMode() === 'light', '非法存储值回落 light')
global.wx.setStorageSync(theme.KEY, 'light')

console.log('---- B. 深浅色令牌对齐 ----')
const appwxss = rd('app.wxss')
const light = tokensOf(appwxss, 'page')
const dark = tokensOf(appwxss, '.theme-dark')
ok(light !== null && dark !== null, 'page{} 与 .theme-dark 块均存在')

/* 颜色类令牌清单（两套必须一一对应） */
const COLOR_TOKENS = [
  '--bg', '--bg-soft', '--surface', '--surface-soft', '--surface-press', '--surface-frost',
  '--ink', '--ink-mid', '--ink-soft', '--ink-faint', '--ink-invert',
  '--line', '--line-soft', '--line-strong',
  '--brand', '--brand-bright', '--brand-deep', '--brand-mute', '--brand-soft',
  '--brand-tint-08', '--brand-tint-12', '--brand-tint-25',
  '--brand-shadow-20', '--brand-shadow-22', '--brand-shadow-28', '--brand-shadow-55',
  '--danger', '--danger-deep', '--danger-bright', '--danger-soft',
  '--danger-shadow', '--danger-tint-20', '--danger-tint-25',
  '--ai', '--ai-deep', '--ai-soft', '--ai-tint-12', '--ai-tint-25', '--ai-shadow-25',
  '--shadow-sm', '--shadow-md', '--shadow-brand'
]
const missingDark = COLOR_TOKENS.filter(t => !(t in dark))
const missingLight = COLOR_TOKENS.filter(t => !(t in light))
ok(missingDark.length === 0, '深色块缺令牌: ' + (missingDark.join(', ') || '无'))
ok(missingLight.length === 0, '浅色块缺令牌: ' + (missingLight.join(', ') || '无'))

/* 深浅色取值必须真的不同（防止复制粘贴忘改） */
const same = COLOR_TOKENS.filter(t => light[t] === dark[t] && t !== '--ink-invert' && t !== '--shadow-brand')
ok(same.length === 0, '同名同值令牌（--ink-invert/--shadow-brand 除外）: ' + (same.join(', ') || '无'))

/* theme.js CHROME 与 wxss 令牌一致 */
ok(theme.CHROME.light.bg === light['--bg'], 'CHROME.light.bg 与 --bg 一致')
ok(theme.CHROME.dark.bg === dark['--bg'], 'CHROME.dark.bg 与深色 --bg 一致')

console.log('---- C. 页面接入 lint ----')
const PAGES = ['archive', 'agreement', 'backup', 'detail', 'font-setting', 'index', 'profile',
  'quote', 'setting', 'setting-reminder', 'summary', 'summary-result', 'write']
  /* about / setting-lock 经 @import "../setting/setting.wxss" 继承 .page 宽底，
     本页无 .page 块，不进本 lint（否则误报）；quote / agreement 已补 [dark-page-bg] */
let badWxml = []
let badJs = []
PAGES.forEach(pg => {
  const w = rd('pages/' + pg + '/' + pg + '.wxml')
  if (w.indexOf('<view class="page {{themeClass}}"') === -1) badWxml.push(pg)
  const j = rd('pages/' + pg + '/' + pg + '.js')
  if (j.indexOf("require('../../utils/theme.js')") === -1) badJs.push(pg + ':require')
  if (j.indexOf('theme.applyTo(this)') === -1) badJs.push(pg + ':applyTo')
})
ok(badWxml.length === 0, PAGES.length + ' 页根节点均挂 themeClass: ' + (badWxml.join(',') || '全部就位'))
ok(badJs.length === 0, PAGES.length + ' 页 js 均 require + applyTo: ' + (badJs.join(',') || '全部就位'))

/* 磨砂令牌化：写死的 rgba(248,244,238,0.95) 不得残留 */
let frostLeft = 0
let frostVar = 0
PAGES.forEach(pg => {
  const f = 'pages/' + pg + '/' + pg + '.wxss'
  if (!fs.existsSync(path.join(ROOT, f))) return
  const s = rd(f)
  frostLeft += (s.match(/rgba\(248,\s*244,\s*238,\s*0\.95\)/g) || []).length
  frostVar += (s.match(/var\(--surface-frost\)/g) || []).length
})
ok(frostLeft === 0, '写死磨砂色残留 = 0')
// x7：底栏 6 处 + [voice-clearall-v1] 语音清空撤销条 1 处（2026-09-24）
ok(frostVar === 7, 'var(--surface-frost) 引用 x7（实际 x' + frostVar + '）')

console.log('---- D. 深色继承重置（间接令牌 / color 继承）----')
/*
 * 背景：page{} 里 --title-ink: var(--ink) 这类「间接引用」在 page 元素层就完成 var() 替换
 * 并被钉死为浅色值。深色主题挂在页面根节点（.theme-dark），覆盖 --ink 不影响已解析的
 * --title-ink；page{} 上的 color: var(--ink) 同理，会让所有未显式声明 color 的文字
 * （典型：textarea 内容）在深色下仍是暗灰。故 .theme-dark 必须重挂引用 + 重置 color。
 * 本段用「合并后在本层解析」模拟该语义，防止后人删掉重置小节。
 */
const darkBody = blockOf(appwxss, '.theme-dark') || ''
const darkLayer = Object.assign({}, light, dark) // 深色元素上：浅色定义被深色覆盖

function resolveVal(map, expr) {
  return String(expr).replace(/var\((--[\w-]+)\)/g, (_, k) => (k in map ? map[k] : 'UNSET'))
}

ok(darkBody.indexOf('--title-ink:') !== -1, '.theme-dark 重挂 --title-ink')
ok(darkBody.indexOf('--title-ink-3:') !== -1, '.theme-dark 重挂 --title-ink-3')
ok(/color\s*:\s*var\(--ink\)/.test(darkBody), '.theme-dark 重置 color 继承（textarea 内容等）')

const lightTitleInk = resolveVal(light, light['--title-ink'])
const darkTitleInk = resolveVal(darkLayer, darkLayer['--title-ink'])
ok(lightTitleInk === light['--ink'], '浅色 --title-ink 解析为浅色墨色（' + lightTitleInk + '）')
ok(darkTitleInk === dark['--ink'], '深色 --title-ink 解析为深色墨色（' + darkTitleInk + '）')
ok(darkTitleInk !== lightTitleInk, '深浅色标题墨色确实不同（防「钉死」复发）')

const lightTitleInk3 = resolveVal(light, light['--title-ink-3'])
const darkTitleInk3 = resolveVal(darkLayer, darkLayer['--title-ink-3'])
ok(darkTitleInk3 === dark['--ink-soft'], '深色 --title-ink-3 解析为深色次要墨色（' + darkTitleInk3 + '）')
ok(darkTitleInk3 !== lightTitleInk3, '深浅色次要标题墨色确实不同')

/* page{} 里任何「深浅解析结果不同却未在深色块重挂」的间接令牌 = 潜在暗字缺口 */
const pageVarTokens = Object.keys(light).filter(k => /var\(/.test(light[k] || ''))
const uncovered = pageVarTokens.filter(k => {
  if (k in dark) return false // 已在本层重挂，安全
  return resolveVal(darkLayer, light[k]) !== resolveVal(light, light[k])
})
ok(uncovered.length === 0, 'page{} 间接令牌无未覆盖缺口: ' + (uncovered.join(', ') || '无'))

/* 页面底色必须在根节点层解析（.page 自带 var(--bg)），否则深色下会露白 */
const pageBgMissing = PAGES.filter(pg => {
  const f = 'pages/' + pg + '/' + pg + '.wxss'
  if (!fs.existsSync(path.join(ROOT, f))) return false
  const body = blockOf(rd(f), '.page')
  if (body === null) return true
  return !/background(-color)?\s*:\s*var\(--bg\)/.test(body)
})
ok(pageBgMissing.length === 0, '各页 .page 均自带宽底 var(--bg): ' + (pageBgMissing.join(', ') || '全部就位'))

console.log('---- E. 品牌实底反白文字（写死白字 lint）----')
/*
 * 品牌实底色（var(--brand)）在深色下被提亮为 #9C8E7B，若反白文字写死 #fff，
 * 对比度会从 7.68:1 掉到 3.20:1（低于 4.5:1）。正确写法是 color: var(--surface)：
 * 浅色 --surface=#FFFFFF（保持原样），深色 --surface=#262320（自动变深字 4.89:1）。
 */
function walkWxss(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'wxss备份') return
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkWxss(p, acc)
    else if (e.name.endsWith('.wxss')) acc.push(p)
  })
  return acc
}
const hardWhite = []
walkWxss(ROOT, []).forEach(p => {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/')
  const s = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const n = (s.match(/(?<![-\w])color\s*:\s*#(?:fff|ffffff)\b/gi) || []).length
  if (n) hardWhite.push(rel + ' x' + n)
})
ok(hardWhite.length === 0, '写死白字残留 = 0: ' + (hardWhite.join(', ') || '无'))
ok(dark['--surface'] === '#262320', '深色 --surface 为深色 #262320（反白文字自动转深字）')

console.log('')
console.log(pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
