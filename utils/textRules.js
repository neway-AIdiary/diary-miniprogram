/**
 * 写日记页占位文案规则（按「打开次数」与「日记篇数」两个维度切换）
 *
 * 用途：写日记页输入框的背景说明文字（3 行）不再写死，而是按「用户第几次打开小程序」
 *       与「已有多少篇日记」匹配一条规则来显示。
 *
 * 数据源：微信云开发数据库集合 text_rules（客户端直读）。
 *         在云开发控制台加一条记录 = 多一个档位，改文案不用发版。
 *         任何一步失败（集合不存在 / 无网络 / 权限不足）都静默回落本地默认文案，
 *         绝不阻塞、绝不报错。
 *
 * 匹配优先级：打开次数 > 日记篇数 > 本地默认
 *   1) 先在所有 type='launch' 规则里按 order 从小到大找，命中即返回；
 *   2) 都没命中，再在 type='diary' 规则里找；
 *   3) 都没命中，返回 DEFAULT_LINES。
 *   ⚠️ 因此不要建「打开次数 2~无上限」这类规则，否则篇数档位永远不会生效。
 *
 * 记录字段（云数据库一条记录 = 一个档位）：
 *   order   Number  排序，小的先匹配（建议 10、20、30… 留空隙方便插队；不填按记录顺序）
 *   type    String  'launch'（按打开次数）| 'diary'（按日记篇数）
 *   min     Number  区间下限（含）；不填 = 0
 *   max     Number  区间上限（含）；不填 = 无上限
 *   enabled Boolean 开关；不填视为启用
 *   lines   Array   最多 3 行文案；少于 3 行时后面的行沿用默认文案
 *
 * 例子（第 1 次打开显示隐私说明，其余走默认）：
 *   { order: 10, type: 'launch', min: 1, max: 1,
 *     lines: ['日记默认只存在你的手机本机',
 *             '你也可以主动开启加密备份（明文永不上传）',
 *             '无论哪种形式，只有你能看到'] }
 */

const COUNT_KEY = 'launchCount'          // 打开次数（冷启动累加）
const RULES_CACHE_KEY = 'textRulesCache' // 云端规则本地缓存
const COLLECTION = 'text_rules'

// 客户端单次最多取 20 条；档位超过 20 个需拆集合或精简
const MAX_FETCH = 20

// 默认三行文案（兜底：无规则命中 / 云端拉取失败 / 集合尚未创建时使用）
const DEFAULT_LINES = [
  '您可以语音或手动输入内容，自动记录和融合到当天的日记',
  '输入改动指令直接更改内容，如：把王威改成王伟，删除第一句',
  '最终还可以通过点击AI优化按钮，完善您的日记'
]

const MAX_LINES = DEFAULT_LINES.length

let memCount = null     // 打开次数内存值（避免每次读取 storage）
let cachedRules = null  // 规则内存缓存（避免每次 onShow 都读 storage）

// ===== 底层读写：无 wx 环境（Node 测试）静默降级到内存 =====
const memStore = {}

function safeGet(key, def) {
  const has = Object.prototype.hasOwnProperty.call(memStore, key)
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      const v = wx.getStorageSync(key)
      if (v !== '' && v !== null && v !== undefined) return v
    }
  } catch (e) { /* 读取失败：用内存/默认值兜底 */ }
  return has ? memStore[key] : def
}

function safeSet(key, val) {
  memStore[key] = val
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(key, val)
  } catch (e) { /* 写入失败不阻塞：内存值本次会话内有效 */ }
}

// 数字归一化：null / undefined / '' 一律视为「未填写」并用默认值
// （注意：Number(null) === 0，若不特判，控制台把 max 留空会被当成 0 → 区间失效）
function toNum(v, def) {
  if (v === null || v === undefined || v === '') return def
  const n = Number(v)
  return isFinite(n) ? n : def
}

// 文案数组归一化：去空、最多 3 行；不足 3 行时后面沿用默认文案
function normalizeLines(raw) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim()) list = [raw]
  const out = []
  for (let i = 0; i < list.length && out.length < MAX_LINES; i++) {
    const s = String(list[i] === null || list[i] === undefined ? '' : list[i]).trim()
    if (s) out.push(s)
  }
  if (!out.length) return []
  while (out.length < MAX_LINES) out.push(DEFAULT_LINES[out.length])
  return out
}

/**
 * 规则归一化：丢弃非法/显式关闭/无文案的记录，按 order 升序（order 相同按 _id）排序
 */
function normalizeRules(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {}
    let type = ''
    if (r.type === 'launch') type = 'launch'
    else if (r.type === 'diary') type = 'diary'
    if (!type) continue // 类型非法：丢弃
    if (r.enabled === false || r.enabled === 0 || r.enabled === 'false') continue // 显式关闭
    const lines = normalizeLines(r.lines)
    if (!lines.length) continue // 没有可用文案：丢弃
    const min = toNum(r.min, 0)
    let max = toNum(r.max, Infinity)
    if (max < min) max = min
    let order = toNum(r.order, NaN)
    if (!isFinite(order)) order = i * 10 // 未填 order：按记录顺序兜底
    out.push({
      id: String(r._id === undefined || r._id === null ? i : r._id),
      order: order,
      type: type,
      min: min,
      max: max,
      lines: lines
    })
  }
  out.sort(function (a, b) {
    if (a.order !== b.order) return a.order - b.order
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
  })
  return out
}

function inRange(v, rule) {
  return v >= rule.min && v <= rule.max
}

/**
 * 纯函数匹配引擎（不依赖 wx，便于单测）
 * @param {Array} rules normalizeRules 的产物
 * @param {Object} ctx  { launchCount, diaryCount }
 * @return {Array} 恰好 3 行文案
 */
function pickLines(rules, ctx) {
  const c = ctx || {}
  const launchCount = toNum(c.launchCount, 1)
  const diaryCount = toNum(c.diaryCount, 0)
  const list = Array.isArray(rules) ? rules : []
  let i
  // 1) 打开次数优先
  for (i = 0; i < list.length; i++) {
    if (list[i].type === 'launch' && list[i].enabled !== false && inRange(launchCount, list[i])) {
      return list[i].lines.slice(0, MAX_LINES)
    }
  }
  // 2) 再看日记篇数
  for (i = 0; i < list.length; i++) {
    if (list[i].type === 'diary' && list[i].enabled !== false && inRange(diaryCount, list[i])) {
      return list[i].lines.slice(0, MAX_LINES)
    }
  }
  // 3) 兜底
  return DEFAULT_LINES.slice()
}

// ===== 打开次数 =====

/** 当前是第几次打开（首次安装后的第一次启动 = 1） */
function getLaunchCount() {
  if (memCount !== null) return memCount
  const raw = Math.floor(toNum(safeGet(COUNT_KEY, 0), 0))
  return raw > 0 ? raw : 1
}

/** 打开次数 +1（仅供 app.onLaunch 调用一次） */
function bumpLaunchCount() {
  const raw = Math.floor(toNum(safeGet(COUNT_KEY, 0), 0))
  const next = raw + 1
  memCount = next
  safeSet(COUNT_KEY, next)
  return next
}

// ===== 规则缓存与云端拉取 =====

function getRules() {
  if (cachedRules) return cachedRules
  cachedRules = normalizeRules(safeGet(RULES_CACHE_KEY, null))
  return cachedRules
}

/**
 * 静默拉取云端规则并写入本地缓存。失败/集合不存在/权限不足一律静默。
 * 云端返回空数组时不覆盖本地缓存（避免集合被清空时把已有档位丢掉）。
 */
function refresh() {
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.database) return false
  try {
    const db = wx.cloud.database()
    db.collection(COLLECTION).limit(MAX_FETCH).get({
      success: function (res) {
        const raw = (res && res.data) || []
        const rules = normalizeRules(raw)
        if (!rules.length) return // 云端为空：保留现有缓存/默认
        cachedRules = rules
        safeSet(RULES_CACHE_KEY, raw)
      },
      fail: function (err) {
        // 集合不存在 / 权限不足 / 无网络：静默沿用缓存或默认
        console.warn('[textRules] 云端文案规则拉取失败，沿用本地默认:',
          err && err.errMsg ? err.errMsg : err)
      }
    })
  } catch (e) {
    return false
  }
  return true
}

/**
 * 当前应显示的三行占位文案
 * @param {Number} diaryCount 当前日记篇数（由调用方从 storage.getStats().total 传入）
 */
function getLines(diaryCount) {
  return pickLines(getRules(), {
    launchCount: getLaunchCount(),
    diaryCount: toNum(diaryCount, 0)
  })
}

// 测试/调试用：清空内存缓存，强制下次重新读取
function clearCache() {
  memCount = null
  cachedRules = null
  for (const k in memStore) {
    if (Object.prototype.hasOwnProperty.call(memStore, k)) delete memStore[k]
  }
}

module.exports = {
  COUNT_KEY,
  RULES_CACHE_KEY,
  COLLECTION,
  DEFAULT_LINES,
  MAX_LINES,
  normalizeLines,
  normalizeRules,
  pickLines,
  getLaunchCount,
  bumpLaunchCount,
  getRules,
  refresh,
  getLines,
  clearCache
}
