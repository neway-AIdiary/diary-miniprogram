/**
 * [summary-nudge v1] 智能总结引导：导入完成 / 保存日记后按篇数提示用户试试智能总结
 * 规则（2026-09-25 拍板）：
 * - 阈值 > 20：当前篇数 − 上次智能总结「生成成功」时的篇数（anchor）> 20 → 提示；
 *   从没用过智能总结（无 anchor）→ 当前篇数 > 20 → 提示
 * - 两档弹窗：「去试试」跳智能总结页 /「以后不再」写 mute 永久静默
 * - anchor 在智能总结生成成功时刷新（pages/summary 的 onGenerate 成功分支）
 * - 保存链路只置待提示标志（app.globalData.pendingSummaryNudge，write.js#afterSaveNavigate），
 *   由详情页 onShow 消费弹出 —— 避免与实体识别（备案弹窗）抢时序
 * 键名与主题等持久键同走 yidengji_ 前缀
 */
const storage = require('./storage.js')

const ANCHOR_KEY = 'yidengji_summary_anchor'   // number：上次总结生成成功时的日记总篇数
const MUTE_KEY = 'yidengji_summary_mute'       // '1'：用户选了「以后不再」
const FIRST_NUDGE_THRESHOLD = 10 // 从没用过智能总结：篇数 > 10 就引导（2026-09-25 拍板改）
const NUDGE_THRESHOLD = 20       // 用过之后：增量 > 20 再引导（不变）
const SUMMARY_URL = '/pages/summary/summary'

function getDiaryCount() {
  try {
    return storage.getAllDiaries().length
  } catch (e) {
    return 0
  }
}

function getAnchor() {
  const v = wx.getStorageSync(ANCHOR_KEY)
  return (typeof v === 'number' && isFinite(v)) ? v : null
}

function isMuted() {
  return wx.getStorageSync(MUTE_KEY) === '1'
}

// 纯判断：是否达到提示阈值（不弹窗，供置标志与测试复用）
function shouldPrompt(count) {
  if (isMuted()) return false
  const anchor = getAnchor()
  if (anchor === null) return count > FIRST_NUDGE_THRESHOLD // 从没用过智能总结：>10 就引导
  return count - anchor > NUDGE_THRESHOLD
}

// 保存链路：保存落定时若已达阈值 → 置待提示标志（详情页 onShow 消费），本函数不弹窗
function markSavedPending(app) {
  if (!shouldPrompt(getDiaryCount())) return false
  if (app && app.globalData) app.globalData.pendingSummaryNudge = true
  return true
}

// 详情页 onShow：消费待提示标志并弹引导；无论弹不弹都不影响页面流程
function consumePending(app) {
  if (!app || !app.globalData || !app.globalData.pendingSummaryNudge) return false
  app.globalData.pendingSummaryNudge = false
  return maybePrompt()
}

// 弹引导（两档）。返回是否弹了；showModal 不可叠加，调用方须保证当前没有别的弹窗
function maybePrompt() {
  if (isMuted()) return false
  const count = getDiaryCount()
  if (!shouldPrompt(count)) return false
  if (!wx.showModal || !wx.navigateTo) return false
  wx.showModal({
    title: '试试智能总结',
    content: '日记已经攒到 ' + count + ' 篇啦，试试让 AI 帮你总结一段时光？',
    confirmText: '去试试',
    cancelText: '不再提醒',
    success: (res) => {
      if (res && res.confirm) {
        wx.navigateTo({ url: SUMMARY_URL })
      } else {
        // 取消档 = 以后不再提示（拍板：两档）
        wx.setStorageSync(MUTE_KEY, '1')
      }
    }
  })
  return true
}

// 智能总结生成成功：刷新篇数锚点（count 可注入，测试与调用方复用）
function refreshAnchor(count) {
  const c = (typeof count === 'number' && isFinite(count)) ? count : getDiaryCount()
  wx.setStorageSync(ANCHOR_KEY, c)
  return c
}

module.exports = {
  FIRST_NUDGE_THRESHOLD, NUDGE_THRESHOLD, SUMMARY_URL, ANCHOR_KEY, MUTE_KEY,
  shouldPrompt, maybePrompt, markSavedPending, consumePending, refreshAnchor, isMuted, getAnchor
}
