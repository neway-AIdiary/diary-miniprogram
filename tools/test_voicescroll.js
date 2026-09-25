// [voice-scroll v1] 智能总结页录音弹窗：识别文本自动滚到底
// 锁三件事：wxml 绑定 scroll-top；js data 声明；js 更新回调里量高推底（含守卫与只增不减）
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + ' | ' + (extra || '')) }
}

const wxml = fs.readFileSync(path.join(ROOT, 'pages/summary/summary.wxml'), 'utf8')
const js = fs.readFileSync(path.join(ROOT, 'pages/summary/summary.js'), 'utf8')

check('vs-1 wxml 弹窗文本容器绑定 scroll-top',
  wxml.indexOf('scroll-top="{{voiceScrollTop}}"') !== -1)
check('vs-2 wxml 弹窗 scroll-view 结构保留',
  wxml.indexOf('<scroll-view class="voice-text-scroll"') !== -1)
check('vs-3 js data 声明 voiceScrollTop',
  js.indexOf('voiceScrollTop: 0') !== -1)
check('vs-4 js 更新回调量文本与视口高度',
  js.indexOf("q.select('.voice-text')") !== -1 &&
  js.indexOf("q.select('.voice-text-scroll')") !== -1)
check('vs-5 js 守卫：无文本或无 API 时不查询',
  js.indexOf('if (!s.liveText || !wx.createSelectorQuery) return') !== -1)
check('vs-6 js 只增不减：差值不大于当前值就不 setData',
  js.indexOf('top > (this.data.voiceScrollTop || 0)') !== -1)

console.log('TOTAL ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
