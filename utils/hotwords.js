// utils/hotwords.js
// 语音热词构建：供火山大模型流式语音识别的热词直传（request.corpus.context）。
// 官方能力：发音相近的词会优先识别为热词，最擅长人名/机构名/地名这类专名。
//
// 构建策略（用户设定）：
// 1. 档案名词优先 —— 档案里的人名/机构名全部尝试装入
// 2. 近十天日记高频关键词补充 —— 复用 tags 引擎提取，按出现频次排序，
//    仅取出现 ≥2 次的「常说」词汇；不凑满预算
// 3. 总预算 100 tokens（火山上限 200，取一半防止截断）；超预算即停，保持词完整
//
// 缓存：按自然日缓存，当天只构建一次（本地存储读取，毫秒级，不拖慢录音启动）。

const storage = require('./storage.js')
const tags = require('./tags.js')
const util = require('./util.js')

const STOP_WORDS = tags.STOP_WORDS || new Set()

const TOKEN_BUDGET = 100   // 热词总 token 预算
const RECENT_DAYS = 10     // 回看近十天的日记
const MAX_WORD_LEN = 12    // 单个热词最大长度（超长多为误提取的叙述碎片）
const MIN_WORD_LEN = 2

// 按自然日缓存
let cache = { dateKey: '', words: [], count: { archive: 0, keyword: 0 } }

// token 估算：中文字按 1.5 计（偏保守，防止服务端按实际 tokenizer 截断）、
// ASCII 每 2 字符计 1
function estTokens(word) {
  let t = 0
  for (let i = 0; i < word.length; i++) {
    if (/[\u4e00-\u9fa5]/.test(word[i])) t += 1.5
    else t += 0.5
  }
  return Math.ceil(t)
}

function isValidWord(w) {
  if (!w) return false
  if (w.length < MIN_WORD_LEN || w.length > MAX_WORD_LEN) return false
  // 仅收中文/英文/数字（·用于外国人名），拒绝标点、emoji、空格
  if (!/^[A-Za-z0-9\u4e00-\u9fa5·]+$/.test(w)) return false
  // 纯数字无热词价值
  if (/^[0-9]+$/.test(w)) return false
  return true
}

/**
 * 构建热词列表（同步，本地数据，毫秒级）
 * @returns {{words: string[], count: {archive: number, keyword: number}}}
 */
function build() {
  let budget = TOKEN_BUDGET
  const words = []
  const seen = new Set()
  const count = { archive: 0, keyword: 0 }

  const push = (w) => {
    w = String(w || '').trim()
    if (seen.has(w) || !isValidWord(w)) return true // 无效词跳过但不中断后续尝试
    const cost = estTokens(w)
    if (cost > budget) return false                 // 超预算：保持词完整，直接停
    budget -= cost
    seen.add(w)
    words.push(w)
    return true
  }

  // 1. 档案名词（优先）
  try {
    const archives = storage.getArchives() || []
    for (let i = 0; i < archives.length; i++) {
      if (push(archives[i] && archives[i].name)) count.archive++
    }
  } catch (e) { /* 档案读取失败不影响关键词 */ }

  // 2. 近十天日记高频关键词（不凑满预算）
  try {
    const cutoff = util.getDateKey(new Date(Date.now() - (RECENT_DAYS - 1) * 86400000))
    const diaries = storage.getAllDiaries() || []
    const recentContents = []
    diaries.forEach(d => {
      // 日记实体只有 created_at（ISO 字符串），换算成日期 key 再比较
      const dk = d && d.created_at ? util.getDateKey(new Date(d.created_at)) : ''
      if (dk && dk >= cutoff) recentContents.push(String((d && d.content) || ''))
    })
    if (recentContents.length) {
      const fullText = recentContents.join(' ')
      const freq = keywordFreq(recentContents, seen)
      Object.keys(freq)
        .sort((a, b) => freq[b] - freq[a])
        .forEach(w => {
          if (push(w)) count.keyword++
        })
    }
  } catch (e) { /* 日记读取失败不影响已收档案词 */ }

  return { words: words, count: count }
}

/**
 * 近十天日记关键词频次统计：
 * ① 2/3 字滑窗统计（覆盖「健身房/咖啡馆」这类非主题词典的日常高频词），仅保留出现 ≥2 次；
 * ② 优先三字词——三字词收录后，其内含的双字片段不再重复收录（避免「健身房+健身+身房」浪费预算）；
 * ③ 停用词过滤（复用 tags 引擎的 STOP_WORDS）。
 * @param {string[]} contents 近十天日记正文列表
 * @param {Set<string>} alreadySet 已收录的词（档案名词），其子串跳过
 * @returns {Object<string, number>} 词 → 出现次数
 */
function keywordFreq(contents, alreadySet) {
  const freq2 = {}
  const freq3 = {}

  // 按标点/空白切段，滑窗不跨标点
  contents.forEach(text => {
    const segs = text.split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
    segs.forEach(seg => {
      for (let i = 0; i < seg.length - 1; i++) {
        const w = seg.substr(i, 2)
        if (!/[\u4e00-\u9fa5]{2}/.test(w) || !/^[\u4e00-\u9fa5]{2}$/.test(w)) continue
        if (STOP_WORDS.has(w)) continue
        freq2[w] = (freq2[w] || 0) + 1
      }
      for (let i = 0; i < seg.length - 2; i++) {
        const w = seg.substr(i, 3)
        if (!/^[\u4e00-\u9fa5]{3}$/.test(w)) continue
        // 三字词内含停用双字（如「的时候」）则丢弃
        if (STOP_WORDS.has(w.substr(0, 2)) || STOP_WORDS.has(w.substr(1, 2))) continue
        freq3[w] = (freq3[w] || 0) + 1
      }
    })
  })

  const out = {}
  const absorbed = new Set()
  // 三字词优先（长词信息量更高）
  Object.keys(freq3).forEach(w => {
    if (freq3[w] >= 2) {
      out[w] = freq3[w]
      absorbed.add(w.substr(0, 2))
      absorbed.add(w.substr(1, 2))
    }
  })
  // 双字词补充：未被三字词吸收、非停用词、不是已收录词的子串（如档案名「王新伟」不再收「王新」）
  Object.keys(freq2).forEach(w => {
    if (absorbed.has(w) || freq2[w] < 2) return
    if (alreadySet && alreadySet.has(w)) return
    let subOfSelected = false
    if (alreadySet) {
      alreadySet.forEach(sel => {
        if (sel.indexOf(w) !== -1) subOfSelected = true
      })
    }
    if (!subOfSelected) out[w] = freq2[w]
  })
  return out
}

/**
 * 获取热词列表（按自然日缓存）
 * @param {boolean} force 是否强制重建
 */
function get(force) {
  const today = util.getDateKey(new Date())
  if (force || cache.dateKey !== today) {
    cache = build()
    cache.dateKey = today
  }
  return cache.words
}

/** 获取最近一次构建的数量统计（调试/日志用） */
function getLastCount() {
  return { archive: cache.count ? cache.count.archive : 0, keyword: cache.count ? cache.count.keyword : 0 }
}

module.exports = { get, getLastCount, estTokens, isValidWord, TOKEN_BUDGET }
