// utils/voiceFilter.js
// 语音输入实时净化层（第一层处理，区别于第二层 AI 优化）：
// 在 ASR 实时识别回调中同步移除语气词（嗯/啊/哈/呃…）和提醒自己思考的自言自语（我想想/怎么说呢…），
// 让用户在说话的同时就能看到修正后的文字。
//
// 设计原则：
// 1. 纯本地规则（词典 + 正则），不请求网络、不调用 AI，执行耗时 <1ms
// 2. 按「小句 + 其后标点」整块匹配删除，绝不碰句子内部的字词 ——「哈尔滨」「干什么」永远不会被误杀
//    （例外：仅对「口吃式重复」做保守清理，见下方 STUTTER_* 注释，正常叠词「试试/看看/慢慢」不受影响）
// 3. 原始文本由调用方保留存档，过滤有误时可回溯

// 语气词：单独成句（前后是标点或边界）时删除
var FILLER_WORDS = [
  '嗯', '啊', '呃', '哎', '唉', '哦', '噢', '喔', '嘛', '呀', '哈', '呵', '诶', '欸',
  '嗯嗯', '呃呃', '啊啊', '哦哦', '哎哟'
]

// 语气短语：口语中填充停顿的固定搭配，单独成句时删除
var FILLER_PHRASES = [
  '就是', '就是那个', '就是说是', '那个', '那个啥', '这个', '这个那个',
  '对吧', '是吧', '对不对', '是不是', '然后呢', '怎么说呢', '说什么呢', '怎么讲呢',
  '等等', '等下', '嗯呢', '哦对', '对对对', '是是是',
  '怎么说', '什么来着', '叫什么来着', '那个什么', '什么'
]

// 自言自语（提醒自己思考的非实质内容）：单独成句时删除
var SELF_TALK_PHRASES = [
  '我想想', '让我想想', '我想想看', '让我想一下', '让我想一想', '想一下', '想一想',
  '我看看', '让我看看', '看一下', '怎么表述呢', '怎么形容呢',
  '我记得一下', '我回忆一下', '怎么说来着', '今天说什么好呢'
]

// 合并词典，长的排前面避免短词抢先匹配
var ALL_REMOVABLE = FILLER_WORDS
  .concat(FILLER_PHRASES)
  .concat(SELF_TALK_PHRASES)
  .sort(function (a, b) { return b.length - a.length })

var REMOVE_MAP = {}
ALL_REMOVABLE.forEach(function (w) {
  if (REMOVE_MAP[w] === undefined) {
    REMOVE_MAP[w] = SELF_TALK_PHRASES.indexOf(w) !== -1 ? 'selftalk'
      : (FILLER_PHRASES.indexOf(w) !== -1 ? 'phrase' : 'filler')
  }
})

// 句首可安全剥离的语气字：这些字不出现在任何正常词语的开头，句首出现必是语气词
var SAFE_LEADING = ['嗯嗯', '呃呃', '嗯', '呃', '诶', '欸']
// 句尾可安全剥离的语气词：正常句子结尾的语气助词
var SAFE_TRAILING = ['对吧', '是吧', '对不对', '嗯嗯', '嗯', '啊', '呃', '哈', '吧', '嘛', '呀', '哦', '诶', '欸']

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ===== 口吃式重复清理（保守规则，仅处理语音输入特有的卡壳重复）=====
// a) 连续 3 个及以上相同汉字 → 收敛为 1 个（「同同同时」→「同时」「我我我」→「我」）
//    正常中文叠词最多 2 个字（试试/看看/慢慢/刚刚），连出 3 个必是口吃；
//    笑声/拟声除外（哈哈哈、呜呜呜、哇哇哇等情绪表达要保留）
var STUTTER_KEEP = { '哈': 1, '呵': 1, '嘿': 1, '嘻': 1, '噗': 1, '呜': 1, '哇': 1, '耶': 1, '咚': 1, '叮': 1 }
var STUTTER_RE = /([\u4e00-\u9fa5])\1{2,}/g
// b) 单字被逗号隔开的即时重启（「都是都，都是一个」中的「都，都」→「都」）
//    仅限单字：双字词重启（「现在，现在」）语义可能有强调含义（「不行，不行」），交给第二层 AI 处理
var RESTART_RE = /([\u4e00-\u9fa5])，\1/g

// 判断一个完整小句是否整体命中词典（可整句删除）
function matchWhole(clause) {
  var t = REMOVE_MAP[clause]
  if (t !== undefined) return { word: clause, type: t }
  return null
}

// 从句首剥离语气字（仅限 SAFE_LEADING，避免误杀「哈气」这类词）
var LEADING_RE = new RegExp('^(' + SAFE_LEADING.map(escapeRe).join('|') + ')')

// 从句尾剥离语气词（仅限 SAFE_TRAILING，且要求剩余部分至少 2 个字）
var TRAILING_RE = new RegExp('(' + SAFE_TRAILING.map(escapeRe).join('|') + ')$')

/**
 * 语音标点规范化（标准中文断句）：
 *   1. 半角标点统一转全角（, ; ! ? : → ，；！？：），
 *      英文句点仅在非「数字/字母之间」时才转中文句号（保护 3.5、www.a.com、v1.2.3）
 *   2. 连续/混用的区隔标点折叠成一个：取段内权重最高的标点保留（其余丢弃），
 *      权重：省略号/句末(。！？…) > 分号 > 顿号 > 逗号；同级取最后一个
 *      ——「逗号是逗号、句号是句号，各归各位」，绝不叠加成「，。」这类残渣
 *   3. 中文标点后的行内空格清理
 * 纯函数，供 purify 在最后一步调用；也可单独导出测试。
 */
var PUNCT_W = { '，': 0, '、': 1, '；': 2, '。': 3, '！': 4, '？': 4, '…': 5 }
var PUNCT_SEG_RE = /([，。！？；、…])(?:[ \t]*[，。！？；、…])*/g

function normalizePunct(text) {
  var s = String(text || '')

  // 0) 占位保护数字小数 / 网址 / 版本号中的句点（先藏起来，最后还原）
  //    用 lookahead 不消费后一个字母/数字，避免重叠的点（如 v1.2.3）漏保护
  s = s.replace(/([0-9A-Za-z])\.(?=[0-9A-Za-z])/g, function (all, a) {
    return a + '\u0001'
  })
  // 三个及以上连续半角句点 → 省略号
  s = s.replace(/\.{3,}/g, '……')

  // 1) 半角 → 全角
  s = s.replace(/,/g, '，')
  s = s.replace(/;/g, '；')
  s = s.replace(/!/g, '！')
  s = s.replace(/\?/g, '？')
  s = s.replace(/:/g, '：')
  s = s.replace(/\./g, '。')

  // 2) 折叠连续/混用标点段：保留段内权重最高的一个
  s = s.replace(PUNCT_SEG_RE, function (m0) {
    // 省略号（可多个 U+2026 组成）统一规范为双字符省略号，不与折叠混用
    if (m0.indexOf('…') !== -1 && m0.replace(/[ \t…]/g, '') === '') {
      return '……'
    }
    var ch = '，'
    var w = -1
    for (var i = 0; i < m0.length; i++) {
      var c = m0.charAt(i)
      var cw = PUNCT_W[c]
      if (cw !== undefined && cw >= w) { ch = c; w = cw }
    }
    return ch
  })

  // 3) 中文标点后行内空格清理（不碰换行）
  s = s.replace(/([，。！？；、…：])[ \t]+/g, '$1')

  // 4) 还原保护点位
  s = s.replace(/\u0001/g, '.')

  return s
}

/**
 * 净化文本（纯函数）
 * @param {string} text ASR 原始识别结果
 * @param {object} [opts] { keepSelfTalk: true 时只删语气词、保留自言自语 }
 * @returns {{text: string, removed: Array<{word,type}>, count: number}}
 */
function purify(text, opts) {
  var keepSelfTalk = !!(opts && opts.keepSelfTalk)
  var removed = []

  var out = String(text || '')

  // —— 口吃清理（a：连续 3+ 相同字收敛；b：单字逗号重启收敛）——
  out = out.replace(STUTTER_RE, function (all, ch) {
    if (STUTTER_KEEP[ch]) return all
    removed.push({ word: all, type: 'stutter' })
    return ch
  })
  out = out.replace(RESTART_RE, function (all, ch) {
    removed.push({ word: all, type: 'stutter' })
    return ch
  })

  // 把文本切成「小句 + 其后标点」：小句删除时连同其后标点一起删，不留「。，」残渣
  out = out.replace(
    /([^，。！？；、,\n!?~…\s]+)([\s，。！？；、,\.\!\?~…]*)/g,
    function (all, clause, sep) {
      var hit = matchWhole(clause)
      if (hit) {
        if (keepSelfTalk && hit.type === 'selftalk') return all
        removed.push(hit)
        return ''
      }

      var body = clause

      // 句首语气字剥离（无标点 ASR 输出的兜底，如「嗯今天天气不错」）
      var lm = body.match(LEADING_RE)
      if (lm && body.length > lm[1].length) {
        removed.push({ word: lm[1], type: 'filler' })
        body = body.slice(lm[1].length)
      }

      // 句尾语气词剥离（如「今天开会哈」→「今天开会」）
      var tm = body.match(TRAILING_RE)
      if (tm && body.length - tm[1].length >= 2) {
        removed.push({ word: tm[1], type: 'filler' })
        body = body.slice(0, body.length - tm[1].length)
      }

      if (body === clause) return all
      return body + sep
    }
  )

  // 清理删除后的残留：行首标点、重复标点
  out = out.replace(/^[，。！？；、,\.\!\?~…]+/, '')
  out = out.replace(/([，,])[，,、]+/g, '$1')
  out = out.replace(/([。！？;；])[，、,]+(?=[^，。！？；、,\s]|$)/g, '$1')
  out = out.replace(/[ \t]{2,}/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')

  // 语音标点规范化（标准中文断句）——所有语音转写文本统一收口
  out = normalizePunct(out)

  return { text: out.trim(), removed: removed, count: removed.length }
}

module.exports = { purify: purify, normalizePunct: normalizePunct }
