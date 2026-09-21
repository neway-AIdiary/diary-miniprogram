/**
 * 本地存储工具 — 日记数据本地持久化，无需后端也能正常使用
 */

const util = require('./util.js')
const zipWriter = require('./zipWriter.js')
// 档案描述追加规则与手写输入添加共用（archiveEdit.appendArchiveDescription），
// 保证「语音添加」与「手写输入添加」对已存在名词的描述追加结果完全一致
const archiveEdit = require('./archiveEdit.js')
// 「日记字体」设置：导出 Word 正文按当前字号档位换算（用户选择导出跟随）
const fontSetting = require('./fontSetting.js')
// [brand-rename v1] 导出物品牌名统一走唯一来源。
// 注意：导入判据仍需兼容旧字面量「AI日记 · 日记备份」，见 parseDocxXml 回退段。
const appInfo = require('./appInfo.js')

const STORAGE_KEY = 'diaries'
// 文本导出/导入的分隔线（整行 >=10 个 = 视为分段标记）
const TEXT_SPLIT = /^={10,}\s*$/m

/* ===== 本地存储容量保护 =====
 * 微信单 key 上限 1MB、总量上限 10MB，写满时 setStorageSync 直接抛异常。
 * 这里统一做「写入前预检查 + 写入异常兜底」，失败时提示用户先导出备份，
 * 而不是静默失败或让用户误以为保存成功。
 */
const STORAGE_FULL_TIP = '本地存储已满，请先备份再删除日记腾出空间'
const STORAGE_SAFE_MARGIN = 200 * 1024 // 预留 200KB 安全余量，避免贴着上限写入

/* ===== 分片存储 [shard-storage v1] =====
 * 日记按创建年份分格存储（diaries_2024 / diaries_2025 / ...），每格各享 1MB 上限，
 * 突破旧「diaries 单格 1MB」瓶颈（约 800~1000 篇纯文字即满）。
 * 旧格 'diaries' 迁移「校验后自动清理」[legacy-clean v1]：复制进年份分片后，
 * 旧格每篇（有 id）都能在分片中按 id 找到才删旧格；有无法验证的条目（无 id）
 * 或任何异常都保留旧格。读取按 id 去重、取 updated_at 较新者，旧格在否都可见。
 * 约定：
 *  - 新写入一律进年份分片；编辑日期跨年时从旧分格挪到新分格；
 *  - 删除在所有格（含旧格）中同步移除；
 *  - 「替换全部 / 清空」语义覆盖旧格（restore / 覆盖导入 / 清除所有日记）。
 */
const SHARD_PREFIX = 'diaries_'
const RE_SHARD_KEY = /^diaries_(\d{4})$/
const SHARD_LIMIT = 900 * 1024 // 单格软上限（1MB 硬限内留余量），超过即拦截并提示
const BACKUP_SYNCED_KEY = 'backup_synced_count' // 最近一次成功云备份时的日记总篇数 [backup-remind v1]
const BACKUP_ALERT_KEY = 'backup_alert_level'   // 已提醒过的档位（30 篇一档）[backup-remind v1]
const BACKUP_REMIND_STEP = 30

// 日记 → 年份分格 key（created_at 无效/缺省归入今年格）
function shardKeyFor(diary) {
  let t = null
  try { t = new Date(diary && diary.created_at) } catch (e) { t = null }
  let y = (t && !isNaN(t.getTime())) ? t.getFullYear() : new Date().getFullYear()
  if (!(y >= 2000 && y <= 2999)) y = new Date().getFullYear()
  return SHARD_PREFIX + y
}

// 日记所属年份（shardKeyFor 的数值口径，供提示文案使用）[shard-full v1]
function shardYearFor(diary) {
  return parseInt(shardKeyFor(diary).slice(SHARD_PREFIX.length), 10)
}

// 现存年份分格 key 列表：优先 getStorageInfoSync().keys，缺失时逐 年扫描（桩环境兼容）
function listShardKeys() {
  const found = []
  try {
    const info = wx.getStorageInfoSync()
    if (info && Array.isArray(info.keys) && info.keys.length) {
      info.keys.forEach((k) => { if (RE_SHARD_KEY.test(k)) found.push(k) })
      found.sort()
      return found
    }
  } catch (e) { /* 走扫描兜底 */ }
  // 上界放到 2999：与 shardKeyFor 的年份口径（2000~2999）一致，
  // 未来年份的日记在 getStorageInfoSync 不可用（走本兜底）时也不能漏读
  for (let y = 2000; y <= 2999; y++) {
    const k = SHARD_PREFIX + y
    try { if (wx.getStorageSync(k)) found.push(k) } catch (e) {}
  }
  found.sort()
  return found
}

// 读一个格（缺省/异常返回空数组）
function readShard(key) {
  try {
    const v = wx.getStorageSync(key)
    return Array.isArray(v) ? v : []
  } catch (e) { return [] }
}

// 全部日记格 key：年份分片 + 迁移保留的旧格（有数据才纳入）
function allDiaryKeys() {
  const keys = listShardKeys()
  try {
    const legacy = wx.getStorageSync(STORAGE_KEY)
    if (Array.isArray(legacy) && legacy.length) keys.push(STORAGE_KEY)
  } catch (e) { /* 旧格读取失败忽略 */ }
  return keys
}

// 全部日记并集（分片 + 旧格），按 id 去重取 updated_at 较新者；未排序
function readAllDiariesRaw() {
  ensureMigrated()
  const byId = new Map()
  const noId = []
  allDiaryKeys().forEach((k) => {
    readShard(k).forEach((d) => {
      if (!d || typeof d !== 'object') return
      if (d.id != null && d.id !== '') {
        const prev = byId.get(d.id)
        if (!prev || new Date(d.updated_at || 0).getTime() > new Date(prev.updated_at || 0).getTime()) {
          byId.set(d.id, d)
        }
      } else {
        noId.push(d)
      }
    })
  })
  return Array.from(byId.values()).concat(noId)
}

// [legacy-clean v1] 旧格迁移完整性校验：旧格每篇（须有 id）都能在年份分片中按 id 找到。
// 只扫分片 keys —— readAllDiariesRaw 含旧格并集，拿它校验恒真
function legacyFullyMigrated(legacy) {
  const ids = new Set()
  listShardKeys().forEach((k) => {
    readShard(k).forEach((d) => {
      if (d && d.id != null && d.id !== '') ids.add(d.id)
    })
  })
  return legacy.every((d) => d && d.id != null && d.id !== '' && ids.has(d.id))
}

// 旧格一次性迁移：按年份并入分格，id 去重兼容中断重跑；
// 复制完成后校验 [legacy-clean v1]，通过才清旧格；
// 任何一步失败/不一致都不动旧格 —— 读路径走并集，旧数据始终可见
let _shardMigrated = false
function ensureMigrated() {
  if (_shardMigrated) return
  _shardMigrated = true
  try {
    const legacy = wx.getStorageSync(STORAGE_KEY)
    if (!Array.isArray(legacy) || !legacy.length) return
    const byYear = {}
    legacy.forEach((d) => {
      // [legacy-clean v1] 无 id 条目不复制（无法校验）：留在旧格，由读并集兜底
      if (!d || d.id == null || d.id === '') return
      const k = shardKeyFor(d)
      ;(byYear[k] = byYear[k] || []).push(d)
    })
    Object.keys(byYear).forEach((k) => {
      const existing = readShard(k)
      const ids = new Set(existing.map((d) => d.id))
      const add = byYear[k].filter((d) => !ids.has(d.id))
      if (add.length) safeSetStorage(k, existing.concat(add), null, true)
    })
    // [legacy-clean v1] 校验后自动清理：逐篇 id 全对上才删旧格；差一篇都保留
    if (legacyFullyMigrated(legacy)) {
      try { wx.removeStorageSync(STORAGE_KEY) } catch (e) {}
    }
  } catch (e) { /* 迁移异常不影响旧数据读取 */ }
}

// 「本地存储已满」统一弹窗：带「去导出备份」直达按钮 [shard-storage v1]
function showStorageFullModal() {
  wx.showModal({
    title: '本地存储已满',
    content: '本地存储已满，请先备份再删除日记腾出空间',
    confirmText: '去导出备份',
    cancelText: '知道了',
    success: (res) => {
      if (res.confirm) {
        try { wx.navigateTo({ url: '/pages/backup/backup' }) } catch (e) {}
      }
    }
  })
}

// 整体替换为分片存储（restore / 覆盖导入 / 清空）[shard-storage v1]
// 先整组预检（每格不超 SHARD_LIMIT、总量有空间）再写入；成功后清掉未用分格与旧格
function replaceAllSharded(items) {
  const groups = {}
  ;(items || []).forEach((d) => {
    const sk = shardKeyFor(d)
    ;(groups[sk] = groups[sk] || []).push(d)
  })
  for (const sk in groups) {
    if (estimateUtf8Bytes(groups[sk]) > SHARD_LIMIT) return false // 该年份分格放不下
  }
  // [net-release v1] 整体替换按「新旧总占用」比较：清空 / 用更小的备份覆盖时不受余量闸限制
  const nextBytes = estimateUtf8Bytes(items || [])
  const prevBytes = allDiaryKeys().reduce((s, k) => s + readStorageBytes(k), 0)
  if (!isNetRelease(prevBytes, nextBytes)) {
    const space = checkStorageSpace(nextBytes)
    if (!space.ok) return false // 存储已满
  }
  for (const sk in groups) {
    if (!safeSetStorage(sk, groups[sk], null, true, SHARD_LIMIT)) return false
  }
  const keep = new Set(Object.keys(groups))
  listShardKeys().forEach((k) => {
    if (!keep.has(k)) {
      try { wx.removeStorageSync(k) } catch (e) {}
    }
  })
  try { wx.removeStorageSync(STORAGE_KEY) } catch (e) {}
  return true
}

// 分格合并导入（去重键由调用方给）[shard-storage v1]
// 先整组预检（每格不超 SHARD_LIMIT、总量有空间），再逐格写入；失败时如实回报已写入数
function mergeIntoShards(items, keyOf) {
  const existingList = readAllDiariesRaw()
  const existing = new Set(existingList.map(keyOf))
  const addedItems = []
  items.forEach((d) => {
    const k = keyOf(d)
    if (existing.has(k)) return
    existing.add(k)
    addedItems.push(d)
  })
  // [import-dedup v1] skipped = 本批被判为重复而跳过的篇数（供导入结果如实上报）
  const skipped = items.length - addedItems.length
  if (!addedItems.length) return { added: 0, total: existingList.length, skipped: skipped }
  const groups = {} // shardKey -> 合并后的完整格内容
  const counts = {} // shardKey -> 该格新增条数
  addedItems.forEach((d) => {
    const sk = shardKeyFor(d)
    if (!groups[sk]) {
      groups[sk] = readShard(sk).slice()
      counts[sk] = 0
    }
    groups[sk].push(d)
    counts[sk]++
  })
  for (const sk in groups) {
    if (estimateUtf8Bytes(groups[sk]) > SHARD_LIMIT) {
      return { added: -1, total: existingList.length } // 该年份分格放不下
    }
  }
  if (!checkStorageSpace(estimateUtf8Bytes(addedItems)).ok) {
    return { added: -1, total: existingList.length } // 存储已满
  }
  let added = 0
  let total = existingList.length
  for (const sk in groups) {
    if (!safeSetStorage(sk, groups[sk], null, true, SHARD_LIMIT)) {
      // 中途失败：已写入的格各自完整（旧+新），如实回报已写入数
      return { added: added > 0 ? added : -1, total: total }
    }
    added += counts[sk]
    total += counts[sk]
  }
  return { added: added, total: total, skipped: skipped }
}

// 未备份定期提醒 [backup-remind v1]：未开启云备份且未备份篇数每满 30 提醒一次（30/60/90...）
// 每个档位只弹一次；「一键开启云备份」跳备份页（开启需输密码，页面承接）
function remindBackupIfNeeded() {
  try {
    const backup = require('./backup.js')
    if (typeof backup.isEnabled !== 'function' || backup.isEnabled()) return
    const total = readAllDiariesRaw().length
    let synced = 0
    try { synced = wx.getStorageSync(BACKUP_SYNCED_KEY) || 0 } catch (e) {}
    const unbacked = Math.max(0, total - synced)
    const level = Math.floor(unbacked / BACKUP_REMIND_STEP)
    if (level < 1) return
    let alerted = 0
    try { alerted = wx.getStorageSync(BACKUP_ALERT_KEY) || 0 } catch (e) {}
    if (level <= alerted) return
    try { wx.setStorageSync(BACKUP_ALERT_KEY, level) } catch (e) {}
    wx.showModal({
      title: '备份提醒',
      content: '已 ' + unbacked + ' 篇未备份，建议备份，以免日记丢失。',
      confirmText: '一键开启云备份',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) {
          try { wx.navigateTo({ url: '/pages/backup/backup' }) } catch (e) {}
        }
      }
    })
  } catch (e) { /* 提醒失败不影响保存主流程 */ }
}


// 估算对象 JSON 序列化后的 UTF-8 字节数（预检查用，估算失败返回 0 表示跳过预检查）
function estimateUtf8Bytes(obj) {
  try {
    return unescape(encodeURIComponent(JSON.stringify(obj))).length
  } catch (e) {
    return 0
  }
}

// 读某个 key 当前占用的字节数（估算；key 不存在返回 0）[net-release v1]
function readStorageBytes(key) {
  try {
    const v = wx.getStorageSync(key)
    if (v === '' || v === null || v === undefined) return 0
    return estimateUtf8Bytes(v)
  } catch (e) {
    return 0
  }
}

// 净释放判定 [net-release v1]：写入后占用更低 ⇒ 不可能因空间不足失败，应免去余量闸。
// 否则会死锁：存储满了 → 用户按提示删日记腾空间 → 删除本身也被空间闸挡住。
// 用 nextBytes > 0 兜住「估算失败返回 0」被误判成净释放的情况。
function isNetRelease(prevBytes, nextBytes) {
  return nextBytes > 0 && prevBytes > 0 && nextBytes < prevBytes
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

// 保存日记前预检：目标年份分格 + 新日记估算，检查单格上限与总剩余空间 [shard-storage v1]
// 返回 { ok, totalFull, shardFull, shardYear, free, need, shardBytes, shardLimit }
// [shard-full v1] ok=false 时调用方按 totalFull / shardFull 给不同提示，不进入保存流程
function precheckDiarySave(diary) {
  const key = shardKeyFor(diary)
  const shard = readShard(key).slice()
  shard.unshift(Object.assign({}, diary, {
    id: (diary && diary.id) || 'precheck',
    created_at: (diary && diary.created_at) || new Date().toISOString()
  }))
  const est = estimateUtf8Bytes(shard)
  const total = checkStorageSpace(est)
  // [shard-full v1] 区分「某年分格满」与「整机存储满」：两者处置建议不同，
  // 只回一个 ok 布尔会把「整机还剩 9MB」也报成「本地存储已满」，用户按提示删往年日记完全无效
  const shardFull = est > SHARD_LIMIT
  return {
    ok: total.ok && !shardFull,
    totalFull: !total.ok,
    shardFull: shardFull,
    shardYear: shardYearFor(diary),
    free: total.free,
    need: total.need,
    shardBytes: est,
    shardLimit: SHARD_LIMIT
  }
}

// 安全写入：预检查（总剩余空间 + 可选单格上限）+ 异常兜底；失败时返回 false
// maxBytes：单格上限（分片写入传 SHARD_LIMIT），超限同样按「存储已满」处理 [shard-storage v1]
function safeSetStorage(key, value, estimatedBytes, silent, maxBytes) {
  const est = estimatedBytes != null ? estimatedBytes : estimateUtf8Bytes(value)
  // [net-release v1] 净释放空间的写入（删日记 / 去重合并后变小 / 清空）直接放行：
  // 这类写入只会让总占用更低，套「剩余 ≥ 本次写入 + 200KB」会把它误判成「存储已满」。
  const release = isNetRelease(readStorageBytes(key), est)
  if (!release) {
    const check = checkStorageSpace(est)
    if (!check.ok || (maxBytes && est > maxBytes)) {
      if (!silent) showStorageFullModal()
      return false
    }
  }
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    if (!silent) showStorageFullModal()
    return false
  }
}

/**
 * 获取所有日记（按时间倒序）
 * 同时为 title 字段缺失的**历史数据**生成默认标题，避免全站出现「无题」
 * 注：导入/解析链路现在都在解析时即写入 title（标记 [parse-title v1]），
 *     这里的兜底只服务于更早版本存下的旧数据。
 */
function getAllDiaries() {
  const list = readAllDiariesRaw() // [shard-storage v1] 分片并集
  // 标题兜底（仅展示层，不写回本地）[title-content-fallback v1]：
  // 空 title → 正文开头 ≤7 字 → 正文也空才用日期标题「X月X日 日记」
  // 唯一口径 = util.resolveDiaryTitle；index.js / detail.js 走同一函数，别在这里另写一份
  list.forEach(d => {
    d.title = util.resolveDiaryTitle(d)
  })
  // [sd#18] 跨格并集后必须用安全排序：无日期条目（Invalid Date→NaN）沉底；
  // 分格并集不再天然带着写入时的排序，普通 sort 的 NaN 比较顺序不可靠
  sortDiariesByTimeDesc(list)
  return list
}

/**
 * 保存日记到本地
 * @param {object} diary - { id, title, content, mood, source, created_at, updated_at }
 */
function saveDiary(diary) {
  ensureMigrated()
  diary.id = diary.id || generateId()
  diary.created_at = diary.created_at || new Date().toISOString()
  diary.updated_at = new Date().toISOString()
  const key = shardKeyFor(diary)
  const list = readShard(key)
  list.unshift(diary)
  if (!safeSetStorage(key, list, null, false, SHARD_LIMIT)) return null // 存储已满：已弹窗提示，返回 null
  scheduleCloudBackup()
  remindBackupIfNeeded()
  return diary
}

/**
 * 更新日记 [shard-storage v1]：先定位所在分格再改；日期改跨年时挪格
 */
function updateDiary(id, updates) {
  ensureMigrated()
  const keys = allDiaryKeys()
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const list = readShard(key)
    const index = list.findIndex(d => d.id === id)
    if (index === -1) continue
    const updated = { ...list[index], ...updates, updated_at: new Date().toISOString() }
    const newKey = shardKeyFor(updated)
    if (newKey === key) {
      list[index] = updated
      if (!safeSetStorage(key, list, null, false, SHARD_LIMIT)) return null // 存储已满：已弹窗提示，返回 null
      scheduleCloudBackup()
      remindBackupIfNeeded()
      return updated
    }
    // 跨年挪格：先写新格（失败则旧格原样不动），成功后再从旧格移除
    const target = readShard(newKey)
    target.unshift(updated)
    if (!safeSetStorage(newKey, target, null, false, SHARD_LIMIT)) return null // 新格已满：已弹窗提示
    safeSetStorage(key, list.filter((d, j) => j !== index)) // 释放旧格空间，正常不会失败
    scheduleCloudBackup()
    remindBackupIfNeeded()
    return updated
  }
  return null
}

/**
 * 删除日记 [shard-storage v1]：在所有分格（含迁移保留的旧格）中同步移除
 * @returns {boolean} 是否全部写入成功；false 表示有分格没删掉，调用方**不得**提示「已删除」
 */
function deleteDiary(id) {
  ensureMigrated()
  let okDelete = true
  allDiaryKeys().forEach((key) => {
    const list = readShard(key)
    if (!list.some(d => d.id === id)) return
    // [net-release v1] 删除是净释放空间的写入，正常不会失败；但必须如实回报，
    // 否则「删了又还在」会被用户当成删除 bug，而且完全没有线索
    if (!safeSetStorage(key, list.filter(d => d.id !== id))) okDelete = false
  })
  scheduleCloudBackup()
  return okDelete
}

/**
 * 获取单条日记 [shard-storage v1]
 */
function getDiaryById(id) {
  return readAllDiariesRaw().find(d => d.id === id)
}

/**
 * 统计某一天已保存日记中的媒体数量（供「当天图片/视频限额」判断）
 * @param {string} dateKey - 'YYYY-MM-DD'
 * @returns {{images: number, videos: number}}
 */
function countMediaByDate(dateKey) {
  const list = readAllDiariesRaw() // [shard-storage v1] 分片并集
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
   一灯记 导出备份（共 2 篇）

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
  let m = str.match(/(\d{4})\s*年\s*(\d{1,2})月\s*(\d{1,2})[日号]/) // [dhv2#1] 兼容「号」；[sd#17] 年月日间允许空白
  if (m) {
    const dt = new Date(+m[1], +m[2] - 1, +m[3], 12)
    return isNaN(dt.getTime()) ? null : dt
  }
  m = str.match(/(\d{1,2})月(\d{1,2})[日号]/) // [dhv2#2] 兼容「号」
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
  const header = appInfo.APP_NAME + ' 导出备份（共 ' + list.length + ' 篇）\n'
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
  if (!dates.length) return appInfo.APP_NAME + '备份.docx'
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
    '.diary h2{font-size:17px;color:#C0773A;margin:0 0 8px}\n' +
    '.meta{font-size:12px;color:#888;margin:0 0 10px}\n' +
    '.content p{margin:4px 0;text-indent:1em}\n' +
    '.media{margin:10px 0}\n' +
    '.media img{max-width:100%;width:100%;border-radius:6px;margin:4px 0;display:block}\n' +
    '.video,.location{font-size:13px;color:#555;margin:6px 0;word-break:break-all}\n' +
    '.video a{color:#10AEFF;text-decoration:none}\n' +
    '</style>\n</head>\n<body>\n' +
    '<h1 class="doc-title">' + appInfo.APP_NAME + ' · 日记备份</h1>\n' +
    '<p class="doc-sub">导出时间：' + escapeHtml(util.formatFullDate(new Date().toISOString())) +
    '　·　共 ' + list.length + ' 篇　·　由 ' + appInfo.APP_NAME + ' 小程序导出</p>\n' +
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
    entryType: d.entryType || null,
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
 * @param {Array} [archives] 可选，档案列表（全量导出附带：文档末尾「档案」一节 + 隐藏 JSON，导入时可还原）
 * @returns {ArrayBuffer} docx 文件二进制
 */
function buildDocx(diaries, imgBin, videoMap, archives) {
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
  paras.push(docxPara(appInfo.APP_NAME + ' · 日记备份', { bold: true, size: '44', center: true, spacing: true }))
  paras.push(docxPara('导出时间：' + util.formatFullDate(new Date().toISOString()) +
    '　·　共 ' + list.length + ' 篇　·　由 ' + appInfo.APP_NAME + ' 小程序导出',
    { color: '999999', size: '22', center: true }))

  list.forEach(d => {
    const dateObj = new Date(d.created_at)
    const valid = !isNaN(dateObj.getTime())
    // 日期标题（绿色加粗）+ 顶部分隔间距
    paras.push(docxPara(valid ? wordTitleDate(dateObj, withYear) : '未标注日期',
      { bold: true, size: '34', color: 'C0773A', before: 360 }))
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
        if (t) paras.push(docxPara(t, { size: String(fontSetting.getDocxSize()), spacing: true }))
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
      entryType: d.entryType || null,
      tags: d.tags || [], location: d.location || null, media: d.media || [],
      weather: d.weather || null,
      created_at: d.created_at, updated_at: d.updated_at
    }
    paras.push(docxHiddenPara(JSON.stringify(data)))
  })

  // [docx-archives v1] 档案节（全量导出附带：可见「档案」一节 + 隐藏 JSON，导入时可完整还原）
  const archList = (Array.isArray(archives) ? archives : [])
    .filter(a => a && String(a.name || '').trim())
  if (archList.length) {
    paras.push(docxPara('档案', { bold: true, size: '34', color: 'C0773A', before: 480 }))
    archList.forEach(a => {
      const name = String(a.name).trim()
      const desc = String(a.description || '').trim()
      paras.push(docxPara('· ' + name + (desc ? '：' + desc : ''), { size: '24', spacing: true }))
    })
    paras.push(docxHiddenPara(JSON.stringify({
      type: 'ai-diary-archives',
      archives: archList.map(a => ({ name: String(a.name).trim(), description: String(a.description || '').trim() }))
    })))
  }

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
 * @returns {{diaries: Array, full: boolean, notes: Array, archives: Array}} archives 为档案节（全量导出附带），无则为 []
 */
function parseDocxXml(xml) {
  if (!xml || typeof xml !== 'string') return { diaries: [], full: false, notes: [], archives: [] }
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
  // [docx-archives v1]
  const archives = []
  paras.forEach(pXml => {
    if (pXml.indexOf('<w:vanish') === -1) return
    const t = paraText(pXml)
    if (t.indexOf('AIDIARY:') !== 0) return
    try {
      const obj = JSON.parse(t.slice(8))
      if (obj && obj.type === 'ai-diary-archives' && Array.isArray(obj.archives)) {
        // 档案节（全量导出附带）：一并取出，交给导入流程 saveArchives 追加合并
        obj.archives.forEach(a => {
          if (a && String(a.name || '').trim()) {
            archives.push({ name: String(a.name).trim(), description: String(a.description || '').trim() })
          }
        })
        return
      }
      if (obj && obj.content) {
        diaries.push({
          id: obj.id || generateId(),
          title: obj.title || '',
          content: obj.content,
          mood: obj.mood || '',
          source: obj.source || 'manual',
          entryType: obj.entryType || null,
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
  if (diaries.length) return { diaries: diaries, full: true, notes: [], archives: archives }

  // 3) 回退：解析可视段落（文件可能被 Word/WPS 编辑过）
  const notes = []
  // 标题行：整行就是「X月X日（日记/合并日记/周几）」等短格式，与 parseNumberedDiaries 一致，额外兼容带年份
  // [dhv2#3] 放宽：兼容「号」、周X+日记双后缀（顺序不限）、行尾括号备注（如「（最终修正版）」）
  // [dhv2#18] 星期后缀兼容「周五」与「星期五」
  const titleRe = /^\s*(?:(?:\d{4})年)?\d{1,2}月\d{1,2}[日号](?:\s*[、,，]\s*(?:\d{1,2}月)?\d{1,2}[日号])*(?:\s*合并)?(?:\s*(?:(?:周|星期)[日一二三四五六]|日记))*(?:\s*[（(][^）)]*[）)])?\s*$/
  let cur = null
  const fallback = []
  paras.forEach(pXml => {
    if (pXml.indexOf('<w:vanish') !== -1) return
    const t = paraText(pXml).trim()
    if (!t) return
    if (titleRe.test(t)) {
      if (cur) fallback.push(cur)
      const ts = parseCnDate(t)
      const createdAt = ts ? ts.toISOString() : new Date().toISOString()
      cur = {
        id: generateId(),
        content: '',
        mood: '',
        tags: [],
        location: null,
        media: [],
        weather: null,
        created_at: createdAt,
        // [parse-title v1] 解析时即写入标题：与 parseVisibleBlock / parseDiariesFromText /
        // parseNumberedDiaries 同一口径（原先留空串、只靠 getAllDiaries 展示层兜底，
        // 而落库的是对象本身 ⇒ 云备份 / 导出 / 分享里的 title 一直是空）
        title: util.getDefaultTitle(util.getDateKey(new Date(createdAt)))
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
    // [brand-rename v1] 兼容旧品牌名：改名后仍要能导入此前导出的老备份文件
    if (t.indexOf(appInfo.APP_NAME + ' · 日记备份') !== -1 ||
      t.indexOf('AI日记 · 日记备份') !== -1 || t.indexOf('导出时间：') !== -1) return
    // [docx-archives v1] 档案节可见行（编辑过的文档回退路径）：标题行与「· 名字：描述」行不入正文
    if (t === '档案' || /^·\s/.test(t)) return
    // 正文
    cur.content = cur.content ? cur.content + '\n' + t : t
  })
  if (cur) fallback.push(cur)
  // [parse-title v2] 安全网：标题补全对**全部**条目生效。
  // 旧写法只给最后一条补 title（前面 push 出去的条目恒为空串、全靠展示层兜底），
  // 且末尾那条的补法与主路径口径重复。这里统一兜住「标题行缺失」的极端文档。
  fallback.forEach(d => {
    if (!d.title) d.title = util.getDefaultTitle(util.getDateKey(new Date(d.created_at)))
  })
  const valid = fallback.filter(d => d.content)
  if (valid.length) {
    notes.push('文档中没有找到完整备份数据（可能被编辑过），已按可见文本还原；图片与视频未能自动还原。')
    return { diaries: valid, full: false, notes: notes, archives: archives }
  }
  return { diaries: [], full: false, notes: [], archives: archives }
}

// [loose-import v1][s1] docx 可见段落 → 纯文本（供宽泛导入引擎使用；隐藏数据段剔除，空行保留）
function docxXmlToText(xml) {
  if (!xml || typeof xml !== 'string') return ''
  const paras = []
  const reP = /<w:p\b[\s\S]*?<\/w:p>/g
  let m
  while ((m = reP.exec(xml)) !== null) paras.push(m[0])
  const lines = []
  paras.forEach(pXml => {
    if (pXml.indexOf('<w:vanish') !== -1) return
    let t = ''
    const reT = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let mm
    while ((mm = reT.exec(pXml)) !== null) t += decodeHtmlEntities(mm[1])
    lines.push(t.replace(/\s+$/, ''))
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// [loose-import v1][s2] 安全排序：created_at 无效（无日期条目）沉底，有效日期正常倒序
function sortDiariesByTimeDesc(list) {
  list.sort((a, b) => {
    const ta = new Date(a.created_at).getTime()
    const tb = new Date(b.created_at).getTime()
    const va = isNaN(ta) ? -Infinity : ta
    const vb = isNaN(tb) ? -Infinity : tb
    return vb - va
  })
}

// 时间升序（旧→新），无日期日记仍沉底 —— sortDiariesByTimeDesc 的镜像口径 [index-sort v1]
// 无日期在 Desc 里记为 -Infinity、在 Asc 里记为 +Infinity ⇒ 两个方向都沉底，
// 与列表既有「无日期沉底」约定一致（不能靠反转数组，否则无日期会被顶到最上面）。
// 返回新数组（slice 后再排），不改动入参 —— 调用方的 data 数组可能与本列表同一引用。
function sortDiariesByTimeAsc(list) {
  const arr = Array.isArray(list) ? list.slice() : []
  arr.sort((a, b) => {
    const ta = new Date(a.created_at).getTime()
    const tb = new Date(b.created_at).getTime()
    const va = isNaN(ta) ? Infinity : ta
    const vb = isNaN(tb) ? Infinity : tb
    return va - vb
  })
  return arr
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
          entryType: obj.entryType || null,
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
  // 标准【日期】/【内容】格式没解析到 → 尝试「X月X日日记」通用格式
  if (diaries.length === 0) return parseNumberedDiaries(text)
  return diaries
}

/**
 * 解析「X月X日日记」通用格式的纯文本为日记数组
 * 格式示例：
 *   8月11日日记
 *   今天早上到公司……
 *
 *   8月10日日记
 *   周一早高峰……
 * 支持标题变体（「日记」二字均可省略）：
 *   「8月11日」                       → 单独日期也算标题
 *   「8月11日 日记」/「8月11日日记」   → 带「日记」后缀
 *   「8月1日、8月2日日记」           → 合并日记，取第一个日期
 *   「7月15日、16日合并日记」        → 第二个日期可省略月份
 *   「7月26日、7月27日合并日记」     → 显式「合并日记」
 * 日期无年份时按今年推断（未来超90天自动回退到去年，与 parseCnDate 一致）
 */
function parseNumberedDiaries(text) {
  if (!text || typeof text !== 'string') return []
  const lines = text.split('\n')
  const diaries = []
  // 标题行：以「X月X日」开头，整行只含日期（可多个顿号/逗号分隔）及可选的「合并」「日记」后缀
  // 「日记」二字可省略，故「8月11日」单独一行也能作为标题识别
  // [dhv2#4] 放宽：兼容「号」、周X+日记双后缀（顺序不限）、行尾括号备注
  // [dhv2#19] 星期后缀兼容「周五」与「星期五」
  // [dhv2#23] 与 parseDocxXml 可见结构口径一致：也支持带年份
  const titleRe = /^\s*(?:(?:\d{4})\s*年\s*)?\d{1,2}月\d{1,2}[日号](?:\s*[、,，]\s*(?:\d{1,2}月)?\d{1,2}[日号])*(?:\s*合并)?(?:\s*(?:(?:周|星期)[日一二三四五六]|日记))*(?:\s*[（(][^）)]*[）)])?\s*$/
  const dateRe = /(?:\d{4}\s*年\s*)?\d{1,2}月\d{1,2}[日号]/ // [dhv2#5] 兼容「号」
  // [sd#16] dateRe 补可选年份：否则「2024年3月1日」标题传给 parseCnDate 的只剩「3月1日」，
  // 年份被静默丢掉（文本导入落错年份的真 bug，分片测试探针发现）
  let current = null // { dateStr, contentLines: [] }

  const flush = () => {
    if (!current) return
    const content = current.contentLines.join('\n').trim()
    if (content) {
      const diary = { id: generateId(), content: content }
      const t = parseCnDate(current.dateStr)
      if (t) {
        diary.created_at = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0, 0).toISOString()
      } else {
        diary.created_at = new Date().toISOString()
      }
      diary.title = util.getDefaultTitle(util.getDateKey(new Date(diary.created_at)))
      diaries.push(diary)
    }
    current = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (titleRe.test(line)) {
      flush()
      const m = line.match(dateRe)
      current = { dateStr: m ? m[0] : '', contentLines: [] }
    } else if (current) {
      current.contentLines.push(rawLine)
    }
    // 标题行之前（文件头部说明）的行忽略
  }
  flush()
  return diaries
}

/**
 * 从纯文本导入日记（按「日期+内容指纹」去重合并，或全部替换）
 * @param {string} text
 * @param {boolean} replace - true 覆盖现有全部日记
 * @returns {{added: number, total: number}}
 */
function importDiariesFromText(text, replace) {
  const parsed = parseDiariesFromText(text)
  if (!parsed.length) return { added: 0, total: 0 }
  if (replace) {
    if (!replaceAllSharded(parsed)) return { added: -1, total: 0 } // 存储已满 [shard-storage v1]
    return { added: parsed.length, total: parsed.length }
  }
  // [shard-storage v1] 分格合并：按「日期+内容指纹」去重后逐格预检、逐格写入
  // [import-dedup v1] 键与 importDiaryObjects 同一式（contentFingerprint），两路行为必须一致
  return mergeIntoShards(parsed, (d) => util.getDateKey(new Date(d.created_at)) + '|' + util.contentFingerprint(d.content))
}

/**
 * 导入日记（按 id 去重，返回新增条数）
 * @param {Array} importList - 日记数组
 */
function importDiaries(importList) {
  if (!Array.isArray(importList)) return 0
  const prepared = []
  importList.forEach(d => {
    if (!d || !d.content) return
    const diary = { ...d }
    if (!diary.id) diary.id = generateId()
    if (!diary.created_at) diary.created_at = new Date().toISOString()
    prepared.push(diary)
  })
  if (!prepared.length) return 0
  const existingIds = new Set(readAllDiariesRaw().map(d => d.id))
  const fresh = prepared.filter(d => !existingIds.has(d.id))
  if (!fresh.length) return 0
  // [shard-storage v1] 分格合并（按 id 去重）
  const r = mergeIntoShards(fresh, (d) => d.id)
  if (r.added > 0) {
    scheduleCloudBackup()
    remindBackupIfNeeded()
  }
  return r.added
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
 * 从日记对象数组导入（按「日期+内容指纹」去重合并，或全部替换）— 供 AI 识别结果等场景使用
 * @param {Array} list - 日记对象数组（需含 content，建议含 created_at）
 * @param {boolean} replace - true 覆盖现有全部日记
 * @returns {{added: number, total: number}}
 */
function importDiaryObjects(list, replace) {
  const items = Array.isArray(list) ? list : []
  if (!items.length) return { added: 0, total: 0 }
  if (replace) {
    if (!replaceAllSharded(items)) return { added: -1, total: 0, skipped: 0 } // 存储已满 [shard-storage v1]
    scheduleCloudBackup()
    return { added: items.length, total: items.length, skipped: 0 }
  }
  // [shard-storage v1] 分格合并：按「日期+内容指纹」去重后逐格预检、逐格写入
  // [import-dedup v1] 键用 contentFingerprint：只吞格式差异（换行/空白），正文真有差异仍判两篇
  const r = mergeIntoShards(items, (d) => util.getDateKey(new Date(d.created_at)) + '|' + util.contentFingerprint(d.content))
  if (r.added > 0) {
    scheduleCloudBackup()
    remindBackupIfNeeded()
  }
  return r
}

/**
 * 替换所有日记（恢复备份用），返回条数 [shard-storage v1]
 */
function replaceAllDiaries(importList) {
  if (!Array.isArray(importList)) return 0
  if (!replaceAllSharded(importList)) return -1 // 存储已满
  scheduleCloudBackup()
  return importList.length
}

/**
 * 清空本机所有日记（设置页「清除所有日记」调用）
 * 不触发云端自动同步：云端快照与云端图片/视频全部保留，用户之后仍可从云端恢复
 */
function clearAllDiaries() {
  // 覆盖所有分格并清掉旧格 [shard-storage v1]
  // [net-release v1] 返回是否真的清干净：清空失败却报「已清除全部日记」，用户会以为删干净了
  return replaceAllSharded([])
}

/* ===== 档案：存储人物/机构等备注信息 ===== */

const ARCHIVE_KEY = 'archives'

/**
 * 获取所有档案（按更新时间倒序）
 *
 * [archive-order v1] 排序必须可复现，主键 + 次键两级：
 *  - 主键：updated_at 倒序（最近改动的排前面）；
 *  - 次键：updated_at 完全相同（含缺失/非法时间）时，按**存储数组下标升序**
 *    —— 即同一批 saveArchives 录入的档案保持录入顺序。
 *  为什么显式写次键：同一批档案的 updated_at 可能落在相邻毫秒（循环跨毫秒，
 *  冷启动/JIT 未热时更常见）。只按时间倒序时，末条会冒到最前 → 同一份数据
 *  在不同时刻运行得到不同顺序，档案列表 / 热词优先级 / 导出 docx 的档案节
 *  顺序都不可复现。另外也不依赖引擎「稳定排序」的实现差异（ES2019 起要求
 *  稳定，但显式次键在任何引擎上都成立）。
 *  返回新数组，不改动 Storage 里的原数组引用。
 */
function getArchives() {
  const list = wx.getStorageSync(ARCHIVE_KEY) || []
  return list
    .map((item, index) => ({ item: item, index: index }))
    .sort((x, y) => {
      const d = new Date(y.item.updated_at) - new Date(x.item.updated_at)
      if (d) return d
      return x.index - y.index
    })
    .map(o => o.item)
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
  let skipped = 0
  // [archive-batch-ts v1] 整批共用同一个时间戳：语义上「这一批是同一时刻保存的」。
  // 同时保证同批各条 updated_at 完全相同 → getArchives() 的稳定次键生效，
  // 顺序恒等于录入顺序；也避免同一条的 created_at 与 updated_at 差 1ms。
  const now = new Date().toISOString()
  items.forEach(item => {
    const name = String(item.name || '').trim()
    const desc = String(item.description || '').trim()
    if (!name) return
    // 统一兜底（云函数 / 本地降级 / 手输三条路共用）：名称必须是 9 字以内的名词，
    // 含句读标点或超长 = 一整句话被误当名称 → 丢弃本条，不入库
    if (!archiveEdit.isTermName(name)) {
      skipped++
      return
    }
    if (nameMap[name]) {
      const oldDesc = String(nameMap[name].description || '').trim()
      const merged = mergeArchiveDescription(oldDesc, desc)
      if (merged !== null && merged !== oldDesc) {
        nameMap[name].description = merged
        nameMap[name].updated_at = now // [archive-batch-ts v1]
        updated++
      }
    } else {
      const entry = {
        id: 'a_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: name,
        description: desc,
        created_at: now,
        updated_at: now
      }
      list.push(entry)
      nameMap[name] = entry
      added++
    }
  })
  if (!safeSetStorage(ARCHIVE_KEY, list)) return { added: 0, updated: 0, skipped } // 存储已满：已弹窗提示
  scheduleCloudBackup()
  return { added, updated, skipped }
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

/**
 * 把 HTML 源码还原为纯文本（保留块级换行结构，并解码 HTML 实体）
 * 用于导入 .html/.htm 文件：记事本/部分编辑器「另存为 HTML」时，中文常被编码成
 * 数字实体（如「月」→ &#26376;），且标题/正文靠 <br>/<p> 等标签分行。
 * 若不先还原，本地解析器认不到字面「月/日」、AI 兜底也会收到实体乱码。
 * 处理顺序：去 script/style → 解码实体 → 块级标签转行 → 去其余标签 → 压缩空白。
 */
function htmlToText(html) {
  if (!html || typeof html !== 'string') return ''
  let s = html
  // 0) 先移除 <script>/<style> 整块（含内部文本，避免脚本/样式混入正文）
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
  // 1) 解码 HTML 实体：数字（十进制/十六进制）+ 常见命名实体
  s = s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
  // 2) 块级换行标签 → 换行（<br> 及各类块级闭合标签）
  s = s
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<hr\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|td|th|section|article|blockquote|pre|table|form)\s*>/gi, '\n')
  // 3) 其余所有标签去掉
  s = s.replace(/<[^>]+>/g, '')
  // 4) 压缩连续空行、行首尾空白
  s = s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(l => l.trim())
    .join('\n')
    .trim()
  return s
}

module.exports = {
  getAllDiaries,
  saveDiary,
  updateDiary,
  deleteDiary,
  clearAllDiaries,
  precheckDiarySave,
  shardKeyFor, // [shard-storage v1] 测试钩子：日记 → 年份分格 key
  ensureMigrated, // [shard-storage v1] 测试钩子：手动触发旧格迁移
  getDiaryById,
  sortDiariesByTimeAsc, // [index-sort v1] 升序展示排序（无日期仍沉底）；日记本「正序」与导出顺序复用
  getStats,
  countMediaByDate,
  exportDiaries,
  importDiaries,
  replaceAllDiaries,
  exportDiariesToText,
  parseDiariesFromText,
  parseNumberedDiaries,
  importDiariesFromText,
  htmlToText,
  buildWordFileName,
  buildWordHtml,
  parseWordHtml,
  buildDocx,
  parseDocxXml,
  docxXmlToText, // [loose-import v1][s3] docx 可见段落转纯文本（宽泛导入用）
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
