/**
 * 行为测试：写日记页「保存流程」端到端（doAddDiary + checkNewEntities）
 *
 * 为什么需要这一套：
 *   2026-09-10 闹钟功能在 write.js 里加了 `reminder.callMarkWritten(diaryDate)`，
 *   但忘了 require reminder → 每次「当天第一篇日记」保存时抛 ReferenceError，
 *   被 doAddDiary 的 catch 兜成「已保存 → 补跳详情页」，导致 checkNewEntities
 *   永远执行不到：保存后不弹「备案」、并秒跳详情页。
 *   这类「未定义标识符」node --check 与原有各套单元测试都抓不到，
 *   只有把保存流程真跑一遍才能发现，故单独立套。
 *
 * 覆盖断言：
 *   1) 保存流程不得出现「后续步骤异常」（未捕获异常被兜底）
 *   2) 有「X 是 Y」解释句式 → 弹出备案弹层、条目正确、且弹层期间不跳转
 *   3) 纯记叙无解释 → 不弹窗、正常跳转详情页
 *   4) 闹钟「今天已写」上报真的发出去（markWritten 云函数被调用）
 *   5) 静态护栏：write.js 里用到的工具模块必须都有 require（防同类漏引复发）
 *   6) 顺序纪律：实体识别必须是「落库后第一步」，且任何后续步骤抛异常都吞不掉它
 *      （用 throwOnMarkWritten 桩让闹钟上报抛错，验证弹层照常显示、且不抢先跳转）
 *   7) 静态护栏：两条保存路径（新增 / 融合）都必须先实体识别、后复位
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

const DATE = '2026-09-18'

// 跑一次真实保存流程，返回现场快照
// opts.throwOnMarkWritten：让「闹钟上报」这一步抛异常，用来验证后续步骤异常吞不掉备案提醒
function runSave(content, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    // 每个用例全新模块实例，避免互相污染
    Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })

    const store = {}
    const sink = { nav: [], toasts: [], errors: [], logs: [], cloud: [], order: [] }

    global.wx = {
      getStorageSync: (k) => (k in store ? store[k] : ''),
      setStorageSync: (k, v) => { store[k] = v },
      removeStorageSync: (k) => { delete store[k] },
      getStorageInfo: (o) => { o && o.success && o.success({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }) },
      getStorageInfoSync: () => ({ currentSize: 100, keys: Object.keys(store), limitSize: 10240 }),
      showToast: (o) => { sink.toasts.push(o && o.title) },
      showModal: () => {},
      navigateTo: (o) => { sink.nav.push((o && o.url) || ''); o && o.success && o.success({}) },
      redirectTo: (o) => { sink.nav.push('REDIRECT:' + ((o && o.url) || '')) },
      getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 375, windowHeight: 700 }),
      cloud: {
        callFunction: (opt) => {
          const name = (opt && opt.name) || ''
          const action = opt && opt.data && opt.data.action
          sink.cloud.push(action ? name + ':' + action : name)
          // 云函数一律「快速成功」但都不返回 entities/tags：
          // 逼着走本地规则兜底 —— 正是真机上云函数旧版/异常时的路径
          return Promise.resolve({ result: { tags: ['测试'] } })
        }
      }
    }
    global.getApp = () => ({ globalData: {} })

    let pageObj = null
    global.Page = (o) => { pageObj = o }

    // 打桩：闹钟上报这一步（可令其抛异常）+ 记录调用顺序。
    // 必须在加载 write.js 之前打桩——它是在模块作用域 require 的。
    const reminderMod = require(path.join(base, 'utils', 'reminder.js'))
    const origMarkWritten = reminderMod.callMarkWritten
    reminderMod.callMarkWritten = function (date) {
      sink.order.push('markWritten')
      if (opts.throwOnMarkWritten) throw new Error('markWritten 测试桩异常')
      return origMarkWritten.call(this, date)
    }

    const realErr = console.error
    const realLog = console.log
    console.error = (...a) => { sink.errors.push(a.map((x) => String(x)).join(' ')) }
    console.log = (...a) => { sink.logs.push(a.map((x) => String(x)).join(' ')) }

    const restore = () => { console.error = realErr; console.log = realLog }

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
    page.data = Object.assign({}, pageObj.data, { content, media: [], diaryDate: DATE })
    page.setData = function (d) { Object.assign(this.data, d) }
    page._navigated = false

    // 顺序探针：记录「实体识别」与「保存后复位」的先后
    const _cne = page.checkNewEntities
    page.checkNewEntities = function (c) { sink.order.push('checkNewEntities'); return _cne.call(this, c) }
    const _ras = page.resetAfterSave
    page.resetAfterSave = function (d) { sink.order.push('resetAfterSave'); return _ras.call(this, d) }

    // 与 onSave 一致：并行发起实体识别并挂到页面上
    const aiCloud = fakeRequire('../../utils/aiCloud.js')
    page._pendingEntityCheck = { content, promise: aiCloud.callAIExtractEntities(content) }

    page.doAddDiary(content, DATE, '', false)

    setTimeout(() => { restore(); resolve({ sink, store, page, loadError: null }) }, 250)
  })
}

const hasLog = (sink, kw) => sink.logs.some((l) => l.indexOf(kw) !== -1)
const abnormal = (sink) => sink.errors.filter((e) => e.indexOf('后续步骤异常') !== -1)

/* ===== 静态护栏：工具模块「用了必须引入」 ===== */
;(function staticGuard() {
  const src = fs.readFileSync(WRITE, 'utf8')
  const UTILS = ['storage', 'util', 'aiCloud', 'aiEdit', 'nameMatch', 'entityClean', 'voice', 'weather',
    'mediaGuard', 'transfer', 'fontSetting', 'theme', 'lock', 'draft', 'textRules', 'reminder']
  const missing = []
  UTILS.forEach((n) => {
    const used = new RegExp('(^|[^.\\w$])' + n + '\\.', 'm').test(src)
    const imported = src.indexOf("utils/" + n + ".js") !== -1
    if (used && !imported) missing.push(n)
  })
  ok(missing.length === 0, 'sg-1 用到的工具模块都已 require', missing)
  ok(src.indexOf('reminder.callMarkWritten') !== -1, 'sg-2 保存流程仍会上报「今天已写」')
  // 顺序纪律：两条保存路径（新增 / 融合）都必须先发起实体识别，再做保存后复位
  const cneCount = src.split('this.checkNewEntities(savedContent)').length - 1
  ok(cneCount === 2, 'sg-3 两条保存路径都调用实体识别', cneCount)
  ok(src.indexOf('this.checkNewEntities(savedContent)') < src.indexOf("safePostSave('复位页面状态"),
    'sg-4 新增路径：实体识别先于保存后复位')
  ok(src.lastIndexOf('this.checkNewEntities(savedContent)') < src.lastIndexOf("safePostSave('复位页面状态"),
    'sg-5 融合路径：实体识别先于保存后复位')
  const spCount = src.split('safePostSave(').length - 1
  ok(spCount >= 8, 'sg-6 保存后步骤均已兜底（safePostSave）', spCount)
})()

;(async () => {
  /* ===== 1. 用户实测用例：四维图形是一家比较好的公司 ===== */
  const A = await runSave('四维图形是一家比较好的公司。我来这个公司已经两个月了')
  ok(A.loadError === null, 'A-1 写日记页可正常加载（无未定义标识符）', A.loadError)
  ok(abnormal(A.sink).length === 0, 'A-2 保存流程无「后续步骤异常」', abnormal(A.sink))
  ok(hasLog(A.sink, 'checkNewEntities 开始'), 'A-3 保存后确实进入实体识别', A.sink.logs)
  ok(A.page && A.page.data.showEntityPrompt === true, 'A-4 弹出备案弹层', A.page && A.page.data.showEntityPrompt)
  ok(A.page && JSON.stringify((A.page.data.newEntities || []).map((e) => e.name)) === JSON.stringify(['四维图形']),
    'A-5 备案条目 = 四维图形', A.page && (A.page.data.newEntities || []).map((e) => e.name))
  ok(A.sink.nav.length === 0, 'A-6 弹层期间不跳转（等用户选备案/跳过）', A.sink.nav)
  ok(Array.isArray(A.store.diaries) && A.store.diaries.length === 1, 'A-7 日记已落库', A.store.diaries && A.store.diaries.length)
  ok(A.sink.cloud.indexOf('markWritten') !== -1, 'A-8 闹钟「今天已写」上报已发出', A.sink.cloud)

  /* ===== 2. 用户实测用例：魏杰是我北汽的同事 ===== */
  const B = await runSave('魏杰是我北汽的同事。好朋友。')
  ok(abnormal(B.sink).length === 0, 'B-1 保存流程无「后续步骤异常」', abnormal(B.sink))
  ok(B.page && JSON.stringify((B.page.data.newEntities || []).map((e) => e.name)) === JSON.stringify(['魏杰']),
    'B-2 备案条目 = 魏杰', B.page && (B.page.data.newEntities || []).map((e) => e.name))

  /* ===== 3. 纯记叙（没有解释任何名词）→ 不弹窗、正常跳转 ===== */
  const C = await runSave('今天天气不错，出门走了走。')
  ok(abnormal(C.sink).length === 0, 'C-1 保存流程无「后续步骤异常」', abnormal(C.sink))
  ok(C.page && C.page.data.showEntityPrompt === false, 'C-2 无解释时不弹窗', C.page && C.page.data.showEntityPrompt)
  ok(C.sink.nav.length === 1, 'C-3 正常跳转详情页一次', C.sink.nav)

  /* ===== 4. 顺序纪律：后续步骤抛异常也吞不掉备案提醒（2026-09-18 加固） ===== */
  const D = await runSave('四维图形是一家比较好的公司。我来这个公司已经两个月了', { throwOnMarkWritten: true })
  ok(D.loadError === null, 'D-1 写日记页可正常加载', D.loadError)
  ok(D.sink.errors.some((e) => e.indexOf('闹钟「今天已写」上报') !== -1), 'D-2 上报步骤确实抛了异常并被兜住', D.sink.errors)
  ok(D.page && D.page.data.showEntityPrompt === true, 'D-3 上报抛异常仍弹出备案弹层', D.page && D.page.data.showEntityPrompt)
  ok(D.sink.nav.length === 0, 'D-4 异常时未抢先跳转（弹层期间不跳）', D.sink.nav)
  ok(Array.isArray(D.store.diaries) && D.store.diaries.length === 1, 'D-5 日记仍已落库', D.store.diaries && D.store.diaries.length)
  ok(D.sink.order.indexOf('checkNewEntities') !== -1, 'D-6 实体识别已发起', D.sink.order)
  ok(D.sink.order.indexOf('checkNewEntities') < D.sink.order.indexOf('resetAfterSave'),
    'D-7 顺序：实体识别先于保存后复位', D.sink.order)
  ok(D.sink.order.indexOf('checkNewEntities') < D.sink.order.indexOf('markWritten'),
    'D-8 顺序：实体识别先于闹钟上报', D.sink.order)

  console.log('\n[test_save_flow] ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail === 0 ? 0 : 1)
})()
