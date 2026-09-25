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
const storage = require('./storage.js')
const entityClean = require('./entityClean.js')
const archiveEdit = require('./archiveEdit.js')
const tagsEngine = require('./tags.js')

/**
 * 本地标签（tagjunk v1）：主题词典 + 档案专名补位
 * 档案里备案过的人名/机构名（四维图新 / 北汽新能源 / 魏杰）才是标签该有的样子，
 * 比旧版「双字词频兜底」可靠得多 —— 见 utils/tags.js 顶部说明。
 * @param {string} content 日记正文
 * @returns {string[]} 最多 5 个标签
 */
function localTags(content) {
  let extra = []
  try {
    const list = storage.getArchives() || []
    extra = list.map(a => String((a && a.name) || '').trim()).filter(Boolean)
  } catch (e) {
    extra = []
  }
  return tagsEngine.extractTags(content, 5, extra)
}

/**
 * 调用 AI
 * @param {string} content 日记内容
 * @param {string} mood 心情 key（可空）
 * @param {string} action 'optimize'（润色）| 'continue'（续写补全）
 * @param {Array<{name,description}>} archives 档案列表（可空，用于 AI 纠错人名地名）
 * @param {string} instruction 用户自定义纠错指令（可空，语音或文字输入）
 * @param {Object} payload 素材补全（action='recite'）的结构化请求：{kind,mode,target,existing}
 * @returns {Promise<Object>} 润色/续写：{optimized,changes,from,...}；
 *                            素材补全：{recited,source,note,kind,candidates,from,...}
 */
function callAI(content, mood, action, archives, instruction, payload) {
  return new Promise((resolve) => {
    const doCall = () => {
      if (!wx.cloud) {
        console.warn('[aiCloud] 当前环境无 wx.cloud，已降级本地规则')
        resolve(localFallback(content, mood, action, '当前环境未启用云开发', true))
        return
      }
      wx.cloud.callFunction({
        name: 'optimizeDiary',
        data: {
          content: content,
          mood: mood || '',
          action: action || 'optimize',
          archives: archives || [],
          instruction: instruction || '',
          payload: payload || null
        }
      }).then(res => {
        const r = res && res.result
        // 素材补全（recite）返回的是「补全片段」而不是整篇优化稿，
        // 拼装优化稿由客户端做（strip 与拼装在客户端，才能单测）
        if (action === 'recite') {
          if (r && !r.error && r.recited) {
            console.log('[aiCloud] 素材补全 from=cloud')
            resolve({
              recited: String(r.recited),
              source: r.source || '',
              note: r.note || '',
              kind: r.kind || '',
              candidates: r.candidates || [],
              from: 'cloud'
            })
          } else {
            console.warn('[aiCloud] 素材补全云端返回异常:', (r && r.error) || '无 recited 字段')
            // 云端**在线**但没给内容（查不到出处 / 接口报错）→ offline=false，如实透传原因
            resolve(localFallback(content, mood, action, (r && r.error) || '未能确认出处', false))
          }
          return
        }
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
        resolve(localFallback(content, mood, action, (err && err.errMsg) || '调用云函数失败', true))
      })
    }
    // 云函数冷启动时可能较慢，给予最长等待
    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 响应超时(30s)，降级本地')
      resolve(localFallback(content, mood, action, 'AI 响应超时', true))
    }, 30000)
    Promise.resolve(doCall()).then(() => clearTimeout(timer))
  })
}

/**
 * 本地规则降级：润色可用本地引擎；续写 / 素材补全本地不支持
 * @param {boolean} offline 是否属于「连不上 AI 服务」（无云环境 / 调用失败 / 超时）；
 *                          云端**在线但明确查不到出处**时为 false —— 两者提示语不同，
 *                          混为一谈会把「云端说查不到」误报成连接故障（用户侧表现为假故障）
 */
function localFallback(content, mood, action, reason, offline) {
  if (action === 'continue') {
    return {
      optimized: '',
      changes: [],
      from: 'local',
      error: reason || '续写需要连接 AI 服务',
      unsupported: true
    }
  }
  // 素材补全：本地**绝不瞎拼**（池内条目已由 utils/quoteAsk.js 直出，
  // 走到这里一定是池外素材 —— 本地规则拼不出可信的诗文与出处）
  if (action === 'recite') {
    return {
      recited: '',
      source: '',
      note: '',
      kind: '',
      from: 'local',
      offline: !!offline,
      error: reason || '补全诗文需要连接 AI 服务'
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
  return new Promise((resolve) => {
    // 本地降级：每篇只补标签（tags 引擎可靠）；心情/天气不做粗提（易误判），留空
    const localResults = () => (items || []).map(it => ({
      index: it.index,
      date: it.date || '',
      mood: '',
      weather: '',
      tags: localTags(it.content),
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
            // 云端标签同样过质量闸：虚词/碎片词一律丢弃，全丢弃时降级本地专名标签
            const cloudTags = (Array.isArray(x.tags) ? x.tags : [])
              .filter(t => tagsEngine.isMeaningfulTag(t))
              .slice(0, 5)
            if (cloudTags.length > 0) {
              return {
                index: it.index,
                date: x.date || it.date || '',
                mood: x.mood || '',
                weather: x.weather || '',
                tags: cloudTags,
                from: 'cloud'
              }
            }
          }
          return {
            index: it.index,
            date: it.date || '',
            mood: '',
            weather: '',
            tags: localTags(it.content),
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
  return new Promise((resolve) => {
    if (!wx.cloud) {
      console.warn('[aiCloud] 当前环境无 wx.cloud，标签用本地引擎生成')
      resolve({ tags: localTags(content), from: 'local' })
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
      // 云端标签过质量闸（tagjunk v1）：虚词/碎片词丢弃，全被丢弃时降级本地专名标签
      const cloudTags = (r && !r.error && Array.isArray(r.tags) ? r.tags : [])
        .filter(t => tagsEngine.isMeaningfulTag(t))
        .slice(0, 5)
      if (cloudTags.length > 0) {
        console.log('[aiCloud] AI 打标签成功 from=cloud:', cloudTags)
        finish({ tags: cloudTags, from: 'cloud' })
      } else {
        console.warn('[aiCloud] AI 打标签返回异常或全被质量闸拦下，降级本地:', (r && r.error) || '无有效tags字段')
        finish({ tags: localTags(content), from: 'local' })
      }
    }).catch(err => {
      console.warn('[aiCloud] AI 打标签调用失败，降级本地:', err && err.errMsg)
      finish({ tags: localTags(content), from: 'local' })
    })
    // 云函数冷启动可能较慢，超时兜底（保存流程不能卡太久）
    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 打标签超时(15s)，降级本地')
      finish({ tags: localTags(content), from: 'local' })
    }, 15000)
  })
}

/**
 * AI 整理档案：把用户按行输入的文本整理成 {name, description} 数组
 * 失败降级本地按行解析（以：或：分隔）
 * @param {string} text 用户输入的原始文本
 * @param {string} instruction 用户自定义纠错指令（可空，语音或文字输入）
 * @returns {Promise<{archives: Array<{name, description}>, skipped?: number, from: 'cloud'|'local', error?: string}>}
 *   skipped：名称不合格（整句话 / 超 9 字 / 含句读标点）被丢弃的条数
 */
function callAIOrganizeArchive(text, instruction) {
  return new Promise((resolve) => {
    // 本地降级：按行拆分，交给 archiveEdit.parseArchiveLine 统一解析
    // （名称必须是不超过 9 字的名词，否则丢弃该行——不再把整句话塞进 name）
    const localParse = () => {
      const lines = String(text || '').split(/[\n\r]+/)
      const archives = []
      let skipped = 0
      lines.forEach(line => {
        const item = archiveEdit.parseArchiveLine(line)
        if (item) {
          archives.push(item)
        } else if (String(line || '').trim()) {
          skipped++
        }
      })
      return { archives, skipped, from: 'local' }
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
      // 云端显式返回空数组也算成功（云函数已判定没有合格名词）
      // → 不再降级本地重造脏名称，由页面提示「没识别到名词」
      if (r && !r.error && Array.isArray(r.archives)) {
        console.log('[aiCloud] AI 整理档案成功 from=cloud:', r.archives.length, '条')
        finish({ archives: r.archives, skipped: Number(r.dropped) || 0, from: 'cloud' })
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
// ===== 名词黑名单（云端路径与本地路径共用同一份，勿分叉）=====
// ⚠️ 不要退回「含字即拦」：单字做子串匹配会误杀合法专名 —— 北汽新能源(能)、蔚来汽车(来)、
//    上汽集团(上)、能链智电(能) 全被丢弃，用户侧表现为「保存后不弹备案提醒」。
// 规则：单字 → 只在「名词首字」命中时否决（这类字开头的 2~6 字串基本都是句式片段：去公司/是我的…）
//       多字 → 出现在名词任意位置即否决（为了/然后/上一…基本都是误捕片段）
const NAME_BLOCK_HEAD_CHARS = ['是', '的', '了', '着', '和', '跟', '与', '同', '在', '到', '从', '把', '被',
  '给', '叫', '说', '想', '要', '又', '还', '也', '就', '都', '让', '做', '吃', '待', '等', '去', '走', '看', '带']
const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么', '以为', '知道', '终于', '擦肩']
// [person-hotword A'] 人名场景**特有**的高频误报：常见姓氏 + 常用字撞出来的普通词。
// 只用于人名清洗，**不动 entityClean 的既有词表**（备案链路零影响）。
// 与 entityClean.NON_NOUN_WORDS 允许重叠（冗余无害）：那张表是按"名词/虚词"分类的，
// 这张表是按"会不会被 AI 当人名"筛的，分类口径不同。
const PERSON_FALSE_POSITIVES = [
  '周末', '何必', '高兴', '王者', '张开', '白天', '金额', '来往',
  '和平', '和气', '安全', '安排', '马上', '金子', '李子', '果实'
]

/**
 * 名词是否命中黑名单（云端/本地共用）
 * @param {string} name 待校验名称
 * @returns {boolean} true 表示应丢弃该名称
 */
function hasBlockedNameWord(name) {
  const n = String(name || '').trim()
  if (!n) return true
  if (NAME_BLOCK_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
  return NAME_BLOCK_WORDS.some(w => n.indexOf(w) !== -1)
}

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
    // 硬规则：name 必须是 2-6 字的名词；description 必须有实际解释意义
    if (name.length < 2 || name.length > 6 || desc.length < 4 || desc.length > 30) return
    if (STOP.indexOf(name) !== -1) return
    // 名词不能以指示/人称代词开头（如「这是我的母校」误匹配为名词）
    if (/^[这那他她它们我你您]./.test(name)) return
    // name 命中黑名单（首字为叙述词 / 含连接词，如「去公司」「上一家…」）→ 不是名词
    if (hasBlockedNameWord(name)) return
    // 与页面侧同一道机械校验：排除虚词（分别/一共…）与带助词的短语（的第一天…），并要求原文确有定义句式
    if (!entityClean.isExplainedNoun(name, text)) return
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
  const re1 = /([\u4e00-\u9fa5A-Za-z0-9·]{2,6})(?:[，,：:]\s*)?(?:这是|他是|她是|它是|就是|也是|正是|是|叫|名叫|叫做)([\u4e00-\u9fa5A-Za-z0-9·]{2,20}(?:的[\u4e00-\u9fa5A-Za-z0-9·]{1,10})?)/g
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
  const re2 = /([\u4e00-\u9fa5A-Za-z0-9·]{2,6})[，,]\s*(我[的]?[\u4e00-\u9fa5A-Za-z0-9·]{2,18})/g
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
 * [person-hotword A'] 人名清洗（客户端 · 语义级）：
 * 云函数只保证「格式合格 + 在原文出现」，这里再过一遍本地的虚词/代词/时间词/数量词表。
 * 误报的代价不是"多显示一个词"，而是 ASR 会把正常表达替换成热词里的名字 ⇒ 刻意保守，宁可漏。
 * @param {string[]} raw 云函数返回的 persons
 * @param {string} content 日记原文
 * @returns {string[]} 清洗后的人名（保序、去重、上限 20）
 */
function cleanPersonNames(raw, content) {
  const list = Array.isArray(raw) ? raw : []
  const text = String(content || '')
  const out = []
  const seen = new Set()
  for (let i = 0; i < list.length; i++) {
    const n = String(list[i] == null ? '' : list[i]).trim()
    if (!n || n.length < 2) continue
    if (!/^[\u4e00-\u9fa5·]+$/.test(n)) continue
    if (PERSON_FALSE_POSITIVES.indexOf(n) !== -1) continue  // 姓氏 + 常用字撞出来的普通词
    const isTrans = n.indexOf('·') !== -1
    if (!isTrans && n.length > 4) continue
    if (n.length > 12) continue
    if (seen.has(n)) continue
    if (text.indexOf(n) === -1) continue                  // 必须在原文里真的出现（防 AI 编造）
    if (hasBlockedNameWord(n)) continue                   // 首字是叙述词 / 含连接词
    if (!isTrans && entityClean.isNonNounWord(n)) continue // 虚词/代词/动词/形容词/数量词/时间词
    seen.add(n)
    out.push(n)
    if (out.length >= 20) break
  }
  return out
}

/**
 * 把清洗后的人名挂到实体抽取结果上。
 * 兼容老云函数：不返回 persons ⇒ 空数组 ⇒ 人名表不写入（功能静默不生效，既有行为零变化）。
 * @param {{entities?:Array, from?:string, persons?:Array}} result
 * @param {string} text 日记原文
 * @returns {{entities:Array, from:string, persons:string[]}}
 */
function withPersons(result, text) {
  const r = result || {}
  return {
    entities: Array.isArray(r.entities) ? r.entities : [],
    from: r.from || 'local',
    persons: cleanPersonNames(r.persons, text)
  }
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
      resolve(withPersons({ entities: localExtractExplainedEntities(text), from: 'local' }, text))
      return
    }
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // [person-hotword A2] 人名随结果一起返回（已过本地语义清洗），供保存路径沉淀人名表。
      // 注意：aiCloud.js 里有 5 处同形的 finish，这里只改 extractEntities 这一处
      resolve(withPersons(result, text))
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
          // 硬校验：只保留"解释真实存在于原文"且 name 是 2-6 字名词、解释内容 4-30 字的实体（AI 编造/过短/过长/非名词全部过滤）
          const valid = r.entities.filter(e => {
            if (!e || !e.name || !e.description) return false
            const name = String(e.name).trim()
            const desc = String(e.description).trim()
            // name 必须是 2-6 字名词；description 必须有实际解释意义
            if (name.length < 2 || name.length > 6) return false
            if (desc.length < 4 || desc.length > 30) return false
            // name 命中黑名单（与本地路径同一份规则）
            if (hasBlockedNameWord(name)) return false
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
    // 保存流程不能卡太久；7 秒先降级本地规则，确保赶在页面等待上限之前返回结果
    const timer = setTimeout(() => {
      console.warn('[aiCloud] AI 提取实体超时(7s)，降级本地规则')
      finish({ entities: localExtractExplainedEntities(text), from: 'local' })
    }, 7000)
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

/**
 * 保存后的静默自动分段（异步路线 B：保存永远秒存，分段在后台悄悄完成）
 *
 * 触发条件（三条都不满足则直接跳过，一次 AI 调用都不发）：
 *   1. 正文有效字符 >= 300（短日记不需要分段）
 *   2. 换行数 < 3（用户已自行分段的不再处理）
 *   3. 非 AI 总结类产物（总结已有 ◆ 结构，且按规则不参与 AI 处理）
 *
 * 安全保障：
 *   - 云函数 + 前端双重忠实性校验（去空白后逐字一致），AI 擅自改字则丢弃结果
 *   - 回写前比对存储中内容是否仍是发送时的原文，防止覆盖期间的用户编辑
 *   - 全程静默：任何失败（网络/超时/校验不过）都保持原文，不影响已保存的日记
 *
 * @param {string} diaryId 已保存日记的 id
 */
function autoSegmentAfterSave(diaryId) {
  let content = ''
  let isSummary = false
  try {
    const diary = storage.getDiaryById(diaryId)
    if (!diary) return
    content = String(diary.content || '')
    isSummary = util.isAiSummaryDiary(diary)
    if (content.replace(/\s+/g, '').length < 300) return       // 太短：不需要分段
    if ((content.match(/\n/g) || []).length >= 3) return       // 已有分段：不再处理
    if (isSummary) return                                      // 总结类排除
  } catch (e) {
    return
  }

  // 云环境不可用：与 aiCloud 其他函数同样的降级防护，直接跳过（保持原文）
  if (!wx.cloud) return

  try {
    wx.cloud.callFunction({
      name: 'optimizeDiary',
      data: { action: 'segment', content: content }
    }).then(res => {
    const r = res && res.result
    if (!r || r.error || !r.segmented) {
      console.warn('[aiCloud] 自动分段未成功（保持原文）:', (r && r.error) || '无segmented字段')
      return
    }
    const segmented = String(r.segmented)
    // 前端侧忠实性校验：AI 返回的去空白文本必须与原文逐字一致
    if (segmented.replace(/\s+/g, '') !== content.replace(/\s+/g, '')) {
      console.warn('[aiCloud] 自动分段忠实性校验未通过，保持原文')
      return
    }
    // 防覆盖：分段请求期间用户可能又编辑了这篇日记（存储内容已变化），放弃回写
    const current = storage.getDiaryById(diaryId)
    if (!current || String(current.content || '') !== content) {
      console.warn('[aiCloud] 日记在分段期间被修改，放弃回写')
      return
    }
    const upd = storage.updateDiary(diaryId, { content: segmented })
    if (!upd) return
    console.log('[aiCloud] 自动分段完成，已原地更新日记', diaryId)
    // 用户通常正停在这篇日记的详情页：原地刷新显示（编辑中则不打扰）
    try {
      const pages = getCurrentPages()
      const top = pages[pages.length - 1]
      if (top && top.route && top.route.indexOf('pages/detail/detail') !== -1 &&
          String(top.data.id) === String(diaryId) && !top.data.editing && top.loadDetail) {
        top.loadDetail(diaryId)
      }
    } catch (e) { /* 刷新失败不影响数据 */ }
  }).catch(err => {
    console.warn('[aiCloud] 自动分段调用失败（保持原文）:', err && err.errMsg)
  })
  } catch (e) {
    // callFunction 同步抛错也不允许外泄：本函数在保存跳转链路上，抛错会炸断导航
    console.warn('[aiCloud] 自动分段发起失败（保持原文）:', e)
  }
}

/**
 * [roster-filter v1] 花名册 AI 复核：把名单交给 AI 甄别真名（optimizeDiary action='rosterReview'）。
 * resolve(保留名单数组)；失败 resolve(null)（调用方静默降级，绝不阻塞、绝不抛错）。
 */
function callAIRosterReview(names) {
  return new Promise(function (resolve) {
    try {
      wx.cloud.callFunction({
        name: 'optimizeDiary',
        data: { action: 'rosterReview', names: names },
        success: function (res) {
          const r = (res && res.result) || {}
          if (r.error) { resolve(null); return }
          resolve(Array.isArray(r.names) ? r.names : [])
        },
        fail: function () { resolve(null) }
      })
    } catch (e) {
      resolve(null)
    }
  })
}

module.exports = { callAI, callAIParse, callAIExtractMetaBatch, callAITags, callAIOrganizeArchive, callAIExtractEntities, callAIMergeDiary, autoSegmentAfterSave, stripMoodTail, cleanPersonNames, callAIRosterReview }
