/**
 * utils/entityClean.js
 * 日记正文「名词解释」清理：日记中解释了某个名词并提示备案后，
 * 正文只保留名词本身，解释部分删除。
 *   例：「我今天和王磊，他是我大学同学一起吃的饭」
 *       → 提示备案后正文变为「我今天和王磊一起吃的饭」
 *
 * 输入实体需带 explanation（解释在日记原文中的逐字片段，不含名词本身）。
 * 全程保守策略：定位不到解释原文就跳过，绝不误删正文。
 */

// 名词与解释之间允许的分隔符
const SEP_RE = /^[，,、；;：:\s]*/
// 解释的常见引导词（原文中有、AI 概括时可能漏掉）
const LEADS = ['其实是', '真的是', '他就是', '她就是', '他就是', '就是', '这是', '他是', '她是', '它是', '也是', '正是', '是']

// ===== 名词备案前的机械校验（防 AI 误报）=====
// 定义句式的引导词：名词之后紧跟（允许中间有标点/空白）
const LEAD_AFTER = [
  '其实是', '真的是', '指的是', '他就是', '她就是', '它就是', '这是', '他是', '她是', '它是',
  '也就是', '就是', '也是', '正是', '名叫', '叫做', '名为', '称为', '称作', '叫', '是'
]
// 定义句式的引导词：名词之前紧跟（如「我母亲叫王喜兰」）
const LEAD_BEFORE = ['名叫', '叫做', '名字叫', '名为', '称为', '称作', '叫']
// 助词/功能字：名词里出现即判为非名词（「的第一天」「很快」这类）
const FUNC_CHARS = ['的', '了', '着', '是', '都', '也', '还', '就', '才', '又', '再', '很', '太', '被', '把', '让', '吗', '呢', '吧', '啊', '呀', '嘛', '挺', '更', '最']
// 虚词/时间词/泛称词：AI 容易误当名词的高频词，一律不备案
const NON_NOUN_WORDS = [
  '分别', '一起', '一共', '一直', '主要', '其中', '大概', '可能', '然后', '后来', '开始', '继续', '最后', '首先', '其次', '同时', '另外', '而且', '但是', '因为', '所以', '虽然',
  '已经', '正在', '可以', '应该', '需要', '觉得', '认为', '希望', '准备', '打算', '决定', '真是', '真的', '确实', '很多', '不少', '一些', '这里', '那里', '这个', '那个', '他们', '我们', '你们', '自己', '别人',
  '今天', '明天', '昨天', '上午', '中午', '下午', '晚上', '早上', '当时', '现在', '目前', '之后', '之前', '时候', '时间', '地方', '东西', '事情', '情况', '问题', '内容', '部分', '方面', '方式', '结果', '原因', '目的', '办法',
  '公司', '学校', '单位', '朋友', '同事', '同学', '孩子', '家里', '工作', '生活', '状态', '心情', '感觉', '计划', '安排'
]
// 部分引导词互为前缀（如「是」是「指的是」的尾字）：按长度降序匹配，避免短词抢先命中
// 允许紧邻名词左侧的功能字/动词（「和」王磊、「叫」王喜兰…）：除此之外左侧出现汉字即视为子串截取
const PRE_NOUN_CHARS = '和跟与同对的了我你他她它们咱您于在从把被让给找见问说叫带陪还有去来到就也都又再想要会能没不很太以及等是做为'
// 时间词前缀：名词以这些词开头基本是正则过度捕获（「今天杨帆」），不是完整名词
const TIME_PREFIX = ['今天', '明天', '昨天', '后天', '前天', '上午', '中午', '下午', '晚上', '早上', '凌晨', '当时', '现在', '目前']

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)
const LEAD_BEFORE_SORTED = LEAD_BEFORE.slice().sort((a, b) => b.length - a.length)

/**
 * 判断 AI 提取的「名词 + 解释」是否为真实备案项（机械校验，不依赖模型）
 * 规则：① 名称是 2~6 字、不含助词/功能字 ② 不是虚词/泛称词、不以时间词开头
 *      ③ 名称在原文中真实出现 ④ 原文中存在定义句式（名次前后紧跟引导词）
 *      ⑤ 命中的那处出现位置、左侧边界必须干净（防「从更长专有名词里截出的子串」）
 * @param {string} name AI 提取的名词
 * @param {string} content 日记原文
 * @returns {boolean} true 才允许弹窗备案
 */
function isExplainedNoun(name, content) {
  const n = String(name || '').trim()
  const text = String(content || '')
  if (!n || n.length < 2 || n.length > 6) return false
  // 以时间词开头 → 正则过度捕获的产物（如「今天杨帆」），不是完整名词
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return false
  }
  // 含助词/功能字 → 不是名词（如「的第一天」）
  for (let i = 0; i < FUNC_CHARS.length; i++) {
    if (n.indexOf(FUNC_CHARS[i]) !== -1) return false
  }
  // 虚词/泛称词 → 不备案
  if (NON_NOUN_WORDS.indexOf(n) !== -1) return false
  // 必须在原文中真实出现（防 AI 编造名词）
  let from = 0
  let idx = text.indexOf(n, from)
  if (idx === -1) return false
  // 逐处出现位置检查是否存在定义句式
  while (idx !== -1) {
    // 左侧边界干净的才作数：原文「中国考古博物馆是一家…」被截成「古博物馆」时，
    // 其前一字符「考」暴露了截取行为，直接否决，避免备案出残缺名词
    if (hasCleanLeftBoundary(text, idx)) {
      const after = text.slice(idx + n.length).replace(SEP_RE, '')
      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {
        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) return true
      }
      const before = text.slice(0, idx)
      for (let i = 0; i < LEAD_BEFORE_SORTED.length; i++) {
        const lead = LEAD_BEFORE_SORTED[i]
        if (before.length >= lead.length && before.slice(before.length - lead.length) === lead) return true
      }
    }
    idx = text.indexOf(n, idx + n.length)
  }
  return false
}

/**
 * 名词左侧边界是否干净：前一字符不是汉字，或属于允许紧邻名词的功能字/动词
 * 用途：拦截「从更长专有名词里截出的子串」（如「中国考古博物馆」→「古博物馆」）
 * @param {string} text 原文
 * @param {number} idx 名词在原文中的起始位置
 * @returns {boolean}
 */
function hasCleanLeftBoundary(text, idx) {
  if (idx <= 0) return true
  const prev = text.charAt(idx - 1)
  if (!/[\u4e00-\u9fa5]/.test(prev)) return true
  return PRE_NOUN_CHARS.indexOf(prev) !== -1
}

/**
 * 删除单个实体的解释部分（只处理第一处出现）
 * @param {string} content 日记正文
 * @param {{name:string, explanation:string}} entity
 * @returns {{content:string, changed:boolean}}
 */
function removeOne(content, entity) {
  const name = String((entity && entity.name) || '').trim()
  const expl = String((entity && entity.explanation) || '').trim()
  if (!name || !expl) return { content: content, changed: false }

  const idx = content.indexOf(name)
  if (idx === -1) return { content: content, changed: false }
  const nameEnd = idx + name.length

  // ---- 后向：解释紧跟在名词后面（最常见）----
  const sepMatch = content.slice(nameEnd).match(SEP_RE)
  const sepLen = sepMatch ? sepMatch[0].length : 0
  const afterSep = nameEnd + sepLen

  // 候选解释片段（按优先级尝试）：
  //   1. explanation 原文逐字匹配
  //   2. 「引导词 + explanation」（AI 概括时漏掉原文引导词，如 原文「他是我大学同学」→ 概括「我的大学同学」）
  //   3. 「我的」还原成「我」再配引导词（概括时统一加了"的"，原文口语可能没有）
  //   4. explanation 去掉开头引导词（AI 把引导词也算进解释）
  const strippedDe = expl.indexOf('我的') === 0 ? '我' + expl.slice(2) : ''
  const candidates = [expl]
  for (const lead of LEADS) {
    candidates.push(lead + expl)
    if (strippedDe) candidates.push(lead + strippedDe)
  }
  if (strippedDe) candidates.push(strippedDe)

  let hit = null
  for (const cand of candidates) {
    if (cand.length < 3) continue
    if (content.startsWith(cand, afterSep)) { hit = cand; break }
  }
  if (!hit) {
    for (const lead of LEADS) {
      if (expl.startsWith(lead)) {
        const tail = expl.slice(lead.length)
        if (tail.length >= 2 && content.startsWith(tail, afterSep)) { hit = tail; break }
      }
    }
  }

  if (hit) {
    // 删除区间：从名词后（含前导分隔符）到解释结尾
    let delEnd = afterSep + hit.length
    let tail = content.slice(delEnd)
    // 解释后紧跟的顿号/逗号原本是隔开「解释」与后文的 → 解释删掉后一并删除
    // （句号/问号/叹号保留，句子边界不动）
    const t = tail.match(/^[，,、]/)
    if (t) {
      delEnd += t[0].length
      tail = content.slice(delEnd)
    }
    return { content: content.slice(0, nameEnd) + tail, changed: true }
  }

  // ---- 前向：解释在名词前面（如「我大学同学王磊今天…」）----
  const before = content.slice(0, idx)
  const sepBeforeMatch = before.match(/[，,、；;：:\s]*$/)
  const sepBeforeLen = sepBeforeMatch ? sepBeforeMatch[0].length : 0
  const explStart = idx - sepBeforeLen - expl.length
  if (explStart >= 0 && content.startsWith(expl, explStart)) {
    return { content: content.slice(0, explStart) + content.slice(idx), changed: true }
  }

  return { content: content, changed: false }
}

/**
 * 清理接缝残留：连续重复标点压成一个、行首孤立标点删除、多余空格压缩
 * 只处理清理动作可能产生的痕迹，不改动正常文本
 */
function tidy(text) {
  return text
    .replace(/[，,]{2,}/g, '，')
    .replace(/[、]{2,}/g, '、')
    .replace(/[。]{2,}/g, '。')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[，,、；;：:]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[，,、]\s*([。！？\n])/g, '$1')
    .trim()
}

/**
 * 批量清理日记正文中的解释部分
 * @param {string} content 日记正文
 * @param {Array<{name:string, explanation:string}>} entities 带原文解释片段的实体
 * @returns {{content:string, changed:boolean, removed:string[]}} removed 为成功删除解释的名词
 */
function removeExplanations(content, entities) {
  let text = String(content || '')
  const removed = []
  const list = Array.isArray(entities) ? entities : []
  for (const e of list) {
    const r = removeOne(text, e)
    if (r.changed) {
      text = r.content
      removed.push(e.name)
    }
  }
  if (removed.length === 0) return { content: content, changed: false, removed: removed }
  const cleaned = tidy(text)
  // 清理后正文为空 → 保留原内容（名词总该留下，不应删空）
  if (!cleaned) return { content: content, changed: false, removed: removed }
  return { content: cleaned, changed: cleaned !== content, removed: removed }
}

module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary }
