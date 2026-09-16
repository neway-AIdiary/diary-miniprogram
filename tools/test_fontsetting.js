/**
 * 「日记字体」设置模块测试 + UGC 类令牌 lint
 * 运行：node tools/test_fontsetting.js
 *
 * A. 常量：字号三档 / 字体族定义
 * B. 归一化与兜底：非法值一律回落默认档
 * C. buildStyle：CSS 变量串拼装
 * D. 读写：setSize / setFont 持久化（mock wx）
 * E. 导出：getDocxSize 与档位对应
 * F. lint：所有 UGC 类必须引用内容令牌（防回归）
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log('  ✗ ' + msg)
  }
}

// ---------- 无 wx 环境先加载，验证 fallback ----------
const fontSetting = require('../utils/fontSetting.js')

// ============ A. 常量 ============
console.log('== A. 常量 ==')
ok(fontSetting.SIZE_OPTIONS.length === 3, '字号三档')
ok(fontSetting.SIZE_OPTIONS[0].rpx === 28 && fontSetting.SIZE_OPTIONS[1].rpx === 32 && fontSetting.SIZE_OPTIONS[2].rpx === 36,
  '三档正文 rpx = 28/32/36')
ok(fontSetting.SIZE_OPTIONS[0].nameRpx === 30 && fontSetting.SIZE_OPTIONS[1].nameRpx === 34 && fontSetting.SIZE_OPTIONS[2].nameRpx === 38,
  '三档档案名词条 rpx = 30/34/38')
ok(fontSetting.SIZE_OPTIONS[1].docx === 28, '中档 docx 半磅值 = 28（14pt）')
ok(fontSetting.FONT_OPTIONS.length === 3, '字体 3 种（黑体/宋体/楷体）')
ok(fontSetting.FONT_OPTIONS.map(f => f.key).join(',') === 'sans,serif,kai', '字体键序 = sans,serif,kai')
ok(fontSetting.FONT_OPTIONS.every(f => f.key !== 'fangsong' && f.key !== 'round'), '仿宋/圆体选项已移除')
ok(!!fontSetting.REMOTE_FONTS && fontSetting.REMOTE_FONTS.serif && fontSetting.REMOTE_FONTS.kai, '托管字体表含 serif/kai（键名必须与 FONT_OPTIONS 一致）')
ok(fontSetting.REMOTE_FONTS.serif.family === 'YDSongti' && fontSetting.REMOTE_FONTS.kai.family === 'YDKaiti', '托管注册名与字体栈栈首对应')
ok(fontSetting.FONT_OPTIONS[1].stack.indexOf("'YDSongti'") === 0, '宋体栈首 = YDSongti（托管优先）')
ok(fontSetting.FONT_OPTIONS[2].stack.indexOf("'YDKaiti'") === 0, '楷体栈首 = YDKaiti（托管优先）')
ok(fontSetting.FONT_OPTIONS[0].key === 'sans', '默认字体 = 系统黑体')
ok(fontSetting.DEFAULT_SETTING.size === 'medium' && fontSetting.DEFAULT_SETTING.font === 'sans', '默认 = 中档 + 系统黑体')

// 字体栈兜底一致性：一律以 sans-serif 结尾（安卓不内置中文衬线，落 serif 会串字体）
fontSetting.FONT_OPTIONS.forEach(f => {
  ok(/sans-serif$/.test(f.stack), '字体栈兜底为 sans-serif：' + f.key)
  ok(!/,\s*serif\s*$/.test(f.stack), '字体栈不出现裸 serif 兜底：' + f.key)
  ok(f.label && f.desc, '字体有中文名与说明：' + f.key)
})

// ============ B. 归一化与兜底 ============
console.log('== B. 归一化与兜底 ==')
ok(fontSetting.getSetting().size === 'medium', '无 wx 环境 getSetting 回落中档')
ok(fontSetting.getSetting().font === 'sans', '无 wx 环境 getSetting 回落系统黑体')

// ============ C. buildStyle ============
console.log('== C. buildStyle ==')
const styleLarge = fontSetting.buildStyle({ size: 'large', font: 'kai' })
ok(styleLarge.indexOf('--content-size:36rpx') !== -1, '大档 --content-size = 36rpx')
ok(styleLarge.indexOf('--content-name-size:38rpx') !== -1, '大档 --content-name-size = 38rpx')
ok(styleLarge.indexOf('--content-font:') !== -1 && styleLarge.indexOf('Kaiti SC') !== -1, '含楷体字体栈')
ok(styleLarge.lastIndexOf(';') === styleLarge.length - 1, '变量串以分号收尾（可安全内联）')
ok(styleLarge.indexOf('{') === -1 && styleLarge.indexOf('\n') === -1, '变量串无换行/花括号')

const styleBad = fontSetting.buildStyle({ size: 'huge', font: 'nope' })
ok(styleBad.indexOf('--content-size:32rpx') !== -1, '非法档位回落中档 32rpx')
ok(styleBad.indexOf('PingFang SC') !== -1, '非法字体回落系统黑体栈')

// ============ D. 读写 ============
console.log('== D. setSize / setFont ==')
global.wx = {
  _s: {},
  getStorageSync(k) { return this._s[k] },
  setStorageSync(k, v) { this._s[k] = v }
}
fontSetting.clearCache()
ok(fontSetting.getSetting().size === 'medium', '首次读取（空存储）＝中档')

fontSetting.setSize('large')
ok(global.wx._s.fontSetting.size === 'large', 'setSize 已写入 storage')
ok(fontSetting.getSetting().size === 'large', 'setSize 后内存缓存同步')

fontSetting.setFont('serif')
ok(global.wx._s.fontSetting.font === 'serif', 'setFont 已写入 storage')
ok(global.wx._s.fontSetting.size === 'large', 'setFont 未覆盖 size')

// 脏数据兜底
global.wx._s.fontSetting = { size: 'x', font: 'y' }
fontSetting.clearCache()
ok(fontSetting.getSetting().size === 'medium' && fontSetting.getSetting().font === 'sans', '脏存储回落默认')

// 存储抛异常也不崩
global.wx.setStorageSync = () => { throw new Error('boom') }
fontSetting.clearCache()
let threw = false
try { fontSetting.setSize('small') } catch (e) { threw = true }
ok(!threw, 'storage 写入异常不抛出')
ok(fontSetting.getSetting().size === 'small', '写入失败时内存缓存仍生效')

delete global.wx

// ============ D2. 托管字体按需加载（ensureLoaded） ============
console.log('== D2. ensureLoaded ==')
// 无 wx 环境：不得抛出
let threwLoad = false
try { fontSetting.ensureLoaded('serif') } catch (e) { threwLoad = true }
ok(!threwLoad, '无 wx 环境调用不抛出')
ok(fontSetting.ensureLoaded('sans') === false, '非托管字体（sans）直接跳过')
ok(fontSetting.ensureLoaded('fangsong') === false, '已下线选项（fangsong）直接跳过')

// 有 wx 环境：托管地址已配置 → serif 必须发起 loadFontFace（回归点：键名不一致会导致静默跳过）
global.wx = {
  _s: {},
  getStorageSync(k) { return this._s[k] },
  setStorageSync(k, v) { this._s[k] = v },
  _loadCalls: [],
  loadFontFace(opt) { this._loadCalls.push(opt) }
}
fontSetting.clearCache()
ok(fontSetting.ensureLoaded('serif') === true, 'serif 触发托管加载')
ok(global.wx._loadCalls.length === 1, 'loadFontFace 被调用 1 次')
ok(global.wx._loadCalls[0] && global.wx._loadCalls[0].family === 'YDSongti', '注册名 = YDSongti（宋体）')
ok(global.wx._loadCalls[0].global === true, 'global 全局生效')
ok(/yidengji-song\.woff2/.test(global.wx._loadCalls[0].source || ''), 'source 指向云存储 song 地址')
ok(fontSetting.ensureLoaded('serif') === true && global.wx._loadCalls.length === 1, '已加载不重复发起')
ok(fontSetting.ensureLoaded('sans') === false, '非托管字体（sans）不发起')
ok(fontSetting.ensureLoaded('fangsong') === false, '已下线选项（fangsong）不发起')

delete global.wx

// ============ E. 导出 ============
console.log('== E. getDocxSize ==')
fontSetting.clearCache()
ok(fontSetting.getDocxSize() === 28, '默认中档导出半磅 = 28')
fontSetting.setSize('small')
ok(fontSetting.getDocxSize() === 24, '小档导出半磅 = 24')
fontSetting.setSize('large')
ok(fontSetting.getDocxSize() === 32, '大档导出半磅 = 32')
fontSetting.setSize('medium')

// ============ F. lint：UGC 类必须引用令牌 ============
console.log('== F. UGC 类令牌 lint ==')
const ROOT = path.join(__dirname, '..')
const UGC = [
  ['pages/write/write.wxss', '.diary-textarea', '--content-size'],
  ['pages/write/write.wxss', '.diary-placeholder', '--content-size'],
  ['pages/write/write.wxss', '.hl-content', '--content-size'],
  ['pages/write/write.wxss', '.voice-card-text', '--content-size'],
  ['pages/detail/detail.wxss', '.detail-content', '--content-size'],
  ['pages/detail/detail.wxss', '.voice-card-text', '--content-size'],
  ['pages/index/index.wxss', '.diary-content', '--content-size'],
  ['pages/archive/archive.wxss', '.archive-name', '--content-name-size'],
  ['pages/archive/archive.wxss', '.archive-desc', '--content-size'],
  ['pages/archive/archive.wxss', '.edit-input', '--content-name-size'],
  ['pages/archive/archive.wxss', '.edit-textarea', '--content-size'],
  ['pages/archive/archive.wxss', '.voice-card-text', '--content-size'],
  ['pages/summary/summary.wxss', '.prompt-textarea', '--content-size'],
  ['pages/summary/summary.wxss', '.input-placeholder', '--content-size'],
  ['pages/summary/summary.wxss', '.result-content', '--content-size'],
  ['pages/summary/summary.wxss', '.voice-text', '--content-size'],
  ['pages/summary-result/summary-result.wxss', '.detail-content', '--content-size']
]

// 取出某个类的「全部」规则块（同一类可能被基础层与增强层各写一次）
function rulesFor(src, cls) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '') // 去注释，避免注释里的类名干扰
  const re = /([^{}]*)\{([^{}]*)\}/g
  const out = []
  let m
  while ((m = re.exec(clean)) !== null) {
    const sels = m[1].split(',').map(s => s.trim())
    if (sels.indexOf(cls) !== -1) out.push(m[2])
  }
  return out
}

// 某个属性的「最后声明」所在块（CSS 层叠：后声明覆盖先声明）
function lastDeclBlock(bodies, prop) {
  const hit = bodies.filter(b => b.indexOf(prop + ':') !== -1)
  return hit.length ? hit[hit.length - 1] : null
}

const fileCache = {}
UGC.forEach(([rel, cls, token]) => {
  const p = path.join(ROOT, rel.replace(/\//g, path.sep))
  if (!fileCache[rel]) fileCache[rel] = fs.readFileSync(p, 'utf8')
  const bodies = rulesFor(fileCache[rel], cls)
  if (!bodies.length) {
    ok(false, rel + ' ' + cls + ' 未找到规则块')
    return
  }

  const sizeBlock = lastDeclBlock(bodies, 'font-size')
  ok(!!sizeBlock, rel + ' ' + cls + ' 有 font-size 声明')
  if (sizeBlock) {
    ok(sizeBlock.indexOf('var(' + token + ')') !== -1, rel + ' ' + cls + ' font-size 引用 var(' + token + ')')
    ok(!/font-size:\s*\d/.test(sizeBlock), rel + ' ' + cls + ' 无硬编码 font-size 残留')
  }

  const famBlock = lastDeclBlock(bodies, 'font-family')
  ok(!!famBlock, rel + ' ' + cls + ' 有 font-family 声明')
  if (famBlock) {
    ok(famBlock.indexOf('var(--content-font)') !== -1, rel + ' ' + cls + ' font-family 引用 var(--content-font)')
  }
})

// 次级内容用相对偏移：默认档取值必须与改动前逐像素一致
const idxSrc = fileCache['pages/index/index.wxss'] || fs.readFileSync(path.join(ROOT, 'pages/index/index.wxss'), 'utf8')
ok(/\.diary-content\s*\{[^}]*font-size:\s*calc\(var\(--content-size\)\s*-\s*3rpx\)/.test(idxSrc),
  'index 卡片摘要 = 正文 −3rpx（默认 29rpx）')
const arcSrc0 = fileCache['pages/archive/archive.wxss'] || fs.readFileSync(path.join(ROOT, 'pages/archive/archive.wxss'), 'utf8')
ok(/\.archive-desc\s*\{[^}]*font-size:\s*calc\(var\(--content-size\)\s*-\s*6rpx\)/.test(arcSrc0),
  'archive 描述 = 正文 −6rpx（默认 26rpx）')

// archive 的 24rpx 组合不得再包含 .archive-desc（否则会盖掉令牌）
const arcSrc = fileCache['pages/archive/archive.wxss'] || fs.readFileSync(path.join(ROOT, 'pages/archive/archive.wxss'), 'utf8')
const combo = arcSrc.match(/\.hint-text,\s*\n\.empty-text,[\s\S]{0,120}?\n\}/)
ok(!!combo && combo[0].indexOf('.archive-desc') === -1, 'archive 24rpx 组合已剔除 .archive-desc')

// 根节点注入
;['write', 'detail', 'index', 'archive', 'summary', 'summary-result'].forEach(pg => {
  const wxml = fs.readFileSync(path.join(ROOT, 'pages', pg, pg + '.wxml'), 'utf8')
  ok(wxml.indexOf('style="{{fontStyle}}"') !== -1, pg + '.wxml 根节点注入 fontStyle')
  const js = fs.readFileSync(path.join(ROOT, 'pages', pg, pg + '.js'), 'utf8')
  ok(js.indexOf('fontSetting.buildStyle()') !== -1, pg + '.js 注入 buildStyle')
  ok(js.indexOf('fontStyle') !== -1, pg + '.js data.fontStyle')
})

// app.wxss 令牌存在
const appwxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
ok(appwxss.indexOf('--content-size: 32rpx') !== -1, 'app.wxss --content-size 默认 32rpx')
ok(appwxss.indexOf('--content-name-size: 34rpx') !== -1, 'app.wxss --content-name-size 默认 34rpx')
ok(appwxss.indexOf('--content-font: var(--font-body)') !== -1, 'app.wxss --content-font 默认黑体')

// storage.js 导出跟随
const storageSrc = fs.readFileSync(path.join(ROOT, 'utils/storage.js'), 'utf8')
ok(storageSrc.indexOf('fontSetting.getDocxSize()') !== -1, 'storage.js docx 正文跟随设置')

// 页面注册
const appJson = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')
ok(appJson.indexOf('pages/font-setting/font-setting') !== -1, 'app.json 已注册字体设置页')

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)
