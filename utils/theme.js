/**
 * 主题设置（唯一来源）
 * 两档：light（默认）/ dark；不做跟随系统，保持简洁。
 * 机制：各页根节点挂 class="page {{themeClass}}"，app.wxss 的 .theme-dark
 * 只覆盖颜色令牌（背景/文字/线/品牌/语义/阴影/磨砂），字体字号间距一律不动。
 * 页面底色与导航栏/窗口背景由 applyTo() 在 onShow 同步（page 元素吃不到根节点类）。
 * 首帧：utils/firstPaint.js 包装全局 Page —— 页面注册期补 data 初值、onLoad 首行按
 *       当前设置同步，使新进入页面的第一帧就是深色（本文件只负责求值/应用，不改页面）。
 */
const KEY = 'yidengji_theme_mode'

/* 导航栏 / 窗口底色（与 app.wxss 对应令牌一致） */
const CHROME = {
  light: { bg: '#EFEBE5', front: '#000000' },
  dark: { bg: '#1B1916', front: '#ffffff' }
}

function getMode() {
  try {
    return wx.getStorageSync(KEY) === 'dark' ? 'dark' : 'light'
  } catch (e) {
    return 'light'
  }
}

function setMode(mode) {
  try {
    wx.setStorageSync(KEY, mode === 'dark' ? 'dark' : 'light')
  } catch (e) { /* 存储异常时静默，保持当前主题 */ }
}

/* 根节点类名：dark → 'theme-dark'，light → ''（不吃类，走 page{} 默认） */
function pageClass(mode) {
  return (mode || getMode()) === 'dark' ? 'theme-dark' : ''
}

/* 同步窗口背景与导航栏（page 元素与系统 chrome 无法用类切换，只能运行时设置） */
function applyChrome(mode) {
  if (typeof wx === 'undefined' || !wx.setNavigationBarColor) return
  const m = mode || getMode()
  const c = CHROME[m] || CHROME.light
  try {
    /* [theme-firstpaint v1] 关掉导航栏默认约 200ms 渐变：深色下切页时「慢慢变深」
       的观感比闪一下更明显，瞬变更接近「第一帧就是深色」 */
    wx.setNavigationBarColor({
      frontColor: c.front,
      backgroundColor: c.bg,
      animation: { duration: 0, timingFunc: 'linear' }
    })
  } catch (e) { /* 部分环境不支持时静默 */ }
  try {
    if (wx.setBackgroundColor) wx.setBackgroundColor({ backgroundColor: c.bg })
  } catch (e) { /* 同上 */ }
  try {
    /* [theme-transition v1] 下拉回弹的 loading 三点：静态 backgroundTextStyle 是 dark，
       深色底上几乎不可见，这里跟随主题（浅色 dark / 深色 light） */
    if (wx.setBackgroundTextStyle) {
      wx.setBackgroundTextStyle({ textStyle: m === 'dark' ? 'light' : 'dark' })
    }
  } catch (e) { /* 同上 */ }
}

/* 各页 onShow 调用：根节点类 + 系统 chrome 一次到位 */
function applyTo(page) {
  const mode = getMode()
  page.setData({ themeClass: pageClass(mode) })
  applyChrome(mode)
}

module.exports = {
  KEY,
  CHROME,
  getMode,
  setMode,
  pageClass,
  applyChrome,
  applyTo
}
