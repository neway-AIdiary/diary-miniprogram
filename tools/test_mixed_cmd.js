/**
 * 行为测试：口语引导语 + 句尾指令（2026-09-22 真机 iPhone）
 *
 * 为什么需要这一套：
 *   用户语音说「把志伟改成杨志伟」，第一句「今天我来到志伟的办公室」里的「志伟」没被替换，
 *   指令句还留在正文里。探针实锤的三种形状（跑的就是线上那份 aiEdit.js）：
 *     把志伟改成杨志伟                  → 正常识别
 *     今天…彩蛋。把志伟改成杨志伟。      → 正常执行（前边有句号断开）
 *     你看，你看，我接着说，把志伟改成杨志伟。 → **判为叙述、0 条指令**（真机现场）
 *   机制：splitSentences 只按 。！？\n 切句、**不切逗号**，detect 又要求整句是纯指令。
 *   ASR（iOS 走录音文件识别，整段一次交付、标点由云端定）把指令用逗号黏在叙述后边 ⇒ 认不出。
 *   点【AI优化】时 extractEmbedded 用的是同一套切句与整句判定 ⇒ 第二条链路也认不出。
 *
 * 覆盖断言：
 *   A 组：句尾指令剥离（真机形状、各种断点、前缀保留、叙述保护、空值安全）
 *   B 组：两道保守闸（无正文不做 / 干跑闸 / 只切最后一个断点）
 *   C 组：extractEmbedded（优化时同样认得出，且失败不丢字）
 *   D 组：写日记页端到端（processInput：真的替换了、指令没落进正文、前缀保住）
 *   E 组：静态护栏（两个入口都传正文；没正文时早退）
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const WRITE = path.join(base, 'pages', 'write', 'write.js')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
function section(t) { console.log('\n== ' + t + ' ==') }
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8')

const AE = require(path.join(base, 'utils', 'aiEdit.js'))

// 红灯自检（还原源码、保留本测试）时新接口还不存在 —— 一律安全包装，
// 让「红」停在断言上，而不是以 TypeError 崩溃吃掉后面的断言。
const safeSplit = (t, o, c) => (typeof AE.splitCommands === 'function'
  ? AE.splitCommands(t, o, c)
  : { commands: [], narrative: String(t == null ? '' : t) })
const safeEmbed = (t) => (typeof AE.extractEmbedded === 'function'
  ? AE.extractEmbedded(t)
  : { content: String(t == null ? '' : t), applied: [], notFound: [], blocked: [], changed: false })

// 真机现场：正文第一句里有「志伟」
const BODY = '今天我来到志伟的办公室，我想告诉他几个彩蛋。'
const REAL = '你看，你看，我接着说，把志伟改成杨志伟。'

/* ============================================================
 * A 组：句尾指令剥离
 * ============================================================ */
section('A 句尾指令剥离（splitCommands 三参）')

const a1 = safeSplit(REAL, { loose: true }, BODY)
ok(a1.commands.length === 1, 'A-1 真机原句现在认得出 1 条指令（以前 0 条）', a1.commands)
ok(a1.commands[0] && a1.commands[0].type === 'replace', 'A-2 类型 = 替换', a1.commands[0])
ok(a1.commands[0] && a1.commands[0].from === '志伟' && a1.commands[0].to === '杨志伟',
  'A-3 目标词/新词解析正确', a1.commands[0])
ok(a1.narrative === '你看，你看，我接着说', 'A-4 引导语留作叙述（逗号顺带去掉）', a1.narrative)
ok(a1.narrative.indexOf('把志伟改成') < 0, 'A-5 叙述里不含指令字样', a1.narrative)
ok(!/[，,、：:；;…]$/.test(a1.narrative), 'A-6 叙述不以悬挂标点结尾', a1.narrative)

// 冒号变体：修复前会把「我接着说：把志伟」整个当目标词 ⇒ 既不执行又把这句丢掉
const a2 = safeSplit('我接着说：把志伟改成杨志伟。', { loose: true }, BODY)
ok(a2.commands.length === 1, 'A-7 冒号黏连同样认得出', a2.commands)
ok(a2.commands[0] && a2.commands[0].from === '志伟',
  'A-8 冒号变体不许把「我接着说：把志伟」整段当目标词', a2.commands[0])
ok(a2.narrative === '我接着说', 'A-9 冒号变体：前缀「我接着说」保留', a2.narrative)

// 其他断点
ok(safeSplit('我接着说 把志伟改成杨志伟。', { loose: true }, BODY).commands.length === 1,
  'A-10 空格断点（iOS 常见）也认得出')
ok(safeSplit('我接着说他；把志伟改成杨志伟。', { loose: true }, BODY).commands.length === 1,
  'A-11 分号断点也认得出')

// 原有能力零回归
const a3 = safeSplit('我来到公司。把志伟改成杨志伟。', { loose: true }, BODY)
ok(a3.commands.length === 1 && a3.narrative.indexOf('我来到公司') >= 0,
  'A-12 有句号的原形状照旧（前句留作叙述）', a3.narrative)
const a4 = safeSplit('把志伟改成杨志伟', { loose: true }, BODY)
ok(a4.commands.length === 1 && a4.narrative === '', 'A-13 纯指令形状逐字不变', a4)
ok(safeSplit('，把志伟改成杨志伟。', { loose: true }, BODY).commands.length === 1,
  'A-14 整句以断点开头（前缀为空）也执行 —— 尾段是纯指令')

// 只切最后一个断点：前缀必须完整，不能被切碎
const a5 = safeSplit('你看，你看，我接着说，把志伟改成杨志伟。', { loose: true }, BODY)
ok(a5.narrative === '你看，你看，我接着说', 'A-15 只切最后一个断点：前缀完整保留', a5.narrative)
ok(a5.narrative !== '你看', 'A-16 前缀没有在第一个逗号处被切碎', a5.narrative)

// 叙述保护：不许把叙述拆出指令来乱执行
const keeps = [
  ['我跟他说，把手机收起来。', '把手机收起来（不在动词表）'],
  ['今天有点累，把不存在的词删掉。', '目标词正文里没有'],
  ['今天下午在公园散步，柳树都发芽了。', '纯叙述'],
  ['我一直在想，把最后一句删掉是不是更好。', '句尾不是纯指令'],
  ['明天要把计划补充完整，今天早点睡。', '叙述 + 补全动词']
]
keeps.forEach(function (c) {
  const r = safeSplit(c[0], { loose: true }, BODY)
  ok(r.commands.length === 0, 'A-17 叙述不被拆出指令：' + c[1], r.commands)
  ok(r.narrative.indexOf(c[0].replace(/[。]$/, '')) >= 0,
    'A-18 叙述句完整保留（零丢字）：' + c[1], r.narrative)
})

// 幂等 / 无副作用 / 空值安全
const before = BODY
safeSplit(REAL, { loose: true }, BODY)
ok(BODY === before, 'A-19 拆分过程不改动传入的正文')
ok(JSON.stringify(safeSplit(REAL, { loose: true }, BODY)) === JSON.stringify(a1),
  'A-20 同输入同结果（幂等）')
ok(safeSplit('', {}, BODY).commands.length === 0, 'A-21 空字符串安全')
ok(safeSplit(null, {}, BODY).commands.length === 0, 'A-22 null 安全')
ok(safeSplit(undefined, {}, BODY).narrative === '', 'A-23 undefined 安全')

/* ============================================================
 * B 组：两道保守闸
 * ============================================================ */
section('B 两道保守闸')

// 闸一：不给正文 ⇒ 该能力关闭（旧调用行为逐字不变，零回归）
const b1 = safeSplit(REAL, { loose: true })
ok(b1.commands.length === 0, 'B-1 不传正文 ⇒ 不做句尾剥离（旧行为）', b1.commands)
ok(b1.narrative === REAL, 'B-2 不传正文 ⇒ 整句按叙述（与旧版逐字相同）', b1.narrative)
ok(safeSplit(REAL, { loose: true }, null).commands.length === 0, 'B-3 传 null 正文同样关闭')
ok(safeSplit(REAL, { loose: true }, undefined).commands.length === 0, 'B-4 传 undefined 正文同样关闭')

// 闸二：干跑 —— 正文里必须真能找到目标才认（误判的代价只能是「没执行」，绝不是丢字）
const b5 = safeSplit('今天有点累，把不存在的词删掉。', { loose: true }, BODY)
ok(b5.commands.length === 0 && b5.narrative.indexOf('不存在的词') >= 0,
  'B-5 干跑失败 ⇒ 不认这条指令，整句留作叙述', b5.narrative)
const b6 = safeSplit('我接着说，把志伟改成杨志伟。', { loose: true }, '今天天气不错，心情很好。')
ok(b6.commands.length === 0 && b6.narrative.indexOf('把志伟改成杨志伟') >= 0,
  'B-6 正文里没有「志伟」⇒ 不执行且一个字都不丢', b6.narrative)

// 位置删句类指令（changed 恒真）也能从句尾剥离出来
const b7 = safeSplit('我接着说，把最后一句删掉。', { loose: true }, BODY)
ok(b7.commands.length === 1 && b7.commands[0].type === 'removeSent',
  'B-7 句尾的位置删句指令同样认得出', b7.commands)

// 明确拒绝的整段删除（拦下、不执行、句子保留）
const b8 = safeSplit('我接着说，把前边所有内容删掉。', { loose: true }, BODY)
ok(b8.commands.length === 0 && b8.narrative.indexOf('把前边所有内容删掉') >= 0,
  'B-8 被拒绝的「前边所有内容」不会被句尾剥离放行', b8.narrative)

/* ============================================================
 * C 组：extractEmbedded（点【AI优化】时的内嵌指令提取）
 * ============================================================ */
section('C extractEmbedded（优化时）')

const cContent = '今天我来到志伟的办公室，我想告诉他几个彩蛋。' + REAL
const c1 = safeEmbed(cContent)
ok(c1.changed === true, 'C-1 优化时也认得出（修复前 changed=false）', c1.applied.length)
ok(c1.content.indexOf('杨志伟的办公室') >= 0, 'C-2 正文里的「志伟」被替换', c1.content)
ok(c1.content.indexOf('把志伟改成杨志伟') < 0, 'C-3 指令尾段被吃掉（不写进日记）', c1.content)
ok(c1.content.indexOf('你看，你看，我接着说') >= 0, 'C-4 引导语保留（用户自己写的内容）', c1.content)
ok(c1.content.indexOf('我想告诉他几个彩蛋') >= 0, 'C-5 其余正文原样', c1.content)

const c2 = safeEmbed('今天天气不错，把不存在的词删掉。')
ok(c2.changed === false && c2.content === '今天天气不错，把不存在的词删掉。',
  'C-6 干跑失败：正文逐字不变（不丢字）', c2.content)

// 既有能力零回归
const c3 = safeEmbed('王伟来找我。不是王伟，是王维。')
ok(c3.content === '王维来找我。', 'C-7 既有纯指令句路径逐字不变', c3.content)
const c4 = safeEmbed('今天很好。把前边所有内容删掉。')
ok(c4.changed === false && c4.blocked.length === 1 && c4.content.indexOf('把前边所有内容删掉') >= 0,
  'C-8 「前边所有内容」仍被拦下且句子保留', c4)
const c5 = safeEmbed('今天很好，明天把计划写完。')
ok(c5.changed === false && c5.content === '今天很好，明天把计划写完。',
  'C-9 带逗号的叙述句一个字不动', c5.content)

/* ============================================================
 * D 组：写日记页端到端（processInput）
 * ============================================================ */
function runProcessInput(content, text) {
  return new Promise(function (resolve) {
    Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })

    const store = {}
    const sink = { toasts: [], cloud: [], errors: [] }

    global.wx = {
      getStorageSync: (k) => (k in store ? store[k] : ''),
      setStorageSync: (k, v) => { store[k] = v },
      removeStorageSync: (k) => { delete store[k] },
      getStorageInfoSync: () => ({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }),
      showToast: (o) => { sink.toasts.push((o && o.title) || '') },
      hideToast: () => {},
      showLoading: () => {},
      hideLoading: () => {},
      showModal: () => {},
      navigateTo: () => {},
      redirectTo: () => {},
      getSystemInfoSync: () => ({ platform: 'ios', windowWidth: 375, windowHeight: 700 }),
      onThemeChange: () => {},
      getFileSystemManager: () => ({ readFile: () => {}, stat: () => {} }),
      cloud: { callFunction: () => Promise.resolve({ result: {} }) }
    }
    global.getApp = () => ({ globalData: {} })

    let pageObj = null
    global.Page = (o) => { pageObj = o }

    const realErr = console.error
    const realWarn = console.warn
    console.error = (...a) => { sink.errors.push(a.map((x) => String(x)).join(' ')) }
    console.warn = (...a) => { sink.errors.push(a.map((x) => String(x)).join(' ')) }
    const restore = () => { console.error = realErr; console.warn = realWarn }

    const dir = path.join(base, 'pages', 'write')
    const fakeRequire = (p) => require(path.resolve(dir, p))

    try {
      const src = fs.readFileSync(WRITE, 'utf8')
      const wrapper = vm.runInThisContext(
        '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'write.js' })
      wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
    } catch (e) {
      restore()
      return resolve({ loadError: String(e && e.message), sink, page: null })
    }
    if (!pageObj) { restore(); return resolve({ loadError: 'Page 未注册', sink, page: null }) }

    const page = Object.create(pageObj)
    page.data = Object.assign({}, pageObj.data, { content: content, media: [], mood: '' })
    page.setData = function (d) { Object.assign(this.data, d) }

    try {
      page.processInput(text, true)
    } catch (e) {
      restore()
      return resolve({ loadError: String(e && e.message), sink, page: page })
    }
    setTimeout(() => { restore(); resolve({ sink, page, loadError: null }) }, 60)
  })
}

async function groupD() {
  section('D 写日记页端到端（processInput）')

  const D = await runProcessInput(BODY, REAL)
  ok(D.loadError === null, 'D-1 写日记页可正常加载', D.loadError)
  const got = String(D.page && D.page.data.content)
  ok(got.indexOf('杨志伟的办公室') >= 0, 'D-2 第一句里的「志伟」→「杨志伟」（用户报的那个 bug）', got)
  ok(got.indexOf('把志伟改成杨志伟') < 0, 'D-3 指令句不再落进正文', got)
  ok(got.indexOf('你看，你看，我接着说') >= 0, 'D-4 引导语「我接着说」保留在正文里', got)
  ok(got.indexOf('我想告诉他几个彩蛋') >= 0, 'D-5 原有正文没被动', got)
  ok(String((D.page && D.page.data.highlight && D.page.data.highlight.title) || '').indexOf('已修改') >= 0,
    'D-6 高亮说明是「已修改：…」（当场可感知）',
    D.page && D.page.data.highlight && D.page.data.highlight.title)
  ok(D.sink.toasts.join('|').indexOf('找不到') < 0, 'D-7 没有「找不到」的误导提示', D.sink.toasts)

  // 干跑闸在页面层：目标不存在 ⇒ 不执行、也不丢字
  const D2 = await runProcessInput(BODY, '今天有点累，把不存在的词删掉。')
  const got2 = String(D2.page && D2.page.data.content)
  ok(got2.indexOf('不存在的词') >= 0, 'D-8 目标不存在：整句照旧落进正文（一个字不丢）', got2)
  ok(got2.indexOf('今天有点累') >= 0, 'D-9 引导语也没有丢', got2)

  // 纯叙述照常追加
  const D3 = await runProcessInput(BODY, '今天下午在公园散步，柳树都发芽了。')
  ok(String(D3.page && D3.page.data.content).indexOf('柳树都发芽了') >= 0,
    'D-10 纯叙述照常追加', D3.page && D3.page.data.content)

  // 另一条语音入口（详情页）必须同口径 —— 静态断言见 E 组
}

/* ============================================================
 * E 组：静态护栏
 * ============================================================ */
function groupE() {
  section('E 静态护栏')
  const ae = read('utils/aiEdit.js')
  const wj = read('pages/write/write.js')
  const dt = read('pages/detail/detail.js')

  ok(ae.indexOf('function splitCommands(text, opts, content) {') >= 0, 'E-1 splitCommands 接住正文参数')
  ok(ae.indexOf('const tail = detectTailCommand(s, opts, content)') >= 0, 'E-2 实时链路接句尾指令')
  ok(ae.indexOf('const tail = detectTailCommand(s, undefined, narrative)') >= 0, 'E-3 优化链路接句尾指令')
  ok(ae.indexOf('if (content === undefined || content === null) return null') >= 0,
    'E-4 没正文就整体不做（零回归闸）')
  ok(ae.indexOf('if (!apply(String(content), edit).changed) return null') >= 0,
    'E-5 干跑闸已落盘（找不到目标不认）')
  ok(ae.indexOf('narrative = res.content + lead') >= 0, 'E-6 引导语留在正文里（优化链路）')
  ok(ae.indexOf('narrative += tail.lead') >= 0, 'E-7 引导语留在叙述里（实时链路）')
  ok(wj.indexOf('aiEdit.splitCommands(trimmed, loose, this.data.content)') >= 0,
    'E-8 写日记页传出当前正文')
  ok(dt.indexOf('aiEdit.splitCommands(trimmed, loose, this.data.content)') >= 0,
    'E-9 详情页同口径传出当前正文（两个语音入口一致）')
  ok(ae.indexOf("const parts = String(text || '').split(/([。！？!?\\n])/)") >= 0,
    'E-10 切句规则没被改动（仍只认 。！？\\n）')
  ok(ae.indexOf('：:；;…改换该') >= 0, 'E-11 裸替换的目标词排除句内断点')
}

;(async () => {
  await groupD()
  groupE()
  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail)
  process.exit(fail ? 1 : 0)
})()
