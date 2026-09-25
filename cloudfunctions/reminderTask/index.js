/**
 * 云函数：reminderTask
 * 定时触发器（每分钟一次）—— 扫所有 enabled 提醒，按周期匹配到点且「周期内还没写过日记」的用户，推送订阅消息
 *
 * 模板 ID（用户已选用「待办事项提醒」生效中，模版编号 2983，类目：备忘录）：
 *   43jTDjTJTUZd3tvis9ErkXv5Zoz0yUWPmB-7paOeGwc
 * 字段内容：
 *   事项主题 = 写日记（固定值）
 *   提醒时间 = 当天日期 + 用户设的提醒时刻，如「2026年9月10日 21:00」
 *   事项描述 = 点击进入一灯记
 *
 * ⚠️ 字段 key（thing1/time23/thing4 等）是模板详情里每个字段右侧标识符。
 *    若发送报错 missing parameter，请到微信公众平台「订阅消息 → 我的模板 → 详情」查看真实 key 改 TEMPLATE_FIELDS。
 *
 * 数据库：
 *   reminders（用户配置：openid, cycle, time, dayOfWeek, enabled, lastSentCycle）
 *   written_dates（用户写日记记录：openid, date）
 *
 * config.json 需声明 openapi 权限 subscribeMessage.send + 定时触发器
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TEMPLATE_ID = '43jTDjTJTUZd3tvis9ErkXv5Zoz0yUWPmB-7paOeGwc'

// 模板字段 key（微信公众平台「待办事项提醒」模板详情实测）：
//   事项主题 → thing1
//   提醒时间 → time23（「时间」类型，填「日期+时刻」格式）
//   事项描述 → thing4
const TEMPLATE_FIELDS = {
  subject: 'thing1',
  time: 'time23',
  desc: 'thing4'
}

// [reminder-window v1] 触发器每 5 分钟一次（config.json "0 */5 * * * * *"）；
// 查询由「time == 当前分钟」改为「过去 REMINDER_WINDOW_MIN 分钟」窗口匹配（_.in）：
//   ① 非整 5 分钟档设置的提醒（如 21:03）也能命中；
//   ② 发送失败后窗口内（10 分钟 > 触发间隔 5 分钟）下次触发仍命中可重试
//     （旧实现「下一分钟再尝试」的注释实际无效：下一分钟查询条件已是新分钟，
//      同一提醒永远匹配不回去——本次顺手修复）。
// 幂等仍由 lastSentCycle 保证：发过/已写即标记当天/当周周期，窗口内不会重复推送。
// ⚠️ REMINDER_WINDOW_MIN 必须 ≥ 触发间隔 × 2（当前 5×2）；改触发器频率时须同步调整。
const REMINDER_WINDOW_MIN = 10

// 生成覆盖 [nowMs-(n-1) 分钟, nowMs] 的窗口分钟串（升序），统一按北京时间计算；
// 跨小时/跨天由时间算术自然正确（如北京 00:00 时窗口含 "23:51"~"00:00"）。
function minuteWindow(nowMs, n) {
  const list = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(nowMs + 8 * 3600 * 1000 - i * 60000)
    list.push(pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()))
  }
  return list
}

// 微信云函数运行在 UTC+0，统一按北京时间计算
function getBeijingParts() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    raw: now
  }
}

function pad2(n) { return n < 10 ? '0' + n : '' + n }
function fmtDateKey(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d) }
function fmtDateCN(y, m, d) { return y + '年' + m + '月' + d + '日' }

// ISO 周编号（YYYY-Www）
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return d.getUTCFullYear() + '-W' + pad2(weekNum)
}

// 周几 1-7（周一=1，周日=7）
function dayOfWeekISO(date) { return date.getUTCDay() || 7 }

exports.main = async () => {
  const parts = getBeijingParts()
  const hh = pad2(parts.hour)
  const mm = pad2(parts.minute)
  const timeStr = hh + ':' + mm
  const todayKey = fmtDateKey(parts.year, parts.month, parts.day)
  const weekKey = isoWeekKey(parts.raw)
  const dow = dayOfWeekISO(parts.raw)

  // 本周一的日期 key（用于 weekly 周期判定）
  const monday = new Date(parts.raw)
  monday.setUTCDate(monday.getUTCDate() - (dow - 1))
  const mondayKey = fmtDateKey(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate())

  // 拉所有 time 落在过去 REMINDER_WINDOW_MIN 分钟内且 enabled 的提醒（按 _id 倒序保证最新生效；单次拉 100 条够个人量级）
  // [reminder-window v1] 原为「time == 当前分钟」精确匹配；触发器改稀疏后须窗口匹配才能覆盖任意分钟档
  const remindersRes = await db.collection('reminders').where({
    enabled: true,
    time: _.in(minuteWindow(Date.now(), REMINDER_WINDOW_MIN))
  }).limit(100).get()
  const reminders = remindersRes.data || []
  if (!reminders.length) return { ok: true, processed: 0 }

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const r of reminders) {
    // 周期匹配
    if (r.cycle === 'weekly') {
      if (Number(r.dayOfWeek) !== dow) { skipped++; continue }
    } else if (r.cycle === 'daily') {
      // nothing extra
    } else {
      // 未知周期（防御）
      skipped++; continue
    }

    // 周期内是否已提醒过
    const cycleKey = r.cycle === 'weekly' ? weekKey : todayKey
    if (r.lastSentCycle === cycleKey) { skipped++; continue }

    // 查该用户所有写日记日期
    const writtenRes = await db.collection('written_dates').where({ openid: r.openid }).limit(1000).get()
    const writtenDates = (writtenRes.data || []).map(d => d.date)

    // 判断周期内是否写过
    let hasWrittenInCycle = false
    if (r.cycle === 'daily') {
      hasWrittenInCycle = writtenDates.indexOf(todayKey) !== -1
    } else {
      // weekly: 本周一 00:00 ≤ date ≤ today
      hasWrittenInCycle = writtenDates.some(d => d >= mondayKey && d <= todayKey)
    }

    // 即使已写过也标记 lastSentCycle，避免每分钟重复查
    if (hasWrittenInCycle) {
      await db.collection('reminders').doc(r._id).update({
        data: { lastSentCycle: cycleKey }
      })
      skipped++; continue
    }

    // 推送订阅消息（提醒时间 = 当天日期 + 用户设的提醒时刻）
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: r.openid,
        templateId: TEMPLATE_ID,
        page: 'pages/write/write',
        data: {
          [TEMPLATE_FIELDS.subject]: { value: '写日记' },
          [TEMPLATE_FIELDS.time]: { value: fmtDateCN(parts.year, parts.month, parts.day) + ' ' + (r.time || timeStr) },
          [TEMPLATE_FIELDS.desc]: { value: '点击进入一灯记' }
        }
      })
      await db.collection('reminders').doc(r._id).update({
        data: { lastSentCycle: cycleKey, lastSentAt: Date.now() }
      })
      sent++
    } catch (e) {
      failed++
      console.error(
        '[reminderTask] send fail openid=' + r.openid +
        ' errCode=' + (e && e.errCode) +
        ' errMsg=' + (e && e.errMsg)
      )
      // 不更新 lastSentCycle；窗口匹配下下次触发仍命中，10 分钟内自动重试
    }
  }

  return { ok: true, sent, skipped, failed, total: reminders.length, time: timeStr }
}