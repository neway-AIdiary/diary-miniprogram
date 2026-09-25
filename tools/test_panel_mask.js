/* test_panel_mask.js —— [panel-mask v1] 底栏面板透明遮罩（静态断言套件）
 * 用户指令（2026-09-25）：表情/+ 面板展开时点击其他区域收起；档案页不改（拍板 1）。
 * 红灯自检口径：--restore-src 只还原 app.wxss/write.wxml/detail.wxml（本套件不随之回退）。
 */
const path = require('path')
const fs = require('fs')
const base = path.join(__dirname, '..')

let pass = 0, fail = 0
function check(name, actual, expect) {
  const ok = actual === expect
  if (ok) pass++; else { fail++; console.log('FAIL: ' + name + '\n  actual: ' + actual + '\n  expect: ' + expect) }
}

const appWxss = fs.readFileSync(path.join(base, 'app.wxss'), 'utf8')
const writeWxml = fs.readFileSync(path.join(base, 'pages/write/write.wxml'), 'utf8')
const detailWxml = fs.readFileSync(path.join(base, 'pages/detail/detail.wxml'), 'utf8')
const writeWxss = fs.readFileSync(path.join(base, 'pages/write/write.wxss'), 'utf8')
const detailWxss = fs.readFileSync(path.join(base, 'pages/detail/detail.wxss'), 'utf8')
const archiveWxml = fs.readFileSync(path.join(base, 'pages/archive/archive.wxml'), 'utf8')

/* ===== A. 共用遮罩类 ===== */
check('pm-1 app.wxss 定义 .panel-mask', appWxss.indexOf('.panel-mask {') !== -1, true)
const pmBlock = appWxss.slice(appWxss.indexOf('.panel-mask {'), appWxss.indexOf('.panel-mask {') + 200)
check('pm-2 遮罩 fixed 全屏', pmBlock.indexOf('position: fixed') !== -1, true)
check('pm-3 遮罩透明（不改变 UI 观感）', pmBlock.indexOf('background: transparent') !== -1, true)
check('pm-4 遮罩 z-index 29（低于底栏 30）', pmBlock.indexOf('z-index: 29') !== -1, true)

/* ===== B. 写字页挂点 ===== */
check('pm-5 write.wxml 有 panel-mask 且 catchtap 收起',
  writeWxml.indexOf('class="panel-mask"') !== -1 && writeWxml.indexOf('catchtap="closeAllPanels"') !== -1, true)
check('pm-6 write 遮罩条件覆盖表情+添加两个面板',
  writeWxml.indexOf("wx:if=\"{{showEmojiPanel || showAddPanel}}\"") !== -1, true)
check('pm-7 write 遮罩在底部固定区之外（页面级兄弟节点）',
  writeWxml.indexOf('panel-mask') < writeWxml.indexOf('底部固定区：面板 + 输入栏，面板展开时压盖编辑区/AI优化·保存按钮'), true)
check('pm-8 write 底栏容器 z 30（遮罩不盖底栏与面板）', /z-index: 30/.test(writeWxss), true)

/* ===== C. 详情页挂点 ===== */
check('pm-9 detail.wxml 有 panel-mask 且 catchtap 收起',
  detailWxml.indexOf('class="panel-mask"') !== -1 && detailWxml.indexOf('catchtap="closeAllPanels"') !== -1, true)
check('pm-10 detail 遮罩条件覆盖两个面板',
  detailWxml.indexOf("wx:if=\"{{showEmojiPanel || showAddPanel}}\"") !== -1, true)
check('pm-11 detail 底栏容器 z 30', /z-index: 30/.test(detailWxss), true)

/* ===== D. 拍板 1：档案页不改 ===== */
check('pm-12 archive.wxml 不加遮罩（用户拍板）', archiveWxml.indexOf('panel-mask') === -1, true)

/* ===== E. 现有收起方式保留（按钮 toggle 不动） ===== */
check('pm-13 write 按钮 toggle 保留', writeWxml.indexOf('bindtap="toggleEmojiPanel"') !== -1, true)
check('pm-14 detail 按钮 toggle 保留', detailWxml.indexOf('bindtap="toggleEmojiPanel"') !== -1, true)

console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
process.exit(fail > 0 ? 1 : 0)
