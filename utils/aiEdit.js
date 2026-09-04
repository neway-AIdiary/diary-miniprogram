/**
 * utils/aiEdit.js
 * 语音/手写输入指令识别：把「不是王磊，是王伟」这类口语化指令，转成对日记正文的修改操作。
 * 采用轻量规则引擎（本地即时生效，不依赖网络/AI服务），覆盖常见修改表达：
 *   1. 替换：不是X，是Y / 把X改成Y / 将X改为Y / X写错了，应该是Y / X改为Y（裸指令，如「北京改为北京朝阳区」）...
 *      替换目标自动剥掉「文中所有/所有/全部/每个」等量词（「把文中所有小王变成老王」→ 小王→老王 全局替换）
 *   2. 插入：在X前边加上Y / X后面加Y / 在X之前插入Y ...
 *   3. 删除：把X删掉 / 去掉X / 删除X ...（同上剥量词，删除后清理悬空标点）
 *   4. 按位置删句：删除最后一句话 / 去掉第一句 / 把最后一句话删掉 / 删除倒数第二句 / 删掉结尾两句 ...
 * 若正文中找不到目标词，返回 reason:'notFound'，由调用方提示用户。
 */

const REPLACE_PATTERNS = [
  // 不是X，是Y（可带“应该/就是/其实/才”等口语词，Y 后可带句号叹号）
  // 分隔符也认空格：语音识别常把逗号识别成空格
  /^不是(.{1,30})[，,、\s]+(?:应该|就是|其实|才)?是(.{1,30})[。！!？?]?$/,
  // 把X改成Y / 将X改为Y / 把X换成Y / 把X调整成Y ...
  /^(?:把|将)(.{1,30})(?:改|换|变|调整|修改|更正|更)(?:成|为|做)(.{1,30})[。！!]?$/,
  // X写错了，应该是Y / X记错了，是Y
  /^(.{1,30})(?:写错|记错|说错|弄错|打错)了[，,、\s]*(?:应该|就是|其实)?是(.{1,30})[。！!？?]?$/
]

// 语音宽松替换识别：识别结果常不带任何标点，「不是X是Y」也认。
// 收紧条件降低误判：X≥2字且 X/Y 均不含标点和「是」字（排除「不只是朋友是兄弟」这类叙述句）
const LOOSE_REPLACE_PATTERNS = [
  // 语音「不是X是Y」（无逗号）
  /^不是([^，,、。！!？?\s是]{2,8})是([^，,、。！!？?\s是]{1,10})[。！!？?]?$/,
  // 语音「X写错了是Y」（无逗号）
  /^([^，,、。！!？?\s]{2,8})(?:写错|记错|说错|弄错|打错)了是([^，,、。！!？?\s]{1,10})[。！!？?]?$/,
  // 语音「X应该是Y / X应该改成Y」（无逗号）
  /^([^，,、。！!？?\s是]{2,8})应该(?:是|改成|换成)([^，,、。！!？?\s是]{1,10})[。！!？?]*$/
]

// 裸替换指令（不带「把/将」前缀的口语表达）：X改为Y / X改成Y / X换成Y / X更改为Y
// 如「北京改为北京朝阳区」「暖风习习改成凉风阵阵」。
// 收紧条件防误判：X≥2字且不含标点/空格/「改/换」字，Y不含标点空格；
// 找不到目标词时（apply 返回 notFound）调用方按普通叙述保留，不会破坏正文。
const BARE_REPLACE_PATTERNS = [
  /^([^，,、。！!？?\s改换]{2,8}?)(?:更改为|修改为|更正为|替换为|换成|变成|改为|改成|调整为|调整成|变更为)([^，,、。！!？?\s]{1,20})[。！!？?]?$/
]

const REMOVE_PATTERNS = [
  // 把X删掉 / 将X去掉 / 把X划掉
  /^(?:把|将)(.{1,30})(?:删除|删去|删掉|去掉|移除|划掉|清除|删)(?:掉|了)?[。！!？]?$/,
  // 删除X / 去掉X / 移除X（长动词在前：否则「删除X」只匹配「删」、把「除」吃进目标词）
  /^(?:删除|删掉|删去|去掉|移除|清除|删)(?:掉|了)?(.{1,30})[。！!？?]?$/
]

// 在X前边加上Y / 在X后面添加Y / 在X之前插入Y
// 「在」必选：避免「我之前加入了一个读书会」这类普通日记句被误判为插入指令；
// 动词也只认明确词（加上/添加/插入…），不认裸「加/添」
const INSERT_PATTERNS = [
  /^在(.{1,30}?)(前边|前面|之前|后边|后面|之后)(?:加上|添加|添上|插入|加入|补上|添加上)(.{1,30})[。！!？?]?$/
]

// 按位置删句：删除最后一句话 / 去掉第一句 / 把最后一句话删掉 / 删掉结尾两句 / 删除倒数第二句 ...
// pos 词映射：最后/末尾/结尾/倒数第N → 结尾方向；第一/开头/最前/首 → 开头方向
// 结构：动词在前（删除X）或动词在后（把X删掉 / X删掉），X = 位置词 + 数量 + 句/句话/句子
// 位置词 → {pos, offset}：pos 方向 + 距边界的偏移（倒数第N句 = 结尾方向偏移 N-1）
// 注意：SENT_POS_WORDS 中的位置词是捕获组（m[1]），数量词为 m[2]
const SENT_POS_WORDS = '(倒数第[一二三两]|最后|末尾|结尾|开头|第一|首个|首句|最前|头一)'
const SENT_REMOVE_PATTERNS = [
  // 动词在前：删除最后一句话 / 删掉第一句 / 去掉结尾两句 / 删了开头一句
  new RegExp('^(?:删除|删掉|删去|去掉|移除|清除|划掉|删)(?:掉|了)?(?:正文中|文中|正文|文章|日记|内容)?的?' + SENT_POS_WORDS + '(一|两|二|三|[1-9])?个?(?:句子|句话|句)话?[。！!？?]?$'),
  // 动词在后：把最后一句话删掉 / 将第一句删了 / 最后一句话去掉
  new RegExp('^(?:把|将)?(?:正文中|文中|正文|文章|日记|内容)?的?' + SENT_POS_WORDS + '(一|两|二|三|[1-9])?个?(?:句子|句话|句)话?(?:都)?(?:删掉|删除|删去|去掉|移除|清除|划掉|删)(?:掉|了)?[。！!？?]?$')
]

// 位置词 → {pos, offset}：pos 方向 + 距边界的偏移（倒数第N句 = 结尾方向偏移 N-1）
function parseSentPos(word) {
  if (!word) return null
  if (word.indexOf('倒数第') === 0) {
    const n = word.slice(3)
    const num = n === '一' ? 1 : n === '二' ? 2 : n === '三' ? 3 : parseInt(n, 10)
    if (!num || num < 1) return null
    return { pos: 'last', offset: num - 1 }
  }
  if (word === '最后' || word === '末尾' || word === '结尾') return { pos: 'last', offset: 0 }
  return { pos: 'first', offset: 0 }
}

// 数量词 → 数字（默认 1）
function parseSentCount(word) {
  if (!word) return 1
  if (word === '一') return 1
  if (word === '两' || word === '二') return 2
  if (word === '三') return 3
  const n = parseInt(word, 10)
  return n > 0 ? Math.min(n, 5) : 1
}

// 剥离替换/删除目标词中的量词前缀（文中所有/所有/全部/每个）与后缀（都/全部）
// 后缀剥离需保证剩余 ≥2 字，避免「成都」被误剥成「成」
function stripQuantifier(w) {
  if (!w) return w
  let s = String(w).trim()
  s = s.replace(/^(?:正文中|正文里|文中|文章中|文章里|正文|文章|日记中|日记里|内容中|内容里)?的?(?:所有|全部|每一个|每个)/, '')
  const t = s.replace(/(?:全部|所有|都)$/, '')
  if (t.length >= 2) s = t
  return s
}

/**
 * 识别输入文本是否为修改指令
 * @param {string} text 语音/手写输入的内容
 * @param {{loose?:boolean}} [opts] loose=true 时启用语音宽松识别（识别结果常不带标点）
 * @returns {null | {type:'replace'|'remove'|'insert'|'removeSent', from?:string, to?:string, at?:string, pos?:string, text?:string, count?:number, offset?:number}}
 *   - 返回 null 表示不是修改指令（调用方按普通追加处理）
 *   - type='replace'：把正文中所有 from 替换为 to（from 自动剥掉「文中所有/所有/全部」等量词）
 *   - type='remove' ：把正文中所有 from 删除（同上剥量词）
 *   - type='insert' ：在 at 前面/后面插入 text
 *   - type='removeSent'：按位置删句（pos:'last'|'first'，count 句数，offset 距边界偏移）
 */
function detect(text, opts) {
  if (!text || typeof text !== 'string') return null
  const t = text.trim()
  if (!t) return null
  const loose = !!(opts && opts.loose)

  const replacePatterns = loose
    ? REPLACE_PATTERNS.concat(BARE_REPLACE_PATTERNS, LOOSE_REPLACE_PATTERNS)
    : REPLACE_PATTERNS.concat(BARE_REPLACE_PATTERNS)
  for (const re of replacePatterns) {
    const m = t.match(re)
    if (!m) continue
    const from = stripQuantifier(m[1].trim())
    const to = m[2].trim()
    if (!from || !to || from === to) return null
    return { type: 'replace', from: from, to: to }
  }

  for (const re of INSERT_PATTERNS) {
    const m = t.match(re)
    if (!m) continue
    const at = m[1].trim()
    const posWord = m[2]
    const ins = m[3].trim()
    if (!at || !ins) return null
    return { type: 'insert', at: at, pos: posWord[0] === '前' ? 'before' : 'after', text: ins }
  }

  // 按位置删句（先于词删除判断，否则「删除最后一句话」会被当成删词「最后一句话」）
  for (const re of SENT_REMOVE_PATTERNS) {
    const m = t.match(re)
    if (!m) continue
    const posInfo = parseSentPos(m[1])
    if (!posInfo) continue
    return { type: 'removeSent', pos: posInfo.pos, offset: posInfo.offset, count: parseSentCount(m[2]) }
  }

  for (const re of REMOVE_PATTERNS) {
    const m = t.match(re)
    if (!m) continue
    const from = stripQuantifier((m[1] || m[2] || '').trim())
      .replace(/[。！!？?…\s]+$/g, '')      // 语音识别常在目标词后带句号，避免把句号吃进目标词导致找不到
    if (!from) return null
    return { type: 'remove', from: from }
  }

  return null
}

// ===== 标点无关模糊匹配（AI 智能兜底）=====
// 语音识别常在指令目标词中间插进逗号/空格（「去掉王磊在南京」→「去掉王磊，在南京」），
// 导致目标词与正文精确匹配失败。此兜底：忽略标点后再匹配一次。
// 匹配时忽略的字符：各类中英文标点、空白（不含匹配边界语义，仅用于对齐）
var FUZZY_IGNORE = '，,、。．!！?？；;：:…·~～-_"\'「」『』（）()《》<>[]【】'

function isFuzzyIgnorable(ch) {
  var c = ch.charCodeAt(0)
  return c === 32 || c === 9 || c === 10 || c === 13 || FUZZY_IGNORE.indexOf(ch) !== -1
}

// 去掉目标词中的标点（含语音误插的逗号），得到纯文本针
function stripPunct(s) {
  let out = ''
  const t = String(s || '')
  for (let i = 0; i < t.length; i++) {
    if (!isFuzzyIgnorable(t[i])) out += t[i]
  }
  return out
}

/**
 * 在 text 中找出所有与 target「忽略标点后相同」的片段
 * @returns {Array<{start:number, end:number}>} 原文下标区间（end 不含），按出现顺序
 */
function fuzzyFindAll(text, target) {
  const needle = stripPunct(target)
  if (!needle) return []
  const t = String(text || '')
  const spans = []
  let i = 0
  while (i < t.length) {
    if (isFuzzyIgnorable(t[i])) { i++; continue }
    // 从 i 起尝试匹配 needle（跳过 text 中的标点）
    let j = i
    let k = 0
    let lastMatchEnd = i
    while (j < t.length && k < needle.length) {
      if (t[j] === needle[k]) { j++; k++; lastMatchEnd = j }
      else if (isFuzzyIgnorable(t[j])) { j++ }
      else break
    }
    if (k === needle.length) {
      spans.push({ start: i, end: j })
      i = j
    } else {
      i = (k > 0 ? lastMatchEnd : i) + 1
    }
  }
  return spans
}

/**
 * 应用修改指令到正文
 * @param {string} content 当前日记正文
 * @param {object} edit detect() 返回的指令
 * @returns {{content:string, changed:boolean, reason?:string, highlightWord?:string, count?:number}}
 *   reason='notFound' 表示正文中找不到目标词
 *   highlightWord：新正文中需要高亮展示的词（供调用方做修改结果高亮）
 *   count：replace/remove 实际处理的处数（供「优化要点」提示）
 */
function apply(content, edit) {
  const text = String(content || '')
  if (!edit) return { content: text, changed: false }

  if (edit.type === 'removeSent') {
    const sentences = splitSentences(text)
    if (!sentences.length) return { content: text, changed: false, reason: 'notFound' }
    const n = Math.max(1, Math.min(edit.count || 1, sentences.length))
    if (edit.pos === 'last') {
      const off = Math.max(0, edit.offset || 0)
      sentences.splice(Math.max(0, sentences.length - off - n), n)
    } else {
      sentences.splice(Math.max(0, edit.offset || 0), n)
    }
    return { content: sentences.join(''), changed: true, count: n }
  }

  if (edit.type === 'insert') {
    if (!edit.at || !edit.text) return { content: text, changed: false }
    let idx = text.indexOf(edit.at)
    let atLen = edit.at.length
    if (idx === -1) {
      // 标点无关兜底：正文里的锚点可能被语音标点干扰（如「在，南京」）
      const spans = fuzzyFindAll(text, edit.at)
      if (!spans.length) {
        return { content: text, changed: false, reason: 'notFound' }
      }
      idx = spans[0].start
      atLen = spans[0].end - spans[0].start
    }
    // 只在第一处 at 前面/后面插入
    const insPos = edit.pos === 'before' ? idx : idx + atLen
    const newContent = text.slice(0, insPos) + edit.text + text.slice(insPos)
    return { content: newContent, changed: true, highlightWord: edit.text }
  }

  if (!edit.from) return { content: text, changed: false }

  // 统一走标点无关匹配（精确匹配是它的特例）：正文里同一目标词可能
  // 一处带标点一处不带（「王磊，在南京…后来王磊在南京」），两处都应命中
  const spans = fuzzyFindAll(text, edit.from)
  if (!spans.length) {
    return { content: text, changed: false, reason: 'notFound' }
  }

  // 从后往前替换/删除，避免前面的改动影响后面的下标
  let out = text
  if (edit.type === 'remove') {
    for (let i = spans.length - 1; i >= 0; i--) {
      out = out.slice(0, spans[i].start) + out.slice(spans[i].end)
    }
    // 删除后清理残留标点：连续分隔符合并、悬空分隔符去掉
    out = out
      .replace(/([。！？!?…\n])[，,、；;]\s*/g, '$1')               // 句末标点后紧跟的分隔符清理
      .replace(/([，,、；;])\s*([，,、；;])(\s*)/g, '$1$3')       // 连续分隔符合并
      .replace(/[，,、]\s*(?=[。！？!?…\n]|$)/g, '')              // 句末/行尾悬空分隔符
      .replace(/^[，,、]\s*/, '')                                  // 行首悬空分隔符
    return { content: out, changed: true, count: spans.length }
  }

  // replace：同样从后往前
  const to = edit.to || ''
  for (let i = spans.length - 1; i >= 0; i--) {
    out = out.slice(0, spans[i].start) + to + out.slice(spans[i].end)
  }
  return { content: out, changed: true, highlightWord: to, count: spans.length }
}

// ===== 按句拆分：支持一段输入/正文中混合多条指令 =====

/**
 * 按句切分文本（以 。！？!?\n 结句，保留分隔符与换行）
 */
function splitSentences(text) {
  const parts = String(text || '').split(/([。！？!?\n])/)
  const sentences = []
  let buf = ''
  for (const p of parts) {
    if (p === undefined || p === '') continue
    buf += p
    if (/^[。！？!?\n]$/.test(p)) {
      sentences.push(buf)
      buf = ''
    }
  }
  if (buf) sentences.push(buf)
  return sentences
}

// 单句去掉首尾空白与结尾标点后做指令识别
function detectSentence(sentence, opts) {
  const core = String(sentence || '').trim().replace(/[。！!？?…\s]+$/g, '')
  return core ? detect(core, opts) : null
}

/**
 * 把一段输入按句拆分为「指令 + 普通叙述」
 * 用于语音/手写混合输入（可多轮、每轮多条）：
 *   指令句逐条执行，普通句照常追加到日记末尾
 * @param {string} text 输入内容
 * @param {{loose?:boolean}} [opts] 透传给 detect：语音输入用宽松识别
 * @returns {{commands:Array, narrative:string}}
 */
function splitCommands(text, opts) {
  const commands = []
  let narrative = ''
  for (const s of splitSentences(text)) {
    const edit = detectSentence(s, opts)
    if (edit) commands.push(edit)
    else narrative += s
  }
  return { commands: commands, narrative: narrative.trim() }
}

/**
 * 从日记正文中提取并执行内嵌的增删改指令（手写正文场景，点 AI 优化时触发）
 * 指令句会从正文中移除（不作为日记内容保留），修改直接作用到其余正文
 * @returns {{content:string, applied:Array<{edit:Object,result:Object}>, notFound:Array, changed:boolean}}
 *   notFound 中的指令找不到目标词，对应句子按普通叙述保留（可能是误判的叙述句）
 */
function extractEmbedded(content) {
  let narrative = ''
  const applied = []
  const notFound = []
  for (const s of splitSentences(content)) {
    const edit = detectSentence(s)
    if (!edit) { narrative += s; continue }
    const res = apply(narrative, edit)
    if (res.changed) {
      narrative = res.content
      applied.push({ edit: edit, result: res })
    } else {
      notFound.push(edit)
      narrative += s
    }
  }
  return { content: narrative, applied: applied, notFound: notFound, changed: applied.length > 0 }
}

module.exports = { detect, apply, splitCommands, extractEmbedded }
