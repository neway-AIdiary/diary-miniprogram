/**
 * 云函数：optimizeDiary
 * 调用 DeepSeek 大模型完成：
 *   action='optimize'（默认）— 日记 AI 润色
 *   action='continue'       — 续写补全
 *   action='parse'          — AI 识别任意文本，提取结构化日记列表（供导入 txt 使用）
 *   action='tags'           — AI 根据日记内容自动生成标签（最多5个）
 *   action='organizeArchive' — AI 把用户按行输入的文本整理成结构化档案列表
 *   action='extractEntities'  — AI 从日记中提取人名/地名/机构名等实体
 *   action='merge'            — AI 把同一天的旧日记和新内容融合成一篇完整日记
 *   action='segment'          — AI 自动划分段落（只插入换行，严禁改动任何字符）
 *
 * 事件参数（optimize/continue）：
 *   content: 用户日记内容（必填）
 *   mood:    心情 key（可空，如 happy/sad）
 *   action:  'optimize' | 'continue'
 *
 * 事件参数（parse）：
 *   text:   待识别的任意文本（必填，超过 10000 字符会自动截断）
 *   today:  前端本地今天的日期 YYYY-MM-DD（供 AI 推断"今天/昨天"等相对日期）
 *   action: 'parse'
 *
 * 返回：
 *   { optimized, changes }        成功（optimize/continue）
 *   { diaries: [...] }            成功（parse）
 *   { error }                     失败（未配置 key / 网络错误等）
 *
 * 环境变量（在云开发控制台-云函数-配置中设置）：
 *   DEEPSEEK_API_KEY  必填，DeepSeek 平台的 API Key
 *
 * 说明：本函数不依赖 wx-server-sdk，仅用 Node 内置 https 模块调用
 *       DeepSeek，任何 Node 版本都能运行，部署无需安装依赖。
 */

const https = require('https')

const API_KEY = process.env.DEEPSEEK_API_KEY
const API_HOST = 'api.deepseek.com'
const API_PATH = '/chat/completions'
const MODEL = 'deepseek-chat'

// 心情中文映射
const MOOD_CN = {
  happy: '开心', calm: '平静', neutral: '平淡', sad: '难过',
  angry: '生气', love: '温暖', tired: '疲惫', excited: '兴奋',
  conflicted: '纠结', melancholy: '惆怅', mixed: '百感', gloomy: '郁闷', proud: '得意' // MARK:mood-v2-cn
}

/**
 * 构造不同任务的中文 prompt
 */
function buildPrompt(content, mood, action, archives, instruction) {
  // 心情仅作为背景信息供把握语气，独立成段、与正文分离，且明确禁止写进输出
  const moodHint = MOOD_CN[mood]
    ? '（背景信息，严禁输出：用户今天的心情是「' + MOOD_CN[mood] + '」）'
    : ''

  // 构造档案库提示语
  let archiveHint = ''
  if (archives && archives.length > 0) {
    const lines = archives.map(a => '- ' + a.name + (a.description ? '：' + a.description : ''))
    archiveHint = '\n\n用户的档案库中有以下条目，请确保日记中提到这些名称时使用正确的写法（如语音识别导致的错别字、简称不统一等，请自动纠正为档案库中的正确名称）：\n' + lines.join('\n')
  }

  // 构造用户自定义纠错指令
  let instructionHint = ''
  if (instruction && String(instruction).trim()) {
    instructionHint = '\n\n用户的特别纠错指令（请务必按照指令执行纠错）：\n' + String(instruction).trim()
  }

  if (action === 'continue') {
    // 角色与规则已分层至 buildSystemPrompt('continue')，此处只放动态上下文与正文
    return [
      archiveHint,
      instructionHint,
      '',
      '用户内容：',
      content
    ].filter(Boolean).join('\n')
  }

  // 默认：润色（角色与规则已分层至 buildSystemPrompt('optimize')，此处只放动态上下文与正文）
  return [
    archiveHint,
    instructionHint,
    moodHint,
    '',
    '用户日记：',
    content
  ].filter(Boolean).join('\n')
}

/**
 * 构造 optimize / continue 的 System Prompt（角色 + 规则 + 输出格式，逐字承接原 buildPrompt 内容）
 */
function buildSystemPrompt(action, ctx) {
  ctx = ctx || {}
  if (action === 'continue') {
    return [
      '你是一位富有文采的中文创作者。用户发来一段【未完成】的内容（可能是半首诗、半句词、文章开头等），请接着写下去把它补全。',
      '要求：',
      '1. 如果是古诗词：保持同样的风格与意境，注意对仗、平仄和押韵，续写的句子与原文浑然一体；',
      '2. 如果是散文或普通文字：顺着用户的语气和主题自然续写，不跑题；',
      '3. 续写部分紧接原文，不要重复用户已写的内容；',
      '4. 完整输出「原文 + 续写内容」的最终结果；',
      '5. 不要添加 emoji / 表情符号，也不要新增 markdown 符号（如 #、##、**）；原文已有的小标题行与列表保持原样。',
      '',
      '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
      '{"optimized":"原文加续写内容的完整文本","changes":["续写说明1","续写说明2"]}'
    ].join('\n')
  }

  // 素材补全（2026-09-20 新增）：只做「检索 + 核对」，不创作、不续写、不意译。
  // 客户端已做四层判定（前置否决 / 触发词 / 素材锚点 / 归类）并把指令句剥离，
  // 这里只负责查原文与出处。**查不到出处一律返回 error，客户端不落正文**。
  if (action === 'recite') {
    const kindCn = { poem: '古典诗文', quote: '名人名言', allusion: '典籍典故', line: '现代作品台词' }[ctx.kind] || '不限'
    const modeCn = {
      full: '要完整内容', nextFew: '要接下来的 1-3 句（≤100 字）',
      nextOne: '只要紧接的一句（≤50 字）', lookup: '检索类：某人关于某主题说过的话'
    }[ctx.mode] || '不限'
    return [
      '你是一位严谨的中国古典文学与名人名言的检索核对助手。用户写日记时记不全一句诗文/名言/典故/台词，向你求助。',
      '你的任务是**检索与核对**，不是创作。',
      '',
      '【最高原则（违反即视为失败）】',
      '1. 只输出你有把握的原文与出处。**说不准出处就把 recited 和 source 都留空**，绝不编造、绝不伪托、绝不意译改写、绝不"补一句像样的"。',
      '2. 不用「大意如此」「有说法认为」「出自某某之说」这类模糊表述凑答案。',
      '3. 不创作、不续写、不仿写、不润色用户的文字。',
      '',
      '【本次类别与范围】',
      '类别：' + kindCn,
      '范围：' + modeCn,
      '',
      '【同名系列文本必须区分（重要，违反即视为失败）】',
      '1. 同一部作品、同一个人物，常有**多套并列且互不相同**的文本：正册判词 / 判词 / 十二支曲 / 曲 / 歌 / 花名签 / 灯谜 / 诗 / 词。',
      '2. 必须严格按用户点名的**文体**给出对应的那一套；不得用同一人物、同一回目的另一套文本顶替。',
      '3. 用户点名文体（判词 / 曲 / 歌 / 诗 / 词 …）时，recited 只填该文体的文本，且要给完整的那一套（该体裁多长就给多长，不受「只给名段」影响）。',
      '4. 用户没点名文体时，给该人物流传最广、最短的那一套（通常就是判词或名句），并在 note 里写明这是哪一套。',
      '5. 正例：用户要「惜春的判词」→ recited 必须是「勘破三春景不长，缁衣顿改昔年妆。可怜绣户侯门女，独卧青灯古佛旁。」，source 写「《红楼梦》第五回 · 金陵十二钗正册」。',
      '6. 反例（**绝不允许**）：用户要「惜春的判词」却给出《虚花悟》（「将那三春看破，桃红柳绿待如何？…」）—— 那是第五回十二支曲之一，是**曲**不是判词，虽然同写惜春、同出第五回。同理「黛玉的判词」不能给《葬花吟》（那是诗）。',
      '',
      '【四类素材的长度上限】',
      '1. 古典诗文（诗/词/曲/赋/文）：可给全文，但不超过 300 字；超过 300 字的长篇只给最著名的一段，并在 note 注明「全文较长，此处为名段」。',
      '2. 典籍典故（四书五经、诸子、史书、笔记等）：可给原文，不超过 300 字。',
      '3. 名人名言：单条不超过 100 字，**必须说得出处**（作品名或场合）。',
      '4. 现代作品台词（小说、影视、歌词、中译本）：**只给那一句**，不超过 50 字；不得整段搬运、不得给续后文或全文。若用户要全文，recited 只给这一句，note 说明「该作品仍在版权保护期内，仅提供这一句」。',
      '',
      '【出处写法】',
      '- 古典诗文与典籍：如「《师说》· 韩愈」「《论语·述而》」；',
      '- 名人名言：如「尼采《偶像的黄昏》」；',
      '- 影视或现代作品：如「《百年孤独》· 加西亚·马尔克斯」。',
      '- source 里**不要**带「——」，客户端会自己加。',
      '',
      '【用户已写出的部分】',
      '- 用户正文里已经写出的原文片段**不要重复**，只给接下来的内容；若用户已把这条素材写完整，recited 留空并在 note 说明「后面没有了」。',
      '',
      '【检索类提问的处理】',
      '- 用户问「某人说过关于某主题的什么话」时：给出该人**确实说过**的一句并附出处。',
      '- 若流传版本有伪托风险（网上常见但查不到原始出处），**宁可不给**（recited 与 source 留空，note 说明「未能确认可靠出处」）。',
      '- 确有多条流传较广时，最多取 2 条放进 candidates，每条都要带出处。',
      '',
      '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
      '{"recited":"原文，不含出处行、不含引号","source":"出处","note":"一句简短说明（无内容时说明原因）","kind":"poem|quote|allusion|line","candidates":[{"recited":"","source":""}]}'
    ].join('\n')
  }

  if (action === 'extractEntities') {
    return [
    '你是一位文本分析助手。请从用户的日记中找出"用户对某个名词做了解释或说明"的内容，提取名词及其解释。',
    '只有日记中明确解释了"这个名词是什么/是谁"才提取；只是被提到、没有解释的名词一律不提取。',
    '名词提取规则（必须同时满足，缺一不可）：',
    '1. name 必须是单一名词（人名/地名/机构名/品牌名/物品名等专有名词），不能是短语、不能是完整句子；',
    '2. name 长度必须小于等于6个字；name 必须是完整的专有名词本体，严禁只截取长名称中的一段（如从"中国考古博物馆"里截出"古博物馆"）；',
    '3. 文中必须对 name 有明确解释说明，解释句式形如「XX是XXXX」「XX是我的XXXX」「XX叫XXXX」「XX就是XXXX」等；',
    '4. description 必须是对 name 的解释概括，而不是名词本身或另一个句子；',
    '5. 如果（完整的）名称超过6个字，或者 name 不是名词，一律不提取——超长时整条放弃，不得缩短、不得截取其中一段来凑长度；',
    '示例：',
    '- 日记写"小明是我大学同学" → 提取 name=小明, description=我的大学同学, explanation=是我大学同学',
    '- 日记写"我母亲叫王喜兰" → 提取 name=王喜兰, description=我的母亲, explanation=我母亲叫王喜兰',
    '- 日记写"那里是一个我们小时候经常去的水库西坝河水库" → 提取 name=西坝河水库, description=我们小时候经常去的水库, explanation=是一个我们小时候经常去的水库西坝河水库',
    '- 日记写"海洋大学，这是我的母校" → 提取 name=海洋大学, description=我的母校, explanation=这是我的母校',
    '- 日记写"腾讯是我工作的公司" → 提取 name=腾讯, description=我工作的公司, explanation=是我工作的公司',
    '- 日记写"今天去了腾讯公司，这个公司是我们公司的客户" → 提取 name=腾讯公司, description=我们公司的客户, explanation=这个公司是我们公司的客户',
    '- 反例：日记写"天又带孩子去上单簧管的课，孩子学了两年的课程" → 不提取，因为"天又带孩子去上单簧管的课"不是名词，而是一个完整句子',
    '- 反例：日记写"领导让我继续多待几天，我的也不清楚他希望我待到什么时候" → 不提取，因为其中没有≤6字的名词，也没有明确解释',
    '- 反例：日记写"中国考古博物馆是一家免费的小孩喜欢去的博物馆" → 完整名称"中国考古博物馆"有7个字、超过上限 → 整条不提取；绝不能缩短或截取成"古博物馆""考古博物馆""博物馆"这类片段，',
    '- 反例：日记写"为了完成认证，我的办理了个体工商户" → 不提取，因为"为了完成认证"不是名词，也不是专有名词',
    '- 反例：日记只写"今天和张三吃饭"（只是提到张三，没有解释他是谁）→ 不提取',
    '- 反例：日记只写"今天去了腾讯公司开会"（只是提到腾讯公司，没有解释它是什么）→ 不提取，即使你猜得出也不要提取、不要编造解释',
    '- 反例：日记写"小灰是我的猫"（解释"我的猫"只有3个字，不足4字）→ 不提取',
    '- 反例：日记写"晚上散步，顺路买了两注彩票，分别是巴西对阵挪威、墨西哥对阵英格兰" → 不提取，"分别"是副词/虚词，不是名词；"分别是…"也不是对"分别"的解释，只是叙述连接；',
    '- 反例：日记写"今天是四维图新入职的第一天，我没敢去的太早" → 不提取，"的第一天"带助词"的"、是短语而非名词；"四维图新"这里也只是被提到、没有解释它的含义，同样不提取；',
    '- 反例：日记写"但总是想着自己的事情，积极性是完全不一样的" → 不提取，"但总"是转折词"但"和副词"总是"被截出来的碎片、不是名词；"积极性"是常用抽象名词——这类词即使后面紧跟"是"，也不是被解释的专名；',
    '- 反例：日记写"智商是完全不一样的" → 不提取，这是「X是……的」比较/强调句，只是在比较差异，不是在解释"智商"是什么；凡名词后跟"是"、整句在说不同/一样的比较句一律不提取；',
    '- 反例：日记写"妈妈说这是豆子在呼吸" → 不提取，"妈妈说这"是言说动词"说"和代词"这"拼出来的叙述碎片、根本不是名词；"豆子"也只是被提到、没有解释它是什么；',
    '- 反例：日记正文开头是日期头"2023年10月2日 星期一 晴今天是一年一度的九月会" → 不提取，"晴今天"是天气字"晴"和时间词"今天"拼出来的碎片、不是名词；日期/时间表达（今天/昨天/明天/2023年5月/3月8日等）以及它们与其他字拼成的碎片一律不提取；',
    '- 反例：日记写"可正是水的柔和善变造就了它自身的魅力""因此我们总是让一天的时间匆匆而来" → 不提取，"可正"是语气副词"可"和"正是"被截出来的碎片、"因此我们总"是连词+代词+副词拼出来的碎片，都不是名词；绝不能把语气副词、连词、代词和后文拼成名词；',
    '- 反例：日记写"以下是为你介绍的高中日记10000字" → 不提取，"以下"是方位词、不是名词；只有人名/地名/事物名称/专用名词才需要提取备案；',
    '- 反例：日记写"每天晚上便是我最放松的时刻""风雨之后便是彩虹" → 不提取，"每天晚上便""风雨之后便"是时间短语和副词"便"拼出来的碎片、不是名词；"X便是Y"是副词加判断词、不是定义句；',
    '- 反例：日记写"村后是一片竹林" → 不提取，"村后"是"名词语素+方位字"的方位短语、不是名词；"村后/桌上/门前/心里"这类方位短语后面跟"是"是存在句、不是定义句；',
    '- 反例：日记写"他通常是晚上跑步""母亲总是起得很早" → 不提取，"通常"是频率副词、"母亲总"是"名词+总"的拼接碎片、都不是名词；"X总是Y""X通常是Y"不是定义句；',
    '- 反例：日记写"每年一次见他是我们家的习惯" → 不提取，"每年一次见他"是频率短语、不是名词；"军训/上课/开会"等日常活动常用词即使后面跟着解释也不要提取；',
    '- 反例：弹窗实录"军训""我们这嗨达""另外一项任务""仅仅"四条，解释均为编造（原文里根本没有这些句子） → explanation 必须从原文逐字复制，原文里没有的解释不要编造，宁可漏掉、不可编造；',
    '- 反例：日记写"俺们这嘎达到处都是积雪" → 不提取，"俺们这嘎达"是方言人称代词"俺们"与口语方位拼片"这嘎达"拼出来的碎片、不是名词；方言代词（俺/俺们/咱）及"这嘎达/那嘎达"类口语拼片一律不提取；',
    '- 反例：日记写"妈妈就给我姐夫打电话，叫我姐夫把我带出去去" → 不提取，"姐夫打电话"是主谓短语（人+动作）不是名词；"叫"是喊/让的意思不是"是"，且"叫"前面隔着逗号、属于下一个分句，绝不能把逗号后的"叫我…"当成对前面词语的解释；',
    '补充硬性要求：name 必须是原文中真实出现的专有名词本体，绝不能是"分别/一共/然后/大概/可能/都/也/还/其中/主要"这类虚词、副词、连接词；name 里不得含"的/了/是"等助词；判断"是否被解释"时，必须是「名词 + 是/叫/就是…」这种针对该名词本体的定义句式，不能把名词后面任意一段文字当成解释；',
    '补充硬性要求二：不要提取以"性"结尾的常用抽象名词（积极性/可能性/重要性/主动性/灵活性等）；也不要把转折词、副词和后面的文字拼接成碎片当名词（如"但总是…"绝不能截出"但总"）；',
    '补充硬性要求三：「名词 + 是……(不)一样的/不同的」是比较或强调句式，不是定义句，一律不提取；以"吧/吗"等疑问、揣测语气收尾的也不是定义句，不要提取；只有整句在说明"该名词是什么/是谁"时才算被解释；',
    '补充硬性要求四：「说的是/告诉我是/写的是/画的是/描述的是」等转述句式，后面跟的是说话内容、不是对名词的定义，一律不提取；name 本体绝不能含"说/讲/写/画/描述/告诉"等动词或以"这/那"结尾；',
    '补充硬性要求五：绝不提取日期、时间词及其任何拼接碎片——今天/明天/昨天/今日/明日/去年/今年/前天/后天等时间词、2023年5月/3月8日/10月1日等日期表达、以及天气字或其他内容与时间词拼成的串（如"晴今天"）都不是名词本体，一律不提取；',
    '补充硬性要求六：name 绝不能是虚词拼接碎片——不得以"可/竟/倒/便"等语气副词开头，不得含"因此/但是/因为/所以/虽然/然后/我们/他们/自己"等连词、代词成分；这些碎片即使后面紧跟"是"也不是被解释的名词；',
    '补充硬性要求七：只提取人名、地名、机构名、物品名、专用名词等真正的名词；方位词（以下/以上/以内/之外/旁边/周围等）和其他常用泛词一律不提取，即使后面紧跟"是"也不是定义；',
    '补充硬性要求八：不得把时间短语（每天晚上/风雨之后/比赛结束等）与"便/即/竟/倒"等副词拼成名词；"X便是/X即是/X竟是"这类副词+判断词组合不是对名词的定义，一律不提取；',
    '补充硬性要求九：「名词语素+方位字」构成的方位短语（村后/桌上/门前/屋里/心里等）不是名词，一律不提取；它们后面跟"是"是存在句（某处有什么），不是定义句；',
    '补充硬性要求十：explanation 字段必须是原文中逐字存在的片段（一般是名词后面的解释句）；原文里找不到的解释一律不要编造；泛指短语（另外一项任务/一个计划类）和副词（仅仅/单单）即使后面跟"是"也不要提取；',
    '补充硬性要求十一：绝不提取频率/情态副词及其拼接碎片——"通常/总是/经常/常常/往往/从来/偶尔/一直/似乎"这类副词、"母亲总/我们总/比赛总"这类以"总"收尾的3字以上拼接都不是名词本体，一律不提取；',
    '要求：',
    '1. 只提取日记中带有解释说明的专有名词（人名/地名/机构名/物品名等）；单纯提到而没有解释的名词，绝对不要提取，也不得为其编造 description；',
    '2. 必须明确判断用户有"解释意图"：只有「XX是XXXX」这类定义句式（是/就是/这是/他是/她是/它是/叫/名叫/叫做等引导）才算解释；解释内容（description）必须不少于4个字，不足4个字的解释（如"是我朋友""是我妈"）视为只是提及，不要提取；',
    '3. description 必须来自日记原文中对名词的实际解释，去掉"是/这是/就是/叫"等引导词，以"我的xx""我xx的xx"等形式概括，不超过30字；',
    '4. explanation 为该解释在日记原文中的逐字片段（不含名词本身，从原文原样复制，可含"他是/这是/就是我/叫"等引导词，不含名词前后的逗号），用于备案弹窗预览展示；不得改写、不得编造，如果原文中没有解释片段则不要提取该名词；',
    '5. 每个实体包含 name（名称）、description（概括解释）、explanation（原文解释片段）、type（person/place/org/other）；',
    '6. name 字段里不能出现"是/去/上/让/带/做/吃/待/等/为了/然后"等叙述词或连接词，必须是纯粹的名词；',
    '7. 不要提取常见动词、形容词、普通名词（如"工作"、"开心"、"日记"）；',
    '8. 绝不提取数量词（一个/一趟/十斤/百分之一/第一次等一切「数词+量词」组合和纯数字表达）、代词（我/你/他/她/它/我们/大家/她们/它们/自己/对方/彼此等）、动词（吃饭/出发/见面/坚持等）、形容词（开心/高兴/疲惫/热闹等）——这些词即使后面紧跟"是/叫"等引导词也不是名词，一律不提取；',
    '9. 不要提取时间词（如"今天"、"昨天"、"8月14日"）；',
    '10. 同一名词只出现一次；',
    '11. 如果日记中没有任何带解释的名词，返回空数组。',
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"entities":[{"name":"王磊","description":"我的大学同学","explanation":"他是我大学同学","type":"person"},{"name":"海洋大学","description":"我的母校","explanation":"这是我的母校","type":"place"}],"persons":["王磊","张三"]}',
    '',
    '【附加任务 · 与上面的 entities 完全独立，不得互相影响】',
    '无论是否被解释过，请另外把日记中出现的**所有人名**单独列进 persons 数组：',
    '1. 只要是人名就列（可以只是被提到，不需要任何解释）——例如"今天和张三吃饭"应列出"张三"；',
    '2. 每条 2~4 个字，必须是原文中**原样出现**的人名本体，不得改写、不得编造、不得从更长的词里截取；',
    '3. 不收地名、机构名、品牌名、称谓（如"老王""领导""同事""妈妈"）、代词、时间词；',
    '4. 不收并非人名的常见词语（如"周末""高兴""方式""出差"）；',
    '5. 没有把握的一律不收：宁可漏掉，也不要猜、不要编造；',
    '6. 没有则返回空数组 []。'
  ].join('\n')
  }

  if (action === 'merge') {
    return [
    '你是一位细腻的中文日记整理助手。用户在同一天记录了两份日记内容，请把它们融合成一篇连贯、完整、有文采的日记。',
    '要求：',
    '1. 保留两份内容中所有重要的事实、事件、人物和细节，不要遗漏，不要虚构原文中没有的内容；',
    '2. 如果两份内容描述了同一件事，合并去重，不要重复描述；',
    '3. 按事情发生的时间顺序组织段落，让文章连贯流畅，过渡自然；',
    '4. 语气与已有日记保持一致，可以适当润色但不堆砌辞藻、不改变事实；',
    '5. 如果内容中提到的人物/机构/地名在档案库中有正确写法，请自动纠正；',
    '6. 输出融合后的完整日记文本；',
    '7. 如果提供了心情背景信息，严禁写进输出——不得添加「今天的心情：xxx」「心情：xxx」等任何标注或总结行，输出必须是纯日记正文；',
    '8. 不要添加 emoji / 表情符号，也不要新增 markdown 符号（如 #、##、**）；原文已有的小标题行与列表保持原样。',
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"merged":"融合后的完整日记文本"}'
  ].join('\n')
  }

  if (action === 'parse') {
    return [
    '你是一位文本整理助手。用户提供一段杂乱的文本（可能是聊天记录、备忘录、随手记、多篇日记的合集，也可能本身就是一篇日记），请从中识别出「日记 / 事件记录」内容，整理成结构化日记列表。',
    '要求：',
    '1. 从文本中识别出每天的记录，尽量按天拆分为多篇日记；如果整段文本就是一篇日记，则整理为一篇；',
    '2. 每篇日记包含三个字段：',
    '   - date: 日记日期，格式 YYYY-MM-DD。根据文本内容推断（如"8月14日"、"2026-08-14"、"昨天"、"今天"；今天是 ' + ctx.today + '）。实在无法推断的留空字符串；',
    '   - mood: 当天心情，用中文词（开心/平静/一般/难过/生气/幸福/疲倦/兴奋/纠结/惆怅/百感/郁闷/得意 之一），文本中没有心情信息则留空字符串；',
    '   - content: 日记正文，尽量保留原文语句，可做轻微整理使其通顺，但不要虚构原文里没有的内容；',
    '3. 明显与日记无关的内容（广告、系统消息、纯寒暄问候、无意义的重复）应忽略，不要生成日记；',
    '4. 如果整段文本明显就是一篇日记或随笔，即使没有明确日期，也要整理为至少一篇日记（date 可用 ' + ctx.today + ' 推断或留空，但不要返回空数组）；',
    '5. 文本太短或没有可识别的日记内容时，返回空数组。',
  ].join('\n')
  }

  if (action === 'extractMetaBatch') {
    return [
    '你是一位日记整理助手。用户提供了 ' + ctx.itemCount + ' 篇已切分好的日记（每篇已标注 index 编号、日期和正文），请只做一件事：为每一篇分别提取「日期 / 心情 / 天气 / 标签」四个字段。',
    '字段说明（每篇独立提取，绝不要把不同篇的内容混在一起）：',
    '   - date: 日记日期，格式 YYYY-MM-DD。优先沿用该篇「已提供日期」；仅当正文明确写了另一个日期时才纠正它；无法确定则留空字符串；',
    '   - mood: 当天心情，从「开心/平静/一般/难过/生气/幸福/疲倦/兴奋/纠结/惆怅/百感/郁闷/得意」中选一个；正文没有心情描述则留空字符串；',
    '   - weather: 天气描述，如「晴」「多云」「下雨」「阴天」等，可带温度（如「晴 28°」）；正文没提天气则留空字符串；',
    '   - tags: 中文关键词标签，每个 2-4 个字，最多 5 个，从该篇正文实际提到的主题/事件/人物/心情提炼；正文确实无主题则返回空数组；',
    '     严禁虚词/代词/碎片词（反例：一家、是一、好的、这个、我们），必须是实义词或专名；',
    '要求：',
    '1. 只输出严格 JSON，不要输出任何其他文字；',
    '2. 不修改、不重写正文，只提取字段；',
    '3. 每篇输出一条结果，index 必须与输入完全一致，按输入顺序排列；',
    '4. 正文里没有的信息一律留空字符串或空数组，绝不虚构、不猜测。',
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"results":[{"index":0,"date":"2026-08-14","mood":"开心","weather":"晴 28°","tags":["加班","项目"]}]}'
  ].join('\n')
  }

  if (action === 'tags') {
    return [
    '你是一位日记整理助手。请根据用户的日记内容，提炼出最能概括这篇日记的关键词标签。',
    '要求：',
    '1. 最多 5 个标签，最少 1 个；内容确实无主题时返回空数组；',
    '2. 每个标签为 2-4 个字的中文词（如：跑步、加班、家人、旅行）；',
    '3. 标签来自日记实际提到的主题/事件/人物/心情，不要虚构；',
    '4. 标签之间不重复、不近义（如"开心"和"高兴"只留一个）。',
    '5. 严禁输出虚词、代词、量词、碎片词（反例：一家、是一、好的、这个、我们、时候、可以）；',
    '   标签必须是「实义词或专名」——名词优先（如：跑步、加班、家人、四维图新、北汽新能源）。',
  ].join('\n')
  }

  if (action === 'organizeArchive') {
    return [
    '你是一位档案整理助手。用户按行输入了一些人物、机构或事物的备注信息，请把它们整理成结构化的档案列表。',
    '要求：',
    '1. 每一行或每一段是一个条目，提取出「名称」和「描述」两个字段；',
    '2. 名称必须是「名词性主体」——人名、地名、机构名、物品名、概念名，长度 2~6 个字（个别专有名词可放宽到 9 个字，如「中科院附属实验中学」）；',
    '   名称绝不能是句子：不得包含逗号、句号、问号、感叹号、顿号、分号等标点，也不得是一段随口说的话；',
    '3. 如果用户写的格式已经是"名称：描述"，直接拆分即可；如果没有明显分隔符，请先找出其中像名词的主体作名称，其余内容作描述；',
    '4. 找不到合格名词时（例如整段是碎句、没有明确主体），name 返回空字符串，把整段原文放进 description，不要硬造一句话当名称；',
    '5. 合并重复的条目（相同名称的只保留一个，描述合并）；',
    '6. 忽略空白行和无意义的内容；',
    '7. 不要虚构原文中没有的信息。',
    '',
    '反例（禁止）：把整句话当名称 → {"name":"继续换行这个两行就够了三号显示三姓氏"}；',
    '正确做法 → {"name":"","description":"继续换行这个两行就够了三号显示三姓氏"}（没名词就不给名称）。',
    '',
    '示例输入：',
    '张三：好朋友，认识十几年了，经常一起玩游戏',
    '腾讯：我工作的公司，位置在中关村软件园',
    '',
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"archives":[{"name":"张三","description":"好朋友，认识十几年了，经常一起玩游戏"}]}'
  ].join('\n')
  }

  if (action === 'segment') {
    return [
    '你是一位日记排版助手。用户写了一篇日记（常由语音输入转写而来，整段没有换行），请只做一件事：在合适的位置插入换行符，把正文划分成自然段落。',
    '要求：',
    '1. 严禁增、删、改任何文字、标点或符号——输出必须与输入逐字一致，你只能添加换行符（\\n）；',
    '2. 依据话题转换、时间推进、事件切换等自然边界分段；不要每句话都断开，也不要一整块不动，一般划分 2-5 段为宜；',
    '3. 输入里已有的换行保持原样，只在此基础上补充；',
    '4. 只输出严格 JSON，不要输出任何其他文字：{"segmented":"分段后的完整正文"}（正文中的换行用 \\n 转义）。',
  ].join('\n')
  }

  // 默认：润色
  return [
    '你是一位细腻的中文日记润色专家。用户写了一段日记（常由语音输入转写而来），请在不改变事实、不虚构内容的前提下润色它：',
    '要求：',
    '1. 让语言更生动、更有文采，但不堆砌辞藻；',
    '2. 保留用户的个人语气和原文结构，不要大改重写；',
    '3. 清理语音转写残留的口吃和重复：说话卡壳造成的叠字要去掉（「同同同时」→「同时」、「我我我」→「我」），说到一半重启的重复片段要去掉（「都是都，都是一个」→「都是一个」、「这个事情这个事情」→「这个事情」）；但正常的叠词（「试试」「看看」「慢慢」）和表达情绪的重复（「哈哈」「呜呜」）必须保留；',
    '4. 语音转写会按停顿在每个短句后插逗号，句子常被切得很碎（如「路上差点，撞车，有一个人强行加塞，特别危险」）：请按书面语重新断句，把被逗号切碎的短碎片合并成通顺完整的句子，只在语义确实需要停顿处保留标点；但不得改变原意，也不得合并成难以阅读的超长句；',
    '5. 不添加原内容里没有的情节或事实；',
    '6. 如果日记中出现了档案库中已有的人物/机构/地名，但写法有误（如语音识别导致的错别字、同音字、简称不统一），请自动纠正为档案库中的正确名称；',
    '7. 输出润色后的完整文本，并附 3-5 条简短优化要点；',
    '8. 如果提供了用户今日心情，它只是背景信息，严禁写进输出——不得在正文开头或末尾添加「今天的心情：xxx」「心情：xxx」等任何标注或总结行；',
    '9. 不要添加 emoji / 表情符号，也不要新增 markdown 符号（如 #、##、**）；但如果原文本身已有小标题行（如「◆ 标题」）或列表，请保留其原样，不要删改结构；',
    '10. 输出必须是润色后的纯日记正文。',
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"optimized":"润色后的完整日记文本","changes":["优化要点1","优化要点2","优化要点3"]}'
  ].join('\n')
}

/**
 * 构造 parse（AI 识别文本为日记列表）的 prompt
 */
// ===== 素材补全（recite）专用：文体词 =====
// 客户端把锚点 E（文体词）命中的词暂存在 target.title 里；这些词本身是**文体**
// 而不是篇名，单列出来告诉模型，避免它去凑一部叫《判词》的作品。
// 只放「单独出现时必然是文体词」的词 —— 「师说」「赤壁赋」这类真篇名不在表内。
const RECITE_GENRE_WORDS = [
  '判词', '诗词', '诗', '词', '曲', '赋', '古文', '名句', '台词', '原文',
  '全篇', '篇', '碑文', '祭文', '对联', '檄文', '散文', '诗经'
]

/**
 * 素材补全（recite）的 user prompt：只放动态上下文（类别/范围/作者/篇名/主题/原文片段）与正文。
 * 角色与规则已分层至 buildSystemPrompt('recite')。
 */
function buildRecitePrompt(content, payload) {
  const p = payload || {}
  const t = p.target || {}
  const lines = []
  const kindCn = { poem: '古典诗文', quote: '名人名言', allusion: '典籍典故', line: '现代作品台词' }[p.kind]
  const modeCn = {
    full: '完整内容', nextFew: '接下来的 1-3 句', nextOne: '紧接的一句',
    lookup: '检索：该人关于该主题说过的话'
  }[p.mode]
  if (kindCn) lines.push('用户要的类别：' + kindCn)
  if (modeCn) lines.push('用户要的范围：' + modeCn)
  // [genre-v1] 人物与文体分列：客户端已把「惜春的判词」解析成 人物=惜春 / 文体=判词。
  // 旧实现把人物塞进「作者」、把文体塞进「篇名」，模型据此去找一部叫《判词》的作品，
  // 结果拿同回目同人物的《虚花悟》（曲）顶替了判词。
  if (t.author) lines.push('涉及作者：' + t.author)
  if (t.person) lines.push('涉及人物：' + t.person)
  if (t.genre) lines.push('要求的文体：' + t.genre + '（必须严格按此文体给出，不得用同一人物的其他文体顶替）')
  // 兼容旧客户端：文体词曾被塞进 t.title，这里单列提示，避免模型误当成一部叫《判词》的作品
  if (t.title) {
    if (RECITE_GENRE_WORDS.indexOf(String(t.title).trim()) !== -1) {
      lines.push('提到的文体（不是篇名，请据此推断用户的真实指向，如「惜春的判词」→《红楼梦》第五回惜春判词）：' + t.title)
    } else {
      lines.push('涉及篇名：' + t.title)
    }
  }
  if (t.keyword) lines.push('涉及主题：' + t.keyword)
  if (t.snippet) lines.push('用户提到的原文片段：' + t.snippet)
  lines.push('')
  lines.push('用户日记正文（可能夹杂与本次求助无关的内容，只处理补全请求那一部分）：')
  lines.push(String(content || '（用户只写了求助本身，没有其他正文）'))
  return lines.join('\n')
}

function buildParsePrompt(text, today) {
  return [
    '待整理文本：',
    text
  ].join('\n')
}

/**
 * 构造 tags（AI 自动打标签）的 prompt
 */
function buildTagsPrompt(content, mood) {
  const moodText = MOOD_CN[mood] ? ('\n当天心情：' + MOOD_CN[mood]) : ''
  return [
    '用户日记：',
    content,
    moodText
  ].join('\n')
}

/**
 * 构造 organizeArchive（AI 整理档案）的 prompt
 */
function buildArchivePrompt(text, instruction) {
  let instructionHint = ''
  if (instruction && String(instruction).trim()) {
    instructionHint = '\n\n用户的特别纠错指令（请务必按照指令执行纠错）：\n' + String(instruction).trim()
  }
  return [
    instructionHint,
    '',
    '用户输入：',
    text
  ].join('\n')
}

/**
 * 构造 extractEntities（AI 提取"用户解释过的名词"）的 prompt
 * 只有日记中对名词做了解释/说明（如"王磊是我大学同学"）才提取，并带出解释内容
 */
function buildExtractEntitiesPrompt(content) {
  return [
    '用户日记：',
    content
  ].join('\n')
}

/**
 * 构造 segment（自动划分段落）的 prompt
 * 与润色的区别：这是纯排版任务——只允许插入换行符，严禁改动任何文字/标点，
 * 因为它由「保存日记」自动触发，用户并未请求 AI 介入，忠实性是第一优先级
 */
function buildSegmentPrompt(content) {
  return [
    '日记正文：',
    content
  ].join('\n')
}

/**
 * 构造 merge（AI 融合同一天的多份日记为一份）的 prompt
 */
function buildMergePrompt(oldContent, newContent, oldMood, newMood, archives, instruction) {
  // 心情仅作背景信息，独立成段且严禁写入融合结果
  const moodHint = (MOOD_CN[oldMood] || MOOD_CN[newMood])
    ? ('（背景信息，严禁输出：已有日记心情「' + (MOOD_CN[oldMood] || '未记录') + '」，新内容心情「' + (MOOD_CN[newMood] || '未记录') + '」，仅供把握语气）')
    : ''

  // 构造档案库提示语
  let archiveHint = ''
  if (archives && archives.length > 0) {
    const lines = archives.map(a => '- ' + a.name + (a.description ? '：' + a.description : ''))
    archiveHint = '\n\n用户的档案库中有以下条目，融合时若提到这些名称请使用正确写法（自动纠正语音识别错别字、简称不统一等）：\n' + lines.join('\n')
  }

  // 构造用户自定义纠错指令
  let instructionHint = ''
  if (instruction && String(instruction).trim()) {
    instructionHint = '\n\n用户的特别纠错指令（请务必按照指令执行纠错）：\n' + String(instruction).trim()
  }

  return [
    archiveHint,
    instructionHint,
    moodHint,
    '',
    '【已有日记】',
    oldContent,
    '',
    '【新内容】',
    newContent,
  ].filter(Boolean).join('\n')
}

/**
 * 构造 extractMetaBatch（对已切分好的多篇日记，逐篇提取 日期/心情/天气/标签）的 prompt
 * 与 parse 的区别：本地已经把块切好（date+content 已定），这里只让 AI 做单一任务——填字段，不切分、不重写正文
 * @param {Array<{index:number, date:string, content:string}>} items
 */
function buildExtractMetaBatchPrompt(items) {
  const listText = items.map(it =>
    '【第' + (it.index + 1) + '篇】index=' + it.index + '\n已提供日期：' + (it.date || '（未知）') + '\n正文：\n' + it.content
  ).join('\n\n')

  return [
    '日记列表：',
    listText
  ].join('\n')
}

/**
 * 调用 DeepSeek（Node 内置 https，无第三方依赖）
 */
function callDeepSeek(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 25000
    }, (res) => {
      // 关键：按字节块收集，最后一次性整体 UTF-8 解码。
      // 若写成 data += chunk，会逐块解码，多字节字符（中文 3 字节、emoji 4 字节）
      // 恰好被切在块边界时会解码失败，变成 U+FFFD 乱码（界面上显示为「♦?」）。
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) })
        } catch (e) {
          resolve({ status: res.statusCode, body: { raw: data } })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * 公共：调用 DeepSeek 并解析出 JSON 对象
 * @returns {Promise<{parsed?: object, error?: string}>}
 */
// 允许紧邻名词左侧的功能字/动词：除此之外左侧出现汉字即视为「从长名词里截取的子串」
// ===== 标签质量闸（tagjunk v1 · 与小程序端 utils/tags.js 逐字一致，勿分叉）=====
// 背景：「双字滑窗词频兜底」在中文里必然产出虚词碎片（一家 / 是一 / 好的），
//       用户侧表现为详情页标签里出现无意义词。此处对 AI 返回的标签再过一道闸。
const TAG_HEAD_STOP_CHARS = '是的了着过在很都也就还又这那我你他她它们谁怎一两有没不别太挺因所但而或和跟与把被让给从向往于为以及等之其此真'
// 尾字只保留「结构助词 / 语气词」——过/就/都/也/还/很 这些一律不做尾字判据：
// 它们是正经词的合法结尾（难过、走过、就好…），拦下来属于误伤，不值得。
const TAG_TAIL_STOP_CHARS = '的了着是在呢吗吧啊呀哦嗯嘛地得'
const TAG_JUNK_WORDS = ['一家', '两家', '这家', '那家', '是一', '好的', '一个', '两个', '这个', '那个', '什么', '怎么', '我们', '你们', '他们', '她们', '自己', '时候', '东西', '事情', '感觉', '真的', '可以', '因为', '所以']

/**
 * 标签是否有意义（与小程序端 utils/tags.js 的 isMeaningfulTag 同规则）
 * @param {string} word
 * @returns {boolean}
 */
function isMeaningfulTag(word) {
  const w = String(word || '').trim()
  if (!w) return false
  if (w.length < 2 || w.length > 6) return false
  if (!/^[A-Za-z0-9\u4e00-\u9fa5·]+$/.test(w)) return false
  if (/^[0-9]+$/.test(w)) return false
  if (TAG_JUNK_WORDS.indexOf(w) !== -1) return false
  if (TAG_HEAD_STOP_CHARS.indexOf(w.charAt(0)) !== -1) return false
  if (TAG_TAIL_STOP_CHARS.indexOf(w.charAt(w.length - 1)) !== -1) return false
  return true
}

const PRE_NOUN_CHARS = '和跟与同对的了我你他她它们咱您于在从把被让给找见问说叫带陪还有去来到就也都又再想要会能没不很太以及等是做为'

/**
 * 名词左侧边界是否干净：前一字符不是汉字，或属于允许紧邻名词的功能字/动词
 */
function hasCleanLeftBoundary(text, idx) {
  if (idx <= 0) return true
  const prev = String(text).charAt(idx - 1)
  if (!/[\u4e00-\u9fa5]/.test(prev)) return true
  return PRE_NOUN_CHARS.indexOf(prev) !== -1
}

/**
 * 名称在原文中是否存在「左侧边界干净」的出现位置（不满足则视为截取长名词得到的残缺子串）
 */
function hasStandaloneOccurrence(name, text) {
  const t = String(text || '')
  const n = String(name || '')
  if (!n) return false
  let idx = t.indexOf(n)
  while (idx !== -1) {
    if (hasCleanLeftBoundary(t, idx)) return true
    idx = t.indexOf(n, idx + n.length)
  }
  return false
}

async function runPrompt(prompt, maxTokens, temperature, systemPrompt) {
  const res = await callDeepSeek({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt || '你只输出严格的 JSON，不要输出任何其他内容。' },
      { role: 'user', content: prompt }
    ],
    temperature: (typeof temperature === 'number') ? temperature : 0.8,
    max_tokens: maxTokens || 2500,
    response_format: { type: 'json_object' }
  })

  if (res.status !== 200) {
    const msg = (res.body && (res.body.error && res.body.error.message || res.body.message)) || res.status
    return { error: 'AI 接口错误: ' + msg }
  }

  const raw = res.body.choices && res.body.choices[0] && res.body.choices[0].message && res.body.choices[0].message.content
  if (!raw) {
    return { error: 'AI 返回为空' }
  }

  // 解析 JSON（个别情况 AI 可能夹带多余字符，做容错）
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // 尝试提取第一个 { ... } 块
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1))
      } catch (e2) {
        parsed = null
      }
    }
  }
  return { parsed: parsed }
}

exports.main = async (event, context) => {
  const action = String(((event && event.action) || 'optimize')).trim()

  // ===== parse：AI 识别任意文本为日记列表 =====
  if (action === 'parse') {
    const text = String((event && event.text) || '').trim()
    if (!text) return { error: '内容为空' }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const today = (event && event.today) || ''
    const limited = text.length > 10000 ? text.slice(0, 10000) : text
    const prompt = buildParsePrompt(limited, today)
    try {
      const r = await runPrompt(prompt, 4000, undefined, buildSystemPrompt('parse', { today: today }))
      if (r.error) return { error: r.error }
      const diaries = (r.parsed && Array.isArray(r.parsed.diaries)) ? r.parsed.diaries : []
      return { diaries: diaries, count: diaries.length }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== recite：日记素材补全（诗文 / 名言 / 典故 / 台词）=====
  // 客户端已完成四层判定并把指令句剥离，这里只查原文与出处。
  // **查不到出处一律返回 error**（不返回半真半假的答案，客户端据此不落正文）。
  if (action === 'recite') {
    const body = String((event && event.content) || '').trim()
    const payload = (event && event.payload) || {}
    // 纯求助句（如「尼采说过那句关于生活的什么话来着，你帮我补充一下」）剥离指令后
    // 净正文本来就为空 —— 这是**合法请求**，故只在「正文与目标信息都空」时判空；
    // 否则用户会看到「需要连接 AI 服务」的假故障（客户端降级误报）。
    const tg = payload.target || {}
    const hasTarget = !!(String(tg.author || '').trim() || String(tg.title || '').trim() ||
      String(tg.keyword || '').trim() || String(tg.snippet || '').trim())
    if (!body && !hasTarget) return { error: '内容为空' }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    try {
      const r = await runPrompt(buildRecitePrompt(body, payload), 1200, 0.2, buildSystemPrompt('recite', payload))
      if (r.error) return { error: r.error }
      const p = r.parsed || {}
      const recited = String(p.recited || '').trim()
      const source = String(p.source || '').trim()
      const note = String(p.note || '').trim()
      // 无出处不出（用户拍板 3.A）：宁可让用户看到「未能确认出处」，也不给伪托内容
      if (!recited) return { error: note || '未能确认出处，未补全' }
      if (!source) return { error: note || '未能确认出处，未补全' }
      return {
        recited: recited,
        source: source,
        note: note,
        kind: String(p.kind || payload.kind || '').trim(),
        candidates: Array.isArray(p.candidates) ? p.candidates.slice(0, 2) : []
      }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== tags：AI 自动打标签 =====
  if (action === 'tags') {
    const tagContent = String((event && event.content) || '').trim()
    if (!tagContent) return { tags: [] }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const tagMood = (event && event.mood) || ''
    const prompt = buildTagsPrompt(tagContent, tagMood)
    try {
      const r = await runPrompt(prompt, 300, undefined, buildSystemPrompt('tags'))
      if (r.error) return { error: r.error }
      let tags = (r.parsed && Array.isArray(r.parsed.tags)) ? r.parsed.tags : []
      // 清洗：过质量闸（虚词/碎片词）、去空白、去重、过滤超长项，最多5个
      const seen = new Set()
      tags = tags
        .map(t => String(t || '').trim().slice(0, 6))
        .filter(t => t && isMeaningfulTag(t) && !seen.has(t) && seen.add(t))
        .slice(0, 5)
      return { tags: tags }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== segment：自动划分段落（只插换行，不改字符；由保存日记后静默触发） =====
  if (action === 'segment') {
    const segContent = String((event && event.content) || '')
    if (!segContent.trim()) return { error: '内容为空' }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const segLimited = segContent.length > 6000 ? segContent.slice(0, 6000) : segContent
    const segPrompt = buildSegmentPrompt(segLimited)
    try {
      // 低温度（0.2）：任务是逐字复刻 + 加换行，越「笨」越稳
      const r = await runPrompt(segPrompt, Math.min(8000, segLimited.length + 800), 0.2, buildSystemPrompt('segment'))
      if (r.error) return { error: r.error }
      const seg = String((r.parsed && r.parsed.segmented) || '').trim()
      // 忠实性校验（云函数侧第一道，前端还会再校验一次）：
      // 去掉所有空白字符后必须与原文逐字一致，防止模型擅自增删改字
      const norm = (s) => String(s || '').replace(/\s+/g, '')
      if (!seg || norm(seg) !== norm(segLimited)) return { error: '分段结果校验未通过' }
      return { segmented: seg }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== organizeArchive：AI 整理档案 =====
  if (action === 'organizeArchive') {
    const rawText = String((event && event.text) || '').trim()
    if (!rawText) return { error: '内容为空' }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const instruction = (event && event.instruction) || ''
    const limited = rawText.length > 5000 ? rawText.slice(0, 5000) : rawText
    const prompt = buildArchivePrompt(limited, instruction)
    try {
      const r = await runPrompt(prompt, 2000, undefined, buildSystemPrompt('organizeArchive'))
      if (r.error) return { error: r.error }
      const archives = (r.parsed && Array.isArray(r.parsed.archives)) ? r.parsed.archives : []
      // 清洗
      // 名称硬约束（与小程序端 utils/archiveEdit.js 的 isTermName 一致）：
      // 超过 9 字或含句读标点 = 一整句话被误当名称 → 丢弃本条，不返回给小程序
      const NAME_MAX = 9
      const NAME_PUNCT_RE = /[，,。.！!？?；;、：:…“”‘’（）()【】\[\]《》<>"']/
      const cleaned = []
      let dropped = 0
      archives.forEach(a => {
        const name = String(a.name || '').trim()
        if (!name || name.length > NAME_MAX || NAME_PUNCT_RE.test(name)) {
          dropped++
          return
        }
        cleaned.push({
          name: name,
          description: String(a.description || '').trim().slice(0, 500)
        })
      })
      return { archives: cleaned, count: cleaned.length, dropped: dropped }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== extractEntities：AI 提取人名/地名/机构名 =====
  if (action === 'extractEntities') {
    const entContent = String((event && event.content) || '').trim()
    if (!entContent) return { entities: [] }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const prompt = buildExtractEntitiesPrompt(entContent.slice(0, 5000))
    try {
      const r = await runPrompt(prompt, 1000, undefined, buildSystemPrompt('extractEntities'))
      if (r.error) return { error: r.error }
      let entities = (r.parsed && Array.isArray(r.parsed.entities)) ? r.parsed.entities : []
      // 清洗（explanation 为原文解释片段，供备案弹窗预览展示）
      const seen = new Set()
      // 名词黑名单（与小程序端 utils/aiCloud.js 同步，改动必须两处一起改）
      // 单字只在「名词首字」否决：含字即拦会误杀 北汽新能源(能)/蔚来汽车(来)/上汽集团(上)
      const NAME_BLOCK_HEAD_CHARS = ['是', '的', '了', '着', '和', '跟', '与', '同', '在', '到', '从', '把', '被',
  '给', '叫', '说', '想', '要', '又', '还', '也', '就', '都', '让', '做', '吃', '待', '等', '去', '走', '看', '带']
      const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么']
      const hasBlockedNameWord = (raw) => {
        const n = String(raw || '').trim()
        if (!n) return true
        if (NAME_BLOCK_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
        return NAME_BLOCK_WORDS.some(w => n.indexOf(w) !== -1)
      }
      // [person-hotword A'] 人名清洗：这里只做**格式级**清洗（长度/字符集/原文出现/去重），
      // 语义级清洗（虚词/代词/时间词/数量词表）交给客户端 utils/entityClean.js —— 那边有完整词表。
      // 人名与 entities 完全解耦：它只用于语音热词沉淀，不参与备案弹窗。
      const cleanPersons = (raw, content) => {
        const list = Array.isArray(raw) ? raw : []
        const text = String(content || '')
        const seenP = new Set()
        const out = []
        for (let i = 0; i < list.length; i++) {
          const n = String(list[i] == null ? '' : list[i]).trim()
          if (!n || n.length < 2) continue
          if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
          // 含「·」的译名/少数民族名放宽到 12 字；其余人名按 2~4 字
          if (n.indexOf('·') === -1 && n.length > 4) continue
          if (n.length > 12) continue
          if (seenP.has(n)) continue
          if (text.indexOf(n) === -1) continue
          if (hasBlockedNameWord(n)) continue
          seenP.add(n)
          out.push(n)
          if (out.length >= 20) break
        }
        return out
      }
      entities = entities
        .map(e => ({
          name: String(e.name || '').trim().slice(0, 50),
          description: String(e.description || '').trim().slice(0, 50),
          explanation: String(e.explanation || '').trim().slice(0, 60),
          type: ['person', 'place', 'org', 'other'].includes(e.type) ? e.type : 'other'
        }))
        .filter(e => {
          if (!e.name || !e.description) return false
          const name = e.name
          const desc = e.description
          // 硬规则：name 必须是 2-6 字的名词；description 必须有实际解释意义
          if (name.length < 2 || name.length > 6) return false
          if (desc.length < 4 || desc.length > 30) return false
          // name 命中黑名单（与小程序端同一份规则）
          if (hasBlockedNameWord(name)) return false
          // name 不能是指示/人称代词开头
          if (/^[这那他她它们我你您我们你们他们她们]./.test(name)) return false
          // name 不能是纯数字、纯英文（允许中英混合）
          if (/^[0-9]+$/.test(name) || /^[a-zA-Z]+$/.test(name)) return false
          // 名称必须在原文中有「左侧边界干净」的出现位置：拦截从更长专有名词里截出的子串
          // （原文「中国考古博物馆是一家…」误提取为「古博物馆」时，其前一字符「考」暴露了截取行为）
          if (!hasStandaloneOccurrence(name, entContent)) return false
          // 同一名词去重
          if (seen.has(name)) return false
          seen.add(name)
          return true
        })
      return { entities: entities, persons: cleanPersons(r.parsed && r.parsed.persons, entContent) }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== extractMetaBatch：对已切分好的多篇日记，逐篇提取 日期/心情/天气/标签 =====
  if (action === 'extractMetaBatch') {
    const items = Array.isArray(event && event.items) ? event.items.slice(0, 10) : []
    if (!items.length) return { results: [] }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const norm = items.map((it, i) => ({
      index: (typeof it.index === 'number') ? it.index : i,
      date: String((it && it.date) || '').trim(),
      content: String((it && it.content) || '').slice(0, 2000)
    })).filter(it => it.content)
    if (!norm.length) return { results: [] }
    const prompt = buildExtractMetaBatchPrompt(norm)
    try {
      // 识别类任务用低温度，结果更稳定、不瞎编
      const r = await runPrompt(prompt, 1500, 0.2, buildSystemPrompt('extractMetaBatch', { itemCount: norm.length }))
      if (r.error) return { error: r.error }
      const rawResults = (r.parsed && Array.isArray(r.parsed.results)) ? r.parsed.results : []
      const cleaned = rawResults.map(x => ({
        index: parseInt(x && x.index, 10) || 0,
        date: String((x && x.date) || '').trim(),
        mood: String((x && x.mood) || '').trim(),
        weather: String((x && x.weather) || '').trim(),
        tags: (Array.isArray(x && x.tags) ? x.tags : [])
          .map(t => String(t || '').trim().slice(0, 6))
          .filter(t => t && isMeaningfulTag(t))
          .slice(0, 5)
      }))
      return { results: cleaned }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== merge：AI 融合同一天的多份日记为一份 =====
  if (action === 'merge') {
    const oldContent = String((event && event.oldContent) || '').trim()
    const newContent = String((event && event.newContent) || '').trim()
    if (!oldContent || !newContent) return { error: '内容为空' }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    const oldMood = (event && event.oldMood) || ''
    const newMood = (event && event.newMood) || ''
    const archives = (event && event.archives) || []
    const instruction = (event && event.instruction) || ''
    const prompt = buildMergePrompt(oldContent.slice(0, 6000), newContent.slice(0, 6000), oldMood, newMood, archives, instruction)
    try {
      const r = await runPrompt(prompt, 2500, undefined, buildSystemPrompt('merge'))
      if (r.error) return { error: r.error }
      const merged = (r.parsed && typeof r.parsed.merged === 'string')
        ? r.parsed.merged.trim()
        : ''
      if (!merged) return { error: 'AI 返回格式异常' }
      return { merged: merged }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== optimize / continue：润色 / 续写 =====
  const content = ((event && event.content) || '').trim()
  const mood = (event && event.mood) || ''
  const archives = (event && event.archives) || []
  const instruction = (event && event.instruction) || ''
  const realAction = action === 'continue' ? 'continue' : 'optimize'

  if (!content) {
    return { error: '内容为空' }
  }
  if (!API_KEY) {
    return { error: '服务端未配置 DEEPSEEK_API_KEY' }
  }

  const prompt = buildPrompt(content, mood, realAction, archives, instruction)

  try {
    const r = await runPrompt(prompt, 2500, undefined, buildSystemPrompt(realAction))
    if (r.error) return { error: r.error }
    const parsed = r.parsed

    if (parsed && typeof parsed.optimized === 'string') {
      return {
        optimized: parsed.optimized,
        changes: Array.isArray(parsed.changes) ? parsed.changes : [],
        action: realAction
      }
    }

    return { error: 'AI 返回格式异常' }
  } catch (err) {
    return { error: '调用 AI 失败: ' + (err && err.message || err) }
  }
}
