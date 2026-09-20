/**
 * 心情枚举扩展回归测试（纠结/惆怅/百感/郁闷/得意，原「五味杂陈」定名「百感」）
 * 覆盖：MOOD_MAP 结构与新 5 项、getMood* 行为、云函数 MOOD_CN 与 prompt 枚举同步、
 *       选择器单一来源（write/detail 两页均从 MOOD_MAP 派生）。
 * 运行：node tools/test_moods.js
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

/* '🫤 百感' -> '百感'（去掉首段 emoji 与空格） */
function cnPart(label) {
  return String(label).replace(/^[^\u4e00-\u9fa5]+/, '').trim()
}

console.log('---- A. MOOD_MAP 结构 ----')
const util = require(path.join(ROOT, 'utils', 'util.js'))
const MAP = util.MOOD_MAP
const EXPECTED_KEYS = [
  'happy', 'calm', 'neutral', 'sad', 'angry', 'love', 'tired', 'excited',
  'conflicted', 'melancholy', 'mixed', 'gloomy', 'proud'
]
ok(Object.keys(MAP).length === 13, 'MOOD_MAP 共 13 项（8 旧 + 5 新），实际 ' + Object.keys(MAP).length)
ok(EXPECTED_KEYS.every(k => MAP[k]), '13 个 key 全部存在（含 conflicted/melancholy/mixed/gloomy/proud）')

const labels = Object.keys(MAP).map(k => MAP[k].label)
ok(new Set(labels).size === labels.length, 'label 全局唯一，无重复')

const RE_COLOR = /^#[0-9A-Fa-f]{6}$/
const RE_BG = /^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.1\)$/
ok(Object.keys(MAP).every(k => RE_COLOR.test(MAP[k].color)), '所有 color 均为合法 #RRGGBB')
ok(Object.keys(MAP).every(k => RE_BG.test(MAP[k].bg)), '所有 bg 均为 rgba(r,g,b,0.1)')

ok(MAP.conflicted.label === '🤔 纠结', 'conflicted = 🤔 纠结')
ok(MAP.melancholy.label === '😞 惆怅', 'melancholy = 😞 惆怅')
ok(MAP.mixed.label === '🫤 百感', 'mixed = 🫤 百感（五味杂陈定名百感）')
ok(MAP.gloomy.label === '😒 郁闷', 'gloomy = 😒 郁闷')
ok(MAP.proud.label === '😏 得意', 'proud = 😏 得意')
ok(rd('utils/util.js').indexOf('五味杂陈') === -1, 'util.js 不再出现「五味杂陈」字面量')

console.log('---- B. getMood* 行为 ----')
ok(util.getMoodLabel('mixed') === '🫤 百感', 'getMoodLabel(mixed) = 🫤 百感')
ok(util.getMoodColor('gloomy') === '#5C6BC0', 'getMoodColor(gloomy) = #5C6BC0')
ok(util.getMoodBg('proud') === 'rgba(216,27,96,0.1)', 'getMoodBg(proud) = rgba(216,27,96,0.1)')
ok(util.getMoodColor('melancholy') === '#78909C', 'getMoodColor(melancholy) = #78909C')
ok(util.getMoodLabel('not_exist') === '', '未知 key：label 回落空串')
ok(util.getMoodColor('not_exist') === '#999', '未知 key：color 回落 #999')
ok(util.getMoodBg('not_exist') === 'rgba(153,153,153,0.1)', '未知 key：bg 回落灰')

console.log('---- C. 云函数 optimizeDiary 同步 ----')
const cf = rd('cloudfunctions/optimizeDiary/index.js')
const NEW_CN = { conflicted: '纠结', melancholy: '惆怅', mixed: '百感', gloomy: '郁闷', proud: '得意' }
ok(Object.keys(NEW_CN).every(k => cf.indexOf(k + ": '" + NEW_CN[k] + "'") !== -1),
   'MOOD_CN 含 5 个新 key 且中文值与客户端一致')

// 两条 prompt 枚举行都要带上 5 个新词
const reEnum1 = /当天心情，用中文词（[^）]*）/
const reEnum2 = /当天心情，从「([^」]*)」中选一个/
const m1 = cf.match(reEnum1)
const m2 = cf.match(reEnum2)
ok(!!m1, '整理 prompt 存在心情枚举行')
ok(!!m2, 'extractMetaBatch prompt 存在心情枚举行')
if (m1) ok(NEW_CN.conflicted && Object.values(NEW_CN).every(w => m1[0].indexOf(w) !== -1),
   '整理 prompt 枚举含 纠结/惆怅/百感/郁闷/得意')
if (m2) ok(Object.values(NEW_CN).every(w => m2[0].indexOf(w) !== -1),
   'extractMetaBatch 枚举含 纠结/惆怅/百感/郁闷/得意')
ok(cf.indexOf('五味杂陈') === -1, '云函数不出现「五味杂陈」字面量')

console.log('---- D. 选择器单一来源 ----')
const writeJs = rd('pages/write/write.js')
const detailJs = rd('pages/detail/detail.js')
ok(writeJs.indexOf('Object.keys(util.MOOD_MAP)') === 1 || writeJs.indexOf('Object.keys(util.MOOD_MAP)') !== -1,
   'write.js moodOptions 从 MOOD_MAP 派生')
ok(detailJs.indexOf('Object.keys(util.MOOD_MAP)') !== -1, 'detail.js moodOptions 从 MOOD_MAP 派生')
// 表情面板等业务数据合法含 emoji，不能全文件查 emoji；改查中文心情词不被硬编码进页面
const MOOD_CN_WORDS = ['纠结', '惆怅', '百感', '郁闷', '得意']
ok(MOOD_CN_WORDS.every(w => writeJs.indexOf(w) === -1), 'write.js 未硬编码心情中文词')
ok(MOOD_CN_WORDS.every(w => detailJs.indexOf(w) === -1), 'detail.js 未硬编码心情中文词')

console.log('')
console.log('moods: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
