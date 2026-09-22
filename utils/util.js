/**
 * 工具函数
 */

// 心情映射
const MOOD_MAP = {
  happy: { label: '😊 开心', color: '#FF9800', bg: 'rgba(255,152,0,0.1)' },
  calm: { label: '😌 平静', color: '#4CAF50', bg: 'rgba(76,175,80,0.1)' },
  neutral: { label: '😐 一般', color: '#9E9E9E', bg: 'rgba(158,158,158,0.1)' },
  sad: { label: '😔 难过', color: '#42A5F5', bg: 'rgba(66,165,245,0.1)' },
  angry: { label: '😤 生气', color: '#EF5350', bg: 'rgba(239,83,80,0.1)' },
  love: { label: '🥰 幸福', color: '#EC407A', bg: 'rgba(236,64,122,0.1)' },
  tired: { label: '😴 疲倦', color: '#7E57C2', bg: 'rgba(126,87,194,0.1)' },
  excited: { label: '🤩 兴奋', color: '#FF7043', bg: 'rgba(255,112,67,0.1)' },
  conflicted: { label: '🤔 纠结', color: '#8D6E63', bg: 'rgba(141,110,99,0.1)' },
  melancholy: { label: '😞 惆怅', color: '#78909C', bg: 'rgba(120,144,156,0.1)' },
  mixed: { label: '🫤 百感', color: '#9575CD', bg: 'rgba(149,117,205,0.1)' },
  gloomy: { label: '😒 郁闷', color: '#5C6BC0', bg: 'rgba(92,107,192,0.1)' },
  proud: { label: '😏 得意', color: '#D81B60', bg: 'rgba(216,27,96,0.1)' } // MARK:mood-v2-add
}

function getMoodLabel(mood) {
  return MOOD_MAP[mood] ? MOOD_MAP[mood].label : ''
}

function getMoodColor(mood) {
  return MOOD_MAP[mood] ? MOOD_MAP[mood].color : '#999'
}

function getMoodBg(mood) {
  return MOOD_MAP[mood] ? MOOD_MAP[mood].bg : 'rgba(153,153,153,0.1)'
}

// 格式化日期 — "8月14日 周五"
function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  return month + '月' + day + '日 周' + weekDays[d.getDay()]
}

// 紧凑日期 [list-date-compact v1] — 「8/14 周五」。仅供日记本列表卡片使用（省横向宽度给标签），
// 其他调用点（备份 / 我的 / 导出 / 分享）仍走 formatDate 的「8月14日 周五」，互不影响。
function formatCompactDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  return month + '/' + day + ' 周' + weekDays[d.getDay()]
}

// 格式化完整日期 — "2026年8月14日 14:30"
function formatFullDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const month = d.getMonth() + 1
  const day = d.getDate()
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  return y + '年' + month + '月' + day + '日 ' + h + ':' + m
}

// 格式化相对时间 — "刚刚" / "3分钟前" / "2小时前" / "昨天" / "3天前"
// compact=true ⇒ 超过 7 天的档位改用紧凑日期「8/14 周五」（仅日记本列表卡片传 true）
function formatRelativeTime(dateStr, compact) {
  if (!dateStr) return ''
  const now = new Date()
  const d = new Date(dateStr)
  const diff = now - d
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + '分钟前'
  if (hours < 24) return hours + '小时前'
  if (days === 1) return '昨天'
  if (days < 7) return days + '天前'
  // [list-date-compact v1] 不传 compact 时行为与改动前完全一致（其他页面零影响）
  return compact ? formatCompactDate(dateStr) : formatDate(dateStr)
}

// 获取默认标题（可指定日期，如 "2026-08-13"，不传则用今天）
// 注意：去掉"的"字，"X月X日 的日记" → "X月X日 日记"，更紧凑
function getDefaultTitle(dateStr) {
  const now = dateStr ? new Date(dateStr + 'T12:00:00') : new Date()
  return (now.getMonth() + 1) + '月' + now.getDate() + '日 日记'
}

// [title-content-fallback v1] 展示层标题兜底：日记标题为空时，取正文字开头几字当标题。
// 仅用于展示与分享；不主动写回存储（用户下次保存日记时经 getAllDiaries 自然固化，属既有行为）。
const CONTENT_TITLE_MAX = 7
const TITLE_TRIM_TAIL_RE = /[\s，。、；：！？…—～·,.!?;:()（）《》【】“”‘’"'-]+$/
// [title-content-fallback v2] 断句标点优先于长度上限：遇到第一个断句标点就停。
// 刻意**不含**引号/括号/书名号 —— 它们是「包裹」不是「断句」，
// 在它们处停下会把左引号带进标题（“今天天气不错），或开头即清空。
const TITLE_STOP_RE = /[，。、；：！？…—～·,.!?;:-]/

/**
 * 从正文提取标题片段：开头最多 max 个字，且**遇到第一个断句标点就停**
 * - 换行与连续空白压成单个空格后 trim（正文常以换行开头）
 * - 按「码点」逐字遍历，避免把 emoji/代理对截成半个字符
 * - 断句标点优先于长度上限：「早上很堵，我开车去公司」→「早上很堵」（不是「早上很堵，我开车」）
 * - 开头的标点直接跳过、不计入已取内容（「，今天很堵」→「今天很堵」）
 * - 去掉结尾残留的标点（引号/括号类兜底：「今天很好”’」→「今天很好」）
 * @param {string} content 日记正文
 * @param {number} [max=7] 最多几个字
 * @returns {string} 取不到时返回空串
 */
function titleFromContent(content, max) {
  const limit = (typeof max === 'number' && max > 0) ? max : CONTENT_TITLE_MAX
  const s = String(content == null ? '' : content).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const chars = Array.from(s)
  const out = []
  for (let i = 0; i < chars.length; i++) {
    if (TITLE_STOP_RE.test(chars[i])) {
      if (!out.length) continue
      break
    }
    out.push(chars[i])
    if (out.length >= limit) break
  }
  return out.join('').replace(TITLE_TRIM_TAIL_RE, '').trim()
}

/**
 * 解析日记的展示标题 —— **所有展示出口的唯一口径**
 *   ① 自身 title 非空（含非纯空白）→ 原样返回
 *   ② 正文取得到字 → 正文开头 ≤7 字
 *   ③ 实在没有 → 日期标题「X月X日 日记」
 * @param {object} diary
 * @returns {string}
 */
function resolveDiaryTitle(diary) {
  if (!diary) return ''
  const own = String(diary.title == null ? '' : diary.title).trim()
  if (own) return own
  const fromContent = titleFromContent(diary.content)
  if (fromContent) return fromContent
  return getDefaultTitle(getDateKey(new Date(diary.created_at)))
}

// 显示侧栏/详情页时，统一去掉旧数据里夹带的"的"字
// 旧数据：title = "9月7日 的日记" → "9月7日 日记"
// 非默认格式（如用户自定义的"周末爬山"）原样保留
function stripDiaryTitleSuffix(title) {
  if (!title) return title
  // 匹配 "X月X日 的日记" → "X月X日 日记"；宽容中间任意空白
  return String(title).replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*的\s*日记/g, '$1月$2日 日记')
}

// 获取当前时间文本
function getCurrentTimeText() {
  const now = new Date()
  const h = now.getHours().toString().padStart(2, '0')
  const m = now.getMinutes().toString().padStart(2, '0')
  return h + ':' + m
}

// 获取日期键值 — "2026-08-14"
function getDateKey(date) {
  const d = date || new Date()
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return y + '-' + m + '-' + day
}

// 导入去重用的「正文指纹」[import-dedup v1.1]：只消除格式差异（换行符 / 行首尾空白 /
// 纯空白行 / 段间距档位），**不改动入库原文**。同一篇日记经不同格式（docx / txt / 网页复制）
// 导出后指纹一致 ⇒ 判为重复；正文真有差异（多一段、改一句）时指纹仍不同 ⇒ 照常判两篇。
// ⚠️ 连续换行统一压成 1 个（段间分隔与单换行等价）：真机 docx 走 parseDocxXml，段间是单个 \n；
// txt 的空行分段归一后是 \n\n —— 若保留两档，跨格式键必然不等（9-21 实测 31 篇全部键不等）。
// 分段位置仍保留（换行都在），丢的只是「空行比单换行多一档」的排版信息。
function contentFingerprint(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  const lines = raw.split('\n').map((line) => {
    return line.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, '')
  })
  return lines.join('\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * 正文拆行（详情页 / 总结结果页逐行渲染用）：
 * 把纯文本正文拆成 [{k, text, heading}] 数组，wxml 用 wx:for 渲染，
 * 小标题行（◆ / ◇ 开头）单独加粗（不上色）。
 *
 * 兼容两种数据：
 *   1. aiSummary 已归一化的新总结（行首已是 ◆ / ◇）；
 *   2. 历史遗留的 markdown（行首 ## / ### 或列表符号 - / * / +）——这里就地转符号、去掉行内 **。
 * 注意：放在 JS 逻辑层而不是 WXS——WXS 环境限制多（不支持正则字面量、
 *       String() 等全局存疑），且视图层运行时报错不打进 Console，排查困难。
 */
function buildContentLines(text) {
  const raw = text === null || text === undefined ? '' : String(text)
  return raw.replace(/\r\n?/g, '\n').split('\n').map((line, k) => {
    let t = line.replace(/^\s+/, '')
    const m = t.match(/^(#{1,6})\s*(.*)$/)
    if (m) {
      t = (m[1].length <= 2 ? '◆ ' : '◇ ') + m[2].replace(/\*\*/g, '')
    } else {
      // 列表符号 - / * / + → 「· 」（纯符号行如 "- - -" 保持原样）
      const li = t.match(/^[-*+]\s+(.*)$/)
      if (li) {
        const body = li[1].replace(/\*\*/g, '').trim()
        if (body && !/^[-*+\s]+$/.test(body)) t = '· ' + body
      }
    }
    t = t.replace(/\*\*/g, '')
    const c = t.charAt(0)
    return { k: k, text: t, heading: c === '◆' || c === '◇' || c === '▍' }
  })
}

/**
 * 是否为「AI 总结」生成的日记（产出物判据，多处共用）：
 *   - 不参与后续 AI 总结（避免上一轮结论被再次汇总形成自我循环）
 *   - 不参与同日融合（新写的日记不合并进总结里）
 * 注意：不能用 source === 'ai' 判断——「AI 优化日记」也用该值，会误伤
 */
function isAiSummaryDiary(d) {
  if (!d) return false
  if (d.entryType === 'summary') return true
  const tags = Array.isArray(d.tags) ? d.tags : []
  if (tags.indexOf('AI总结') !== -1) return true
  return /【AI总结】/.test(String(d.title || ''))
}

module.exports = {
  MOOD_MAP,
  getMoodLabel,
  getMoodColor,
  getMoodBg,
  formatDate,
  formatFullDate,
  formatRelativeTime,
  formatCompactDate,
  getDefaultTitle,
  titleFromContent,
  resolveDiaryTitle,
  stripDiaryTitleSuffix,
  getCurrentTimeText,
  getDateKey,
  contentFingerprint,
  buildContentLines,
  isAiSummaryDiary
}
