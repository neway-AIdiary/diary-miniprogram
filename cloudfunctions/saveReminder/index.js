/**
 * 云函数：saveReminder
 * 保存/更新用户的闹钟提醒配置
 *
 * 入参：{ cycle: 'daily'|'weekly', time: 'HH:mm', dayOfWeek: 1-7（仅 weekly），enabled: bool }
 * 出参：{ ok: true, id } 或 { error }
 *
 * 数据库：reminders 集合（每个 openid 一条）
 *   {
 *     openid, cycle, time, dayOfWeek, enabled, lastSentCycle, updatedAt
 *   }
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { error: '未识别用户' }

  const cycle = String((event && event.cycle) || '')
  const time = String((event && event.time) || '')
  const dayOfWeek = event && event.dayOfWeek != null ? Number(event.dayOfWeek) : null
  const enabled = !!(event && event.enabled)

  if (cycle !== 'daily' && cycle !== 'weekly') return { error: '周期不合法（仅支持 daily/weekly）' }
  if (!/^\d{1,2}:\d{2}$/.test(time)) return { error: '时间格式不合法（HH:mm）' }
  if (cycle === 'weekly' && !(dayOfWeek >= 1 && dayOfWeek <= 7)) return { error: '周几不合法（1-7）' }

  // 查现有记录
  const exist = await db.collection('reminders').where({ openid }).limit(1).get()
  const prev = exist.data[0] || {}
  const payload = {
    openid,
    cycle,
    time,
    dayOfWeek: cycle === 'weekly' ? dayOfWeek : null,
    enabled,
    // 关闭再开启后允许再发：清空 lastSentCycle
    lastSentCycle: enabled ? (prev.lastSentCycle || '') : '',
    updatedAt: Date.now()
  }

  if (prev._id) {
    await db.collection('reminders').doc(prev._id).update({ data: payload })
    return { ok: true, id: prev._id }
  } else {
    const r = await db.collection('reminders').add({ data: payload })
    return { ok: true, id: r._id }
  }
}