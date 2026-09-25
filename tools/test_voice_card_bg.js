// [voice-card-bg v1] 测试：语音识别中卡片背景必须为实心档（防深色下 10% 透明近乎隐身）
// 红灯判据：旧源码（background: var(--brand-tint-08)）下 3 条全红；新源码全绿。
// 用法：node tools/test_voice_card_bg.js
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0

function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('PASS ' + name)
  } else {
    fail++
    console.log('FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''))
  }
}

// 取规则块：从选择器出现处到下一个 '}'（含）
function blockOf(css, selector) {
  const i = css.indexOf(selector)
  if (i === -1) return null
  const end = css.indexOf('}', i)
  if (end === -1) return null
  return css.slice(i, end + 1)
}

const PAGES = [
  'pages/write/write.wxss',
  'pages/detail/detail.wxss',
  'pages/archive/archive.wxss',
]

for (const rel of PAGES) {
  const p = path.join(ROOT, rel)
  const css = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')
  const tag = rel.split('/')[1]

  const block = blockOf(css, '.voice-card-processing {')
  check(tag + ' vc-1 .voice-card-processing 规则存在', !!block, block)

  if (block) {
    check(
      tag + ' vc-2 背景为实心档 --brand-soft（非 tint-08 半透明）',
      block.indexOf('background: var(--brand-soft)') !== -1 &&
        block.indexOf('--brand-tint-08') === -1,
      block
    )
    check(
      tag + ' vc-3 保留 2rpx 描边（状态区分）',
      block.indexOf('border: 2rpx solid var(--brand-shadow-20)') !== -1,
      block
    )
  }

  // 结构护栏：卡片基础类仍存在（选择器没被误删）
  check(tag + ' vc-4 .voice-card 基础规则存在', css.indexOf('.voice-card {') !== -1)
}

console.log('TOTAL: pass ' + pass + ', fail ' + fail)
process.exit(fail ? 1 : 0)
