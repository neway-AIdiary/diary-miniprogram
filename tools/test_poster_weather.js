/**
 * 行为测试：海报天气行去掉图标（2026-09-22 真机，用户拍板方案 2）
 *
 * 为什么需要这一套：
 *   安卓保存海报 → 天气图标与「晴 26° · 北京市」之间空一个很宽的格；
 *   iPhone 保存海报 → 图标与文字之间多一个**方框占位符**（canvas notdef）。
 *   根因（同一链路的两个端）：
 *     iOS  = 天气图标是 U+2600 系「基字符 + 变体选择符 U+FE0F」，FE0F 在 canvas 的
 *            sans-serif 回退链里没有字形 ⇒ 画成 □；心情 emoji 不带 FE0F ⇒ 双端正常（旁证）。
 *     安卓 = emoji 当全宽字符（advance≈1em）+ 代码里那个显式空格 ⇒ 空隙约 1.5 字。
 *   口径：海报是 canvas 绘制、对外分享物，只画文字最稳 ⇒ 新增 weatherTextOnly，
 *         海报用它；「复制文字版」仍走 weatherLine（输入框里 emoji 正常）。
 *
 * 覆盖断言：
 *   A 组：weatherTextOnly 基础（原样、空值、不误剥 ° 与 ·）
 *   B 组：防御性剥离（图标若被并进 weatherText 也永不出方格）
 *   C 组：海报模型（真机两种手机的形状：无图标、无 FE0F、无前导空格）
 *   D 组：复制文字版与 weatherLine 保持不变（这是本次改动的回归网）
 *   E 组：静态护栏（海报走 weatherTextOnly；绘制处与复制路都没被顺手改动）
 *   F 组：幂等与空值安全（不改入参、重复调用同值）
 */
const path = require('path')
const fs = require('fs')

const base = path.resolve(__dirname, '..')
const share = require(path.join(base, 'utils', 'share.js'))

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
function section(t) { console.log('\n== ' + t + ' ==') }
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8')

// 红灯自检（还原源码、保留本测试）时新接口还不存在 —— 安全包装，
// 让「红」停在断言上，而不是以 TypeError 崩溃吃掉后面的断言。
const W = (d) => (typeof share.weatherTextOnly === 'function' ? share.weatherTextOnly(d) : '')

// 与实现同口径的「含 emoji / 变体选择符」判据（用于反例断言）
const EMOJI_RE = /[\uFE0E\uFE0F\u200D\u2600-\u27BF\u2B00-\u2BFF]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/

// 详情页装饰后的日记（同 test_share.js 的 fixture 形状）
const diary = {
  createdAt: '2026年9月4日 16:20',
  content: '今天去公园散步，天气很好。',
  moodText: '😐 一般',
  moodColor: '#8E8E8E',
  moodBg: 'rgba(142,142,142,0.12)',
  weatherIcon: '☀️',
  weatherText: '晴 28° · 深圳',
  tags: [],
  images: []
}
const emptyDiary = { content: '', createdAt: '', moodText: '', weatherText: '', tags: [], images: [] }

// 天气表里出现过的全部图标（utils/weather.js 的 WMO 映射）
const ICONS = ['☀️', '🌤️', '⛅', '☁️', '🌫️', '🌦️', '🌧️', '❄️', '⛈️', '🌡️']

/* ============================================================
 * A 组：weatherTextOnly 基础
 * ============================================================ */
section('A) weatherTextOnly 基础')
ok(typeof share.weatherTextOnly === 'function', 'A-1 weatherTextOnly 已导出')
ok(W({ weatherText: '晴 28° · 深圳' }) === '晴 28° · 深圳',
  'A-2 正常文本原样（° 与 · 不被误剥）', W({ weatherText: '晴 28° · 深圳' }))
ok(W({ weatherText: '' }) === '' && W({ weatherText: '   ' }) === '',
  'A-3 空文本 / 纯空白 → 空串', [W({ weatherText: '' }), W({ weatherText: '   ' })])
ok(W(null) === '' && W(undefined) === '' && W({}) === '',
  'A-4 null / undefined / 空对象 → 空串', [W(null), W(undefined), W({})])
ok(W({ weatherText: '多云 20°' }) === '多云 20°',
  'A-5 没有图标字段也能出文本（与 icon 无关）', W({ weatherText: '多云 20°' }))
ok(W({ weatherIcon: '☀️', weatherText: '晴 28°' }).indexOf('☀') < 0,
  'A-6 有图标字段但结果里不含图标', W({ weatherIcon: '☀️', weatherText: '晴 28°' }))
ok(W({ weatherText: ' 晴 26° · 北京市 ' }) === '晴 26° · 北京市',
  'A-7 首尾空白去掉', W({ weatherText: ' 晴 26° · 北京市 ' }))
ok(W({ weatherText: '晴   26°' }) === '晴 26°',
  'A-8 连续空白折叠为单个空格', W({ weatherText: '晴   26°' }))
ok(W({ weatherText: 123 }) === '123', 'A-9 非字符串不抛错（转字符串）', W({ weatherText: 123 }))
ok(W({ weatherText: null }) === '', 'A-10 null 文本 → 空串', W({ weatherText: null }))

/* ============================================================
 * B 组：防御性剥离 —— 图标若被并进 weatherText（云端/旧数据）也永不出方格
 * ============================================================ */
section('B) 防御性剥离（图标并进文本时）')
ICONS.forEach(function (ic, i) {
  const got = W({ weatherText: ic + ' 晴 26° · 北京市' })
  ok(got === '晴 26° · 北京市', 'B-1.' + (i + 1) + ' 图标 ' + ic + ' 被剥掉只留文字', got)
  ok(!EMOJI_RE.test(got), 'B-2.' + (i + 1) + ' 结果不含任何 emoji / 变体选择符', got)
})
ok(W({ weatherText: '晴 ☀️ 26°' }) === '晴 26°',
  'B-3 图标夹在文字中间也被剥（并折叠多余空格）', W({ weatherText: '晴 ☀️ 26°' }))
ok(W({ weatherText: '☀️' }) === '', 'B-4 只有图标没有文字 → 空串（不画出孤儿图标）',
  W({ weatherText: '☀️' }))
ok(!EMOJI_RE.test(W({ weatherText: '☀️ 晴 26°' })), 'B-5 结果不含 U+FE0F（方格真凶）')
ok(String(W({ weatherText: '⛅多云' })) === '多云', 'B-6 图标与文字粘连无空格也能剥干净',
  W({ weatherText: '⛅多云' }))
// 反向护栏：剥 emoji 的代理对区间必须**收窄在 emoji 块内**，不许顺手吃掉生僻汉字
// （城市名理论上可能是扩展区字，误剥就是静默改字）
ok(W({ weatherText: '\uD842\uDFB7 城 晴 26°' }) === '\uD842\uDFB7 城 晴 26°',
  'B-7 CJK 扩展区生僻字（𠮷 U+20BB7）不被误剥', W({ weatherText: '\uD842\uDFB7 城 晴 26°' }))
ok(W({ weatherText: '🌧 小雨 18°' }).indexOf('🌧') < 0 &&
  W({ weatherText: '🌧 小雨 18°' }) === '小雨 18°',
  'B-8 星面 emoji（U+1F300 段）仍被剥掉', W({ weatherText: '🌧 小雨 18°' }))

/* ============================================================
 * C 组：海报模型（真机两种手机的形状）
 * ============================================================ */
section('C) 海报模型：天气行只剩文字')
const pm = share.buildPosterModel(diary, {})
ok(pm.weather === '晴 28° · 深圳', 'C-1 海报天气 = 纯文本（与复制版区别开）', pm.weather)
ok(pm.weather.indexOf('☀') < 0, 'C-2 不含天气图标字符', pm.weather)
ok(pm.weather.indexOf('\uFE0F') < 0, 'C-3 不含 U+FE0F（iPhone 方格占位符的真凶）')
ok(pm.weather.indexOf('\u25A1') < 0 && pm.weather.indexOf('\uFFFD') < 0,
  'C-4 不含 □ / 替换字符', pm.weather)
ok(pm.weather.charAt(0) === '晴', 'C-5 首字符即文字（无前导空格 ⇒ 安卓宽格消失）', pm.weather)
ok(!/\s{2,}/.test(pm.weather), 'C-6 无连续空格（不会多出一个空格位）')
ICONS.forEach(function (ic, i) {
  const got = share.buildPosterModel({ weatherIcon: ic, weatherText: '晴 26° · 北京市' }, {}).weather
  ok(got === '晴 26° · 北京市' && !EMOJI_RE.test(got),
    'C-7.' + (i + 1) + ' 任何天气类型海报都只剩文字 ' + ic, got)
})
ok(share.buildPosterModel(diary, { weather: false }).weather === '',
  'C-8 天气开关关掉 → 空串（隐藏模块的契约不变）')
ok(share.buildPosterModel(emptyDiary, {}).weather === '',
  'C-9 空日记 → 空串')
ok(share.buildPosterModel({ weatherIcon: '☀️' }, {}).weather === '',
  'C-10 只有图标没有文本 → 空串（不留空模块）')
ok(share.buildPosterModel(diary, {}).date === '2026年9月4日' &&
  share.buildPosterModel(diary, {}).mood === '😐 一般' &&
  share.buildPosterModel(diary, {}).weather === '晴 28° · 深圳',
  'C-11 只动天气：日期与心情一个字没变（心情 emoji 无 FE0F、双端正常，刻意不动）',
  [share.buildPosterModel(diary, {}).date, share.buildPosterModel(diary, {}).mood])

/* ============================================================
 * D 组：复制文字版与 weatherLine 保持不变（回归网：别把另一路也改了）
 * ============================================================ */
section('D) 复制文字版保持原样')
ok(typeof share.weatherLine === 'function', 'D-1 weatherLine 仍导出（复制路依赖它）')
ok(share.weatherLine(diary) === '☀️ 晴 28° · 深圳',
  'D-2 weatherLine 仍带图标（wxml/输入框里 emoji 渲染正常）', share.weatherLine(diary))
ok(share.buildCopyText(diary).indexOf('☀️ 晴 28° · 深圳') !== -1,
  'D-3 复制文字版仍含「图标 + 文本」', share.buildCopyText(diary))
ok(share.weatherLine({ weatherText: '多云 20°' }) === '多云 20°',
  'D-4 无图标时就是文本（原行为）')
ok(share.weatherLine({ weatherIcon: '☀️' }) === '',
  'D-5 只图标无文本 → 空串（原行为）')

/* ============================================================
 * E 组：静态护栏
 * ============================================================ */
section('E) 静态护栏')
const shSrc = read('utils/share.js')
const sheetSrc = read('components/share-sheet/share-sheet.js')
ok(shSrc.indexOf("weather: sw.weather === false ? '' : weatherTextOnly(d),") >= 0,
  'E-1 海报模型走 weatherTextOnly')
ok(shSrc.indexOf("? '' : weatherLine(d),") < 0,
  'E-2 海报模型里已无 weatherLine（避免又走回带图标那条）')
ok(shSrc.indexOf('function weatherTextOnly(d) {') >= 0, 'E-3 weatherTextOnly 已落盘')
ok(shSrc.indexOf('  weatherTextOnly: weatherTextOnly,') >= 0, 'E-4 weatherTextOnly 已导出')
ok(shSrc.indexOf('  weatherLine: weatherLine,') >= 0, 'E-5 weatherLine 保留（复制路不许动）')
ok(sheetSrc.indexOf('model.weatherIcon') < 0,
  'E-6 绘制处没有自己去拼图标（weatherIcon 不进 canvas）')
ok(sheetSrc.indexOf('ctx.fillText(model.weather, b.x || PAD, b.y)') >= 0,
  'E-7 天气绘制调用未改动（仍画 model.weather）')
ok(sheetSrc.indexOf("const wW = ctx.measureText(model.weather).width") >= 0,
  'E-8 同行宽度测算仍基于 model.weather（图标去掉后量宽自然变短）')

/* ============================================================
 * F 组：幂等与空值安全
 * ============================================================ */
section('F) 幂等与空值安全')
const src = { weatherText: '☀️ 晴 26° · 北京市' }
const once = W(src)
const twice = W({ weatherText: once })
ok(once === twice, 'F-1 幂等：剥两次与剥一次同结果', [once, twice])
ok(src.weatherText === '☀️ 晴 26° · 北京市', 'F-2 不改写入参对象（纯函数）', src.weatherText)
ok(W({ weatherText: once }) === W({ weatherText: once }), 'F-3 重复调用同值（无状态）')
ok(W({}) === '' && W({ weatherText: '' }) === '', 'F-4 空值安全（不抛错、返回空串）')
const idemBad = [undefined, null, {}, { weatherText: '' }, { weatherText: '晴 26°' }]
  .filter(function (x) { return W(x) !== W({ weatherText: W(x) }) })
ok(idemBad.length === 0, 'F-5 各类输入都幂等（含空值）', idemBad)

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail ? 1 : 0)
