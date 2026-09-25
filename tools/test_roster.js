/**
 * [roster v1] 花名册测试
 * A. 行为（wx 桩 + 真实模块）：validName 规则 / 花名册增删与上限 / 一键提取（滑窗+种子+排序+剔除+截断）
 *    / 热词注入联动（花名册变更后 hotwords.get/build 带上最新名单）
 * B. 静态：app.json 注册 / archive 入口 / hotwords 注入块 / voice 日志 / 页面结构与文案
 */
const path = require('path')
const fs = require('fs')

// wx 桩：内存存储
const store = {}
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] }
}

const base = path.resolve(__dirname, '..')
const roster = require(path.join(base, 'utils/roster.js'))
const hotwords = require(path.join(base, 'utils/hotwords.js'))
const storage = require(path.join(base, 'utils/storage.js'))
const personNames = require(path.join(base, 'utils/personNames.js'))

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + ' | ' + (extra || '')) }
}
function resetRoster() { delete store[roster.KEY] }

/* ===== A1. validName ===== */
check('rv-1 两字中文通过', roster.validName('王威') === true)
check('rv-2 三字中文通过', roster.validName('王小明') === true)
check('rv-3 停用词否决', roster.validName('今天') === false)
check('rv-4 副词前缀否决（终于）', roster.validName('终于') === false)
check('rv-5 代词字否决', roster.validName('我朋') === false && roster.validName('他好') === false)
check('rv-6 长度 1/4 否决', roster.validName('王') === false && roster.validName('王威小明') === false)
check('rv-7 非纯汉字否决', roster.validName('Wang') === false && roster.validName('王威1') === false)

/* ===== A2. 增删与上限 ===== */
resetRoster()
check('ra-1 空数组不加', roster.addNames([]) === 0 && roster.getList().length === 0)
check('ra-2 加两个', roster.addNames([{ name: '王威', count: 2, lastDate: '2026-09-25' }, { name: '李娜', count: 1, lastDate: '2026-09-20' }]) === 2)
check('ra-3 读取带字段', roster.getList()[0].name === '王威' && roster.getList()[0].count === 2 && roster.getList()[0].lastDate === '2026-09-25')
check('ra-4 重名跳过', roster.addNames([{ name: '王威' }]) === 0 && roster.getList().length === 2)
check('ra-5 删除存在', roster.removeName('李娜') === true && roster.getList().length === 1)
check('ra-6 删除不存在', roster.removeName('赵六') === false)
resetRoster()
// 105 个唯一纯中文名（姓氏字典字 + 干支后缀组合，避开停用词/代词字）
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤温康施葛鲁'
const SU = SURNAMES.split('')
const bulk = []
for (let i = 0; i < 105; i++) {
  bulk.push({
    name: i < 30
      ? SU[i % SU.length] + '甲乙丙丁戊己庚辛壬癸'[i % 10]
      : SU[i % SU.length] + '甲乙丙丁戊己庚辛壬癸'[i % 10] + '子丑寅卯辰巳午未申酉戌亥'[Math.floor(i / 10) % 12]
  })
}
const bulkAdded = roster.addNames(bulk)
check('ra-7 上限 100 截断', bulkAdded === 100 && roster.getList().length === 100)
check('ra-8 满员后再加跳过', roster.addNames([{ name: '王威' }]) === 0 && roster.getList().length === 100)
resetRoster()

/* ===== A3. 一键提取 ===== */
const DIARIES = [
  { dateKey: '2026-09-25', content: '今天和王威吃饭，王威聊到王小明。' },
  { dateKey: '2026-09-20', content: '又见王威，李娜也来了。' },
  { dateKey: '2026-09-18', content: '王小明说来找我。李娜请喝茶。' }
]
let c = roster.extractCandidates(DIARIES, [], 100)
const byName = {}
c.forEach(x => { byName[x.name] = x })
check('re-1 滑窗提出王威 3 次', byName['王威'] && byName['王威'].count === 3)
check('re-2 王小明（3字≥2次）收录', !!byName['王小明'] && byName['王小明'].count === 2)
check('re-3 滑窗提出李娜 2 次', byName['李娜'] && byName['李娜'].count === 2)
check('re-4 最近日期取最大', byName['王威'].lastDate === '2026-09-25' && byName['李娜'].lastDate === '2026-09-20')
check('re-5 排序：日期新在前，同日期频次多在前',
  c[0].name === '王威' && c[1].name === '王小明' && c[2].name === '李娜')
check('re-5b 低频 3 字碎片被弃、2 字碎片被吸收',
  c.every(x => x.name !== '王威吃' && x.name !== '王威聊' && x.name !== '李娜也' && x.name !== '王小'))
check('re-6 已在花名册的剔除', roster.extractCandidates(DIARIES, ['王威', '李娜'], 100).every(x => x.name !== '王威' && x.name !== '李娜'))
check('re-7 cap 截断', roster.extractCandidates(DIARIES, [], 1).length === 1)
check('re-8 cap=0 空返回', roster.extractCandidates(DIARIES, [], 0).length === 0)
check('re-9 空日记空返回', roster.extractCandidates([], [], 100).length === 0)
check('re-10 停用词/代词不进', c.every(x => x.name !== '今天' && x.name !== '他们'))
// personNames 种子：不在姓氏字典的复姓也进候选
store[personNames.KEY] = ['欧阳飞']
c = roster.extractCandidates([{ dateKey: '2026-09-25', content: '欧阳飞来电话了。' }], [], 100)
check('re-11 personNames 种子计数', c.length === 1 && c[0].name === '欧阳飞' && c[0].count === 1)
delete store[personNames.KEY]

/* ===== A3b. [roster-filter v1] 三层去伪 + AI 复核 ===== */
// rf-1 虚词尾字否决（姓+虚词碎片）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '任在来了，任在走了，任在还说话。' }
], [], 100)
check('rf-1 虚词尾字否决（任在）', c.every(x => x.name !== '任在'))
// rf-2 黑名单否决（姓+常用词，含子串）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '周末去罗马度假。' }
], [], 100)
check('rf-2 黑名单否决（罗马）', c.every(x => x.name !== '罗马'))
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '钟双打练得不错，又夸钟双打。' }
], [], 100)
check('rf-2b 黑名单子串否决（钟双打/钟双）', c.every(x => x.name !== '钟双打' && x.name !== '钟双'))
// rf-3 无强上下文不收（2 字候选必须有至少一次人名式上下文）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '今天看了马术比赛，马术很精彩。' }
], [], 100)
check('rf-3 无强上下文剔除（马术）', c.every(x => x.name !== '马术'))
// rf-3b 前邻协同字即强证据
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '陪李娜逛街，然后回家。' }
], [], 100)
check('rf-3b 前邻「陪」即强证据（李娜）', !!c.find(x => x.name === '李娜'))
// rf-4 后邻言说字即强证据（3 字窗同享该证据，仍须 ≥2 次）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '王小明说到就到。王小明很守时。' }
], [], 100)
const rf4 = c.find(x => x.name === '王小明')
check('rf-4 后邻「说」即强证据（王小明×2）', !!rf4 && rf4.count === 2)
// rf-5 AI 复核：满 100 才触发、keepOnly 静默剔除、标记后不再触发
resetRoster()
check('rf-5a 未满不触发', roster.needsAiReview() === false)
const fill100 = []
for (let i = 0; fill100.length < 100; i++) {
  fill100.push({ name: SU[i % SU.length] + '甲乙丙丁戊己庚辛壬癸'[i % 10] + '子丑寅卯辰巳午未申酉戌亥'[Math.floor(i / 12) % 12] })
}
roster.addNames(fill100)
check('rf-5b 满 100 且未复核 → 触发', roster.getList().length === 100 && roster.needsAiReview() === true)
const rfCur = roster.getNames()
check('rf-5c keepOnly 静默剔除', roster.keepOnly(rfCur.slice(1)) === 1 && roster.getList().length === 99)
roster.markAiReviewDone()
check('rf-5d 标记后不再触发', roster.needsAiReview() === false)
resetRoster()
delete store[roster.REVIEW_KEY]

/* ===== A4. 热词注入联动 ===== */
// 干净环境：空档案 + 无日记，get() 预热日缓存（此时花名册为空）
resetRoster()
storage.getArchives = () => []
storage.getAllDiaries = () => []
hotwords.get(true, { contextText: '' })
check('rh-1 空花名册不注入', hotwords.get(false, { contextText: '' }).indexOf('王威') === -1)
// 确认添加后（write 内部调 resetBaseCache）：下一次 get 即带上花名册
roster.addNames([{ name: '王威' }])
check('rh-2 添加后热词带花名册名', hotwords.get(false, { contextText: '' }).indexOf('王威') !== -1)
check('rh-3 档案之后注入（buildBase 顺序）', hotwords.build({}).words.indexOf('王威') !== -1)
// 删除后同样联动
roster.removeName('王威')
check('rh-4 删除后热词不再带', hotwords.get(false, { contextText: '' }).indexOf('王威') === -1)
check('rh-5 resetBaseCache 已导出', typeof hotwords.resetBaseCache === 'function')
resetRoster()

/* ===== B. 静态断言 ===== */
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8').replace(/\r\n/g, '\n')
const appJson = JSON.parse(read('app.json'))
check('rs-1 app.json 注册花名册页', appJson.pages.indexOf('pages/roster/roster') !== -1)

const archWxml = read('pages/archive/archive.wxml')
check('rs-2 档案页表情按钮改花名册入口', archWxml.indexOf('bindtap="onRosterTap"') !== -1 && archWxml.indexOf('input-emoji disabled') === -1)
check('rs-2a 花名册入口图标为 icon-roster（非表情）[roster v1.1]',
  archWxml.indexOf('icon-bar icon-roster') !== -1 && archWxml.indexOf('icon-bar icon-smiley') === -1)

const archJs = read('pages/archive/archive.js')
check('rs-3 档案页跳转花名册', archJs.indexOf('onRosterTap') !== -1 && archJs.indexOf("url: '/pages/roster/roster'") !== -1)

const hw = read('utils/hotwords.js')
check('rs-4 热词注入块在位', hw.indexOf('roster.getNames()') !== -1 && hw.indexOf('count.roster++') !== -1 && hw.indexOf('resetBaseCache') !== -1)
check('rs-5 注入优先级在档案之后、高频词之前',
  hw.indexOf('花名册人名') > hw.indexOf('档案名词') && hw.indexOf('花名册人名') < hw.indexOf('  // 2. 近十天日记高频关键词'))

const voiceJs = read('utils/voice.js')
check('rs-6 热词日志带花名册计数', voiceJs.indexOf("'+ 花名册', c.roster || 0,") !== -1)

check('rs-7 页面四件套存在', ['roster.js', 'roster.wxml', 'roster.wxss', 'roster.json'].every(f => fs.existsSync(path.join(base, 'pages/roster', f))))
const rWxml = read('pages/roster/roster.wxml')
const rJs = read('pages/roster/roster.js')
check('rs-8 说明文案在位', rWxml.indexOf('添加名字到花名册后，语音识别会更精准') !== -1)
check('rs-9 一键提取 + 确认面板 + 长按删除结构', rWxml.indexOf('onExtract') !== -1 && rWxml.indexOf('onToggle') !== -1 && rWxml.indexOf('onPanelConfirm') !== -1 && rWxml.indexOf('bindlongpress="onRemoveName"') !== -1)
check('rs-10 页面主题与确认弹窗', rJs.indexOf('theme.applyTo(this)') !== -1 && rJs.indexOf('wx.showModal') !== -1 && rJs.indexOf("confirmText: '删除'") !== -1)
check('rs-11 标题「花名册」', read('pages/roster/roster.json').indexOf('花名册') !== -1)

// [roster-filter v1] AI 复核链路静态断言
const optSrc = read('cloudfunctions/optimizeDiary/index.js')
check('rf-6a 云函数 rosterReview 分支与 prompt（含职位头衔剔除）',
  optSrc.indexOf("action === 'rosterReview'") !== -1 && optSrc.indexOf('职位/头衔/称谓') !== -1)
check('rf-6b 云函数返回名单限制为原子集',
  optSrc.indexOf('src.has(n)') !== -1)
const aiSrc = read('utils/aiCloud.js')
check('rf-6c aiCloud 导出 callAIRosterReview（失败静默）',
  aiSrc.indexOf('function callAIRosterReview') !== -1 && aiSrc.indexOf('callAIRosterReview }') !== -1)
check('rf-6d 页面接好静默复核链路',
  rJs.indexOf('maybeAiReview') !== -1 && rJs.indexOf('callAIRosterReview') !== -1 && rJs.indexOf('roster.keepOnly') !== -1)

console.log('===== TOTAL ' + pass + ' pass, ' + fail + ' fail =====')
process.exit(fail ? 1 : 0)
