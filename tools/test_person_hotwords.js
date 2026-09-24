/**
 * [person-hotword v1] 测试：A'（保存时沉淀人名）+ D（单次人名降为低优先填充）
 *
 * A. entityClean.isNonNounWord —— 语义级否决（复用既有词表）
 * B. aiCloud.cleanPersonNames —— 人名清洗（长度/字符集/原文出现/误报表/去重）
 * C. personNames —— 本地人名表（去重 / LRU / 上限 60 / 脏数据 / clear）
 * D. hotwords 第四源 —— 低优先填充、独立子预算 30、只填空余、保序、与 ctx 去重
 * E. voice.js 时序 —— **热词构建必须发生在 task.onOpen 之后**（不占「按下→建连」期间的主线程，
 *    即不牺牲录音浮层出现的时间）；含行为级 spy + 静态位置断言
 * F. 接线与契约 —— 保存路径沉淀、云函数 persons 契约、老云函数兼容
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

// ===== wx mock（storage）=====
const store = {}
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] }
}

const entityClean = require(path.join(ROOT, 'utils/entityClean.js'))
const aiCloud = require(path.join(ROOT, 'utils/aiCloud.js'))
const personNames = require(path.join(ROOT, 'utils/personNames.js'))
const hotwords = require(path.join(ROOT, 'utils/hotwords.js'))
const storage = require(path.join(ROOT, 'utils/storage.js'))

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else {
    fail++
    console.log('  ✗ ' + msg + (extra === undefined ? '' : ('  → ' + JSON.stringify(extra))))
  }
}
function section(t) { console.log('\n== ' + t + ' ==') }

// 纯中文汉字池（用于批量构造人名，避免 ASCII 被字符集规则过滤）
const CHARS = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国'

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString()
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ============================================================
  // A. entityClean.isNonNounWord
  // ============================================================
  section('A. entityClean.isNonNounWord（语义级否决，复用既有词表）')
  // 守卫：目标缺失时返回 undefined ⇒ 断言失败而非抛异常。
  // 「崩溃」会吃掉后面的断言，把「红得很少」伪装成「红得干净」（本项目踩过的坑）
  const isNonNoun = (n) => (typeof entityClean.isNonNounWord === 'function' ? entityClean.isNonNounWord(n) : undefined)
  ok(typeof entityClean.isNonNounWord === 'function', 'A1 已导出 isNonNounWord')
  ok(isNonNoun('高兴') === true, 'A2 形容词「高兴」被否决（entity-adj-v1 表）')
  ok(isNonNoun('方式') === true, 'A3 泛称词「方式」被否决')
  ok(isNonNoun('出差') === true, 'A4 动词「出差」被否决（entity-verb-v1 表）')
  ok(isNonNoun('他们') === true, 'A5 代词「他们」被否决（entity-pron-v1 表）')
  ok(isNonNoun('一个') === true, 'A6 数量词「一个」被否决（NUM_CLS_RE 规则）')
  ok(isNonNoun('百分之') === true, 'A7 数量词「百分之」被否决（NUM_EXPR_RE 规则）')
  ok(isNonNoun('今天杨帆') === true, 'A8 时间词前缀「今天杨帆」被否决')
  ok(isNonNoun('的第一天') === true, 'A9 含功能字「的第一天」被否决')
  ok(isNonNoun('张三') === false, 'A10 真名「张三」不被否决')
  ok(isNonNoun('王威') === false, 'A11 真名「王威」不被否决')
  ok(isNonNoun('') === true && isNonNoun(null) === true, 'A12 空值被否决（安全）')
  ok(isNonNoun('甲') === true, 'A13 单字被否决')
  ok(isNonNoun('一二三四五六七') === true, 'A14 超 6 字被否决')

  // ============================================================
  // B. aiCloud.cleanPersonNames
  // ============================================================
  section('B. cleanPersonNames（人名清洗）')
  const TEXT = '今天和张三吃饭，王威也来了，顺便聊了周末的安排。'
  // 守卫：目标缺失时返回空数组（断言用 join 比对 ⇒ 空数组同样会失败，不会假绿）
  const cleanPersons = (raw, text) => {
    if (typeof aiCloud.cleanPersonNames !== 'function') return []
    const r = aiCloud.cleanPersonNames(raw, text)
    return Array.isArray(r) ? r : []
  }
  ok(typeof aiCloud.cleanPersonNames === 'function', 'B1 已导出 cleanPersonNames')
  ok(JSON.stringify(cleanPersons(['张三', '王威'], TEXT)) === '["张三","王威"]',
    'B2 真名通过（保序）', cleanPersons(['张三', '王威'], TEXT))
  ok(cleanPersons(['周末', '张三'], TEXT).join(',') === '张三', 'B3 「周末」（姓氏+常用字误报）被拦、真名保留')
  ok(cleanPersons(['高兴', '张三'], TEXT).join(',') === '张三', 'B4 形容词误报被拦、真名保留')
  ok(cleanPersons(['李四', '张三'], TEXT).join(',') === '张三', 'B5 原文未出现 → 拦（防 AI 编造）')
  ok(cleanPersons(['这个', '张三'], TEXT).join(',') === '张三', 'B6 代词开头 → 拦')
  ok(cleanPersons(['和', '张三'], TEXT).join(',') === '张三', 'B7 单字 → 拦')
  ok(cleanPersons(['ABC', '张三'], TEXT).join(',') === '张三', 'B8 纯 ASCII → 拦')
  ok(cleanPersons(['张三', '张三', '张三'], TEXT).length === 1, 'B9 重复去重')
  ok(cleanPersons(null, TEXT).length === 0, 'B10 非数组 → 空（安全）')
  ok(cleanPersons(['张三'], '').length === 0, 'B11 空原文 → 空（无原文可比）')
  const TRANS = '昨天碰见了阿依古丽·买买提，她说要来。'
  const tr = cleanPersons(['阿依古丽·买买提'], TRANS)
  ok(tr.length === 1 && tr[0] === '阿依古丽·买买提', 'B12 含「·」的译名放宽长度限制（≤12 字）', tr)
  const LONG = []
  for (let i = 0; i < 30; i++) LONG.push('名' + CHARS[i] + '字')
  ok(cleanPersons(LONG, LONG.join('，')).length === 20, 'B13 上限 20 条')
  ok(cleanPersons(['周末', '张三', '高兴', '王威'], TEXT).join(',') === '张三,王威', 'B14 混合输入只留真名')

  // ============================================================
  // C. personNames 本地人名表
  // ============================================================
  section('C. personNames（本地人名表）')
  ok(typeof personNames.addNames === 'function' && typeof personNames.getNames === 'function', 'C1 接口齐全')
  ok(personNames.KEY === 'person_names_v1', 'C2 存储键独立（person_names_v1）')
  personNames.clear()
  ok(personNames.getNames().length === 0, 'C3 初始为空')
  ok(personNames.addNames(['张三', '王威']) === 2, 'C4 新增 2 条返回 2')
  ok(personNames.getNames().join(',') === '张三,王威', 'C5 保序写入', personNames.getNames())
  ok(personNames.addNames(['张三']) === 0, 'C6 已存在 → 新增 0')
  ok(personNames.getNames().length === 2, 'C7 已存在不重复存')
  personNames.addNames(['李四'])
  ok(personNames.getNames()[0] === '李四', 'C8 最新保存的名字排最前（LRU 口径）', personNames.getNames())
  ok(personNames.addNames(['', '  ', '甲', 'x'.repeat(20), '王五']) === 1,
    'C9 空串/纯空白/单字/超长/ASCII 被过滤，只留「王五」', personNames.getNames())
  ok(personNames.addNames([]) === 0 && personNames.addNames(null) === 0, 'C10 空输入安全')
  personNames.clear()
  for (let i = 0; i < 70; i++) personNames.addNames(['名' + CHARS[i]])
  ok(personNames.getNames().length === personNames.MAX_NAMES, 'C11 上限 60 条', personNames.getNames().length)
  ok(personNames.getNames()[0] === '名' + CHARS[69], 'C12 最后一次新增仍在最前（未被截掉）')
  store[personNames.KEY] = 'not-an-array'
  ok(personNames.getNames().length === 0, 'C13 脏存储（非数组）→ 空表，不抛错')
  store[personNames.KEY] = [1, null, '张三', '张三', '  ']
  ok(JSON.stringify(personNames.getNames()) === '["张三"]', 'C14 数组内脏项被过滤去重', personNames.getNames())
  personNames.clear()
  ok(personNames.getNames().length === 0, 'C15 clear 生效')

  // ============================================================
  // D. hotwords 第四源（D 级低优先填充）
  // ============================================================
  section('D. hotwords 第四源（低优先填充 · 独立子预算）')
  ok(hotwords.PERSON_SUB_BUDGET === 30, 'D1 独立子预算导出 = 30 token')

  // D2 无档案无日记 → 人名被注入
  store['archives'] = []
  store['diaries'] = []
  personNames.clear()
  personNames.addNames(['张三', '王威'])
  let w = hotwords.get(true)
  ok(w.indexOf('张三') !== -1 && w.indexOf('王威') !== -1, 'D2 无干扰时人名被注入', w)

  // D3 排在高频词之后
  store['archives'] = [{ name: '王新伟', description: '' }]
  store['diaries'] = [
    { id: 'x1', content: '今天去健身房，健身房人不多', created_at: iso(0) },
    { id: 'x2', content: '又去了健身房，健身房气氛好', created_at: iso(1) }
  ]
  w = hotwords.get(true)
  ok(w.indexOf('王新伟') !== -1 && w.indexOf('健身房') !== -1, 'D3 档案词与高频词仍在', w)
  ok(w.indexOf('张三') > w.indexOf('健身房'), 'D4 人名排在档案/高频词**之后**（低优先）', w)

  // D5 独立子预算：人名总量 ≤ 30
  personNames.clear()
  const THREES = []
  for (let i = 0; i < 20; i++) THREES.push('名' + CHARS[i] + '字')
  personNames.addNames(THREES)
  store['archives'] = []
  store['diaries'] = []
  w = hotwords.get(true)
  const personTokens = w.filter(x => THREES.indexOf(x) !== -1).reduce((s, x) => s + hotwords.estTokens(x), 0)
  ok(personTokens <= hotwords.PERSON_SUB_BUDGET, 'D5 人名总量 ≤ 独立子预算（' + personTokens + ' ≤ 30）')
  ok(personTokens === 30, 'D6 子预算被精确用满（30 token = 6 个 3 字名）')
  ok(w.length === 6, 'D7 只注入 6 个人名（不越界）', w.length)

  // D8 主预算用尽 → 人名一个不进
  const MANY = []
  for (let i = 0; i < 33; i++) MANY.push({ name: '测试' + CHARS[i], description: '' }) // 3 字名 = 5 token
  storage.saveArchives(MANY)
  w = hotwords.get(true)
  const archCount = w.filter(x => x.indexOf('测试') === 0).length
  ok(archCount === 30, 'D8 档案词正好占满 150 token（30 × 5 = 150，[hotword-budget-150 v1]）', archCount)
  ok(w.filter(x => THREES.indexOf(x) !== -1).length === 0, 'D9 主预算用尽 → 人名一个都不注入（只填空余）', w)

  // D10 与草稿词去重
  store['archives'] = []
  store['diaries'] = []
  personNames.clear()
  personNames.addNames(['王威'])
  w = hotwords.get(true, { contextText: '今天王威来了' })
  ok(w.filter(x => x === '王威').length === 1, 'D10 人名与草稿词重复时只出现一次', w)

  // D11 无人名表 → 结果与改动前一致
  personNames.clear()
  store['archives'] = [{ name: '王新伟', description: '' }]
  w = hotwords.get(true)
  ok(w.length === 1 && w[0] === '王新伟', 'D11 无人名表时结果不受影响（零回归）', w)
  ok(hotwords.getLastCount().person === 0, 'D12 无注入时 person 计数为 0')

  // D13 getLastCount 计数
  personNames.clear()
  personNames.addNames(['张三'])
  hotwords.get(true)
  ok(hotwords.getLastCount().person === 1, 'D13 getLastCount().person 反映实际注入数')

  // D14 build() 同样走 D 级
  personNames.clear()
  personNames.addNames(['张三', '王威'])
  const built = hotwords.build({ contextText: '' })
  ok(built.words.indexOf('张三') !== -1, 'D14 build() 同样注入人名', built.words)
  ok(built.count.person >= 1, 'D15 build().count.person 计数存在', built.count)

  // D16 总预算仍 ≤ 150
  const total = built.words.reduce((s, x) => s + hotwords.estTokens(x), 0)
  ok(total <= hotwords.TOKEN_BUDGET, 'D16 总 token 仍 ≤ ' + hotwords.TOKEN_BUDGET + '（' + total + '）')

  // ============================================================
  // E. voice.js 时序（用户硬约束：不牺牲录音浮层出现时间）
  // ============================================================
  section('E. voice.js 时序（热词构建不占「按下→建连」期间）')

  // E-行为级：spy hotwords.get，验证「connectSocket 时尚未构建、onOpen 后才构建」
  let hwCalls = 0
  const origGet = hotwords.get
  hotwords.get = function () { hwCalls++; return origGet.apply(this, arguments) }

  const voiceMod = path.join(ROOT, 'utils/voice.js')
  delete require.cache[require.resolve(voiceMod)]
  const voice = require(voiceMod)

  const vcalls = { cloud: 0, connectSocket: 0, recorderStart: 0 }
  let vOpenCb = null
  const vManager = {
    onStart: (cb) => { vManager._s = cb },
    onStop: (cb) => { vManager._st = cb },
    onError: (cb) => { vManager._e = cb },
    onFrameRecorded: (cb) => { vManager._f = cb },
    onInterruptionBegin: () => {},
    start: () => { vcalls.recorderStart++ },
    stop: () => {}
  }
  const vTask = {
    onOpen: (cb) => { vOpenCb = cb },
    onClose: () => {}, onError: () => {}, onMessage: () => {},
    send: () => {}, close: () => {}
  }
  global.wx = {
    getSystemInfoSync: () => ({ platform: 'android' }),
    getSetting: (o) => { o.success({ authSetting: { 'scope.record': true } }) },
    cloud: { callFunction: () => { vcalls.cloud++; return Promise.resolve({ result: { apiKey: 'K' } }) } },
    authorize: (o) => { o.success() },
    connectSocket: () => { vcalls.connectSocket++; return vTask },
    getRecorderManager: () => vManager,
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    showToast: () => {}, showModal: () => {}, openSetting: () => {}
  }

  hwCalls = 0
  voice.start({ contextText: '把王威改成王伟' })
  await wait(80)
  ok(vcalls.recorderStart === 1, 'E1 录音已立即启动（不等建连）')
  ok(vcalls.connectSocket === 1, 'E2 WS 建连已发起')
  ok(hwCalls === 0, 'E3 按下→建连期间**未**构建热词（不占浮层渲染主线程）', hwCalls)
  vOpenCb && vOpenCb()
  await wait(30)
  ok(hwCalls >= 1, 'E4 握手成功（onOpen）后才构建热词 —— 发首帧前就绪', hwCalls)

  // E-静态：位置断言（先证明锚点存在，避免「-1 < n」恒真的假绿）
  const vSrc = fs.readFileSync(path.join(ROOT, 'utils/voice.js'), 'utf8')
  const iGet = vSrc.indexOf('hotwordList = hotwords.get(false')
  const iOpenFlag = vSrc.indexOf('socketOpen = true')
  const iConnect = vSrc.indexOf('task = wx.connectSocket({')
  const iOpenSocket = vSrc.indexOf('function openSocket(cfg) {')
  const iOnOpen = vSrc.indexOf('task.onOpen(() => {')
  ok(iGet > -1 && iOpenFlag > -1 && iConnect > -1 && iOpenSocket > -1 && iOnOpen > -1,
    'E5 五个位置锚点都存在（前置断言，防假绿）',
    { iGet, iOpenFlag, iConnect, iOpenSocket, iOnOpen })
  ok(iGet > iConnect, 'E6 热词构建在 connectSocket 之后（不在建连前同步执行）')
  ok(iGet > iOnOpen && iGet > iOpenSocket, 'E7 热词构建位于 onOpen 回调内（已移出关键路径）')
  ok(iGet > iOpenFlag, 'E8 热词构建在 socketOpen = true 之后（连接已就绪）')
  ok(vSrc.indexOf('预热热词基底') > -1, 'E9 warmup 里含热词基底预热（首次按下的 onOpen 直接命中缓存）')
  ok(vSrc.indexOf('function warmup() {') > -1 && vSrc.indexOf('预热热词基底') > vSrc.indexOf('function warmup() {'),
    'E10 预热写在 warmup 函数体内')

  hotwords.get = origGet // 还原 spy

  // ============================================================
  // F. 接线与契约
  // ============================================================
  section('F. 接线与契约')
  const wSrc = fs.readFileSync(path.join(ROOT, 'pages/write/write.js'), 'utf8')
  ok(wSrc.indexOf("require('../../utils/personNames.js')") > -1, 'F1 write.js 引入人名表模块')
  ok(wSrc.indexOf('personNames.addNames(result.persons)') > -1, 'F2 保存路径沉淀人名')
  ok(wSrc.indexOf('personNames.addNames(result.persons)') < wSrc.indexOf('if (!result.entities || result.entities.length === 0)'),
    'F3 沉淀发生在「无备案实体」早退**之前**（没有备案也能存人名）')

  const cSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/optimizeDiary/index.js'), 'utf8')
  ok(cSrc.indexOf('persons: cleanPersons(') > -1, 'F4 云函数返回 persons 字段')
  ok(cSrc.indexOf('"persons":["王磊","张三"]') > -1, 'F5 system prompt 声明 persons 输出契约')
  ok(cSrc.indexOf('【附加任务 · 与上面的 entities 完全独立，不得互相影响】') > -1,
    'F6 prompt 明确 persons 与 entities 解耦（备案链路不受影响）')
  ok(cSrc.indexOf('const cleanPersons = (raw, content) => {') > -1, 'F7 云函数做格式级清洗')
  ok(cSrc.indexOf("'{" + '"entities":[{"name":"王磊"') > -1, 'F8 entities 格式契约一字未动')

  // 老云函数兼容（typeof 前置短路，目标缺失时不调用、不崩）
  ok(typeof aiCloud.cleanPersonNames === 'function' &&
    JSON.stringify(aiCloud.cleanPersonNames(undefined, '今天和张三吃饭')) === '[]',
    'F9 老云函数（不返回 persons）→ 空数组，不报错、人名表不写入')

  console.log('\n===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
