/**
 * 每日一签（utils/dailyQuote.js）回归测试（纯 Node，无需小程序环境）
 *
 * 守护 5 件事：
 *  1) 内容池合法性：100 条、字段齐、正文 ≤300 字、无重复、古今中外覆盖
 *  2) 轮换确定性：同一天恒定、相邻两天差 1、跨年/闰日/早于纪元都不崩、100 天全覆盖
 *  3) 卡片两行口径：诗词取诗词名 / 名言取作者；第二行前 16 字且只对长文本补省略号
 *  4) 全篇口径：标题 / 副题 / 正文完整 / 复制文本；脏下标一律回落「今天」
 *  5) 接线：路由注册、quote 页四文件、图标在字体子集内、事件与 data 绑定、卡片在 scroll 之外
 *
 * 用法：node tools/test_daily_quote.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const dq = require(path.join(ROOT, 'utils/dailyQuote.js'))

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

// 构造本地日期（用本地时间构造，避免测试机时区影响 dayNumber 的取整）
function D(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0)
}

// ---------- 1. 内容池合法性 ----------
section('内容池：规模与结构')
const Q = dq.QUOTES
ok('条数为 100', Q.length === 100, 'got ' + Q.length)

let badType = []
let badField = []
let tooLong = []
let emptyText = []
Q.forEach((it, i) => {
  if (it.type !== 'poem' && it.type !== 'quote') badType.push(i + ':' + it.type)
  if (it.type === 'poem') {
    if (!it.title || !it.author || !it.dynasty) badField.push(i + ':' + (it.title || it.author || '?'))
  } else {
    if (!it.author) badField.push(i + ':' + it.text)
  }
  if (!String(it.text || '').trim()) emptyText.push(i)
  if (dq.countChars(it.text) > dq.MAX_LEN) tooLong.push(i + ':' + dq.countChars(it.text))
})
ok('type 只有 poem / quote', badType.length === 0, badType.join(','))
ok('诗词有 title+author+dynasty，名言有 author', badField.length === 0, badField.join(','))
ok('正文非空', emptyText.length === 0, emptyText.join(','))
ok('正文去空白后 ≤ ' + dq.MAX_LEN + ' 字', tooLong.length === 0, tooLong.join(','))

const maxLen = Math.max.apply(null, Q.map((it) => dq.countChars(it.text)))
lines.push('  · 最长一条 ' + maxLen + ' 字（上限 ' + dq.MAX_LEN + '）')
ok('最长一条留有余量（≤ 250，给细节页留排版空间）', maxLen <= 250, 'max=' + maxLen)

// 重复检测：正文相同即视为重复（同一首诗不重复收）
const textMap = {}
const dups = []
Q.forEach((it, i) => {
  const key = String(it.text).replace(/\s+/g, '')
  if (textMap[key] !== undefined) dups.push(textMap[key] + '/' + i)
  else textMap[key] = i
})
ok('正文无重复收录', dups.length === 0, dups.join(','))

// 「同日同名作者重复条目」不算错，但「同名同作者同类型」不应出现两次同名诗
const titleMap = {}
const titleDups = []
Q.forEach((it, i) => {
  if (it.type !== 'poem') return
  const key = it.title + '|' + it.author
  if (titleMap[key] !== undefined) titleDups.push(key)
  else titleMap[key] = i
})
ok('诗词标题+作者不重复', titleDups.length === 0, titleDups.join(','))

// 覆盖度：古今中外
const poems = Q.filter((it) => it.type === 'poem')
const quotes = Q.filter((it) => it.type === 'quote')
const dynasties = {}
poems.forEach((it) => { dynasties[it.dynasty] = (dynasties[it.dynasty] || 0) + 1 })
const origins = {}
quotes.forEach((it) => { if (it.origin) origins[it.origin] = (origins[it.origin] || 0) + 1 })
// 外国名言在池子里有 origin，中国古典格言没有 origin
const foreign = quotes.filter((it) => !!it.origin).length
const classic = quotes.filter((it) => !it.origin).length
lines.push('  · 诗词 ' + poems.length + ' 条，名言 ' + quotes.length + ' 条（外国 ' + foreign + ' / 中国古典 ' + classic + '）')
lines.push('  · 朝代分布：' + Object.keys(dynasties).map((k) => k + dynasties[k]).join(' '))
ok('诗词 ≥ 60 条', poems.length >= 60, String(poems.length))
ok('名言 ≥ 30 条', quotes.length >= 30, String(quotes.length))
ok('覆盖 ≥ 5 个朝代（含唐/宋）', Object.keys(dynasties).length >= 5 && dynasties['唐'] && dynasties['宋'],
  Object.keys(dynasties).join(','))
ok('外国名言 ≥ 15 条', foreign >= 15, String(foreign))
ok('中国古典格言 ≥ 5 条', classic >= 5, String(classic))
ok('正文不含回车符', Q.every((it) => String(it.text).indexOf('\r') < 0))
ok('正文首尾无空白', Q.every((it) => String(it.text) === String(it.text).trim()))

// ---------- 2. 轮换确定性 ----------
section('轮换：确定性')
const sameDay = [
  dq.pickIndex(D(2026, 9, 18, 0, 0)),
  dq.pickIndex(D(2026, 9, 18, 9, 30)),
  dq.pickIndex(D(2026, 9, 18, 23, 59))
]
ok('同一天任何时刻取到同一条', sameDay[0] === sameDay[1] && sameDay[1] === sameDay[2], sameDay.join(','))

// 连续 400 天：下标严格 (prev+1) % n
let chainBad = []
let prev = dq.pickIndex(D(2026, 1, 1))
const start = D(2026, 1, 1)
for (let d = 1; d <= 400; d++) {
  const dt = new Date(start.getTime())
  dt.setDate(dt.getDate() + d)
  const cur = dq.pickIndex(dt)
  if (cur !== (prev + 1) % Q.length) chainBad.push(d + ':' + prev + '→' + cur)
  prev = cur
}
ok('连续 400 天下标逐日 +1（环形）', chainBad.length === 0, chainBad.slice(0, 5).join(','))

ok('跨年（2026-12-31 → 2027-01-01）差 1',
  dq.pickIndex(D(2027, 1, 1)) === (dq.pickIndex(D(2026, 12, 31)) + 1) % Q.length)
ok('跨月（2026-09-30 → 2026-10-01）差 1',
  dq.pickIndex(D(2026, 10, 1)) === (dq.pickIndex(D(2026, 9, 30)) + 1) % Q.length)
ok('闰年 2 月（2028-02-28 → 02-29）差 1',
  dq.pickIndex(D(2028, 2, 29)) === (dq.pickIndex(D(2028, 2, 28)) + 1) % Q.length)
ok('闰年 2 月末（02-29 → 03-01）差 1',
  dq.pickIndex(D(2028, 3, 1)) === (dq.pickIndex(D(2028, 2, 29)) + 1) % Q.length)
ok('平年 2 月末（2027-02-28 → 03-01）差 1',
  dq.pickIndex(D(2027, 3, 1)) === (dq.pickIndex(D(2027, 2, 28)) + 1) % Q.length)

// 早于纪元（负数天）：必须回落到合法非负下标，不得出现 -1
const early = dq.pickIndex(D(2025, 12, 31))
ok('早于纪元也回落为合法非负下标', early >= 0 && early < Q.length, String(early))
ok('早于纪元的昨天 = 今天前一天（环形连续）',
  dq.pickIndex(D(2026, 1, 1)) === (early + 1) % Q.length, early + ' vs ' + dq.pickIndex(D(2026, 1, 1)))

// 100 天覆盖全池（不重复、不遗漏）
const seen = {}
const s2 = D(2026, 5, 1)
for (let d = 0; d < Q.length; d++) {
  const dt = new Date(s2.getTime())
  dt.setDate(dt.getDate() + d)
  seen[dq.pickIndex(dt)] = true
}
ok('连续 100 天恰好覆盖全池 100 条', Object.keys(seen).length === Q.length,
  'covered=' + Object.keys(seen).length)

ok('池子为空时 pickIndex 返回 0（除零保护）', dq.pickIndex(D(2026, 9, 18), 0) === 0)

// ---------- 3. 卡片两行口径 ----------
section('卡片：两行口径')
const today = dq.getToday(D(2026, 9, 18))
ok('getToday 返回 index/type/icon/line1/line2', ['index', 'type', 'icon', 'line1', 'line2']
  .every((k) => today[k] !== undefined && today[k] !== null), JSON.stringify(today))
ok('index 与当天 pickIndex 一致', today.index === dq.pickIndex(D(2026, 9, 18)))
ok('icon 非空', typeof today.icon === 'string' && today.icon.length > 0, today.icon)

// 全池逐条校验：诗词第一行＝诗词名，名言第一行＝作者
let cardBad = []
Q.forEach((it, i) => {
  const c = dq.toCard(i, D(2026, 9, 18))
  const want = it.type === 'poem' ? it.title : it.author
  if (c.line1 !== want) cardBad.push(i + ':' + c.line1 + '≠' + want)
  if (c.line2.length > dq.PREVIEW_LEN + 1) cardBad.push(i + ':line2 too long')
  if (c.index !== i) cardBad.push(i + ':index mismatch')
})
ok('诗词第一行＝诗词名 / 名言第一行＝作者（全池 100 条）', cardBad.length === 0, cardBad.slice(0, 5).join(','))

ok('短文本不加省略号', dq.excerpt('千里之行，始于足下。') === '千里之行，始于足下。', dq.excerpt('千里之行，始于足下。'))
ok('恰好 16 字不加省略号', dq.excerpt('一二三四五六七八九十一二三四五六') === '一二三四五六七八九十一二三四五六')
ok('17 字截断为 16 字 + 省略号',
  dq.excerpt('一二三四五六七八九十一二三四五六七') === '一二三四五六七八九十一二三四五六…',
  dq.excerpt('一二三四五六七八九十一二三四五六七'))
ok('换行/空格被压平（长诗一行不改行为两条）',
  dq.excerpt('床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。') === '床前明月光，疑是地上霜。举头望明…',
  dq.excerpt('床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。'))
ok('excerpt 空值安全', dq.excerpt(null) === '' && dq.excerpt(undefined) === '')
ok('preview 长度 ≤ 17（含省略号）', Q.every((it) => dq.excerpt(it.text).length <= dq.PREVIEW_LEN + 1))

// ---------- 4. 全篇口径 ----------
section('全篇：标题 / 副题 / 正文 / 复制文本')
const poemIdx = Q.findIndex((it) => it.type === 'poem' && it.title === '静夜思')
const pv = dq.getDetail(poemIdx, D(2026, 9, 18))
ok('诗词 kind=诗词', pv.kind === '诗词', pv.kind)
ok('诗词 head＝诗词名', pv.head === '静夜思', pv.head)
ok('诗词 byline＝朝代 · 作者', pv.byline === '唐 · 李白', pv.byline)
ok('诗词 body 与原文完全一致（不截断）', pv.body === Q[poemIdx].text)
ok('复制文本含标题 + 副题 + 正文', pv.copyText.indexOf('静夜思 · 唐 · 李白') === 0 &&
  pv.copyText.indexOf(Q[poemIdx].text) > 0, JSON.stringify(pv.copyText.slice(0, 40)))

const fIdx = Q.findIndex((it) => it.type === 'quote' && it.author === '莎士比亚')
const fv = dq.getDetail(fIdx, D(2026, 9, 18))
ok('名言 kind=名言', fv.kind === '名言', fv.kind)
ok('名言 head＝作者', fv.head === '莎士比亚', fv.head)
ok('名言 byline＝国别 · 出处', fv.byline === '英 · 《哈姆雷特》', fv.byline)

const cIdx = Q.findIndex((it) => it.type === 'quote' && it.author === '孔子')
const cv = dq.getDetail(cIdx, D(2026, 9, 18))
ok('中国古典格言无国别时 byline 只留出处', cv.byline === '《论语·为政》', cv.byline)
ok('名言复制文本以「作者 · 副题」开头', cv.copyText.indexOf('孔子 · 《论语·为政》') === 0,
  JSON.stringify(cv.copyText.slice(0, 30)))

ok('全池 getDetail 均有非空 head/body', Q.every((it, i) => {
  const v = dq.getDetail(i, D(2026, 9, 18))
  return v.head && v.body && v.copyText
}))

// 脏下标：一律回落「今天」
const todayIdx = dq.pickIndex(D(2026, 9, 18))
// 注意「越界」必须按池子长度算，不能写死 100（池子长度会变，写死会误判成通过）
const dirty = [-1, Q.length, Q.length + 5, 1.5, NaN, Infinity, -Infinity, undefined, null, '', ' ', 'abc', true, {}, []]
let dirtyBad = []
dirty.forEach((v) => {
  const got = dq.safeIndex(v, D(2026, 9, 18))
  if (got !== todayIdx) dirtyBad.push(JSON.stringify(v) + '→' + got)
})
ok('脏下标全部回落今天（含空串，Number(\'\')===0 的坑）', dirtyBad.length === 0, dirtyBad.join(','))
ok('合法数字字符串被接受', dq.safeIndex('7', D(2026, 9, 18)) === 7, String(dq.safeIndex('7', D(2026, 9, 18))))
ok('合法下标原样返回', dq.safeIndex(0, D(2026, 9, 18)) === 0 && dq.safeIndex(99, D(2026, 9, 18)) === 99)

// ---------- 5. 页面接线 ----------
section('接线：路由 / 文件 / 图标 / 事件')
const appJson = JSON.parse(read('app.json'))
ok('app.json 注册 pages/quote/quote', appJson.pages.indexOf('pages/quote/quote') >= 0)

const QFILES = ['pages/quote/quote.js', 'pages/quote/quote.json', 'pages/quote/quote.wxml', 'pages/quote/quote.wxss']
QFILES.forEach((f) => ok('存在 ' + f, fs.existsSync(path.join(ROOT, f))))

const qJson = JSON.parse(read('pages/quote/quote.json'))
ok('quote.json 导航标题＝每日一签', qJson.navigationBarTitleText === '每日一签', qJson.navigationBarTitleText)

const qJs = read('pages/quote/quote.js')
const qWxml = read('pages/quote/quote.wxml')
const qWxss = read('pages/quote/quote.wxss')
ok('quote.js 引用 dailyQuote', qJs.indexOf("require('../../utils/dailyQuote.js')") >= 0)
ok('quote.js 走主题机制（theme.applyTo）', qJs.indexOf('theme.applyTo(this)') >= 0)
ok('quote.js 具备 copyAll（wxml 绑定的事件有实现）', qJs.indexOf('copyAll()') >= 0)
ok('quote.wxml 根节点吃 themeClass', qWxml.indexOf('class="page {{themeClass}}"') >= 0)

// wxml 绑定的每个 bindtap 都要在 js 里有同名方法
const handlers = (qWxml.match(/bindtap="([A-Za-z0-9_]+)"/g) || []).map((m) => m.replace(/bindtap="|"/g, ''))
const missing = handlers.filter((h) => qJs.indexOf(h + '(') < 0 && qJs.indexOf(h + ':') < 0)
ok('quote.wxml 的 bindtap 均在 quote.js 有实现', missing.length === 0, missing.join(','))

// wxml 引用的变量要在 data 里声明（防 undefined 渲染）
const dataBlock = qJs.slice(qJs.indexOf('data: {'), qJs.indexOf('onLoad'))
const undeclared = ['kind', 'head', 'byline', 'body', 'appName'].filter((k) => dataBlock.indexOf(k) < 0)
ok('quote.wxml 引用的变量都在 data 声明', undeclared.length === 0, undeclared.join(','))

// 图标必须在字体子集里（否则渲染成空方块）
const iconWxss = read('icon.wxss')
const iconNames = (iconWxss.match(/\.(ri-[a-z0-9-]+)::before/g) || []).map((m) => m.replace(/^\.|::before$/g, ''))
const usedIcons = []
;[qWxml, read('pages/write/write.wxml')].forEach((src) => {
  (src.match(/\bri-[a-z0-9-]+/g) || []).forEach((c) => { if (usedIcons.indexOf(c) < 0) usedIcons.push(c) })
})
const unknownIcons = usedIcons.filter((c) => c !== 'ri' && iconNames.indexOf(c) < 0)
ok('引用到的图标都在 icon.wxss 子集内（共 ' + iconNames.length + ' 枚）', unknownIcons.length === 0,
  unknownIcons.join(','))
ok('dailyQuote.ICON 在字体子集内', iconNames.indexOf(dq.ICON) >= 0, dq.ICON)

// write 页接线
const wWxml = read('pages/write/write.wxml')
const wJs = read('pages/write/write.js')
const wWxss = read('pages/write/write.wxss')
ok('write.wxml 有日签卡片', wWxml.indexOf('class="sidebar-quote"') >= 0)
ok('卡片绑定 goToDailyQuote', wWxml.indexOf('bindtap="goToDailyQuote"') >= 0)
ok('卡片第一行绑 {{dailyQuote.line1}}', wWxml.indexOf('{{dailyQuote.line1}}') >= 0)
ok('卡片第二行绑 {{dailyQuote.line2}}', wWxml.indexOf('{{dailyQuote.line2}}') >= 0)
ok('卡片在侧栏滚动区之外（不被日记列表挤走）',
  wWxml.indexOf('class="sidebar-quote"') < wWxml.indexOf('class="sidebar-scroll"'))
ok('write.js 引用 dailyQuote', wJs.indexOf("require('../../utils/dailyQuote.js')") >= 0)
ok('write.js data 声明 dailyQuote（含 index 初值 -1）', /dailyQuote:\s*\{\s*index:\s*-1/.test(wJs))
ok('write.js 有 refreshDailyQuote', wJs.indexOf('refreshDailyQuote()') >= 0)
ok('write.js 有 goToDailyQuote', wJs.indexOf('goToDailyQuote()') >= 0)
ok('onShow 会刷新日签（跨天自动换）', wJs.indexOf('this.refreshDailyQuote()') >= 0)
ok('openSidebar 会刷新日签', (wJs.match(/this\.refreshDailyQuote\(\)/g) || []).length >= 2)
ok('goToDailyQuote 先收侧栏再跳页', /goToDailyQuote\(\)\s*\{[\s\S]{0,200}?showSidebar:\s*false[\s\S]{0,200}?navigateTo/.test(wJs))
ok('跳转路径与 app.json 注册一致', wJs.indexOf("'/pages/quote/quote?i='") >= 0)
ok('write.wxss 有 .sidebar-quote', wWxss.indexOf('.sidebar-quote {') >= 0)
ok('write.wxss 有两行样式 .sq-line1 / .sq-line2',
  wWxss.indexOf('.sq-line1 {') >= 0 && wWxss.indexOf('.sq-line2 {') >= 0)
ok('卡片样式只用主题令牌（无写死色值）',
  !/\.sidebar-quote[\s\S]{0,900}?#[0-9A-Fa-f]{3,6}/.test(wWxss))

// 别把人家的东西碰坏：新手引导锚点仍在
;['guide-hold-talk', 'guide-archive', 'guide-summary'].forEach((id) => {
  ok('引导锚点 id=' + id + ' 仍在', (wWxml.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1)
})

// 侧栏卡片不得吃 APP_NAME 字面量（护栏在 test_about_info.js，这里只针对新页）
ok('quote.wxml 无「一灯记」字面量（走 {{appName}}）', qWxml.indexOf('一灯记') < 0)

// ---------- 输出 ----------
lines.push('')
lines.push('通过 ' + pass + ' / 失败 ' + fail)
console.log(lines.join('\n'))
process.exit(fail ? 1 : 0)
