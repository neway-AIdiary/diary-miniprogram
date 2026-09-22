/**
 * [dark-pill v1] 测试：深色主题下胶囊/按钮边缘可见
 * 运行：node tools/test_dark_edges.js
 *
 * 背景：用户真机（深色主题）反馈智能总结页「全部时间」胶囊边缘看不见。
 * 根因：.rp-pill / .date-pill 底色写死为浅色专用的半透明黑（rgba(0,0,0,0.06)，
 *       只在浅背景上可见），深色下与暗底几乎同色、又无描边 → 边缘消失。
 * 横展排查（全工程 wxss 写死颜色扫描 + 胶囊类清点）后修四处：
 *   ① .rp-pill        底色令牌化(--brand-tint-08) + tint-25 描边（与 shortcut-chip 同款配方）
 *   ② summary .hold-talk  加 --line 描边 + box-sizing（浅色观感不变、总高仍 80rpx）
 *   ③ write   .hold-talk  同 ②
 *   ④ write   .date-pill  清掉被末尾令牌版覆盖、永不生效的写死底色行；
 *                         令牌版描边 --line-soft → --line
 *   ⑤ write   .mood-pill  类上加 --line 描边兜底（底色走 wxml 内联）
 * 不动（横展结论）：
 *   - 各遮罩层 rgba(0,0,0,0.4~0.55)：两主题通用的蒙层，不是「边缘」
 *   - setting.wxss 色卡写死颜色：主题预览，刻意为之
 *   - shortcut-chip / tag-chip / tag-item / s-diary-keyword / generate-btn：
 *     已走令牌 + 描边或实心渐变，深色正常（只做零回归确认）
 *
 * 覆盖断言：
 *   A 组：写死浅色专用底清零（rp-pill / date-pill；mood-pill 的默认底在 wxml 内联，另查）
 *   B 组：四处描边就位（含 box-sizing 与描边档位）
 *   C 组：零回归（已正常的胶囊家族描边未被牵连、遮罩未被误改）
 */
const path = require('path')
const fs = require('fs')

const base = path.resolve(__dirname, '..')
const RPWXSS = path.join(base, 'components', 'range-picker', 'range-picker.wxss')
const SWXSS = path.join(base, 'pages', 'summary', 'summary.wxss')
const WWXSS = path.join(base, 'pages', 'write', 'write.wxss')
const WWWXML = path.join(base, 'pages', 'write', 'write.wxml')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// 取某选择器块的样式体（首个匹配；支持「.a」前缀匹配，避开 .a:active 等误取——按出现顺序取第一个）
function blockOf(css, selector) {
  const idx = css.indexOf(selector + ' {')
  if (idx === -1) return null
  const end = css.indexOf('}', idx)
  return css.slice(idx + selector.length + 2, end)
}

const rp = read(RPWXSS)
const sw = read(SWXSS)
const ww = read(WWXSS)
const wwxml = read(WWWXML)

// ============================================================
// A 组：写死浅色专用底清零
// ============================================================
{
  ok(rp.indexOf('rgba(0, 0, 0, 0.06)') === -1,
    'A1 range-picker.wxss 旧写死底色清零', rp.indexOf('rgba(0, 0, 0, 0.06)'))

  const pill = blockOf(rp, '.rp-pill')
  ok(!!pill && pill.indexOf('background: var(--brand-tint-08)') !== -1,
    'A2 .rp-pill 底色 = --brand-tint-08（令牌，两主题各有效值）', pill)
  ok(!!pill && pill.indexOf('border: 1rpx solid var(--brand-tint-25)') !== -1,
    'A3 .rp-pill 有 tint-25 描边（与 shortcut-chip 同款配方）', pill)

  // 写日记页：死色行已清（wxss 内不允许再出现该写死底）
  ok(ww.indexOf('rgba(0, 0, 0, 0.06)') === -1,
    'A4 write.wxss 旧写死底色清零（含被覆盖的死代码行）', ww.indexOf('rgba(0, 0, 0, 0.06)'))

  // mood-pill 的默认底色在 wxml 内联 style 里（CSS 治不了内联），靠 B 组描边兜底：
  ok(wwxml.indexOf('mood-pill') !== -1 &&
     wwxml.indexOf("background:{{moodBg || 'rgba(0,0,0,0.06)'}}") !== -1,
    'A5 mood-pill 内联默认底仍在 wxml（结构未动，描边兜底方案的前提）')
}

// ============================================================
// B 组：四处描边就位
// ============================================================
{
  const holdS = blockOf(sw, '.hold-talk')
  ok(!!holdS && holdS.indexOf('border: 1rpx solid var(--line)') !== -1,
    'B1 summary .hold-talk 有 --line 描边', holdS)
  ok(!!holdS && holdS.indexOf('box-sizing: border-box') !== -1,
    'B2 summary .hold-talk box-sizing（加描边后总高仍 80rpx，与生成按钮对齐）', holdS)

  const holdW = blockOf(ww, '.hold-talk')
  ok(!!holdW && holdW.indexOf('border: 1rpx solid var(--line)') !== -1 &&
     holdW.indexOf('box-sizing: border-box') !== -1,
    'B3 write .hold-talk 同款描边 + box-sizing', holdW)

  // date-pill：令牌版描边升档；前段块不再有 background（死代码已清）
  const dpUp = ww.indexOf('.date-pill {\n  background: var(--bg-soft)')
  ok(dpUp !== -1, 'B4 write .date-pill 令牌版块存在')
  if (dpUp !== -1) {
    const seg = ww.slice(dpUp, ww.indexOf('}', dpUp))
    ok(seg.indexOf('border: 1rpx solid var(--line);') !== -1 &&
       seg.indexOf('var(--line-soft)') === -1,
      'B5 write .date-pill 描边 = --line（--line-soft 已升档）', seg)
  }
  const dpFirst = blockOf(ww, '.date-pill')
  ok(!!dpFirst && dpFirst.indexOf('background:') === -1,
    'B6 write .date-pill 前段块不再自带底色（以末尾令牌版为准）', dpFirst)

  const mood = blockOf(ww, '.mood-pill')
  ok(!!mood && mood.indexOf('border: 1rpx solid var(--line)') !== -1,
    'B7 write .mood-pill 有 --line 描边兜底', mood)
}

// ============================================================
// C 组：零回归（深色下本来就正常的控件未被牵连）
// ============================================================
{
  const chip = blockOf(sw, '.shortcut-chip')
  ok(!!chip && chip.indexOf('background: var(--brand-tint-08)') !== -1 &&
     chip.indexOf('border: 1rpx solid var(--brand-tint-25)') !== -1,
    'C1 shortcut-chip 配方未被牵连', chip)

  ok(rp.indexOf('.rp-chip') !== -1 &&
     blockOf(rp, '.rp-chip').indexOf('border: 1rpx solid var(--line)') !== -1,
    'C2 弹层内 .rp-chip 描边保持不变')

  // 遮罩层通用黑色半透明未被误改（改了会同时影响两主题的蒙层观感）
  ok(rp.indexOf('background: rgba(0, 0, 0, 0.4)') !== -1,
    'C3 range-picker 弹层遮罩保持原样（两主题通用，不是病灶）')

  const gen = blockOf(sw, '.generate-btn')
  ok(!!gen && gen.indexOf('linear-gradient') !== -1,
    'C4 生成按钮实心渐变未被牵连')

  // hold-talk 的按压/录音态仍走各自的底色（描边不应改变态语义）
  const act = sw.indexOf('.hold-talk:active')
  ok(act !== -1 && sw.slice(act, sw.indexOf('}', act)).indexOf('var(--line-strong)') !== -1,
    'C5 summary .hold-talk 按压态底色保持 --line-strong')

  // 浅色专用底色只允许存在于备份目录之外的两处合法位置：无（全清）
  ok(rp.indexOf('0.06') === -1, 'A6 range-picker.wxss 全文件无 0.06 底色残留')
}

console.log('pass=%d fail=%d', pass, fail)
process.exit(fail ? 1 : 0)
