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
 *   - 单用户每日上限 5 次（按北京时间自然日），超出返回友好提示
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
const DAILY_LIMIT = 5          // 单用户每日最多 5 次
const MAX_DIARIES = 365        // 单次最多读取 365 篇
const MAX_CONTEXT_CHARS = 12000 // 拼接日记上下文总字符上限（超出裁剪最早日记）

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

// 构造系统提示词（文档十一节给的固定前缀）
function buildSystemPrompt() {
  return [
    '你是AI日记助手，基于用户提供的多篇日记内容，按照用户的要求进行总结。',
    '要求：',
    '1. 只用提供的日记内容，不要编造不存在信息；',
    '2. 语言简洁自然，贴合日记风格；',
    '3. 可以分段，支持简单markdown列表；',
    '4. 如果信息不足，如实告知用户。'
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
      summaryText: summaryText.trim(),
      diaryCount: ctx.count,
      quotaUsed: quota.used,
      truncated: ctx.count < diaries.length // 是否因超长被裁剪（提示用户日记较多）
    }
  } catch (e) {
    console.error('[aiSummary] 调用 AI 失败:', e && e.message)
    return { success: false, error: 'AI 分析超时，请缩短时间范围后重试' }
  }
}
