/**
 * 云函数：reminderTask
 * 定时触发器（每分钟一次）—— 扫所有 enabled 提醒，按周期匹配到点且「周期内还没写过日记」的用户，推送订阅消息
 *
 * 模板 ID（用户已选用「每日记录提醒」生效中）：
 *   vLvztBed6Og4EEVcO2phVJUYFLtKU-BlVMS-bVEqA80
 * 字段内容：
 *   日期 = 2026年9月10日（当天日期）
 *   记录内容 = Hi，写日记啦
 *   已记录天数 = 该用户 written_dates 集合总数
 *   备注 = 点击进入一灯记
 *
 * ⚠️ 字段 key（date1/thing1/number1/thing2 等）是模板详情里每个字段右侧标识符。
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

const TEMPLATE_ID = 'vLvztBed6Og4EEVcO2phVJUYFLtKU-BlVMS-bVEqA80'

// 模板字段 key（按微信公众平台「我的模板 → 详情」实际标识填）
// 模板名：每日记录提醒
//   日期(YYYY年M月D日) → date1
//   记录内容(Hi，写日记啦) → thing1
//   已记录天数(数字) → number3
//   备注(点击进入一灯记) → thing2
const TEMPLATE_FIELDS = {
  date: 'date1',
  content: 'thing1',
  totalDays: 'number3',
  remark: 'thing2'
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

  // 拉所有当前分钟匹配且 enabled 的提醒（按 _id 倒序保证最新生效；单次拉 100 条够个人量级）
  const remindersRes = await db.collection('reminders').where({
    enabled: true,
    time: timeStr
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

    // 算总记录天数
    const totalDays = writtenDates.length

    // 推送订阅消息
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: r.openid,
        templateId: TEMPLATE_ID,
        page: 'pages/write/write',
        data: {
          [TEMPLATE_FIELDS.date]: { value: fmtDateCN(parts.year, parts.month, parts.day) },
          [TEMPLATE_FIELDS.content]: { value: 'Hi，写日记啦' },
          [TEMPLATE_FIELDS.totalDays]: { value: String(totalDays) },
          [TEMPLATE_FIELDS.remark]: { value: '点击进入一灯记' }
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
      // 不更新 lastSentCycle，下一分钟再尝试
    }
  }

  return { ok: true, sent, skipped, failed, total: reminders.length, time: timeStr }
}