/**
 * 本地 AI 日记优化引擎
 * 基于规则与模板的智能润色：只润色表达、补充氛围，不改写事实。
 * 纯本地运行，无需后端，保护隐私。
 */

// 心情 → 开头氛围句
const MOOD_OPENINGS = {
  happy: '今天的心情像被阳光晒过一样，亮堂堂的。',
  calm: '今天的节奏很安静，我把思绪慢慢理了一遍。',
  neutral: '日子不紧不慢地过着，今天也不例外。',
  sad: '今天的情绪有点低落，我想把心里的这些话说出来。',
  angry: '今天心里堵着一口气，先写下来，等平静了再回头看。',
  love: '今天心里盛着满满的温柔，想把每一刻都记下来。',
  tired: '今天确实有点累，可还是想把这一天好好留下。',
  excited: '今天整个人都处于兴奋状态，感觉有使不完的劲。'
}

// 心情 → 结尾升华句
const MOOD_ENDINGS = {
  happy: '这一天值得好好收藏，希望明天也依然闪亮。',
  calm: '平平淡淡的一天，却让人格外安心。生活本来的样子，大概就是这样静水流深。',
  neutral: '生活就是这样，把普通的日子过成自己的节奏，就已经很好。',
  sad: '难过不会一直停留，等明天天亮，一切都会好起来一些。',
  angry: '把不快写下来，气就消了一半。日子还长，不值得为这点事扰了心情。',
  love: '能被这些细小的幸福包围着，就是生活最好的馈赠。',
  tired: '好好睡一觉，明天又是元气满满的一天。',
  excited: '这样的好心情希望一直延续，明天也请继续加油！'
}

// 心情 → 通用氛围句（未选择心情时使用）
const DEFAULT_OPENINGS = [
  '窗外透进来的光把桌面照得发亮，时间好像也慢了下来。',
  '把今天的事情在脑子里过了一遍，觉得值得记下来。'
]

const DEFAULT_ENDINGS = [
  '把今天记下来，日子就有了着落。',
  '平凡的一天，也是独一无二的一天。'
]

// 感官细节句库（用于让平铺直叙的场景更鲜活）
const DETAILS = [
  '风从窗缝里溜进来，带着一点傍晚特有的气息。',
  '街灯一盏盏亮起，城市慢慢换上了夜的颜色。',
  '空气里有雨后泥土的味道，让人格外清醒。',
  '耳边是窗外的车流声，忽远忽近，像生活的背景音。',
  '阳光斜斜地落在桌角，连影子都带着暖意。',
  '路上的行人脚步匆匆，只有我一个人不紧不慢。'
]

// 词语润色表（仅替换语义安全、语气更生动的表达，长词优先匹配）
const WORD_POLISH = [
  { from: '非常开心', to: '开心得眼睛都在笑' },
  { from: '特别开心', to: '开心得合不拢嘴' },
  { from: '非常累', to: '累到骨头缝里都透着酸' },
  { from: '特别累', to: '累得浑身像散了架' },
  { from: '非常忙', to: '忙得脚不沾地' },
  { from: '特别忙', to: '忙得团团转' },
  { from: '很好喝', to: '格外好喝' },
  { from: '很好听', to: '格外好听' },
  { from: '很好看', to: '格外好看' },
  { from: '很开心', to: '满心欢喜' },
  { from: '很难过', to: '心里堵得慌' },
  { from: '很生气', to: '气得直冒火' },
  { from: '很累', to: '疲惫不堪' },
  { from: '很忙', to: '忙得不可开交' },
  { from: '很舒服', to: '格外惬意' },
  { from: '很幸福', to: '幸福感满满' },
  { from: '很快乐', to: '快乐得冒泡' },
  { from: '很漂亮', to: '赏心悦目' },
  { from: '很好吃', to: '美味得让人回味' },
  { from: '很好', to: '相当不错' }
]

/**
 * 按标点安全拆分句子（不用正则 lookbehind，兼容性更好）
 */
function splitSentences(text) {
  const sentences = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '!' || ch === '?' || ch === ';' || ch === '\n') {
      const s = buf.replace(/\s+/g, ' ').trim()
      if (s) sentences.push(s)
      buf = ''
    }
  }
  const rest = buf.replace(/\s+/g, ' ').trim()
  if (rest) sentences.push(rest)
  return sentences
}

/**
 * 判断句子是否是"平铺直叙"的短句（可作为润色候选）
 */
function isPlainSentence(sentence) {
  const len = sentence.length
  if (len > 34) return false
  // 已经有修饰词/描述的句子不处理
  if (/(像|仿佛|如同|好像|格外|满满|透|轻轻|慢慢|终于|居然|竟然)/.test(sentence)) return false
  // 疑问句、对话不处理
  if (/[？?]/.test(sentence)) return false
  return true
}

/**
 * 优化主函数
 * @param {string} content 日记原文
 * @param {string} mood 心情 key（可空）
 * @returns {{optimized:string, changes:string[]}}
 */
function optimize(content, mood) {
  const original = (content || '').trim()
  if (!original) return null
  if (original.length < 20) {
    return { tooShort: true, optimized: original, changes: [] }
  }

  const changes = []
  let text = original

  // ===== 0. 口吃式重复清理（语音转写残留，与 voiceFilter.js 保持一致）=====
  const STUTTER_KEEP = { '哈': 1, '呵': 1, '嘿': 1, '嘻': 1, '噗': 1, '呜': 1, '哇': 1, '耶': 1, '咚': 1, '叮': 1 }
  let stutterCount = 0
  text = text.replace(/([\u4e00-\u9fa5])\1{2,}/g, (all, ch) => {
    if (STUTTER_KEEP[ch]) return all
    stutterCount++
    return ch
  })
  text = text.replace(/([\u4e00-\u9fa5])，\1/g, (all, ch) => {
    stutterCount++
    return ch
  })
  if (stutterCount > 0) {
    changes.push('清理了 ' + stutterCount + ' 处语音输入的口吃重复')
  }

  // ===== 1. 词语润色（长词优先，避免子串误替换） =====
  const sorted = WORD_POLISH.slice().sort((a, b) => b.from.length - a.from.length)
  let wordCount = 0
  sorted.forEach(p => {
    if (text.indexOf(p.from) !== -1) {
      text = text.split(p.from).join(p.to)
      wordCount++
    }
  })
  if (wordCount > 0) {
    changes.push('润色了 ' + wordCount + ' 处表达，语气更生动')
  }

  // ===== 2. 段落处理 =====
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const out = paragraphs.slice()

  // —— 2.1 开头氛围：首段首句过于平实 → 前置氛围句
  const firstSentences = splitSentences(out[0])
  if (firstSentences.length > 0 && isPlainSentence(firstSentences[0])) {
    const opening = MOOD_OPENINGS[mood] || DEFAULT_OPENINGS[Math.floor(Math.random() * DEFAULT_OPENINGS.length)]
    if (out[0].indexOf(opening.slice(0, 8)) === -1) {
      out[0] = opening + '\n' + out[0]
      changes.push('为开头增加了一段氛围描写，更有代入感')
    }
  }

  // —— 2.2 细节补充：在中间段落里插入一句感官细节
  if (out.length > 1) {
    const midIdx = out.length > 2 ? 1 : 0
    const midSentences = splitSentences(out[midIdx])
    if (midSentences.length >= 2) {
      const detail = DETAILS[Math.floor(Math.random() * DETAILS.length)]
      // 避免重复：原文里已有类似表达则不插入
      const marker = detail.slice(0, 6)
      let repeated = false
      paragraphs.forEach(p => { if (p.indexOf(marker) !== -1) repeated = true })
      if (!repeated) {
        // 插在第二句之后
        const firstTwo = midSentences.slice(0, 2).join('')
        const restText = midSentences.slice(2).join('')
        out[midIdx] = (restText ? firstTwo + '\n' + detail + '\n' + restText : firstTwo + '\n' + detail)
        changes.push('补充了感官细节描写，让场景更鲜活')
      }
    }
  }

  // —— 2.3 结尾升华：末段末句较短/无升华感 → 追加一句
  const lastIdx = out.length - 1
  const lastSentences = splitSentences(out[lastIdx])
  const lastSentence = lastSentences[lastSentences.length - 1] || ''
  const hasReflection = /(生活|希望|明天|这样|日子|值得|加油|美好|期待|继续|平凡)/.test(lastSentence)
  if (lastSentence.length < 26 || !hasReflection) {
    const ending = MOOD_ENDINGS[mood] || DEFAULT_ENDINGS[Math.floor(Math.random() * DEFAULT_ENDINGS.length)]
    if (out[lastIdx].indexOf(ending.slice(0, 8)) === -1) {
      out[lastIdx] = out[lastIdx] + '\n' + ending
      changes.push('结尾增加了一句感想，让日记更有余味')
    }
  }

  const optimized = out.join('\n\n')

  // 若几乎没有改动，也给出兜底说明
  if (changes.length === 0) {
    changes.push('整体表达已经比较流畅，微调了句读节奏')
  }

  return { optimized, changes, original }
}

module.exports = {
  optimize
}
