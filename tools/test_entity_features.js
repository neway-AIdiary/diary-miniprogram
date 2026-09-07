/**
 * 单元测试：本轮新增功能
 * 1. nameMatch：语音识别结果的备案名词同音匹配
 * 2. entityClean：日记正文名词解释清理
 * 3. aiCloud.localExtractExplainedEntities：本地降级返回 explanation 原文片段
 * 4. storage.saveArchives：已备案名词去重（只保留一条）
 * 5. processInput 流程模拟：语音输入 → 备案匹配 → 追加 + 指令路径
 */
const path = require('path')

// wx 桩：storage/aiCloud 依赖
const store = {}
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v }
}

const base = path.resolve(__dirname, '..')
const nameMatch = require(path.join(base, 'utils/nameMatch.js'))
const entityClean = require(path.join(base, 'utils/entityClean.js'))
const aiCloud = require(path.join(base, 'utils/aiCloud.js'))
const storage = require(path.join(base, 'utils/storage.js'))

let pass = 0, fail = 0
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) { pass++ } else { fail++; console.log('FAIL:', name, '\n  actual:', JSON.stringify(actual), '\n  expect:', JSON.stringify(expect)) }
}

/* ===== 1. nameMatch 备案名词优先匹配 ===== */
const archives = [{ name: '王维' }, { name: '王磊' }, { name: '海洋大学' }, { name: '长安' }]

// 核心用例：wang wei → 备案「王维」优先于识别输出的「王伟」
check('nm-1 同音替换', nameMatch.matchArchives('今天和王伟一起吃饭', archives),
  { text: '今天和王维一起吃饭', replaced: [{ from: '王伟', to: '王维' }] })
// 拉丁拼音（空格分隔）
check('nm-2 拼音串', nameMatch.matchArchives('wang wei 今天来找我', archives).text, '王维 今天来找我')
// 拉丁拼音（连写）
check('nm-3 连写拼音', nameMatch.matchArchives('wangwei是个诗人', archives).text, '王维是个诗人')
// 已是备案写法：不替换
check('nm-4 正确写法不动', nameMatch.matchArchives('今天和王维吃饭', archives).replaced, [])
// 无关名词：不替换
check('nm-5 未备案不动', nameMatch.matchArchives('今天和张三吃饭', archives).replaced, [])
// 多处替换
check('nm-6 多处', nameMatch.matchArchives('王伟和王伟都来了', archives).replaced.length, 2)
// 防误判：指令语义不受影响的普通文本（英文名/英文单词不动）
check('nm-7 英文不动', nameMatch.matchArchives('我改了一个 bug 就睡了', archives).text, '我改了一个 bug 就睡了')
// 防误判：含多音字的备案名（长乐 chang le / 长乐 zhang?）—— 「长乐」备案，识别「常乐」→ 替换
check('nm-8 多音字', nameMatch.matchArchives('今天常乐了一次', [{ name: '长乐' }]).text, '今天长乐了一次')

/* ===== 2. entityClean 解释清理 ===== */
const ec = (c, es) => entityClean.removeExplanations(c, es).content
// 用户核心用例
check('ec-1 用户用例', ec('我今天和王磊，他是我大学同学一起吃的饭', [{ name: '王磊', explanation: '他是我大学同学' }]),
  '我今天和王磊一起吃的饭')
// 解释在句首
check('ec-2 句首', ec('王磊是我大学同学，今天一起吃饭', [{ name: '王磊', explanation: '是我大学同学' }]),
  '王磊今天一起吃饭')
// 句号分隔保留
check('ec-3 句号保留', ec('王磊是我大学同学。今天一起吃饭', [{ name: '王磊', explanation: '是我大学同学' }]),
  '王磊。今天一起吃饭')
// 解释在名词前
check('ec-4 前向', ec('我大学同学王磊今天来了', [{ name: '王磊', explanation: '我大学同学' }]),
  '王磊今天来了')
// 定位不到 → 不动（防误删）
check('ec-5 防误删', ec('今天和王磊吃饭', [{ name: '王磊', explanation: '不存在的解释' }]),
  '今天和王磊吃饭')
// 多实体
check('ec-6 多实体', ec('我和王磊吃饭，张三是我领导，一起喝酒', [{ name: '王磊', explanation: '他是谁' }, { name: '张三', explanation: '是我领导' }]),
  '我和王磊吃饭，张三一起喝酒')
// AI 概括型（description 带"我的"，原文是"他是我大学同学"）
check('ec-7 概括变体', ec('今天和王磊，他是我大学同学一起吃的饭', [{ name: '王磊', explanation: '我的大学同学' }]),
  '今天和王磊一起吃的饭')
// 云端未返回 explanation（旧版云函数）→ 不清理
check('ec-8 无explanation跳过', ec('我今天和王磊，他是我大学同学一起吃的饭', [{ name: '王磊' }]),
  '我今天和王磊，他是我大学同学一起吃的饭')

/* ===== 3. 本地实体提取带 explanation ===== */
aiCloud.callAIExtractEntities('我今天和王磊，他是我大学同学一起吃的饭').then(localEnt => {
  // callAIExtractEntities 无 wx.cloud → 走本地
  if (localEnt.entities && localEnt.entities.length > 0) {
    const wang = localEnt.entities.find(e => e.name === '王磊')
    check('le-1 提取王磊', !!wang, true)
    if (wang) {
      check('le-2 explanation原文', wang.explanation, '他是我大学同学')
      // 本地提取 + 清理 = 端到端
      check('le-3 端到端清理', entityClean.removeExplanations('我今天和王磊，他是我大学同学一起吃的饭', [wang]).content,
        '我今天和王磊一起吃的饭')
    }
  } else {
    fail++; console.log('FAIL: le-1 本地未提取到实体', JSON.stringify(localEnt))
  }
  runRest()
}).catch(err => {
  fail++; console.log('FAIL: le-调用异常', err)
  runRest()
})

/* ===== 3b. 解释内容门槛：≥4 字才提取，不足 4 字视为只是提及 ===== */
aiCloud.callAIExtractEntities('今天陪小灰玩了一天，小灰是我的猫，特别粘人').then(shortEnt => {
  const grey = (shortEnt.entities || []).find(e => e.name === '小灰')
  check('le-4 不足4字不提取', !!grey, false)
  runRest2()
}).catch(() => { fail++; console.log('FAIL: le-4 调用异常'); runRest2() })

function runRest2() {
aiCloud.callAIExtractEntities('今天见到了李老师，李老师是我高中班主任，还挺健朗').then(longEnt => {
  const t = (longEnt.entities || []).find(e => e.name === '李老师')
  check('le-5 达标仍提取', !!(t && t.description && t.description.length >= 4), true)
  runRest()
}).catch(() => { fail++; console.log('FAIL: le-5 调用异常'); runRest() })
}

function runRest() {

/* ===== 4. 档案去重：已备案名词无论选否都只保留一条 ===== */
storage.replaceArchives([])
storage.saveArchives([{ name: '王磊', description: '我的大学同学' }])
// 再次保存同名同解释（描述追加合并：重复条目不追加）
const r1 = storage.saveArchives([{ name: '王磊', description: '我的大学同学' }])
check('ar-1 重复备案不新增', r1, { added: 0, updated: 0 })
check('ar-2 只保留一条', storage.getArchives().filter(a => a.name === '王磊').length, 1)
// 同名不同解释 → 按逗号条目追加合并（不覆盖旧信息），仍一条
storage.saveArchives([{ name: '王磊', description: '我的高中同学' }])
check('ar-3 更新后仍一条', storage.getArchives().filter(a => a.name === '王磊').length, 1)
check('ar-4 描述追加合并', storage.getArchives()[0].description, '我的大学同学，我的高中同学')

/* ===== 5. processInput 流程模拟（语音路径） ===== */
// 模拟：备案有王维，语音识别"今天和王伟吃饭"（无指令）→ 追加正文为备案写法
const m = nameMatch.matchArchives('今天和王伟吃饭', [{ name: '王维' }])
check('pi-1 语音纯叙述', m.text, '今天和王维吃饭')
// 语音混合指令：叙述中同音替换 + 指令执行
const m2 = nameMatch.matchArchives('王伟来找我。把开心删掉。', [{ name: '王维' }])
const aiEdit = require(path.join(base, 'utils/aiEdit.js'))
const parsed = aiEdit.splitCommands(m2.text)
check('pi-2 指令仍识别', parsed.commands.length >= 1, true)
check('pi-3 叙述已替换', parsed.narrative.indexOf('王维') !== -1, true)

console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
process.exit(fail > 0 ? 1 : 0)
} // runRest end
