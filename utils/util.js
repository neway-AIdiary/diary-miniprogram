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
  getDateKey
}
