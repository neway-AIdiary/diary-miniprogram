// test_mood_capsule.js —— [mood-capsule v1] detail 编辑态心情栏并入标题行
// 静态断言：wxml 结构 / wxss 样式 / js 数据与高度计算；guard 断言保护 write 页与阅读态不受影响
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + msg) }
  else { fail++; console.log('  FAIL- ' + msg) }
}
// 取规则块（坑 8：断言不含 \n 字面串，先取块再在块内 indexOf）
function blockOf(text, startMarker) {
  const i = text.indexOf(startMarker)
  if (i === -1) return ''
  const end = text.indexOf('}', i)
  return text.slice(i, end === -1 ? i + 300 : end + 1)
}

const wxml = read('pages/detail/detail.wxml')
const wxss = read('pages/detail/detail.wxss')
const js = read('pages/detail/detail.js')
const writeWxml = read('pages/write/write.wxml')
const srWxml = read('pages/summary-result/summary-result.wxml')

console.log('--- A. detail.wxml 编辑态结构 ---')
// A1 心情栏旧结构清零（精确到类名，坑 7）
ok(wxml.indexOf('class="section section-mood"') === -1, 'mc-1 旧心情栏 section-mood 清零')
ok(wxml.indexOf('class="mood-bar"') === -1 && wxml.indexOf('mood-bar-hover') === -1, 'mc-2 mood-bar 结构清零')
ok(wxml.indexOf('class="mood-label"') === -1 && wxml.indexOf('class="mood-value') === -1, 'mc-3 mood-label/mood-value 清零')
ok(wxml.indexOf('class="mood-arrow') === -1, 'mc-4 mood-arrow 清零')
ok(wxml.indexOf('可选，点击选择') === -1, 'mc-5 旧占位文案清零')
// A2 新结构
ok(wxml.indexOf('class="title-row"') !== -1, 'mc-6 标题行 title-row 存在')
const rowI = wxml.indexOf('class="title-row"')
const rowEnd = wxml.indexOf('</view>', wxml.indexOf('mood-pill', rowI))
const rowSeg = rowI === -1 ? '' : wxml.slice(rowI, rowEnd)
ok(rowSeg.indexOf('edit-title-input') !== -1 && rowSeg.indexOf('class="mood-pill"') !== -1,
  'mc-7 标题行内含标题输入 + 心情胶囊')
ok(wxml.indexOf('catchtap="toggleMoodPicker"') !== -1, 'mc-8 胶囊点击开选择器')
ok(wxml.indexOf("moodColor || '#999999'") !== -1 && wxml.indexOf("moodBg || 'rgba(0,0,0,0.06)'") !== -1,
  'mc-9 胶囊内联色与写字页同款兜底')
ok(wxml.indexOf("moodLabel ? moodLabel : '心情'") !== -1, 'mc-10 无心情显示灰底「心情」')
// A3 选项组保留（内联展开，方案①）
ok(wxml.indexOf('class="mood-options" wx:if="{{showMoodPicker}}"') !== -1, 'mc-11 选项组保留且条件展开')
ok(wxml.indexOf('bindtap="selectMood"') !== -1 && wxml.indexOf('{{moodOptions}}') !== -1, 'mc-12 选项数据源不变')
// A4 阅读态不受影响
ok(wxml.indexOf('class="tag-mood"') !== -1, 'mc-13 阅读态心情标签保留')

console.log('--- B. detail.wxss 样式 ---')
ok(wxss.indexOf('.section-mood') === -1, 'mc-14 section-mood 选择器清零')
const st = blockOf(wxss, '.section-title {')
ok(st.indexOf('flex-shrink: 0;') !== -1 && st.indexOf('border-bottom') !== -1, 'mc-15 标题区保留分隔线')
ok(st.indexOf('padding-bottom: 12rpx;') !== -1, 'mc-15a 分隔线上移（padding-bottom 12rpx）')
ok(wxss.indexOf('.mood-bar') === -1 && wxss.indexOf('.mood-value') === -1 &&
   wxss.indexOf('.mood-arrow') === -1 && wxss.indexOf('.mood-label') === -1, 'mc-16 心情栏旧样式清零')
const tr = blockOf(wxss, '.title-row {')
ok(tr.indexOf('display: flex;') !== -1 && tr.indexOf('align-items: center;') !== -1, 'mc-17 标题行 flex 布局')
const ti = blockOf(wxss, '.title-row .edit-title-input {')
ok(ti.indexOf('flex: 1;') !== -1 && ti.indexOf('min-width: 0;') !== -1,
  'mc-18 标题输入占剩余宽度且可收缩（长标题不顶胶囊）')
ok(ti.indexOf('height: 60rpx;') !== -1 && ti.indexOf('padding: 0;') !== -1,
  'mc-18a 输入高度收成 60rpx 贴文字行（与胶囊中心对齐）')
const mp = blockOf(wxss, '.mood-pill {')
ok(mp.indexOf('border-radius: 30rpx;') !== -1 && mp.indexOf('padding: 10rpx 22rpx;') !== -1 &&
   mp.indexOf('font-size: 24rpx;') !== -1 && mp.indexOf('flex-shrink: 0;') !== -1,
  'mc-19 胶囊与写字页同款关键属性')
ok(wxss.indexOf('class="mood-options"') === -1 && blockOf(wxss, '.mood-options {').indexOf('flex-wrap: wrap;') !== -1,
  'mc-20 选项组样式保留')
ok(wxss.indexOf('#fff') === -1 || blockOf(wxss, '.mood-pill {').indexOf('#fff') === -1,
  'mc-21 胶囊无写死白字（主题 lint）')

console.log('--- C. detail.js 数据与高度 ---')
ok(js.indexOf('moodColor: diary.mood ? util.getMoodColor(diary.mood)') !== -1 &&
   js.indexOf('moodBg: diary.mood ? util.getMoodBg(diary.mood)') !== -1,
  'mc-22 编辑载入补 moodColor/moodBg')
ok(js.indexOf("mood: '', moodLabel: '', moodColor: '', moodBg: ''") !== -1,
  'mc-23 selectMood「不选」分支清色值')
ok(js.indexOf('moodColor: util.getMoodColor(key)') !== -1 &&
   js.indexOf('moodBg: util.getMoodBg(key)') !== -1,
  'mc-24 selectMood 正常分支带色值')
ok(js.indexOf('const fixedRpx = 260') !== -1 && js.indexOf('[mood-capsule v1') !== -1,
  'mc-25 fixedRpx 收紧至 260 且带标记注释')
ok(js.indexOf('const fixedRpx = 380') === -1 && js.indexOf('const fixedRpx = 290') === -1,
  'mc-26 旧 380/290 值清零')

console.log('--- D. guard：无关页面不受影响 ---')
ok(writeWxml.indexOf('class="mood-pill"') !== -1 && writeWxml.indexOf('mood-picker') !== -1,
  'mc-27 写字页胶囊与浮层选择器原样')
ok(srWxml.indexOf('mood') === -1, 'mc-28 总结结果页阅读态无心情结构（编辑入口本就跳 detail）')

console.log('\nSUITES 1, PASS ' + pass + ', FAIL ' + fail)
process.exit(fail ? 1 : 0)
