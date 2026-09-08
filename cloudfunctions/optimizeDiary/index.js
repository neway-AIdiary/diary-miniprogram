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
  angry: '生气', love: '温暖', tired: '疲惫', excited: '兴奋'
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
    return [
      '你是一位富有文采的中文创作者。用户发来一段【未完成】的内容（可能是半首诗、半句词、文章开头等），请接着写下去把它补全。',
      '要求：',
      '1. 如果是古诗词：保持同样的风格与意境，注意对仗、平仄和押韵，续写的句子与原文浑然一体；',
      '2. 如果是散文或普通文字：顺着用户的语气和主题自然续写，不跑题；',
      '3. 续写部分紧接原文，不要重复用户已写的内容；',
      '4. 完整输出「原文 + 续写内容」的最终结果。',
      archiveHint,
      instructionHint,
      '',
      '用户内容：',
      content,
      '',
      '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
      '{"optimized":"原文加续写内容的完整文本","changes":["续写说明1","续写说明2"]}'
    ].filter(Boolean).join('\n')
  }

  // 默认：润色
  return [
    '你是一位细腻的中文日记润色专家。用户写了一段日记（常由语音输入转写而来），请在不改变事实、不虚构内容的前提下润色它：',
    '要求：',
    '1. 让语言更生动、更有文采，但不堆砌辞藻；',
    '2. 保留用户的个人语气和原文结构，不要大改重写；',
    '3. 清理语音转写残留的口吃和重复：说话卡壳造成的叠字要去掉（「同同同时」→「同时」、「我我我」→「我」），说到一半重启的重复片段要去掉（「都是都，都是一个」→「都是一个」、「这个事情这个事情」→「这个事情」）；但正常的叠词（「试试」「看看」「慢慢」）和表达情绪的重复（「哈哈」「呜呜」）必须保留；',
    '4. 不添加原内容里没有的情节或事实；',
    '5. 如果日记中出现了档案库中已有的人物/机构/地名，但写法有误（如语音识别导致的错别字、同音字、简称不统一），请自动纠正为档案库中的正确名称；',
    '6. 输出润色后的完整文本，并附 3-5 条简短优化要点；',
    '7. 如果提供了用户今日心情，它只是背景信息，严禁写进输出——不得在正文开头或末尾添加「今天的心情：xxx」「心情：xxx」等任何标注或总结行；',
    '8. 输出必须是润色后的纯日记正文。',
    archiveHint,
    instructionHint,
    moodHint,
    '',
    '用户日记：',
    content,
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"optimized":"润色后的完整日记文本","changes":["优化要点1","优化要点2","优化要点3"]}'
  ].filter(Boolean).join('\n')
}

/**
 * 构造 parse（AI 识别文本为日记列表）的 prompt
 */
function buildParsePrompt(text, today) {
  return [
    '你是一位文本整理助手。用户提供一段杂乱的文本（可能是聊天记录、备忘录、随手记、多篇日记的合集，也可能本身就是一篇日记），请从中识别出「日记 / 事件记录」内容，整理成结构化日记列表。',
    '要求：',
    '1. 从文本中识别出每天的记录，尽量按天拆分为多篇日记；如果整段文本就是一篇日记，则整理为一篇；',
    '2. 每篇日记包含三个字段：',
    '   - date: 日记日期，格式 YYYY-MM-DD。根据文本内容推断（如"8月14日"、"2026-08-14"、"昨天"、"今天"；今天是 ' + today + '）。实在无法推断的留空字符串；',
    '   - mood: 当天心情，用中文词（开心/平静/一般/难过/生气/幸福/疲倦/兴奋 之一），文本中没有心情信息则留空字符串；',
    '   - content: 日记正文，尽量保留原文语句，可做轻微整理使其通顺，但不要虚构原文里没有的内容；',
    '3. 明显与日记无关的内容（广告、系统消息、纯寒暄问候、无意义的重复）应忽略，不要生成日记；',
    '4. 文本太短或没有可识别的日记内容时，返回空数组。',
    '',
    '待整理文本：',
    text,
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"diaries":[{"date":"2026-08-14","mood":"开心","content":"日记正文"}]}'
  ].join('\n')
}

/**
 * 构造 tags（AI 自动打标签）的 prompt
 */
function buildTagsPrompt(content, mood) {
  const moodText = MOOD_CN[mood] ? ('\n当天心情：' + MOOD_CN[mood]) : ''
  return [
    '你是一位日记整理助手。请根据用户的日记内容，提炼出最能概括这篇日记的关键词标签。',
    '要求：',
    '1. 最多 5 个标签，最少 1 个；内容确实无主题时返回空数组；',
    '2. 每个标签为 2-4 个字的中文词（如：跑步、加班、家人、旅行）；',
    '3. 标签来自日记实际提到的主题/事件/人物/心情，不要虚构；',
    '4. 标签之间不重复、不近义（如"开心"和"高兴"只留一个）。',
    '',
    '用户日记：',
    content,
    moodText,
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"tags":["标签1","标签2"]}'
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
    '你是一位档案整理助手。用户按行输入了一些人物、机构或事物的备注信息，请把它们整理成结构化的档案列表。',
    '要求：',
    '1. 每一行或每一段是一个条目，提取出「名称」和「描述」两个字段；',
    '2. 名称是条目的主体（如人名、公司名、地名等），描述是对该主体的说明；',
    '3. 如果用户写的格式已经是"名称：描述"，直接拆分即可；如果没有明显分隔符，请智能识别名称和描述；',
    '4. 合并重复的条目（相同名称的只保留一个，描述合并）；',
    '5. 忽略空白行和无意义的内容；',
    '6. 不要虚构原文中没有的信息。',
    instructionHint,
    '',
    '示例输入：',
    '张三：好朋友，认识十几年了，经常一起玩游戏',
    '腾讯：我工作的公司，位置在中关村软件园',
    '',
    '用户输入：',
    text,
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"archives":[{"name":"张三","description":"好朋友，认识十几年了，经常一起玩游戏"}]}'
  ].join('\n')
}

/**
 * 构造 extractEntities（AI 提取"用户解释过的名词"）的 prompt
 * 只有日记中对名词做了解释/说明（如"王磊是我大学同学"）才提取，并带出解释内容
 */
function buildExtractEntitiesPrompt(content) {
  return [
    '你是一位文本分析助手。请从用户的日记中找出"用户对某个名词做了解释或说明"的内容，提取名词及其解释。',
    '只有日记中明确解释了"这个名词是什么/是谁"才提取；只是被提到、没有解释的名词一律不提取。',
    '名词提取规则（必须同时满足，缺一不可）：',
    '1. name 必须是单一名词（人名/地名/机构名/品牌名/物品名等专有名词），不能是短语、不能是完整句子；',
    '2. name 长度必须小于等于4个字；',
    '3. 文中必须对 name 有明确解释说明，解释句式形如「XX是XXXX」「XX是我的XXXX」「XX叫XXXX」「XX就是XXXX」等；',
    '4. description 必须是对 name 的解释概括，而不是名词本身或另一个句子；',
    '5. 如果 name 本身超过4个字，或者 name 不是名词，一律不提取。',
    '示例：',
    '- 日记写"小明是我大学同学" → 提取 name=小明, description=我的大学同学, explanation=是我大学同学',
    '- 日记写"我母亲叫王喜兰" → 提取 name=王喜兰, description=我的母亲, explanation=我母亲叫王喜兰',
    '- 日记写"那里是一个我们小时候经常去的水库西坝河水库" → 提取 name=西坝河水库, description=我们小时候经常去的水库, explanation=是一个我们小时候经常去的水库西坝河水库',
    '- 日记写"海洋大学，这是我的母校" → 提取 name=海洋大学, description=我的母校, explanation=这是我的母校',
    '- 日记写"腾讯是我工作的公司" → 提取 name=腾讯, description=我工作的公司, explanation=是我工作的公司',
    '- 日记写"今天去了腾讯公司，这个公司是我们公司的客户" → 提取 name=腾讯公司, description=我们公司的客户, explanation=这个公司是我们公司的客户',
    '- 反例：日记写"天又带孩子去上单簧管的课，孩子学了两年的课程" → 不提取，因为"天又带孩子去上单簧管的课"不是名词，而是一个完整句子',
    '- 反例：日记写"领导让我继续多待几天，我的也不清楚他希望我待到什么时候" → 不提取，因为其中没有≤4字的名词，也没有明确解释',
    '- 反例：日记写"为了完成认证，我的办理了个体工商户" → 不提取，因为"为了完成认证"不是名词，也不是专有名词',
    '- 反例：日记只写"今天和张三吃饭"（只是提到张三，没有解释他是谁）→ 不提取',
    '- 反例：日记只写"今天去了腾讯公司开会"（只是提到腾讯公司，没有解释它是什么）→ 不提取，即使你猜得出也不要提取、不要编造解释',
    '- 反例：日记写"小灰是我的猫"（解释"我的猫"只有3个字，不足4字）→ 不提取',
    '要求：',
    '1. 只提取日记中带有解释说明的专有名词（人名/地名/机构名/物品名等）；单纯提到而没有解释的名词，绝对不要提取，也不得为其编造 description；',
    '2. 必须明确判断用户有"解释意图"：只有「XX是XXXX」这类定义句式（是/就是/这是/他是/她是/它是/叫/名叫/叫做等引导）才算解释；解释内容（description）必须不少于4个字，不足4个字的解释（如"是我朋友""是我妈"）视为只是提及，不要提取；',
    '3. description 必须来自日记原文中对名词的实际解释，去掉"是/这是/就是/叫"等引导词，以"我的xx""我xx的xx"等形式概括，不超过30字；',
    '4. explanation 为该解释在日记原文中的逐字片段（不含名词本身，从原文原样复制，可含"他是/这是/就是我/叫"等引导词，不含名词前后的逗号），用于后续从原文中删除解释部分；不得改写、不得编造，如果原文中没有解释片段则不要提取该名词；',
    '5. 每个实体包含 name（名称）、description（概括解释）、explanation（原文解释片段）、type（person/place/org/other）；',
    '6. name 字段里不能出现"是/去/上/让/带/做/吃/待/等/为了/然后"等叙述词或连接词，必须是纯粹的名词；',
    '7. 不要提取常见动词、形容词、普通名词（如"工作"、"开心"、"日记"）；',
    '8. 不要提取时间词（如"今天"、"昨天"、"8月14日"）；',
    '9. 同一名词只出现一次；',
    '10. 如果日记中没有任何带解释的名词，返回空数组。',
    '',
    '用户日记：',
    content,
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"entities":[{"name":"王磊","description":"我的大学同学","explanation":"他是我大学同学","type":"person"},{"name":"海洋大学","description":"我的母校","explanation":"这是我的母校","type":"place"}]}'
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
    '你是一位细腻的中文日记整理助手。用户在同一天记录了两份日记内容，请把它们融合成一篇连贯、完整、有文采的日记。',
    '要求：',
    '1. 保留两份内容中所有重要的事实、事件、人物和细节，不要遗漏，不要虚构原文中没有的内容；',
    '2. 如果两份内容描述了同一件事，合并去重，不要重复描述；',
    '3. 按事情发生的时间顺序组织段落，让文章连贯流畅，过渡自然；',
    '4. 语气与已有日记保持一致，可以适当润色但不堆砌辞藻、不改变事实；',
    '5. 如果内容中提到的人物/机构/地名在档案库中有正确写法，请自动纠正；',
    '6. 输出融合后的完整日记文本；',
    '7. 如果提供了心情背景信息，严禁写进输出——不得添加「今天的心情：xxx」「心情：xxx」等任何标注或总结行，输出必须是纯日记正文。',
    archiveHint,
    instructionHint,
    moodHint,
    '',
    '【已有日记】',
    oldContent,
    '',
    '【新内容】',
    newContent,
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"merged":"融合后的完整日记文本"}'
  ].filter(Boolean).join('\n')
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
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
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
async function runPrompt(prompt, maxTokens) {
  const res = await callDeepSeek({
    model: MODEL,
    messages: [
      { role: 'system', content: '你只输出严格的 JSON，不要输出任何其他内容。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.8,
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
      const r = await runPrompt(prompt, 4000)
      if (r.error) return { error: r.error }
      const diaries = (r.parsed && Array.isArray(r.parsed.diaries)) ? r.parsed.diaries : []
      return { diaries: diaries, count: diaries.length }
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
      const r = await runPrompt(prompt, 300)
      if (r.error) return { error: r.error }
      let tags = (r.parsed && Array.isArray(r.parsed.tags)) ? r.parsed.tags : []
      // 清洗：去空白、去重、过滤超长项，最多5个
      const seen = new Set()
      tags = tags
        .map(t => String(t || '').trim().slice(0, 6))
        .filter(t => t && !seen.has(t) && seen.add(t))
        .slice(0, 5)
      return { tags: tags }
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
      const r = await runPrompt(prompt, 2000)
      if (r.error) return { error: r.error }
      const archives = (r.parsed && Array.isArray(r.parsed.archives)) ? r.parsed.archives : []
      // 清洗
      const cleaned = archives
        .map(a => ({
          name: String(a.name || '').trim().slice(0, 50),
          description: String(a.description || '').trim().slice(0, 500)
        }))
        .filter(a => a.name)
      return { archives: cleaned, count: cleaned.length }
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
      const r = await runPrompt(prompt, 1000)
      if (r.error) return { error: r.error }
      let entities = (r.parsed && Array.isArray(r.parsed.entities)) ? r.parsed.entities : []
      // 清洗（explanation 为原文解释片段，供前端从正文中删除解释部分）
      const seen = new Set()
      // 叙述词/连接词/动词：name 里不能出现这些，否则就不是名词
      const INVALID_NAME_WORDS = ['是', '去', '上', '让', '带', '做', '吃', '待', '等', '为了', '然后', '又', '还', '也', '就', '和', '跟', '与', '同', '在', '到', '从', '把', '被', '给', '叫', '说', '看', '来', '走', '想', '要', '会', '能', '可以']
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
          // 硬规则：name 必须是 2-4 字的名词；description 必须有实际解释意义
          if (name.length < 2 || name.length > 4) return false
          if (desc.length < 4 || desc.length > 30) return false
          // name 里不能出现叙述词或连接词
          if (INVALID_NAME_WORDS.some(w => name.indexOf(w) !== -1)) return false
          // name 不能是指示/人称代词开头
          if (/^[这那他她它们我你您我们你们他们她们]./.test(name)) return false
          // name 不能是纯数字、纯英文（允许中英混合）
          if (/^[0-9]+$/.test(name) || /^[a-zA-Z]+$/.test(name)) return false
          // 同一名词去重
          if (seen.has(name)) return false
          seen.add(name)
          return true
        })
      return { entities: entities }
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
      const r = await runPrompt(prompt, 2500)
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
    const r = await runPrompt(prompt, 2500)
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
