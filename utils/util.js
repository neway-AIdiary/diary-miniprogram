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
  excited: { label: '🤩 兴奋', color: '#FF7043', bg: 'rgba(255,112,67,0.1)' }
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
function formatRelativeTime(dateStr) {
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
  return formatDate(dateStr)
}

// 获取默认标题（可指定日期，如 "2026-08-13"，不传则用今天）
// 注意：去掉"的"字，"X月X日 的日记" → "X月X日 日记"，更紧凑
function getDefaultTitle(dateStr) {
  const now = dateStr ? new Date(dateStr + 'T12:00:00') : new Date()
  return (now.getMonth() + 1) + '月' + now.getDate() + '日 日记'
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

/**
 * 正文拆行（详情页 / 总结结果页逐行渲染用）：
 * 把纯文本正文拆成 [{k, text, heading}] 数组，wxml 用 wx:for 渲染，
 * 小标题行（◆ / ◇ 开头）单独加粗（不上色）。
 *
 * 兼容两种数据：
 *   1. aiSummary 已归一化的新总结（行首已是 ◆ / ◇）；
 *   2. 历史遗留的 markdown（行首 ## / ###）——这里就地转符号、去掉行内 **。
 * 注意：放在 JS 逻辑层而不是 WXS——WXS 环境限制多（不支持正则字面量、
 *       String() 等全局存疑），且视图层运行时报错不打进 Console，排查困难。
 */
function buildContentLines(text) {
  const raw = text === null || text === undefined ? '' : String(text)
  return raw.replace(/\r\n?/g, '\n').split('\n').map((line, k) => {
    let t = line.replace(/^\s+/, '')
    const m = t.match(/^(#{1,6})\s*(.*)$/)
    if (m) t = (m[1].length <= 2 ? '◆ ' : '◇ ') + m[2].replace(/\*\*/g, '')
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
  getDefaultTitle,
  stripDiaryTitleSuffix,
  getCurrentTimeText,
  getDateKey,
  buildContentLines,
  isAiSummaryDiary
}
