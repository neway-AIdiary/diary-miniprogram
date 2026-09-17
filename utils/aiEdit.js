/**
 * utils/aiEdit.js
 * 语音/手写输入指令识别：把「不是王磊，是王伟」这类口语化指令，转成对日记正文的修改操作。
 * 采用轻量规则引擎（本地即时生效，不依赖网络/AI服务），覆盖常见修改表达：
 *   1. 替换：不是X，是Y / 把X改成Y / 将X改为Y / X写错了，应该是Y / X改为Y（裸指令，如「北京改为北京朝阳区」）...
 *      替换目标自动剥掉「文中所有/所有/全部/每个」等量词（「把文中所有小王变成老王」→ 小王→老王 全局替换）
 *      范围限定：目标词前可加范围词，把全局改动收窄到指定一处/句——
 *        「把第一个40分钟替换成50分钟」「把倒数第二个小王删掉」「第一句的40分钟替换成50分钟」
 *        「把最后一句里的小王删掉」；范围词由 extractScope 剥离，写入 edit.scope 供 apply 挑选命中
 *        相对范围词（2026-09-17）：以上一句/前两句/这句话锚定「指令之前」的范围——
 *        「把上一句的40分钟替换成50分钟」「删掉前边两句」「把这两句里的开心删掉」；
 *        「前边所有内容」= 作用域全范围，可用于替换/插入，禁止用于删除（否则一次删掉整篇）
 *      句界（2026-09-17）：定位「第几句」与「按位置删句」走宽口径——任何标点都断句
 *        （「早上很堵，我开车去公司，晴天。」= 三句话）；指令句扫描仍走窄口径（只认。！？与换行），
 *        避免逗号分句后把叙述的半个分句当指令解析
 *      数字等价（2026-09-17）：阿拉伯与中文数字视为同一内容——「30」=「三十」、「第3处」=「第三处」
 *   2. 插入：在X前边加上Y / X后面加Y / 在X之前插入Y ...
 *   3. 删除：把X删掉 / 去掉X / 删除X ...（同上剥量词，删除后清理悬空标点）
 *   4. 按位置删句：删除最后一句话 / 去掉第一句 / 把最后一句话删掉 / 删除倒数第二句 / 删掉结尾两句 ...
 * 若正文中找不到目标词，返回 reason:'notFound'，由调用方提示用户。
 */

const REPLACE_PATTERNS = [
  // 不是X，是Y（可带“应该/就是/其实/才”等口语词，Y 后可带句号叹号）
  // 分隔符也认空格：语音识别常把逗号识别成空格
  /^不是(.{1,30})[，,、\s]+(?:应该|就是|其实|才)?是(.{1,30})[。！!？?]?$/,
  // 把X改成Y / 将X改为Y / 把X换成Y / 把X替换成Y / 把X更换成Y / 把X调整成Y ...
  // X 必须懒惰匹配：贪婪回溯会让「替换成」里的「换成」抢先当动词、把「替」吃进目标词
  // （「把40分钟替换成50分钟」→ 误找「40分钟替」）；多字动词必须排在单字前面
  /^(?:把|将)(.{1,30}?)(?:替换|更换|调整|修改|更正|变更|改|换|变|更)(?:成|为|做)(.{1,30})[。！!]?$/,
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
  /^([^，,、。！!？?\s是]{2,8}?)应该(?:是|改成|换成|替换成)([^，,、。！!？?\s是]{1,10})[。！!？?]*$/
]

// 裸替换指令（不带「把/将」前缀的口语表达）：X改为Y / X改成Y / X换成Y / X更改为Y
// 如「北京改为北京朝阳区」「暖风习习改成凉风阵阵」。
// 收紧条件防误判：X≥2字且不含标点/空格/「改/换/该」字（该：防「应该换成」把「应该」吃进目标词），Y不含标点空格；
// 找不到目标词时（apply 返回 notFound）调用方按普通叙述保留，不会破坏正文。
const BARE_REPLACE_PATTERNS = [
  /^([^，,、。！!？?\s改换该]{2,8}?)(?:更改为|修改为|更正为|替换为|替换成|更换成|更改成|换成|变成|改为|改成|调整为|调整成|变更为)([^，,、。！!？?\s]{1,20})[。！!？?]?$/
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
// 相对指代（2026-09-17）：上一 / 上 / 前边 / 前面 / 之前 / 这 —— 都相对「作用域末尾」
// 长词必须排在短词前（「上一」先于「上」），否则「上两句」会被剥成「上」+ 残留
const SENT_POS_WORDS = '(倒数第[一二三两]|上一|前边|前面|之前|最后|末尾|结尾|这|开头|第一|首个|首句|最前|头一|上)'
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
  // 相对指代：上一句 / 前边两句 / 这两句 = 相对于作用域末尾（等价「最后 N 句」）
  if (word === '上一' || word === '上' || word === '前边' ||
      word === '前面' || word === '之前' || word === '这') return { pos: 'last', offset: 0 }
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
  // 「所有的X」里的「的」属量词一部分，一并剥掉（剩余 ≥2 字才剥，避免把「花」这类单字暴露成宽泛搜索词）
  s = s.replace(/^(?:正文中|正文里|文中|文章中|文章里|正文|文章|日记中|日记里|内容中|内容里)?的?(?:所有|全部|每一个|每个)(?:的(?=.{2,}$))?/, '')
  const t = s.replace(/(?:全部|所有|都)$/, '')
  if (t.length >= 2) s = t
  return s
}

// 是否等于「前边所有内容 / 所有内容」这类无具体目标词的整段指代
// 用于拦截「把前边所有内容删掉」——一次删掉整篇不可逆（2026-09-17 决策 3.A）
function isAllScopeTarget(w) {
  return /^(?:正文中|正文里|文中|文章里|文章中|日记里|日记中|内容里|内容中)?的?(?:前边|前面|之前|上面|以上)?(?:的)?(?:所有|全部|一切)(?:的)?(?:内容|文字|正文|话语|部分)?(?:里头|里面|里边|之中|里|中|内)?的?$/.test(String(w || '').trim())
}

// ===== 范围限定：把「全文所有命中」收窄到指定一处 / 指定一句（2026-09-17）=====
// 用户在目标词前加范围词即可：
//   把第一个40分钟替换成50分钟   → 只改第 1 处「40分钟」
//   把倒数第二个小王删掉        → 只删倒数第 2 处「小王」
//   第一句的40分钟替换成50分钟   → 只改第 1 句里的「40分钟」
//   把最后一句里的小王删掉       → 只删最后一句里的「小王」
//   删除第一句的第二个小王       → 句范围与处范围可叠加
// 范围词从目标词前面剥掉，结果写入 edit.scope：
//   { sentence: 2 }     正数 = 从前往后第 n 句；负数 = 从后往前第 n 句（-1 = 最后一句）
//   { occurrence: -1 }  正数 = 从前往后第 n 处；负数 = 从后往前第 n 处（-1 = 最后一处）
// 剥完没有目标词（如「把第一个换成第二个」）则不做范围解析，保持原有行为。
const SCOPE_NUM = '[一二两三四五六七八九十0-9]{1,3}'
// 范围词可带的前缀：只/仅、在、文中/正文中…、的
const SCOPE_PRE = '(?:只|仅|要)?(?:在)?(?:正文中|正文里|文中|文章里|文章中|日记里|日记中|内容里|内容中)?的?'
// 句范围词后必须跟着「的/里/中…」：否则「第一句话」是目标词本身（如「把第一句话改成…」）
const SCOPE_POST = '(?:里头|里面|里边|之中|中的|里的|里|中|内|的)'

// 相对范围词（2026-09-17 决策 4.A）：以「指令之前已累积的正文」末尾为基准
//   上一句/前一句/这句话   → tail:1（等价「最后一句」）
//   上两句/前边两句/这两句  → tail:N
//   前边所有内容           → all:true
const SCOPE_TAIL_RES = [
  [new RegExp('^' + SCOPE_PRE + '(?:上一|上|前边|前面|之前|上面|这)([一二两三四五六七八九十0-9]{1,2})?句话?' + SCOPE_POST), 1, 1]
]
// 「前边所有内容」类：必须带「前边/前面/之前/上面/以上」或「内容/文字/正文」，
// 否则会和量词「所有的X」（= 全文所有命中）混淆，把全局替换误收窄成单处
const SCOPE_ALL_RES = [
  [new RegExp('^' + SCOPE_PRE + '(?:前边|前面|之前|上面|以上)(?:的)?(?:所有|全部|一切)(?:的)?(?:内容|文字|正文|话语|部分)?(?:里头|里面|里边|之中|里的|里|中|内)?的?'), 0, 1],
  [new RegExp('^' + SCOPE_PRE + '(?:所有|全部|一切)(?:的)?(?:内容|文字|正文|部分)(?:里头|里面|里边|之中|里的|里|中|内)?的?'), 0, 1]
]

const SCOPE_SENT_RES = [
  [new RegExp('^' + SCOPE_PRE + '第(' + SCOPE_NUM + ')句话?' + SCOPE_POST), 1, 1],
  [new RegExp('^' + SCOPE_PRE + '倒数第(' + SCOPE_NUM + ')句话?' + SCOPE_POST), 1, -1],
  [new RegExp('^' + SCOPE_PRE + '(?:最后|最末|末尾|结尾)一?句话?' + SCOPE_POST), 0, -1],
  [new RegExp('^' + SCOPE_PRE + '(?:首|头一|开头那?一?)句话?' + SCOPE_POST), 0, 1]
]

const SCOPE_OCC_RES = [
  [new RegExp('^' + SCOPE_PRE + '第(' + SCOPE_NUM + ')(?:个|处|次)(?:出现)?的?'), 1, 1],
  [new RegExp('^' + SCOPE_PRE + '倒数第(' + SCOPE_NUM + ')(?:个|处|次)(?:出现)?的?'), 1, -1],
  [new RegExp('^' + SCOPE_PRE + '(?:最后|最末|末尾|结尾)一?(?:个|处|次)(?:出现)?的?'), 0, -1],
  [new RegExp('^' + SCOPE_PRE + '(?:首|头一)个(?:出现)?的?'), 0, 1]
]

const CN_DIGIT = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }

// 中文/阿拉伯数字 → 整数（支持「十二」「二十三」这类写法）
function scopeNumber(s) {
  const t = String(s || '').trim()
  if (!t) return 1
  if (/^[0-9]+$/.test(t)) {
    const n = parseInt(t, 10)
    return n > 0 ? n : 1
  }
  const i = t.indexOf('十')
  if (i === -1) return CN_DIGIT[t] || 1
  const hi = i === 0 ? 1 : (CN_DIGIT[t.charAt(i - 1)] || 1)
  const lo = i === t.length - 1 ? 0 : (CN_DIGIT[t.charAt(i + 1)] || 0)
  const n = hi * 10 + lo
  return n > 0 ? n : 1
}

/**
 * 从目标词前面的范围词剥出范围信息
 * @returns {{core:string, scope:null|{sentence?:number, occurrence?:number}}}
 *   core：剥掉范围词后的目标词（剥完为空则原样返回、scope 为 null）
 */
function extractScope(raw) {
  let s = String(raw || '').trim()
  const scope = {}
  const stripOnce = function (res, key) {
    for (let i = 0; i < res.length; i++) {
      const m = s.match(res[i][0])
      if (!m) continue
      const rest = s.slice(m[0].length)
      if (!rest) return false                 // 剥完没目标词了 → 不认
      const n = res[i][1] ? scopeNumber(m[res[i][1]]) : 1
      scope[key] = n * res[i][2]
      s = rest
      return true
    }
    return false
  }
  stripOnce(SCOPE_SENT_RES, 'sentence')
  stripOnce(SCOPE_TAIL_RES, 'tail')
  stripOnce(SCOPE_ALL_RES, 'all')
  stripOnce(SCOPE_OCC_RES, 'occurrence')
  const has = !!(scope.sentence || scope.occurrence || scope.tail || scope.all)
  return { core: s, scope: has ? scope : null }
}

// 范围描述文案（提示语用）：「第2句」「最后一句」「第1处」「最后一处」
function scopeText(scope) {
  if (!scope) return ''
  const parts = []
  if (scope.all) parts.push('前边所有内容')
  if (scope.tail) {
    parts.push(scope.tail === 1 ? '上一句' : '前' + (scope.tail === 2 ? '两' : scope.tail) + '句')
  }
  if (scope.sentence) {
    parts.push(scope.sentence > 0
      ? '第' + scope.sentence + '句'
      : (scope.sentence === -1 ? '最后一句' : '倒数第' + (-scope.sentence) + '句'))
  }
  if (scope.occurrence) {
    parts.push(scope.occurrence > 0
      ? '第' + scope.occurrence + '处'
      : (scope.occurrence === -1 ? '最后一处' : '倒数第' + (-scope.occurrence) + '处'))
  }
  return parts.join('')
}

// ===== 句界宽口径（2026-09-17 决策 1.B：定位/删句用宽口径，指令扫描仍用窄口径）=====
// 宽口径：任何标点都断句。用户定义「早上很堵，我开车去公司，晴天。」= 三句话
// 纯标点片段（连续标点、独立换行）不计入句数，避免「最后一句话」删到空片段
var WIDE_SENT_END = /[。．！!？?、，,；;：:…\n]/

function hasVisibleContent(s) {
  for (var i = 0; i < s.length; i++) {
    if (!isFuzzyIgnorable(s.charAt(i))) return true
  }
  return false
}

// 宽口径句区间表：{start, end} 按出现顺序，跳过纯标点片段
// 与 splitSentences（窄口径）的区别：逗号/顿号/分号/冒号/省略号同样算句界
function sentenceBounds(text) {
  const t = String(text || '')
  const out = []
  let start = -1
  for (let i = 0; i < t.length; i++) {
    if (start === -1) start = i
    if (WIDE_SENT_END.test(t.charAt(i))) {
      const seg = t.slice(start, i + 1)
      if (hasVisibleContent(seg)) out.push({ start: start, end: i + 1 })
      start = -1
    }
  }
  if (start !== -1) {
    const rest = t.slice(start)
    if (hasVisibleContent(rest)) out.push({ start: start, end: t.length })
  }
  return out
}

// 按范围从命中区间里挑选：先按句过滤，再按出现次序取一处
function selectSpans(text, spans, scope) {
  let list = spans
  if (!scope) return list
  // 前边所有内容：作用域全范围，不做过滤（删除已在 detect 拦截）
  if (scope.all) return list
  // 相对句范围：以作用域末尾为基准的最后 N 句（上一句 / 前两句 / 这两句）
  if (scope.tail) {
    const bounds = sentenceBounds(text)
    if (!bounds.length) return []
    const b0 = bounds[Math.max(0, bounds.length - scope.tail)]
    const b1 = bounds[bounds.length - 1]
    list = list.filter(function (sp) { return sp.start >= b0.start && sp.end <= b1.end })
  }
  if (scope.sentence) {
    const bounds = sentenceBounds(text)
    const i = scope.sentence > 0 ? scope.sentence - 1 : bounds.length + scope.sentence
    if (i < 0 || i >= bounds.length) return []
    const b = bounds[i]
    list = list.filter(function (sp) { return sp.start >= b.start && sp.end <= b.end })
  }
  if (scope.occurrence) {
    const n = scope.occurrence
    const i = n > 0 ? n - 1 : list.length + n
    if (i < 0 || i >= list.length) return []
    list = [list[i]]
  }
  return list
}

// 清洗指令字段首尾的标点和空白
// 语音识别常在指令末尾加句号（「把二十年改成三十年。」），如果不去掉，
// 这些句号会被当成 from/to 的一部分，替换时就出现了「三十年。太长」这种错位句号。
// 这里只剥首尾，不动中间——中间标点交给 fuzzyFindAll 处理。
function cleanEditWord(w) {
  if (w === null || w === undefined) return w
  return String(w).trim().replace(/^[，,、。．！!？?；;：:…\s]+|[，,、。．！!？?；;：:…\s]+$/g, '')
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
    const sc = extractScope(m[1].trim())
    const from = cleanEditWord(stripQuantifier(sc.core))
    const to = cleanEditWord(m[2].trim())
    if (!from || !to || from === to) return null
    const edit = { type: 'replace', from: from, to: to }
    if (sc.scope) {
      edit.scope = sc.scope
      edit.rawFrom = cleanEditWord(stripQuantifier(m[1].trim())) || m[1].trim()
    }
    return edit
  }

  for (const re of INSERT_PATTERNS) {
    const m = t.match(re)
    if (!m) continue
    const sc = extractScope(m[1].trim())
    const at = cleanEditWord(stripQuantifier(sc.core))
    const posWord = m[2]
    const ins = cleanEditWord(m[3].trim())
    if (!at || !ins) return null
    const edit = { type: 'insert', at: at, pos: posWord[0] === '前' ? 'before' : 'after', text: ins }
    if (sc.scope) {
      edit.scope = sc.scope
      edit.rawAt = cleanEditWord(stripQuantifier(m[1].trim())) || m[1].trim()
    }
    return edit
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
    const rawFrom = (m[1] || m[2] || '').trim()
    // 「前边所有内容」类整段删除：明确拒绝（2026-09-17 决策 3.A）
    // 带具体目标词的（「把前边所有内容里的40分钟删掉」）正常放行，只收窄范围
    if (isAllScopeTarget(rawFrom)) {
      return { type: 'remove', from: '', blockedReason: 'allRemove' }
    }
    const sc = extractScope(rawFrom)
    const from = cleanEditWord(stripQuantifier(sc.core))
    if (!from) return null
    const edit = { type: 'remove', from: from }
    if (sc.scope) {
      edit.scope = sc.scope
      edit.rawFrom = cleanEditWord(stripQuantifier(rawFrom)) || rawFrom
    }
    return edit
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

// ===== 数字等价（2026-09-17 决策 2.A）：阿拉伯数字与中文数字视为同一内容 =====
// 「30」=「三十」、「第12处」=「第十二处」
// 做法：匹配前把两侧的数字串都折算成阿拉伯表示，再做序列比较
// 停用保护（2026-09-17 二次决策）：单字中文数字恢复折算——「两小时」=「2小时」、
//   「十个」=「10个」，避免跨写法找不到；只对少数「数字 + 常用构词」的同形词
//   （十分/一起/一样/万一/千万…）做停用保护，这些词里的数字字符不折算。
//   范围词（第二个 / 第2处）不受影响，仍走 scopeNumber 的单字解析。
var CN_NUM_D = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
var CN_NUM_UNIT = { '十': 10, '百': 100, '千': 1000 }
// 停用词（2026-09-17 二次决策）：词内中文数字不参与折算——「十分」不等于 10 分
var CN_NUM_STOPWORDS = [
  '十分', '一起', '一样', '一定', '一直', '一般', '一切', '一半', '一边',
  '一些', '一点', '一早', '一眼', '一旦', '一向', '一贯', '一味', '一体',
  '一举', '一共', '一致', '万一', '千万', '十足', '百般', '百姓', '二话',
  '两全', '两头', '三思', '十字'
]
// 量词/单位起始字：停用词后缀后接这些字时它其实是数量单位（「十分钟」≠「十分 开心」）
var CN_QUANT_HEAD = {
  '钟': 1, '秒': 1, '时': 1, '分': 1, '年': 1, '月': 1, '日': 1, '天': 1,
  '个': 1, '块': 1, '元': 1, '斤': 1, '米': 1, '里': 1, '度': 1, '次': 1,
  '人': 1, '点': 1
}
var RE_CN_CORE = /^[零〇一二两三四五六七八九十百千万]+/

// 数字串 raw（原文区间 [i, j)）是否落在某个停用词上。
// 要求「停用词里的数字核心」与整个数字串完全对齐，因此「三十分钟」里的
// 「十」不会因为撞上停用词「十分」被误停用。
function isNumStopAt(t, i, j, raw) {
  for (var wi = 0; wi < CN_NUM_STOPWORDS.length; wi++) {
    var w = CN_NUM_STOPWORDS[wi]
    var m = RE_CN_CORE.exec(w)
    var core = m ? m[0] : ''
    if (!core || core !== raw) continue
    var suffix = w.slice(core.length)
    if (suffix && t.substr(j, suffix.length) !== suffix) continue
    // 后缀之后接量词/单位时按数量处理（「十分钟」照常折算）
    if (CN_QUANT_HEAD[t.charAt(j + suffix.length)]) continue
    return true
  }
  return false
}

function isNumChar(ch) {
  return (ch >= '0' && ch <= '9') || CN_NUM_D[ch] !== undefined ||
    CN_NUM_UNIT[ch] !== undefined || ch === '万'
}

// 纯中文数字串 → 整数（支持「三十」「十二」「二十三」「一百二十」「一千零五」），失败返回 null
function cnNumToInt(s) {
  let total = 0, section = 0, num = 0, has = false
  let i = 0
  while (i < s.length) {
    const c = s.charAt(i)
    // 连续阿拉伯数字当作一个数：支持「1000万」「1500万」这类混合写法
    if (c >= '0' && c <= '9') {
      let j = i
      let buf = ''
      while (j < s.length && s.charAt(j) >= '0' && s.charAt(j) <= '9') { buf += s.charAt(j); j++ }
      num = parseInt(buf, 10)
      has = true
      i = j
      continue
    }
    if (CN_NUM_D[c] !== undefined) { num = CN_NUM_D[c]; has = true }
    else if (CN_NUM_UNIT[c] !== undefined) { section += (num || 1) * CN_NUM_UNIT[c]; num = 0; has = true }
    else if (c === '万') { total += (section + num) * 10000; section = 0; num = 0; has = true }
    else return null
    i++
  }
  return has ? total + section + num : null
}

// 数字串 → 归一化阿拉伯字符串（去掉前导零）
function normNumStr(raw) {
  if (/^[0-9]+$/.test(raw)) {
    const v = String(parseInt(raw, 10))
    return v === 'NaN' ? null : v
  }
  // 光杆一个「万」不构成数量（「万里」「万物」），不折算
  if (raw === '万') return null
  const n = cnNumToInt(raw)
  return n === null ? null : String(n)
}

/**
 * 归一化序列：丢弃标点与空白，数字串折算为阿拉伯数字
 * @returns {{chars:string[], spans:Array<{start:number,end:number}>}} 每个归一化字符对应的原文区间
 */
function normSeq(s) {
  const chars = []
  const spans = []
  const t = String(s || '')
  let i = 0
  while (i < t.length) {
    const ch = t.charAt(i)
    if (isFuzzyIgnorable(ch)) { i++; continue }
    if (isNumChar(ch)) {
      let j = i
      let raw = ''
      while (j < t.length && !isFuzzyIgnorable(t.charAt(j)) && isNumChar(t.charAt(j))) {
        raw += t.charAt(j); j++
      }
      // 停用词（「十分」「一起」）不折算；其余单字中文数字恢复折算（「两小时」=「2小时」）
      const v = isNumStopAt(t, i, j, raw) ? null : normNumStr(raw)
      if (v) {
        for (let k = 0; k < v.length; k++) { chars.push(v.charAt(k)); spans.push({ start: i, end: j }) }
        i = j
        continue
      }
    }
    chars.push(ch)
    spans.push({ start: i, end: i + 1 })
    i++
  }
  return { chars: chars, spans: spans }
}

/**
 * 在 text 中找出所有与 target「忽略标点 + 数字等价后相同」的片段
 * @returns {Array<{start:number, end:number}>} 原文下标区间（end 不含），按出现顺序
 */
function fuzzyFindAll(text, target) {
  const needle = normSeq(target)
  if (!needle.chars.length) return []
  const hay = normSeq(text)
  const n = needle.chars.length
  const spans = []
  for (let i = 0; i + n <= hay.chars.length; i++) {
    let hit = true
    for (let k = 0; k < n; k++) {
      if (hay.chars[i + k] !== needle.chars[k]) { hit = false; break }
    }
    if (hit) {
      spans.push({ start: hay.spans[i].start, end: hay.spans[i + n - 1].end })
      i += n - 1
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
  // 被明确拒绝的指令（如「把前边所有内容删掉」）——不做任何改动，由调用方提示原因
  if (edit.blockedReason) return { content: text, changed: false, reason: edit.blockedReason }

  if (edit.type === 'removeSent') {
    // 宽口径句界（任何标点都断句），与「第几句」定位保持同一口径
    const bounds = sentenceBounds(text)
    if (!bounds.length) return { content: text, changed: false, reason: 'notFound' }
    const n = Math.max(1, Math.min(edit.count || 1, bounds.length))
    let startIdx = 0
    let endIdx = 0
    if (edit.pos === 'last') {
      endIdx = Math.max(0, bounds.length - 1 - Math.max(0, edit.offset || 0))
      startIdx = Math.max(0, endIdx - n + 1)
    } else {
      startIdx = Math.max(0, Math.min(bounds.length - 1, edit.offset || 0))
      endIdx = Math.min(bounds.length - 1, startIdx + n - 1)
    }
    // 删完只剩悬空标点/空白时视为空（如「今天很好。！」删掉唯一句后不留「！」）
    const rest = text.slice(0, bounds[startIdx].start) + text.slice(bounds[endIdx].end)
    return {
      content: hasVisibleContent(rest) ? rest : '',
      changed: true,
      count: n
    }
  }

  if (edit.type === 'insert') {
    if (!edit.at || !edit.text) return { content: text, changed: false }
    let idx = -1
    let atLen = 0
    // 范围词与锚点连成的原串在正文中真实存在时按字面处理（「在第一个路口前加上…」）
    if (edit.scope && edit.rawAt && edit.rawAt !== edit.at) {
      const lit = fuzzyFindAll(text, edit.rawAt)
      if (lit.length) {
        idx = lit[0].start
        atLen = lit[0].end - lit[0].start
      }
    }
    if (idx === -1 && !edit.scope) {
      idx = text.indexOf(edit.at)
      atLen = edit.at.length
    }
    if (idx === -1) {
      // 标点无关兜底：正文里的锚点可能被语音标点干扰（如「在，南京」）
      let spans = fuzzyFindAll(text, edit.at)
      if (edit.scope) spans = selectSpans(text, spans, edit.scope)
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
  let spans = fuzzyFindAll(text, edit.from)
  let usedRaw = false
  // 字面优先：范围词与目标词连成的原串若在正文中真实存在，按字面处理
  // （「把第一个项目替换成第三个项目」——正文里确实有「第一个项目」时不该只改「项目」）
  if (edit.scope && edit.rawFrom && edit.rawFrom !== edit.from) {
    const lit = fuzzyFindAll(text, edit.rawFrom)
    if (lit.length) {
      spans = lit
      usedRaw = true
    }
  }
  if (!usedRaw && edit.scope) spans = selectSpans(text, spans, edit.scope)
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
    return { content: out, changed: true, count: spans.length, usedRaw: usedRaw }
  }

  // replace：同样从后往前
  const to = cleanEditWord(edit.to || '')
  for (let i = spans.length - 1; i >= 0; i--) {
    out = out.slice(0, spans[i].start) + to + out.slice(spans[i].end)
  }
  return { content: out, changed: true, highlightWord: to, count: spans.length, usedRaw: usedRaw }
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
  const blocked = []
  for (const s of splitSentences(content)) {
    const edit = detectSentence(s)
    if (!edit) { narrative += s; continue }
    const res = apply(narrative, edit)
    if (res.changed) {
      narrative = res.content
      applied.push({ edit: edit, result: res })
    } else if (res.reason === 'allRemove') {
      // 明确拒绝的指令：句子按叙述保留，交由调用方提示原因
      blocked.push(edit)
      narrative += s
    } else {
      notFound.push(edit)
      narrative += s
    }
  }
  return { content: narrative, applied: applied, notFound: notFound, blocked: blocked, changed: applied.length > 0 }
}

module.exports = { detect, apply, splitCommands, extractEmbedded, scopeText }
