/**
 * 单元测试：[voice-clearall-v1] 语音「清空全部」指令（2026-09-24）
 * 1. aiEdit.matchClearAll：规则化识别（用户 8 条原话 + 变体 + 叙述反例）
 * 2. write.js 接线：processInput 挂钩位置 / 撤销逻辑 / 定时器清理
 * 3. wxml / wxss：撤销条元素与样式
 * 4. 护栏：指令引擎旧入口不回归
 */
const path = require('path')
const fs = require('fs')

const base = path.resolve(__dirname, '..')
const aiEdit = require(path.join(base, 'utils/aiEdit.js'))

let pass = 0, fail = 0
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) { pass++ } else { fail++; console.log('FAIL:', name, '\n  actual:', JSON.stringify(actual), '\n  expect:', JSON.stringify(expect)) }
}

// 红灯守卫：旧源码无 matchClearAll 时精准变红、零崩溃
const hasMatch = typeof aiEdit.matchClearAll === 'function'
check('ca-0 matchClearAll 已导出', hasMatch, true)
function mca(text) { return hasMatch ? aiEdit.matchClearAll(text) : 'N/A' }

/* ===== 1. 用户给的 8 条原话 ===== */
check('ca-1 删除所有内容', mca('删除所有内容'), true)
check('ca-2 删掉所有内容', mca('删掉所有内容'), true)
check('ca-3 去掉所有内容', mca('去掉所有内容'), true)
check('ca-4 清空所有内容', mca('清空所有内容'), true)
check('ca-5 删除所有文字', mca('删除所有文字'), true)
check('ca-6 删掉所有文字', mca('删掉所有文字'), true)
check('ca-7 去掉所有文字', mca('去掉所有文字'), true)
check('ca-8 清空所有文字', mca('清空所有文字'), true)

/* ===== 2. 常见变体（规则化覆盖，不逐条枚举） ===== */
check('ca-9 变体「全部删除」', mca('全部删除'), true)
check('ca-10 变体「把内容全部清空」', mca('把内容全部清空'), true)
check('ca-11 变体「清空全部内容」', mca('清空全部内容'), true)
check('ca-12 混合句「今天很累，删除所有内容」', mca('今天很累，删除所有内容'), true)
check('ca-13 带语气词「删除所有内容吧」', mca('删除所有内容吧'), true)

/* ===== 3. 叙述反例（不触发清空） ===== */
check('ca-14 跨句不触发「删除了。所有内容都很好」', mca('删除了。所有内容都很好'), false)
check('ca-15 无对象词「删除了所有错别字」', mca('删除了所有错别字'), false)
check('ca-16 无对象词「删除所有烦恼」', mca('删除所有烦恼'), false)
check('ca-17 普通叙述「今天写了很多内容」', mca('今天写了很多内容'), false)
check('ca-18 无动词「所有内容都很好」', mca('所有内容都很好'), false)
check('ca-19 空串', mca(''), false)
check('ca-20 无关句「把开心删掉」', mca('把开心删掉'), false)

/* ===== 4. write.js 接线（静态断言） ===== */
const wjs = fs.readFileSync(path.join(base, 'pages/write/write.js'), 'utf8')
check('ca-21 processInput 挂钩存在', wjs.indexOf('this.tryClearAll(trimmed)') !== -1, true)
check('ca-22 挂钩早于备案名词匹配（清空优先）',
  wjs.indexOf('this.tryClearAll(trimmed)') < wjs.indexOf('matchInfo = nameMatch.matchArchives(trimmed'), true)
check('ca-23 撤销处理函数存在', wjs.indexOf('onClearAllUndo() {') !== -1, true)
check('ca-24 撤销缓冲保存旧正文', wjs.indexOf('this._clearAllUndo = prev') !== -1, true)
check('ca-25 撤销定时器 5 秒收起', wjs.indexOf('this._clearAllTimer = setTimeout(') !== -1 && wjs.indexOf('}, 5000)') !== -1, true)
check('ca-26 onUnload 清理定时器',
  /onUnload\(\) \{[\s\S]{0,200}?if \(this\._clearAllTimer\)/.test(wjs), true)
check('ca-27 恢复走 _setContent（单一入口纪律）', wjs.indexOf('this._setContent(prev)') !== -1, true)
check('ca-28 命中后吞掉指令不写正文', /tryClearAll\(text\) \{[\s\S]*?this\._setContent\(''\)[\s\S]*?return true/.test(wjs), true)

/* ===== 5. wxml / wxss：撤销条 ===== */
const wxml = fs.readFileSync(path.join(base, 'pages/write/write.wxml'), 'utf8')
check('ca-29 撤销条元素与点击处理', wxml.indexOf('clear-undo-bar') !== -1 && wxml.indexOf('onClearAllUndo') !== -1, true)
check('ca-30 撤销条文案', wxml.indexOf('已清空全部内容') !== -1 && wxml.indexOf('撤销') !== -1, true)
const wxss = fs.readFileSync(path.join(base, 'pages/write/write.wxss'), 'utf8')
check('ca-31 撤销条样式（绝对定位浮层不挤压布局）', wxss.indexOf('.clear-undo-bar {') !== -1 && wxss.indexOf('bottom: 100%') !== -1, true)
check('ca-32 撤销按钮高亮样式', wxss.indexOf('.clear-undo-btn {') !== -1, true)

/* ===== 6. 护栏：指令引擎旧入口不回归 ===== */
check('ca-33 旧入口 detect/splitCommands 未动', typeof aiEdit.detect === 'function' && typeof aiEdit.splitCommands === 'function' && typeof aiEdit.apply === 'function', true)

console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
if (fail > 0) process.exit(1)
