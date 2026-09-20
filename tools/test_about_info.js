/**
 * 「关于」页信息一致性测试（纯 Node，无需小程序环境）
 *
 * 守护 6 件事：
 *  1) utils/appInfo.js 的常量格式（版本号 / 备案号后缀 / 微信号）
 *  2) about 页四文件齐全，json 导航标题与 APP_NAME 一致（改 APP_NAME 时会咬）
 *  3) setting.js 的跳转路径与 app.json 的注册路径一致（防路径写错→点击无反应）
 *  4) about.wxml 用到的图标都在 icon.wxss 字体子集里（防出现空图标）
 *  5) about.wxml 绑定的事件 / 引用的变量都在 about.js 有实现与声明
 *  6) APP_NAME 字面量泄漏护栏：侧栏标题必须绑 {{appName}}；全量 wxml 扫描 + 白名单
 *
 * 用法：node tools/test_about_info.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const lines = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    lines.push('  ✓ ' + name)
  } else {
    fail++
    lines.push('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function section(title) {
  lines.push('')
  lines.push('[' + title + ']')
}

const info = require(path.join(ROOT, 'utils/appInfo.js'))

// ---------- 1. 常量 ----------
section('appInfo 常量')
ok('APP_NAME 非空', typeof info.APP_NAME === 'string' && info.APP_NAME.length > 0, String(info.APP_NAME))
ok('APP_NAME === 一灯记（3.A 范围：仅关于页用此名）', info.APP_NAME === '一灯记', String(info.APP_NAME))
ok('APP_VERSION 形如 x.y.z', /^\d+\.\d+\.\d+$/.test(info.APP_VERSION), String(info.APP_VERSION))
ok('APP_INTRO 是一段完整简介', typeof info.APP_INTRO === 'string' && info.APP_INTRO.length >= 30,
  'len=' + (info.APP_INTRO || '').length)
ok('ICP_NO 含主体编号 + 序列号后缀', /^[\u4e00-\u9fa5]+ICP备\d+号-\d+[A-Z]$/.test(info.ICP_NO), String(info.ICP_NO))
ok('ICP_SITE 是工信部备案系统域名', info.ICP_SITE === 'beian.miit.gov.cn', String(info.ICP_SITE))
ok('WECHAT_ID 非空且无空格', /^\S{4,}$/.test(info.WECHAT_ID), String(info.WECHAT_ID))

// ---------- 2. 页面文件与标题 ----------
section('关于页文件')
const FILES = [
  'pages/about/about.js',
  'pages/about/about.json',
  'pages/about/about.wxml',
  'pages/about/about.wxss'
]
FILES.forEach((f) => {
  ok('存在 ' + f, fs.existsSync(path.join(ROOT, f)))
})

let aboutJson = {}
try {
  aboutJson = JSON.parse(read('pages/about/about.json'))
  ok('about.json 是合法 JSON', true)
} catch (e) {
  ok('about.json 是合法 JSON', false, e.message)
}
ok('导航标题与 APP_NAME 一致', aboutJson.navigationBarTitleText === info.APP_NAME,
  'json=' + aboutJson.navigationBarTitleText + ' / appInfo=' + info.APP_NAME)
ok('about.json 声明了 usingComponents', aboutJson.usingComponents !== undefined)

// ---------- 3. 路由与入口 ----------
section('路由与入口')
const appJson = JSON.parse(read('app.json'))
const pages = appJson.pages || []
ok('app.json 已注册 pages/about/about', pages.indexOf('pages/about/about') !== -1)
ok('about 只注册一次', pages.filter((p) => p === 'pages/about/about').length === 1)

const settingJs = read('pages/setting/setting.js')
ok('setting.js 已无 showAbout（旧弹窗拆除）', settingJs.indexOf('showAbout') === -1)
ok('setting.js 有 goToAbout', settingJs.indexOf('goToAbout') !== -1)
ok('跳转路径与注册路径一致 → /pages/about/about',
  settingJs.indexOf("'/pages/about/about'") !== -1 && pages.indexOf('pages/about/about') !== -1)
ok('setting.js 已无旧弹窗文案', settingJs.indexOf('关于AI日记') === -1)

const settingWxml = read('pages/setting/setting.wxml')
ok('setting.wxml 绑定 goToAbout', settingWxml.indexOf('bindtap="goToAbout"') !== -1)
ok('setting.wxml 不再绑定 showAbout', settingWxml.indexOf('bindtap="showAbout"') === -1)

// ---------- 4. 图标 ----------
section('图标子集')
const iconCss = read('icon.wxss')
const aboutWxml = read('pages/about/about.wxml')
const usedIcons = (aboutWxml.match(/\bri-[\w-]+\b/g) || []).filter((c) => c !== 'ri')
const definedIcons = (iconCss.match(/\.(ri-[\w-]+)::before/g) || []).map((s) => s.slice(1).replace('::before', ''))
const missingIcons = usedIcons.filter((c) => definedIcons.indexOf(c) === -1)
ok('用到的图标都已内嵌（' + usedIcons.length + ' 个）', missingIcons.length === 0, missingIcons.join(','))

// ---------- 5. 事件与数据绑定 ----------
section('事件与数据绑定')
const aboutJs = read('pages/about/about.js')
const methods = (aboutJs.match(/^  ([A-Za-z_]\w*)\(/gm) || []).map((s) => s.trim().replace('(', ''))
const handlers = (aboutWxml.match(/(?:bind|catch)tap="([A-Za-z_]\w*)"/g) || [])
  .map((s) => s.replace(/.*"([A-Za-z_]\w*)"/, '$1'))
const missingMethods = handlers.filter((h) => methods.indexOf(h) === -1)
ok('绑定的事件都有实现（' + handlers.length + ' 个）', missingMethods.length === 0, missingMethods.join(','))

const dataBlock = aboutJs.slice(aboutJs.indexOf('  data: {'), aboutJs.indexOf('  onShow'))
const dataKeys = (dataBlock.match(/^    ([A-Za-z_]\w*):/gm) || []).map((s) => s.trim().replace(':', ''))
const vars = (aboutWxml.match(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g) || [])
  .map((s) => s.replace(/[{}]/g, '').trim())
const missingVars = vars.filter((v) => dataKeys.indexOf(v) === -1)
ok('wxml 变量都在 data 中声明（' + vars.length + ' 个）', missingVars.length === 0, missingVars.join(','))

ok('复制走 wx.setClipboardData', aboutJs.indexOf('wx.setClipboardData') !== -1)
ok('about.js 未硬编码备案号（只从 appInfo 取）', aboutJs.indexOf('京ICP备') === -1)
ok('about.js 接入主题（theme.applyTo）', aboutJs.indexOf('theme.applyTo(this)') !== -1)

// ---------- 6. APP_NAME 字面量泄漏护栏 ----------
// APP_NAME 只允许来自 utils/appInfo.js；页面/组件里硬编码就成了「第二来源」，
// 改品牌名时必然漏改（2026-09-18：侧栏居中标题写死「AI日记」，品牌改名后漏了一整轮）
section('APP_NAME 字面量泄漏')
const writeJs = read('pages/write/write.js')
const writeWxml = read('pages/write/write.wxml')
ok('write.js 已引入 appInfo', writeJs.indexOf("require('../../utils/appInfo.js')") !== -1)
ok('write.js data 暴露 appName', writeJs.indexOf('appName: appInfo.APP_NAME,') !== -1)
ok('侧栏标题绑定 {{appName}}（不再硬编码）',
  writeWxml.indexOf('<view class="sidebar-title">{{appName}}</view>') !== -1)
ok('侧栏标题区已无字面量',
  /<view class="sidebar-title">[^<{]*<\/view>/.test(writeWxml) === false,
  (writeWxml.match(/<view class="sidebar-title">[^<]*<\/view>/) || [''])[0])

// [nav-slogan v1] 写日记主页顶栏标题 = 品牌名 + 标语：两者都必须来自 appInfo
ok('APP_SLOGAN 非空', typeof info.APP_SLOGAN === 'string' && info.APP_SLOGAN.length > 0,
  String(info.APP_SLOGAN))
ok('顶栏标题由 appInfo 拼出（APP_NAME + · + APP_SLOGAN）',
  writeJs.indexOf("navTitle: appInfo.APP_NAME + '·' + appInfo.APP_SLOGAN,") !== -1)
ok('顶栏标题绑定 {{navTitle}}（不再硬编码）',
  writeWxml.indexOf('<view class="nav-title" style="{{navTitleStyle}}">{{navTitle}}</view>') !== -1)
ok('顶栏标题区已无字面量',
  /<view class="nav-title"[^>]*>[^<{]*<\/view>/.test(writeWxml) === false,
  (writeWxml.match(/<view class="nav-title"[^>]*>[^<]*<\/view>/) || [''])[0])
ok('顶栏实际标题 = 一灯记·让AI照亮此间',
  info.APP_NAME + '·' + info.APP_SLOGAN === '一灯记·让AI照亮此间',
  info.APP_NAME + '·' + info.APP_SLOGAN)
ok('侧栏标题仍绑 appName（未被顶栏改动波及）',
  writeWxml.indexOf('<view class="sidebar-title">{{appName}}</view>') !== -1)

// [nav-title-30 v1] 顶栏字号 30rpx（用户指定的半档值，不再走标题令牌刻度）
const writeWxss = read('pages/write/write.wxss')
const navTitleBlock = (writeWxss.match(/\.nav-title \{[\s\S]*?\}/) || [''])[0]
const sidebarTitleBlock = (writeWxss.match(/\.sidebar-title \{[\s\S]*?\}/) || [''])[0]
ok('.nav-title 规则块可定位', navTitleBlock.length > 0)
ok('顶栏标题字号 = 30rpx（用户指定的半档值，非令牌档位）',
  navTitleBlock.indexOf('font-size: 30rpx') !== -1 &&
  navTitleBlock.indexOf('font-size: var(--title-') === -1,
  navTitleBlock.replace(/\s+/g, ' ').slice(0, 130))
ok('顶栏其余样式未动（字重/颜色/字距/字体仍是 title 系）',
  navTitleBlock.indexOf('font-weight: var(--title-w)') !== -1 &&
  navTitleBlock.indexOf('color: var(--title-ink)') !== -1 &&
  navTitleBlock.indexOf('letter-spacing: var(--title-track)') !== -1 &&
  navTitleBlock.indexOf('font-family: var(--font-display)') !== -1)
ok('侧栏标题字号未被波及（仍 --title-2）',
  sidebarTitleBlock.indexOf('font-size: var(--title-2)') !== -1)

// [nav-title-center v1] 顶栏标题「视觉居中」（避让微信胶囊）+ 溢出护栏
// 缘由：右侧胶囊是系统层覆盖、左侧只有汉堡图标 ⇒ 数学居中看着偏右。
// 口径：标题中心对准「图标可视线右缘 与 胶囊左缘」的中点，偏移经内联 margin-left 施加。
let navbar = null
try { navbar = require(path.join(ROOT, 'utils', 'navbar.js')) } catch (e) { navbar = null }
ok('utils/navbar.js 可加载且导出纯函数',
  !!(navbar && typeof navbar.computeNavTitle === 'function' && typeof navbar.estimateTextWidthRpx === 'function'))

if (navbar && typeof navbar.computeNavTitle === 'function') {
  const TITLE = info.APP_NAME + '·' + info.APP_SLOGAN
  // 375pt 屏：胶囊左缘 = 375 − 7(贴右) − 87(宽) = 281
  const r375 = navbar.computeNavTitle({ screenW: 375, capsuleLeft: 281, text: TITLE })
  const iconRight375 = navbar.ICON_RIGHT_RPX * (375 / 750)
  const mid375 = (iconRight375 + 281) / 2
  ok('375 屏：偏移为正，且标题中心落在「图标右缘 ↔ 胶囊左缘」中点',
    r375.shiftPx > 0 && Math.abs((375 / 2 - r375.shiftPx) - mid375) < 0.05,
    'shift=' + r375.shiftPx + ' 落点=' + (375 / 2 - r375.shiftPx) + ' 目标=' + mid375)
  ok('375 屏：偏移量 ≈ 27.5px', Math.abs(r375.shiftPx - 27.5) < 0.6, String(r375.shiftPx))
  ok('375 屏：内联样式用 margin-left（不用 left —— 失效时退回数学居中而非跑飞）',
    r375.style === 'margin-left: -27.5px', r375.style)
  ok('375 屏：当前标题不触发缩字（仍有余量）',
    r375.scaled === false && r375.truncated === false && r375.style.indexOf('font-size') === -1, r375.style)

  const r320 = navbar.computeNavTitle({ screenW: 320, capsuleLeft: 320 - 94, text: TITLE })
  ok('320 窄屏：偏移按本机算（比 375 更大），当前标题仍不缩字',
    r320.shiftPx > 27.5 && r320.scaled === false, 'shift=' + r320.shiftPx + ' scaled=' + r320.scaled)

  const rFallback = navbar.computeNavTitle({ screenW: 375, capsuleLeft: 0, text: TITLE })
  ok('取不到胶囊信息时走兜底估算，结果与显式传入一致',
    Math.abs(rFallback.shiftPx - r375.shiftPx) < 0.05 && rFallback.capsuleLeft === 281)

  const rWeird = navbar.computeNavTitle({ screenW: 375, capsuleLeft: 400, text: TITLE })
  ok('胶囊信息异常 → shift=0 且样式不含定位（退回数学居中，不推向不可预期位置）',
    rWeird.shiftPx === 0 && rWeird.style.indexOf('margin-left') === -1, rWeird.style)

  const LONG = '一灯记·让AI照亮此间这是非常非常长的标题占位'
  const rLong = navbar.computeNavTitle({ screenW: 375, capsuleLeft: 281, text: LONG })
  ok('超长标题触发缩字', rLong.scaled === true && rLong.fontRpx < 30, 'font=' + rLong.fontRpx)
  ok('缩字不低于下限 24rpx', rLong.fontRpx >= navbar.MIN_FONT_RPX, String(rLong.fontRpx))
  ok('缩到下限仍不够则截断（max-width + 省略号）',
    rLong.truncated === true &&
    rLong.style.indexOf('max-width:') !== -1 &&
    rLong.style.indexOf('text-overflow: ellipsis') !== -1, rLong.style)
  ok('估算宽度：全角 1 字号宽、半角 0.55（本标题 ≈ 308.5rpx）',
    Math.abs(navbar.estimateTextWidthRpx(TITLE, 30) - 308.5) < 1.5,
    String(navbar.estimateTextWidthRpx(TITLE, 30)))
}

ok('write.js 已引入 utils/navbar.js', writeJs.indexOf("require('../../utils/navbar.js')") !== -1)
ok('write.js 调用 computeNavTitle 并把结果写进 navTitleStyle',
  writeJs.indexOf('navbar.computeNavTitle(') !== -1 &&
  writeJs.indexOf('navTitleStyle: navTitleLayout.style') !== -1)
ok('write.js 取胶囊信息包了 try/catch（取不到不阻塞页面）',
  writeJs.indexOf('getMenuButtonBoundingClientRect') !== -1 &&
  writeJs.indexOf('catch (e) {\n      capsuleLeft = 0') !== -1)
ok('write.wxml 顶栏标题绑定内联样式 {{navTitleStyle}}',
  writeWxml.indexOf('<view class="nav-title" style="{{navTitleStyle}}">{{navTitle}}</view>') !== -1)
ok('.nav-title 仍保留 left:50% + translateX(-50%)（内联偏移缺失时的降级底）',
  navTitleBlock.indexOf('left: 50%') !== -1 && navTitleBlock.indexOf('translateX(-50%)') !== -1)

// 白名单：已知的、暂未收敛的硬编码点（值为允许出现次数）
// 收敛后请把次数改为 0（或从表里删掉），别让白名单变成永久豁免
const ALLOW_HARDCODED = {
  'pages/lock/lock.wxml': 1,   // 锁屏页品牌名
  'pages/write/write.wxml': 1  // 技术支持致谢行「一灯记 由DeepSeek…」
}
function walkWxml(dir) {
  let out = []
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walkWxml(p))
    else if (/\.wxml$/.test(e.name)) out.push(p)
  })
  return out
}
const leaked = []
const scanned = [].concat(walkWxml(path.join(ROOT, 'pages')), walkWxml(path.join(ROOT, 'components')))
scanned.forEach((p) => {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/')
  const n = (fs.readFileSync(p, 'utf8').match(new RegExp(info.APP_NAME, 'g')) || []).length
  const allow = ALLOW_HARDCODED[rel] || 0
  if (n > allow) leaked.push(rel + '(' + n + '>' + allow + ')')
})
ok('wxml 硬编码 APP_NAME 未超出白名单（扫 ' + scanned.length + ' 个文件）',
  leaked.length === 0, leaked.join(', '))

// 红灯自检：拿改动前的 write.wxml 跑同一判据，必须不通过（证明断言有区分度）
const BK_OLD_WXML = 'C:\\Users\\ThinkPad\\WorkBuddy\\sidebartitle-backup-20260918\\pages\\write\\write.wxml'
if (fs.existsSync(BK_OLD_WXML)) {
  const oldWxml = fs.readFileSync(BK_OLD_WXML, 'utf8')
  ok('红灯自检：改动前侧栏标题确实硬编码（断言有区分度）',
    oldWxml.indexOf('<view class="sidebar-title">{{appName}}</view>') === -1)
}

// ---------- 汇总 ----------
lines.push('')
lines.push('===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====')
console.log(lines.join('\n'))
process.exit(fail === 0 ? 0 : 1)
