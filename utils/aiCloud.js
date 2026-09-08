/**
 * 兜底：剥离 AI 输出文本末尾的「心情标注行」（今天的心情：开心 等）。
 * 只处理连续出现在文本末尾的整行；正文中间的行不受影响。
 * 防止模型把 prompt 里的心情背景写进输出，或用户未重新部署旧版云函数时残留。
 * @param {string} text
 * @returns {string}
 */
function stripMoodTail(text) {
  const lines = String(text || '').split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim()
    // 形如「今天的心情：开心」「当天心情：平淡」「心情：温暖」的整行，且不以句读结尾（避免误伤正文句）
    if (/^(?:(?:今天|今日|当天|当日|昨日|昨天)?(?:的)?心情)[：:][^，。！？；、\n]{0,30}$/.test(last)) {
      lines.pop()
    } else {
      break
    }
  }
  return lines.join('\n').replace(/\n{2,}$/, '').trim()
}

/**
 * AI 调用封装：优先调云函数（DeepSeek 真大模型），失败自动降级本地规则引擎
 */
const localAI = require('./ai.js')
const util = require('./util.js')

/**
 * 调用 AI
 * @param {string} content 日记内容
 * @param {string} mood 心情 key（可空）
 * @param {string} action 'optimize'（润色）| 'continue'（续写补全）
 * @param {Array<{name,description}>} archives 档案列表（可空，用于 AI 纠错人名地名）
 * @param {string} instruction 用户自定义纠错指令（可空，语音或文字输入）
 * @returns {Promise<{optimized:string, changes:string[], from:'cloud'|'local', error?:string, unsupported?:boolean}>}
 */
function callAI(content, mood, action, archives, instruction) {
  return new Promise((resolve) => {
    const doCall = () => {
      if (!wx.cloud) {
        console.warn('[aiCloud] 当前环境无 wx.cloud，已降级本地规则')
        resolve(localFallback(content, mood, action, '当前环境未启用云开发'))
        return
      }
      wx.cloud.callFunction({
        name: 'optimizeDiary',
        data: { content: content, mood: mood || '', action: action || 'optimize', archives: archives || [], instruction: instruction || '' }
      }).then(res => {
        const r = res && res.result
        if (r && !r.error && r.optimized) {
          console.log('[aiCloud] 云函数调用成功 from=cloud')
          resolve({
            optimized: stripMoodTail(r.optimized),
            changes: r.changes || [],
            from: 'cloud'
          })
        } else {
          console.warn('[aiCloud] 云函数返回异常，降级本地:', (r && r.error) || '无optimized字段')
          resolve(localFallback(content, mood, action, (r && r.error) || '云函数返回异常'))
        }
      }).catch(err => {
        console.warn('[aiCloud] 调用云函数失败，降级本地:', err && err.errMsg)
        resolve(localFallback(content, mood, action, (err && err.errMsg) || '调用云函数失败'))
      })
    }
    // 云函数冷启动时可能较慢，给予最长等待
    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 响应超时(30s)，降级本地')
      resolve(localFallback(content, mood, action, 'AI 响应超时'))
    }, 30000)
    Promise.resolve(doCall()).then(() => clearTimeout(timer))
  })
}

/**
 * 本地规则降级：润色可用本地引擎；续写本地不支持
 */
function localFallback(content, mood, action, reason) {
  if (action === 'continue') {
    return {
      optimized: '',
      changes: [],
      from: 'local',
      error: reason || '续写需要连接 AI 服务',
      unsupported: true
    }
  }
  const result = localAI.optimize(content, mood)
  if (!result || result.tooShort) {
    return { optimized: '', changes: [], from: 'local', error: '内容太短' }
  }
  return { optimized: stripMoodTail(result.optimized), changes: result.changes || [], from: 'local' }
}

/**
 * AI 智能识别：把任意文本识别为结构化日记列表（供导入 txt 使用）
 * @param {string} text 待识别文本（超长会自动截断）
 * @returns {Promise<{diaries?: Array<{date:string,mood:string,content:string}>, error?: string}>}
 */
function callAIParse(text) {
  return new Promise((resolve) => {
    if (!wx.cloud) {
      resolve({ error: '当前环境未启用云开发，无法使用 AI 识别' })
      return
    }
    const today = util.getDateKey(new Date())
    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: {
        action: 'parse',
        text: String(text || '').slice(0, 10000),
        today: today
      }
    }).then(res => {
      const r = res && res.result
      if (r && !r.error && Array.isArray(r.diaries)) {
        console.log('[aiCloud] AI 识别成功，识别到', r.diaries.length, '篇')
        resolve({ diaries: r.diaries, from: 'cloud' })
      } else {
        resolve({ error: (r && r.error) || 'AI 识别失败' })
      }
    }).catch(err => {
      console.warn('[aiCloud] AI 识别调用失败:', err && err.errMsg)
      resolve({ error: (err && err.errMsg) || '调用云函数失败' })
    })
    // 云函数冷启动可能较慢，超时兜底
    setTimeout(() => {
      resolve({ error: 'AI 响应超时，请稍后重试' })
    }, 30000)
  })
}

/**
 * AI 结构化提取（批量）：对已切分好的多篇日记，逐篇提取 日期/心情/天气/标签
 * 本地已经把块切好（date+content 已定），这里只让 AI 做单一任务——填字段，不切分、不重写正文。
 * 失败自动降级：本地标签引擎补 tags，心情/天气留空（不影响导入）。
 * @param {Array<{index:number, date:string, content:string}>} items
 * @returns {Promise<Array<{index:number, date:string, mood:string, weather:string, tags:string[], from:string}>>}
 */
function callAIExtractMetaBatch(items) {
  const tagsEngine = require('./tags.js')
  return new Promise((resolve) => {
    // 本地降级：每篇只补标签（tags 引擎可靠）；心情/天气不做粗提（易误判），留空
    const localResults = () => (items || []).map(it => ({
      index: it.index,
      date: it.date || '',
      mood: '',
      weather: '',
      tags: tagsEngine.extractTags(it.content, 5),
      from: 'local'
    }))

    if (!wx.cloud) {
      console.warn('[aiCloud] 当前环境无 wx.cloud，元数据本地降级')
      resolve(localResults())
      return
    }

    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }

    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: {
        action: 'extractMetaBatch',
        items: (items || []).map(it => ({
          index: it.index,
          date: it.date || '',
          content: String(it.content || '').slice(0, 2000)
        }))
      }
    }).then(res => {
      const r = res && res.result
      if (r && !r.error && Array.isArray(r.results)) {
        const map = {}
        r.results.forEach(x => { map[x.index] = x })
        // 按 index 对齐，AI 漏返回的篇降级本地 tags
        const out = (items || []).map(it => {
          const x = map[it.index]
          if (x) {
            return {
              index: it.index,
              date: x.date || it.date || '',
              mood: x.mood || '',
              weather: x.weather || '',
              tags: Array.isArray(x.tags) ? x.tags : [],
              from: 'cloud'
            }
          }
          return {
            index: it.index,
            date: it.date || '',
            mood: '',
            weather: '',
            tags: tagsEngine.extractTags(it.content, 5),
            from: 'local'
          }
        })
        console.log('[aiCloud] 批量提取元数据成功 from=cloud')
        finish(out)
      } else {
        console.warn('[aiCloud] 批量提取元数据异常，本地降级:', (r && r.error) || '无results字段')
        finish(localResults())
      }
    }).catch(err => {
      console.warn('[aiCloud] 批量提取元数据调用失败，本地降级:', err && err.errMsg)
      finish(localResults())
    })

    // 云函数冷启动可能较慢，超时兜底
    const timer = setTimeout(() => {
      console.warn('[aiCloud] 批量提取元数据超时(20s)，本地降级')
      finish(localResults())
    }, 20000)
  })
}

/**
 * AI 自动打标签：云函数 DeepSeek 生成，失败自动降级本地关键词引擎
 * @param {string} content 日记内容
 * @param {string} mood 心情 key（可空）
 * @returns {Promise<{tags: string[], from: 'cloud'|'local'}>}
 */
function callAITags(content, mood) {
  const tagsEngine = require('./tags.js')
  return new Promise((resolve) => {
    if (!wx.cloud) {
      console.warn('[aiCloud] 当前环境无 wx.cloud，标签用本地引擎生成')
      resolve({ tags: tagsEngine.extractTags(content, 5), from: 'local' })
      return
    }
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: { content: content, mood: mood || '', action: 'tags' }
    }).then(res => {
      const r = res && res.result
      if (r && !r.error && Array.isArray(r.tags) && r.tags.length > 0) {
        console.log('[aiCloud] AI 打标签成功 from=cloud:', r.tags)
        finish({ tags: r.tags.slice(0, 5), from: 'cloud' })
      } else {
        console.warn('[aiCloud] AI 打标签返回异常，降级本地:', (r && r.error) || '无tags字段')
        finish({ tags: tagsEngine.extractTags(content, 5), from: 'local' })
      }
    }).catch(err => {
      console.warn('[aiCloud] AI 打标签调用失败，降级本地:', err && err.errMsg)
      finish({ tags: tagsEngine.extractTags(content, 5), from: 'local' })
    })
    // 云函数冷启动可能较慢，超时兜底（保存流程不能卡太久）
    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 打标签超时(15s)，降级本地')
      finish({ tags: tagsEngine.extractTags(content, 5), from: 'local' })
    }, 15000)
  })
}

/**
 * AI 整理档案：把用户按行输入的文本整理成 {name, description} 数组
 * 失败降级本地按行解析（以：或：分隔）
 * @param {string} text 用户输入的原始文本
 * @param {string} instruction 用户自定义纠错指令（可空，语音或文字输入）
 * @returns {Promise<{archives: Array<{name, description}>, from: 'cloud'|'local', error?: string}>}
 */
function callAIOrganizeArchive(text, instruction) {
  return new Promise((resolve) => {
    // 本地降级：按行拆分，以：或：分隔 name 和 description
    const localParse = () => {
      const lines = String(text || '').split(/[\n\r]+/)
      const archives = []
      lines.forEach(line => {
        const trimmed = line.trim()
        if (!trimmed) return
        const m = trimmed.match(/^([^：:]+)[：:]\s*(.*)$/)
        if (m) {
          archives.push({ name: m[1].trim(), description: m[2].trim() })
        } else {
          // 没有分隔符的整行作为 name，description 留空
          archives.push({ name: trimmed, description: '' })
        }
      })
      return { archives, from: 'local' }
    }

    if (!wx.cloud) {
      resolve(localParse())
      return
    }

    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }

    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: { action: 'organizeArchive', text: String(text || '').slice(0, 5000), instruction: instruction || '' }
    }).then(res => {
      const r = res && res.result
      if (r && !r.error && Array.isArray(r.archives) && r.archives.length > 0) {
        console.log('[aiCloud] AI 整理档案成功 from=cloud:', r.archives.length, '条')
        finish({ archives: r.archives, from: 'cloud' })
      } else {
        console.warn('[aiCloud] AI 整理档案异常，降级本地:', (r && r.error) || '无archives字段')
        finish(localParse())
      }
    }).catch(err => {
      console.warn('[aiCloud] AI 整理档案调用失败，降级本地:', err && err.errMsg)
      finish(localParse())
    })

    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 整理档案超时(20s)，降级本地')
      finish(localParse())
    }, 20000)
  })
}

/**
 * 本地规则降级：从日记中提取"用户解释过的名词"（名词，解释）
 * 匹配模式：
 *   「王磊是我大学同学」「海洋大学，这是我的母校」「腾讯，我工作的公司」等
 * 云函数不可用时兜底，保证备案提示仍可用
 * 实体带 explanation（解释在原文中的逐字片段），供正文清理使用
 */
// 名词清洗：剥离捕获进来的叙述前缀（如「我今天和王磊」→「王磊」）
function cleanEntityName(raw) {
  let name = String(raw || '').trim()
  // 按标点/连接词/时间词切分，取最后一段（最贴近引导词的部分）
  const parts = name.split(/[，,。；;、！？\s]|和|与|跟|以及|还有|然后|今天|昨天|前天|上午|下午|晚上|早上|中午|刚|顺便|一起/).filter(Boolean)
  if (parts.length > 0 && parts[parts.length - 1].length >= 2) name = parts[parts.length - 1]
  // 剥离开头残存的「我(们)(时间词)(在/跟/和/去/到/约/陪)了」等叙述前缀
  name = name.replace(/^我们?/, '')
  name = name.replace(/^(?:今天|昨天|前天|上午|下午|晚上|早上|中午)?(?:在|跟|和|与|去|到|约|陪|遇见|遇到|见了|碰到)(?:了)?/, '')
  return name.trim()
}

function localExtractExplainedEntities(content) {
  const text = String(content || '')
  const STOP = ['我', '我们', '你', '你们', '他', '她', '它', '他们', '今天', '昨天', '明天', '前天',
    '最近', '现在', '这', '那', '这个', '那个', '感觉', '心情', '日记', '生活', '工作', '时间',
    '事情', '地方', '东西', '大家', '自己', '晚上', '上午', '下午', '中午', '早上']
  const results = []
  const seen = new Set()
  // 叙述词/连接词/动词：name 里不能出现这些，否则就不是名词
  const INVALID_NAME_WORDS = ['是', '去', '上', '让', '带', '做', '吃', '待', '等', '为了', '然后', '又', '还', '也', '就', '和', '跟', '与', '同', '在', '到', '从', '把', '被', '给', '叫', '说', '看', '来', '走', '想', '要', '会', '能', '可以']

  const push = (name, desc, expl) => {
    name = cleanEntityName(name)
    desc = String(desc || '').trim().replace(/[。！!？?，、；;]+$/, '')
    // 解释过长时按连接成分截断（如「我大学同学一起吃的饭」→「我大学同学」）
    const cut = (s) => {
      const head = s.split(/一起|然后|之后|并且|就|还|又|，|。|；|！|？/)[0]
      return head && head.length >= 2 ? head : s
    }
    desc = cut(desc)
    if (!name || !desc) return
    // 硬规则：name 必须是 2-4 字的名词；description 必须有实际解释意义
    if (name.length < 2 || name.length > 4 || desc.length < 4 || desc.length > 30) return
    if (STOP.indexOf(name) !== -1) return
    // 名词不能以指示/人称代词开头（如「这是我的母校」误匹配为名词）
    if (/^[这那他她它们我你您]./.test(name)) return
    // name 里不能出现叙述词/连接词/动词
    if (INVALID_NAME_WORDS.some(w => name.indexOf(w) !== -1)) return
    // 与已提取结果重叠（同一名词的重复匹配/脏匹配）→ 跳过
    if (results.some(r => name.indexOf(r.name) !== -1 || name.indexOf(r.description) !== -1)) return
    // 解释规范化：「我大学同学」→「我的大学同学」（句中已有"的"则保持原样）
    if (/^我(?!的)/.test(desc) && desc.indexOf('的', 1) === -1) desc = '我的' + desc.slice(1)
    if (seen.has(name)) return
    seen.add(name)
    // explanation：解释在原文中的逐字片段（供正文清理用，同样按连接词截断防止吞掉后文叙述）
    const explanation = cut(String(expl || '').trim().replace(/^[，,：:\s]+/, ''))
    results.push({ name: name, description: desc, explanation: explanation, type: 'other' })
  }

  // 模式1：X（，/：）(这是|他是|她是|它是|就是|也是|正是|是|叫|名叫|叫做)解释
  const re1 = /([\u4e00-\u9fa5A-Za-z0-9·]{2,4})(?:[，,：:]\s*)?(?:这是|他是|她是|它是|就是|也是|正是|是|叫|名叫|叫做)([\u4e00-\u9fa5A-Za-z0-9·]{2,20}(?:的[\u4e00-\u9fa5A-Za-z0-9·]{1,10})?)/g
  let m
  while ((m = re1.exec(text)) !== null) {
    // explanation：解释在原文中的逐字片段（名词之后的部分，去掉前导标点）
    const expl = m[0].slice(m[1].length).replace(/^[，,：:\s]+/, '')
    push(m[1], m[2], expl)
    if (results.length >= 8) return results
  }

  // 模式1b：X，这个/那家xx是解释（如「腾讯公司，这个公司是我们公司的客户」）
  const re1b = /([\u4e00-\u9fa5A-Za-z0-9·]{2,12})[，,]\s*(?:这|那)(?:个|家|位|所|名|款)?[\u4e00-\u9fa5]{1,4}?(?:就)?是([\u4e00-\u9fa5A-Za-z0-9·]{2,20}(?:的[\u4e00-\u9fa5A-Za-z0-9·]{1,10})?)/g
  while ((m = re1b.exec(text)) !== null) {
    // explanation 从「这/那」开始到解释结尾（含指代与名词，可整体删除）
    const expl = m[0].slice(m[1].length).replace(/^[，,：:\s]+/, '')
    push(m[1], m[2], expl)
    if (results.length >= 8) return results
  }

  // 模式2：X，我的xx（逗号后直接以"我的"开头，无"是"引导）
  const re2 = /([\u4e00-\u9fa5A-Za-z0-9·]{2,4})[，,]\s*(我[的]?[\u4e00-\u9fa5A-Za-z0-9·]{2,18})/g
  while ((m = re2.exec(text)) !== null) {
    push(m[1], m[2], m[2])
    if (results.length >= 8) return results
  }

  return results
}

/**
 * 校验实体是否真的在日记原文中"解释过"：
 * 仅当 explanation（解释的逐字片段）确实存在于原文时才认定为解释过的名词，
 * 防止 AI 对只是被提到的名词（如"今天和张三吃饭"）也编造 description 触发备案提醒。
 * 只提到名词、没有解释 → 不提醒备案（用户明确要求：仅当保存后日记中有解释才备案）。
 * @param {string} content 日记原文
 * @param {{name?:string, explanation?:string}} e 实体
 * @returns {boolean}
 */
function hasRealExplanation(content, e) {
  const name = String((e && e.name) || '').trim()
  const expl = String((e && e.explanation) || '').trim()
  if (!name || !expl) return false
  // 1. explanation 是原文逐字片段 → 直接通过
  if (content.indexOf(expl) !== -1) return true
  // 2. explanation 用「他/她/这/那/其/我」等指代名词，去掉指代与引导词后仍是原文片段 → 通过
  //    例：原文「张三是我大学同学」，AI 概括 explanation=他是我大学同学
  const naked = expl.replace(/^(这|那|他|她|它|其|人家|我们|咱|我)?(就)?(?:是|为|叫)/, '').trim()
  return naked.length >= 2 && content.indexOf(naked) !== -1
}

/**
 * AI 提取实体：从日记中识别"用户解释过的名词"及其解释，用于提示用户备案到档案
 * 云函数返回 name+description；失败降级本地规则引擎（不返回无解释的实体）
 * 无论云端还是本地，最终都经过 hasRealExplanation 校验：只有原文里确实解释了的名词才会被提醒备案
 * @param {string} content 日记内容
 * @returns {Promise<{entities: Array<{name, description, type}>, from: 'cloud'|'local'}>}
 */
function callAIExtractEntities(content) {
  return new Promise((resolve) => {
    const text = String(content || '')
    if (!wx.cloud) {
      resolve({ entities: localExtractExplainedEntities(text), from: 'local' })
      return
    }
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: { content: text.slice(0, 5000), action: 'extractEntities' }
    }).then(res => {
      const r = res && res.result
      if (r && !r.error && Array.isArray(r.entities)) {
        // 云端旧版未返回 description（云函数未重新部署）→ 本地规则兜底补解释
        const hasDesc = r.entities.some(e => e && e.description)
        if (hasDesc) {
          // 硬校验：只保留"解释真实存在于原文"且 name 是 2-4 字名词、解释内容 4-30 字的实体（AI 编造/过短/过长/非名词全部过滤）
          const INVALID_NAME_WORDS = ['是', '去', '上', '让', '带', '做', '吃', '待', '等', '为了', '然后', '又', '还', '也', '就', '和', '跟', '与', '同', '在', '到', '从', '把', '被', '给', '叫', '说', '看', '来', '走', '想', '要', '会', '能', '可以']
          const valid = r.entities.filter(e => {
            if (!e || !e.name || !e.description) return false
            const name = String(e.name).trim()
            const desc = String(e.description).trim()
            // name 必须是 2-4 字名词；description 必须有实际解释意义
            if (name.length < 2 || name.length > 4) return false
            if (desc.length < 4 || desc.length > 30) return false
            // name 里不能出现叙述词/连接词/动词
            if (INVALID_NAME_WORDS.some(w => name.indexOf(w) !== -1)) return false
            // name 不能是指示/人称代词开头
            if (/^[这那他她它们我你您我们你们他们她们]./.test(name)) return false
            // 解释必须真实存在于原文
            return hasRealExplanation(text, e)
          })
          if (valid.length > 0) {
            console.log('[aiCloud] AI 提取名词解释成功 from=cloud:', r.entities.length, '个，解释校验通过:', valid.length, '个')
            finish({ entities: valid, from: 'cloud' })
          } else {
            console.warn('[aiCloud] 云端实体均无原文解释（AI 误报），降级本地规则')
            finish({ entities: localExtractExplainedEntities(text), from: 'local' })
          }
        } else {
          console.warn('[aiCloud] 云函数为旧版（无 description），降级本地规则')
          finish({ entities: localExtractExplainedEntities(text), from: 'local' })
        }
      } else {
        console.warn('[aiCloud] AI 提取实体异常:', (r && r.error) || '无entities字段')
        finish({ entities: localExtractExplainedEntities(text), from: 'local' })
      }
    }).catch(err => {
      console.warn('[aiCloud] AI 提取实体调用失败:', err && err.errMsg)
      finish({ entities: localExtractExplainedEntities(text), from: 'local' })
    })
    // 保存流程不能卡太久
    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 提取实体超时(15s)')
      finish({ entities: localExtractExplainedEntities(text), from: 'local' })
    }, 15000)
  })
}

/**
 * AI 融合日记：把同一天的旧日记和新内容融合成一篇完整日记
 * 失败降级本地直接拼接（保证内容不丢失）
 * @param {string} oldContent 已存在的同日日记内容
 * @param {string} newContent 新写的内容
 * @param {object} opts - { oldMood, newMood, archives, instruction }
 * @returns {Promise<{merged: string, from: 'cloud'|'local'}>}
 */
function callAIMergeDiary(oldContent, newContent, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    // 本地降级：直接拼接两份内容，保证不丢任何文字
    const localMerge = () => {
      const merged = String(oldContent || '').trim() + '\n\n' + String(newContent || '').trim()
      return { merged: merged, from: 'local' }
    }

    if (!wx.cloud) {
      resolve(localMerge())
      return
    }

    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }

    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: {
        action: 'merge',
        oldContent: String(oldContent || '').slice(0, 6000),
        newContent: String(newContent || '').slice(0, 6000),
        oldMood: opts.oldMood || '',
        newMood: opts.newMood || '',
        archives: opts.archives || [],
        instruction: opts.instruction || ''
      }
    }).then(res => {
      const r = res && res.result
      if (r && !r.error && r.merged) {
        console.log('[aiCloud] AI 融合日记成功 from=cloud')
        finish({ merged: stripMoodTail(r.merged), from: 'cloud' })
      } else {
        console.warn('[aiCloud] AI 融合日记异常，降级本地拼接:', (r && r.error) || '无merged字段')
        finish(localMerge())
      }
    }).catch(err => {
      console.warn('[aiCloud] AI 融合日记调用失败，降级本地拼接:', err && err.errMsg)
      finish(localMerge())
    })

    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 融合日记超时(20s)，降级本地拼接')
      finish(localMerge())
    }, 20000)
  })
}

module.exports = { callAI, callAIParse, callAIExtractMetaBatch, callAITags, callAIOrganizeArchive, callAIExtractEntities, callAIMergeDiary, stripMoodTail }
