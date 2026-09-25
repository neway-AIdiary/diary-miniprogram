/**
 * [summary-nudge v1] 智能总结引导测试
 * A. 行为测试（wx 桩 + 真实 storage 模块）：阈值判断 / mute / anchor 刷新 / 置标志 / 弹窗两档
 * B. 静态断言：write.js 导入串行弹窗 + afterSaveNavigate 置标志；detail.js onShow 消费；summary.js 刷锚点
 */
const path = require('path')
const fs = require('fs')

// wx 桩：内存存储 + 可捕获的 showModal / navigateTo
const store = {}
let modalOpts = null
let navUrl = null
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  showModal: (opts) => { modalOpts = opts },
  navigateTo: (opts) => { navUrl = opts && opts.url }
}

const base = path.resolve(__dirname, '..')
const storage = require(path.join(base, 'utils/storage.js'))
const sn = require(path.join(base, 'utils/summaryNudge.js'))

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + ' | ' + (extra || '')) }
}
function resetState() {
  delete store[sn.ANCHOR_KEY]
  delete store[sn.MUTE_KEY]
  modalOpts = null
  navUrl = null
  // globalApp 由用例自建
}

// storage.getAllDiaries 打桩为可控篇数（summaryNudge 内部调用同一模块实例）
let fakeCount = 0
const realGetAll = storage.getAllDiaries
storage.getAllDiaries = () => { const a = realGetAll(); return a.length ? a : new Array(fakeCount) }

/* ===== A. 行为测试 ===== */

// A1 无 anchor（从没用过智能总结）：> 10 就提示（2026-09-25 拍板：首用阈值 10，与复用增量 20 分开）
resetState(); fakeCount = 10
check('sn-1a 无anchor 10篇不提示(首用阈值>10)', sn.shouldPrompt(10) === false)
check('sn-1a2 阈值常量', sn.FIRST_NUDGE_THRESHOLD === 10 && sn.NUDGE_THRESHOLD === 20)
fakeCount = 11
check('sn-1b 无anchor 11篇提示', sn.shouldPrompt(11) === true)

// A2 有 anchor：差值 > 20 才提示
resetState(); sn.refreshAnchor(10)
check('sn-2a 差值恰20不提示', sn.shouldPrompt(30) === false)
check('sn-2b 差值21提示', sn.shouldPrompt(31) === true)
check('sn-2c anchor 已落存储', store[sn.ANCHOR_KEY], 10)

// A3 mute 后永不提示（无论差值多大）
resetState(); sn.refreshAnchor(0)
store[sn.MUTE_KEY] = '1'
check('sn-3a mute 后不提示', sn.shouldPrompt(9999) === false)
check('sn-3b mute 后不弹窗', sn.maybePrompt() === false && modalOpts === null)
delete store[sn.MUTE_KEY]

// A4 maybePrompt：弹窗文案带篇数，确认跳智能总结页
resetState(); fakeCount = 25
check('sn-4a 达阈值弹窗', sn.maybePrompt() === true && modalOpts !== null)
check('sn-4b 文案含篇数', String(modalOpts.content || '').indexOf('25') !== -1)
check('sn-4c 两档按钮', modalOpts.confirmText === '去试试' && modalOpts.cancelText === '不再提醒')
modalOpts.success({ confirm: true })
check('sn-4d 确认跳智能总结页', navUrl === sn.SUMMARY_URL)

// A5 maybePrompt：取消档 = 写 mute 永久静默
resetState(); fakeCount = 25
sn.maybePrompt()
modalOpts.success({ confirm: false })
check('sn-5a 取消写 mute', store[sn.MUTE_KEY] === '1')
check('sn-5b mute 后不再弹', sn.maybePrompt() === false)

// A6 未达阈值不弹窗
resetState(); fakeCount = 5
check('sn-6 未达阈值不弹', sn.maybePrompt() === false && modalOpts === null)

// A7 保存链路：markSavedPending 置全局标志 / consumePending 消费并弹
resetState(); fakeCount = 10
const appStub = { globalData: {} }
check('sn-7a 未达阈值不置标志', sn.markSavedPending(appStub) === false && !appStub.globalData.pendingSummaryNudge)
fakeCount = 31
check('sn-7b 达阈值置标志', sn.markSavedPending(appStub) === true && appStub.globalData.pendingSummaryNudge === true)
fakeCount = 31
check('sn-7c consumePending 弹窗并清标志', sn.consumePending(appStub) === true && modalOpts !== null && appStub.globalData.pendingSummaryNudge === false)
check('sn-7d 无标志时 consume 不动', sn.consumePending(appStub) === false && modalOpts !== null) // modalOpts 未被重置： consume 返回 false 即可
sn.consumePending(appStub)
modalOpts = null
check('sn-7e 再次消费不重复弹', sn.consumePending(appStub) === false && modalOpts === null)

// A8 无 anchor 的 consumePending 不误弹
resetState(); fakeCount = 3
check('sn-8 未达阈值 consume 静默', sn.consumePending({ globalData: { pendingSummaryNudge: true } }) === false)

/* ===== B. 静态断言：挂点落位 ===== */
const writeJs = fs.readFileSync(path.join(base, 'pages/write/write.js'), 'utf8')
const detailJs = fs.readFileSync(path.join(base, 'pages/detail/detail.js'), 'utf8')
const summaryJs = fs.readFileSync(path.join(base, 'pages/summary/summary.js'), 'utf8')

check('sn-b1 write.js 引入 summaryNudge', writeJs.indexOf("require('../../utils/summaryNudge.js')") !== -1)
check('sn-b2 导入成功弹窗串行接引导', writeJs.indexOf('if (added > 0) summaryNudge.maybePrompt()') !== -1)
check('sn-b3 afterSaveNavigate 置待提示标志', writeJs.indexOf('summaryNudge.markSavedPending(app)') !== -1)
check('sn-b4 detail.js 引入 summaryNudge', detailJs.indexOf("require('../../utils/summaryNudge.js')") !== -1)
check('sn-b5 detail onShow 消费标志', detailJs.indexOf('summaryNudge.consumePending(app)') !== -1)
check('sn-b6 summary.js 引入 summaryNudge', summaryJs.indexOf("require('../../utils/summaryNudge.js')") !== -1)
check('sn-b7 生成成功刷锚点', summaryJs.indexOf('summaryNudge.refreshAnchor()') !== -1)

console.log('TOTAL ' + pass + ' pass, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
