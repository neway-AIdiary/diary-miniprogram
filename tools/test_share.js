// tools/test_share.js —— share.js 分享脱敏逻辑回归测试（node 直跑）
const share = require('../utils/share.js')

let passed = 0
let failed = 0
function assert(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.log('[FAIL] ' + name)
    console.log('  expect:', JSON.stringify(expected))
    console.log('  actual:', JSON.stringify(actual))
  }
}

// 模拟详情页装饰后的日记
const longText = '今天写了很多字，用来测试分享时的脱敏摘要截断逻辑。' +
  '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' +
  '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' +
  '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' +
  '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十' +
  '末尾收尾句。'
const diary = {
  title: '一篇日记标题',
  content: '  今天  过得不错，\n去了公园散步，\n天气很好。  ',
  createdAt: '2026年9月4日 16:20',
  moodText: '开心',
  moodColor: '#FFB300',
  moodBg: 'rgba(255,179,0,0.12)',
  weatherIcon: '☀️',
  weatherText: '晴 28° · 深圳',
  tags: ['生活', '运动', '旅行'],
  images: ['cloud://a/b1.jpg', 'cloud://a/b2.jpg', 'cloud://a/b3.jpg', 'cloud://a/b4.jpg']
}
const emptyDiary = { title: '', content: '', createdAt: '', moodText: '', weatherText: '', tags: [], images: [] }

// ===== 1. 摘要截断 =====
assert('摘要：短文本原样', share.truncateSummary('今天很开心', 150), '今天很开心')
const tr = share.truncateSummary(longText, 150)
assert('摘要：150 字上限', tr.length, 150)
assert('摘要：末尾省略号', tr.slice(-1), '…')
assert('摘要：保留换行（空行折叠、行内空白折叠）', share.truncateSummary('a\n\n  b   c', 150), 'a\nb c')
assert('摘要：空文本', share.truncateSummary('   ', 150), '')
assert('摘要：自定义上限', share.truncateSummary('一二三四五六七八九十', 5), '一二三四…')

// ===== 2. 天气行 =====
assert('天气：icon+文本', share.weatherLine(diary), '☀️ 晴 28° · 深圳')
assert('天气：无 icon', share.weatherLine({ weatherText: '多云 20°' }), '多云 20°')
assert('天气：无天气', share.weatherLine({ weatherIcon: '☀️' }), '')
assert('天气：空对象', share.weatherLine(null), '')

// ===== 3. 复制完整文字（默认配置） =====
const copyText = share.buildCopyText(diary)
assert('复制：含日期', copyText.indexOf('2026年9月4日 16:20') !== -1, true)
assert('复制：含天气', copyText.indexOf('☀️ 晴 28° · 深圳') !== -1, true)
assert('复制：含心情', copyText.indexOf('开心') !== -1, true)
assert('复制：含标签', copyText.indexOf('#生活 #运动 #旅行') !== -1, true)
assert('复制：含摘要（保留段落换行）', copyText.indexOf('今天 过得不错，\n去了公园散步，\n天气很好。') !== -1, true)
assert('复制：段落结构（连续空行折叠为单换行）',
  share.buildCopyText({ content: '第一段。\n\n\n第二段内容。\n第三段收尾。' }),
  '第一段。\n第二段内容。\n第三段收尾。')
const bigText = '一二三四五六七八九十'.repeat(30) // 300 字
const bigCopy = share.buildCopyText({ createdAt: '2026年9月16日 10:00', content: bigText })
assert('复制：300 字全文不截断', bigCopy.indexOf(bigText) !== -1, true)
assert('复制：全文无省略号', bigCopy.indexOf('…'), -1)
const hugeCopy = share.buildCopyText({ content: '字'.repeat(1200) })
assert('复制：1200 字仍全文', hugeCopy.length, 1200)
assert('复制：不含标题（隐私）', copyText.indexOf('一篇日记标题') === -1, true)
assert('复制：首行是日期', copyText.split('\n')[0], '2026年9月4日 16:20')
assert('复制：空日记为空串', share.buildCopyText(emptyDiary), '')
assert('复制：空日记不残留空行', share.buildCopyText({ createdAt: '2026年1月1日' }), '2026年1月1日')

// ===== 4. 海报日期 =====
assert('海报日期：取年月日', share.posterDate('2026年9月4日 16:20'), '2026年9月4日')
assert('海报日期：无时间串原样', share.posterDate('2026-09-04'), '2026-09-04')
assert('海报日期：空', share.posterDate(''), '')

// ===== 5. 海报模型（默认全开） =====
const pm = share.buildPosterModel(diary, { weather: true, mood: true, tags: true, images: true })
assert('海报：日期', pm.date, '2026年9月4日')
assert('海报：摘要保留原文换行', pm.summary, '今天 过得不错，\n去了公园散步，\n天气很好。')
assert('海报：天气（不带图标，canvas 双端渲染口径）', pm.weather, '晴 28° · 深圳')
assert('海报：心情', pm.mood, '开心')
assert('海报：心情色', pm.moodColor, '#FFB300')
assert('海报：标签', JSON.stringify(pm.tags), JSON.stringify(['生活', '运动', '旅行']))
assert('海报：图片最多 3 张', pm.images.length, 3)

// ===== 6. 开关关闭 =====
const off = share.buildPosterModel(diary, { weather: false, mood: false, tags: false, images: false })
assert('海报：天气关', off.weather, '')
assert('海报：心情关', off.mood, '')
assert('海报：标签关', off.tags.length, 0)
assert('海报：图片关', off.images.length, 0)
assert('海报：关掉展示项后摘要仍在', off.summary !== '', true)

// ===== 7. 空日记兜底 =====
const em = share.buildPosterModel(emptyDiary, {})
assert('空日记海报：各字段为空', JSON.stringify({ s: em.summary, w: em.weather, m: em.mood, t: em.tags.length, i: em.images.length }), JSON.stringify({ s: '', w: '', m: '', t: 0, i: 0 }))
assert('空日记海报：不抛错返回日期空', em.date, '')

// ===== 8. 开关缺省（默认视为开） =====
const def = share.buildPosterModel(diary, {})
assert('缺省开关：视为全开含图', def.images.length, 3)

// ===== 9. 海报正文上限（方案1：150 → 600 字） =====
assert('海报：行数上限常量为 40', share.MAX_POSTER_LINES, 40)
const p300 = share.buildPosterModel({ createdAt: '2026年9月16日 10:00', content: bigText }, {})
assert('海报：300 字不截断', p300.summary.length, 300)
assert('海报：300 字未标记截断', p300.summaryTruncated, false)
const p900 = share.buildPosterModel({ createdAt: '2026年9月16日 10:00', content: '字'.repeat(900) }, {})
assert('海报：900 字截到 600', p900.summary.length, 600)
assert('海报：超限末尾省略号', p900.summary.slice(-1), '…')
assert('海报：超限标记截断', p900.summaryTruncated, true)

// ===== 10. 海报正文保留原文换行（2026-09-17） =====
assert('海报：多段换行原样保留',
  share.buildPosterModel({ content: '第一段。\n第二段。\n第三段。' }, {}).summary,
  '第一段。\n第二段。\n第三段。')
assert('海报：连续空行折叠为单换行',
  share.buildPosterModel({ content: '上段。\n\n\n下段。' }, {}).summary,
  '上段。\n下段。')
assert('海报：换行不占字数上限（600 字 + 换行不截断）',
  share.buildPosterModel({ content: '字'.repeat(590) + '\n' + '句'.repeat(10) }, {}).summaryTruncated,
  false)
const multiLong = share.buildPosterModel({ content: ('甲'.repeat(100) + '\n').repeat(8) + '乙'.repeat(50) }, {})
assert('海报：超限截断保留整行（首行 100 字完整）', multiLong.summary.split('\n')[0].length, 100)
assert('海报：截断后纯字数正好 600', multiLong.summary.replace(/\n/g, '').length, 600)
assert('海报：超限末尾省略号', multiLong.summary.slice(-1), '…')
assert('海报：截断处不留空行（6 行）', multiLong.summary.split('\n').length, 6)

// ===== 11. 海报品牌行（[poster-slogan v1] 2026-09-20）=====
// 品牌行后缀改由 appInfo.APP_SLOGAN 提供（与顶栏标题同一拼法），不得再硬编码「记录每一天」
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const sheetSrc = fs.readFileSync(path.join(ROOT, 'components', 'share-sheet', 'share-sheet.js'), 'utf8')
const appInfo = require(path.join(ROOT, 'utils', 'appInfo.js'))

assert('appInfo 导出 APP_SLOGAN 且非空',
  typeof appInfo.APP_SLOGAN === 'string' && appInfo.APP_SLOGAN.length > 0,
  true)
assert('appInfo 导出 APP_NAME 且非空',
  typeof appInfo.APP_NAME === 'string' && appInfo.APP_NAME.length > 0,
  true)
assert('海报品牌行拼法 == NAME·SLOGAN（出现 2 处：有码 / 无码布局）',
  sheetSrc.split("appInfo.APP_NAME + '·' + appInfo.APP_SLOGAN").length - 1,
  2)
assert('海报品牌行不再硬编码「记录每一天」',
  sheetSrc.indexOf("' · 记录每一天'") === -1,
  true)
assert('海报品牌行不再硬编码旧品牌名 AI 日记',
  sheetSrc.indexOf('来自 AI 日记') === -1,
  true)
assert('海报品牌行实际文本',
  '来自 ' + appInfo.APP_NAME + '·' + appInfo.APP_SLOGAN,
  '来自 一灯记·让AI照亮此间')
// 宽度护栏：有码布局文本左侧起于 PAD=46，码左缘 = 600-46-112 = 442 ⇒ 可用宽 396px @26px 字号
// 新文案 14 字符（含 2 个半角字母）= 约 310px < 396px，且不超旧文案「来自 一灯记 · 记录每一天」的 14 字符
const oldBrandLen = ('来自 ' + appInfo.APP_NAME + ' · 记录每一天').length
assert('海报品牌行长度不超过旧文案（宽度不增，不会压到小程序码）',
  ('来自 ' + appInfo.APP_NAME + '·' + appInfo.APP_SLOGAN).length <= oldBrandLen,
  true)

console.log('\nshare tests: ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
