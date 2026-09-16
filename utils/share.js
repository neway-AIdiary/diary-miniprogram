// utils/share.js —— 日记分享内容组装（脱敏核心逻辑，纯函数，不依赖 wx，可 node 测试）
// 入参 diary 为详情页装饰后的 view model，含：
//   createdAt(如「2026年9月4日 16:20」) / content / moodText / moodColor / moodBg
//   weatherIcon / weatherText(如「晴 28° · 深圳」) / tags:[] / images:[cloud fileID...]
// 脱敏铁律（对应产品文档）：
//   复制文字版给全文（保留段落结构，不截断）；海报正文上限 600 字（约 40 行），超长末行渐隐并引导扫码；
//   最多 3 张图缩略；视频、定位永不出现；
//   没天气就隐藏天气栏，不留空模块。
const MAX_SUMMARY_LEN = 600   // 海报正文上限（字）——约 40 行 × 15 字；再长会触到 canvas 像素上限
const MAX_POSTER_LINES = 40   // 海报正文最多绘制的行数（与字数上限互为保险）
const MAX_POSTER_IMAGES = 3   // 海报精选图上限

// 折叠空白并去首尾；顺带去掉中文标点后残留的空格（换行折叠产生的「， 去」类瑕疵）
function cleanLine(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/([，。；：！？、」』）】〉》]) /g, '$1')
    .trim()
}

// 正文按段落清理（复制文字版用）：保留换行结构，逐行折叠空白、去空行
function cleanParagraphs(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function (line) { return cleanLine(line) })
    .filter(function (line) { return !!line })
    .join('\n')
}
// 正文压成单行摘要并按上限截断：上限内取整段，超出截到 limit-1 字 + …
function truncateSummary(text, max) {
  const limit = (typeof max === 'number' && max > 0) ? max : MAX_SUMMARY_LEN
  const t = cleanLine(text)
  if (!t) return ''
  if (t.length <= limit) return t
  return t.slice(0, limit - 1) + '…'
}

// 天气一行（icon + 文本），无则空串
function weatherLine(d) {
  if (!d) return ''
  const txt = String(d.weatherText || '').trim()
  if (!txt) return ''
  return (d.weatherIcon ? String(d.weatherIcon) + ' ' : '') + txt
}

// 复制文字版（脱敏默认配置）：日期 + 天气 + 心情 + 标签 + 全文（保留段落，不截断）
function buildCopyText(d) {
  if (!d) return ''
  const lines = []
  if (d.createdAt) lines.push(String(d.createdAt).trim())
  const w = weatherLine(d)
  if (w) lines.push(w)
  if (d.moodText) lines.push(String(d.moodText).trim())
  const tags = Array.isArray(d.tags) ? d.tags.map(t => '#' + String(t).trim()).filter(Boolean) : []
  if (tags.length) lines.push(tags.join(' '))
  const body = cleanParagraphs(d.content)
  if (body) lines.push('', body) // 正文前空一行更易读
  return lines.join('\n').trim()
}

// 海报日期：从「2026年9月4日 16:20」取「2026年9月4日」；取不到则原样
function posterDate(createdAt) {
  const s = String(createdAt || '').trim()
  if (!s) return ''
  const m = s.match(/^(\d{4}年\d{1,2}月\d{1,2}日)/)
  return m ? m[1] : s
}

// 公开海报数据模型（遵循开关 + 兜底隐藏空模块）
function buildPosterModel(d, sw) {
  sw = sw || {}
  if (!d) {
    return { date: '', summary: '', summaryTruncated: false, weather: '', mood: '', moodColor: '', moodBg: '', tags: [], images: [] }
  }
  const m = {
    date: posterDate(d.createdAt),
    summary: truncateSummary(d.content),
    summaryTruncated: cleanLine(d.content).length > MAX_SUMMARY_LEN,
    weather: sw.weather === false ? '' : weatherLine(d),
    mood: sw.mood === false ? '' : (String(d.moodText || '').trim()),
    moodColor: sw.mood === false ? '' : (d.moodColor || '#8A8F8C'),
    moodBg: sw.mood === false ? '' : (d.moodBg || 'rgba(138,143,140,0.12)'),
    tags: (sw.tags === false) ? [] : (Array.isArray(d.tags) ? d.tags.map(t => String(t).trim()).filter(Boolean) : []),
    images: []
  }
  if (sw.images !== false && Array.isArray(d.images)) {
    m.images = d.images.filter(u => u && typeof u === 'string').slice(0, MAX_POSTER_IMAGES)
  }
  return m
}

module.exports = {
  MAX_SUMMARY_LEN: MAX_SUMMARY_LEN,
  MAX_POSTER_LINES: MAX_POSTER_LINES,
  MAX_POSTER_IMAGES: MAX_POSTER_IMAGES,
  cleanLine: cleanLine,
  cleanParagraphs: cleanParagraphs,
  truncateSummary: truncateSummary,
  weatherLine: weatherLine,
  posterDate: posterDate,
  buildCopyText: buildCopyText,
  buildPosterModel: buildPosterModel
}
