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
assert('摘要：换行/多空格折叠', share.truncateSummary('a\n\n  b   c', 150), 'a b c')
assert('摘要：空文本', share.truncateSummary('   ', 150), '')
assert('摘要：自定义上限', share.truncateSummary('一二三四五六七八九十', 5), '一二三四…')

// ===== 2. 天气行 =====
assert('天气：icon+文本', share.weatherLine(diary), '☀️ 晴 28° · 深圳')
assert('天气：无 icon', share.weatherLine({ weatherText: '多云 20°' }), '多云 20°')
assert('天气：无天气', share.weatherLine({ weatherIcon: '☀️' }), '')
assert('天气：空对象', share.weatherLine(null), '')

// ===== 3. 复制精简文字（脱敏默认配置） =====
const copyText = share.buildCopyText(diary)
assert('复制：含日期', copyText.indexOf('2026年9月4日 16:20') !== -1, true)
assert('复制：含天气', copyText.indexOf('☀️ 晴 28° · 深圳') !== -1, true)
assert('复制：含心情', copyText.indexOf('开心') !== -1, true)
assert('复制：含标签', copyText.indexOf('#生活 #运动 #旅行') !== -1, true)
assert('复制：含折叠后的摘要', copyText.indexOf('今天 过得不错，去了公园散步，天气很好。') !== -1, true)
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
assert('海报：摘要', pm.summary, '今天 过得不错，去了公园散步，天气很好。')
assert('海报：天气', pm.weather, '☀️ 晴 28° · 深圳')
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

console.log('\nshare tests: ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
