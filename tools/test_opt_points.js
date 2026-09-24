/**
 * tools/test_opt_points.js
 * [opt-points-scroll v2] AI优化「要点框」安卓半行裁切修复（第二步）回归套件。
 *
 * 背景：第一步（234rpx 静态行栅格预算）在安卓真机上仍露半行 —— 静态预算依赖
 * 「每行真实渲染高度 == 46rpx」的假设，安卓 WebView 字体度量/取整差异会让
 * 实际行高偏离预算。第二步改为运行时实测，不再赌静态数值：
 *   - 探针节点（继承要点正文同款字体/行高）渲染后实测一行真实高度
 *   - 内联 px 把内层滚动区上限钉在恰好 4 行（Math.floor 防残影）
 *   - 裁切只发生在无内边距的内层滚动区，盒模型口径不再影响裁切结果
 *
 * 覆盖：
 *   A. wxml 结构（探针 / 滚动区 / 实测 px 绑定 / 层级顺序）
 *   B. wxss（旧静态总预算移除 / 内层滚动区兜底 / 探针隐藏 / 正文度量未动）
 *   C. write.js（data 字段 / 实测方法 / 四个展示入口全部挂测量回调）
 *
 * 运行：node tools/test_opt_points.js（全绿退出码 0）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
// 工程文件是 CRLF ⇒ 统一转 LF 后再做含换行的串断言（否则恒不命中、假红）
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else {
    fail++
    console.log('  FAIL ' + msg + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''))
  }
}

// 提取某条规则块（从选择器到最近的 '}'），实现缺失时返回空串 ⇒ 断言自然失败不崩溃
const blockOf = (css, name) => {
  const i = css.indexOf(name)
  if (i < 0) return ''
  const j = css.indexOf('}', i)
  return j < 0 ? '' : css.slice(i, j + 1)
}

const wxml = read('pages/write/write.wxml')
const wxss = read('pages/write/write.wxss')
const js = read('pages/write/write.js')

console.log('\n== A. wxml 结构 ==')
ok(wxml.indexOf('class="opt-point opt-point-probe"') > 0, 'A1 探针节点存在（继承要点正文样式）')
ok(wxml.indexOf('class="opt-points-scroll"') > 0, 'A2 内层滚动区存在')
ok(wxml.indexOf("'max-height:' + optPointsScrollH + 'px'") > 0,
  'A3 滚动区上限走实测 px 内联绑定（optPointsScrollH）')
const iT = wxml.indexOf('class="opt-points-title"')
const iP = wxml.indexOf('opt-point-probe')
const iS = wxml.indexOf('class="opt-points-scroll"')
const iF = wxml.indexOf('wx:for="{{optimizeChanges}}"')
ok(iT > 0 && iT < iP && iP < iS && iS < iF,
  'A4 层级顺序：标题 → 探针 → 滚动区 → 要点遍历（要点在滚动区内）')
ok(wxml.indexOf('aria-hidden="true"') > 0, 'A5 探针对辅助功能隐藏')
ok(wxml.indexOf('class="opt-points" wx:if="{{optimizeChanges.length > 0}}"') > 0,
  'A6 卡片判空入口未动')

console.log('\n== B. wxss ==')
ok(wxss.indexOf('max-height: 234rpx') < 0, 'B1 旧静态总预算（234rpx）已移除')
const sc = blockOf(wxss, '.opt-points-scroll {')
ok(sc.length > 0, 'B2 内层滚动区规则存在')
ok(sc.indexOf('overflow-y: auto') >= 0, 'B3 滚动区可滚动（条目多时内部滚动）')
ok(sc.indexOf('max-height: 184rpx') >= 0, 'B4 静态兜底 4 行（测量未完成的首帧）')
const pr = blockOf(wxss, '.opt-point-probe {')
ok(pr.indexOf('position: absolute') >= 0 && pr.indexOf('visibility: hidden') >= 0,
  'B5 探针绝对定位且不可见（不影响布局）')
const op = blockOf(wxss, '.opt-points {')
ok(op.indexOf('position: relative') >= 0, 'B6 卡片为探针定位基准')
ok(op.length > 0 && op.indexOf('max-height') < 0,
  'B7 外层卡片不再裁切（裁切只发生在无内边距的内层）')
const pt = blockOf(wxss, '.opt-point {')
ok(pt.indexOf('line-height: 46rpx') >= 0 && pt.indexOf('font-size: 26rpx') >= 0,
  'B8 正文行高/字号未动（探针继承同一度量）')

console.log('\n== C. write.js ==')
ok(js.indexOf('optPointsScrollH: 0,') > 0, 'C1 data 含实测高度字段（0 = 未测量，走 wxss 兜底）')
ok(js.indexOf('measureOptPoints() {') > 0, 'C2 实测方法已定义')
const mi = js.indexOf('measureOptPoints() {')
const mEnd = js.indexOf('onOptimizedInput', mi)
const mbody = (mi >= 0 && mEnd > mi) ? js.slice(mi, mEnd) : ''
ok(mbody.indexOf('createSelectorQuery') >= 0 && mbody.indexOf('.opt-point-probe') >= 0,
  'C3 实测走选择器查探针节点')
ok(mbody.indexOf('Math.floor(rect.height * 4)') >= 0,
  'C4 高度 = 一行实测高 × 4（floor 防第五行残影）')
ok(mbody.indexOf('!(rect.height > 0)') >= 0, 'C5 测量失败安全早退（不写脏值）')
const cbCount = js.split('() => this.measureOptPoints())').length - 1
ok(cbCount === 4, 'C6 四个要点展示入口全部挂测量回调', cbCount)
ok(js.indexOf('.concat(opts.extraNotes || []),\n        showOriginal: false\n      }, () => this.measureOptPoints())') > 0,
  'C7 主润色入口已挂')
ok(js.indexOf('concat(opts.notes || []),\n      showOriginal: false\n    }, () => this.measureOptPoints())') > 0,
  'C8 统一兜底入口（showOptimizeFallback）已挂')
ok(js.indexOf('notes.concat(note ? [note] : []),\n        showOriginal: false\n      }, () => this.measureOptPoints())') > 0,
  'C9 素材补全入口已挂')
ok(js.indexOf("已展示现有文字，可直接编辑']),\n            showOriginal: false\n          }, () => this.measureOptPoints())") > 0,
  'C10 补全失败兜底入口已挂')
ok(js.indexOf('optimizeChanges: [],\n    optPointsScrollH: 0,') > 0,
  'C11 字段紧邻 optimizeChanges（清空面板时互不干扰）')

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
