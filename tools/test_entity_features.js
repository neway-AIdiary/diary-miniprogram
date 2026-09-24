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
check('ar-1 重复备案不新增', r1, { added: 0, updated: 0, skipped: 0 })
check('ar-2 只保留一条', storage.getArchives().filter(a => a.name === '王磊').length, 1)
// 同名不同解释 → 按逗号条目追加合并（不覆盖旧信息），仍一条
storage.saveArchives([{ name: '王磊', description: '我的高中同学' }])
check('ar-3 更新后仍一条', storage.getArchives().filter(a => a.name === '王磊').length, 1)
check('ar-4 描述追加合并', storage.getArchives()[0].description, '我的大学同学，我的高中同学')

// ar-5/6：脏名称（一整句话）统一兜底拒收（2026-09-16 语音建档反馈）
const rDirty = storage.saveArchives([{ name: '继续换行，继续换行，这个两行就够了，三孩没有必要？', description: '' }])
check('ar-5 脏名称被拒收', rDirty, { added: 0, updated: 0, skipped: 1 })
check('ar-6 脏名称不入库', storage.getArchives().filter(a => String(a.name).indexOf('，') !== -1).length, 0)

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

/* ===== 6. 名词黑名单：单字只在首字否决（防误杀含「能/来/上」的合法专名） =====
 * 2026-09-18 用户侧 bug：「北汽新能源是我上一家公司」保存后不弹备案 —— 旧规则「含字即拦」命中「能」。
 */
const fs = require('fs')

// 6a 行为：合法专名必须能提取（本地规则引擎，无 wx.cloud 路径）
aiCloud.callAIExtractEntities('北汽新能源是我上一家公司').then(r6a => {
  check('nb-1 北汽新能源可提取', (r6a.entities || []).map(e => e.name).indexOf('北汽新能源') !== -1, true)
  return aiCloud.callAIExtractEntities('蔚来汽车是我的代步工具')
}).then(r6b => {
  check('nb-2 蔚来汽车可提取', (r6b.entities || []).map(e => e.name).indexOf('蔚来汽车') !== -1, true)
  return aiCloud.callAIExtractEntities('四维图新是一家科技公司。')
}).then(r6c => {
  check('nb-3 四维图新可提取', (r6c.entities || []).map(e => e.name).indexOf('四维图新') !== -1, true)
  return aiCloud.callAIExtractEntities('去公司是每天的必修课')
}).then(r6d => {
  // 6b 反向：动词开头的句式片段仍必须被拦
  check('nb-4 动词开头仍被拦', (r6d.entities || []).length, 0)

  // 6c 静态护栏：两端（小程序 / 云函数）不允许再出现旧黑名单，且新规则两份逐字一致
  const utilSrc = fs.readFileSync(path.join(base, 'utils/aiCloud.js'), 'utf8')
  const fnSrc = fs.readFileSync(path.join(base, 'cloudfunctions/optimizeDiary/index.js'), 'utf8')
  check('nb-5 旧黑名单已清除(小程序端)', utilSrc.indexOf('INVALID_NAME_WORDS') === -1, true)
  check('nb-6 旧黑名单已清除(云函数)', fnSrc.indexOf('INVALID_NAME_WORDS') === -1, true)
  const arrText = (src, key) => {
    const m = src.match(new RegExp(key + '\\s*=\\s*\\[([^\\]]*)\\]'))
    return m ? m[1].replace(/[\s']/g, '') : 'MISSING'
  }
  const headU = arrText(utilSrc, 'NAME_BLOCK_HEAD_CHARS')
  const headF = arrText(fnSrc, 'NAME_BLOCK_HEAD_CHARS')
  check('nb-7 首字黑名单两端一致', headU !== 'MISSING' && headU === headF, true)
  const wordU = arrText(utilSrc, 'NAME_BLOCK_WORDS')
  const wordF = arrText(fnSrc, 'NAME_BLOCK_WORDS')
  check('nb-8 多字黑名单两端一致', wordU !== 'MISSING' && wordU === wordF, true)

/* ===== 7. 否定句不备案（2026-09-18 用户侧 bug：「我明明不是这么说的。」弹出备案「明明不」） ===== */
// AI 拆词「明明不」+ 余句「是这么说的」以「是」开头 → 旧规则误判为定义句
check('ng-1 否定句拆词「明明不」不备案', entityClean.isExplainedNoun('明明不', '我明明不是这么说的。'), false)
// AI 只报「明明」时，靠副词表拦截（「明明是这么说的」旧规则会误判为定义句）
check('ng-2 副词「明明」不备案', entityClean.isExplainedNoun('明明', '我明明是这么说的。'), false)
// NEG_LEADS 顺带治既有误报源：「王磊不是坏人」旧规则也会误判为定义句
check('ng-3 否定句「王磊不是坏人」不备案', entityClean.isExplainedNoun('王磊', '王磊不是坏人。'), false)
// 副词表直接拦截（「其实是…」句式旧规则会误判为定义句）
check('ng-4 虚词「其实」不备案', entityClean.isExplainedNoun('其实', '其实是我的错。'), false)
// 正例不误伤：正常备案句原路径放行
check('ng-5 正例「王喜兰」仍备案', entityClean.isExplainedNoun('王喜兰', '我妈叫王喜兰。'), true)
check('ng-6 正例「披萨」仍备案', entityClean.isExplainedNoun('披萨', '这是披萨，就是一种意大利饼。'), true)
// 否定句即使主语是真专名也不弹备案（日记原文保持不变，无副作用）
check('ng-7 专名+否定句不备案', entityClean.isExplainedNoun('王喜兰', '王喜兰不是本地人。'), false)
// [entity-adv-v1] 2026-09-20 用户侧 bug：「简直是专门为我准备的。」弹出备案「简直」——
// 语气/强调/转折副词与介词整类不备案（两句在旧规则下都会被「是」开头误判为定义句）
check('ng-9 语气副词「简直」不备案', entityClean.isExplainedNoun('简直', '简直是专门为我准备的。'), false)
check('ng-10 强调副词「根本」不备案', entityClean.isExplainedNoun('根本', '他根本是我的知己。'), false)

/* ===== 8. 虚词横展 [entity-vc-v1]（2026-09-20 用户指令）：副词/介词/连词/助词/叹词整类不备案 ===== */
// 每类抽代表，句子均构造为「虚词 + 是…」的旧规则必误判形状（红灯自检能咬中）
check('ng-11 时间副词「渐渐」不备案', entityClean.isExplainedNoun('渐渐', '我渐渐是他最信任的人。'), false)
check('ng-12 连词「如果」不备案', entityClean.isExplainedNoun('如果', '如果这是命运的安排。'), false)
check('ng-13 介词「自从」不备案', entityClean.isExplainedNoun('自从', '我一直记得那天，自从，是我们第一次见面。'), false)
check('ng-14 助词「而已」不备案', entityClean.isExplainedNoun('而已', '而已，是我们之间才懂的暗号。'), false)
check('ng-15 叹词「哎哟」不备案', entityClean.isExplainedNoun('哎哟', '哎哟，是我的老朋友！'), false)
check('ng-16 方位约词「左右」不备案', entityClean.isExplainedNoun('左右', '等左右是十分钟后，我们出发。'), false)
// 正例护栏不误伤：真专名仍放行（横展只拦虚词整词，不碰含同字的专名）
check('ng-17 正例「果然山」不受横展影响', entityClean.isExplainedNoun('果然山', '果然山是我们村后的大山。'), true)

/* ===== 9. 词性整类拦截 [entity-num/pron/verb/adj-v1]（2026-09-20 用户指令）：
   数量词/代词/动词/形容词一律不备案。句子均为旧版必红形状（句首或「，是」凑成定义句） ===== */
check('ng-18 数量词「一个」不备案', entityClean.isExplainedNoun('一个', '一个是阆苑仙葩。'), false)
check('ng-19 数字表达式「百分之一」不备案', entityClean.isExplainedNoun('百分之一', '百分之一是我的诚意。'), false)
check('ng-20 数量短语「十斤」不备案', entityClean.isExplainedNoun('十斤', '十斤是我这周的目标。'), false)
check('ng-21 序数「第一次」不备案', entityClean.isExplainedNoun('第一次', '第一次是我搞错了。'), false)
check('ng-22 时间量词「三年」不备案', entityClean.isExplainedNoun('三年', '三年是我全部的青春。'), false)
check('ng-23 动词「吃饭」不备案', entityClean.isExplainedNoun('吃饭', '吃饭是我一天中最期待的事。'), false)
check('ng-24 形容词「开心」不备案', entityClean.isExplainedNoun('开心', '开心是我今天的主旋律。'), false)
check('ng-25 代词「大家」不备案', entityClean.isExplainedNoun('大家', '大家是我的家人。'), false)
// 正例护栏：含数字的专名不被数量词规则误伤
check('ng-26 正例「三里屯」不受数量词规则影响', entityClean.isExplainedNoun('三里屯', '三里屯是我们常去的商场。'), true)

/* ===== 10. 连词碎片与抽象属性词 [entity-frag-v1/entity-xing-v1]（2026-09-24 用户侧 bug：
   「但总是想着自己的事情」弹出备案「但总」；「积极性是完全不一样的」弹出备案「积极性」） ===== */
check('fg-1 连词碎片「但总」不备案', entityClean.isExplainedNoun('但总', '但总是想着自己的事情。'), false)
check('fg-2 抽象属性词「积极性」不备案', entityClean.isExplainedNoun('积极性', '积极性是完全不一样的。'), false)
check('fg-3 同整类「可能性」不备案', entityClean.isExplainedNoun('可能性', '可能性是有的。'), false)
check('fg-4 连词碎片「却总」同样拦截', entityClean.isExplainedNoun('却总', '却总是另一番景象。'), false)
check('fg-5 正例「张总」不受碎片规则影响', entityClean.isExplainedNoun('张总', '张总是我们部门的经理。'), true)
check('fg-6 人名热词同口径：碎片「但总」被拒', entityClean.isNonNounWord('但总'), true)
check('fg-7 人名热词同口径：「积极性」被拒', entityClean.isNonNounWord('积极性'), true)
check('fg-8 已知拦截不回归：简直/一个仍拒绝', entityClean.isNonNounWord('简直') && entityClean.isNonNounWord('一个'), true)

/* ===== 11. 比较句/强调句否决 [entity-compare-v1]（2026-09-24 用户侧 bug：
   「智商是完全不一样的」——名词后跟「是」但整句是比较/强调，不是定义） ===== */
check('cp-1 比较句「智商是完全不一样的」不备案', entityClean.isExplainedNoun('智商', '今天聊了很多，智商是完全不一样的。'), false)
check('cp-2 比较句「能力是不一样的」不备案', entityClean.isExplainedNoun('能力', '我们俩能力是不一样的。'), false)
check('cp-3 比较句「态度是差不多的」不备案', entityClean.isExplainedNoun('态度', '他对这件事的态度是差不多的。'), false)
check('cp-4 强调句「是华为最新款的」不备案', entityClean.isExplainedNoun('手机', '这部手机是华为最新款的。'), false)
check('cp-5 人称领属真定义「王磊是我的大学同学」仍备案', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('cp-6 正例「三里屯」不受新规则影响', entityClean.isExplainedNoun('三里屯', '三里屯是我们常去的商场。'), true)
check('cp-7 同词两处：比较句跳过、定义句仍备案', entityClean.isExplainedNoun('智商', '智商是完全不一样的。医生说智商是衡量认知能力的指标。'), true)
check('cp-8 通篇比较句不备案', entityClean.isExplainedNoun('智商', '智商是完全不一样的。能力是完全不一样的。'), false)
check('cp-9 揣测句「是我的朋友吧」不备案', entityClean.isExplainedNoun('王磊', '王磊是我的朋友吧。'), false)
check('cp-10 疑问句「是坏人吗」不备案', entityClean.isExplainedNoun('张总', '张总是坏人吗？'), false)
check('cp-11 吧/吗之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('cp-12 假名词「妈妈说这」不备案', entityClean.isExplainedNoun('妈妈说这', '妈妈说这是豆子在呼吸'), false)
check('cp-13 假名词同口径：热词链路拒绝', entityClean.isNonNounWord('妈妈说这'), true)
check('cp-14 真名词「豆子」在转述句中不备案', entityClean.isExplainedNoun('豆子', '妈妈说这是豆子在呼吸'), false)
check('cp-15 转述引导「说的是」不备案', entityClean.isExplainedNoun('豆子', '妈妈说的是豆子在呼吸。'), false)
check('cp-16 转述引导「告诉我是」不备案', entityClean.isExplainedNoun('三块钱', '老师告诉我是三块钱。'), false)
check('cp-17 转述之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 12. 日期/时间词整类不备案 [entity-date-v1]（2026-09-24 用户侧 bug：
   「晴今天」——天气字与时间词的拼接碎片；日期类表达整类不该备案） ===== */
check('dt-1 拼接碎片「晴今天」不备案', entityClean.isExplainedNoun('晴今天', '2023年10月2日 星期一 晴今天是一年一度的九月会。'), false)
check('dt-2 整词「今天」不备案', entityClean.isExplainedNoun('今天', '今天是我的生日。'), false)
check('dt-3 相对日期「明日」不备案', entityClean.isExplainedNoun('明日', '明日是提交的最后期限。'), false)
check('dt-4 数字日期「10月1日」不备案', entityClean.isExplainedNoun('10月1日', '10月1日是国庆节。'), false)
check('dt-5 混合日期「3月8日」不备案', entityClean.isExplainedNoun('3月8日', '3月8日是她的生日。'), false)
check('dt-6 热词同口径：含日期碎片拒绝', entityClean.isNonNounWord('晴今天'), true)
check('dt-7 含月字真名「王月红」不受日期模式误伤', entityClean.isNonNounWord('王月红'), false)
check('dt-8 真专名「五羊城」不受日期模式影响', entityClean.isExplainedNoun('五羊城', '五羊城是我们的老城区。'), true)

/* ===== 13. 语气副词/连词代词拼接碎片否决 [entity-frag2-v1]（2026-09-24 用户侧 bug：
   「可正」「因此我们总」——语气副词开头碎片；连词+代词+副词复合碎片） ===== */
check('kd-1 语气副词碎片「可正」不备案', entityClean.isExplainedNoun('可正', '可正是水的柔和善变造就了它自身的魅力。'), false)
check('kd-2 复合碎片「因此我们总」不备案', entityClean.isExplainedNoun('因此我们总', '因此我们总是让一天的时间匆匆而来。'), false)
check('kd-3 热词同口径：「可正」拒绝', entityClean.isNonNounWord('可正'), true)
check('kd-4 热词同口径：「因此我们总」拒绝', entityClean.isNonNounWord('因此我们总'), true)
check('kd-5 真名「王磊」不受连词子串误伤', entityClean.isNonNounWord('王磊'), false)
check('kd-6 真专名「果然山」不回归', entityClean.isExplainedNoun('果然山', '果然山是我们村后的大山。'), true)
check('kd-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('kd-8 变体碎片「所以我们」拒绝', entityClean.isNonNounWord('所以我们'), true)

/* ===== 14. 方位词整类不备案 [entity-loc-v1]（2026-09-24 用户指令：
   「以下是为你介绍的高中日记10000字」弹备案「以下」——只有人名/地名/事物名/专用名词才备案） ===== */
check('lw-1 方位词「以下」不备案', entityClean.isExplainedNoun('以下', '以下是为你介绍的高中日记10000字。'), false)
check('lw-2 方位词「以上」不备案', entityClean.isExplainedNoun('以上', '以上是我的全部交代。'), false)
check('lw-3 方位词「旁边」不备案', entityClean.isExplainedNoun('旁边', '旁边是王磊的座位。'), false)
check('lw-4 热词同口径：方位词「以下」拒绝', entityClean.isNonNounWord('以下'), true)
check('lw-5 真地名「中关村」不回归', entityClean.isExplainedNoun('中关村', '中关村是我们的科技园区。'), true)
check('lw-6 真名「王磊」不回归', entityClean.isNonNounWord('王磊'), false)

/* ===== 15. 副词收尾碎片 + 频率时间词 [entity-tailadv-v1]（2026-09-24 用户侧 bug：
   「每天晚上便」「风雨之后便」——时间短语+副词「便」的拼接碎片） ===== */
check('bd-1 「每天晚上便」不备案', entityClean.isExplainedNoun('每天晚上便', '每天晚上便是我最放松的时刻。'), false)
check('bd-2 「风雨之后便」不备案', entityClean.isExplainedNoun('风雨之后便', '风雨之后便是彩虹出现的时刻。'), false)
check('bd-3 热词同口径：「每天晚上便」拒绝', entityClean.isNonNounWord('每天晚上便'), true)
check('bd-4 热词同口径：「风雨之后便」拒绝', entityClean.isNonNounWord('风雨之后便'), true)
check('bd-5 频率时间词「每天」不备案', entityClean.isExplainedNoun('每天', '每天是我最忙的时候。'), false)
check('bd-6 变体碎片「比赛之即」拒绝', entityClean.isNonNounWord('比赛之即'), true)
check('bd-7 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)
check('bd-8 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 16. 方位字收尾否决 [entity-loc2-v1]（2026-09-24 用户侧 bug：
   「村后是一片竹林」弹备案「村后」——方位短语不是名词，后跟「是」是存在句） ===== */
check('fw-1 方位短语「村后」不备案', entityClean.isExplainedNoun('村后', '村后是一片竹林。'), false)
check('fw-2 方位短语「桌上」不备案', entityClean.isExplainedNoun('桌上', '桌上是一杯温水。'), false)
check('fw-3 热词同口径：「村后」拒绝', entityClean.isNonNounWord('村后'), true)
check('fw-4 变体方位短语「门前」拒绝', entityClean.isNonNounWord('门前'), true)
check('fw-5 真地名「汉中」不受尾字误伤', entityClean.isNonNounWord('汉中'), false)
check('fw-6 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 17. 解释原文核对 + 泛指短语补漏 [entity-expl-v1]（2026-09-24 用户侧 bug：
   弹窗「军训/我们这嗨达/另外一项任务/仅仅」四条解释均为 AI 编造） ===== */
check('ex-1 幻觉解释「军训」整条否决', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。', '培新任意识的开始'), false)
check('ex-2 真解释「王磊」不受误伤', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)
check('ex-3 空解释不据此否决（旧数据兜底）', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。', ''), true)
check('ex-4 旧两参签名行为不回归', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。'), true)
check('ex-5 副词「仅仅」不备案', entityClean.isExplainedNoun('仅仅', '仅仅是开始。'), false)
check('ex-6 泛指短语「另外一项任务」不备案', entityClean.isExplainedNoun('另外一项任务', '另外一项任务是写总结。'), false)
check('ex-7 热词同口径：「另外一项任务」拒绝', entityClean.isNonNounWord('另外一项任务'), true)
check('ex-8 热词同口径：「仅仅」拒绝', entityClean.isNonNounWord('仅仅'), true)

/* ===== 18. 频率副词成分 + 「名词+总」拼接否决 [entity-freq-v1]（2026-09-24 用户侧 bug
   第二轮：「他通常是晚上跑步」弹「通常」、「母亲总是起得很早」弹「母亲总」） ===== */
check('fq-1 副词「通常」不备案', entityClean.isExplainedNoun('通常', '他通常是晚上跑步。'), false)
check('fq-2 拼接碎片「母亲总」不备案', entityClean.isExplainedNoun('母亲总', '母亲总是起得很早。'), false)
check('fq-3 幻觉解释双保险：「通常」仍拦', entityClean.isExplainedNoun('通常', '他通常是晚上跑步。', '选择显示为该人记忆的意志'), false)
check('fq-4 热词同口径：「通常」拒绝', entityClean.isNonNounWord('通常'), true)
check('fq-5 热词同口径：「母亲总」拒绝', entityClean.isNonNounWord('母亲总'), true)
check('fq-6 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)
check('fq-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('fq-8 变体拼接「比赛总」拒绝', entityClean.isNonNounWord('比赛总'), true)

/* ===== 19. 频率短语「每年/每次」+ 常用活动词 [entity-gate3-v1]（2026-09-24 用户侧 bug
   第三轮：「每年一次见他是我们家的习惯」弹「每年一次见他」；军训解释在原文时仍弹） ===== */
check('yb-1 频率短语「每年一次见他」不备案', entityClean.isExplainedNoun('每年一次见他', '每年一次见他是我们家的习惯。', '是我们家的习惯'), false)
check('yb-2 热词同口径：「每年一次见他」拒绝', entityClean.isNonNounWord('每年一次见他'), true)
check('yb-3 变体「每次聚会」拒绝', entityClean.isNonNounWord('每次聚会'), true)
check('yb-4 常用活动词「军训」不备案', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。'), false)
check('yb-5 热词同口径：「军训」拒绝', entityClean.isNonNounWord('军训'), true)
check('yb-6 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('yb-7 旧两参真定义不回归（新载体）', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。'), true)
check('yb-8 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)

/* ===== 20. 方言代词成分 [entity-amen-v1]（2026-09-24 用户侧 bug 第四轮：
   「俺们这嘎达」弹备案——上轮修的「我们这嗨达」靠「我们」子串拦住，ASR 转成
   「俺们」换字就漏；方言代词「俺/咱」单字入表，一并覆盖全部变体） ===== */
check('am-1 方言碎片「俺们这嘎达」不备案', entityClean.isExplainedNoun('俺们这嘎达', '俺们这嘎达到处都是积雪。'), false)
check('am-2 热词同口径：「俺们这嘎达」拒绝', entityClean.isNonNounWord('俺们这嘎达'), true)
check('am-3 变体「俺这嘎达」拒绝', entityClean.isNonNounWord('俺这嘎达'), true)
check('am-4 变体「咱这嘎达」拒绝', entityClean.isNonNounWord('咱这嘎达'), true)
check('am-5 热词同口径：「俺们」拒绝', entityClean.isNonNounWord('俺们'), true)
check('am-6 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)
check('am-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 21. 「叫」义治理：分句边界 + 使令豁免 [entity-jiao v1]（2026-09-24 用户侧 bug 第五轮：
   「妈妈就给我姐夫打电话，叫我姐夫把我带出去去」弹「姐夫打电话」——逗号后的「叫」被当成
   紧随定义。用户指令：①叫前面有标点不弹 ②「叫」是喊/说不是「是」，只有「叫」的是
   人名/地名/建筑名/设施名才弹） ===== */
check('jb-1 隔逗号的「叫」不判定义（姐夫打电话）', entityClean.isExplainedNoun('姐夫打电话', '妈妈就给我姐夫打电话，叫我姐夫把我带出去去。', '叫我姐夫把我带出去'), false)
check('jb-2 叫+人称代词是使令（王磊叫我…）', entityClean.isExplainedNoun('王磊', '王磊叫我明天早点去集合。', '叫我明天早点去集合'), false)
check('jb-3 叫+动态助词是喊叫（叫住了我）', entityClean.isExplainedNoun('王磊', '王磊叫住了我，说有急事。', '叫住了我'), false)
check('jb-4 名字介绍「母亲叫王喜兰」不回归（前向引导）', entityClean.isExplainedNoun('王喜兰', '我母亲叫王喜兰，是个热心肠的人。', '是个热心肠的人'), true)
check('jb-5 无标点紧随「是」不回归', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。'), true)
check('jb-6 隔逗号的「是」维持可弹（边界规则只限「叫」，不扩大打击面）', entityClean.isExplainedNoun('李雷', '今天路上遇到李雷，是个热心人。', '是个热心人'), true)
check('jb-7 「叫」+人名仍可弹（姐夫叫王磊）', entityClean.isExplainedNoun('姐夫', '我姐夫叫王磊，是个热心肠的人。', '是个热心肠的人'), true)

  // ===== [entity-generic v1] 第 22 节：常识级常用词不备案（lg-1~6）=====
  check('lg-1 用户案例：黄河是常识级地名不备案', entityClean.isExplainedNoun('黄河', '黄河是中国的母亲河。', '中国的母亲河'), false)
  check('lg-2 论证是常用抽象词', entityClean.isNonNounWord('论证'), true)
  check('lg-3 「论证事迹」拼接碎片不备案', entityClean.isNonNounWord('论证事迹'), true)
  check('lg-4 事迹是泛称', entityClean.isNonNounWord('事迹'), true)
  check('lg-5 护栏：黄河大桥不被整词表误伤', entityClean.isNonNounWord('黄河大桥'), false)
  check('lg-6 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)

  // ===== [entity-sumword/whether/tailpron v1] 第 23 节：总结连词/是否疑问/代词收尾（zt-1~6）=====
  check('zt-1 用户案例：总而言之是总结连词不备案', entityClean.isExplainedNoun('总而言之', '总而言之是一场误会，不必再提。', '是一场误会'), false)
  check('zt-2 总而言之本体非名词', entityClean.isNonNounWord('总而言之'), true)
  check('zt-3 用户案例：「是否」开头是疑问不是定义（明神大陆）', entityClean.isExplainedNoun('明神大陆', '明神大陆是否再次矛头相接，谁也说不准。', '是否再次矛头相接'), false)
  check('zt-4 用户案例：动词+代词「娶她」不是名词', entityClean.isExplainedNoun('娶她', '我娶她是为了羞辱她。', '是为了羞辱她'), false)
  check('zt-5 护栏：明神大陆本体合法（热词链路不误伤）', entityClean.isNonNounWord('明神大陆'), false)
  check('zt-6 护栏：左小小不被新规则误伤', entityClean.isNonNounWord('左小小'), false)

  // ===== [entity-frag3-v1] 第 24 节：疑问/揣测副词首字（怎/岂）碎片不备案（zl-1~5）=====
  check('zl-1 用户案例：怎料却是疑问副词碎片不备案', entityClean.isExplainedNoun('怎料却', '怎料却是个爹不亲、娘不爱的主。', '是个爹不亲、娘不爱的主'), false)
  check('zl-2 怎料却本体按首字规则否决（热词链路同口径）', entityClean.isNonNounWord('怎料却'), true)
  check('zl-3 变体：怎奈开头同类碎片', entityClean.isNonNounWord('怎奈'), true)
  check('zl-4 变体：岂料开头同类碎片', entityClean.isNonNounWord('岂料'), true)
  check('zl-5 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)

  // ===== [entity-time-adv-v1] 第 25 节：时间词/情态副词不备案（rj-1~6）=====
  check('rj-1 用户案例：如今是时间词不备案', entityClean.isExplainedNoun('如今', '到了如今，这是她的思想。', '她的思想'), false)
  check('rj-2 用户案例：充其量是情态副词不备案', entityClean.isExplainedNoun('充其量', '她充其量是舆论的玩偶。', '是舆论的玩偶'), false)
  check('rj-3 如今本体按时间词否决', entityClean.isNonNounWord('如今'), true)
  check('rj-4 至今同族变体', entityClean.isNonNounWord('至今'), true)
  check('rj-5 充其量本体按副词否决', entityClean.isNonNounWord('充其量'), true)
  check('rj-6 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)

  // ===== [entity-pron2/tailtime/advprefix/tailadv2 v1] 第 26 节：代词成分/「X时」收尾/副词前缀碎片不备案（pn-1~8）=====
  check('pn-1 用户案例：「妹妹吵架时」时间从句碎片不备案', entityClean.isExplainedNoun('妹妹吵架时', '妹妹吵架时是一条心的，原来我妈只是一个平凡的女人。', '一条心的'), false)
  check('pn-2 用户案例：「原来我妈只」副词+代词碎片不备案', entityClean.isExplainedNoun('原来我妈只', '妹妹吵架时是一条心的，原来我妈只是一个平凡的女人。', '一个平凡的女人'), false)
  check('pn-3 妹妹吵架时本体按尾字规则否决（热词链路同口径）', entityClean.isNonNounWord('妹妹吵架时'), true)
  check('pn-4 原来我妈只本体按代词成分否决', entityClean.isNonNounWord('原来我妈只'), true)
  check('pn-5 变体：原来妈妈同类副词前缀碎片', entityClean.isNonNounWord('原来妈妈'), true)
  check('pn-6 变体：放学时同类时间从句碎片', entityClean.isNonNounWord('放学时'), true)
  check('pn-7 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)
  check('pn-8 护栏：不含代词/副词前缀的真专名不受误伤', entityClean.isNonNounWord('明神大陆'), false)
  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
  process.exit(fail > 0 ? 1 : 0)
}).catch(err => {
  fail++
  console.log('FAIL: nb-调用异常', err)
  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
  process.exit(1)
})
} // runRest end
