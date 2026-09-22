# -*- coding: utf-8 -*-
r"""
patch_person_hotword.py — [person-hotword v1] A' + D：人名沉淀 + 低优先热词填充

用户 2026-09-22 拍板：A' + D（如果要准），**不要牺牲录音弹框出现的时间作为代价**。

现状问题（hotwords.js#keywordFreq）：
  「近十天高频词」是纯字面 2/3 字滑窗 + **频次 ≥2** 门槛，它没有人名这个概念。
  只出现一次的人名（"今天和王威吃饭"）永远进不来；而人名恰恰是 ASR 最容易听错的东西。

本补丁做两件事：

  **A'（准确）** 保存日记时那次已有的 AI 实体抽取（optimizeDiary:extractEntities）
     顺手把所有出现的人名（**不要求被解释过**）单独返回一份 persons，客户端清洗后
     沉淀到本地人名表 utils/personNames.js；按住说话时直接取，把"猜"变成"已知"。
     · 云函数只做**格式级**清洗（长度/字符集/原文出现/去重）
     · 客户端做**语义级**清洗（复用 entityClean 的虚词/代词/时间词/数量词表）
     · 与备案弹窗**完全解耦**：entities 语义一字未动，persons 是独立字段；
       老云函数不返回 persons ⇒ 空数组 ⇒ 人名表不写入，既有行为零变化

  **D（克制）** 单次人名降为**低优先填充**：排在档案名词与 ≥2 次高频词**之后**，
     独立子预算 PERSON_SUB_BUDGET=30 token，只占主预算用不完的空余。
     人名收益（少听错一个名字）与误报代价（ASR 把普通词替换成名字）不对称 ⇒ 宁可少而准。

  **时序（用户硬约束）** 热词构建从 connectSocket **之前** 挪到 task.onOpen 之后：
     原位置是同步执行，会占住 JS 主线程、推迟「按住」后的第一帧渲染（= 录音浮层出现时间）。
     挪到 onOpen 后：connectSocket 立即发起、浮层立即渲染，构建耗时落在「握手完成 → 发首帧」之间。
     另在 warmup 里加延迟 800ms 的基底预热，首次按下的构建直接命中缓存。

用法：
  python patch_person_hotword.py --check        # 预检（唯一锚点 + 幂等判据）
  python patch_person_hotword.py --write        # 落盘（先备份）
  python patch_person_hotword.py --restore-src  # 仅还原源码（保留新建文件）
  python patch_person_hotword.py --restore      # 全部还原（含删除新建文件）
"""
import io
import os
import sys
import shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\person-hotword-backup-20260922'

CRLF = chr(13) + chr(10)
LF = chr(10)

# ============================================================
# 新建模块：utils/personNames.js
# ============================================================
NEW_PERSON_NAMES = r"""/**
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
"""

# ============================================================
# 各文件改动
# ============================================================
OPS = [
    # ================= cloudfunctions/optimizeDiary/index.js =================
    ('cloudfunctions/optimizeDiary/index.js', {
        'tag': 'A1 system prompt 增加 persons 附加任务',
        'sig': "'【附加任务 · 与上面的 entities 完全独立，不得互相影响】',",
        'old': r"""    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"entities":[{"name":"王磊","description":"我的大学同学","explanation":"他是我大学同学","type":"person"},{"name":"海洋大学","description":"我的母校","explanation":"这是我的母校","type":"place"}]}'
""",
        'new': r"""    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"entities":[{"name":"王磊","description":"我的大学同学","explanation":"他是我大学同学","type":"person"},{"name":"海洋大学","description":"我的母校","explanation":"这是我的母校","type":"place"}],"persons":["王磊","张三"]}',
    '',
    '【附加任务 · 与上面的 entities 完全独立，不得互相影响】',
    '无论是否被解释过，请另外把日记中出现的**所有人名**单独列进 persons 数组：',
    '1. 只要是人名就列（可以只是被提到，不需要任何解释）——例如"今天和张三吃饭"应列出"张三"；',
    '2. 每条 2~4 个字，必须是原文中**原样出现**的人名本体，不得改写、不得编造、不得从更长的词里截取；',
    '3. 不收地名、机构名、品牌名、称谓（如"老王""领导""同事""妈妈"）、代词、时间词；',
    '4. 不收并非人名的常见词语（如"周末""高兴""方式""出差"）；',
    '5. 没有把握的一律不收：宁可漏掉，也不要猜、不要编造；',
    '6. 没有则返回空数组 []。'
""",
    }),
    ('cloudfunctions/optimizeDiary/index.js', {
        'tag': 'A2 云函数新增 cleanPersons（格式级清洗）',
        'sig': '      const cleanPersons = (raw, content) => {',
        'old': r"""      const hasBlockedNameWord = (raw) => {
        const n = String(raw || '').trim()
        if (!n) return true
        if (NAME_BLOCK_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
        return NAME_BLOCK_WORDS.some(w => n.indexOf(w) !== -1)
      }
""",
        'new': r"""      const hasBlockedNameWord = (raw) => {
        const n = String(raw || '').trim()
        if (!n) return true
        if (NAME_BLOCK_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
        return NAME_BLOCK_WORDS.some(w => n.indexOf(w) !== -1)
      }
      // [person-hotword A'] 人名清洗：这里只做**格式级**清洗（长度/字符集/原文出现/去重），
      // 语义级清洗（虚词/代词/时间词/数量词表）交给客户端 utils/entityClean.js —— 那边有完整词表。
      // 人名与 entities 完全解耦：它只用于语音热词沉淀，不参与备案弹窗。
      const cleanPersons = (raw, content) => {
        const list = Array.isArray(raw) ? raw : []
        const text = String(content || '')
        const seenP = new Set()
        const out = []
        for (let i = 0; i < list.length; i++) {
          const n = String(list[i] == null ? '' : list[i]).trim()
          if (!n || n.length < 2) continue
          if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
          // 含「·」的译名/少数民族名放宽到 12 字；其余人名按 2~4 字
          if (n.indexOf('·') === -1 && n.length > 4) continue
          if (n.length > 12) continue
          if (seenP.has(n)) continue
          if (text.indexOf(n) === -1) continue
          if (hasBlockedNameWord(n)) continue
          seenP.add(n)
          out.push(n)
          if (out.length >= 20) break
        }
        return out
      }
""",
    }),
    ('cloudfunctions/optimizeDiary/index.js', {
        'tag': 'A3 return 带上 persons',
        'sig': 'persons: cleanPersons(r.parsed && r.parsed.persons, entContent)',
        'old': r"""      return { entities: entities }
""",
        'new': r"""      return { entities: entities, persons: cleanPersons(r.parsed && r.parsed.persons, entContent) }
""",
    }),

    # ================= utils/entityClean.js =================
    ('utils/entityClean.js', {
        'tag': 'B1 新增 isNonNounWord（复用既有词表做语义级否决）',
        'sig': 'function isNonNounWord(name) {',
        'old': r"""/**
 * 批量清理日记正文中的解释部分
 * @param {string} content 日记正文
""",
        'new': r"""/**
 * [person-hotword A'] 判断名称是否**明确不是名词本体**：虚词 / 代词 / 动词 / 形容词 /
 * 数量词 / 时间词前缀。只做「否决」不做「肯定」—— 复用本模块既有的全部词表与数量词规则，
 * 保证与备案链路同一口径（改一处两边同时变）。
 * 用途：AI 抽人名时的语义级过滤（人名比"被解释的名词"宽得多，所以这里只拦明确不是名字的）。
 * @param {string} name 待判定名称
 * @returns {boolean} true 表示应丢弃
 */
function isNonNounWord(name) {
  const n = String(name || '').trim()
  if (!n) return true
  if (n.length < 2 || n.length > 6) return true
  // 时间词前缀（「今天杨帆」这类正则过度捕获）
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return true
  }
  // 含助词/功能字
  for (let i = 0; i < FUNC_CHARS.length; i++) {
    if (n.indexOf(FUNC_CHARS[i]) !== -1) return true
  }
  // 数量词（一个 / 十斤 / 百分之一 / 第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return true
  // 虚词 / 代词 / 高频动词 / 高频形容词表
  if (NON_NOUN_WORDS.indexOf(n) !== -1) return true
  return false
}

/**
 * 批量清理日记正文中的解释部分
 * @param {string} content 日记正文
""",
    }),
    ('utils/entityClean.js', {
        'tag': 'B2 导出 isNonNounWord',
        'sig': 'hasCleanLeftBoundary, isNonNounWord }',
        'old': r"""module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary }
""",
        'new': r"""module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary, isNonNounWord }
""",
    }),

    # ================= utils/aiCloud.js =================
    ('utils/aiCloud.js', {
        'tag': 'C0 新增人名特有误报表（姓氏 + 常用字撞出的普通词）',
        'sig': 'const PERSON_FALSE_POSITIVES = [',
        'old': r"""const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么']
""",
        'new': r"""const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么']
// [person-hotword A'] 人名场景**特有**的高频误报：常见姓氏 + 常用字撞出来的普通词。
// 只用于人名清洗，**不动 entityClean 的既有词表**（备案链路零影响）。
// 与 entityClean.NON_NOUN_WORDS 允许重叠（冗余无害）：那张表是按"名词/虚词"分类的，
// 这张表是按"会不会被 AI 当人名"筛的，分类口径不同。
const PERSON_FALSE_POSITIVES = [
  '周末', '何必', '高兴', '王者', '张开', '白天', '金额', '来往',
  '和平', '和气', '安全', '安排', '马上', '金子', '李子', '果实'
]
""",
    }),
    ('utils/aiCloud.js', {
        'tag': 'C1 新增 cleanPersonNames + withPersons',
        'sig': 'function cleanPersonNames(raw, content) {',
        'old': r"""/**
 * AI 提取实体：从日记中识别"用户解释过的名词"及其解释，用于提示用户备案到档案
""",
        'new': r"""/**
 * [person-hotword A'] 人名清洗（客户端 · 语义级）：
 * 云函数只保证「格式合格 + 在原文出现」，这里再过一遍本地的虚词/代词/时间词/数量词表。
 * 误报的代价不是"多显示一个词"，而是 ASR 会把正常表达替换成热词里的名字 ⇒ 刻意保守，宁可漏。
 * @param {string[]} raw 云函数返回的 persons
 * @param {string} content 日记原文
 * @returns {string[]} 清洗后的人名（保序、去重、上限 20）
 */
function cleanPersonNames(raw, content) {
  const list = Array.isArray(raw) ? raw : []
  const text = String(content || '')
  const out = []
  const seen = new Set()
  for (let i = 0; i < list.length; i++) {
    const n = String(list[i] == null ? '' : list[i]).trim()
    if (!n || n.length < 2) continue
    if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
    const isTrans = n.indexOf('·') !== -1
    if (!isTrans && n.length > 4) continue
    if (n.length > 12) continue
    if (seen.has(n)) continue
    if (text.indexOf(n) === -1) continue                  // 必须在原文里真的出现（防 AI 编造）
    if (hasBlockedNameWord(n)) continue                   // 首字是叙述词 / 含连接词
    if (!isTrans && entityClean.isNonNounWord(n)) continue // 虚词/代词/动词/形容词/数量词/时间词
    seen.add(n)
    out.push(n)
    if (out.length >= 20) break
  }
  return out
}

/**
 * 把清洗后的人名挂到实体抽取结果上。
 * 兼容老云函数：不返回 persons ⇒ 空数组 ⇒ 人名表不写入（功能静默不生效，既有行为零变化）。
 * @param {{entities?:Array, from?:string, persons?:Array}} result
 * @param {string} text 日记原文
 * @returns {{entities:Array, from:string, persons:string[]}}
 */
function withPersons(result, text) {
  const r = result || {}
  return {
    entities: Array.isArray(r.entities) ? r.entities : [],
    from: r.from || 'local',
    persons: cleanPersonNames(r.persons, text)
  }
}

/**
 * AI 提取实体：从日记中识别"用户解释过的名词"及其解释，用于提示用户备案到档案
""",
    }),
    ('utils/aiCloud.js', {
        'tag': 'C1b cleanPersonNames 接入误报表',
        'sig': '    if (PERSON_FALSE_POSITIVES.indexOf(n) !== -1) continue',
        'old': r"""    if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
    const isTrans = n.indexOf('·') !== -1
""",
        'new': r"""    if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
    if (PERSON_FALSE_POSITIVES.indexOf(n) !== -1) continue  // 姓氏 + 常用字撞出来的普通词
    const isTrans = n.indexOf('·') !== -1
""",
    }),
    ('utils/aiCloud.js', {
        'tag': 'C2 wx.cloud 缺失分支也带 persons',
        'sig': "resolve(withPersons({ entities: localExtractExplainedEntities(text), from: 'local' }, text))",
        'old': r"""    if (!wx.cloud) {
      resolve({ entities: localExtractExplainedEntities(text), from: 'local' })
      return
    }
""",
        'new': r"""    if (!wx.cloud) {
      resolve(withPersons({ entities: localExtractExplainedEntities(text), from: 'local' }, text))
      return
    }
""",
    }),
    ('utils/aiCloud.js', {
        'tag': 'C3 finish 出口统一补 persons',
        'sig': '      // [person-hotword A2] 人名随结果一起返回',
        'old': r"""    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: { content: text.slice(0, 5000), action: 'extractEntities' }
    }).then(res => {
""",
        'new': r"""    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // [person-hotword A2] 人名随结果一起返回（已过本地语义清洗），供保存路径沉淀人名表。
      // 注意：aiCloud.js 里有 5 处同形的 finish，这里只改 extractEntities 这一处
      resolve(withPersons(result, text))
    }
    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: { content: text.slice(0, 5000), action: 'extractEntities' }
    }).then(res => {
""",
    }),
    ('utils/aiCloud.js', {
        'tag': 'C4 导出 cleanPersonNames',
        'sig': 'stripMoodTail, cleanPersonNames }',
        'old': r"""module.exports = { callAI, callAIParse, callAIExtractMetaBatch, callAITags, callAIOrganizeArchive, callAIExtractEntities, callAIMergeDiary, autoSegmentAfterSave, stripMoodTail }
""",
        'new': r"""module.exports = { callAI, callAIParse, callAIExtractMetaBatch, callAITags, callAIOrganizeArchive, callAIExtractEntities, callAIMergeDiary, autoSegmentAfterSave, stripMoodTail, cleanPersonNames }
""",
    }),

    # ================= pages/write/write.js =================
    ('pages/write/write.js', {
        'tag': 'D1 引入 personNames',
        'sig': "const personNames = require('../../utils/personNames.js')",
        'old': r"""const voice = require('../../utils/voice.js')
""",
        'new': r"""const voice = require('../../utils/voice.js')
const personNames = require('../../utils/personNames.js') // [person-hotword A'] 人名表沉淀
""",
    }),
    ('pages/write/write.js', {
        'tag': 'D2 保存路径沉淀人名（与备案弹窗解耦）',
        'sig': 'try { personNames.addNames(result.persons) } catch (e) {}',
        'old': r"""    req.then(result => {
      clearTimeout(timeout)
      if (resolved) return

      if (!result.entities || result.entities.length === 0) {
""",
        'new': r"""    req.then(result => {
      clearTimeout(timeout)
      if (resolved) return

      // [person-hotword A'] 沉淀人名表：与备案弹窗**完全独立** —— 无论用户是否勾选备案、
      // 甚至本次没有任何"被解释的名词"，只要 AI 认出了人名就存下来，供语音热词使用。
      // 只写本机 storage 几十字节，发生在**保存路径**，不占录音路径
      try { personNames.addNames(result.persons) } catch (e) {}

      if (!result.entities || result.entities.length === 0) {
""",
    }),

    # ================= utils/hotwords.js =================
    ('utils/hotwords.js', {
        'tag': 'E1 引入 personNames',
        'sig': "const personNames = require('./personNames.js')",
        'old': r"""const storage = require('./storage.js')
const tags = require('./tags.js')
const util = require('./util.js')
""",
        'new': r"""const storage = require('./storage.js')
const tags = require('./tags.js')
const util = require('./util.js')
const personNames = require('./personNames.js') // [person-hotword A'] 沉淀人名表
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E2 新增 PERSON_SUB_BUDGET',
        'sig': 'const PERSON_SUB_BUDGET = 30',
        'old': r"""const MIN_WORD_LEN = 2
""",
        'new': r"""const MIN_WORD_LEN = 2
// [person-hotword D] 「单次人名」独立子预算（token）：低优先填充，只占档案/高频词用不完的空余。
// 用户 2026-09-22 拍板 D —— 人名收益（少听错一个名字）与误报代价（ASR 把普通词替换成名字）
// 不对称，所以宁少而准，绝不挤掉主预算。
const PERSON_SUB_BUDGET = 30
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E3 lastPersonCount 调试计数',
        'sig': 'let lastPersonCount = 0',
        'old': r"""let cache = { dateKey: '', baseWords: [], count: { archive: 0, keyword: 0 } }
""",
        'new': r"""let cache = { dateKey: '', baseWords: [], count: { archive: 0, keyword: 0 } }
// 最近一次 get() 里「沉淀人名」实际注入的条数（仅日志/调试用；人名表随保存日记变化，故不进日缓存）
let lastPersonCount = 0
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E4 usedTokens 帮助函数',
        'sig': 'function usedTokens(list) {',
        'old': r"""  return Math.ceil(t)
}

function isValidWord(w) {
""",
        'new': r"""  return Math.ceil(t)
}

// 一组词的总 token 消耗（用于算「还剩多少预算给低优先来源」）
function usedTokens(list) {
  let s = 0
  for (let i = 0; i < (list ? list.length : 0); i++) s += estTokens(list[i])
  return s
}

function isValidWord(w) {
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E5 新增 getPersonExtras（D 级低优先填充）',
        'sig': 'function getPersonExtras(ctxSet, baseWords, free) {',
        'old': r"""/**
 * 构建热词列表（端到端版本：含草稿上下文 + 档案 + 近十天高频）。
""",
        'new': r"""/**
 * [person-hotword D] 从本地人名表取「单次人名」作为**低优先填充**（用户 2026-09-22 拍板 D）：
 *   · 排在档案名词与近十天高频词**之后**，只有它们装完还有剩余预算时才用；
 *   · 独立子预算 PERSON_SUB_BUDGET，避免把主预算吃光（否则会反向退化）；
 *   · 与已收录词（草稿 / 档案 / 高频）去重 —— 已经在高频词里的名字不必重复占位；
 *   · 读本地小表（几十条字符串），微秒级，不构成录音路径开销。
 * @param {Set<string>} ctxSet 草稿词集合
 * @param {string[]} baseWords 已收录的基础词
 * @param {number} free 剩余 token 预算
 * @returns {string[]}
 */
function getPersonExtras(ctxSet, baseWords, free) {
  const limit = Math.min(Number(free) || 0, PERSON_SUB_BUDGET)
  if (limit <= 0) return []
  let names = []
  try { names = personNames.getNames() || [] } catch (e) { return [] }
  const out = []
  let budget = limit
  for (let i = 0; i < names.length; i++) {
    const w = names[i]
    if (ctxSet && ctxSet.has(w)) continue
    if (baseWords && baseWords.indexOf(w) !== -1) continue
    if (!isValidWord(w)) continue
    const cost = estTokens(w)
    // 装不下就跳过（不 break：后面的短名字可能还装得下）
    if (cost > budget) continue
    budget -= cost
    out.push(w)
  }
  return out
}

/**
 * 构建热词列表（端到端版本：含草稿上下文 + 档案 + 近十天高频）。
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E6 get() 接线（人名只填空余）',
        'sig': 'const personExtras = getPersonExtras(ctxSet, baseExtras, TOKEN_BUDGET - usedTokens(ctxWords) - usedTokens(baseExtras))',
        'old': r"""  const ctxSet = new Set(ctxWords)
  const baseExtras = cache.baseWords.filter(w => !ctxSet.has(w))
  return ctxWords.concat(baseExtras)
}
""",
        'new': r"""  const ctxSet = new Set(ctxWords)
  const baseExtras = cache.baseWords.filter(w => !ctxSet.has(w))
  // [person-hotword D] 沉淀人名最低优先：只填空余（独立子预算），绝不挤掉档案与高频词
  const personExtras = getPersonExtras(ctxSet, baseExtras, TOKEN_BUDGET - usedTokens(ctxWords) - usedTokens(baseExtras))
  lastPersonCount = personExtras.length
  return ctxWords.concat(baseExtras, personExtras)
}
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E7 build() 接线（含 person 计数）',
        'sig': 'person: personExtras.length',
        'old': r"""  const ctxCost = ctxWords.reduce((s, w) => s + estTokens(w), 0)
  let budget = Math.max(0, TOKEN_BUDGET - ctxCost)
  const finalWords = ctxWords.slice()
  for (let i = 0; i < baseWithoutCtxOverlap.length; i++) {
    const w = baseWithoutCtxOverlap[i]
    const cost = estTokens(w)
    if (cost > budget) break
    budget -= cost
    finalWords.push(w)
  }

  return {
    words: finalWords,
    count: {
      archive: base.count.archive,
      keyword: base.count.keyword,
      context: ctxWords.length
    }
  }
}
""",
        'new': r"""  const ctxCost = ctxWords.reduce((s, w) => s + estTokens(w), 0)
  let budget = Math.max(0, TOKEN_BUDGET - ctxCost)
  const finalWords = ctxWords.slice()
  for (let i = 0; i < baseWithoutCtxOverlap.length; i++) {
    const w = baseWithoutCtxOverlap[i]
    const cost = estTokens(w)
    if (cost > budget) break
    budget -= cost
    finalWords.push(w)
  }

  // [person-hotword D] 沉淀人名：最低优先，只填「档案 + 高频」用不完的空余
  const personExtras = getPersonExtras(ctxSet, finalWords, budget)
  for (let i = 0; i < personExtras.length; i++) finalWords.push(personExtras[i])

  return {
    words: finalWords,
    count: {
      archive: base.count.archive,
      keyword: base.count.keyword,
      context: ctxWords.length,
      person: personExtras.length
    }
  }
}
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E8 getLastCount 带上 person',
        'sig': 'person: lastPersonCount',
        'old': r"""function getLastCount() {
  return {
    archive: cache.count ? cache.count.archive : 0,
    keyword: cache.count ? cache.count.keyword : 0
  }
}
""",
        'new': r"""function getLastCount() {
  return {
    archive: cache.count ? cache.count.archive : 0,
    keyword: cache.count ? cache.count.keyword : 0,
    person: lastPersonCount
  }
}
""",
    }),
    ('utils/hotwords.js', {
        'tag': 'E9 导出 PERSON_SUB_BUDGET',
        'sig': 'TOKEN_BUDGET, PERSON_SUB_BUDGET }',
        'old': r"""module.exports = { get, build, getContextTerms, getLastCount, estTokens, isValidWord, TOKEN_BUDGET }
""",
        'new': r"""module.exports = { get, build, getContextTerms, getLastCount, estTokens, isValidWord, TOKEN_BUDGET, PERSON_SUB_BUDGET }
""",
    }),

    # ================= utils/voice.js =================
    ('utils/voice.js', {
        'tag': 'F1 从 openSocket 移除热词构建（原来占住主线程）',
        'sig': '[hotword-off-critical-path v1] 热词构建已挪到 task.onOpen',
        'old': r"""  // 热词直传（按自然日缓存，构建为本地存储读取，毫秒级）：
  // 在 connectSocket 前构建，耗时落在建连等待期，不占录音关键路径。
  // 包含三段来源（高→低优先级）：
  //   ① 当前编辑框草稿里的词（currentContextText，按页面 onHoldStart 透传）
  //   ② 档案名词（按天缓存）
  //   ③ 近十天日记高频词（按天缓存）
  let hotwordList = []
  try {
    hotwordList = hotwords.get(false, { contextText: currentContextText })
    if (hotwordList.length) {
      const c = hotwords.getLastCount()
      console.log('[voice] 热词已注入:', hotwordList.length, '个（档案', c.archive, '+ 日记高频', c.keyword, '+ 草稿', '）')
    }
  } catch (e) { /* 热词构建失败不影响录音 */ }

""",
        'new': r"""  // [hotword-off-critical-path v1] 热词构建已挪到 task.onOpen（见下）：
  // 原先在 connectSocket **之前**同步构建，会占住 JS 主线程、推迟「按住」后第一帧渲染
  // ——那正是用户能看到的录音浮层。用户明确要求：不以牺牲浮层出现时间为代价。
  // 挪到 onOpen 后：connectSocket 立即发起、浮层立即渲染，
  // 构建耗时落在「WS 握手完成 → 发首帧」之间，录音与首帧音频帧都不受影响。

""",
    }),
    ('utils/voice.js', {
        'tag': 'F2 onOpen 内构建热词（发首帧前，但已不占浮层时间）',
        'sig': '[hotword-off-critical-path v1] 在此处（而非 connectSocket 之前）构建热词',
        'old': r"""    socketOpen = true
    // 首帧：full client request（JSON 参数）
""",
        'new': r"""    socketOpen = true
    // [hotword-off-critical-path v1] 在此处（而非 connectSocket 之前）构建热词：
    // 此刻录音已启动、浮层已渲染，构建耗时不再推迟任何用户可见的反馈；
    // 握手期间产出的音频帧已缓存在 pendingFrames，构建完再补发，不丢开头、不影响识别内容。
    // 四段来源（高→低优先级）：
    //   ① 当前编辑框草稿里的词（currentContextText，按页面 onHoldStart 透传）
    //   ② 档案名词（按天缓存）
    //   ③ 近十天日记高频词（按天缓存，出现 ≥2 次）
    //   ④ [person-hotword D] 沉淀人名（低优先填充，只占前三者用不完的空余）
    let hotwordList = []
    try {
      hotwordList = hotwords.get(false, { contextText: currentContextText })
      if (hotwordList.length) {
        const c = hotwords.getLastCount()
        console.log('[voice] 热词已注入:', hotwordList.length, '个（档案', c.archive, '+ 日记高频', c.keyword, '+ 人名', c.person || 0, '）')
      }
    } catch (e) { /* 热词构建失败不影响录音 */ }
    // 首帧：full client request（JSON 参数）
""",
    }),
    ('utils/voice.js', {
        'tag': 'F3 warmup 延迟预热热词基底（把构建耗时彻底移出关键路径）',
        'sig': '[hotword-off-critical-path v1] 预热热词基底',
        'old': r"""            getAsrConfig().then(() => resolve(true), () => resolve(false))
""",
        'new': r"""            getAsrConfig().then(() => {
              // [hotword-off-critical-path v1] 预热热词基底（档案 + 近十天高频，按天缓存）：
              // 延迟 800ms 跑，避开页面首屏渲染；这样首次按下的 onOpen 构建直接命中缓存，
              // 连「握手完成 → 发首帧」那一小段也不再承担扫描开销。
              setTimeout(() => {
                try { hotwords.get(false, { contextText: '' }) } catch (e) {}
              }, 800)
              resolve(true)
            }, () => resolve(false))
""",
    }),

    # ================= tools/test_voice_start.js =================
    ('tools/test_voice_start.js', {
        'tag': 'G1 wx mock 补 storage API（热词链路会读本地表）',
        'sig': '  getStorageSync: (k) => store[k],',
        'old': r"""function makeWx(opts) {
  opts = opts || {}
  const calls = { cloud: 0, auth: 0, socketOpen: 0, socketClose: 0, recorderStart: [], setting: 0 }
""",
        'new': r"""// 本机 storage 桩（[person-hotword v1] 起热词链路会读人名表/日记分片）
const store = {}

function makeWx(opts) {
  opts = opts || {}
  const calls = { cloud: 0, auth: 0, socketOpen: 0, socketClose: 0, recorderStart: [], setting: 0 }
""",
    }),
    ('tools/test_voice_start.js', {
        'tag': 'G2 mock 挂 storage 方法',
        'sig': '    setStorageSync: (k, v) => { store[k] = v },',
        'old': r"""    connectSocket: (o) => { calls.socketTask = task; return task },
""",
        'new': r"""    connectSocket: (o) => { calls.socketTask = task; return task },
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
""",
    }),
]

# ============================================================
# 框架
# ============================================================


def load(rel):
    p = os.path.join(ROOT, rel)
    with io.open(p, 'rb') as f:
        raw = f.read().decode('utf-8')
    crlf = CRLF in raw
    text = raw.replace(CRLF, LF)
    return raw, text, crlf


def save(rel, text, crlf):
    p = os.path.join(ROOT, rel)
    out = text.replace(LF, CRLF) if crlf else text
    with io.open(p, 'wb') as f:
        f.write(out.encode('utf-8'))


def do_backup(rel):
    src = os.path.join(ROOT, rel)
    dst = os.path.join(BACKUP, rel.replace('/', os.sep))
    d = os.path.dirname(dst)
    if not os.path.isdir(d):
        os.makedirs(d)
    # [幂等备份] 已存在就不覆盖：多次 --write 时必须保留**最早**（补丁前）的版本，
    # 否则 --restore 会还原成「中间态」。本补丁踩过这个坑：第二次 --write（补 C0/C1b 时）
    # 只有 aiCloud.js 是 dirty，干净备份被半成品覆盖 ⇒ 红灯自检跑的是
    # 「新 aiCloud + 旧 entityClean」⇒ 调用不存在的函数而崩溃。
    if os.path.isfile(dst):
        return
    if os.path.isfile(src):
        shutil.copy2(src, dst)


def new_file_state(rel, content):
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p):
        return 'PENDING'
    with io.open(p, 'rb') as f:
        cur = f.read().decode('utf-8')
    return 'SKIP' if cur.replace(CRLF, LF) == content else 'ERR_NEW_DIFF'


def run(mode):
    do_write = (mode == '--write')
    counts = {'OK': 0, 'SKIP': 0, 'PENDING': 0, 'ERR': 0}
    cache = {}

    for rel, op in OPS:
        if rel not in cache:
            raw, text, crlf = load(rel)
            cache[rel] = {'text': text, 'crlf': crlf, 'dirty': False, 'backed': False}
        ent = cache[rel]
        text = ent['text']
        sig = op['sig']
        old = op['old']
        if sig in text:
            st = 'SKIP'
        else:
            n = text.count(old)
            if n == 1:
                ent['text'] = text.replace(old, op['new'], 1)
                ent['dirty'] = True
                st = 'OK'
            elif n == 0:
                st = 'ERR_ANCHOR_MISSING'
            else:
                st = 'ERR_ANCHOR_DUP(%d)' % n
        key = 'ERR' if st.startswith('ERR') else st
        counts[key] += 1
        print('[%s] %s -> %s' % (mode, rel + ' :: ' + op['tag'], st))

    # 新文件
    for rel, content in [('utils/personNames.js', NEW_PERSON_NAMES)]:
        st = new_file_state(rel, content)
        if st == 'PENDING' and do_write:
            p = os.path.join(ROOT, rel)
            if not os.path.isdir(os.path.dirname(p)):
                os.makedirs(os.path.dirname(p))
            with io.open(p, 'wb') as f:
                f.write(content.replace(LF, CRLF).encode('utf-8'))
            st = 'OK'
        key = 'ERR' if st.startswith('ERR') else st
        counts[key] += 1
        print('[%s] %s -> %s' % (mode, rel + ' :: 新增模块', st))

    # 写盘（每文件只在全部 op 处理完后写一次）
    if do_write:
        for rel, ent in cache.items():
            if ent['dirty']:
                do_backup(rel)
                save(rel, ent['text'], ent['crlf'])
                print('[write] %s 已落盘（已备份到 %s）' % (rel, BACKUP))

    print('RESULT: OK=%d SKIP=%d PENDING=%d ERR=%d' % (
        counts['OK'], counts['SKIP'], counts['PENDING'], counts['ERR']))
    return 1 if counts['ERR'] else 0


def restore(include_new):
    files = sorted(set([rel for rel, _ in OPS]))
    for rel in files:
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        if not os.path.isfile(src):
            print('[restore] 缺备份 %s' % rel)
            continue
        dst = os.path.join(ROOT, rel)
        shutil.copy2(src, dst)
        print('[restore] %s' % rel)
    if include_new:
        for rel in ['utils/personNames.js']:
            p = os.path.join(ROOT, rel)
            if os.path.isfile(p):
                os.remove(p)
                print('[restore] 删除新建 %s' % rel)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--check':
        sys.exit(run('--check'))
    elif mode == '--write':
        sys.exit(run('--write'))
    elif mode == '--restore-src':
        restore(False)
    elif mode == '--restore':
        restore(True)
    else:
        print('用法: --check | --write | --restore-src | --restore')
