/**
 * [edit-card-fill v1] 详情编辑页卡片撑满 + 固定间距 回归测试（纯 Node，无需小程序环境）
 *
 * 背景：日记详情编辑页「编辑框下边 ↔ 取消/保存按钮上边」的间距随内容长度漂移
 * （.edit-area 原来是 flex: 0 1 auto，剩余空白全被 .edit-actions 的 margin-top:auto
 *  吃进「卡片和按钮之间」）。修法：卡片改 flex: 1 1 auto + min-height: 0，
 *  剩余空间给卡片自己，间距固定为 margin-bottom: 20rpx。
 *
 * 守护 4 件事：
 *  1) 新口径落地：flex: 1 1 auto / min-height: 0 / margin-bottom: 20rpx 都在 .edit-area 块内
 *  2) 旧口径消失：.edit-area 块内不再有 flex: 0 1 auto
 *  3) 别把人家的东西碰坏：190rpx 底部对齐、.edit-actions 的 margin-top: auto、
 *     textarea 高度口径（min 330rpx / max 60vh）、scrollMaxHeight 内联接线都在
 *  4) 两个入口共用同一页面：summary-result 的编辑跳转仍指向 detail?edit=1（间距统一的前提）
 *
 * 用法：node tools/test_edit_fill.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const lines = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    lines.push('  ✓ ' + name)
  } else {
    fail++
    lines.push('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function section(title) {
  lines.push('')
  lines.push('[' + title + ']')
}

// 取某个选择器块的内容（从「selector {」到配对「}」，wxss 无嵌套，取到下一个「}」即可）
function block(css, selector) {
  const i = css.indexOf(selector + ' {')
  if (i < 0) return null
  const start = i + selector.length + 2
  const end = css.indexOf('}', start)
  return end < 0 ? null : css.slice(start, end)
}

// ---------- 1. 新口径落地 ----------
section('新口径：.edit-area 撑满 + 固定间距')
const wxss = read('pages/detail/detail.wxss')
const area = block(wxss, '.edit-area')
ok('.edit-area 块存在', area !== null)
ok('.edit-area 是 flex: 1 1 auto（撑满可用高度）',
  !!area && area.indexOf('flex: 1 1 auto') >= 0, area && area.trim().slice(0, 120))
ok('.edit-area 有 min-height: 0（长内容可按 flex 收缩）',
  !!area && area.indexOf('min-height: 0') >= 0)
ok('.edit-area 有固定 margin-bottom: 20rpx（卡片底↔按钮顶的统一间距）',
  !!area && area.indexOf('margin-bottom: 20rpx') >= 0)
ok('.edit-area 不再是 flex: 0 1 auto（旧口径：缝隙 = 屏幕剩余空白）',
  !!area && area.indexOf('flex: 0 1 auto') < 0)

// ---------- 2. 别碰坏既有对齐关系 ----------
section('护栏：既有对齐与滚动口径不变')
const page = block(wxss, '.edit-page')
ok('.edit-page 底留白仍是 190rpx（按钮底与写日记页对齐）',
  !!page && page.indexOf('padding-bottom: 190rpx') >= 0, page && page.trim().slice(0, 120))
const actions = block(wxss, '.edit-actions')
ok('.edit-actions 的 margin-top: auto 保留（margin: auto 24rpx 0，无剩余空间后自然失效）',
  !!actions && actions.indexOf('margin: auto 24rpx 0') >= 0,
  actions && actions.trim().slice(0, 120))
const field = block(wxss, '.edit-area .textarea-field')
ok('textarea 最小高度口径不变（min-height: 330rpx）',
  !!field && field.indexOf('min-height: 330rpx') >= 0)
ok('textarea 最大高度口径不变（max-height: 60vh）',
  !!field && field.indexOf('max-height: 60vh') >= 0)
const wxml = read('pages/detail/detail.wxml')
ok('滚动上限接线仍在（scroll-view 内联 max-height: scrollMaxHeight）',
  wxml.indexOf('max-height: {{scrollMaxHeight}}px') >= 0)
ok('按钮接线不变（取消 cancelEdit / 保存 saveEdit）',
  wxml.indexOf('bindtap="cancelEdit"') >= 0 && wxml.indexOf('bindtap="saveEdit"') >= 0)

// ---------- 3. 两个入口共用同一页面 ----------
section('统一间距的前提：AI 总结编辑仍复用详情编辑页')
const srJs = read('pages/summary-result/summary-result.js')
ok('summary-result 编辑跳 detail?edit=1',
  srJs.indexOf('/pages/detail/detail?id=') >= 0 && srJs.indexOf('&edit=1') >= 0)

// ---------- 输出 ----------
lines.push('')
lines.push('通过 ' + pass + ' / 失败 ' + fail)
console.log(lines.join('\n'))
process.exit(fail ? 1 : 0)
