/**
 * utils/looseImport.js
 * [loose-import v1] 宽泛导入引擎（纯函数，不碰 wx.*）
 *
 * 需求口径（用户拍板）：
 *   1. 非小程序导出格式（Word 手写稿 / txt / md 等自由文本）宽泛识别：
 *      文本块里认得出「日期 / 标题 / 段落」即可成篇，所有文字保证落库。
 *   2. 日期写在正文里 → 提取出来落到 created_at（时间数据），正文原样保留（不删日期句）。
 *   3. 缺年份的日期按「就近过去年份」推断：候选年 = 今年；该月日若还没到（未来）→ 退一年。
 *      例：现在是 2026-09，导入「10月」补 2025，「7月」补 2026。
 *   4. 分篇口径 [loose-block-v2]（用户拍板，取代旧「空行分隔的无日期块单独成篇」）：
 *      - 只有「日期头行」才切新篇：一个日期头之后的所有段落（含空行分隔的）全部归该篇，
 *        直到下一个日期头 —— 与 Word 稿的阅读直觉一致，不会把段落切成一堆碎片；
 *      - 段落之间的空行保留（连续空行压缩为一个），正文段落结构不丢；
 *      - 日期头之前的开头无日期内容 → 单独成篇、日期留空（展示为无日期，排序沉底）；
 *      - 全文找不到任何日期 → 整篇合为一篇日记（保留段落）。
 *   5. [loose-shortdrop] 过短噪声丢弃：**无日期的**独立篇，正文去掉空白后 ≤10 字 ⇒ 不落库
 *      （文档标题 / 页眉 / 页码类）；**有日期的短篇一律保留**（那是用户明确记录）；
 *      「全文无日期 → 整篇合一」的那一篇不适用本规则；丢弃必须如实报告（stats.dropped / droppedSamples）。
 *   6. [loose-flatline] 整篇不分行时按日期切段：整篇**一个换行都没有**、且能找到
 *      **≥2 个「两侧都是边界」的日期**（边界 = 空白 / 常用标点 / 首尾）⇒ 在每个日期前断行成多行，
 *      再走上面的日期头切篇逻辑（口径天然一致）；日期句保留在正文（3.A）；
 *      两侧不同时是边界的日期（句子中间的提及）一律不切。
 *
 * 判定规则（保守，全部规则引擎、不走 AI）：
 *   - 日期模式：
 *       带年：2026年9月20日 / 2026-09-20 / 2026.9.20 / 2026/9/20
 *       缺年：9月20日 / 9月20日（行首）；行首还接受裸数字 9.20 / 9-20 / 9/20
 *       行首裸数字必须有边界保护：后面紧跟非空白/标点（如「3.5公里」）不算日期，
 *       形如 a.b.c 的三段数字（版本号）不算日期。
 *       正文中部（非行首）只认 带年形式 与 X月X日，避免把小数/比分误判成日期。
 *   - 标题：条目首行 ≤16 字、无断句标点（。？！；…，）→ 用作 title（从正文提出，不重复保留）；
 *     其余情况 title 留空（dated 用「X月X日 日记」兜底，undated 走展示层正文开头兜底）。
 *   - 日期头行（整行以日期开头且剩余部分很短）：剩余部分作标题候选；无剩余 → 标题留空。
 *     剩余部分较长（是正文）→ 整行原样留在正文（含日期句）。
 */

const util = require('./util.js')

// 带年份日期：2026年9月20日 | 2026-09-20 | 2026.9.20 | 2026/9/20（尾部不跟数字，防 2026-09-2011 这类截断）
// [dhv2#6] 日期单位兼容「日 / 号」
const RE_DATE_YMD = /(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})[日号]?(?!\d)/
// 缺年中文式：9月20日
const RE_DATE_MD = /(\d{1,2})月(\d{1,2})[日号]/ // [dhv2#7] 兼容「号」
// 行首裸数字（仅日期头判定用）：9.20 / 9-20 / 9/20
// 双重边界：其后不得再跟数字/分隔符（排除 1.2.3 版本号），且必须是空白/标点/行尾（排除 3.5公里 这类数值）
const RE_DATE_BARE = /^(\d{1,2})[.\-/](\d{1,2})(?![\d.\-/])(?=$|[\s：:、，,。；！？（()「」『』\-—])/
// 断句标点（含逗号）：标题/日期头剩余部分出现即不算短标题
const RE_SENT_PUNCT = /[。？！；…，,]/

// [loose-shortdrop] 无日期独立篇的丢弃阈值（去空白后字数 ≤ 此值 ⇒ 判为文档标题类噪声）
const SHORT_DROP_MAX = 10
// [loose-flatline] 切点边界字符（空白 / 常用标点 —— 与「首尾」共同构成边界）
const FLAT_BOUND = '[\\s，。；！？、：,;!?…]'
// [loose-flatline] 日期本体（与 findDateInText 同口径：带年 or X月X日；裸数字不认，避免误切）
const FLAT_DATE = '(?:\\d{4}\\s*[年\\-/.]\\s*\\d{1,2}\\s*[月\\-/.]\\s*\\d{1,2}\\s*[日号]?|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号])'

// [loose-shortdrop#2] 空结果 stats 统一结构（含 dropped 计数）
function emptyStats() {
  return { dated: 0, undated: 0, dropped: 0, droppedSamples: [] }
}

function isBlank(line) {
  return !line || !line.trim()
}

function validMonthDay(m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}

/**
 * 缺年推断（用户规则）：候选年 = now 所在年；月日若在未来 → 退一年。
 * 只按「日期」比较，不含时间（避免当天上午把当天日期误退一年）。
 * 返回当天中午 12 点的 Date（与既有解析口径一致，避免时区偏移）。
 */
function inferNoYearDate(m, d, now) {
  const y0 = now.getFullYear()
  let y = y0
  const cand = new Date(y, m - 1, d)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (cand > today) y = y0 - 1
  return new Date(y, m - 1, d, 12, 0, 0)
}

function ymdToDate(y, m, d) {
  if (!validMonthDay(m, d)) return null
  return new Date(y, m - 1, d, 12, 0, 0)
}

// 从文本里找第一个日期（正文级：只认带年形式与 X月X日，不认裸数字）
function findDateInText(text) {
  let m = text.match(RE_DATE_YMD)
  if (m) {
    const t = ymdToDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10))
    if (t) return { date: t, hasYear: true, raw: m[0] }
  }
  m = text.match(RE_DATE_MD)
  if (m) {
    const mm = parseInt(m[1], 10)
    const dd = parseInt(m[2], 10)
    if (validMonthDay(mm, dd)) return { date: null, hasYear: false, month: mm, day: dd, raw: m[0] }
  }
  return null
}

/**
 * 日期头行判定：整行以日期开头，剩余部分短（可作标题）或为空。
 * 返回 { date|{month,day}, rest } 或 null。
 * rest 已去掉分隔符/周X/「日记」「合并日记」尾巴与首尾空白。
 */
function matchDateHeader(line) {
  const t = line.trim()
  if (!t) return null
  // 1) 带年形式开头
  let m = t.match(/^(\d{4})[年](\d{1,2})月(\d{1,2})[日号]?/) // [dhv2#8]
  if (!m) m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d.\-/])/)
  if (m) {
    const date = ymdToDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10))
    if (!date) return null
    return { date: date, hasYear: true, rest: cleanRest(t.slice(m[0].length)) }
  }
  // 2) 9月20日 开头
  m = t.match(/^(\d{1,2})月(\d{1,2})[日号]/) // [dhv2#9] 兼容「号」
  if (m) {
    const mm = parseInt(m[1], 10)
    const dd = parseInt(m[2], 10)
    if (!validMonthDay(mm, dd)) return null
    return { date: null, hasYear: false, month: mm, day: dd, rest: cleanRest(t.slice(m[0].length)) }
  }
  // 3) 行首裸数字 9.20 / 9-20 / 9/20（必须有边界：其后是空白/标点/行尾）
  m = t.match(RE_DATE_BARE)
  if (m) {
    const mm = parseInt(m[1], 10)
    const dd = parseInt(m[2], 10)
    if (!validMonthDay(mm, dd)) return null
    return { date: null, hasYear: false, month: mm, day: dd, rest: cleanRest(t.slice(m[0].length)) }
  }
  return null
}

// 日期头剩余部分清洗：去首部分隔符、周X、「日记」「合并日记」尾巴
function cleanRest(rest) {
  let s = String(rest || '').trim()
  s = s.replace(/^[：:、，,．.\-—\s]+/, '')
  // [dhv2#10] 行尾括号备注（如「（最终修正版）」「(已修正人名)」）不作标题
  s = s.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/(?:周|星期)[日一二三四五六]/g, '').trim() // [dhv2#20] 兼容「星期五」
  // [dhv2#22] 修：原 /合并?日记$/ 只认「合日记 / 合并日记」，「日记」尾从未被清掉
  s = s.replace(/(?:合并)?日记$/g, '').trim()
  return s
}

// 首行是否「标题样」：≤16 字、无断句标点、非纯数字（「11」这类日期头残渣不配当标题）
function isTitleLike(line) {
  const t = String(line || '').trim()
  if (!t || t.length > 16) return false
  if (RE_SENT_PUNCT.test(t)) return false
  if (/^\d+$/.test(t)) return false
  return true
}

/**
 * [loose-flatline] 整篇不分行时的「按日期断行」预处理。
 * 触发（全部满足才生效）：① 文本里一个换行都没有；② 找到 ≥2 个「两侧都是边界」的日期。
 * 处理：在每个切点日期前断行（日期前的空白被吃掉，标点留在上一行末尾），
 *       使文本恢复成「日期头 + 正文」的多行形态，后续完全复用既有切篇逻辑。
 * 不满足条件时原样返回。
 */
function splitFlatLine(text) {
  const src = String(text == null ? '' : text)
  if (!src || src.indexOf('\n') !== -1) return src
  const re = new RegExp('(^|' + FLAT_BOUND + ')[ \\t\\u3000]*(' + FLAT_DATE + ')(?=[ \\t\\u3000]|' + FLAT_BOUND + '|$)', 'g')
  const hits = src.match(re)
  if (!hits || hits.length < 2) return src
  return src.replace(re, function (all, pre, date, offset) {
    const keepPre = (pre && !/\s/.test(pre)) ? pre : ''
    return keepPre + (offset === 0 ? '' : '\n') + date
  })
}

function newEntry() {
  return {
    date: null,        // Date 或 null（null = 无日期）
    noYear: false,     // 原文日期是否缺年（需 inferNoYearDate 推断）
    month: 0,
    day: 0,
    titleRemainder: '', // 日期头行带来的标题候选
    lines: []          // 原始行（不含日期头行本身）
  }
}

/**
 * 宽泛解析：自由文本 → 日记数组
 * @param {string} text 任意文本
 * @param {object} [opts] { now: Date } 测试注入当前时间；缺省 new Date()
 * @returns {{diaries: Array, stats: {dated: number, undated: number}}}
 *   diary: { id, title, content, mood:'', tags:[], location:null, media:[], weather:null, created_at }
 *   created_at 为 '' 表示无日期（2.A 口径）；dated 为推断后的 ISO（当天中午 12 点）。
 */
function parseLooseDiaries(text, opts) {
  if (!text || typeof text !== 'string') return { diaries: [], stats: emptyStats() }
  const now = (opts && opts.now instanceof Date) ? opts.now : new Date()
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // [loose-flatline#1] 整篇不分行（一个换行都没有）且 ≥2 个带边界日期 → 先按日期断行
  const lines = splitFlatLine(normalized).split('\n')

  // 全文无任何日期 → 整篇合为一篇（保留段落），标题取首个标题样首行
  const wholeHasDate = (() => {
    for (const line of lines) {
      if (isBlank(line)) continue
      if (findDateInText(line) || matchDateHeader(line)) return true
    }
    return false
  })()
  if (!wholeHasDate) {
    const nonBlank = lines.filter(l => !isBlank(l))
    if (!nonBlank.length) return { diaries: [], stats: emptyStats() }
    let title = ''
    let contentLines = lines
    // 首行标题样且提出后正文仍有内容 → 提为标题；否则整篇进正文（单行文本保证落库）
    if (isTitleLike(lines[0])) {
      const rest = lines.slice(1).join('\n').replace(/\n{3,}/g, '\n\n').trim()
      if (rest) {
        title = lines[0].trim()
        contentLines = lines.slice(1)
      }
    }
    const content = contentLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!content) return { diaries: [], stats: emptyStats() }
    return {
      diaries: [makeDiary({ title: title, content: content, created_at: '' })],
      stats: { dated: 0, undated: 1, dropped: 0, droppedSamples: [] }
    }
  }

  const entries = []
  let cur = null
  // [loose-block-v2#1] 旧 open / headerGrace 状态机已移除：分篇只由日期头决定，空行不再切篇

  const flush = () => {
    if (cur) entries.push(cur)
    cur = null
  }

  for (const rawLine of lines) {
    if (isBlank(rawLine)) {
      // [loose-block-v2#2] 空行不再切篇：仅作段落分隔保留（行首空行忽略、连续空行压缩为一个）
      if (cur && cur.lines.length && cur.lines[cur.lines.length - 1] !== '') cur.lines.push('')
      continue
    }
    const header = matchDateHeader(rawLine)
    if (header) {
      flush()
      cur = newEntry()
      // 剩余部分：短 → 标题候选（日期部分转为元数据）；
      // 长（是正文）→ 整行原样保留进正文（3.A：日期句留在原文，不吞字）
      if (header.rest && isTitleLike(header.rest)) {
        cur.titleRemainder = header.rest
      } else if (header.rest) {
        cur.lines.push(rawLine.trim())
      }
      if (header.hasYear) {
        cur.date = header.date
      } else {
        cur.noYear = true
        cur.month = header.month
        cur.day = header.day
      }
      // [loose-block-v2#5] 日期头之后的段落一律归该篇（不再有「空行封闭」）
      continue
    }
    if (!cur) {
      // [loose-block-v2#3] 只在「尚无当前条目」时另起一篇（文件开头 / 日期头之前的无日期内容）；
      // 其余一律归当前篇 —— 旧「空行后另起一篇（2.A）」已按用户拍板废弃
      cur = newEntry()
    }
    cur.lines.push(rawLine)
  }
  flush()

  const diaries = []
  let dated = 0
  let undated = 0
  let dropped = 0            // [loose-shortdrop#2] 被丢弃的过短无日期篇数
  const droppedSamples = []  // 供导入报告展示（前 3 条）
  entries.forEach(e => {
    // [loose-block-v2#4] 段落首尾空行清零（空行只作段落分隔用；
    // 否则「日期头 + 单行 + 尾空行」会被标题提用吃掉，只剩空正文导致整篇丢失）
    const bodyLines = (function () {
      const arr = e.lines.slice()
      while (arr.length && arr[0] === '') arr.shift()
      while (arr.length && arr[arr.length - 1] === '') arr.pop()
      return arr
    })()
    // 日期落盘
    let created = ''
    if (e.date) {
      created = e.date.toISOString()
    } else if (e.noYear) {
      created = inferNoYearDate(e.month, e.day, now).toISOString()
    }
    // 正文内日期（首行含日期）：提取落盘，正文原样保留（3.A）
    let contentText = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() // [loose-block-v2#6]
    if (!created && contentText) {
      const firstLine = bodyLines.length ? bodyLines[0] : '' // [loose-block-v2#7]
      const found = findDateInText(firstLine)
      if (found) {
        created = found.hasYear
          ? found.date.toISOString()
          : inferNoYearDate(found.month, found.day, now).toISOString()
      }
    }
    // 标题：日期头剩余 > 条目首行标题样提用（首行含日期时不提，防日期行被吃进标题）> 留空兜底
    let title = e.titleRemainder && isTitleLike(e.titleRemainder) ? e.titleRemainder : ''
    if (!title && bodyLines.length >= 2 && isTitleLike(bodyLines[0]) && !findDateInText(bodyLines[0])) {
      title = bodyLines[0].trim() // [loose-block-v2#8]
      contentText = bodyLines.slice(1).join('\n').trim()
    }
    if (!contentText && title) {
      // [loose-shortdrop#4] 日期头短剩余被提为标题、正文为空（如「9月1日 晴」）：
      // 正文回填该文本、title 交回默认 —— 旧版这里会静默丢篇（文字没落库）
      contentText = title
      title = ''
    }
    if (!contentText) return
    if (created) {
      dated++
      if (!title) title = util.getDefaultTitle(util.getDateKey(new Date(created)))
    } else {
      // [loose-shortdrop#1] 无日期的独立篇：去掉空白后 ≤10 字 ⇒ 判为文档标题/页眉类噪声，不落库
      // （有日期的短篇一律保留；「全文无日期 → 整篇合一」不走这里）
      const visible = contentText.replace(/\s/g, '')
      if (visible.length <= SHORT_DROP_MAX) {
        dropped++
        if (droppedSamples.length < 3) {
          droppedSamples.push('『' + contentText.replace(/\s+/g, ' ').slice(0, SHORT_DROP_MAX) + '』')
        }
        return
      }
      undated++
    }
    diaries.push(makeDiary({ title: title, content: contentText, created_at: created }))
  })

  return {
    diaries: diaries,
    stats: { dated: dated, undated: undated, dropped: dropped, droppedSamples: droppedSamples } // [loose-shortdrop#2]
  }
}

function makeDiary(o) {
  return {
    id: 'loose_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: o.title || '',
    content: o.content,
    mood: '',
    tags: [],
    location: null,
    media: [],
    weather: null,
    created_at: o.created_at || ''
  }
}

// ===== [dhv2#15] 归一化垫层（「临时手段」内建）+ 保险丝判据 =====
// 归一化垫层：把日期头行里的常见变体抹平 ——「X月X号」→「X月X日」、去掉行尾括号备注、
// 去掉「周X」。只处理「抹平后确实是纯日期头」的行，正文行一字不改（3.A 口径）。
function normalizeDateHeaderLine(line) {
  const raw = String(line == null ? '' : line)
  if (!raw.trim()) return raw
  let s = raw.trim()
  s = s.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*号/g, '$1月$2日')
  s = s.replace(/[（(][^）)]*[）)]/g, ' ')
  s = s.replace(/(?:周|星期)[日一二三四五六]/g, ' ') // [dhv2#21] 兼容「星期五」
  s = s.replace(/[\t\u3000 ]+/g, ' ').trim()
  const m = s.match(/^(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?(?:\s*[、,，]\s*(?:\d{1,2}\s*月\s*)?\d{1,2}\s*[日号]?)*(?:\s*合并)?\s*(?:日记)?$/)
  if (!m) return raw
  if (!validMonthDay(parseInt(m[2], 10), parseInt(m[3], 10))) return raw
  return s
}

function normalizeDateHeaders(text) {
  if (!text || typeof text !== 'string') return text || ''
  return text.split('\n').map(normalizeDateHeaderLine).join('\n')
}

function countDateHeaders(text) {
  if (!text || typeof text !== 'string') return 0
  let n = 0
  text.split('\n').forEach(line => { if (matchDateHeader(line)) n++ })
  return n
}

// 保险丝判据：可见文本里的行级日期头明显多于已识别篇数，且存在超长单篇
// ⇒ 文本级（或 XML 级）解析很可能把若干日记「吞并」进了一篇
function isSuspectHeaderSplit(diaries, text) {
  const list = Array.isArray(diaries) ? diaries.filter(d => d && d.content) : []
  if (!list.length) return false
  const headers = countDateHeaders(text)
  if (headers < list.length + 2) return false
  let maxLen = 0
  list.forEach(d => { const n = String(d.content).length; if (n > maxLen) maxLen = n })
  return maxLen > 1500
}

/**
 * [loose-shortdrop#3] 导入报告的「过短忽略」尾部文案（无忽略时返回空串）。
 * 被丢弃的内容必须让用户看得见 —— 不允许静默丢内容。
 */
function statsSuffix(stats) {
  const n = (stats && stats.dropped) || 0
  if (!n) return ''
  const samples = (stats && stats.droppedSamples) || []
  return '；已忽略 ' + n + ' 处过短内容（≤' + SHORT_DROP_MAX + ' 字）' + (samples.length ? '：' + samples.join('、') : '')
}

module.exports = {
  parseLooseDiaries,
  // 供测试
  inferNoYearDate,
  matchDateHeader,
  isTitleLike,
  findDateInText,
  normalizeDateHeaders, // [dhv2#16]
  isSuspectHeaderSplit, // [dhv2#16]
  splitFlatLine,        // [loose-flatline#3]
  statsSuffix,          // [loose-shortdrop#3]
  SHORT_DROP_MAX        // [loose-shortdrop#3]
}
