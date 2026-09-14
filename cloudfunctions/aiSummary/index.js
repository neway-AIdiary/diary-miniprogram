/**
 * 云函数：aiSummary
 * 智能总结：读取前端传来的多篇日记文本 + 用户需求，调用 DeepSeek 生成自定义总结。
 *
 * ⚠️ 数据来源（方案 A）：日记正文存在用户手机本地，由前端本地读取、按时间筛选后，
 *    作为 diaries 数组传给本函数。本函数不查询任何日记集合（云数据库里没有日记正文）。
 *
 * 入参（前端传入）：
 *   userPrompt: 用户总结需求（必填）
 *   diaries:    [{ date: 'YYYY-MM-DD', content: '正文', mood?: '开心', tags?: [] }, ...]
 *   startDate / endDate: 用户选的时间范围（仅用于记录/回显，非强制）
 *
 * 返回：
 *   { success: true, summaryText, diaryCount, quotaUsed }  成功
 *   { success: false, error }                               失败/限流
 *
 * 限流（防费用暴增）：
 *   - 单用户每日上限见 DAILY_LIMIT（10 次，按北京时间自然日），超出返回友好提示
 *   - 单次最多处理 365 篇，超出丢弃最早日记并裁剪
 *   - 拼接日记上下文控制总字符上限，超出自动丢弃最早日记
 *
 * 依赖：wx-server-sdk（限流用云数据库 summary_quota 集合）——需「云端安装依赖」部署
 * 环境变量：DEEPSEEK_API_KEY（与 optimizeDiary 共用同一个）
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const https = require('https')

const API_KEY = process.env.DEEPSEEK_API_KEY
const API_HOST = 'api.deepseek.com'
const API_PATH = '/chat/completions'
const MODEL = 'deepseek-chat'

// 限流配置
const DAILY_LIMIT = 10          // 单用户每日最多次数（按北京时间自然日）
const MAX_DIARIES = 365        // 单次最多读取 365 篇
const MAX_CONTEXT_CHARS = 50000 // 拼接日记上下文总字符上限（约可容纳一年日记；超出仍裁剪最早日记）

// 微信云函数运行在 UTC+0，统一按北京时间计算
function getBeijingDateKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = n => n < 10 ? '0' + n : '' + n
  return now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
}

/**
 * 调用 DeepSeek（Node 内置 https，无第三方依赖）
 * 总结类任务：输出 markdown 纯文本，不用 JSON 模式
 */
function callDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 2000
    })
    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000 // 总结可能耗时较长，放宽到 60s
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

// 构造系统提示词（文档十一节给的固定前缀）
function buildSystemPrompt() {
  return [
    '你是AI日记助手，基于用户提供的多篇日记内容，按照用户的要求进行总结。',
    '要求：',
    '1. 只用提供的日记内容，不要编造不存在信息；',
    '2. 语言简洁自然，贴合日记风格；',
    '3. 可以分段，需要罗列时用「- 」开头的简单列表；',
    '4. 内容有明显分节时（如按主题、按维度分类），用小标题分节：小标题单独占一行，以「## 」开头（只用两个 #，不要用 # 或 ###）；',
    '5. 不要使用其他 markdown 符号（如加粗 **）和任何 emoji / 表情符号装饰文字；',
    '6. 如果信息不足，如实告知用户。'
  ].join('\n')
}

// 把多篇日记组装成上下文（按日期升序；控制总字符上限，超出丢弃最早日记）
function buildDiaryContext(diaries) {
  const list = (diaries || []).slice()
  // 按日期升序（旧→新），保证时间线正确
  list.sort((a, b) => String(a.date || '') < String(b.date || '') ? -1 : 1)

  let blocks = []
  let total = 0
  // 从最新往前装（保最近的日记优先保留），最后再反转回升序
  const reversed = list.slice().reverse()
  for (const d of reversed) {
    const date = String(d.date || '').trim()
    const content = String(d.content || '').trim()
    if (!content) continue
    let line = (date ? '【' + date + '】' : '【未标注日期】') + '\n' + content
    const mood = String(d.mood || '').trim()
    if (mood) line = '【' + date + ' · 心情：' + mood + '】' + '\n' + content
    if (total + line.length > MAX_CONTEXT_CHARS) break // 超上限：丢弃更早的日记
    blocks.push(line)
    total += line.length
  }
  blocks.reverse() // 回到升序
  return { text: blocks.join('\n\n'), count: blocks.length }
}

/**
 * 正文排版归一化（前端是纯文本展示，不吃 markdown 标记）：
 *   - 行首的 markdown 标题（# / ## / ###…）统一转成符号行：一级「◆ 标题」、二级及更深「◇ 标题」
 *   - 小标题前补一个空行，让分段更透气
 *   - 去掉行内加粗标记 **xxx**（符号已承担强调作用，留着反而会显示成星号）
 * 说明：模型仍按 markdown 输出（结构化最稳定），由这里翻译成符号，保证
 *      总结结果页 / 保存后的日记详情 / 分享文案 三处显示一致。
 */
function normalizeSummaryText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^\s*(#{1,6})\s*(.*)$/)
    if (m) {
      const symbol = m[1].length <= 2 ? '◆' : '◇'
      if (out.length && out[out.length - 1] !== '') out.push('') // 标题前保证空行
      out.push(symbol + ' ' + m[2].replace(/\*\*/g, '').trim())
      continue
    }
    out.push(line.replace(/\*\*/g, ''))
  }
  // 去掉标题后可能出现的连续空行（最多保留一个）
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// 限流：单用户每日次数检查 + 计数
async function checkAndCountQuota(openid, today) {
  try {
    const res = await db.collection('summary_quota').where({ openid: openid, date: today }).limit(1).get()
    const rec = res.data && res.data[0]
    if (rec && rec.count >= DAILY_LIMIT) {
      return { ok: false, error: '今日 AI 总结次数已用完，明天再来', used: rec.count }
    }
    if (rec) {
      await db.collection('summary_quota').doc(rec._id).update({ data: { count: _.inc(1) } })
      return { ok: true, used: (rec.count || 0) + 1 }
    }
    await db.collection('summary_quota').add({ data: { openid: openid, date: today, count: 1 } })
    return { ok: true, used: 1 }
  } catch (e) {
    // 限流集合不存在/读写失败：不阻塞主流程（首次调用集合可能未创建，add 会自动建）
    console.warn('[aiSummary] 限流计数异常，放行本次:', e && e.message)
    return { ok: true, used: -1 }
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || 'unknown'

  const userPrompt = String((event && event.userPrompt) || '').trim()
  if (!userPrompt) return { success: false, error: '需求不能为空' }

  const diaries = Array.isArray(event && event.diaries) ? event.diaries : []
  if (!diaries.length) return { success: false, error: '所选时间段暂无日记' }

  if (!API_KEY) return { success: false, error: '服务端未配置 DEEPSEEK_API_KEY' }

  // 限流
  const today = getBeijingDateKey()
  const quota = await checkAndCountQuota(openid, today)
  if (!quota.ok) return { success: false, error: quota.error, quotaUsed: quota.used }

  // 日记数量上限（最多 365 篇）
  const limited = diaries.slice(0, MAX_DIARIES)

  // 组装上下文
  const ctx = buildDiaryContext(limited)
  if (!ctx.count) return { success: false, error: '所选时间段暂无日记' }

  // 构造请求
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: '【用户日记内容】\n' + ctx.text + '\n\n【用户的需求指令】\n' + userPrompt }
  ]

  try {
    const res = await callDeepSeek(messages)
    if (res.status !== 200) {
      const msg = (res.body && (res.body.error && res.body.error.message || res.body.message)) || res.status
      return { success: false, error: 'AI 分析失败，请稍后重试', detail: msg }
    }
    const summaryText = res.body.choices && res.body.choices[0] && res.body.choices[0].message && res.body.choices[0].message.content
    if (!summaryText) return { success: false, error: 'AI 返回为空，请重试' }

    return {
      success: true,
      summaryText: normalizeSummaryText(summaryText),
      diaryCount: ctx.count,
      quotaUsed: quota.used,
      truncated: ctx.count < diaries.length // 是否因超长被裁剪（提示用户日记较多）
    }
  } catch (e) {
    console.error('[aiSummary] 调用 AI 失败:', e && e.message)
    return { success: false, error: 'AI 分析超时，请缩短时间范围后重试' }
  }
}
