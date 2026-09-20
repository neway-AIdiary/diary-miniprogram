/**
 * 行为测试：任何「点了按钮」的路径都不许把用户堵在原地
 *
 * 为什么需要这一套：
 *   2026-09-20 用户实测反馈「不能因为【保存日记】/ 删改纠错指令 / 补充这种指令，
 *   就不跳转到下一个页面」，并追问「你再检查一遍，还有没有」。
 *   只读探针实跑 `onOptimize()` 确认**确实还有**，且集中在两类早退闸：
 *     ① 「<20 字」长度闸 —— 指令执行后正文变短、泛问句本来就没正文，全撞在这道闸上；
 *     ② 「指令后正文为空」的早退 —— 直接 toast 返回，后面的流程一个都没走；
 *     附带第三处：`runOptimize` 拿不到润色稿且调用方没传 onFail 时，也是只 toast 不弹面板。
 *   保存链路另有「日记已落库却把用户留在写页」与「详情页对一篇已不存在的日记反复报保存失败」。
 *
 * 用户拍板 1.A + 2.A + 3.A + 4.A，本套件逐条锁死。
 *
 * 覆盖断言：
 *   A 组：优化链路不再有死胡同（四条早退路径 + 空正文合理拦截 + 正常路径回归）
 *   B 组：长度闸例外（带指令跳过闸；无指令只给面板不进润色）
 *   C 组：保存链路「已落库必须跳转」
 *   D 组：详情页区分「日记已不存在」与真写失败
 *   S 组：静态护栏（旧早退 toast 已不再可执行 / 兜底方法存在 / 三处跳转守卫齐全）
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const WRITE = path.join(base, 'pages', 'write', 'write.js')
const DETAIL = path.join(base, 'pages', 'detail', 'detail.js')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8')

function clearCache() {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })
}

function installWx(sink, store) {
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
    showModal: (o) => { sink.modals.push(o || {}); if (o && o.__auto) { o.complete && o.complete({ confirm: true }) } },
    navigateTo: (o) => { sink.nav.push(o || {}) },
    redirectTo: (o) => { sink.nav.push(o || {}) },
    navigateBack: () => { sink.back = (sink.back || 0) + 1 },
    reLaunch: (o) => { sink.relaunch.push(o || {}) },
    getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 375, windowHeight: 700 }),
    onThemeChange: () => {},
    getFileSystemManager: () => ({ readFile: () => {}, stat: () => {} }),
    cloud: {
      callFunction: (opt) => {
        const d = (opt && opt.data) || {}
        sink.calls.push({ action: d.action || '', content: d.content || '' })
        if (sink.__respond) return Promise.resolve(sink.__respond(opt))
        return Promise.resolve({ result: { optimized: '（云端润色稿）今天挺好。', changes: [] } })
      }
    }
  }
  global.getApp = () => ({ globalData: {} })
}

/** 加载 write.js 并造一个 page 实例 */
function loadWritePage(opts) {
  opts = opts || {}
  clearCache()
  const store = opts.store || {}
  const sink = { toasts: [], modals: [], nav: [], relaunch: [], calls: [], errors: [] }
  installWx(sink, store)

  let pageObj = null
  global.Page = (o) => { pageObj = o }

  const realErr = console.error
  const realWarn = console.warn
  console.error = (...a) => { sink.errors.push(a.map(String).join(' ')) }
  console.warn = (...a) => { sink.errors.push(a.map(String).join(' ')) }
  sink.__restore = () => { console.error = realErr; console.warn = realWarn }

  const overrides = opts.overrides || {}
  const dir = path.join(base, 'pages', 'write')
  const fakeRequire = (p) => {
    for (const k of Object.keys(overrides)) {
      if (p.indexOf(k) >= 0) return overrides[k]
    }
    return require(path.resolve(dir, p))
  }

  const src = fs.readFileSync(WRITE, 'utf8')
  const wrapper = vm.runInThisContext(
    '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'write.js' })
  wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)

  if (!pageObj) { sink.__restore(); return { page: null, sink, loadError: 'Page 未注册' } }
  const page = Object.create(pageObj)
  page.data = Object.assign({}, pageObj.data, {
    content: opts.content || '',
    media: [],
    mood: '',
    optimized: false,
    diaryDate: '2026-09-20',
    location: null,
    weatherInfo: null
  })
  page.setData = function (d) { Object.assign(this.data, d) }
  return { page, sink, store, loadError: null }
}

// 旧代码在被断言的行为上抛异常时，也要记为「红」而不是让测试进程崩掉
// （否则红灯自检看到的是 crash，分不清「断言有牙齿」还是「测试自己坏了」）
function emptySink() {
  return { toasts: [], modals: [], nav: [], relaunch: [], calls: [], errors: [], __restore: () => {} }
}
function guard(ctx, e) {
  if (ctx && ctx.sink) { ctx.sink.errors.push('THROWN: ' + String(e && e.message)); if (ctx.sink.__restore) ctx.sink.__restore() }
  if (ctx) ctx.page = null
  return ctx || { page: null, sink: emptySink(), loadError: String(e && e.message) }
}

/** 点一次【AI 优化】 */
function clickOptimize(content, opts) {
  return new Promise((resolve) => {
    let ctx
    try {
      ctx = loadWritePage(Object.assign({ content }, opts))
      if (ctx.loadError) { ctx.page = null; return resolve(ctx) }
      ctx.page.onOptimize()
    } catch (e) {
      return resolve(guard(ctx, e))
    }
    setTimeout(() => { ctx.sink.__restore(); resolve(ctx) }, 240)
  })
}

/** 跑一次同日融合保存 */
function runMergeSave(aiCloudStub, opts) {
  return new Promise((resolve) => {
    opts = opts || {}
    const mediaGuardStub = {
      computeRemovedFiles: () => [],
      deleteMediaItems: () => Promise.resolve({ failed: 0 }),
      collectFileIDs: () => [],
      sumMediaBytes: () => 0,
      subtractMediaUsage: () => {},
      deleteCloudFiles: () => {}
    }
    const storageStub = {
      getArchives: () => [],
      updateDiary: () => ({ id: 'base-1', content: '合并后的内容' }),
      deleteDiary: () => {},
      getAllDiaries: () => []
    }
    let ctx
    try {
      ctx = loadWritePage({
        content: '今天新写的一段内容',
        overrides: {
          'storage.js': storageStub,
          'aiCloud.js': aiCloudStub,
          'mediaGuard.js': mediaGuardStub
        }
      })
      if (ctx.loadError) return resolve(ctx)
      ctx.page._sessionUploaded = []
      ctx.page._lastSavedId = null
      ctx.page._navigated = false
      ctx.page._entityCheckActive = false
      const sameDay = [{ id: 'base-1', content: '早上写的', mood: '', media: [], created_at: '2026-09-20T08:00:00.000Z' }]
      ctx.page.mergeWithSameDay(sameDay, '今天新写的一段内容', '2026-09-20', '')
    } catch (e) {
      return resolve(guard(ctx, e))
    }
    setTimeout(() => { ctx.sink.__restore(); resolve(ctx) }, 260)
  })
}

/** 加载 detail.js 并造一个 page 实例（storage 走桩，便于控制「写失败 / 日记不存在」） */
function loadDetailPage(storageStub, opts) {
  opts = opts || {}
  clearCache()
  const store = {}
  const sink = { toasts: [], modals: [], nav: [], relaunch: [], calls: [], errors: [] }
  installWx(sink, store)

  let pageObj = null
  global.Page = (o) => { pageObj = o }
  const realErr = console.error
  console.error = (...a) => { sink.errors.push(a.map(String).join(' ')) }
  sink.__restore = () => { console.error = realErr }

  const overrides = Object.assign({ 'storage.js': storageStub }, (opts.overrides || {}))
  const dir = path.join(base, 'pages', 'detail')
  const fakeRequire = (p) => {
    for (const k of Object.keys(overrides)) {
      if (p.indexOf(k) >= 0) return overrides[k]
    }
    return require(path.resolve(dir, p))
  }

  try {
    const src = fs.readFileSync(DETAIL, 'utf8')
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'detail.js' })
    wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  } catch (e) {
    sink.__restore()
    return { page: null, sink, loadError: String(e && e.message) }
  }
  if (!pageObj) { sink.__restore(); return { page: null, sink, loadError: 'Page 未注册' } }

  const page = Object.create(pageObj)
  page.data = Object.assign({}, pageObj.data, {
    id: opts.id || 'd1',
    content: opts.content || '编辑后的内容',
    title: '2026年9月20日 日记',
    mood: '',
    diary: { id: opts.id || 'd1', source: 'manual', media: [] },
    editLocation: null,
    editMedia: []
  })
  page.setData = function (d) { Object.assign(this.data, d) }
  return { page, sink, store, loadError: null }
}

function trySaveEdit(page) {
  if (!page) return 'no-page'
  try { page.saveEdit(); return null } catch (e) { return String(e && e.message) }
}

const toastText = (sink) => sink.toasts.join(' | ')

/* ============================================================
 * A 组：优化链路不再有死胡同
 * ============================================================ */
async function groupA() {
  // —— A1 删改指令把正文彻底删空 ——
  const A1 = await clickOptimize('今天心情不错。把这句话删掉。')
  ok(A1.page && A1.page.data.showOptimizeResult === true,
    'A-1 指令删空正文也必须弹出结果面板', A1.page && A1.page.data.showOptimizeResult)
  ok(A1.page && (A1.page.data.optimizeChanges || []).join(' | ').indexOf('正文已为空') >= 0,
    'A-2 优化要点里写清「正文已为空」', A1.page && A1.page.data.optimizeChanges)
  ok(A1.page && A1.page.data.optimizing === false,
    'A-3 兜底路径必须复位 optimizing（否则 loading 一直转）', A1.page && A1.page.data.optimizing)

  // —— A4 泛问句（既没有正文也没有实体）：不得只弹「内容太短」——
  const A4 = await clickOptimize('帮我补充一下明天的计划安排。')
  ok(A4.page && A4.page.data.showOptimizeResult === true,
    'A-4 泛问句也要有结果面板', A4.page && A4.page.data.showOptimizeResult)
  ok(A4.page && (A4.page.data.optimizeChanges || []).join(' | ').indexOf('未做润色') >= 0,
    'A-5 面板里说明为什么没润色', A4.page && A4.page.data.optimizeChanges)

  const A4b = await clickOptimize('帮我改一下今天。')
  ok(A4b.page && A4b.page.data.showOptimizeResult === true,
    'A-6 另一条泛问句同样有面板', A4b.page && A4b.page.data.showOptimizeResult)

  // —— A7 空正文：合理拦截（提示后停住是对的）——
  const A7 = await clickOptimize('')
  ok(A7.page && !A7.page.data.showOptimizeResult && toastText(A7.sink).indexOf('请先写下日记内容') >= 0,
    'A-7 空正文仍按「请输入内容」拦截（这一条不该弹面板）', A7.sink.toasts)

  // —— A8 云端拿不到润色稿 → 也要给面板 ——
  const A8 = await clickOptimize('今天在公司忙了一整天，晚上回家做了饭。', {
    overrides: {},
    store: {}
  })
  ok(A8.page && A8.page.data.showOptimizeResult === true,
    'A-8 正常正文照常出面板（回归）', A8.page && A8.page.data.showOptimizeResult)

  // —— A9 云函数返回空 optimized → 必须给面板而不是只 toast ——
  const ctxA9 = loadWritePage({ content: '今天在公司忙了一整天，晚上回家做了饭。' })
  ctxA9.sink.__respond = () => ({ result: { error: 'AI 服务繁忙' } })
  ctxA9.page.onOptimize()
  await new Promise((r) => setTimeout(r, 240))
  ctxA9.sink.__restore()
  ok(ctxA9.page.data.showOptimizeResult === true,
    'A-9 拿不到润色稿也必须弹出面板', ctxA9.page.data.showOptimizeResult)
  ok(ctxA9.page.data.optimizedContent === '今天在公司忙了一整天，晚上回家做了饭。',
    'A-10 兜底时把现有正文作为优化稿展示', ctxA9.page.data.optimizedContent)
  ok(ctxA9.page.data.optimizing === false,
    'A-11 拿不到润色稿时 loading 也必须复位', ctxA9.page.data.optimizing)
}

/* ============================================================
 * B 组：长度闸例外（拍板 2.A）
 * ============================================================ */
async function groupB() {
  // —— B1 带指令 + 短正文 → 跳过长度闸，真的去润色 ——
  const B1 = await clickOptimize('今天累。把今天累改成今天挺好。')
  const b1Optimize = (B1.sink.calls || []).filter((c) => c.action === 'optimize')
  ok(b1Optimize.length === 1,
    'B-1 带指令的短正文不再被长度闸拦（应发起润色）', B1.sink.calls)
  ok(b1Optimize.length === 1 && b1Optimize[0].content.indexOf('今天累') < 0,
    'B-2 指令句已从正文剥离（发给云端的是改后正文）', b1Optimize)

  // —— B3 无指令的短正文 → 不进润色，直接给面板 ——
  const B3 = await clickOptimize('今天挺好。')
  ok((B3.sink.calls || []).filter((c) => c.action === 'optimize').length === 0,
    'B-3 无指令的短正文不进润色（省一次调用）', B3.sink.calls)
  ok(B3.page && B3.page.data.showOptimizeResult === true,
    'B-4 但仍给结果面板（不再只弹 toast）', B3.page && B3.page.data.showOptimizeResult)
}

/* ============================================================
 * C 组：保存链路「已落库必须跳转」（拍板 3.A）
 * ============================================================ */
async function groupC() {
  // —— C1 融合已落库，实体识别发起时炸了 → 仍必须跳详情页 ——
  const C1 = await runMergeSave({
    callAIMergeDiary: () => Promise.resolve({ merged: '合并后的内容', from: 'cloud' }),
    callAITags: () => Promise.resolve({ tags: [] }),
    callAIExtractEntities: () => { throw new Error('entity check boom') },
    autoSegmentAfterSave: () => {}
  })
  ok(C1.page && C1.sink.nav.length >= 1,
    'C-1 融合已落库时，后续步骤异常也必须跳转',
    {
      nav: C1.sink.nav,
      errors: C1.sink.errors.slice(0, 2),
      navigated: C1.page && C1.page._navigated,
      lastId: C1.page && C1.page._lastSavedId,
      entityActive: C1.page && C1.page._entityCheckActive,
      hasFn: C1.page && typeof C1.page.afterSaveNavigate
    })
  ok(C1.sink.nav.length >= 1 && String(C1.sink.nav[0].url || '').indexOf('/pages/detail/detail?id=') === 0,
    'C-2 跳转目标是刚保存的那篇日记', C1.sink.nav)

  // —— C3 融合一切正常 → 跳转（回归）——
  const C3 = await runMergeSave({
    callAIMergeDiary: () => Promise.resolve({ merged: '合并后的内容', from: 'cloud' }),
    callAITags: () => Promise.resolve({ tags: [] }),
    callAIExtractEntities: () => Promise.resolve({ entities: [] }),
    autoSegmentAfterSave: () => {}
  })
  ok(C3.sink.nav.length >= 1,
    'C-3 融合正常保存后照常跳转（回归）', C3.sink.nav)

  // —— C4 融合落库前就失败（AI 融合本身挂了）→ 提示保存失败、不跳转 ——
  const C4 = await runMergeSave({
    callAIMergeDiary: () => Promise.reject(new Error('merge boom')),
    callAITags: () => Promise.resolve({ tags: [] }),
    callAIExtractEntities: () => Promise.resolve({ entities: [] }),
    autoSegmentAfterSave: () => {}
  })
  ok(C4.sink.nav.length === 0 && toastText(C4.sink).indexOf('保存失败') >= 0,
    'C-4 未落库的融合失败仍按「保存失败」处理（不乱跳）', C4.sink.toasts)
}

/* ============================================================
 * D 组：详情页（拍板 4.A）
 * ============================================================ */
async function groupD() {
  // —— D1 日记已被同日融合删掉 → 说清原因并返回日记本 ——
  const D1 = loadDetailPage({
    updateDiary: () => null,
    getDiaryById: () => undefined,
    getArchives: () => []
  }, { id: 'ghost-1' })
  if (D1.loadError) {
    ok(false, 'D-0 detail.js 能加载起来（桩依赖）', D1.loadError)
  } else {
    const errD1 = trySaveEdit(D1.page)
    ok(!errD1, 'D-0 saveEdit 不应抛异常', errD1)
    ok(D1.sink.modals.length === 1 && D1.sink.modals[0].title === '日记已不存在',
      'D-1 日记不存在时明确提示（不再只说「保存失败」）', D1.sink.modals.map((m) => m.title))
    ok(D1.page && D1.page.data.editing === false,
      'D-2 不再停留在编辑态', D1.page && D1.page.data.editing)
    ok(toastText(D1.sink).indexOf('保存失败') < 0,
      'D-3 不再误报「保存失败」', D1.sink.toasts)
    // 确认后必须返回日记本
    if (D1.sink.modals.length === 1) {
      D1.sink.modals[0].complete && D1.sink.modals[0].complete({ confirm: true })
      ok(D1.sink.relaunch.length === 1 && D1.sink.relaunch[0].url === '/pages/index/index',
        'D-4 确认后返回日记本', D1.sink.relaunch)
    }
    D1.sink.__restore()

    // —— D5 日记还在，只是本地写入失败 → 保持「保存失败」，不误报「已不存在」 ——
    const D5 = loadDetailPage({
      updateDiary: () => null,
      getDiaryById: () => ({ id: 'd1' }),
      getArchives: () => []
    })
    if (D5.loadError) {
      ok(false, 'D-5 detail.js 能加载起来', D5.loadError)
    } else {
      D5.page.saveEdit()
      ok(D5.sink.modals.length === 0 && toastText(D5.sink).indexOf('保存失败') >= 0,
        'D-5 日记仍在、仅写入失败时照旧提示「保存失败」', { modals: D5.sink.modals, toasts: D5.sink.toasts })
      D5.sink.__restore()
    }

    // —— D6 保存成功 → 退出编辑态并提示成功（回归）——
    const D6 = loadDetailPage({
      updateDiary: () => ({ id: 'd1', content: '编辑后的内容', media: [], location: null }),
      getDiaryById: () => ({ id: 'd1' }),
      getArchives: () => [],
      formatWeatherText: () => ''
    }, {
      overrides: {
        'aiCloud.js': {
          autoSegmentAfterSave: () => {},
          callAIExtractEntities: () => Promise.resolve({ entities: [] }),
          callAITags: () => Promise.resolve({ tags: [] })
        }
      }
    })
    if (D6.loadError) {
      ok(false, 'D-6 detail.js 能加载起来', D6.loadError)
    } else {
      const errD6 = trySaveEdit(D6.page)
      ok(!errD6, 'D-6a saveEdit 不应抛异常', errD6)
      ok(D6.page && D6.page.data.editing === false && toastText(D6.sink).indexOf('保存成功') >= 0,
        'D-6 保存成功照旧提示（回归）', { editing: D6.page && D6.page.data.editing, toasts: D6.sink.toasts })
      D6.sink.__restore()
    }
  }
}

/* ============================================================
 * S 组：静态护栏
 * ============================================================ */
function groupS() {
  const src = read('pages/write/write.js')
  const detailSrc = read('pages/detail/detail.js')

  ok(src.indexOf('showOptimizeFallback(opts) {') >= 0,
    'S-1 存在统一兜底方法 showOptimizeFallback')
  ok(src.indexOf('this.showOptimizeFallback({') >= 0,
    'S-2 早退路径改为调用统一兜底')

  // 旧早退 toast 不得再作为可执行语句出现（只允许留在注释里说明历史）
  const deadToast = /wx\.showToast\(\{[^\n}]*内容太短，先多写几句吧/.exec(src)
  ok(!deadToast,
    'S-3 「内容太短，先多写几句吧」不再作为可执行提示', deadToast && deadToast[0])

  const guardCount = (src.match(/if \(!this\._entityCheckActive\) this\.afterSaveNavigate\(\)/g) || []).length
  ok(guardCount === 3,
    'S-4 三处「已落库」分支都带实体识别在途守卫的跳转', guardCount)
  ok(src.indexOf('if (this._navigated) return') >= 0,
    'S-5 afterSaveNavigate 防重入仍在（多条兜底路径只跳一次）')

  ok(detailSrc.indexOf('日记已不存在') >= 0 && detailSrc.indexOf('storage.getDiaryById(this.data.id)') >= 0,
    'S-6 详情页有「日记已不存在」分支')
  ok(detailSrc.indexOf("wx.reLaunch({ url: '/pages/index/index' })") >= 0,
    'S-7 日记不存在时返回日记本')

  ok(src.indexOf('[nodeadend-v1]') >= 0 && detailSrc.indexOf('[nodeadend-v1]') >= 0,
    'S-8 改动都带 [nodeadend-v1] 标记（可追溯）')
}

;(async function main() {
  // 串行执行：每个用例都会重装 global.wx，并行跑会让「断言读的 sink」与
  // 「被测代码实际调用的 sink」错位（C-1 曾因此假红）
  await groupA()
  await groupB()
  await groupC()
  await groupD()
  groupS()
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': pass=' + pass + ' fail=' + fail)
  process.exit(fail === 0 ? 0 : 1)
})()
