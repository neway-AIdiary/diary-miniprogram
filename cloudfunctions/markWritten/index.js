/**
 * 云函数：markWritten
 * 用户写日记成功后调用，标记「某 openid 在某日期写过日记」
 *
 * 入参：{ date: 'YYYY-MM-DD' }
 * 出参：{ ok: true } 或 { error }
 *
 * 数据库：written_dates 集合
 *   { openid, date, updatedAt }
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { error: '未识别用户' }

  const date = String((event && event.date) || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日期格式不合法（YYYY-MM-DD）' }

  const exist = await db.collection('written_dates').where({ openid, date }).limit(1).get()
  if (exist.data[0]) {
    await db.collection('written_dates').doc(exist.data[0]._id).update({
      data: { updatedAt: Date.now() }
    })
  } else {
    await db.collection('written_dates').add({
      data: { openid, date, createdAt: Date.now(), updatedAt: Date.now() }
    })
  }
  return { ok: true }
}