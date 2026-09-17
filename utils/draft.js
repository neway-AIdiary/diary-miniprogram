/**
 * 写日记页草稿（防「写了一半离开就没了」）
 *
 * 场景：写日记页被销毁时内容会丢——典型触发是「切后台超过 30 秒回来被密码锁」，
 *       锁屏是 reLaunch（清空页面栈），原页面连同未保存的正文一起被销毁。
 *
 * 策略：只暂存正文文本，离开页面时写入、回来时若输入框为空则恢复。
 *       - 不存媒体（照片/视频已上传云存储，由 write 页的会话清单负责回收）；
 *       - 不存心情/日期（影响小，避免恢复时联动遗漏）；
 *       - 保存日记成功后清除（resetAfterSave）；
 *       - 超过 MAX_AGE_MS 自动作废，避免翻出陈年老草稿。
 */
const KEY = 'yidengji_write_draft'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function raw() {
  try {
    const v = wx.getStorageSync(KEY)
    return v && typeof v === 'object' ? v : null
  } catch (e) { return null }
}

// 存草稿：空内容视为「用户主动清空」，直接删掉草稿而不是存空
function save(content) {
  const c = String(content === null || content === undefined ? '' : content)
  if (!c.trim()) { clear(); return false }
  try {
    wx.setStorageSync(KEY, { content: c, savedAt: Date.now() })
    return true
  } catch (e) { return false }
}

// 读草稿：无草稿、已过期、内容为空都返回 null
function load() {
  const d = raw()
  if (!d) return null
  const c = String(d.content || '')
  if (!c.trim()) return null
  const at = Number(d.savedAt) || 0
  if (at && Date.now() - at > MAX_AGE_MS) { clear(); return null }
  return { content: c, savedAt: at }
}

function clear() {
  try { wx.removeStorageSync(KEY) } catch (e) { /* 静默 */ }
}

module.exports = {
  KEY,
  MAX_AGE_MS,
  save,
  load,
  clear
}
