/**
 * 日记本密码（4 位数字）—— 纯本地「界面锁」
 *
 * 定位：防「身边人随手翻你手机」，不是安全级防护。
 *   - 只存 3 个本地键（开关 / 盐 / 哈希），不存明文密码，不碰日记数据；
 *   - 数据仍是明文存在本地 Storage，拿到设备调试权限的人可以绕过；
 *   - 不做加密、不接云端，因此「忘记密码 → 清空密码」不丢日记。
 *
 * 哈希：pbkdf2(密码, 16 字节随机盐, 5000 轮) 存十六进制。
 *   4 位密码只有 1 万种组合，轮数的意义只是「不存明文 + 不秒破」，
 *   5000 轮实测桌面 ~44ms（手机约 3~8 倍），解锁不卡手。
 *
 * 会话态：sessionUnlocked 只存在内存，小程序被杀死/冷启动即失效。
 * 锁定时机（与 app.js 约定）：
 *   - 冷启动：initSession() → 未解锁 → 首屏守卫跳锁屏页；
 *   - 回前台：onAppShow() 判定后台停留 ≥ RELOCK_SEC 秒则重新上锁。
 */
const crypto = require('./crypto.js')

const K_ENABLED = 'yidengji_lock_enabled'
const K_SALT = 'yidengji_lock_salt'
const K_HASH = 'yidengji_lock_hash'
const K_FAIL = 'yidengji_lock_fail'

const LOCK_PAGE = '/pages/lock/lock'
const HOME_PAGE = '/pages/write/write'

const CODE_LEN = 4
const ITERATIONS = 5000
const MAX_FAIL = 5            // 连错 5 次
const FREEZE_SEC = 30         // 冻结 30 秒
const RELOCK_SEC = 30         // 后台停留满 30 秒，回来重新上锁

// ===== 会话态（内存，不落盘）=====
let sessionUnlocked = false
let hideAt = 0                // 进入后台的时刻（0 表示无记录）
let redirecting = false       // 跳锁屏页防抖（多页 onShow 同时守卫时只跳一次）
let nowFn = function () { return Date.now() }   // 测试可注入

// ===== 存储读写（异常一律静默）=====
function read(key, dv) {
  try {
    const v = wx.getStorageSync(key)
    return v === '' || v === undefined || v === null ? dv : v
  } catch (e) { return dv }
}
function write(key, v) {
  try { wx.setStorageSync(key, v) } catch (e) { /* 存储异常静默 */ }
}
function remove(key) {
  try { wx.removeStorageSync(key) } catch (e) { /* 同上 */ }
}

// ===== 开关与密码 =====
function isEnabled() {
  return read(K_ENABLED, '') === '1'
}

function hashOf(code, saltHex) {
  return crypto.bytesToHex(crypto.pbkdf2(String(code), saltHex, ITERATIONS, 32))
}

// 设置（或修改）密码：只接受 4 位数字
function setCode(code) {
  const c = String(code === null || code === undefined ? '' : code)
  if (!new RegExp('^\\d{' + CODE_LEN + '}$').test(c)) return false
  const saltHex = crypto.bytesToHex(crypto.randomBytes(16))
  write(K_SALT, saltHex)
  write(K_HASH, hashOf(c, saltHex))
  write(K_ENABLED, '1')
  remove(K_FAIL)
  sessionUnlocked = true      // 刚设完密码，当前会话视为已解锁
  return true
}

// 校验密码（未开启密码时恒为真）
function verify(code) {
  if (!isEnabled()) return true
  const salt = read(K_SALT, '')
  const want = read(K_HASH, '')
  if (!salt || !want) return false
  return hashOf(code, salt) === want
}

// 清空密码（忘记密码 / 主动关闭）：只删密码的 3 个键，日记一律不动
function clear() {
  remove(K_ENABLED)
  remove(K_SALT)
  remove(K_HASH)
  remove(K_FAIL)
  sessionUnlocked = true
}

// ===== 连错冻结 =====
function failState() {
  const v = read(K_FAIL, null)
  if (!v || typeof v !== 'object') return { count: 0, until: 0 }
  return { count: Number(v.count) || 0, until: Number(v.until) || 0 }
}

// 剩余冻结秒数（0 = 未冻结）
function freezeLeft() {
  const left = failState().until - nowFn()
  return left > 0 ? Math.ceil(left / 1000) : 0
}

function noteFail() {
  const f = failState()
  f.count = f.count + 1
  if (f.count >= MAX_FAIL) {
    f.until = nowFn() + FREEZE_SEC * 1000
    f.count = 0
  }
  write(K_FAIL, f)
  return freezeLeft()
}

/**
 * 一次解锁尝试（锁屏页与设置页验证旧密码共用一套冻结）
 * 返回 { ok, freeze, reason }
 *   ok     : 是否通过
 *   freeze : 剩余冻结秒数（>0 时不可输入）
 *   reason : 'frozen' | 'wrong' | '' 
 */
function attempt(code) {
  if (!isEnabled()) return { ok: true, freeze: 0, reason: '' }
  const left = freezeLeft()
  if (left > 0) return { ok: false, freeze: left, reason: 'frozen' }
  if (verify(code)) {
    remove(K_FAIL)
    sessionUnlocked = true
    return { ok: true, freeze: 0, reason: '' }
  }
  return { ok: false, freeze: noteFail(), reason: 'wrong' }
}

// ===== 会话态 =====
function isSessionUnlocked() { return sessionUnlocked }
function unlockSession() { sessionUnlocked = true }
function lockSession() { sessionUnlocked = false }

// 冷启动调用：密码开启则本次会话以「未解锁」开始
function initSession() {
  sessionUnlocked = !isEnabled()
  hideAt = 0
  redirecting = false
  return sessionUnlocked
}

// 进入后台：记下时刻（供回前台判定停留时长）
function noteHide() {
  hideAt = nowFn()
}

/**
 * App.onShow 调用：冷启动未解锁、或后台停留 ≥ RELOCK_SEC 秒 → 重新上锁并跳锁屏页
 * 返回 true 表示已判定需要上锁
 */
function onAppShow() {
  if (!isEnabled()) { hideAt = 0; return false }
  const idle = hideAt ? nowFn() - hideAt : 0
  hideAt = 0
  if (sessionUnlocked && idle < RELOCK_SEC * 1000) return false
  sessionUnlocked = false
  guard()
  return true
}

/**
 * 页面守卫：需要锁且会话未解锁 → reLaunch 到锁屏页（清空页面栈，物理返回退不回内容页）
 * 各页 onShow 首行调用；另有 400ms 防抖，多页同时触发只跳一次。
 *
 * 页面栈为空时不发起跳转（冷启动时 App.onShow 早于首屏 onLoad，此时 reLaunch 会失败，
 * 若同时置了防抖标记，会把首屏自己的守卫一起挡掉 → 漏锁）。交给首个页面自己跳。
 */
function guard() {
  if (!isEnabled() || sessionUnlocked) return false
  if (stackDepth() === 0) return true
  if (redirecting) return true
  redirecting = true
  const release = function () {
    setTimeout(function () { redirecting = false }, 400)
  }
  try {
    wx.reLaunch({ url: LOCK_PAGE, complete: release })
  } catch (e) {
    redirecting = false
  }
  return true
}

// 当前页面栈深度（非小程序环境或取不到时按 1 处理，不影响守卫语义）
function stackDepth() {
  try {
    if (typeof getCurrentPages !== 'function') return 1
    return getCurrentPages().length
  } catch (e) { return 1 }
}

// 解锁成功后回首页（页面栈已被 reLaunch 清空，只能回默认首页）
function goHome() {
  try {
    wx.reLaunch({ url: HOME_PAGE })
  } catch (e) { /* 静默 */ }
}

module.exports = {
  LOCK_PAGE,
  HOME_PAGE,
  CODE_LEN,
  ITERATIONS,
  MAX_FAIL,
  FREEZE_SEC,
  RELOCK_SEC,
  isEnabled,
  setCode,
  verify,
  clear,
  attempt,
  freezeLeft,
  isSessionUnlocked,
  unlockSession,
  lockSession,
  initSession,
  noteHide,
  onAppShow,
  guard,
  goHome,
  // 仅供回归测试：注入时钟 / 复位会话态
  _setNow(fn) { nowFn = fn || function () { return Date.now() } },
  _resetSession() { sessionUnlocked = false; hideAt = 0; redirecting = false }
}
