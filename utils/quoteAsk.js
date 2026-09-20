/**
 * utils/quoteAsk.js
 * 日记素材补全识别引擎（纯函数，不碰 wx.*，可被 tools/test_quote_ask.js 直接单测）
 *
 * 用途：用户在正文里写了「XX 是什么来着 / 帮我补充全文」这类话时，把它识别成
 *       「素材补全请求」，交给池内直出或云端 recite 通道。**只在点【AI 优化】/
 *       【重新优化】时执行**，不新增按钮、不在保存时自动跑。
 *
 * 判定链（四层，缺一不触发）：
 *   ① 前置否决（一票否决） → ② 触发词（必须命中） → ③ 素材锚点（必须命中 ≥1） → ④ 归类定级
 *
 * 核心公式：**触发词 AND 素材锚点**。
 *   只有触发词、没有素材锚点 → 静默退回普通润色（不提示、不改字、不进素材通道）。
 *
 * 绝不误识别的三道保险：
 *   1) 改文指令（删掉/改成/替换成）直接让给 aiEdit；
 *   2) 补充对象是「这段话/这句话/我的想法」这类文字实体 → 一律不做；
 *   3) 锚点表里没有书名号/池内篇名/引号句/人名/文体词/名句片段 → 不做。
 *
 * 否决闸的作用域（2026-09-20 定，别退回全文扫描）：
 *   「继续往下写」= 全局否决（日记常用语，无歧义）；
 *   「改文指令 / 文字实体 / 指令句过长」= **只在含触发词的那句里判**。
 *   否则「今天心情很好，把《静夜思》补充完整」会被整段否决（「心情」误伤）。
 *
 * 容错：语音输入为主，触发词做「精确档 + 拼音近似档」两档；
 *       近似档**要求完全同音（编辑距离 0）且触发词拼音 ≥4 音节**，并必须同时
 *       命中强锚点（书名号 / 池内篇名 / 引号句）才放行 —— 距离放宽到 1 会误触发。
 */

const dailyQuote = require('./dailyQuote.js')

// 拼音表（缺失时静默降级为「只有精确档」，不抛错）
let PINYIN = {}
try {
  PINYIN = require('./pinyinDict.js') || {}
} catch (e) {
  PINYIN = {}
}

// ===== 一、一票否决 =====

// 改文指令：交给 utils/aiEdit.js 处理，本引擎不抢（句内判定）
const NEG_EDIT_WORDS = [
  '删掉', '删了', '删除', '删去', '去掉', '移除', '划掉',
  '改成', '改为', '换成', '替换成', '替换为', '更改为', '修改为', '变更为', '变成'
]

// 补充对象是「文字实体」：用户要改的是自己写的东西，不是要诗文（句内判定）
const NEG_TEXT_OBJ = [
  '这段话', '这句话', '这几句', '这两句', '这一句', '这一段', '这几段',
  '这里', '这个', '这段', '正文', '描述', '我的想法', '想法', '心情',
  '内容', '开头', '结尾', '语气', '表达', '上文', '前面这段', '上面这段'
]

// 明确不收：日记常用语（全局判定）
const NEG_CONTINUE_WORDS = ['继续往下写', '继续写下去', '接着往下写', '以后接着写', '明天接着写', '回头再写']

const MAX_COMMAND_LEN = 40

// ===== 二、触发词 =====

// 全文组：要整篇 / 整段
const TRIGGER_FULL = [
  '补充一下全文', '补充全文', '补齐全文', '补全全文', '补充完整', '补全一下全文',
  '补全', '补完', '帮我补全', '补齐', '补一下全文'
]

// 续写组：要后续几句（不重复已写出的句子）
const TRIGGER_NEXT_FEW = [
  '续上后边几句', '续上后面几句', '续上后边', '续上后面', '帮我续上', '帮我接上',
  '接后面句子', '接后面的话', '接后面几句', '后面怎么写的', '后面是什么',
  '接着写几句', '续几句', '接几句', '后面几句是什么'
]

// 单句组：只要紧接的一句
const TRIGGER_NEXT_ONE = [
  '加上后边一句', '加上后面一句', '补下一句', '补上下一句', '后面那句是什么',
  '下一句是啥', '下一句是什么', '后面一句是什么', '下一句', '后面那句是啥'
]

// 泛指组：只说「补充一下」而没指明范围。
// 单靠它什么也不做（必须过素材锚点闸，所以「补充一下明天要做的事」不触发），
// 但它让「把这句话补充一下」这类句子能走到否决闸 —— 被识别成「对象是文字实体」，
// 而不是含糊地掉进 no-trigger。判定顺序上排最后，不许抢详细组的活。
const TRIGGER_ANY = ['补充一下', '补充下', '补充一点', '补一下']

// 检索组：问句形状（人名 + 主题 → 找名言），靠正则而不是短语表，覆盖口语变体
const LOOKUP_RE = /(什么话来着|什么话|哪句话|哪一句|哪句|说过什么|说过啥|什么来着|是什么来着|是啥来着|有没有关于|有没有什么名言|有句关于|那句关于|关于.{0,10}的?那句|关于.{0,10}的一句)/

// 兜底标记：用户显式指定类别（优先级最高，可绕过 ②③ 的模糊判定，但仍需过 ①）
const MARK_KINDS = {
  '【诗文】': 'poem',
  '【名言】': 'quote',
  '【典故】': 'allusion',
  '【台词】': 'line'
}
const MARK_RE = /【(诗文|名言|典故|台词)】/

// ===== 三、素材锚点 =====

// D 作者人名库：诗词作者 / 典籍作者 / 外国作家哲人 / 常见文学人物
// 注意：人名只是「锚点」，必须与触发词同时命中才触发
const AUTHORS = [
  // 唐诗宋词元曲与古文
  '李白', '杜甫', '白居易', '王维', '孟浩然', '王之涣', '柳宗元', '贾岛', '李绅',
  '李商隐', '杜牧', '王勃', '陈子昂', '贺知章', '张若虚', '崔颢', '岑参', '高适',
  '王昌龄', '刘禹锡', '元稹', '李贺', '温庭筠', '韩愈', '柳永', '范仲淹', '欧阳修',
  '苏洵', '苏轼', '苏辙', '王安石', '曾巩', '晏殊', '晏几道', '秦观', '周邦彦',
  '辛弃疾', '李清照', '陆游', '杨万里', '朱熹', '岳飞', '文天祥', '李煜', '纳兰性德',
  '马致远', '张养浩', '郑燮', '龚自珍', '汤显祖', '关汉卿', '王实甫', '罗贯中',
  '施耐庵', '吴承恩', '曹雪芹',
  // 先秦诸子与史家
  '孔子', '孟子', '老子', '庄子', '荀子', '墨子', '韩非', '孙子', '曾子', '子思',
  '司马迁', '班固', '刘向', '左丘明', '屈原', '宋玉', '陶渊明', '曹操', '曹植',
  '嵇康', '阮籍', '刘勰', '王阳明', '洪应明', '周敦颐', '诸葛亮',
  // 外国作家 / 哲人 / 科学家
  '尼采', '叔本华', '康德', '黑格尔', '歌德', '席勒', '莎士比亚', '培根', '雨果',
  '托尔斯泰', '陀思妥耶夫斯基', '契诃夫', '屠格涅夫', '普希金', '泰戈尔', '罗曼·罗兰',
  '罗曼罗兰', '爱默生', '梭罗', '海明威', '马克·吐温', '马克吐温', '毛姆', '茨威格',
  '里尔克', '纪伯伦', '卡夫卡', '加缪', '萨特', '加西亚·马尔克斯', '博尔赫斯',
  '居里夫人', '爱因斯坦', '帕斯卡尔', '塞涅卡', '贝多芬', '牛顿', '马可·奥勒留',
  '柏拉图', '亚里士多德', '苏格拉底', '弗洛伊德', '荣格',
  // 中国近现代
  '鲁迅', '胡适', '林语堂', '钱钟书', '杨绛', '老舍', '巴金', '沈从文', '余华',
  '莫言', '路遥', '史铁生', '汪曾祺', '村上春树',
  // 文学人物（判词 / 台词类常见提问对象）
  '惜春', '黛玉', '林黛玉', '宝钗', '薛宝钗', '探春', '湘云', '史湘云', '妙玉',
  '迎春', '王熙凤', '李纨', '秦可卿', '贾宝玉', '孙悟空', '唐僧', '猪八戒',
  '武松', '林冲', '李逵', '刘备', '关羽', '张飞'
]

// E 文体词（双字及以上为主，避免「文」「句」这类单字满屏误命中）
const GENRE_WORDS = [
  '判词', '诗词', '古诗', '唐诗', '宋词', '元曲', '古文', '骈文', '原文', '全篇',
  '全文', '名句', '名言', '典故', '台词', '诗句', '对联', '碑文', '祭文', '散文', '诗经',
  '楚辞', '乐府', '绝句', '律诗', '词牌', '赋', '偈', '疏', '铭', '箴'
]

// [genre-v1] 「文体」与「范围」要分开：
//   · GENRE_SCOPE_WORDS 说的是范围（要全文/全篇/原文），不是文体 —— 既不当 genre 也不当篇名；
//   · GENRE_REAL_WORDS 才是真文体（判词/诗句/名言/典故/台词…），用来判「X 的 Y」里的 Y 是不是文体。
const GENRE_SCOPE_WORDS = ['全文', '全篇', '原文']
const GENRE_REAL_WORDS = GENRE_WORDS.filter(function (w) {
  return GENRE_SCOPE_WORDS.indexOf(w) < 0
})

// [genre-v1] 文体 → 素材类别（kind）。未列出的文体一律当古典诗文（判词/诗/词/赋/曲…）。
const GENRE_KINDS = {
  '名言': 'quote',
  '名句': 'quote',
  '典故': 'allusion',
  '台词': 'line'
}

// [genre-v1] 文学人物：这些名字是**人物**，不是作者。
// 「惜春的判词」里惜春是人物（作者是曹雪芹）；把人名塞进「作者」字段会诱导模型乱找。
// 必须是 AUTHORS 的子集（测试有断言）。
const CHARACTERS = [
  '惜春', '黛玉', '林黛玉', '宝钗', '薛宝钗', '探春', '湘云', '史湘云', '妙玉',
  '迎春', '王熙凤', '李纨', '秦可卿', '贾宝玉', '孙悟空', '唐僧', '猪八戒',
  '武松', '林冲', '李逵', '刘备', '关羽', '张飞'
]

// [genre-v1] 从「X 的 Y」抽 X 时的否决词：这些不是人物
const PERSON_STOP_WORDS = [
  '我', '你', '他', '她', '它', '咱', '您', '我们', '你们', '他们', '她们', '咱们',
  '自己', '别人', '大家', '这', '那', '这里', '那里', '什么', '谁', '人',
  '今天', '昨天', '明天', '现在', '当时', '以前', '时候', '时间',
  '心情', '生活', '工作', '事情', '内容', '意思', '感觉', '想法', '日记',
  // 指代词（「我喜欢的那句诗词」里的「那句」不是人物）
  '那句', '这句', '哪句', '哪首', '这首', '那首', '一篇', '一篇诗',
  // 作品名（不是人物：「红楼梦的判词」）
  '红楼梦', '西游记', '水浒传', '三国演义', '聊斋志异', '论语', '孟子',
  '大学', '中庸', '诗经', '楚辞', '史记', '汉书', '唐诗', '宋词'
]

// 名句相似锚点的前缀长度（归一化后比对）
const SNIPPET_PREFIX = 5

// ===== 四、长度档（2026-09-20 用户拍板：1 = 分级）=====
// 单句 50 / 续后文 100 / 全文 300；现代作品台词一律 ≤50（版权红线）
const LEN_LIMIT = {
  nextOne: 50,
  lookup: 50,
  line: 50,
  nextFew: 100,
  full: 300
}

// ===== 基础工具 =====

/* 归一化：去空白与标点（书名号/引号也去，触发词里不含这些） */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.、；;：:！!？?…~～\-—－_/\\|]+/g, '')
    .replace(/[《》「」『』“”‘’"'【】\[\]（）()]+/g, '')
}

/* 是否含中文 */
function hasChinese(s) {
  return /[\u4e00-\u9fa5]/.test(String(s || ''))
}

/* 词表命中（任一） */
function containsAny(n, list) {
  for (let i = 0; i < list.length; i++) {
    if (n.indexOf(norm(list[i])) >= 0) return list[i]
  }
  return ''
}

/* 逐字取首选拼音，拼成串（非汉字直接丢掉；标点忽略） */
function toPinyin(s) {
  const out = []
  const str = String(s == null ? '' : s)
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i)
    const py = PINYIN[ch]
    if (py) out.push(String(py).split(',')[0])
    else if (/[a-zA-Z0-9]/.test(ch)) out.push(ch.toLowerCase())
  }
  return out
}

/* 拼音数组编辑距离（0 = 完全同音） */
function pyDistance(a, b) {
  const n = a.length
  const m = b.length
  if (Math.abs(n - m) > 1) return 99
  const dp = []
  for (let i = 0; i <= n; i++) {
    dp.push([i])
    for (let j = 1; j <= m; j++) dp[i][j] = 0
  }
  for (let j = 0; j <= m; j++) dp[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[n][m]
}

/* 引号 / 书名号内部不切句：把内部标点换成掩码（等长），位置不变 */
function maskQuoted(text) {
  const chars = String(text).split('')
  const pairs = [['《', '》'], ['「', '」'], ['『', '』'], ['“', '”'], ['"', '"']]
  pairs.forEach(function (p) {
    const open = p[0]
    const close = p[1]
    let i = 0
    while (i < chars.length) {
      if (chars[i] !== open) { i++; continue }
      let j = i + 1
      while (j < chars.length && chars[j] !== close) j++
      if (j >= chars.length) break
      for (let k = i + 1; k < j; k++) {
        if (/[，,。.、；;：:！!？?…\n\r]/.test(chars[k])) chars[k] = '\u0001'
      }
      i = j + 1
    }
  })
  return chars.join('')
}

/* 切句（宽口径：任何标点都算边界），返回 [{text, start, end}]（不含分隔符） */
function splitSentences(text) {
  const src = String(text == null ? '' : text)
  const masked = maskQuoted(src)
  const out = []
  let start = 0
  for (let i = 0; i <= masked.length; i++) {
    const ch = i < masked.length ? masked.charAt(i) : '\n'
    const isSep = i === masked.length || /[，,。.、；;：:！!？?…\n\r]/.test(ch)
    if (!isSep) continue
    const seg = src.slice(start, i).trim()
    if (seg) out.push({ text: seg, start: start, end: i })
    start = i + 1
  }
  return out
}

/* 剥掉礼貌词与指令词后剩下的「实义内容」（判断整句是不是纯指令） */
const SOFT_WORDS = [
  '帮我', '请你', '请帮', '麻烦你', '麻烦', '帮我一下', '看一下', '看看', '给我',
  '我', '你', '请', '一下', '下', '个', '的', '吧', '呗', '呢', '啊', '呀', '哦',
  '嗯', '了', '来', '去', '把', '给', '看', '说', '讲', '写'
]
function commandCore(sent, triggers) {
  let s = norm(sent)
  triggers.forEach(function (t) { s = s.split(norm(t)).join('') })
  SOFT_WORDS.forEach(function (w) { s = s.split(w).join('') })
  // 补全动词也要剥：「帮我补一句」剥完只剩空串（整句就是指令）；
  // 而「我今天补了牙」剥完还剩「今天牙」（叙述句，不能被当指令删掉）
  FILL_VERBS.forEach(function (v) { s = s.split(v).join('') })
  return s
}
// 补全动词（用于判定「整句就是一条补全指令」）
const FILL_VERBS = ['补充', '补全', '补齐', '补上', '补一下', '续上', '接上', '接下去', '接着写', '加上', '补', '续']

// ===== 目标解析 =====

/* 在文本里找人名 */
function findAuthor(n) {
  for (let i = 0; i < AUTHORS.length; i++) {
    if (n.indexOf(norm(AUTHORS[i])) >= 0) return AUTHORS[i]
  }
  return ''
}

/* 剥掉篇名尾部的修饰词（「师说很好」→「师说」「判词是什么来着」→「判词」） */
const TITLE_TAIL_WORDS = [
  '是什么来着', '是什么来的', '怎么写来着', '是什么', '是啥', '写的很好', '写得很好',
  '很好', '不错', '真好', '太棒', '好极了', '经典', '有名', '那句', '这句', '的'
]
function trimTitle(raw) {
  let s = String(raw || '')
  s = s.split(/[，,。.、；;：:！!？?…\n\r]/)[0]
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < TITLE_TAIL_WORDS.length; i++) {
      const w = TITLE_TAIL_WORDS[i]
      if (s.length > w.length && s.slice(-w.length) === w) {
        s = s.slice(0, -w.length)
        changed = true
      }
    }
  }
  return s.trim()
}

/* 篇名的终止词：遇到就截断（「判词是帮我补充一下」→「判词」） */
const TITLE_STOP_WORDS = [
  '帮我', '请你', '请帮', '麻烦', '补充', '补全', '补齐', '补上', '续上', '接上',
  '一下', '是什么', '什么', '是', '来着', '是啥', '那句', '这句', '怎么', '为什么'
]

/* 篇名净化：先按终止词截断，再剥尾部修饰词 */
function cleanTitle(raw) {
  const s = String(raw || '')
  let cut = s.length
  TITLE_STOP_WORDS.forEach(function (w) {
    const i = s.indexOf(w)
    if (i >= 0 && i < cut) cut = i
  })
  return trimTitle(s.slice(0, cut))
}

// [genre-v1] 是不是「文体词」（不含「全文/全篇/原文」这类范围词）
function isGenreWord(w) {
  return GENRE_REAL_WORDS.indexOf(String(w == null ? '' : w).trim()) >= 0
}

/**
 * [genre-v1] 从指令残料里抽出「人物 + 文体」：
 *   惜春的判词 → { person: '惜春', genre: '判词' }
 *   李白的诗句 → { person: '',     genre: '诗句' }（李白是作者，不是人物）
 *   帮我补充一下 → null
 * 命中多个文体词时取最长的一个（「诗词」优先于「诗」）。
 */
function parseGenrePair(nTarget) {
  const s = String(nTarget == null ? '' : nTarget)
  let genre = ''
  for (let i = 0; i < GENRE_REAL_WORDS.length; i++) {
    const w = GENRE_REAL_WORDS[i]
    if (w.length <= genre.length) continue
    if (s.indexOf(w) >= 0) genre = w
  }
  if (!genre) return null
  const pre = s.slice(0, s.indexOf(genre))
  // 人物名最长 3 字（文学人物都 ≤3 字）；4 字以上多是「关于珍惜当下」这种主题短语
  const m = /([\u4e00-\u9fa5]{1,3})的$/.exec(pre)
  let person = m ? m[1] : ''
  if (person && PERSON_STOP_WORDS.indexOf(person) >= 0) person = ''
  // 「…里的 / …中的」收尾的是方位，不是人名（「红楼梦里的判词」）
  if (person && /[\u91cc\u4e2d\u4e0a\u4e0b\u5185\u5916\u540e\u524d\u95f4]$/.test(person)) person = ''
  // 「关于 X 的」里的 X 是**主题**，不是人物（「有没有关于珍惜当下的名言」）
  if (person && pre.indexOf('关于') >= 0) person = ''
  // 是「作者」而不是「人物」的不算（李白、韩愈…）
  if (person && AUTHORS.indexOf(person) >= 0 && CHARACTERS.indexOf(person) < 0) person = ''
  return { person: person, genre: genre }
}

// ===== 主函数 =====

/**
 * 识别素材补全请求
 * @param {string} content 正文（已在 aiEdit 剥离增删改指令之后）
 * @returns {Object} 判定结果（结构稳定，测试直接断言）
 */
function detect(content) {
  const text = String(content == null ? '' : content)
  const n = norm(text)
  const res = {
    hit: false,
    reason: 'no-trigger',
    negWord: '',
    trigger: '',
    group: '',
    mark: '',
    kind: '',
    mode: '',
    anchors: [],
    target: { author: '', person: '', genre: '', title: '', keyword: '', snippet: '' },
    commandRanges: [],
    commandTexts: [],
    pool: null,
    poolItem: null,
    approximate: false
  }

  // ---------- ① 全局否决 ----------
  if (!n || !hasChinese(text)) {
    res.reason = 'neg-empty'
    return res
  }
  const g = containsAny(n, NEG_CONTINUE_WORDS)
  if (g) {
    res.reason = 'neg-continue'
    res.negWord = g
    return res
  }

  const sents = splitSentences(text)
  if (!sents.length) {
    res.reason = 'neg-empty'
    return res
  }

  // ---------- ② 触发词 ----------
  const markMatch = MARK_RE.exec(text)
  if (markMatch) res.mark = '【' + markMatch[1] + '】'

  let hitSent = null
  let group = ''
  let trigger = ''
  let approximate = false

  function matchGroup(sent) {
    const sn = norm(sent)
    for (let i = 0; i < TRIGGER_NEXT_ONE.length; i++) {
      if (sn.indexOf(norm(TRIGGER_NEXT_ONE[i])) >= 0) return { g: 'nextOne', t: TRIGGER_NEXT_ONE[i] }
    }
    for (let i = 0; i < TRIGGER_NEXT_FEW.length; i++) {
      if (sn.indexOf(norm(TRIGGER_NEXT_FEW[i])) >= 0) return { g: 'nextFew', t: TRIGGER_NEXT_FEW[i] }
    }
    for (let i = 0; i < TRIGGER_FULL.length; i++) {
      if (sn.indexOf(norm(TRIGGER_FULL[i])) >= 0) return { g: 'full', t: TRIGGER_FULL[i] }
    }
    const lm = LOOKUP_RE.exec(sn)
    if (lm) return { g: 'lookup', t: lm[0] }
    for (let i = 0; i < TRIGGER_ANY.length; i++) {
      if (sn.indexOf(norm(TRIGGER_ANY[i])) >= 0) return { g: 'any', t: TRIGGER_ANY[i] }
    }
    return null
  }

  for (let i = 0; i < sents.length; i++) {
    const m = matchGroup(sents[i].text)
    if (m) {
      hitSent = sents[i]
      group = m.g
      trigger = m.t
      break
    }
  }

  // 近似档：精确档没命中时用拼音近似（要求完全同音 + 触发词 ≥4 音节）
  if (!hitSent && PINYIN) {
    const strongWords = TRIGGER_NEXT_ONE.concat(TRIGGER_NEXT_FEW, TRIGGER_FULL)
    for (let i = 0; i < sents.length && !hitSent; i++) {
      const pySent = toPinyin(norm(sents[i].text))
      for (let j = 0; j < strongWords.length && !hitSent; j++) {
        const pyTrig = toPinyin(norm(strongWords[j]))
        if (pyTrig.length < 4) continue
        for (let k = 0; k + pyTrig.length <= pySent.length; k++) {
          const win = pySent.slice(k, k + pyTrig.length)
          if (pyDistance(win, pyTrig) === 0) {
            hitSent = sents[i]
            trigger = strongWords[j]
            group = TRIGGER_NEXT_ONE.indexOf(strongWords[j]) >= 0 ? 'nextOne'
              : (TRIGGER_NEXT_FEW.indexOf(strongWords[j]) >= 0 ? 'nextFew' : 'full')
            approximate = true
            break
          }
        }
      }
    }
  }

  // 既没有触发词、也没有兜底标记 → 连候选都不是，直接退出。
  // 注意这步必须在否决闸**之前**：否则「今天心情像首诗一样」会被报成 neg-text-obj，
  // reason 语义失真，反例断言也失去区分度。
  if (!hitSent && !res.mark) {
    res.reason = 'no-trigger'
    return res
  }

  // ---------- ③ 句内否决（作用域 = 含触发词的那句；有标记无触发词时 = 全文）----------
  const scope = hitSent ? norm(hitSent.text) : n

  const ne = containsAny(scope, NEG_EDIT_WORDS)
  if (ne) {
    res.reason = 'neg-edit'
    res.negWord = ne
    return res
  }
  const nt = containsAny(scope, NEG_TEXT_OBJ)
  if (nt) {
    res.reason = 'neg-text-obj'
    res.negWord = nt
    return res
  }
  if (hitSent && scope.length > MAX_COMMAND_LEN) {
    res.reason = 'neg-long'
    res.negWord = scope.slice(0, 12)
    return res
  }

  // ---------- ④ 素材锚点 ----------
  // 目标词解析前先把触发词从归一化文本里剥掉（否则「补充全文」会被吃进篇名）。
  // 剥的是**全部**触发词而不只是命中的那一个，避免残留词混进篇名。
  let nTarget = n
  if (trigger) {
    TRIGGER_NEXT_ONE.concat(TRIGGER_NEXT_FEW, TRIGGER_FULL, TRIGGER_ANY).forEach(function (w) {
      nTarget = nTarget.split(norm(w)).join('')
    })
    nTarget = nTarget.replace(LOOKUP_RE, '')
  }

  const anchors = []
  const bm = /《([^》]{1,30})》/.exec(text)
  if (bm) anchors.push({ type: 'A', value: bm[1] })
  const qm = /[「『“"]([^」』”"]{1,60})[」』”"]/.exec(text)
  if (qm) anchors.push({ type: 'C', value: qm[1] })

  const author = findAuthor(nTarget)
  if (author) anchors.push({ type: 'D', value: author })

  // E 文体词（在含触发词的那句里找；有标记无触发词时看全文）
  const genreScope = hitSent ? norm(hitSent.text) : n
  for (let i = 0; i < GENRE_WORDS.length; i++) {
    const w = GENRE_WORDS[i]
    if (genreScope.indexOf(norm(w)) >= 0) {
      anchors.push({ type: 'E', value: w })
      break
    }
  }

  // ---------- 目标解析（必须排在池内反查之前：解析出的篇名要喂给 findByAnchor）----------
  // [genre-v1] 人物 / 文体分离：「惜春的判词」= 人物「惜春」+ 文体「判词」。
  // 旧实现把「判词」当篇名塞进 title，模型据此去找一部叫《判词》的作品，结果给出
  // 同回目、同人物的《虚花悟》（曲），把真正要的判词（28 字）换掉了。
  const gp = parseGenrePair(nTarget)
  const authorIsChar = !!author && CHARACTERS.indexOf(author) >= 0
  const target = {
    author: authorIsChar ? '' : author,
    person: (gp && gp.person) ? gp.person : (authorIsChar ? author : ''),
    genre: gp ? gp.genre : '',
    title: '', keyword: '', snippet: ''
  }
  if (bm) target.title = bm[1]
  if (qm) target.snippet = qm[1]

  // 「X 的 Y」/「X 那句 Y」：X 必须是人名库成员才认（否则「今天的心情」会被当成篇名）
  if (author) {
    const after = nTarget.slice(nTarget.indexOf(norm(author)) + norm(author).length)
    // 必须**紧跟**指代词或「的」才认篇名：「李白那句静夜思」✓ / 「尼采说过那句…」✗
    // （否则「说过那句关于生活的」会被 cleanTitle 截成「说过生活」这种假篇名，
    //   把检索类误判成补全类）
    const lead = /^(?:的|那句|这句|哪句|那首|这首|那一句|这一句|那一首|这一首|那篇|这篇)/.exec(after)
    if (lead) {
      const rawTitle = cleanTitle(after.slice(lead[0].length))
      // [genre-v1] 文体词不当篇名：「李白的诗句」里「诗句」是文体，不是一部叫《诗句》的作品
      //（「师说」「静夜思」这类真篇名不在文体词表里，照旧填 title）
      if (!target.title && !isGenreWord(rawTitle) && rawTitle.length >= 1 && rawTitle.length <= 10) target.title = rawTitle
    }
  }
  // 检索类的主题词：关于 X 的（终止符要覆盖「的」「那句」「话」等，且**不锚定字符串末尾**——
  // 指令后半截常还有「你帮我补充一下」跟在后面；这一条要在原文归一化串上找，
  // 不能用剥了触发词的 nTarget：LOOKUP_RE 会把「那句关于」整段吃掉，导致「关于」丢失）
  const km = /关于([\u4e00-\u9fa5A-Za-z]{1,10}?)(?:的|那句|哪句|一句|话|什么)/.exec(n)
  if (km) target.keyword = km[1]

  // B 池内篇名/作者 + F 名句相似
  const pool = dailyQuote.findByAnchor({
    text: text,
    title: target.title || (bm ? bm[1] : ''),
    author: author
  })
  if (pool) {
    const poolAnchorType = pool.by === 'text' ? 'F' : 'B'
    anchors.push({ type: poolAnchorType, value: pool.label })
    // 池内已有该篇名 → 用池内条目的正式名（仅篇名/片段命中时；作者命中不算，否则
    // 「尼采关于生活」会把《偶像的黄昏》当成篇名，把检索类误判成补全类）
    if (pool.by !== 'author' && !target.title) target.title = pool.title || ''
  }

  // 强锚点 = 书名号 / 池内篇名 / 引号句 / 名句片段（近似档必须命中其中之一）
  const strong = anchors.some(function (a) {
    return a.type === 'A' || a.type === 'B' || a.type === 'C' || a.type === 'F'
  })
  if (approximate && !strong) {
    res.reason = 'no-anchor'
    res.trigger = trigger
    res.group = group
    res.anchors = anchors
    return res
  }

  if (!anchors.length && !res.mark) {
    res.reason = 'no-anchor'
    res.trigger = trigger
    res.group = group
    res.anchors = anchors
    return res
  }

  // ---------- ⑤ 归类定级 ----------

  // kind
  let kind = ''
  if (res.mark) {
    kind = MARK_KINDS[res.mark]
  } else if (anchors.some(function (a) { return a.type === 'E' && a.value === '典故' })) {
    kind = 'allusion'
  } else if (anchors.some(function (a) { return a.type === 'E' && a.value === '台词' })) {
    kind = 'line'
  } else if (pool && pool.by !== 'author') {
    kind = pool.type === 'poem' ? 'poem' : 'quote'
  } else if (target.genre) {
    // [genre-v1] 用户点名了文体就按文体定类别（判词/诗/赋/曲 → 古典诗文；名言 → 名言…）
    kind = GENRE_KINDS[target.genre] || 'poem'
  } else if (target.title) {
    kind = 'poem'
  } else if (group === 'lookup') {
    kind = 'quote'
  } else {
    kind = 'poem'
  }

  // mode：显式触发词优先；否则有篇名/片段 = 补全类，只有人名 + 主题 = 检索类
  let mode = ''
  if (group === 'nextOne' || group === 'nextFew' || group === 'full') {
    mode = group
  } else if (res.mark && !group) {
    mode = 'full'
  } else {
    // [genre-v1] 「有具体指向」才算补全类：篇名 / 片段 / 人物 / 作者+文体。
    // 只有文体时仍归检索类（「有没有关于珍惜当下的名言」要的是检索一句，
    // 若误判成补全，长度档会从 50 撑到 300，模型会去凑一大段）。
    const hasPiece = !!(target.title || target.snippet) ||
      !!target.person || !!(target.genre && target.author) ||
      anchors.some(function (a) { return a.type === 'C' }) ||
      !!(pool && pool.by && pool.by !== 'author')
    mode = hasPiece ? 'full' : 'lookup'
  }
  // 篇名与检索式同时出现 → 补全优先（不许改成名言检索）
  if (mode === 'lookup' && (target.title || target.snippet)) mode = 'full'

  // ---------- 可直出的池内条目 ----------
  // 检索类必须走「作者 + 主题」检索；只按作者命中的池内条目**不能直出**
  // （否则「尼采关于生活」会被答成「每一个不曾起舞的日子」，答非所问）
  let poolItem = null
  if (mode === 'lookup') {
    // 检索类必须给出主题词才允许直出 —— 只按作者过滤会答非所问
    // （「尼采关于生活」若只按作者命中，会直出「每一个不曾起舞的日子…」）
    if (target.keyword) {
      const list = dailyQuote.findByTopic(target.author, target.keyword)
      poolItem = list.length ? list[0].item : null
    }
  } else if (pool && pool.by !== 'author') {
    poolItem = pool.item
  }

  // ---------- 指令句收集（strip 用）----------
  const commandRanges = []
  const commandTexts = []
  sents.forEach(function (s) {
    const sn = norm(s.text)
    let isCmd = false
    if (hitSent && s.start === hitSent.start) {
      isCmd = true
    } else if (LOOKUP_RE.test(sn) && (res.mark || author)) {
      isCmd = true
    } else {
      const hasFillVerb = FILL_VERBS.some(function (v) { return sn.indexOf(v) >= 0 })
      if (hasFillVerb && commandCore(s.text, []).length <= 2) isCmd = true
    }
    if (isCmd) {
      commandRanges.push([s.start, s.end])
      commandTexts.push(s.text)
    }
  })

  res.hit = true
  res.reason = 'ok'
  res.trigger = trigger
  res.group = group
  res.approximate = approximate
  res.anchors = anchors
  res.target = target
  res.kind = kind
  res.mode = mode
  res.commandRanges = commandRanges
  res.commandTexts = commandTexts
  res.pool = pool
  res.poolItem = poolItem
  return res
}

/**
 * 从正文里剥掉指令句（幂等：第二次点优化不会再命中）
 * @returns {string} 净正文
 */
function strip(content, res) {
  let text = String(content == null ? '' : content)
  const ranges = ((res && res.commandRanges) || []).slice()
  if (!ranges.length) return text.trim()
  ranges.sort(function (a, b) { return b[0] - a[0] })
  ranges.forEach(function (r) {
    let e = r[1]
    const tail = text.slice(e)
    const m = /^[，,。.、；;：:！!？?…\s\u3000]+/.exec(tail)
    if (m) e += m[0].length
    text = text.slice(0, r[0]) + text.slice(e)
  })
  // 清理首尾悬空标点（「韩愈的师说很好，补充全文」删完会剩一个逗号）
  text = text.replace(/^[，,。.、；;：:！!？?…\s\u3000]+/, '')
  text = text.replace(/[，,。.、；;：:！!？?…\s\u3000]+$/, '')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/* 池内条目 → 出处行文本（版本 B 的「—— 」后面那截） */
function poolSource(item) {
  if (!item) return ''
  if (item.type === 'poem') {
    const d = item.dynasty ? item.dynasty + '·' : ''
    return d + (item.author || '') + '《' + (item.title || '') + '》'
  }
  return (item.author || '') + (item.from || '')
}

/* 按句切分池内正文（保留句末标点；逗号也算界——中文诗句常以逗号作句内停顿，
   切细一点才能把「床前明月光，」这类已写片段精确裁掉） */
function splitClauses(body) {
  const s = String(body || '')
  const out = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    cur += ch
    if ('。！？；，'.indexOf(ch) >= 0) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 池内条目 → 本次真正要补的那段
 * @param {Object} item 池内条目
 * @param {string} mode full / nextFew / nextOne
 * @param {string} existing 正文里已写出的片段（续写时用来裁掉重复部分）
 */
function poolPiece(item, mode, existing) {
  const body = String((item && item.text) || '')
  if (!body) return ''
  if (mode !== 'nextOne' && mode !== 'nextFew') return body
  const clauses = splitClauses(body)
  const ex = norm(existing || '')
  // 已写出部分覆盖到第几句（按句累计比对，用户只写半句也能认出）
  let covered = 0
  if (ex) {
    let acc = ''
    for (let i = 0; i < clauses.length; i++) {
      acc += clauses[i]
      const cn = norm(clauses[i])
      if (cn.length >= 3 && ex.indexOf(cn) >= 0) covered = i + 1
      else if (cn.length >= 3 && cn.indexOf(ex) === 0 && ex.length >= cn.length - 1) covered = i + 1
      else if (norm(acc).length >= 3 && ex.indexOf(norm(acc)) >= 0) covered = i + 1
    }
  }
  if (!covered) {
    // 没有可裁掉的已写部分：从开头给（nextOne 给第一句，nextFew 给前 3 句）
    if (mode === 'nextOne') return clauses[0] || body
    let head = ''
    for (let i = 0; i < clauses.length && i < 3; i++) {
      if (head && (head + clauses[i]).replace(/\s+/g, '').length > LEN_LIMIT.nextFew) break
      head += clauses[i]
    }
    return head || body
  }
  const rest = clauses.slice(covered)
  if (!rest.length) return ''
  if (mode === 'nextOne') return rest[0]
  // nextFew：最多 3 句，且不超过 100 字
  let out = ''
  for (let i = 0; i < rest.length && i < 3; i++) {
    if (out && (out + rest[i]).replace(/\s+/g, '').length > LEN_LIMIT.nextFew) break
    out += rest[i]
  }
  return out || rest[0]
}

/* 池内条目 → 完整补全块（原文 + 出处行） */
function poolBlock(item, mode, existing) {
  if (!item) return ''
  const src = poolSource(item)
  const body = poolPiece(item, mode, existing)
  if (!body) return ''
  return src ? body + '\n—— ' + src : body
}

/* 池内条目 → 优化要点注释（进「优化要点」，不污染正文） */
function poolNote(item, mode) {
  if (!item) return ''
  const tail = (mode === 'nextOne' || mode === 'nextFew') ? '的后续句子' : ''
  if (item.type === 'poem') {
    const who = (item.dynasty || '') + (item.author || '')
    return '已补全《' + (item.title || '') + '》' + tail + (who ? '（' + who + '）' : '')
  }
  return '已补全' + (item.author || '') + tail + (item.from ? '（出自' + item.from + '）' : '')
}

/* 拼装优化稿：净正文 + 空行 + 补全块 */
function buildOptimized(cleanBody, block) {
  const body = String(cleanBody == null ? '' : cleanBody).trim()
  const blk = String(block == null ? '' : block).trim()
  if (!body) return blk
  if (!blk) return body
  return body + '\n\n' + blk
}

/* 去空白计字（与 dailyQuote.countChars 同口径：空白不计，标点计入） */
function countPlain(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').length
}

/* 按长度档裁剪；超限就截到 limit 字并补省略号（长诗只给名段） */
function clampText(text, limit) {
  const s = String(text == null ? '' : text)
  const n = Number(limit)
  if (!isFinite(n) || n < 1 || countPlain(s) <= n) return s
  let out = ''
  let cnt = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    out += ch
    if (!/\s/.test(ch)) cnt++
    if (cnt >= n) break
  }
  return out + '…'
}

/* 长度档查询（云端也按同一份口径裁剪） */
function lenLimitFor(mode, kind) {
  if (kind === 'line') return LEN_LIMIT.line
  return LEN_LIMIT[mode] || LEN_LIMIT.full
}

module.exports = {
  NEG_EDIT_WORDS,
  NEG_TEXT_OBJ,
  NEG_CONTINUE_WORDS,
  TRIGGER_FULL,
  TRIGGER_NEXT_FEW,
  TRIGGER_NEXT_ONE,
  TRIGGER_ANY,
  LOOKUP_RE,
  MARK_KINDS,
  GENRE_WORDS,
  GENRE_REAL_WORDS,
  GENRE_SCOPE_WORDS,
  GENRE_KINDS,
  CHARACTERS,
  PERSON_STOP_WORDS,
  AUTHORS,
  LEN_LIMIT,
  MAX_COMMAND_LEN,
  SNIPPET_PREFIX,
  norm,
  hasChinese,
  containsAny,
  toPinyin,
  pyDistance,
  maskQuoted,
  splitSentences,
  trimTitle,
  findAuthor,
  isGenreWord,
  parseGenrePair,
  detect,
  strip,
  poolSource,
  poolPiece,
  splitClauses,
  poolBlock,
  poolNote,
  buildOptimized,
  countPlain,
  clampText,
  lenLimitFor
}
