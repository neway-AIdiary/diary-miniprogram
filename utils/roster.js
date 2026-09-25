/**
 * utils/roster.js
 * [roster v1] 花名册 —— 从日记一键提取人名、用户确认后作为语音热词注入，独立于档案词条。
 *
 * 与档案的关系：存储独立、允许重名（档案是用户认证词条，花名册是提取名单）；
 * 唯一交汇点在热词注入（hotwords.js buildBase）：push 内 seen 去重，重名只占一位。
 *
 * 一键提取（纯本地规则，用户 2026-09-25 拍板）：
 *   ① 姓氏字典滑窗：姓氏位置同时统计 2/3 字窗，3 字须 ≥2 次才收、
 *      2 字被同名 3 字吸收（滤掉「王威吃/王威聊」这类「真名+后续字」碎片）；
 *   ② personNames 沉淀表种子（AI 抽取过的人名，精度最高）在日记中计数；
 *   ③ 清洗复用 entityClean.isNonNounWord + tags.STOP_WORDS + 代词字排除；
 *   ④ 排序 = 最近出现日期新→旧 主，出现次数多→少 次；
 *   ⑤ 剔除已在花名册的名字，截断至 100 − 已有数量。
 *
 * 缓存联动：确认添加/删除后 resetHotwordCache()（懒加载 hotwords，防循环 require），
 * 下次按住说话构建热词即带上最新花名册；录音路径只读本地小数组，无时序风险。
 */

const tags = require('./tags.js')
const entityClean = require('./entityClean.js')
const personNames = require('./personNames.js')

const KEY = 'yidengji_roster_v1'
const MAX_ROSTER = 100

// 常见单字姓氏：滑窗提名的首字必须命中（百家姓常用集）
const SURNAME_SRC =
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董' +
  '潘袁蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟' +
  '熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤温康施葛鲁'

const SURNAME_SET = new Set(SURNAME_SRC.split(''))
const PRON_CHARS = new Set('你我他她它咱'.split(''))

// ===== [roster-filter v1] 三层去伪（用户 2026-09-25 拍板 B 案）=====
// ① 虚词否决：候选首/尾字命中即不收（杀「任在」类「姓+虚词」碎片）
const EDGE_STOP_CHARS = '的了着是也都很就不没把被让在里上和与跟同或呢吧吗啊呀之乎者地得等又再才更最太'
// ② 常见词黑名单：以姓氏字开头但不是人名的常用词（子串命中即否决，杀「范围/罗马/宋体/朱砂/孔府/钟双打」类）
const NONNAME_WORDS = ['范围', '罗马', '宋体', '朱砂', '孔府', '双打', '马上', '方面',
  '周末', '当时', '当初', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
// ③ 上下文强证据：候选至少出现过一次「人名式上下文」——
//    前邻命中协同/称呼字（如「和王威…」），或后邻命中言说/动作字（如「王威说…」）；
//    一处都没有则视为普通词组剔除（杀「马术」类无上下文词组）
const CTX_LEFT_CHARS = '和跟与同陪带找叫请约帮教给让问邀拉'
const CTX_RIGHT_CHARS = '说问道讲喊告找带陪请帮见约来去到走回进出吃喝聊谈给让叫邀拉接送会要想'

function hitEdgeStop(w) {
  return EDGE_STOP_CHARS.indexOf(w.charAt(0)) !== -1 ||
    EDGE_STOP_CHARS.indexOf(w.charAt(w.length - 1)) !== -1
}

function hitNonnameWord(w) {
  for (let i = 0; i < NONNAME_WORDS.length; i++) {
    if (w.indexOf(NONNAME_WORDS[i]) !== -1) return true
  }
  return false
}

/** 名字合法性：2~3 个纯汉字，非停用词、非代词组合、过 entityClean 非名词否决 */
function validName(w) {
  if (!w || typeof w !== 'string') return false
  if (!/^[\u4e00-\u9fa5]{2,3}$/.test(w)) return false
  if (tags.STOP_WORDS && tags.STOP_WORDS.has(w)) return false
  for (let i = 0; i < w.length; i++) {
    if (PRON_CHARS.has(w[i])) return false
  }
  try { if (entityClean.isNonNounWord(w)) return false } catch (e) {}
  return true
}

/** 读取花名册（脏数据一律当空表/逐条过滤，绝不抛错），按存储顺序（先加在前） */
function getList() {
  try {
    const raw = wx.getStorageSync(KEY)
    if (!Array.isArray(raw)) return []
    const out = []
    const seen = new Set()
    for (let i = 0; i < raw.length; i++) {
      const it = raw[i]
      const name = String((it && it.name) || '').trim()
      if (!validName(name) || seen.has(name)) continue
      seen.add(name)
      out.push({
        name: name,
        count: Number(it && it.count) || 0,
        lastDate: String((it && it.lastDate) || ''),
        addedAt: Number(it && it.addedAt) || 0
      })
      if (out.length >= MAX_ROSTER) break
    }
    return out
  } catch (e) {
    return []
  }
}

/** 名字字符串数组（供热词注入等只读方） */
function getNames() {
  return getList().map(function (i) { return i.name })
}

/** 写底层 + 联动清热词缓存（懒加载，防与 hotwords.js 循环 require） */
function write(list) {
  try {
    wx.setStorageSync(KEY, list)
    try { require('./hotwords.js').resetBaseCache() } catch (e) {}
    return true
  } catch (e) {
    return false
  }
}

/**
 * 并入一批候选（确认面板点「确认添加」后调用）。
 * 已在花名册的名字跳过；总量到 MAX_ROSTER 即停。
 * @param {{name: string, count?: number, lastDate?: string}[]} items
 * @returns {number} 实际新增条数
 */
function addNames(items) {
  if (!Array.isArray(items) || !items.length) return 0
  const cur = getList()
  const names = new Set(cur.map(function (i) { return i.name }))
  const now = Date.now()
  let added = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const name = String((it && it.name) || '').trim()
    if (!validName(name) || names.has(name)) continue
    if (cur.length >= MAX_ROSTER) break
    cur.push({
      name: name,
      count: Number(it && it.count) || 0,
      lastDate: String((it && it.lastDate) || ''),
      addedAt: now
    })
    names.add(name)
    added++
  }
  if (added) write(cur)
  return added
}

/** 移除一个名字（长按删除确认后调用）；返回是否真的删了 */
function removeName(name) {
  const target = String(name || '').trim()
  if (!target) return false
  const cur = getList()
  const next = cur.filter(function (i) { return i.name !== target })
  if (next.length === cur.length) return false
  return write(next)
}

/**
 * 一键提取：从全量日记中挖人名候选（纯本地，见文件头规则）。
 * @param {{dateKey: string, content: string}[]} diaries 全量日记（dateKey 供新旧排序）
 * @param {string[]} existingNames 已在花名册的名字（剔除）
 * @param {number} cap 最大返回条数（= 100 − 已有数量）
 * @returns {{name: string, count: number, lastDate: string}[]} 排序截断后的候选
 */
function extractCandidates(diaries, existingNames, cap) {
  const existing = new Set(existingNames || [])
  const info2 = {}   // 2 字窗：{name, count, lastDate}
  const info3 = {}   // 3 字窗
  const bump = function (store, w, dk, strong) {
    if (!store[w]) store[w] = { name: w, count: 0, lastDate: '', strong: false }
    store[w].count++
    if (strong) store[w].strong = true
    if (dk && dk > store[w].lastDate) store[w].lastDate = dk
  }

  const list = Array.isArray(diaries) ? diaries : []

  // ① 姓氏滑窗：姓氏位置同时统计 2/3 字窗（重叠计数，后按频次与吸收规则去伪）
  list.forEach(function (d) {
    const text = String((d && d.content) || '')
    const dk = (d && d.dateKey) || ''
    if (!text) return
    const segs = text.split(/[^\u4e00-\u9fa5]+/)
    segs.forEach(function (seg) {
      for (let i = 0; i < seg.length - 1; i++) {
        if (!SURNAME_SET.has(seg[i])) continue
        // [roster-filter v1] 上下文强证据：前邻协同字 或 后邻言说/动作字（2/3 字窗共享同一证据）
        const hasCtx =
          (i > 0 && CTX_LEFT_CHARS.indexOf(seg[i - 1]) !== -1) ||
          (i + 2 < seg.length && CTX_RIGHT_CHARS.indexOf(seg[i + 2]) !== -1) ||
          (i + 3 < seg.length && CTX_RIGHT_CHARS.indexOf(seg[i + 3]) !== -1)
        bump(info2, seg.substr(i, 2), dk, hasCtx)
        if (i + 2 < seg.length) bump(info3, seg.substr(i, 3), dk, hasCtx)
      }
    })
  })

  // ② personNames 沉淀表种子（AI 抽过的人名，不受姓氏字典限制）逐篇计数
  let seeds = []
  try { seeds = personNames.getNames() || [] } catch (e) { seeds = [] }

  // ③ 去伪成稿：
  //    3 字窗须出现 ≥2 次才收（滤掉「王威吃/王威聊」这类「真名+后续字」一次性碎片）；
  //    2 字窗若被某个已收 3 字窗包含且频次不高于它，视为该名字的碎片吸收掉。
  //    排序 = 最近出现日期新→旧 主，次数多→少 次；existing 剔除；截断至 cap。
  const out = []
  const outNames = new Set()
  // [roster-filter v1] skipFilter=true 仅供 personNames 种子（AI 抽过，精度最高，沿用原直通）
  const push = function (it, skipFilter) {
    if (existing.has(it.name) || !validName(it.name) || outNames.has(it.name)) return
    if (!skipFilter) {
      if (hitEdgeStop(it.name) || hitNonnameWord(it.name)) return
      if (!it.strong) return
    }
    outNames.add(it.name)
    out.push({ name: it.name, count: it.count, lastDate: it.lastDate })
  }
  Object.keys(info3).forEach(function (w) {
    if (info3[w].count >= 2) push(info3[w])
  })
  Object.keys(info2).forEach(function (w) {
    const it = info2[w]
    let absorbed = false
    Object.keys(info3).forEach(function (k) {
      if (info3[k].count >= 2 && k.indexOf(w) !== -1 && it.count <= info3[k].count) absorbed = true
    })
    if (!absorbed) push(it)
  })
  seeds.forEach(function (w) {
    if (!validName(w)) return
    let count = 0
    let lastDate = ''
    list.forEach(function (d) {
      const text = String((d && d.content) || '')
      const dk = (d && d.dateKey) || ''
      if (!text) return
      let idx = text.indexOf(w)
      while (idx !== -1) {
        count++
        if (dk && dk > lastDate) lastDate = dk
        idx = text.indexOf(w, idx + w.length)
      }
    })
    if (count) push({ name: w, count: count, lastDate: lastDate }, true)
  })

  out.sort(function (a, b) {
    return String(b.lastDate).localeCompare(String(a.lastDate)) || b.count - a.count
  })
  return out.slice(0, Math.max(0, Number(cap) || 0))
}

// ===== [roster-filter v1] 满 100 触发一次 AI 复核（拍板：optimizeDiary 加 action + 静默剔除）=====
const REVIEW_KEY = 'yidengji_roster_review_done'

/** 是否需要 AI 复核：花名册已满且本轮未复核过 */
function needsAiReview() {
  try {
    if (wx.getStorageSync(REVIEW_KEY)) return false
    return getList().length >= MAX_ROSTER
  } catch (e) {
    return false
  }
}

/** 标记本轮 AI 复核已完成（成功后才标记，失败下次确认添加时重试） */
function markAiReviewDone() {
  try {
    wx.setStorageSync(REVIEW_KEY, Date.now())
    return true
  } catch (e) {
    return false
  }
}

/** AI 复核后只保留名单内的名字（静默剔除，返回删除条数） */
function keepOnly(keptNames) {
  const kept = new Set((Array.isArray(keptNames) ? keptNames : [])
    .map(function (n) { return String(n || '').trim() })
    .filter(Boolean))
  const cur = getList()
  const next = cur.filter(function (i) { return kept.has(i.name) })
  if (next.length === cur.length) return 0
  return write(next) ? (cur.length - next.length) : 0
}

module.exports = { getList, getNames, addNames, removeName, extractCandidates, validName, MAX_ROSTER, KEY, needsAiReview, markAiReviewDone, keepOnly, REVIEW_KEY }
