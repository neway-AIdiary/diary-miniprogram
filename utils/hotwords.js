// utils/hotwords.js
// 语音热词构建：供火山大模型流式语音识别的热词直传（request.corpus.context）。
// 官方能力：发音相近的词会优先识别为热词，最擅长人名/机构名/地名这类专名。
//
// 构建策略（用户设定）：
// 0. 编辑框已有文本中的词 —— 最高优先级（用户已写下，几乎必定会念到）。
//    解决典型问题：先写"王威"再口述"把王威改成王伟"——避免"王威"被听成"王微/王菲"。
// 1. 档案名词 —— 档案里的人名/机构名全部尝试装入
// 2. 近十天日记高频关键词补充 —— 复用 tags 引擎提取，按出现频次排序，
//    仅取出现 ≥2 次的「常说」词汇；不凑满预算
// 3. 总预算 100 tokens（火山上限 200，取一半防止截断）；超预算即停，保持词完整
//
// 缓存：基础词（档案 + 历史高频）按自然日缓存；context 热词每次按上下文重算（不缓存）。
//   草稿文本每次录音都可能不同，不能跨日复用。

const storage = require('./storage.js')
const tags = require('./tags.js')
const util = require('./util.js')

const STOP_WORDS = tags.STOP_WORDS || new Set()

// ctx 模块自维护的单字停用表（与 tags.STOP_WORDS 互不依赖，避免改动历史关键词引擎）
// 仅用于 getContextTerms：滤掉"今天和/王威约/王威在/在咖啡"这类包含虚词的句子片段
const SINGLE_STOP_CHARS = new Set((
  '的|了|着|过|在|于|从|到|向|和|与|及|或|也|还|就|才|只|并|又|已|曾|' +
  '我|你|您|他|她|它|们|这|那|谁|哪|呢|啊|吧|哦|嗯|嘛|呀|哈|' +
  '是|有|像|把|被|让|给|说|讲|叫|让|做|' +
  '上|下|里|外|中|前|后|左|右|来|去|出|进|回|' +
  '不|很|都|又|再|便|则|将|应|可|能|会|要'
).split('|'))

const TOKEN_BUDGET = 100   // 热词总 token 预算
const RECENT_DAYS = 10     // 回看近十天的日记
const MAX_WORD_LEN = 12    // 单个热词最大长度（超长多为误提取的叙述碎片）
const MIN_WORD_LEN = 2

// 按自然日缓存的"基础词"（archive + recent keyword），不含 ctx
let cache = { dateKey: '', baseWords: [], count: { archive: 0, keyword: 0 } }

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
 * 从单段文本中提取 2/3 字候选词（出现 ≥1 次即收，无频次门槛）。
 * 用途：把按住说话前输入框里"已存在"的内容里的词也喂给火山引擎，
 *      防止后续语音指令"将王威改成王伟，伟是伟大的为"把"王威"识别错（如"王微"），
 *      导致下游 AI 编辑时找不到匹配上下文。
 * 过滤规则与 keywordFreq 一致：纯中文 2/3 字滑窗、不跨标点、停用词过滤、
 *      三字词先于双字词、双字词不能嵌入已收录三字词。
 * 阈值 = 1（草稿是用户当下写出来的，不需要"频繁出现"才收）。
 * @param {string} text 草稿文本（一般为 textarea 的 content）
 * @returns {string[]} 候选词数组（顺序：3 字 → 2 字，按文本出现先后去重）
 */
function getContextTerms(text) {
  if (!text) return []
  const out = []
  const seen = new Set()
  const segs = String(text).split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
  segs.forEach(seg => {
    // 仅收 2 字候选：兼顾人名（王威/张三）这类 2 字专名精准命中；
    // 3 字短语（如"健身房"）由档案名或近十天高频词等其他来源覆盖。
    //   原因：3 字滑窗会切出"王威约/王威在"等带虚词的句子片段，
    //   反而吞掉真正想保住的 2 字专名（王威已被"王威约"吸收后丢失）。
    for (let i = 0; i < seg.length - 1; i++) {
      const w = seg.substr(i, 2)
      if (!/^[\u4e00-\u9fa5]{2}$/.test(w)) continue
      if (STOP_WORDS.has(w)) continue
      // 双字内部两个字都不能是单字停用字（过滤"约在/和王/和威"这种含虚词的句子片段）
      if (SINGLE_STOP_CHARS.has(w[0]) || SINGLE_STOP_CHARS.has(w[1])) continue
      if (!isValidWord(w)) continue
      if (seen.has(w)) continue
      seen.add(w); out.push(w)
    }
  })
  return out
}

/**
 * 仅构建"基础热词"（档案名词 + 近十天高频），不含草稿上下文。
 * 给按天缓存的 get() 使用。
 * @returns {{words: string[], count: {archive: number, keyword: number}}}
 */
function buildBase() {
  let budget = TOKEN_BUDGET
  const words = []
  const seen = new Set()
  const count = { archive: 0, keyword: 0 }

  const push = (w) => {
    w = String(w || '').trim()
    if (seen.has(w) || !isValidWord(w)) return true
    const cost = estTokens(w)
    if (cost > budget) return false
    budget -= cost
    seen.add(w)
    words.push(w)
    return true
  }

  // 1. 档案名词
  try {
    const archives = storage.getArchives() || []
    for (let i = 0; i < archives.length; i++) {
      if (push(archives[i] && archives[i].name)) count.archive++
    }
  } catch (e) {}

  // 2. 近十天日记高频关键词
  try {
    const cutoff = util.getDateKey(new Date(Date.now() - (RECENT_DAYS - 1) * 86400000))
    const diaries = storage.getAllDiaries() || []
    const recentContents = []
    diaries.forEach(d => {
      const dk = d && d.created_at ? util.getDateKey(new Date(d.created_at)) : ''
      if (dk && dk >= cutoff) recentContents.push(String((d && d.content) || ''))
    })
    if (recentContents.length) {
      const freq = keywordFreq(recentContents, seen)
      Object.keys(freq)
        .sort((a, b) => freq[b] - freq[a])
        .forEach(w => {
          if (push(w)) count.keyword++
        })
    }
  } catch (e) {}

  return { words, count }
}

/**
 * 构建热词列表（端到端版本：含草稿上下文 + 档案 + 近十天高频）。
 * 每次都重新算（ctx 来源不固定）；整段链路（upload→speechToText）使用。
 * @param {{contextText?: string}} [opts] 可选上下文：
 *   contextText —— 当前编辑框中的草稿文本（按"已写出的词"作为最高优先级热词来源）
 * @returns {{words: string[], count: {archive: number, keyword: number, context: number}}}
 */
function build(opts) {
  // 草稿上下文（最高优先级）：用户当下写出的词，识别置信度最高
  let ctxWords = []
  try { ctxWords = getContextTerms(opts && opts.contextText) } catch (e) {}
  const ctxSet = new Set(ctxWords)

  // 基础热词：档案 + 近十天高频（不强求 ctx 已被加进去，但 buildBase 自己按 seen 去重）
  // 这里让 base 部分知道 ctx 已占用预算，避免重复装入相同词。
  // 简化：buildBase 内部按"已 push 的"去重即可（ctx 不传给 buildBase，base 自然去重 base 内重复；ctx 与 base 间的去重在最后合并时做）
  const base = buildBase()
  const baseWithoutCtxOverlap = base.words.filter(w => !ctxSet.has(w))

  // 合并：ctx 优先 + base 补充；总预算需要重新计算——ctx 已经按 TOKEN_BUDGET 装一遍了，再装 base 会爆
  // 简化策略：ctx 不论预算全保留；base 部分预算重算（用 estTokens 重数），超则按原顺序截断。
  const ctxCost = ctxWords.reduce((s, w) => s + estTokens(w), 0)
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
 * 获取热词列表（基础词按自然日缓存，context 每次新算）
 * 流式链路在 WS 握手前调用；返回 ctx 优先 + base 去重的合并列表。
 * @param {boolean} [force] 是否强制重建（兼容旧签名）
 * @param {{contextText?: string}} [opts] 可选上下文：
 *   contextText —— 当前编辑框草稿文本，作为最高优先级热词来源
 * @returns {string[]}
 */
function get(force, opts) {
  const today = util.getDateKey(new Date())
  if (force || cache.dateKey !== today || !cache.baseWords.length && !cache.count.archive && !cache.count.keyword) {
    const base = buildBase()
    cache.baseWords = base.words
    cache.count = { archive: base.count.archive, keyword: base.count.keyword }
    cache.dateKey = today
  }
  // 拼接 ctx：ctx 每次新算（草稿文本会变），且 ctx 优先装在最前
  let ctxWords = []
  try { ctxWords = getContextTerms(opts && opts.contextText) } catch (e) {}
  const ctxSet = new Set(ctxWords)
  const baseExtras = cache.baseWords.filter(w => !ctxSet.has(w))
  return ctxWords.concat(baseExtras)
}

/** 获取最近一次构建的基础词数量统计（调试/日志用） */
function getLastCount() {
  return {
    archive: cache.count ? cache.count.archive : 0,
    keyword: cache.count ? cache.count.keyword : 0
  }
}

module.exports = { get, build, getContextTerms, getLastCount, estTokens, isValidWord, TOKEN_BUDGET }
