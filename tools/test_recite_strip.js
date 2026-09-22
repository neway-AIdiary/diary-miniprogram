/**
 * 行为测试：「补充指令」不许留在正文里（2026-09-22 真机实例）
 *
 * 为什么需要这一套：
 *   用户在写日记页写「天高云淡，望断南飞雁。不到长城非好汉，屈指行程二万。帮我把这首词补充完整。」
 *   点【AI 优化】→ 词确实补全了（很好），但「帮我把这首词补充完整。」这句指令**留在了正文里**。
 *   根因两处，缺一不可：
 *     ① 锚点断链：判定链是「触发词 AND 素材锚点」，「补充完整」命中了触发词，但锚点六路全不中 ——
 *        A 书名号 ✗ / B 池内篇名 ✗（池里没有《清平乐·六盘山》）/ C 引号句 ✗ /
 *        D 人名 ✗（作者库里没有毛泽东）/ E 文体词 ✗（GENRE_WORDS 刻意不收光杆的「词」）/
 *        F 名句片段 ✗ ⇒ reason='no-anchor' ⇒ **静默退回普通润色**；
 *     ② 普通润色链路没有任何一处剥指令句（aiEdit 只管删/改/换，quoteAsk.strip 只在素材通道里跑），
 *        指令句作为正文的一部分被 AI 一起润色着送回，点【应用】后落进日记。
 *
 * 覆盖断言：
 *   A 组：锚点 G（指代 + 文体）正例/反例与目标解析（改 2）
 *   B 组：commandSents / stripCommands 单元 —— 两条腿、叙述句保护、剥空保护、幂等、空值安全（改 1）
 *   C 组：行为 —— 普通润色通道回来的优化稿不含指令句（正文不受影响 + 要点如实说明）
 *   D 组：行为 —— 这句真机输入现在进得了 recite 通道，且发给云端的正文已剥指令
 *   E 组：行为 —— recite 拒答降级到普通润色，优化稿同样不含指令句
 *   S 组：静态护栏
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

const Q = require(path.join(base, 'utils', 'quoteAsk.js'))

// 红灯自检（还原源码、保留本测试）时这些接口还不存在 —— 一律走安全包装，
// 让「红」停在断言上，而不是以 TypeError 崩溃吃掉后面的断言。
const safeCmd = (t) => (typeof Q.commandSents === 'function' ? Q.commandSents(t) : [])
const safeStrip = (t, c) => (typeof Q.stripCommands === 'function' ? Q.stripCommands(t, c) : t)
const safeGenre = (t) => (typeof Q.pickAnteGenre === 'function' ? Q.pickAnteGenre(t) : '')

// 真机现场那句
const USER = '天高云淡，望断南飞雁。不到长城非好汉，屈指行程二万。帮我把这首词补充完整。'
const USER_BODY = '天高云淡，望断南飞雁。不到长城非好汉，屈指行程二万'

/* ============================================================
 * A 组：锚点 G（指代 + 文体）
 * ============================================================ */
section('A 锚点 G：指代 + 文体')

ok(typeof Q.ANTE_PIECE_RE === 'object' && Q.ANTE_PIECE_RE instanceof RegExp,
  'A-1 ANTE_PIECE_RE 已导出')
ok(Array.isArray(Q.ANTE_GENRES) && Q.ANTE_GENRES.indexOf('词') >= 0 && Q.ANTE_GENRES.indexOf('话') < 0,
  'A-1b 文体白名单：收「词」不收「话」（「这句话」不算素材对象）', Q.ANTE_GENRES)
ok(typeof Q.pickAnteGenre === 'function' &&
  safeGenre('这首词') === '词' && safeGenre('这句诗词') === '诗词',
  'A-1c pickAnteGenre 按最长命中取文体（不靠正则组序号）',
  safeGenre('这句诗词'))

const dUser = Q.detect(USER)
ok(dUser.hit === true, 'A-2 真机输入现在命中（以前 no-anchor 静默退回普通润色）', dUser.reason)
ok(dUser.reason === 'ok', 'A-3 reason 为 ok', dUser.reason)
ok(dUser.mode === 'full', 'A-4 范围 = 全文（要完整内容）', dUser.mode)
ok(dUser.kind === 'poem', 'A-5 类别 = 古典诗文', dUser.kind)
ok(dUser.target.genre === '词', 'A-6 「这首词」→ 文体=词（后续 kind/长度档/加载文案都要用）', dUser.target)
ok(dUser.target.title === '', 'A-7 不许把「词」当篇名塞进 title', dUser.target.title)
ok(dUser.target.snippet === '' && dUser.target.author === '' && dUser.target.person === '',
  'A-8 无作者/人物/片段（不许臆造）', dUser.target)
ok(dUser.anchors.some(a => a.type === 'G'), 'A-9 锚点 G 命中', dUser.anchors)

const cleanUser = Q.strip(USER, dUser)
ok(cleanUser === USER_BODY, 'A-10 素材通道剥指令后 = 词的前半阕（无指令、无悬空标点）', cleanUser)
ok(cleanUser.indexOf('补充完整') < 0, 'A-11 净正文不含指令词', cleanUser)

// 指代 + 文体 的写法矩阵
;[['这首诗帮我补充完整', 'full', 'poem'],
['帮我补全那阕词', 'full', 'poem'],
['这句名言帮我补充一下', 'full', 'quote']].forEach(function (c) {
  const r = Q.detect(c[0])
  ok(r.hit === true, 'A-12 正例命中：' + c[0], r.reason)
  ok(r.mode === c[1] && r.kind === c[2], 'A-13 范围/类别：' + c[0], r.mode + '/' + r.kind)
})

// 反例回归：改文对象、无指向、非指令，一律不许被 G 收编
;[['把这段话补充完整', 'neg-text-obj'],
['把这句话补充一下', 'neg-text-obj'],
['这段文字帮我补充完整', 'neg-text-obj'],
['这段内容再补充完整些', 'neg-text-obj'],
['补充一下明天要做的事', 'no-anchor'],
['帮我补充一下今天的支出记录', 'no-anchor'],
['明天要把工作计划补充完整吗', 'no-anchor'],
['这首诗我很喜欢', 'no-trigger']].forEach(function (c) {
  const r = Q.detect(c[0])
  ok(r.reason === c[1], 'A-14 反例仍然拦下：' + c[0] + ' → ' + c[1], r.reason)
})
const rThatPoem = Q.detect('我喜欢的那句诗词帮我补充一下')
ok(rThatPoem.target.person === '', 'A-15 指代词不是人物（「那句诗词」person 必须为空）', rThatPoem.target)

/* ============================================================
 * B 组：commandSents / stripCommands
 * ============================================================ */
section('B 指令句定位与剥离（单元）')

ok(typeof Q.commandSents === 'function' && typeof Q.stripCommands === 'function',
  'B-1 两个新接口已导出')

const cmdsUser = safeCmd(USER)
ok(cmdsUser.length === 1, 'B-2 真机正文里认出 1 条指令句', cmdsUser)
ok(cmdsUser[0] && cmdsUser[0].text === '帮我把这首词补充完整',
  'B-3 命中的就是那句指令（不含句号）', cmdsUser)

// 叙述句保护：日记正文里「补充完整」并不罕见，绝不能被当成指令删掉
;[['明天要把计划补充完整。今天早点睡。', '明天计划'],
['今天终于把材料补充完整了，好累。', ''],
['我今天补了牙。', ''],
['今天在公司忙了一整天，晚上回家做了饭。', '']].forEach(function (c) {
  const got = safeCmd(c[0])
  ok(got.length === 0, 'B-4 叙述句不算指令：' + c[0].slice(0, 12) + '…', got.map(x => x.text))
})

// 纯求助句（整句就是指令）必须能认出来 —— 这是「没命中素材锚点」时的兜底
ok(safeCmd('帮我补充全文。').length === 1, 'B-5 纯求助句「帮我补充全文」算指令')
ok(safeCmd('尼采说过那句关于生活的什么话来着，你帮我补充一下').length >= 1,
  'B-6 检索句形算指令（凭据是句形本身）')

// stripCommands：原样带回 / 小幅改写 / 不误删 / 剥空保护
ok(safeStrip('天高云淡。帮我把这首词补充完整。', cmdsUser) === '天高云淡',
  'B-7 原样带回的指令句被剥掉（连带悬空句号）',
  safeStrip('天高云淡。帮我把这首词补充完整。', cmdsUser))
ok(safeStrip('天高云淡。帮我把这首词补充完整吧。', cmdsUser) === '天高云淡',
  'B-8 小幅改写（「…补充完整吧」）也认得出（靠 G + 触发词这条腿）',
  safeStrip('天高云淡。帮我把这首词补充完整吧。', cmdsUser))
const keep = '今天在公司忙了一整天，晚上回家做了饭。'
ok(safeStrip(keep, cmdsUser) === keep, 'B-9 优化稿里没有指令句 ⇒ 一个字都不动', safeStrip(keep, cmdsUser))
const narrative = '明天要把计划补充完整。今天早点睡。'
ok(safeStrip(narrative, safeCmd(narrative)) === narrative,
  'B-10 叙述句不会被误删（保守口径）', safeStrip(narrative, safeCmd(narrative)))
const onlyCmd = '帮我把这首词补充完整。'
ok(String(safeStrip(onlyCmd, safeCmd(onlyCmd))).trim().length > 0,
  'B-11 剥空则原样返回 —— 面板绝不能变成空白', safeStrip(onlyCmd, safeCmd(onlyCmd)))
ok(safeStrip('', []) === '' && safeStrip(null, null) === '',
  'B-12 空值安全')
const once = safeStrip('天高云淡。帮我补充全文。', safeCmd('帮我补充全文。'))
ok(safeStrip(once, safeCmd('帮我补充全文。')) === once,
  'B-13 幂等：剥两次与剥一次同结果', once)

/* ============================================================
 * 行为脚手架（照 test_recite_flow.js）
 * ============================================================ */
function runOptimizeClick(content, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })

    const store = {}
    const sink = { toasts: [], cloud: [], calls: [], errors: [] }

    global.wx = {
      getStorageSync: (k) => (k in store ? store[k] : ''),
      setStorageSync: (k, v) => { store[k] = v },
      removeStorageSync: (k) => { delete store[k] },
      getStorageInfo: (o) => { o && o.success && o.success({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }) },
      getStorageInfoSync: () => ({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }),
      showToast: (o) => { sink.toasts.push((o && o.title) || '') },
      hideToast: () => {},
      showLoading: () => {},
      hideLoading: () => {},
      showModal: () => {},
      navigateTo: () => {},
      redirectTo: () => {},
      getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 375, windowHeight: 700 }),
      onThemeChange: () => {},
      getFileSystemManager: () => ({ readFile: () => {}, stat: () => {} }),
      cloud: {
        callFunction: (opt) => {
          const action = (opt && opt.data && opt.data.action) || ''
          sink.calls.push({
            action: action,
            content: (opt && opt.data && opt.data.content) || '',
            payload: (opt && opt.data && opt.data.payload) || null
          })
          sink.cloud.push(action)
          if (opts.respond) return Promise.resolve(opts.respond(opt))
          return Promise.resolve({ result: {} })
        }
      }
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
      return resolve({ loadError: String(e && e.message), sink, store, page: null })
    }
    if (!pageObj) { restore(); return resolve({ loadError: 'Page 未注册', sink, store, page: null }) }

    const page = Object.create(pageObj)
    page.data = Object.assign({}, pageObj.data, { content: content, media: [], diaryDate: '2026-09-22', mood: '' })
    page.setData = function (d) { Object.assign(this.data, d) }

    page.onOptimize()
    setTimeout(() => { restore(); resolve({ sink, store, page, loadError: null }) }, 260)
  })
}

const toastText = (sink) => sink.toasts.join(' | ')
const notesText = (page) => ((page && page.data && page.data.optimizeChanges) || []).join(' | ')

/* ============================================================
 * C 组：普通润色通道（无素材锚点）—— 优化稿不含指令句
 * ============================================================ */
async function groupC() {
  section('C 普通润色通道：优化稿不含指令句')
  // 这段正文：没有指代+文体、没有书名号/人名/文体词 ⇒ 必然走普通润色；「帮我补充一下」是明确指令
  const SRC = '今天下午在公园散步，柳树都发芽了，心情不错。帮我补充一下。'
  const POLISHED = '今天下午在公园散步，柳树都发芽了，心情不错。帮我补充一下。这是润色后的句子。'

  const C = await runOptimizeClick(SRC, {
    respond: (opt) => {
      const action = (opt && opt.data && opt.data.action) || ''
      if (action === 'recite') return { result: { error: '不该走到 recite' } }
      return { result: { optimized: POLISHED, changes: ['调整了语序'] } }
    }
  })
  ok(C.loadError === null, 'C-1 写日记页可正常加载', C.loadError)
  ok(C.sink.cloud.indexOf('optimize') >= 0 && C.sink.cloud.indexOf('recite') < 0,
    'C-2 走的是普通润色通道（无素材锚点）', C.sink.cloud)
  const optCall = (C.sink.calls || []).filter(c => c.action === 'optimize')[0]
  ok(!!optCall && optCall.content === SRC,
    'C-3 发给云端的是用户原文（指令是正文的一部分，本次不去改它）', optCall && optCall.content)
  const got = String(C.page && C.page.data.optimizedContent)
  ok(got.indexOf('补充一下') < 0, 'C-4 优化稿里不再残留指令句', got)
  ok(got.indexOf('这是润色后的句子') >= 0, 'C-5 润色正文照常保留', got)
  ok(C.page && C.page.data.content === SRC, 'C-6 只动优化稿：正文原样不动', C.page && C.page.data.content)
  ok(C.page && C.page.data.originalContent === SRC, 'C-7 「原文」对照仍是用户写的原样（含指令）',
    C.page && C.page.data.originalContent)
  ok(notesText(C.page).indexOf('不写进正文') >= 0, 'C-8 优化要点如实说明去掉了指令句', notesText(C.page))
  ok(notesText(C.page).indexOf('调整了语序') >= 0, 'C-9 云端要点没被顶掉', notesText(C.page))
  ok(toastText(C.sink).indexOf('需要连接 AI 服务') < 0, 'C-10 不谎报连接故障', C.sink.toasts)

  // 反面：正文里没有指令句 ⇒ 一个字都不许动（避免误删正常日记）
  const C2 = await runOptimizeClick('今天下午在公园散步，柳树都发芽了，心情不错。明天要把计划补充完整。', {
    respond: () => ({ result: { optimized: '今天下午在公园散步，柳树都发芽了，心情不错。明天要把计划补充完整。' } })
  })
  ok(C2.page && C2.page.data.optimizedContent ===
    '今天下午在公园散步，柳树都发芽了，心情不错。明天要把计划补充完整。',
    'C-11 叙述句「明天要把计划补充完整」不许被当指令删掉',
    C2.page && C2.page.data.optimizedContent)
  ok(notesText(C2.page).indexOf('不写进正文') < 0, 'C-12 没剥东西时不写那句说明', notesText(C2.page))
}

/* ============================================================
 * D 组：真机那句现在进得了 recite 通道
 * ============================================================ */
async function groupD() {
  section('D 真机输入 → 素材补全通道')
  const RECITED = '六盘山上高峰，红旗漫卷西风。今日长缨在手，何时缚住苍龙？'
  const D = await runOptimizeClick(USER, {
    respond: (opt) => {
      const action = (opt && opt.data && opt.data.action) || ''
      if (action === 'recite') return { result: { recited: RECITED, source: '毛泽东《清平乐·六盘山》' } }
      return { result: { optimized: '不该走到普通润色：' + (opt && opt.data && opt.data.content) } }
    }
  })
  ok(D.loadError === null, 'D-1 页面可正常加载', D.loadError)
  ok(D.sink.cloud.indexOf('recite') >= 0, 'D-2 走的是 recite 通道（改 2 的核心收益）', D.sink.cloud)
  ok(D.sink.cloud.indexOf('optimize') < 0, 'D-3 不再误走普通润色', D.sink.cloud)
  const call = (D.sink.calls || []).filter(c => c.action === 'recite')[0]
  ok(!!call && call.content.indexOf('补充完整') < 0,
    'D-4 发给云端的正文已剥指令句（云端只查原文与出处）', call && call.content)
  ok(!!call && call.content.indexOf('屈指行程二万') >= 0, 'D-5 用户已写的半阕照样给云端当上下文', call && call.content)
  ok(!!call && call.payload && call.payload.target && call.payload.target.genre === '词',
    'D-6 payload 带文体「词」', call && call.payload && call.payload.target)
  ok(!!call && call.payload && call.payload.mode === 'full' && call.payload.kind === 'poem',
    'D-7 payload 范围 full / 类别 poem', call && call.payload)
  const got = String(D.page && D.page.data.optimizedContent)
  ok(got.indexOf('何时缚住苍龙') >= 0, 'D-8 补全内容进了优化稿', got)
  ok(got.indexOf('—— 毛泽东《清平乐·六盘山》') >= 0, 'D-9 出处行按「—— 出处」拼接', got)
  ok(got.indexOf('补充完整') < 0, 'D-10 优化稿里没有指令句', got)
  ok(D.page && D.page.data.content === USER, 'D-11 正文未被改写（等用户点【应用】）', D.page && D.page.data.content)
}

/* ============================================================
 * E 组：recite 拒答 → 降级普通润色，仍不含指令句
 * ============================================================ */
async function groupE() {
  section('E 补全未成降级：优化稿仍不含指令句')
  const E = await runOptimizeClick(USER, {
    respond: (opt) => {
      const action = (opt && opt.data && opt.data.action) || ''
      if (action === 'recite') return { result: { error: '未能确认出处' } }
      return { result: { optimized: String((opt && opt.data && opt.data.content) || '') + '（已润色）' } }
    }
  })
  ok(E.sink.cloud.indexOf('recite') >= 0 && E.sink.cloud.indexOf('optimize') >= 0,
    'E-1 补全未成后自动接了一次普通润色', E.sink.cloud)
  ok(E.page && E.page.data.showOptimizeResult === true, 'E-2 面板照样弹出（不阻断）',
    E.page && E.page.data.showOptimizeResult)
  const optCall = (E.sink.calls || []).filter(c => c.action === 'optimize')[0]
  ok(!!optCall && optCall.content.indexOf('补充完整') < 0,
    'E-3 降级润色的正文也不含指令句（clean 已剥）', optCall && optCall.content)
  const got = String(E.page && E.page.data.optimizedContent)
  ok(got.indexOf('已润色') >= 0 && got.indexOf('补充完整') < 0,
    'E-4 面板优化稿有内容且无指令句', got)
  ok(notesText(E.page).indexOf('素材补全未成') >= 0, 'E-5 未补全原因如实保留', notesText(E.page))
}

/* ============================================================
 * S 组：静态护栏
 * ============================================================ */
function groupS() {
  section('S 静态护栏')
  const wj = read('pages/write/write.js')
  const qs = read('utils/quoteAsk.js')
  ok(wj.indexOf('quoteAsk.commandSents(content)') >= 0, 'S-1 润色前记录正文指令句')
  ok(wj.indexOf('quoteAsk.stripCommands(optimized, cmdSents)') >= 0, 'S-2 优化稿返回前剥指令句')
  ok(wj.indexOf('不写进正文') >= 0, 'S-3 优化要点里如实说明')
  ok(qs.indexOf('function commandSents(text) {') >= 0 && qs.indexOf('function stripCommands(text, commands) {') >= 0,
    'S-4 两个新函数已落盘')
  ok(qs.indexOf('const ANTE_PIECE_RE =') >= 0, 'S-5 锚点 G 的判定正则已落盘')
  ok(qs.indexOf('if (!isPronounCore(commandCore(s.text, []))) return') >= 0,
    'S-6 叙述句保护闸（实义核心必须只指内容）已落盘')
  // 云函数这次不需要改：G 锚点走既有 recite 通道
  const cf = read('cloudfunctions/optimizeDiary/index.js')
  ok(cf.indexOf("if (t.genre) lines.push") >= 0, 'S-7 云函数已支持 target.genre（本批无需改云函数）')
}

;(async () => {
  await groupC()
  await groupD()
  await groupE()
  groupS()
  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail)
  process.exit(fail ? 1 : 0)
})()
