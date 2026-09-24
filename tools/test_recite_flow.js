/**
 * 行为测试：写日记页「素材补全（recite）失败」不得阻断用户
 *
 * 为什么需要这一套：
 *   2026-09-20 用户实测点【AI 优化】输入「尼采说过那句关于生活的什么话来着，你帮我补充一下」，
 *   弹出「补全诗文需要连接 AI 服务，请稍后重试」且**结果面板不出现**（用户被堵死）。
 *   根因有两处，都不是「连接问题」：
 *     ① 纯求助句剥离指令后**净正文为空**，客户端把空串发给云端 → 云函数第一道闸
 *        `if (!body) return { error: '内容为空' }` 直接拒绝 → 客户端落进本地降级 →
 *        被写成「需要连接 AI 服务」的假故障（重新部署云函数也修不好）；
 *     ② 降级分支只弹 toast 就 return，「点了按钮没有响应」比提示不准确更严重。
 *
 * 覆盖断言：
 *   1) 净正文为空时，发给云端的 content **不得为空**（根因回归）
 *   2) 云端拒答 → 结果面板照样弹出 + 提示说明真实原因（不再冒充连接故障）
 *   3) 真·连不上（callFunction reject）→ 面板照样弹出，提示区分「连接失败」
 *   4) 净正文够长 → 自动转普通润色继续（用户拍板的 1 号方案）
 *   5) 云端正常给内容 → 正常进优化稿（含出处行），不误降级
 *   6) 静态护栏：云函数判空放宽 / aiCloud 降级带 offline 标志 / write.js 兜底存在
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const WRITE = path.join(base, 'pages', 'write', 'write.js')

// [ai-usage v1] optimizeDiary 引入了 wx-server-sdk（服务端用量记账）。本套件第 7 节直接
// require 云函数源码跑判空闸行为测试——未配置 DEEPSEEK_API_KEY 时 main 早退、不触网络，
// 桩只需让模块可加载（与 test_ai_usage.js 同款 Module._load 劫持，进程内生效）
const Module = require('module')
const __origModuleLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    const col = {
      where: function () { return col },
      add: async function () { return { _id: 'stub' } },
      doc: function () { return { update: async function () { return {} } } },
      limit: function () { return { get: async function () { return { data: [] } } } }
    }
    return {
      DYNAMIC_CURRENT_ENV: '[DYNAMIC_CURRENT_ENV]',
      init: function () {},
      getWXContext: function () { return { OPENID: 'oTEST-recite' } },
      database: function () { return { collection: function () { return col } } }
    }
  }
  return __origModuleLoad.apply(this, arguments)
}

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}

const read = (p) => fs.readFileSync(path.join(base, p), 'utf8')

// 跑一次【AI 优化】点击，返回现场快照
// opts.respond(opt)：云函数桩。返回 Promise 或普通对象；返回的 { result: ... } 交给 callAI
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
          sink.calls.push({ action: action, content: (opt && opt.data && opt.data.content) || '', payload: (opt && opt.data && opt.data.payload) || null })
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
    page.data = Object.assign({}, pageObj.data, { content: content, media: [], diaryDate: '2026-09-20', mood: '' })
    page.setData = function (d) { Object.assign(this.data, d) }

    page.onOptimize()

    setTimeout(() => { restore(); resolve({ sink, store, page, loadError: null }) }, 220)
  })
}

const toastText = (sink) => sink.toasts.join(' | ')

/* ===== 静态护栏 ===== */
;(function staticGuard() {
  const src = read('pages/write/write.js')
  const aiCloudSrc = read('utils/aiCloud.js')
  const cfSrc = read('cloudfunctions/optimizeDiary/index.js')

  ok(src.indexOf('const askBody = clean || content') >= 0,
    'sg-1 净正文为空时改发原句（防云端判「内容为空」）')
  ok(src.indexOf('this.runOptimize(content)') >= 0 && src.indexOf('runOptimize(content, opts) {') >= 0,
    'sg-2 普通润色链路已抽成 runOptimize（供降级复用）')
  ok(src.indexOf('const showFallback = () => {') >= 0 && src.indexOf('opts.onFail(result)') >= 0,
    'sg-3 素材补全失败有兜底：结果面板一定跳出')
  ok(src.indexOf("'素材补全未成，已按普通润色继续'") >= 0 &&
    src.indexOf("'素材补全未成，已展示现有文字'") >= 0,
    'sg-4 降级提示不再冒充「需要连接 AI 服务」')
  ok(src.indexOf('result.unsupported') < 0,
    'sg-5 recite 判决已改用 offline（unsupported 语义废弃）')

  ok(aiCloudSrc.indexOf('offline: !!offline') >= 0,
    'sg-6 aiCloud 降级结果带 offline 标志')
  ok(aiCloudSrc.indexOf("'当前环境未启用云开发', true") >= 0 &&
    aiCloudSrc.indexOf("'AI 响应超时', true") >= 0 &&
    aiCloudSrc.indexOf("'调用云函数失败', true") >= 0,
    'sg-7 真·连不上的三条路径都标 offline=true')
  ok(aiCloudSrc.indexOf("(r && r.error) || '未能确认出处', false") >= 0,
    'sg-8 云端在线但拒答 → offline=false（如实透传原因）')

  ok(cfSrc.indexOf('if (!body && !hasTarget) return { error: \'内容为空\' }') >= 0,
    'sg-9 云函数判空已放宽（纯求助句是合法请求）')
  ok(cfSrc.indexOf('const hasTarget = ') >= 0 && cfSrc.indexOf('tg.keyword') >= 0,
    'sg-10 云函数按 target 判定请求是否有效')
  ok(cfSrc.indexOf('RECITE_GENRE_WORDS') >= 0 && cfSrc.indexOf('提到的文体（不是篇名') >= 0,
    'sg-11 文体词与篇名分开（「判词」不会被当成《判词》这部作品）')
})()

;(async () => {
  const NEO = '尼采说过那句关于生活的什么话来着，你帮我补充一下'
  const XIV = '惜春的判词是什么来着，帮我补充一下'

  /* ===== 1. 根因：净正文为空也要把原句发出去（用户实测那句） ===== */
  const A = await runOptimizeClick(NEO, {
    respond: () => ({ result: { error: '内容为空' } })
  })
  ok(A.loadError === null, 'A-1 写日记页可正常加载', A.loadError)
  const reciteCallA = A.sink.calls.filter(c => c.action === 'recite')[0]
  ok(!!reciteCallA, 'A-2 走的是 recite 通道', A.sink.cloud)
  ok(!!reciteCallA && String(reciteCallA.content).trim().length > 0,
    'A-3 发给云端的 content 不为空（根因回归）', reciteCallA && reciteCallA.content)
  ok(!!reciteCallA && reciteCallA.payload && reciteCallA.payload.target &&
    reciteCallA.payload.target.author === '尼采',
    'A-4 payload 带上作者锚点', reciteCallA && reciteCallA.payload && reciteCallA.payload.target)

  /* ===== 2. 云端拒答 → 面板照跳 + 不冒充连接故障 ===== */
  ok(A.page && A.page.data.showOptimizeResult === true,
    'A-5 云端拒答时结果面板照样弹出（不阻断）', A.page && A.page.data.showOptimizeResult)
  ok(A.page && !!String(A.page.data.optimizedContent).trim(),
    'A-6 面板里有可编辑的文稿（净正文为空则回退原句）', A.page && A.page.data.optimizedContent)
  ok(toastText(A.sink).indexOf('需要连接 AI 服务') < 0,
    'A-7 不再冒充「连接 AI 服务」故障', A.sink.toasts)
  ok(toastText(A.sink).indexOf('素材补全未成') >= 0,
    'A-8 提示如实说明「素材补全未成」', A.sink.toasts)
  ok((A.page && A.page.data.optimizeChanges || []).join(' | ').indexOf('素材补全未成') >= 0,
    'A-9 优化要点里写清未补全原因', A.page && A.page.data.optimizeChanges)
  const aNotes = ((A.page && A.page.data.optimizeChanges) || []).join(' | ')
  ok(aNotes.indexOf('连接 AI 服务失败') < 0,
    'A-10 云端在线（只是拒答）时不谎报连接失败', aNotes)

  /* ===== 3. 惜春判词：同一类纯求助句 ===== */
  const B = await runOptimizeClick(XIV, { respond: () => ({ result: { error: '未能确认可靠出处' } }) })
  ok(B.page && B.page.data.showOptimizeResult === true,
    'B-1 判词句拒答时也照样跳面板', B.page && B.page.data.showOptimizeResult)
  ok(toastText(B.sink).indexOf('未能确认可靠出处') >= 0 || toastText(B.sink).indexOf('素材补全未成') >= 0,
    'B-2 云端给的原因被如实透传', B.sink.toasts)
  const reciteCallB = B.sink.calls.filter(c => c.action === 'recite')[0]
  ok(!!reciteCallB && reciteCallB.payload && reciteCallB.payload.target &&
    reciteCallB.payload.target.person === '惜春' &&
    reciteCallB.payload.target.genre === '判词' &&
    reciteCallB.payload.target.title === '',
    '[genre-v1] B-3 payload 把人物与文体分列（「判词」不再是篇名）',
    reciteCallB && reciteCallB.payload && reciteCallB.payload.target)

  /* ===== 4. 真·连不上（callFunction reject）→ 也要跳 ===== */
  const C = await runOptimizeClick(NEO, {
    respond: () => Promise.reject(new Error('cloud call failed'))
  })
  ok(C.page && C.page.data.showOptimizeResult === true,
    'C-1 连不上时也要跳面板', C.page && C.page.data.showOptimizeResult)
  const cNotes = ((C.page && C.page.data.optimizeChanges) || []).join(' | ')
  ok(cNotes.indexOf('连接 AI 服务失败') >= 0,
    'C-2 真·连不上才说「连接 AI 服务失败」', cNotes)

  /* ===== 5. 净正文够长 → 自动转普通润色继续（拍板 1 号方案） ===== */
  const LONG = '今天下午在公园散步，看到柳树都发芽了，心情不错。惜春的判词是什么来着，帮我补充一下'
  const qa = require(path.join(base, 'utils', 'quoteAsk.js'))
  const dLong = qa.detect(LONG)
  const cleanLong = qa.strip(LONG, dLong)
  ok(dLong.hit === true && cleanLong.trim().length >= 20,
    'D-0 前置条件：该句命中且净正文够长', { hit: dLong.hit, clean: cleanLong })
  const D = await runOptimizeClick(LONG, {
    respond: (opt) => {
      const action = (opt && opt.data && opt.data.action) || ''
      if (action === 'recite') return { result: { error: '未能确认可靠出处' } }
      return { result: { optimized: cleanLong + '（已润色）', changes: ['调整了语序'] } }
    }
  })
  ok(D.sink.cloud.indexOf('recite') >= 0 && D.sink.cloud.indexOf('optimize') >= 0,
    'D-1 补全未成后自动接了一次普通润色', D.sink.cloud)
  ok(D.page && D.page.data.showOptimizeResult === true &&
    String(D.page.data.optimizedContent).indexOf('已润色') >= 0,
    'D-2 面板展示的是润色稿', D.page && D.page.data.optimizedContent)
  ok((D.page && D.page.data.optimizeChanges || []).join(' | ').indexOf('素材补全未成') >= 0,
    'D-3 润色稿的要点里保留了「素材补全未成」说明', D.page && D.page.data.optimizeChanges)

  /* ===== 6. 云端正常返回 → 正常进优化稿，不误降级 ===== */
  const E = await runOptimizeClick(NEO, {
    respond: () => ({ result: { recited: '每一个不曾起舞的日子，都是对生命的辜负。', source: '尼采《偶像的黄昏》' } })
  })
  ok(E.sink.cloud.indexOf('recite') >= 0 && E.sink.cloud.indexOf('optimize') < 0,
    'E-1 云端给了内容就不再触发降级润色', E.sink.cloud)
  ok(E.page && E.page.data.showOptimizeResult === true &&
    String(E.page.data.optimizedContent).indexOf('不曾起舞') >= 0,
    'E-2 优化稿里含补全内容', E.page && E.page.data.optimizedContent)
  ok(E.page && String(E.page.data.optimizedContent).indexOf('—— 尼采《偶像的黄昏》') >= 0,
    'E-3 出处行按「—— 出处」拼接', E.page && E.page.data.optimizedContent)
  ok(toastText(E.sink).indexOf('素材补全未成') < 0,
    'E-4 成功路径不出现降级提示', E.sink.toasts)
  ok(E.page && E.page.data.content === NEO,
    'E-5 素材补全只进优化稿，正文未被改写', E.page && E.page.data.content)

  /* ===== 7. 云函数判空闸：纯求助句不得被拒（真跑 main，不再只看源码） ===== */
  const cf = require(path.join(base, 'cloudfunctions', 'optimizeDiary', 'index.js'))
  const f1 = await cf.main({
    action: 'recite', content: '',
    payload: { kind: 'quote', mode: 'lookup', target: { author: '尼采', keyword: '生活' } }
  }, {})
  ok(f1 && f1.error !== '内容为空',
    'F-1 净正文为空但有目标信息 → 不得判「内容为空」', f1 && f1.error)
  const f2 = await cf.main({ action: 'recite', content: '', payload: {} }, {})
  ok(f2 && f2.error === '内容为空',
    'F-2 正文与目标信息都空 → 仍然判空（防无意义调用）', f2 && f2.error)

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': pass=' + pass + ' fail=' + fail)
  process.exit(fail === 0 ? 0 : 1)
})()
