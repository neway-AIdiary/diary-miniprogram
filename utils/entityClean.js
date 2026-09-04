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

module.exports = { removeExplanations, removeOne, tidy }
