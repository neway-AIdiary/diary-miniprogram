/**
 * utils/personNames.js
 * [person-hotword A'] 本地人名表 —— 把「AI 在日记里认出的人名」沉淀下来，供语音热词使用。
 *
 * 为什么需要：
 *   hotwords.js 的「近十天高频词」是纯字面滑窗 + 频次 ≥2 门槛，它没有人名这个概念。
 *   只出现一次的人名（「今天和王威吃饭」）永远进不来，而人名恰恰是 ASR 最容易听错的东西。
 *   这里把「猜」变成「已知」：保存日记时那一次 AI 实体抽取顺手把人名存下来，
 *   按住说话时直接取，喂给火山引擎做热词加权。
 *
 * 三条硬约束：
 *   ① **只在保存路径写入**（异步 AI 回调里），按住说话路径**只读** ——
 *      读一个几十条的字符串数组是微秒级，绝不阻塞录音浮层的出现；
 *   ② 上限 60 条，超额按「最近出现在日记里」淘汰（LRU，新名字排最前）；
 *   ③ 全本机存留、不上传云端；提供 clear() 供隐私清理。
 *
 * 已知取舍：清空日记（storage.clearAllDiaries）不会连带清理本表 ——
 *   两者刻意不耦合（避免为了一个小功能去动容量闸门链路）。热词只是加权，
 *   残留旧人名不会造成功能故障，最坏是 ASR 稍微偏爱这些名字。
 */

const KEY = 'person_names_v1'
const MAX_NAMES = 60

/** 读取人名表；任何脏数据一律当空表返回，绝不抛错 */
function getNames() {
  try {
    const raw = wx.getStorageSync(KEY)
    if (!Array.isArray(raw)) return []
    const out = []
    const seen = new Set()
    for (let i = 0; i < raw.length; i++) {
      const n = String(raw[i] == null ? '' : raw[i]).trim()
      // 读取路径同样做一次格式校验：存储被外部写脏（数字 / null / ASCII / 超长）时不污染热词
      if (n.length < 2 || n.length > 12) continue
      if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
      if (seen.has(n)) continue
      seen.add(n)
      out.push(n)
      if (out.length >= MAX_NAMES) break
    }
    return out
  } catch (e) {
    return []
  }
}

/** 写入底层（失败静默，绝不抛） */
function write(names) {
  try {
    wx.setStorageSync(KEY, names)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 沉淀一批人名（保存日记时调用）。
 * 去重：已在表中的名字**只提升优先级、不重复存**（挪到最前）。
 * @param {string[]} list AI 抽出的（已清洗）人名
 * @returns {number} 本次**新增**的条数（已存在的名字不计）
 */
function addNames(list) {
  if (!Array.isArray(list) || !list.length) return 0
  const cur = getNames()
  const incoming = []
  for (let i = 0; i < list.length; i++) {
    const n = String(list[i] == null ? '' : list[i]).trim()
    if (!n || n.length < 2 || n.length > 12) continue
    if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
    if (incoming.indexOf(n) !== -1) continue
    incoming.push(n)
  }
  if (!incoming.length) return 0

  let added = 0
  for (let i = 0; i < incoming.length; i++) {
    if (cur.indexOf(incoming[i]) === -1) added++
  }
  // 新名字排最前，旧名字保持原有相对顺序，整体截到上限
  const rest = cur.filter(function (n) { return incoming.indexOf(n) === -1 })
  const next = incoming.concat(rest).slice(0, MAX_NAMES)
  return write(next) ? added : 0
}

/** 清空人名表（隐私清理 / 调试） */
function clear() {
  return write([])
}

module.exports = { getNames, addNames, clear, MAX_NAMES, KEY }
