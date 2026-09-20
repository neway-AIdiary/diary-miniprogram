/**
 * 自定义导航栏适配：[nav-title-center v1] 顶栏标题的「视觉居中」
 *
 * 为什么需要它：
 *   .nav-inner 左右 padding 对称（24rpx），.nav-title 用 left:50% + translateX(-50%)，
 *   在**数学上**严格居中于整屏。但顶栏右侧的微信胶囊按钮是**系统层覆盖**上来的
 *   （约占 87pt 宽、距屏右缘 7pt），而左侧只有汉堡图标（可视线右缘 78rpx）
 *   ⇒ 375pt 机型上左留白约 129rpx、右留白仅 19rpx，人眼读成「偏右」。
 *
 * 口径：
 *   把标题中心对准「图标可视线右缘」与「胶囊左边缘」的中点 ⇒ 左右留白相等。
 *   偏移量只取决于两侧元素位置，与标题自身宽度无关。
 *
 * 降级：
 *   取不到胶囊信息时按「贴右 7pt + 宽 87pt」估算；若算出的偏移为反向（信息异常），
 *   则 shift=0 —— 退回数学居中（即接入前的现状），绝不把标题推向不可预期的位置。
 *
 * 测试：tools/test_about_info.js 的纯函数断言（无需 wx 桩）
 */

// 左侧汉堡图标可视线右缘（rpx）：.nav-inner padding-left 24 + .nav-lines padding 14 + 线宽 40
const ICON_RIGHT_RPX = 78
// 标题与两侧元素的最小安全间距（rpx）
const GAP_RPX = 8
// 默认字号（rpx），与 write.wxss 的 .nav-title 保持一致
const FONT_RPX = 30
// 缩字下限（rpx）：再小就不如截断
const MIN_FONT_RPX = 24
// 字距（rpx）：对应 --title-track
const TRACK_RPX = 0.5
// 胶囊兜底参数（px/逻辑点）：距屏右缘 7、宽 87
const CAPSULE_RIGHT_PX = 7
const CAPSULE_WIDTH_PX = 87

// 半角字符按 0.55 个字宽计。
// 注意：只认 ASCII 可见字符 —— 「·」是 U+00B7（Latin-1 补充），
// 若用 \x00-\xff 判定会被误当半角，而中文语境下它按全角渲染。
function isHalfWidth(ch) {
  return /[\x20-\x7e]/.test(ch)
}

// 估算文本渲染宽度（rpx）：全角 1 个字宽、半角 0.55，另加字距
function estimateTextWidthRpx(text, fontRpx) {
  const chars = Array.from(String(text == null ? '' : text))
  let units = 0
  for (let i = 0; i < chars.length; i++) {
    units += isHalfWidth(chars[i]) ? 0.55 : 1
  }
  return units * fontRpx + chars.length * TRACK_RPX
}

/**
 * @param {Object} opts
 *   screenW     屏宽（px，取 wx.getWindowInfo().windowWidth）
 *   capsuleLeft 胶囊左边缘（px，取 wx.getMenuButtonBoundingClientRect().left）；<=0 走兜底
 *   text        标题文本
 *   fontRpx     期望字号（rpx），默认 30
 * @returns {{shiftPx:number, fontRpx:number, scaled:boolean, truncated:boolean,
 *            availPx:number, capsuleLeft:number, style:string}}
 */
function computeNavTitle(opts) {
  const o = opts || {}
  const screenW = Number(o.screenW) > 0 ? Number(o.screenW) : 375
  const rpx = screenW / 750
  const text = String(o.text == null ? '' : o.text)
  let fontRpx = Number(o.fontRpx) > 0 ? Number(o.fontRpx) : FONT_RPX

  const iconRightPx = ICON_RIGHT_RPX * rpx
  const gapPx = GAP_RPX * rpx
  const capsuleLeft = Number(o.capsuleLeft) > 0
    ? Number(o.capsuleLeft)
    : screenW - CAPSULE_RIGHT_PX - CAPSULE_WIDTH_PX

  // 视觉中心 = 图标右缘 与 胶囊左缘 的中点
  const midPx = (iconRightPx + capsuleLeft) / 2
  let shiftPx = screenW / 2 - midPx
  if (!(shiftPx > 0.5)) shiftPx = 0

  // 溢出护栏：可用宽度 = 胶囊左缘 − 图标右缘 − 两侧安全间距
  const availPx = (capsuleLeft - gapPx) - (iconRightPx + gapPx)
  let scaled = false
  let truncated = false
  if (availPx > 0) {
    const estPx = estimateTextWidthRpx(text, fontRpx) * rpx
    if (estPx > availPx) {
      fontRpx = Math.max(MIN_FONT_RPX, Math.floor(fontRpx * availPx / estPx))
      scaled = true
      if (estimateTextWidthRpx(text, fontRpx) * rpx > availPx) truncated = true
    }
  }

  const parts = []
  if (shiftPx > 0.5) parts.push('margin-left: -' + shiftPx.toFixed(1) + 'px')
  if (scaled) parts.push('font-size: ' + fontRpx + 'rpx')
  if (truncated) {
    parts.push('max-width: ' + Math.floor(availPx / rpx) + 'rpx')
    parts.push('overflow: hidden')
    parts.push('text-overflow: ellipsis')
    parts.push('white-space: nowrap')
  }

  return {
    shiftPx: shiftPx,
    fontRpx: fontRpx,
    scaled: scaled,
    truncated: truncated,
    availPx: availPx,
    capsuleLeft: capsuleLeft,
    style: parts.join(';')
  }
}

module.exports = {
  ICON_RIGHT_RPX: ICON_RIGHT_RPX,
  GAP_RPX: GAP_RPX,
  FONT_RPX: FONT_RPX,
  MIN_FONT_RPX: MIN_FONT_RPX,
  estimateTextWidthRpx: estimateTextWidthRpx,
  computeNavTitle: computeNavTitle
}
