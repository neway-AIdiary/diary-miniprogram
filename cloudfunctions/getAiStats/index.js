/**
 * 云函数：getAiStats
 * [ai-usage v1] 商业化埋点统计：聚合 ai_usage 集合，为定价与 AI 成本红线提供数据。
 *
 * 调用方式（当前仅开发者自用）：
 *   开发者工具 → 云函数 → getAiStats → 云端测试，入参 { "days": 30 }
 *   或在小程序端 wx.cloud.callFunction({ name: 'getAiStats', data: { days: 30 } })
 *
 * 返回（仅聚合，无 openid 全文——top 列表只给尾号 6 位）：
 *   { days, total, truncated, users, okCount, totalTokens, byFn, byDay, topUsers }
 *
 * 门槛：环境变量 STATS_ADMIN_OPENID 配置后仅该 openid 可查；未配置时放行
 *       （当前没有客户端入口，只有云端测试能调到）。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const admin = process.env.STATS_ADMIN_OPENID || ''
  if (admin && (!wxContext || wxContext.OPENID !== admin)) {
    return { error: '无权限' }
  }

  const days = Math.min(Math.max(parseInt(event && event.days, 10) || 30, 1), 365)
  const sinceTs = Date.now() - days * 86400000

  // 分页拉取（服务端单次 get 上限 1000 条；埋点量级远低于此，10000 封顶防失控）
  const rows = []
  let skip = 0
  while (rows.length < 10000) {
    const batch = await db.collection('ai_usage')
      .where({ ts: _.gte(sinceTs) })
      .orderBy('ts', 'desc')
      .skip(skip)
      .limit(1000)
      .get()
    const data = batch.data || []
    rows.push.apply(rows, data)
    if (data.length < 1000) break
    skip += 1000
  }

  const byFn = {}
  const byDay = {}
  const byUser = {}
  let totalTokens = 0
  let okCount = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const fn = String(r.fn || 'unknown')
    const day = String(r.date || '-')
    if (!byFn[fn]) byFn[fn] = { count: 0, ok: 0, totalTokens: 0 }
    byFn[fn].count++
    if (r.ok) byFn[fn].ok++
    byFn[fn].totalTokens += (r.totalTokens || 0)
    if (!byDay[day]) byDay[day] = { count: 0, totalTokens: 0 }
    byDay[day].count++
    byDay[day].totalTokens += (r.totalTokens || 0)
    const oid = String(r.openid || '')
    if (oid) byUser[oid] = (byUser[oid] || 0) + 1
    totalTokens += (r.totalTokens || 0)
    if (r.ok) okCount++
  }
  const topUsers = Object.keys(byUser)
    .map(function (k) { return { openidTail: k.slice(-6), calls: byUser[k] } })
    .sort(function (a, b) { return b.calls - a.calls })
    .slice(0, 10)

  return {
    days: days,
    total: rows.length,
    truncated: rows.length >= 10000,
    users: Object.keys(byUser).length,
    okCount: okCount,
    totalTokens: totalTokens,
    byFn: byFn,
    byDay: byDay,
    topUsers: topUsers
  }
}
