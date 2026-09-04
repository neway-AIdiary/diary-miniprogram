/**
 * utils/nameMatch.js
 * 备案名词优先匹配：语音识别结果中与备案名词同音（拼音相同，忽略声调）的字词，
 * 优先替换为备案中的名词写法。
 *   例：备案有「王维」，语音识别成「王伟」→ 自动更正为「王维」
 *       语音识别成拼音「wang wei」→ 同样更正为「王维」
 *
 * 匹配规则：
 *   1. 汉字同音替换：文本中与备案名词等长、逐字同音（多音字读音取交集）的纯汉字片段
 *   2. 拼音串替换：文本中空格分隔（或连写）的拉丁拼音串，逐字与备案名词拼音一致
 *   3. 发音接近的模糊替换（精确匹配失败后启用）：
 *      拼音字母相似度（1 - 编辑距离/最大长度）≥ 80%，且逐字声母相同或属于易混声母对
 *      （l/n、f/h、zh/z、ch/c、sh/s），覆盖发音不标准的场景（前后鼻音、平翘舌等）
 *      例：备案「王新伟」，识别为「wangxingwei」或「王兴卫」→ 更正为「王新伟」
 *      「王伟」不会误换成「王磊」（声母 w/l 不同，不算发音接近）
 *
 * 全部本地计算，不依赖网络；汉字只做等长替换，不改变句子其余部分。
 */

const PY = require('./pinyinDict.js')

// 拼音字母相似度阈值（用户要求：重复度高于 80%）
const FUZZY_THRESHOLD = 0.8

// 拉丁字母串（含空格分隔的多个词）
const LATIN_RUN = /[a-zA-Z]+(?:[ \t]+[a-zA-Z]+)*/g

// 单字读音集合缓存
const pyCache = {}

/**
 * 取单字的全部无声调读音（数组），未知字返回 null
 */
function readingsOf(ch) {
  if (pyCache[ch] !== undefined) return pyCache[ch]
  const v = PY[ch]
  const arr = v ? v.split(',') : null
  pyCache[ch] = arr
  return arr
}

/**
 * 判断片段 seg 是否与备案名词 name 逐字同音（多音字取读音交集；同字不算）
 * seg 与 name 等长、均为纯汉字
 */
function samePronunciation(seg, name) {
  for (let i = 0; i < name.length; i++) {
    if (seg[i] === name[i]) continue
    const a = readingsOf(seg[i])
    const b = readingsOf(name[i])
    if (!a || !b) return false
    let hit = false
    for (let p = 0; p < a.length && !hit; p++) {
      if (b.indexOf(a[p]) !== -1) hit = true
    }
    if (!hit) return false
  }
  return true
}

/**
 * 编辑距离（Levenshtein）
 */
function levenshtein(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  let prev = new Array(m + 1)
  let cur = new Array(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const t = prev; prev = cur; cur = t
  }
  return prev[m]
}

/**
 * 拼音字母相似度：1 - 编辑距离/最大长度（1=完全一致）
 */
function pinyinSimilarity(a, b) {
  a = String(a || '').toLowerCase()
  b = String(b || '').toLowerCase()
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/**
 * 发音接近判断（模糊匹配）：seg 与 name 等长、均为纯汉字。需同时满足：
 *   1. 全拼串拼音字母相似度 ≥ 80%（多音字取读音组合，任一组合达标即可）
 *      例：王兴卫(wangxingwei) vs 王新伟(wangxinwei) → 0.91 命中（前后鼻音）
 *   2. 逐字声母兼容：声母相同，或属于易混声母对（l/n、f/h、zh/z、ch/c、sh/s、r/l）
 *      例：王伟(wei) vs 王磊(lei) 字母重复度 85%，但声母 w/l 不同 → 不命中（不同的人）
 *          张三(san) vs 长安(zhangan) → 不命中
 */
function fuzzyPronunciation(seg, name) {
  // 逐字声母兼容（必要条件，先做，快速排除）
  for (let i = 0; i < name.length; i++) {
    if (!charInitialsCompatible(seg[i], name[i])) return false
  }
  const segPys = stringPinyinVariants(seg, 16)
  const namePys = stringPinyinVariants(name, 64)
  if (segPys.length === 0 || namePys.length === 0) return false
  for (const a of segPys) {
    for (const b of namePys) {
      const m = Math.max(a.length, b.length)
      if (Math.abs(a.length - b.length) > 0.2 * m) continue
      if (pinyinSimilarity(a, b) >= FUZZY_THRESHOLD) return true
    }
  }
  return false
}

// 易混声母对（地域口音常见混淆），其余声母不同视为发音不同
const CONFUSABLE_INITIALS = {
  l: 'n', n: 'l', f: 'h', h: 'f',
  z: 'zh', zh: 'z', c: 'ch', ch: 'c', s: 'sh', sh: 's', r: 'l'
}

/**
 * 取音节声母（zh/ch/sh 为双字母声母，零声母返回 ''）
 */
function syllableInitial(sy) {
  if (!sy) return ''
  if (sy.length >= 2 && (sy[0] === 'z' || sy[0] === 'c' || sy[0] === 's') && sy[1] === 'h') {
    return sy.slice(0, 2)
  }
  return sy.charAt(0)
}

function initialsCompatible(a, b) {
  if (a === b) return true
  return CONFUSABLE_INITIALS[a] === b
}

/**
 * 两个字是否存在读音组合声母兼容（多音字任一组合命中即可）
 */
function charInitialsCompatible(chSeg, chName) {
  if (chSeg === chName) return true
  const a = readingsOf(chSeg)
  const b = readingsOf(chName)
  if (!a || !b) return false
  for (let p = 0; p < a.length; p++) {
    for (let q = 0; q < b.length; q++) {
      if (initialsCompatible(syllableInitial(a[p]), syllableInitial(b[q]))) return true
    }
  }
  return false
}

/**
 * 一段汉字的完整拼音串（全部多音字组合，超量截断）
 * 例：王新伟 → ['wangxinwei']；长安 → ['changan','zhangan']
 * 未知字返回空数组
 */
function stringPinyinVariants(str, cap) {
  let combos = ['']
  for (let i = 0; i < str.length; i++) {
    const rs = readingsOf(str[i])
    if (!rs) return []
    const next = []
    for (let c = 0; c < combos.length && next.length < cap; c++) {
      for (let r = 0; r < rs.length && next.length < cap; r++) {
        next.push(combos[c] + rs[r])
      }
    }
    combos = next
  }
  return combos
}

/**
 * 备案名词的完整拼音串（全部多音字组合，超量截断）
 * 例：王新伟 → ['wangxinwei']
 */
function namePinyinVariants(name) {
  return stringPinyinVariants(name, 64)
}

/**
 * 全部拼音音节集合（供拉丁拼音串切分），惰性构建
 */
let syllables = null
function allSyllables() {
  if (syllables) return syllables
  const set = new Set()
  for (const ch in PY) {
    PY[ch].split(',').forEach(p => {
      if (p.length >= 2) set.add(p)
    })
  }
  // 按长度降序，贪心切分时长音节优先
  syllables = Array.from(set).sort((a, b) => b.length - a.length)
  return syllables
}

/**
 * 把无空格的拉丁串切成恰好 n 个音节（回溯），失败返回 null
 */
function splitSyllables(str, n) {
  const s = str.toLowerCase()
  const result = []
  const tryFrom = (pos, left) => {
    if (pos === s.length) return left === 0
    if (left === 0) return false
    for (const sy of allSyllables()) {
      if (s.startsWith(sy, pos)) {
        result.push(sy)
        if (tryFrom(pos + sy.length, left - 1)) return true
        result.pop()
      }
    }
    return false
  }
  if (!tryFrom(0, n)) return null
  return result
}

/**
 * 拉丁词的拼音是否在单字读音集合中
 */
function wordMatchesChar(word, ch) {
  const b = readingsOf(ch)
  if (!b) return false
  return b.indexOf(word.toLowerCase()) !== -1
}

/**
 * 判断一个拉丁段（可能含空格）是否与备案名词逐字拼音一致
 * @returns {boolean}
 */
function latinMatchesName(run, name) {
  const words = run.trim().split(/[ \t]+/)
  if (words.length === name.length) {
    // 空格分词：逐词逐字比对
    for (let i = 0; i < name.length; i++) {
      if (!wordMatchesChar(words[i], name[i])) return false
    }
    return true
  }
  if (words.length === 1 && !/[ \t]/.test(run)) {
    // 连写拼音串：回溯切成 name.length 个音节再逐字比对
    const parts = splitSyllables(words[0], name.length)
    if (!parts) return false
    for (let i = 0; i < name.length; i++) {
      if (!wordMatchesChar(parts[i], name[i])) return false
    }
    return true
  }
  return false
}

/**
 * 收集拉丁段内可作为替换目标的候选片段（带原文起止位置）：
 *   - 整段（去空格连写后比对）
 *   - 连续若干个词的窗口（应对拉丁段中混有其他词，如「wang xing wei and then」）
 */
function buildLatinCandidates(run, runOffset) {
  const wordInfos = []
  const re = /[a-zA-Z]+/g
  let wm
  while ((wm = re.exec(run)) !== null) {
    wordInfos.push({ word: wm[0], start: wm.index, end: wm.index + wm[0].length })
  }
  const cands = []
  // 整段
  cands.push({
    start: runOffset,
    end: runOffset + run.length,
    join: wordInfos.map(w => w.word).join('').toLowerCase()
  })
  // 连续词窗口（整段已含，跳过全窗口）
  for (let w = 1; w < wordInfos.length && w <= 6; w++) {
    for (let i = 0; i + w <= wordInfos.length; i++) {
      if (i === 0 && i + w === wordInfos.length) continue
      cands.push({
        start: runOffset + wordInfos[i].start,
        end: runOffset + wordInfos[i + w - 1].end,
        join: wordInfos.slice(i, i + w).map(x => x.word).join('').toLowerCase()
      })
    }
  }
  return cands
}

/**
 * 拉丁候选片段与备案名词的声母兼容校验：
 *   候选能切成 name.length 个音节 → 逐音节比声母（与名词各字读音的声母兼容）；
 *   切不出（本就不是规整拼音，如漏字母）→ 不做声母限制（字母相似度已达标）
 */
function latinInitialsOk(join, name) {
  const parts = splitSyllables(join, name.length)
  if (!parts) return true
  for (let i = 0; i < name.length; i++) {
    let hit = false
    const rs = readingsOf(name[i])
    if (!rs) return false
    for (const r of rs) {
      if (initialsCompatible(syllableInitial(parts[i]), syllableInitial(r))) { hit = true; break }
    }
    if (!hit) return false
  }
  return true
}

/**
 * 在一个拉丁段中找备案名词命中：
 *   先精确（逐字拼音一致），再模糊（拼音字母相似度 ≥ FUZZY_THRESHOLD + 声母兼容，取相似度最高者）
 * @returns {null | {name:string, start:number, end:number, sim:number}}
 */
function findLatinHit(run, runOffset, uniq) {
  // 1) 精确：整段逐字拼音一致
  for (const name of uniq) {
    if (latinMatchesName(run, name)) {
      return { name: name, start: runOffset, end: runOffset + run.length, sim: 1 }
    }
  }
  // 2) 模糊：整段或连续词窗口，拼音字母相似度达标
  const cands = buildLatinCandidates(run, runOffset)
  let best = null
  for (const name of uniq) {
    const pys = namePinyinVariants(name)
    if (pys.length === 0) continue
    for (const py of pys) {
      const L = py.length
      for (const c of cands) {
        const J = c.join.length
        // 相似度 ≥ 0.8 要求编辑距离 ≤ 0.2*maxLen，长度差不可能超过该值 → 预筛
        if (Math.abs(J - L) > 0.2 * Math.max(J, L)) continue
        const sim = pinyinSimilarity(c.join, py)
        if (sim < FUZZY_THRESHOLD) continue
        // 声母不同的（如 wangwei vs wanglei）不算发音接近
        if (!latinInitialsOk(c.join, name)) continue
        if (!best || sim > best.sim ||
            (sim === best.sim && name.length > best.name.length)) {
          best = { name: name, start: c.start, end: c.end, sim: sim }
        }
      }
    }
  }
  return best
}

/**
 * 备案名词优先匹配（核心入口）
 * @param {string} text 语音识别出的文本
 * @param {Array<{name:string}>} archives 档案列表（用 name 字段）
 * @returns {{text:string, replaced:Array<{from:string,to:string}>}}
 *   replaced 记录每一处替换（from=原文片段, to=备案名词）
 */
function matchArchives(text, archives) {
  let result = String(text || '')
  const replaced = []
  if (!result) return { text: result, replaced: replaced }

  // 参与匹配的备案名词：2-6 字纯汉字，长名优先（避免「王磊磊」被「王磊」抢先占位）
  const names = (Array.isArray(archives) ? archives : [])
    .map(a => String((a && a.name) || '').trim())
    .filter(n => /^[\u4e00-\u9fa5]{2,6}$/.test(n))
  const uniq = Array.from(new Set(names)).sort((a, b) => b.length - a.length)
  if (uniq.length === 0) return { text: result, replaced: replaced }

  // 1) 汉字同音替换（等长替换，不移动索引）—— 先精确，全部名词过完再模糊
  for (const name of uniq) {
    for (let i = 0; i + name.length <= result.length; i++) {
      const seg = result.substr(i, name.length)
      if (seg === name) { i += name.length - 1; continue }
      if (!/^[\u4e00-\u9fa5]+$/.test(seg)) continue
      if (samePronunciation(seg, name)) {
        result = result.slice(0, i) + name + result.slice(i + name.length)
        replaced.push({ from: seg, to: name })
        i += name.length - 1
      }
    }
  }

  // 1b) 汉字模糊替换：发音接近（拼音字母相似度 ≥ 80% + 声母兼容，如前后鼻音/平翘舌）
  //     本身已是备案名词的片段跳过（精确匹配已确定写法，避免被其他名词的模糊规则二次改写）
  const nameSet = new Set(uniq)
  for (const name of uniq) {
    for (let i = 0; i + name.length <= result.length; i++) {
      const seg = result.substr(i, name.length)
      if (seg === name || nameSet.has(seg)) { i += name.length - 1; continue }
      if (!/^[\u4e00-\u9fa5]+$/.test(seg)) continue
      if (fuzzyPronunciation(seg, name)) {
        result = result.slice(0, i) + name + result.slice(i + name.length)
        replaced.push({ from: seg, to: name })
        i += name.length - 1
      }
    }
  }

  // 2) 拉丁拼音串替换（如识别结果直接是 wang wei / wangxingwei）
  //    精确（逐字拼音一致）优先，其次模糊（相似度 ≥ 80%）；需重新收集（上一步可能已改动文本）
  let latinText = result
  let guard = 0
  while (guard++ < 20) {
    const m = LATIN_RUN.exec(latinText)
    if (!m) break
    const hit = findLatinHit(m[0], m.index, uniq)
    if (hit) {
      const from = latinText.slice(hit.start, hit.end)
      latinText = latinText.slice(0, hit.start) + hit.name + latinText.slice(hit.end)
      replaced.push({ from: from, to: hit.name })
      LATIN_RUN.lastIndex = hit.start + hit.name.length
    }
  }

  return { text: latinText, replaced: replaced }
}

module.exports = { matchArchives, samePronunciation, fuzzyPronunciation, pinyinSimilarity }
