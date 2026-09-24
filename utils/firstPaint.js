/**
 * [theme-firstpaint v1] 主题 / 字体「首帧就位」——消除深色模式切页「先浅后深」闪一下
 *
 * 症状（用户真机）：深色模式下点进日记本，先看到一整个浅色页面，下一帧才翻深；
 *                  其他按钮切页同样。
 *
 * 根因：各页 data 里 themeClass / fontStyle 的初值是空串，真正的赋值发生在 onShow
 *   （theme.applyTo(this) / setData(fontSetting.buildStyle())），而页面**首帧渲染读的是
 *   data 初值** ⇒ 深色用户每次都先看到浅色首帧。
 *   更麻烦的是：data 字面量只在页面 JS 模块「首次执行」时求值一次 —— 即便把初值写成
 *   求值表达式（themeClass: theme.pageClass()），用户在设置页切了主题后再进入一个
 *   「已加载过」的页面，拿到的仍是注册那一刻的旧值。所以必须在**实例期**再同步一次。
 *
 * 做法：包装全局 Page（app.js onLaunch 里安装，早于任何页面 JS 执行）
 *   - 注册期：data 里没有 themeClass 就补当前主题类；data 里**声明了** fontStyle 才填当前字体串
 *   - 实例期：把 onLoad 包一层，首行按「当前设置」重写这两项（此时尚未渲染，不产生二次渲染）
 *
 * 与 onShow 的 theme.applyTo() 分工（两者都必须保留，缺一不可）：
 *   - 本模块：管「新进入的页面，第一帧就是对的」
 *   - onShow/applyTo：管「在设置页改了主题或字体、返回**栈内已有页面**」的即时刷新
 *
 * 失败降级：任何一步异常都不阻断页面 —— 主题退回 onShow 修正（会闪，但功能不坏）。
 */
const theme = require('./theme.js')
const fontSetting = require('./fontSetting.js')

const MARK = '__ypFirstPaint'

/* 注册期：补初值（只补缺失/空串，不覆盖页面自己声明的非空值） */
function seedData(data) {
  if (!data || typeof data !== 'object') return
  if (!data.themeClass) data.themeClass = theme.pageClass()
  if (Object.prototype.hasOwnProperty.call(data, 'fontStyle') && !data.fontStyle) {
    data.fontStyle = fontSetting.buildStyle()
  }
}

/* 实例期：按当前设置重写（页面首帧渲染之前调用） */
function syncNow(page) {
  if (!page || typeof page.setData !== 'function') return
  const patch = { themeClass: theme.pageClass() }
  if (page.data && Object.prototype.hasOwnProperty.call(page.data, 'fontStyle')) {
    patch.fontStyle = fontSetting.buildStyle()
  }
  page.setData(patch)
}

function install() {
  if (typeof Page !== 'function') return false
  if (Page[MARK]) return true // 幂等：已安装
  const origin = Page
  const wrapped = function (opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    try {
      seedData(o.data)
    } catch (e) { /* 初值补不上不阻断注册，退回 onShow 修正 */ }
    const userOnLoad = typeof o.onLoad === 'function' ? o.onLoad : null
    o.onLoad = function () {
      try {
        syncNow(this)
      } catch (e) { /* 同上：失败不阻断生命周期 */ }
      if (userOnLoad) return userOnLoad.apply(this, arguments)
    }
    return origin(o)
  }
  wrapped[MARK] = true
  try {
    /* Page 是小程序注入的全局函数：重写全局引用，页面 JS 执行时读到的即包装版。
       不用 globalThis / global —— 各基础库对这些的暴露不一致；
       隐式全局赋值在非严格模式下始终有效（本项目 app.js 未声明 'use strict'）。
       包装的是「注册入口」而非页面本身，页面 opts 原样交给原生 Page。 */
    Page = wrapped
  } catch (e) {
    console.warn('[firstPaint] 包装 Page 失败:', e)
  }
  if (!Page || !Page[MARK]) {
    console.warn('[firstPaint] Page 包装未生效，主题首帧化退化为 onShow 修正')
    return false
  }
  return true
}

module.exports = {
  install,
  seedData,
  syncNow,
  MARK
}
