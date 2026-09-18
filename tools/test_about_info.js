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
