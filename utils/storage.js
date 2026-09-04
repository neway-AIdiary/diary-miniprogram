/**
 * 本地存储工具 — 日记数据本地持久化，无需后端也能正常使用
 */

const util = require('./util.js')
const zipWriter = require('./zipWriter.js')
// 档案描述追加规则与手写输入添加共用（archiveEdit.appendArchiveDescription），
// 保证「语音添加」与「手写输入添加」对已存在名词的描述追加结果完全一致
const archiveEdit = require('./archiveEdit.js')

const STORAGE_KEY = 'diaries'
// 文本导出/导入的分隔线（整行 >=10 个 = 视为分段标记）
const TEXT_SPLIT = /^={10,}\s*$/m

/* ===== 本地存储容量保护 =====
 * 微信单 key 上限 1MB、总量上限 10MB，写满时 setStorageSync 直接抛异常。
 * 这里统一做「写入前预检查 + 写入异常兜底」，失败时提示用户先导出备份，
 * 而不是静默失败或让用户误以为保存成功。
 */
const STORAGE_FULL_TIP = '本地存储已满，保存失败。\n\n请先「导出备份」保存日记，再删除部分旧日记腾出空间。'
const STORAGE_SAFE_MARGIN = 200 * 1024 // 预留 200KB 安全余量，避免贴着上限写入

// 估算对象 JSON 序列化后的 UTF-8 字节数（预检查用，估算失败返回 0 表示跳过预检查）
function estimateUtf8Bytes(obj) {
  try {
    return unescape(encodeURIComponent(JSON.stringify(obj))).length
  } catch (e) {
    return 0
  }
}

// 查询剩余空间是否足够写入 estimatedBytes
// 注意：wx.getStorageInfoSync 返回的 currentSize / limitSize 单位是 KB，需换算成字节
function checkStorageSpace(estimatedBytes) {
  try {
    const info = wx.getStorageInfoSync()
    const limit = (info.limitSize || 10 * 1024) * 1024 // KB → 字节（默认 10MB）
    const free = limit - (info.currentSize || 0) * 1024 // KB → 字节
    const need = (estimatedBytes || 0) + STORAGE_SAFE_MARGIN
    return { ok: free >= need, free: free, need: need }
  } catch (e) {
    return { ok: true, free: 0, need: 0 } // 查询失败不阻塞写入，交给 setStorageSync 兜底
  }
}

// 保存日记前预检：估算「当前列表 + 新日记」序列化后的总字节数，检查剩余空间是否足够
// 返回 { ok, free, need }；ok=false 时调用方应先提示用户、不进入保存流程
function precheckDiarySave(diary) {
  const list = getAllDiaries()
  const estimate = list.slice()
  estimate.unshift(Object.assign({}, diary, {
    id: diary.id || 'precheck',
    created_at: diary.created_at || new Date().toISOString()
  }))
  return checkStorageSpace(estimateUtf8Bytes(estimate))
}

// 安全写入：预检查 + 异常兜底；失败时返回 false，可按需弹窗（silent=true 时不弹，由调用方提示）
function safeSetStorage(key, value, estimatedBytes, silent) {
  const est = estimatedBytes != null ? estimatedBytes : estimateUtf8Bytes(value)
  const check = checkStorageSpace(est)
  if (!check.ok) {
    if (!silent) {
      wx.showModal({ title: '存储空间不足', content: STORAGE_FULL_TIP, showCancel: false, confirmText: '知道了' })
    }
    return false
  }
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    if (!silent) {
      wx.showModal({ title: '保存失败', content: STORAGE_FULL_TIP, showCancel: false, confirmText: '知道了' })
    }
    return false
  }
}

/**
 * 获取所有日记（按时间倒序）
 */
function getAllDiaries() {
  const list = wx.getStorageSync(STORAGE_KEY) || []
  return list.sort((a, b) => {
    return new Date(b.created_at) - new Date(a.created_at)
  })
}

/**
 * 保存日记到本地
 * @param {object} diary - { id, title, content, mood, source, created_at, updated_at }
 */
function saveDiary(diary) {
  const list = getAllDiaries()
  diary.id = diary.id || generateId()
  diary.created_at = diary.created_at || new Date().toISOString()
  diary.updated_at = new Date().toISOString()
  list.unshift(diary)
  if (!safeSetStorage(STORAGE_KEY, list)) return null // 存储已满：已弹窗提示，返回 null
  scheduleCloudBackup()
  return diary
}

/**
 * 更新日记
 */
function updateDiary(id, updates) {
  const list = wx.getStorageSync(STORAGE_KEY) || []
  const index = list.findIndex(d => d.id === id)
  if (index !== -1) {
    list[index] = { ...list[index], ...updates, updated_at: new Date().toISOString() }
    if (!safeSetStorage(STORAGE_KEY, list)) return null // 存储已满：已弹窗提示，返回 null
    scheduleCloudBackup()
    return list[index]
  }
  return null
}

/**
 * 删除日记
 */
function deleteDiary(id) {
  let list = wx.getStorageSync(STORAGE_KEY) || []
  list = list.filter(d => d.id !== id)
  safeSetStorage(STORAGE_KEY, list) // 删除是释放空间，正常不会失败
  scheduleCloudBackup()
}

/**
 * 获取单条日记
 */
function getDiaryById(id) {
  const list = wx.getStorageSync(STORAGE_KEY) || []
  return list.find(d => d.id === id)
}

/**
 * 统计某一天已保存日记中的媒体数量（供「当天图片/视频限额」判断）
 * @param {string} dateKey - 'YYYY-MM-DD'
 * @returns {{images: number, videos: number}}
 */
function countMediaByDate(dateKey) {
  const list = wx.getStorageSync(STORAGE_KEY) || []
  let images = 0
  let videos = 0
  list.forEach(d => {
    if (util.getDateKey(new Date(d.created_at)) !== dateKey) return
    const media = d.media || []
    media.forEach(m => {
      if (m.type === 'video') videos++
      else images++
    })
  })
  return { images: images, videos: videos }
}

/**
 * 获取日记统计
 */
function getStats() {
  const list = getAllDiaries()
  const total = list.length
  const aiCount = list.filter(d => d.source === 'ai').length
  const manualCount = total - aiCount

  // 本月日记数
  const now = new Date()
  const monthCount = list.filter(d => {
    const date = new Date(d.created_at)
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()
  }).length

  // 连续天数
  const streak = calculateStreak(list)

  // 最早和最晚日期
  let firstDate = null
  let lastDate = null
  if (list.length > 0) {
    firstDate = list[list.length - 1].created_at
    lastDate = list[0].created_at
  }

  return { total, aiCount, manualCount, monthCount, streak, firstDate, lastDate }
}

/**
 * 计算连续记录天数
 */
function calculateStreak(list) {
  if (list.length === 0) return 0

  const dateSet = new Set()
  list.forEach(d => {
    const date = new Date(d.created_at)
    dateSet.add(date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate())
  })

  let streak = 0
  const today = new Date()
  for (let i = 0; i < 365; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()
    if (dateSet.has(key)) {
      streak++
    } else if (i > 0) {
      break
    }
  }
  return streak
}

/**
 * 生成唯一ID
 */
function generateId() {
  return 'd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
}

/**
 * 导出所有日记（返回可序列化的数据对象）
 */
function exportDiaries() {
  const list = getAllDiaries()
  return {
    app: 'ai-diary',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: list.length,
    diaries: list
  }
}

/* ===== 纯文本导入导出（日期/内容/心情，用日期分段）=====
   格式示例：
   AI日记 导出备份（共 2 篇）

   ========================================
   【日期】2026-08-14 16:30
   【心情】😊 开心
   【内容】
   今天天气很好，出去散步了。
   ========================================
   【日期】2026-08-13 12:00
   【心情】😌 平静
   【内容】
   昨天加班到很晚。
*/

// 格式化日期时间 — "2026-08-14 16:30"（本地时区）
function formatDateTimeText(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  const pad = n => n.toString().padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 解析日期时间文本 — 支持 "2026-08-14 16:30" / "2026-08-14 16:30:00" / "2026-08-14"（默认中午12点）
function parseDateTimeText(str) {
  const m = str.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2})[:：](\d{2})(?::(\d{2}))?)?$/)
  if (!m) return null
  const dt = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0)
  if (isNaN(dt.getTime())) return null
  return dt
}

// 解析中文日期 — 支持 "2026年8月14日" / "8月14日"（无年份按今年，未来超3个月则推断为去年）
function parseCnDate(str) {
  if (!str) return null
  let m = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const dt = new Date(+m[1], +m[2] - 1, +m[3], 12)
    return isNaN(dt.getTime()) ? null : dt
  }
  m = str.match(/(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const now = new Date()
    let dt = new Date(now.getFullYear(), +m[1] - 1, +m[2], 12)
    // 明显落在未来（超过今天90天）则视为去年
    if (dt.getTime() - now.getTime() > 90 * 86400000) {
      dt = new Date(now.getFullYear() - 1, +m[1] - 1, +m[2], 12)
    }
    return isNaN(dt.getTime()) ? null : dt
  }
  return null
}

// 去除 emoji / 变体选择符，只留纯文字（用于心情反查兼容手写文本）
function stripEmoji(str) {
  return String(str).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim()
}

// 心情文本 → key（先精确匹配 label，再兼容去掉 emoji 的手写文本，如「开心」）
function moodTextToKey(label) {
  const map = util.MOOD_MAP
  for (const k in map) {
    if (map[k].label === label) return k
  }
  const plain = stripEmoji(label)
  for (const k in map) {
    if (stripEmoji(map[k].label) === plain) return k
  }
  return ''
}

// 天气对象 → 可读文本（不含图标）：如「晴 28° · 深圳」
function formatWeatherText(w) {
  if (!w || typeof w !== 'object') return ''
  let s = ''
  if (w.text) s += String(w.text)
  if (w.temp !== undefined && w.temp !== null && w.temp !== '') {
    s += (s ? ' ' : '') + w.temp + '°'
  }
  if (w.city) s += (s ? ' · ' : '') + String(w.city)
  return s
}

// 天气文本 → 对象（导入回填）：支持「☀️ 晴 28° · 深圳」「晴 28°深圳」「多云 22°」等
function parseWeatherText(str) {
  if (!str) return null
  let s = String(str).trim()
  if (!s) return null
  // 图标（开头的 emoji）
  let icon = ''
  const iconM = s.match(/^([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}][\u{FE0F}\u{200D}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]*)\s*/u)
  if (iconM) {
    icon = iconM[1]
    s = s.slice(iconM[0].length).trim()
  }
  const w = {}
  if (icon) w.icon = icon
  // 温度（可带负号）
  const tempM = s.match(/(-?\d+)\s*°/)
  if (tempM) {
    w.temp = parseInt(tempM[1], 10)
    const after = s.slice(tempM.index + tempM[0].length).trim()
    s = s.slice(0, tempM.index).trim()
    // 温度后的剩余为城市（去掉分隔符）
    const city = after.replace(/^[·,\-，、|]\s*/, '').trim()
    if (city) w.city = city
  }
  // 剩余部分：温度前的为天气描述，若温度后还有第二段中文（未识别为城市的场景）合并
  const desc = s.replace(/[·,\-，、|]\s*$/, '').trim()
  if (desc) w.text = desc
  if (!w.text && !w.city && w.temp === undefined) return null
  return w
}

/**
 * 导出所有日记为纯文本（日期/心情/内容，按日期分段）
 * @returns {{count: number, text: string}}
 */
function exportDiariesToText() {
  const list = getAllDiaries()
  const blocks = list.map(d => {
    const lines = ['【日期】' + formatDateTimeText(d.created_at)]
    const moodLabel = util.getMoodLabel(d.mood)
    if (moodLabel) lines.push('【心情】' + moodLabel)
    const weatherText = formatWeatherText(d.weather)
    if (weatherText) lines.push('【天气】' + (d.weather.icon ? d.weather.icon + ' ' : '') + weatherText)
    lines.push('【内容】')
    lines.push(String(d.content || '').trim())
    return lines.join('\n')
  })
  const header = 'AI日记 导出备份（共 ' + list.length + ' 篇）\n'
  const text = header + blocks.join('\n\n========================================\n\n') + '\n'
  return { count: list.length, text: text }
}

/* ===== Word 导入导出（HTML 包装 .doc，Word/WPS 可打开；保留全部内容）=====
   说明：
   - .doc 文件实为 HTML 内容（Word/WPS 打开自动渲染），文件名按日期范围命名
   - 每篇日记一个 <div class="diary">，含日期标题/心情/标签/内容/图片/视频链接/位置
   - 每篇内嵌一个 display:none 的 JSON 数据块（ai-diary-data）：Word 打开不可见、不影响阅读；
     导入时优先解析它可完整还原（含原始 id、时间戳、媒体 fileID、位置坐标、视频时长）
*/

// HTML 实体转义（用于正文内容与隐藏 JSON，防止标签注入）
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// HTML 实体反转义
function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
}

// Word 标题日期 — "8月14日 周五"（跨年文档带年份，避免混淆）
function wordTitleDate(dateObj, withYear) {
  const week = ['日', '一', '二', '三', '四', '五', '六'][dateObj.getDay()]
  return (withYear ? dateObj.getFullYear() + '年' : '') +
    (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日 周' + week
}

/**
 * 根据日记日期范围生成 Word 文件名
 * 例：单篇「7月1日日记.docx」；同年「7月1日-8月30日日记.docx」；跨年「2025年12月30日-2026年1月2日日记.docx」
 * @param {Array} diaries
 * @returns {string}
 */
function buildWordFileName(diaries) {
  const dates = (diaries || []).map(d => new Date(d.created_at)).filter(d => !isNaN(d.getTime()))
  if (!dates.length) return 'AI日记备份.docx'
  dates.sort((a, b) => a - b)
  const first = dates[0]
  const last = dates[dates.length - 1]
  const fmt = (d, withYear) => (withYear ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日'
  const sameDay = first.toDateString() === last.toDateString()
  const sameYear = first.getFullYear() === last.getFullYear()
  let name
  if (sameDay) name = fmt(first, false) + '日记'
  else if (sameYear) name = fmt(first, false) + '-' + fmt(last, false) + '日记'
  else name = fmt(first, true) + '-' + fmt(last, true) + '日记'
  return name + '.docx'
}

/**
 * 构建 Word 文档内容（HTML 包装 .doc）
 * @param {Array} diaries 日记数组（自动升序排列）
 * @param {Object} imgMap { fileID: 图片显示源（base64 data URI 或 https URL） }
 * @param {Object} videoMap { fileID: 视频临时 URL }
 * @returns {string} HTML 文本
 */
function buildWordHtml(diaries, imgMap, videoMap) {
  imgMap = imgMap || {}
  videoMap = videoMap || {}
  const list = (diaries || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const years = new Set(list.map(d => new Date(d.created_at).getFullYear()).filter(y => !isNaN(y)))
  const withYear = years.size > 1
  const blocks = list.map(d => buildWordBlock(d, withYear, imgMap, videoMap)).join('\n')
  const title = buildWordFileName(list).replace(/\.doc$/, '')
  // 微软官方「Word HTML」格式头（Word 另存为网页的标准结构）：
  //   - Office 命名空间 + ProgId 让 WPS/微信预览引擎按 Word 文档解析（而非普通网页）
  //   - <w:View>Web</w:View> Web 版式视图：按窗口宽度自适应排版，手机上无需手动缩小
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
    'xmlns="http://www.w3.org/TR/REC-html40">\n<head>\n' +
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n' +
    '<meta name="ProgId" content="Word.Document">\n' +
    '<meta name="Generator" content="Microsoft Word 15">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<!--[if gte mso 9]><xml>\n<w:WordDocument>\n<w:View>Web</w:View>\n<w:Zoom>100</w:Zoom>\n' +
    '<w:DoNotOptimizeForBrowser/>\n</w:WordDocument>\n</xml><![endif]-->\n' +
    '<style>\n' +
    'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:14px;color:#333;' +
    'margin:16px 12px;line-height:1.8;max-width:100%;word-wrap:break-word;overflow-wrap:break-word}\n' +
    '.doc-title{font-size:22px;color:#1a1a1a;text-align:center;margin:8px 0 4px}\n' +
    '.doc-sub{font-size:12px;color:#999;text-align:center;margin:0 0 24px}\n' +
    '.diary{border-top:2px solid #E5E5E5;padding:16px 0;page-break-inside:avoid}\n' +
    '.diary h2{font-size:17px;color:#07C160;margin:0 0 8px}\n' +
    '.meta{font-size:12px;color:#888;margin:0 0 10px}\n' +
    '.content p{margin:4px 0}\n' +
    '.media{margin:10px 0}\n' +
    '.media img{max-width:100%;width:100%;border-radius:6px;margin:4px 0;display:block}\n' +
    '.video,.location{font-size:13px;color:#555;margin:6px 0;word-break:break-all}\n' +
    '.video a{color:#10AEFF;text-decoration:none}\n' +
    '</style>\n</head>\n<body>\n' +
    '<h1 class="doc-title">AI日记 · 日记备份</h1>\n' +
    '<p class="doc-sub">导出时间：' + escapeHtml(util.formatFullDate(new Date().toISOString())) +
    '　·　共 ' + list.length + ' 篇　·　由 AI日记 小程序导出</p>\n' +
    blocks + '\n</body>\n</html>'
}

// 构建单篇日记块
function buildWordBlock(d, withYear, imgMap, videoMap) {
  const dateObj = new Date(d.created_at)
  const valid = !isNaN(dateObj.getTime())
  const lines = []
  lines.push('<div class="diary" data-id="' + escapeHtml(d.id || '') + '" data-date="' +
    escapeHtml(util.getDateKey(valid ? dateObj : new Date())) + '">')
  lines.push('  <h2>' + (valid ? escapeHtml(wordTitleDate(dateObj, withYear)) : '未标注日期') + '</h2>')
  const metaBits = []
  const moodLabel = util.getMoodLabel(d.mood)
  if (moodLabel) metaBits.push('心情：' + moodLabel)
  const weatherText = formatWeatherText(d.weather)
  if (weatherText) metaBits.push('天气：' + (d.weather.icon ? d.weather.icon + ' ' : '') + weatherText)
  if (d.tags && d.tags.length) metaBits.push('标签：' + d.tags.join('、'))
  if (metaBits.length) lines.push('  <p class="meta">' + escapeHtml(metaBits.join('　|　')) + '</p>')
  // 内容（保留换行）
  const content = String(d.content || '').trim()
  if (content) {
    lines.push('  <div class="content">')
    content.split(/\n+/).forEach(para => {
      const t = para.trim()
      if (t) lines.push('    <p>' + escapeHtml(t) + '</p>')
    })
    lines.push('  </div>')
  }
  // 媒体（图片内嵌显示、视频放链接）
  const media = d.media || []
  const images = media.filter(m => m.type === 'image')
  const videos = media.filter(m => m.type === 'video')
  if (images.length || videos.length) {
    lines.push('  <div class="media">')
    images.forEach(m => {
      const src = imgMap[m.fileID]
      if (src) lines.push('    <img src="' + escapeHtml(src) + '" alt="图片" />')
      else lines.push('    <p class="video">📷 图片：' + escapeHtml(m.fileID || '未命名') + '（无法在文档中显示）</p>')
    })
    videos.forEach(m => {
      const url = videoMap[m.fileID]
      const dur = m.duration ? Math.round(m.duration) + '秒' : '视频'
      if (url) lines.push('    <p class="video">🎬 ' + dur + '：<a href="' + escapeHtml(url) + '">点击查看视频</a></p>')
      else lines.push('    <p class="video">🎬 ' + dur + '：' + escapeHtml(m.fileID || '') + '（Word 不支持内嵌视频，可在小程序中查看）</p>')
    })
    lines.push('  </div>')
  }
  // 位置
  if (d.location && d.location.name) {
    const loc = d.location
    const extra = []
    if (loc.address) extra.push(loc.address)
    if (loc.latitude && loc.longitude) extra.push(loc.latitude + ', ' + loc.longitude)
    const locText = extra.length ? loc.name + '（' + extra.join('，') + '）' : loc.name
    lines.push('  <p class="location">📍 位置：' + escapeHtml(locText) + '</p>')
  }
  // 隐藏 JSON 数据块（导入时完整还原）
  const data = {
    id: d.id, title: d.title, content: d.content, mood: d.mood, source: d.source,
    tags: d.tags || [], location: d.location || null, media: media,
    weather: d.weather || null,
    created_at: d.created_at, updated_at: d.updated_at
  }
  lines.push('  <div class="ai-diary-data" style="display:none">' + escapeHtml(JSON.stringify(data)) + '</div>')
  lines.push('</div>')
  return lines.join('\n')
}

// ============================================================
// 以下：标准 .docx（OOXML）导出/导入
// 微信/WPS/Word 对 HTML 伪装的 .doc 支持差（聊天中打不开），
// 改为生成真正的 .docx（zip 包 + OOXML 部件），全平台可打开
// ============================================================

// docx 段落 XML（o: bold/color(十六进制色)/size(半磅)/center/spacing/before/vanish）
function docxPara(text, o) {
  o = o || {}
  const rPrBits = []
  if (o.bold) rPrBits.push('<w:b/>')
  if (o.color) rPrBits.push('<w:color w:val="' + o.color + '"/>')
  if (o.size) rPrBits.push('<w:sz w:val="' + o.size + '"/><w:szCs w:val="' + o.size + '"/>')
  if (o.vanish) rPrBits.push('<w:vanish/>')
  const rPr = rPrBits.length ? '<w:rPr>' + rPrBits.join('') + '</w:rPr>' : ''
  const pPrBits = []
  if (o.before || o.spacing) {
    pPrBits.push('<w:spacing w:before="' + (o.before || 0) + '" w:line="360" w:lineRule="auto"/>')
  }
  if (o.center) pPrBits.push('<w:jc w:val="center"/>')
  const pPr = pPrBits.length ? '<w:pPr>' + pPrBits.join('') + '</w:pPr>' : ''
  const textXml = (text === '' || text === undefined || text === null)
    ? '' : '<w:r>' + rPr + '<w:t xml:space="preserve">' + escapeHtml(String(text)) + '</w:t></w:r>'
  return '<w:p>' + pPr + textXml + '</w:p>'
}

// docx 内嵌图片段落（按原始宽高等比缩放，宽上限约 12.3cm，竖图高上限约 16.4cm）
function docxImagePara(rid, name, idx, bytes) {
  const size = zipWriter.parseImageSize(bytes) || { w: 4, h: 3 }
  const MAX_W = 4680000
  const MAX_H = 6240000
  let cx = MAX_W
  let cy = Math.round(MAX_W * size.h / (size.w || 4))
  if (cy > MAX_H) { cy = MAX_H; cx = Math.round(MAX_H * (size.w || 4) / size.h) }
  return '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="' + idx + '" name="' + name + '"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + idx + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
}

// docx 隐藏段落（w:vanish 隐藏文字，Word/WPS 不显示；导入时提取 JSON 完整还原）
function docxHiddenPara(jsonStr) {
  return '<w:p><w:pPr><w:rPr><w:vanish/><w:sz w:val="2"/></w:rPr></w:pPr>' +
    '<w:r><w:rPr><w:vanish/><w:sz w:val="2"/></w:rPr>' +
    '<w:t xml:space="preserve">AIDIARY:' + escapeHtml(jsonStr) + '</w:t></w:r></w:p>'
}

/**
 * 生成标准 .docx 文件内容（ArrayBuffer）
 * @param {Array} diaries 日记数组（自动升序）
 * @param {Object} imgBin { fileID: { ext: 'jpg'|'png', b64: 纯base64（无 data: 前缀） } }
 * @param {Object} videoMap { fileID: 视频 https 临时链接 }
 * @returns {ArrayBuffer} docx 文件二进制
 */
function buildDocx(diaries, imgBin, videoMap) {
  imgBin = imgBin || {}
  videoMap = videoMap || {}
  const list = (diaries || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const years = new Set(list.map(d => new Date(d.created_at).getFullYear()).filter(y => !isNaN(y)))
  const withYear = years.size > 1

  // 1) 分配图片 media 文件名 + 关系 id（按文档中出现顺序）
  const imgRid = {}
  const imgOrder = []
  let imgIdx = 0
  list.forEach(d => (d.media || []).forEach(m => {
    if (m && m.type === 'image' && imgBin[m.fileID] && !imgRid[m.fileID]) {
      imgIdx++
      const ext = (imgBin[m.fileID].ext || 'jpg').toLowerCase()
      imgRid[m.fileID] = { rid: 'rIdImg' + imgIdx, name: 'image' + imgIdx + '.' + ext }
      imgOrder.push(m.fileID)
    }
  }))
  // 2) 视频超链接关系 id
  const videoRid = {}
  let vidIdx = 0
  list.forEach(d => (d.media || []).forEach(m => {
    if (m && m.type === 'video' && videoMap[m.fileID] && !videoRid[m.fileID]) {
      vidIdx++
      videoRid[m.fileID] = 'rIdV' + vidIdx
    }
  }))

  // 3) 正文段落
  const paras = []
  paras.push(docxPara('AI日记 · 日记备份', { bold: true, size: '44', center: true, spacing: true }))
  paras.push(docxPara('导出时间：' + util.formatFullDate(new Date().toISOString()) +
    '　·　共 ' + list.length + ' 篇　·　由 AI日记 小程序导出',
    { color: '999999', size: '22', center: true }))

  list.forEach(d => {
    const dateObj = new Date(d.created_at)
    const valid = !isNaN(dateObj.getTime())
    // 日期标题（绿色加粗）+ 顶部分隔间距
    paras.push(docxPara(valid ? wordTitleDate(dateObj, withYear) : '未标注日期',
      { bold: true, size: '34', color: '07C160', before: 360 }))
    // 心情 / 天气 / 标签
    const metaBits = []
    const moodLabel = util.getMoodLabel(d.mood)
    if (moodLabel) metaBits.push('心情：' + moodLabel)
    const weatherText = formatWeatherText(d.weather)
    if (weatherText) metaBits.push('天气：' + (d.weather.icon ? d.weather.icon + ' ' : '') + weatherText)
    if (d.tags && d.tags.length) metaBits.push('标签：' + d.tags.join('、'))
    if (metaBits.length) paras.push(docxPara(metaBits.join('　|　'), { color: '888888', size: '22' }))
    // 正文（按换行分段）
    const content = String(d.content || '').trim()
    if (content) {
      content.split(/\n+/).forEach(p => {
        const t = p.trim()
        if (t) paras.push(docxPara(t, { size: '28', spacing: true }))
      })
    }
    // 图片（二进制内嵌，离线可看）
    ;(d.media || []).forEach(m => {
      if (m && m.type === 'image' && imgRid[m.fileID]) {
        const info = imgRid[m.fileID]
        const bytes = zipWriter.base64ToBytes(imgBin[m.fileID].b64)
        paras.push(docxImagePara(info.rid, info.name, parseInt(info.rid.replace('rIdImg', ''), 10), bytes))
      }
    })
    // 视频（超链接，云存储临时地址有时效）
    ;(d.media || []).forEach(m => {
      if (m && m.type === 'video') {
        const url = videoMap[m.fileID]
        const dur = m.duration ? Math.round(m.duration) + '秒' : '视频'
        const rid = videoRid[m.fileID]
        if (url && rid) {
          paras.push('<w:p><w:r><w:rPr><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>' +
            '<w:t xml:space="preserve">🎬 ' + escapeHtml(dur) + '：</w:t></w:r>' +
            '<w:hyperlink r:id="' + rid + '"><w:r><w:rPr><w:color w:val="0563C1"/>' +
            '<w:u w:val="single"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>' +
            '<w:t xml:space="preserve">点击查看视频</w:t></w:r></w:hyperlink>' +
            '<w:r><w:rPr><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>' +
            '<w:t xml:space="preserve">（链接为临时地址，约 2 小时内有效，长期查看请回小程序）</w:t></w:r></w:p>')
        } else {
          paras.push(docxPara('🎬 ' + dur + '（Word 不支持内嵌视频，请回小程序查看）', { color: '555555', size: '26' }))
        }
      }
    })
    // 位置
    if (d.location && d.location.name) {
      const loc = d.location
      const extra = []
      if (loc.address) extra.push(loc.address)
      if (loc.latitude && loc.longitude) extra.push(loc.latitude + ', ' + loc.longitude)
      const locText = extra.length ? loc.name + '（' + extra.join('，') + '）' : loc.name
      paras.push(docxPara('📍 位置：' + locText, { color: '555555', size: '26' }))
    }
    // 隐藏 JSON（导入完整还原：id/心情/天气/媒体 fileID/位置等）
    const data = {
      id: d.id, title: d.title, content: d.content, mood: d.mood, source: d.source,
      tags: d.tags || [], location: d.location || null, media: d.media || [],
      weather: d.weather || null,
      created_at: d.created_at, updated_at: d.updated_at
    }
    paras.push(docxHiddenPara(JSON.stringify(data)))
  })

  // 4) document.xml
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + paras.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
    'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>'

  // 5) document.xml.rels（图片 + 视频超链接）
  const relBits = []
  imgOrder.forEach(fid => {
    const info = imgRid[fid]
    relBits.push('<Relationship Id="' + info.rid + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
      'Target="media/' + info.name + '"/>')
  })
  Object.keys(videoRid).forEach(fid => {
    relBits.push('<Relationship Id="' + videoRid[fid] + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
      'Target="' + escapeHtml(videoMap[fid]) + '" TargetMode="External"/>')
  })
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    relBits.join('') + '</Relationships>'

  // 6) [Content_Types].xml（按实际用到的图片扩展名注册）
  const exts = new Set(['jpeg', 'jpg', 'png'])
  imgOrder.forEach(fid => exts.add((imgBin[fid].ext || 'jpg').toLowerCase()))
  const ctBits = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>'
  ]
  exts.forEach(e => ctBits.push('<Default Extension="' + e + '" ContentType="image/' + (e === 'jpg' ? 'jpeg' : e) + '"/>'))
  ctBits.push('<Override PartName="/word/document.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>')
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + ctBits.join('') + '</Types>'

  // 7) 根关系
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="word/document.xml"/></Relationships>'

  // 8) 组装 zip
  const files = [
    { name: '[Content_Types].xml', data: zipWriter.strToBytes(contentTypes) },
    { name: '_rels/.rels', data: zipWriter.strToBytes(rootRels) },
    { name: 'word/document.xml', data: zipWriter.strToBytes(docXml) },
    { name: 'word/_rels/document.xml.rels', data: zipWriter.strToBytes(docRels) }
  ]
  imgOrder.forEach(fid => {
    const info = imgRid[fid]
    files.push({
      name: 'word/media/' + info.name,
      data: zipWriter.base64ToBytes(imgBin[fid].b64)
    })
  })
  return zipWriter.buildZip(files)
}

/**
 * 解析 .docx 的 word/document.xml 为日记数组
 * @param {string} xml document.xml 文本
 * @returns {{diaries: Array, full: boolean, notes: Array}}
 */
function parseDocxXml(xml) {
  if (!xml || typeof xml !== 'string') return { diaries: [], full: false, notes: [] }
  // 1) 提取段落
  const paras = []
  const reP = /<w:p\b[\s\S]*?<\/w:p>/g
  let m
  while ((m = reP.exec(xml)) !== null) paras.push(m[0])
  // 段落文本
  const paraText = (pXml) => {
    let t = ''
    const reT = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let mm
    while ((mm = reT.exec(pXml)) !== null) t += decodeHtmlEntities(mm[1])
    return t
  }
  // 2) 优先：隐藏段（vanish + AIDIARY: 前缀）完整还原
  const diaries = []
  paras.forEach(pXml => {
    if (pXml.indexOf('<w:vanish') === -1) return
    const t = paraText(pXml)
    if (t.indexOf('AIDIARY:') !== 0) return
    try {
      const obj = JSON.parse(t.slice(8))
      if (obj && obj.content) {
        diaries.push({
          id: obj.id || generateId(),
          title: obj.title || '',
          content: obj.content,
          mood: obj.mood || '',
          source: obj.source || 'manual',
          tags: Array.isArray(obj.tags) ? obj.tags : [],
          location: obj.location || null,
          media: Array.isArray(obj.media) ? obj.media : [],
          weather: (obj.weather && typeof obj.weather === 'object') ? obj.weather : null,
          created_at: obj.created_at || new Date().toISOString(),
          updated_at: obj.updated_at || ''
        })
      }
    } catch (e) { /* 单段损坏跳过 */ }
  })
  if (diaries.length) return { diaries: diaries, full: true, notes: [] }

  // 3) 回退：解析可视段落（文件可能被 Word/WPS 编辑过）
  const notes = []
  const reTitle = /((?:\d{4}年)?\d{1,2}月\d{1,2}日(?:\s*周[日一二三四五六])?)/
  let cur = null
  const fallback = []
  paras.forEach(pXml => {
    if (pXml.indexOf('<w:vanish') !== -1) return
    const t = paraText(pXml).trim()
    if (!t) return
    const titleMatch = t.match(reTitle)
    const isTitle = titleMatch && t.length <= 20 && titleMatch[1].length >= 5
    if (isTitle) {
      if (cur) fallback.push(cur)
      const ts = parseCnDate(titleMatch[1])
      cur = {
        id: generateId(),
        content: '',
        mood: '',
        tags: [],
        location: null,
        media: [],
        weather: null,
        created_at: ts ? ts.toISOString() : new Date().toISOString(),
        title: ''
      }
      return
    }
    if (!cur) return
    // meta 行（心情/天气/标签，可能合并在一行用 | 分隔，也可能各自独立成行）
    const metaHandled = (() => {
      const segs = t.split(/\s*[|｜]\s*/)
      let handled = false
      segs.forEach(seg => {
        const s = seg.trim()
        if (!s) return
        const moodM = s.match(/^心情[：:]\s*(\S+)$/)
        if (moodM) {
          const key = moodTextToKey(moodM[1])
          if (key) cur.mood = key
          handled = true
          return
        }
        const weatherM = s.match(/^天气[：:]\s*(.+)$/)
        if (weatherM) {
          const w = parseWeatherText(weatherM[1])
          if (w) cur.weather = w
          handled = true
          return
        }
        const tagM = s.match(/^标签[：:]\s*(.+)$/)
        if (tagM) {
          cur.tags = tagM[1].split(/[、,，\s]+/).filter(Boolean)
          handled = true
        }
      })
      return handled
    })()
    if (metaHandled) return
    // 位置行
    if (t.indexOf('📍') !== -1 || t.indexOf('位置：') !== -1) {
      const nameM = t.replace(/^[^：:]*[：:]\s*/, '').match(/^([^（(]+)/)
      const addrM = t.match(/[（(]([^）)]+)[）)]/)
      const loc = { name: nameM ? nameM[1].trim() : t }
      if (addrM) loc.address = addrM[1]
      cur.location = loc
      return
    }
    // 视频行（超链接已在段落文本中合并，只保留提示）
    if (t.indexOf('🎬') !== -1) return
    // 标签行
    const tagM = t.match(/标签[：:]\s*(.+)$/)
    if (tagM) {
      cur.tags = tagM[1].split(/[、,，\s]+/).filter(Boolean)
      return
    }
    // 头部副标题行跳过
    if (t.indexOf('AI日记 · 日记备份') !== -1 || t.indexOf('导出时间：') !== -1) return
    // 正文
    cur.content = cur.content ? cur.content + '\n' + t : t
  })
  if (cur) fallback.push(cur)
  const valid = fallback.filter(d => d.content)
  if (valid.length) {
    notes.push('文档中没有找到完整备份数据（可能被编辑过），已按可见文本还原；图片与视频未能自动还原。')
    return { diaries: valid, full: false, notes: notes }
  }
  return { diaries: [], full: false, notes: [] }
}

// HTML 内容 → 纯文本（<br>/<p> 变换行，剥离其余标签并解码实体）
function htmlContentToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 解析位置文本 — "name（address，lat, lng）" / "name（address）" / "name"
function parseLocationText(txt) {
  const loc = { name: '', address: '', latitude: 0, longitude: 0 }
  const m = String(txt).match(/^(.+?)(?:（(.+)）)?$/)
  if (!m || !(m[1] || '').trim()) return null
  loc.name = m[1].trim()
  const inner = m[2] || ''
  const coord = inner.match(/(\d+\.?\d*)\s*,\s*(\d+\.?\d*)/)
  if (coord) {
    loc.latitude = parseFloat(coord[1])
    loc.longitude = parseFloat(coord[2])
    loc.address = inner.replace(coord[0], '').replace(/[，,]\s*$/, '').trim()
  } else {
    loc.address = inner.trim()
  }
  return loc.name ? loc : null
}

/**
 * 解析 Word（.doc HTML）为日记数组
 * @param {string} text
 * @returns {{diaries: Array, full: boolean, notes: Array}}
 *   full=true 表示解析到隐藏 JSON（完整还原，含视频 fileID）；否则为可视结构回退（图片 base64、视频丢失）
 */
function parseWordHtml(text) {
  if (!text || typeof text !== 'string') return { diaries: [], full: false, notes: [] }
  // 1) 优先：隐藏 JSON 数据块（完整还原）
  const diaries = []
  const reData = /<div[^>]*class="[^"]*ai-diary-data[^"]*"[^>]*>([\s\S]*?)<\/div>/g
  let m
  while ((m = reData.exec(text)) !== null) {
    const jsonStr = decodeHtmlEntities(m[1].trim())
    try {
      const obj = JSON.parse(jsonStr)
      if (obj && obj.content) {
        diaries.push({
          id: obj.id || generateId(),
          title: obj.title || '',
          content: obj.content,
          mood: obj.mood || '',
          source: obj.source || 'manual',
          tags: Array.isArray(obj.tags) ? obj.tags : [],
          location: obj.location || null,
          media: Array.isArray(obj.media) ? obj.media : [],
          weather: (obj.weather && typeof obj.weather === 'object') ? obj.weather : null,
          created_at: obj.created_at || new Date().toISOString(),
          updated_at: obj.updated_at || ''
        })
      }
    } catch (e) {
      // 单块 JSON 损坏则跳过（整体走回退解析）
    }
  }
  if (diaries.length) return { diaries: diaries, full: true, notes: [] }

  // 2) 回退：解析可视结构（文件可能被 Word 编辑过）
  const notes = []
  const reBlock = /<div([^>]*class="[^"]*\bdiary\b[^"]*"[^>]*)>([\s\S]*?)(?=<div[^>]*class="[^"]*\bdiary\b[^"]*"[^>]*>|<\/body>|<\/html>|$)/g
  let mm
  let videoLost = 0
  while ((mm = reBlock.exec(text)) !== null) {
    const attrs = mm[1]
    const body = mm[2]
    const d = parseVisibleBlock(attrs, body)
    if (!d) continue
    videoLost += (d.media || []).filter(x => x && x.type === 'video').length
    diaries.push(d)
  }
  if (diaries.length) {
    if (videoLost > 0) notes.push('Word 不支持内嵌视频，' + videoLost + ' 个视频未能从文档还原（可在原小程序中查看）。')
    return { diaries: diaries, full: false, notes: notes }
  }
  return { diaries: [], full: false, notes: [] }
}

// 回退解析：从可见 HTML 块中提取日记
function parseVisibleBlock(attrs, body) {
  const d = { id: generateId(), content: '', mood: '', tags: [], location: null, media: [], weather: null, created_at: '', title: '' }
  const idM = attrs.match(/data-id="([^"]*)"/)
  if (idM) d.id = idM[1]
  const dm = attrs.match(/data-date="([^"]*)"/)
  const h2 = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
  let dateStr = dm ? dm[1] : ''
  if (!dateStr && h2) {
    const t = parseCnDate(decodeHtmlEntities(h2[1]))
    if (t) dateStr = util.getDateKey(t)
  }
  if (dateStr) {
    const t = parseDateTimeText(dateStr) || parseCnDate(dateStr)
    d.created_at = (t ? t : new Date()).toISOString()
  }
  // 心情 / 标签
  const meta = body.match(/<p[^>]*class="[^"]*meta[^"]*"[^>]*>([\s\S]*?)<\/p>/)
  if (meta) {
    const metaTxt = decodeHtmlEntities(meta[1])
    const moodM = metaTxt.match(/心情：([^　|]+)/)
    if (moodM) {
      const key = moodTextToKey(moodM[1].trim())
      if (key) d.mood = key
    }
    const tagM = metaTxt.match(/标签：([^　|]+)/)
    if (tagM) {
      d.tags = tagM[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 5)
    }
    const weatherM = metaTxt.match(/天气：([^　|]+)/)
    if (weatherM) {
      const w = parseWeatherText(weatherM[1])
      if (w) d.weather = w
    }
  }
  // 内容
  const cm = body.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  if (cm) d.content = htmlContentToText(cm[1])
  if (!d.content) return null
  // 图片（base64 data URI）
  const imgRe = /<img[^>]*src="data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)"[^>]*>/g
  let im
  while ((im = imgRe.exec(body)) !== null) {
    d.media.push({ type: 'image', _data: im[2], _mime: im[1] })
  }
  // 视频（无法还原，标记计数）
  const vRe = /<p[^>]*class="[^"]*video[^"]*"[^>]*>/g
  while (vRe.test(body)) {
    d.media.push({ type: 'video', _lost: true })
  }
  // 位置
  const locM = body.match(/<p[^>]*class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/p>/)
  if (locM) {
    const txt = decodeHtmlEntities(locM[1]).replace(/^📍\s*位置：/, '').trim()
    if (txt) d.location = parseLocationText(txt)
  }
  if (!d.created_at) d.created_at = new Date().toISOString()
  if (!d.title) d.title = util.getDefaultTitle(util.getDateKey(new Date(d.created_at)))
  return d
}

/**
 * 解析纯文本为日记数组（id 新建，created_at 从【日期】解析，标题自动生成）
 * @param {string} text
 * @returns {Array}
 */
function parseDiariesFromText(text) {
  if (!text || typeof text !== 'string') return []
  const blocks = text.split(TEXT_SPLIT)
  const diaries = []
  blocks.forEach(block => {
    const lines = block.split('\n')
    let dateStr = ''
    let moodStr = ''
    let weatherStr = ''
    let contentIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.indexOf('【日期】') === 0) {
        dateStr = line.substring(4).trim()
      } else if (line.indexOf('【心情】') === 0) {
        moodStr = line.substring(4).trim()
      } else if (line.indexOf('【天气】') === 0) {
        weatherStr = line.substring(4).trim()
      } else if (line.indexOf('【内容】') === 0) {
        contentIdx = i
        break
      }
    }
    if (contentIdx === -1) return
    const content = lines.slice(contentIdx + 1).join('\n').trim()
    if (!content) return

    const diary = { id: generateId(), content: content }
    if (dateStr) {
      const t = parseDateTimeText(dateStr)
      if (t) diary.created_at = t.toISOString()
    }
    if (!diary.created_at) diary.created_at = new Date().toISOString()
    const moodKey = moodTextToKey(moodStr)
    if (moodKey) diary.mood = moodKey
    const weather = parseWeatherText(weatherStr)
    if (weather) diary.weather = weather
    diary.title = util.getDefaultTitle(util.getDateKey(new Date(diary.created_at)))
    diaries.push(diary)
  })
  return diaries
}

/**
 * 从纯文本导入日记（按「日期+内容」去重合并，或全部替换）
 * @param {string} text
 * @param {boolean} replace - true 覆盖现有全部日记
 * @returns {{added: number, total: number}}
 */
function importDiariesFromText(text, replace) {
  const parsed = parseDiariesFromText(text)
  if (!parsed.length) return { added: 0, total: 0 }
  if (replace) {
    if (!safeSetStorage(STORAGE_KEY, parsed, null, true)) return { added: -1, total: 0 } // 存储已满
    return { added: parsed.length, total: parsed.length }
  }
  const list = wx.getStorageSync(STORAGE_KEY) || []
  const keyOf = d => util.getDateKey(new Date(d.created_at)) + '|' + String(d.content || '').trim()
  const existing = new Set(list.map(keyOf))
  let added = 0
  parsed.forEach(d => {
    const key = keyOf(d)
    if (existing.has(key)) return
    list.push(d)
    existing.add(key)
    added++
  })
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  if (!safeSetStorage(STORAGE_KEY, list, null, true)) return { added: -1, total: list.length } // 存储已满
  return { added: added, total: list.length }
}

/**
 * 导入日记（按 id 去重，返回新增条数）
 * @param {Array} importList - 日记数组
 */
function importDiaries(importList) {
  if (!Array.isArray(importList)) return 0
  const list = wx.getStorageSync(STORAGE_KEY) || []
  const existingIds = new Set(list.map(d => d.id))
  let added = 0
  importList.forEach(d => {
    if (!d || !d.content) return
    const diary = { ...d }
    if (!diary.id) diary.id = generateId()
    if (!diary.created_at) diary.created_at = new Date().toISOString()
    if (existingIds.has(diary.id)) return
    list.push(diary)
    existingIds.add(diary.id)
    added++
  })
  // 按时间倒序
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  if (!safeSetStorage(STORAGE_KEY, list, null, true)) return -1 // 存储已满
  scheduleCloudBackup()
  return added
}

/**
 * 把 AI 识别的结果项转成日记对象
 * @param {{date?: string, mood?: string, content?: string}} item - AI 返回的一项
 * @returns {{id, title, content, mood?, created_at}} 缺省字段自动补全（日期缺省用今天中午）
 */
function buildDiaryFromAI(item) {
  const content = String((item && item.content) || '').trim()
  const diary = { id: generateId(), content: content }
  // 日期优先级：标准 YYYY-MM-DD → 中文日期 → 今天（统一记当天中午，避免时区偏移）
  const dateStr = String((item && item.date) || '').trim()
  const t = (dateStr && (parseDateTimeText(dateStr) || parseCnDate(dateStr))) || new Date()
  const noon = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0, 0)
  diary.created_at = noon.toISOString()
  const moodKey = moodTextToKey(String((item && item.mood) || ''))
  if (moodKey) diary.mood = moodKey
  // AI 识别结果若含天气描述（如「晴 28°」），一并还原
  const weather = parseWeatherText(String((item && item.weather) || ''))
  if (weather) diary.weather = weather
  diary.title = util.getDefaultTitle(util.getDateKey(noon))
  return diary
}

/**
 * 从日记对象数组导入（按「日期+内容」去重合并，或全部替换）— 供 AI 识别结果等场景使用
 * @param {Array} list - 日记对象数组（需含 content，建议含 created_at）
 * @param {boolean} replace - true 覆盖现有全部日记
 * @returns {{added: number, total: number}}
 */
function importDiaryObjects(list, replace) {
  const items = Array.isArray(list) ? list : []
  if (!items.length) return { added: 0, total: 0 }
  if (replace) {
    if (!safeSetStorage(STORAGE_KEY, items, null, true)) return { added: -1, total: 0 } // 存储已满
    scheduleCloudBackup()
    return { added: items.length, total: items.length }
  }
  const existingList = wx.getStorageSync(STORAGE_KEY) || []
  const keyOf = d => util.getDateKey(new Date(d.created_at)) + '|' + String(d.content || '').trim()
  const existing = new Set(existingList.map(keyOf))
  let added = 0
  items.forEach(d => {
    const key = keyOf(d)
    if (existing.has(key)) return
    existingList.push(d)
    existing.add(key)
    added++
  })
  existingList.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  if (!safeSetStorage(STORAGE_KEY, existingList, null, true)) return { added: -1, total: existingList.length } // 存储已满
  scheduleCloudBackup()
  return { added: added, total: existingList.length }
}

/**
 * 替换所有日记（恢复备份用），返回条数
 */
function replaceAllDiaries(importList) {
  if (!Array.isArray(importList)) return 0
  if (!safeSetStorage(STORAGE_KEY, importList, null, true)) return -1 // 存储已满
  scheduleCloudBackup()
  return importList.length
}

/**
 * 清空所有日记（「我的」页清除全部；同时触发云端同步）
 */
function clearAllDiaries() {
  safeSetStorage(STORAGE_KEY, [])
  scheduleCloudBackup()
}

/* ===== 档案：存储人物/机构等备注信息 ===== */

const ARCHIVE_KEY = 'archives'

/**
 * 获取所有档案（按更新时间倒序）
 */
function getArchives() {
  const list = wx.getStorageSync(ARCHIVE_KEY) || []
  return list.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
}

/**
 * 合并档案描述（追加语义，绝不覆盖旧信息）：
 * 已存在名词再次录入新说明时，把新说明追加到已有描述末尾：
 *  - 旧描述末尾已有逗号/句号等标点 → 直接追加；
 *  - 末尾无逗号/句号 → 先补一个中文逗号再追加；
 *  - 新说明若已存在于旧描述中 → 返回 null（不重复追加）。
 * 与手写输入添加共用 archiveEdit.appendArchiveDescription，保证语音/手写逻辑一致。
 * @param {string} oldDesc 已有描述（可空）
 * @param {string} addDesc 新录入的说明（可空）
 * @returns {string|null} 追加后的描述；无需追加返回 null
 */
function mergeArchiveDescription(oldDesc, addDesc) {
  return archiveEdit.appendArchiveDescription(oldDesc, addDesc)
}

/**
 * 批量保存档案（按 name 去重；已存在 → 描述按逗号条目追加合并，不覆盖旧信息）
 */
function saveArchives(items) {
  if (!Array.isArray(items) || !items.length) return { added: 0, updated: 0 }
  const list = wx.getStorageSync(ARCHIVE_KEY) || []
  const nameMap = {}
  list.forEach(a => { nameMap[a.name] = a })
  let added = 0
  let updated = 0
  items.forEach(item => {
    const name = String(item.name || '').trim()
    const desc = String(item.description || '').trim()
    if (!name) return
    if (nameMap[name]) {
      const oldDesc = String(nameMap[name].description || '').trim()
      const merged = mergeArchiveDescription(oldDesc, desc)
      if (merged !== null && merged !== oldDesc) {
        nameMap[name].description = merged
        nameMap[name].updated_at = new Date().toISOString()
        updated++
      }
    } else {
      const entry = {
        id: 'a_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        description: desc,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      list.push(entry)
      nameMap[name] = entry
      added++
    }
  })
  if (!safeSetStorage(ARCHIVE_KEY, list)) return { added: 0, updated: 0 } // 存储已满：已弹窗提示
  scheduleCloudBackup()
  return { added, updated }
}

/**
 * 更新单条档案（按 id 定位，刷新 updated_at）
 * @param {string} id
 * @param {{name?:string, description?:string}} updates
 * @returns {object|null} 更新后的档案，未找到返回 null
 */
function updateArchive(id, updates) {
  const list = wx.getStorageSync(ARCHIVE_KEY) || []
  const index = list.findIndex(a => a.id === id)
  if (index === -1) return null
  list[index] = { ...list[index], ...updates, updated_at: new Date().toISOString() }
  if (!safeSetStorage(ARCHIVE_KEY, list)) return null // 存储已满：已弹窗提示
  return list[index]
}

/**
 * 整体替换档案列表（供智能修改等批量场景使用）
 * @param {Array} list
 */
function replaceArchives(list) {
  safeSetStorage(ARCHIVE_KEY, Array.isArray(list) ? list : []) // 失败已弹窗提示
  scheduleCloudBackup()
}

/**
 * 删除档案
 */
function deleteArchive(id) {
  let list = wx.getStorageSync(ARCHIVE_KEY) || []
  list = list.filter(a => a.id !== id)
  safeSetStorage(ARCHIVE_KEY, list) // 删除是释放空间，正常不会失败
  scheduleCloudBackup()
}

/* ===== 云端加密备份：数据变动后防抖自动同步（未开启时零开销）===== */
let _backupTimer = null
function scheduleCloudBackup() {
  try {
    const backup = require('./backup.js')
    if (!backup.isEnabled()) return
    if (_backupTimer) clearTimeout(_backupTimer)
    _backupTimer = setTimeout(() => {
      _backupTimer = null
      backup.sync().catch(() => {})
    }, 5000)
  } catch (e) { /* 备份模块异常不影响主流程 */ }
}

module.exports = {
  getAllDiaries,
  saveDiary,
  updateDiary,
  deleteDiary,
  clearAllDiaries,
  precheckDiarySave,
  getDiaryById,
  getStats,
  countMediaByDate,
  exportDiaries,
  importDiaries,
  replaceAllDiaries,
  exportDiariesToText,
  parseDiariesFromText,
  importDiariesFromText,
  buildWordFileName,
  buildWordHtml,
  parseWordHtml,
  buildDocx,
  parseDocxXml,
  buildDiaryFromAI,
  importDiaryObjects,
  moodTextToKey,
  formatWeatherText,
  parseWeatherText,
  getArchives,
  saveArchives,
  updateArchive,
  replaceArchives,
  deleteArchive
}
