/**
 * 闹钟/写日记上报相关的云函数调用封装
 * 所有方法失败静默（不影响主流程）
 */

const REMINDER_CF = 'saveReminder'
const MARK_WRITTEN_CF = 'markWritten'

// 是否有云开发能力（IDE / 非云开发项目下 wx.cloud 可能不存在）
function hasCloud() {
  return typeof wx !== 'undefined' && typeof wx.cloud !== 'undefined' && typeof wx.cloud.callFunction === 'function'
}

// 上报「某 openid 在某日期写过日记」
// 失败静默，不影响主保存流程
function callMarkWritten(date) {
  if (!hasCloud()) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return
  wx.cloud.callFunction({
    name: MARK_WRITTEN_CF,
    data: { date },
    success: () => { /* 静默 */ },
    fail: () => { /* 静默：失败也不影响日记保存 */ }
  })
}

module.exports = {
  callMarkWritten,
  // 暴露常量供设置页使用（如不想在设置页重复声明）
  REMINDER_CF,
  MARK_WRITTEN_CF,
  hasCloud
}