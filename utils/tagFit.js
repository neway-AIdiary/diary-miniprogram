/**
 * utils/tagFit.js
 * [tag-fit v1] 日记本列表卡片「心情 + 标签」两行自适应。
 *
 * 背景：.tag-list 是 flex-wrap 且行数无上限，标签一多一长就撑到三行，
 *   把 .diary-card-footer（align-items:center）的日期挤到卡片中间，卡片也被撑高。
 *
 * 口径（用户拍板 · 方案 3）：
 *   - 只在「估算会溢出到第三行」时才动手；平时一行就一行，一个都不丢；
 *   - 溢出时从**末尾**丢标签，直到剩余能保证两行；
 *   - **保底留 1 个**（单 chip 是 nowrap + ellipsis，最多占一行，天然安全）；
 *   - 日期保持横排不竖排，宽度靠「8/12 周三」这种紧凑文案腾出来。
 *
 * 纯函数、不依赖 wx、不逐卡测量：宽度用静态估算，系数刻意**偏保守**
 * （宁可多丢一个，也不能漏成三行）。样式改了必须同步本文件的宽度常量。
 */

// 宽度口径（rpx）—— 与 pages/index/index.wxss 的盒模型一一对应
const W = {
  viewport: 750,
  listPadX: 24,      // .diary-list   padding 左右
  cardPadL: 36,      // .diary-card   padding-left
  cardPadR: 32,      // .diary-card   padding-right
  dateWidth: 108,    // .diary-date 「8/12 周三」@24rpx（含 letter-spacing 余量）
  moodGapL: 24,      // .tag-list     margin-left
  moodFont: 22,      // .tag-mood     font-size
  moodPadX: 16,      // .tag-mood     padding 左右
  chipFont: 22,      // .tag-item     font-size
  chipPadX: 16,      // .tag-item     padding 左右
  chipBorderX: 2,    // .tag-item     左右边框各 1rpx
  chipGapR: 12,      // .tag-item     margin-right
  asciiRatio: 0.6,   // 数字/字母宽 ≈ 0.6em（中文/全角按 1em）
  safety: 1.06,      // 保守系数
}

const MAX_LINES = 2

// 卡片内容宽 = 750 − 列表左右 padding − 卡片左右 padding = 634rpx
function cardInnerWidth() {
  return W.viewport - W.listPadX * 2 - W.cardPadL - W.cardPadR
}

// 文本估算宽（rpx）：ASCII 按 asciiRatio em、其余按 1em。
// 用 charCodeAt 逐码元判断（不走正则转义），代理对会算 2 个中文宽 ⇒ 偏保守，符合本模块取向。
function textWidth(text, fontRpx) {
  const s = String(text == null ? '' : text)
  let units = 0
  for (let i = 0; i < s.length; i++) {
    units += s.charCodeAt(i) < 256 ? W.asciiRatio : 1
  }
  return units * fontRpx
}

// 单个标签 chip 占宽（含右侧间距）
function chipWidth(tag) {
  return textWidth(tag, W.chipFont) * W.safety + W.chipPadX * 2 + W.chipBorderX + W.chipGapR
}

// 心情 pill 占宽（不含与标签区之间的间距）；无心情返回 0
function moodWidth(moodLabel) {
  const s = String(moodLabel == null ? '' : moodLabel)
  if (!s) return 0
  return textWidth(s, W.moodFont) * W.safety + W.moodPadX * 2
}

// 本卡片「标签区」可用宽（rpx）
function availWidth(moodLabel) {
  let avail = cardInnerWidth() - W.dateWidth
  const mw = moodWidth(moodLabel)
  if (mw > 0) avail -= mw + W.moodGapL
  return avail
}

// 贪心装箱估算行数；末尾 chip 也计一次间距 ⇒ 偏保守
function estimateLines(tags, avail) {
  if (!tags || !tags.length) return 0
  if (avail <= 0) return tags.length
  let lines = 1
  let cur = 0
  for (let i = 0; i < tags.length; i++) {
    const w = chipWidth(tags[i])
    if (cur === 0) {
      cur = w
    } else if (cur + w <= avail) {
      cur += w
    } else {
      lines += 1
      cur = w
    }
  }
  return lines
}

/**
 * 列表卡片标签自适应：估算溢出到第 3 行时，从末尾丢到能保证两行（保底留 1 个）。
 * @param {string[]} tags      标签数组（列表侧最多 5 个）
 * @param {string}   moodLabel 心情文案（'' 表示本卡无心情 pill）
 * @return {{shown: string[], dropped: number, lines: number}}
 */
function fitTags(tags, moodLabel) {
  // 过滤空串与纯空白标签（trim 覆盖半角/全角空格）—— 它们白占宽度却看不见
  const list = (Array.isArray(tags) ? tags : []).filter(function (t) {
    return String(t == null ? '' : t).trim() !== ''
  })
  const out = { shown: list, dropped: 0, lines: 0 }
  if (!list.length) return out
  const avail = availWidth(moodLabel)
  out.lines = estimateLines(list, avail)
  if (out.lines <= MAX_LINES) return out
  let n = list.length
  while (n > 1 && estimateLines(list.slice(0, n), avail) > MAX_LINES) {
    n -= 1
  }
  out.shown = list.slice(0, n)
  out.dropped = list.length - n
  out.lines = estimateLines(out.shown, avail)
  return out
}

module.exports = {
  fitTags: fitTags,
  estimateLines: estimateLines,
  availWidth: availWidth,
  chipWidth: chipWidth,
  moodWidth: moodWidth,
  cardInnerWidth: cardInnerWidth,
  textWidth: textWidth,
  WIDTHS: W,
  MAX_LINES: MAX_LINES,
}
