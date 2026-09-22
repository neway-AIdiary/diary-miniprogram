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
// 海报正文：保留原文换行（与「复制文字版」同一口径），按上限截断且不切断整行；
// 换行不占用字数上限——上限只约束真正的文字量
function truncateSummary(text, max) {
  const limit = (typeof max === 'number' && max > 0) ? max : MAX_SUMMARY_LEN
  const full = cleanParagraphs(text)
  if (!full) return ''
  if (full.replace(/\n/g, '').length <= limit) return full
  const out = []
  let n = 0
  const lines = full.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (n + ln.length <= limit) { out.push(ln); n += ln.length; continue }
    // 本行放不下：能放多少写多少，再补省略号收尾（总字数仍不超过 limit）
    const rest = limit - n - 1
    if (rest > 0) {
      out.push(ln.slice(0, rest) + '…')
    } else if (out.length) {
      const last = out[out.length - 1]
      out[out.length - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…'
    } else {
      out.push(ln.slice(0, Math.max(1, limit - 1)) + '…')
    }
    break
  }
  return out.join('\n')
}

// [poster-weather-text v1] 海报天气文本（**不带图标**，2026-09-22 真机双端拍板 2）
// 为什么：海报是 canvas 绘制，天气图标全是 U+2600 系「基字符 + 变体选择符 U+FE0F」——
//   iOS canvas 的 sans-serif 回退链没有 FE0F 字形，把它画成 notdef 方框（☀□）；
//   安卓把 emoji 当全宽字符，再叠加代码里那个显式空格 ⇒ 视觉空隙约 1.5 字。
//   两个端的根都是「emoji 进 canvas」，剥 FE0F 只治一半 ⇒ 干脆不画图标。
//   心情 emoji 不受影响：全是单个星面码位、不带 FE0F，双端正常，故 pill 不动。
// 口径：只有海报走这里；「复制文字版」仍走 weatherLine（输入框里 emoji 渲染正常）。
// 防御：万一云端或旧数据把图标并进 weatherText，这里连 emoji 与变体选择符一起剥掉，
//   保证海报**永不出方格、永不留多余空格**（幂等、空值安全）。
function weatherTextOnly(d) {
  if (!d) return ''
  return String(d.weatherText == null ? '' : d.weatherText)
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')            // 变体选择符（方格真凶）+ 零宽连接符
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF]/g, '')    // 杂项符号 / 箭头 dingbat（emoji 基字符）
    .replace(/[\uD83C-\uD83E][\uDC00-\uDFFF]/g, '')  // 星面 emoji（U+1F000–1FBFF）；区间刻意收窄在
                                                     // emoji 块内，别误伤 CJK 扩展区生僻字（如 𠮷 U+20BB7）
    .replace(/\s+/g, ' ')
    .trim()
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

// [poster-font v1] 海报正文与「说明头」分层（2026-09-21 拍板 1.A）：
//   说明头 = 正文开头连续的「【标签】…」行（总结需求 / 分析范围）→ 单独小一号浅灰绘制；
//   正文 = 其余部分。只有说明头、没有正文时回退（brief 空、整体当正文），避免画出空海报。
function splitPosterBrief(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && /^【[^】]{1,8}】/.test(lines[i])) i++
  const brief = lines.slice(0, i).join('\n')
  const body = lines.slice(i).join('\n')
  if (!body.trim()) return { brief: '', body: brief }
  return { brief: brief, body: body }
}

// [poster-font v1] 每个段落首字空一个字（全角空格）：非空行前加一个「　」；
//   空行保持空行；已缩进的行不重复加（幂等，便于重复绘制 / 重复调用）
function indentParas(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function (line) {
      if (!line) return line
      if (line.charAt(0) === '\u3000' || line.charAt(0) === ' ') return line
      return '\u3000' + line
    })
    .join('\n')
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
    summaryTruncated: cleanParagraphs(d.content).replace(/\n/g, '').length > MAX_SUMMARY_LEN,
    // [poster-weather-text v1] 海报天气行不带图标（canvas 双端渲染口径，见 weatherTextOnly 注释）
    weather: sw.weather === false ? '' : weatherTextOnly(d),
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
  weatherTextOnly: weatherTextOnly,
  posterDate: posterDate,
  buildCopyText: buildCopyText,
  buildPosterModel: buildPosterModel,
  splitPosterBrief: splitPosterBrief,
  indentParas: indentParas
}
