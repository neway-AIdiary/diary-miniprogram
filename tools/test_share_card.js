/**
 * [share-card-fallback v1] 分享卡片品牌图探活与兜底 —— 回归测试
 *
 * 背景：onShareAppMessage 给了 imageUrl 但图取不到时，微信**不会**回落页面截图，只显示破图。
 * 本套件锁住「取不到 ⇒ 不返回 imageUrl ⇒ 微信自动截图」这条兜底链路。
 *
 * A. build 同步三分支（已知可用 / 已知不可用 / 未知走 promise）
 * B. probe 语义（status!==0、fail、无云能力、桩抛异常、硬超时、去重、同步回调不挂 inFlight）
 * C. 缓存与 TTL（可用 7 天 / 不可用 10 分钟 / 过期回未知 / 脏数据不崩 / 读写异常不崩）
 * D. 危险默认（fileID 为空永不带图；title/path 透传；不改传入对象）
 * E. warmup 时序（不占启动主路径：立即不探、延迟发起、已可用不重探、无 wx 不崩）
 * F. 静态契约（6 页接线、无裸 imageUrl 残留、app.js 预热、失败静默）
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const SHARE_PATH = path.join(ROOT, 'utils/shareCard.js')
const APPINFO_PATH = path.join(ROOT, 'utils/appInfo.js')
const FID = require(APPINFO_PATH).SHARE_CARD_FILEID

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
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// ===== wx mock =====
const store = {}
let cloudCalls = 0
let mode = 'ok'      // ok | notfound | empty | fail | throw | noreply
let delay = 0

global.wx = {
  getStorageSync: function (k) { return store[k] },
  setStorageSync: function (k, v) { store[k] = v },
  removeStorageSync: function (k) { delete store[k] },
  cloud: {
    getTempFileURL: function (opts) {
      cloudCalls++
      const fire = function () {
        if (mode === 'ok') opts.success({ fileList: [{ status: 0, tempFileURL: 'https://example.com/media/share-card.png' }] })
        else if (mode === 'notfound') opts.success({ fileList: [{ status: -1, errMsg: 'file not exist' }] })
        else if (mode === 'empty') opts.success({ fileList: [] })
        else if (mode === 'fail') opts.fail({ errMsg: 'network fail' })
        else if (mode === 'throw') throw new Error('boom')
        // 'noreply' → 永不回调，走硬超时
      }
      if (delay > 0) setTimeout(fire, delay)
      else fire()
    }
  }
}

// 重新加载模块（清内存态），默认同时清掉本地缓存
function fresh(keepCache) {
  if (!keepCache) Object.keys(store).forEach(function (k) { delete store[k] })
  cloudCalls = 0
  mode = 'ok'
  delay = 0
  delete require.cache[require.resolve(SHARE_PATH)]
  return require(SHARE_PATH)
}

async function main() {
  // ===== A. build 同步三分支 =====
  section('A. build 三分支')
  let sc = fresh()
  let p = sc.build({ title: 'T', path: '/p' })
  ok(p.title === 'T' && p.path === '/p', 'A1 未知态：title/path 原样透传')
  ok(!('imageUrl' in p), 'A2 未知态：同步返回值**不带** imageUrl（危险默认 = 截图）')
  ok(p.promise && typeof p.promise.then === 'function', 'A3 未知态：带 promise 字段异步定夺')
  let r = await p.promise
  ok(r.imageUrl === FID, 'A4 未知态 + 探活成功 → promise 结果带云图 fileID')
  ok(sc.getState() === true, 'A5 探活成功后内存态 = 可用')

  sc = fresh()
  mode = 'ok'
  await sc.probe()
  p = sc.build({ title: 'T', path: '/p' })
  ok(p.imageUrl === FID, 'A6 已知可用：同步带 imageUrl')
  ok(!('promise' in p), 'A7 已知可用：不带 promise（零延迟路径）')

  sc = fresh()
  mode = 'fail'
  await sc.probe()
  p = sc.build({ title: 'T', path: '/p' })
  ok(!('imageUrl' in p), 'A8 已知不可用：同步不带 imageUrl → 微信自动截图')
  ok(!('promise' in p), 'A9 已知不可用：不带 promise')

  // ===== B. probe 语义 =====
  section('B. probe 探活语义')
  sc = fresh()
  mode = 'notfound'
  ok((await sc.probe()) === false, 'B1 status !== 0（文件不存在）→ false')
  sc = fresh()
  mode = 'empty'
  ok((await sc.probe()) === false, 'B2 fileList 为空 → false')
  sc = fresh()
  mode = 'throw'
  ok((await sc.probe()) === false, 'B3 桩直接抛异常 → false（不崩、不冒泡）')

  // 无云能力
  sc = fresh()
  const savedCloud = global.wx.cloud
  global.wx.cloud = undefined
  cloudCalls = 0
  ok((await sc.probe()) === false, 'B4 wx.cloud 缺失 → false')
  ok(cloudCalls === 0, 'B5 wx.cloud 缺失时不发请求')
  global.wx.cloud = savedCloud

  // 硬超时
  sc = fresh()
  mode = 'noreply'
  const t0 = Date.now()
  ok((await sc.probe()) === false, 'B6 永不回调 → 硬超时后判 false（不永久挂起）')
  const cost = Date.now() - t0
  ok(cost >= 1400 && cost <= 2600, 'B7 超时时长约 1.5s（实测 ' + cost + 'ms）')

  // 去重
  sc = fresh()
  mode = 'ok'
  delay = 120
  const pa = sc.probe()
  const pb = sc.probe()
  ok(pa === pb, 'B8 并发 probe 去重（返回同一 promise）')
  ok((await pa) === true, 'B9 去重后结果正确')
  ok(cloudCalls === 1, 'B10 去重后底层只请求 1 次（实测 ' + cloudCalls + '）')

  // 同步回调不把 inFlight 永久挂住
  sc = fresh()
  mode = 'ok'
  delay = 0
  ok((await sc.probe()) === true, 'B11 同步回调场景：首次 probe 正确')
  mode = 'fail'
  ok((await sc.probe()) === false, 'B12 同步回调后 inFlight 已清空（第二次 probe 能重新发起）')

  // ===== C. 缓存与 TTL =====
  section('C. 缓存与 TTL')
  sc = fresh()
  mode = 'ok'
  await sc.probe()
  const c = store['shareCardFileOk']
  ok(c && c.ok === true && typeof c.ts === 'number', 'C1 探活成功写入本地缓存 {ok:true, ts}')

  const sc2 = fresh(true)   // 保留缓存、清内存态（fresh 会把请求计数归零，基线须在它之后取）
  const before = cloudCalls
  ok(sc2.getState() === true, 'C2 新会话命中缓存 → 同步可用')
  ok(cloudCalls === before, 'C3 命中缓存不再发请求（同步零延迟）')

  store['shareCardFileOk'] = { ok: false, ts: Date.now() }
  ok(sc2.getState() === true, 'C4 会话内内存态优先：已知后不再受存储变动影响（下次冷启动才重读）')

  store['shareCardFileOk'] = { ok: true, ts: Date.now() - 8 * 24 * 3600 * 1000 }
  const sc2b = fresh(true)
  ok(sc2b.getState() === null, 'C4b 可用缓存超 7 天 → 未知（需重探）')
  store['shareCardFileOk'] = { ok: false, ts: Date.now() - 5 * 60 * 1000 }
  const sc3 = fresh(true)
  ok(sc3.getState() === false, 'C5 不可用缓存 5 分钟内 → 不可用（10 分钟 TTL 内）')
  store['shareCardFileOk'] = { ok: false, ts: Date.now() - 11 * 60 * 1000 }
  const sc4 = fresh(true)
  ok(sc4.getState() === null, 'C6 不可用缓存超 10 分钟 → 未知（重传图后可自愈）')

  // 脏数据 / 读写异常
  const raws = ['abc', {}, { ok: 'yes' }, { ok: true }, { ts: 123 }, null]
  let dirtyOk = true
  for (let i = 0; i < raws.length; i++) {
    store['shareCardFileOk'] = raws[i]
    const s = fresh(true)
    let st
    try { st = s.getState() } catch (e) { dirtyOk = false; break }
    if (st !== null) { dirtyOk = false; break }
  }
  ok(dirtyOk, 'C7 脏缓存（' + raws.length + ' 种）一律当未知，不崩不错判')
  delete store['shareCardFileOk']

  const sThrow1 = fresh()
  const realGet = global.wx.getStorageSync
  global.wx.getStorageSync = function () { throw new Error('storage boom') }
  let noThrow = true
  try { sThrow1.getState() } catch (e) { noThrow = false }
  ok(noThrow, 'C8 读缓存抛异常 → getState 不崩（当未知）')
  global.wx.getStorageSync = realGet

  const sThrow2 = fresh()
  const realSet = global.wx.setStorageSync
  global.wx.setStorageSync = function () { throw new Error('storage boom') }
  mode = 'ok'
  let okThrow = true
  try { await sThrow2.probe() } catch (e) { okThrow = false }
  ok(okThrow && sThrow2.getState() === true, 'C9 写缓存抛异常 → 探活仍正常返回')
  global.wx.setStorageSync = realSet

  // ===== D. 危险默认与边界 =====
  section('D. 危险默认与边界')
  const realExports = require.cache[require.resolve(APPINFO_PATH)].exports
  require.cache[require.resolve(APPINFO_PATH)].exports =
    Object.assign({}, realExports, { SHARE_CARD_FILEID: '' })
  const scEmpty = fresh()
  mode = 'ok'
  const pe = scEmpty.build({ title: 'T', path: '/p' })
  ok(scEmpty.getState() === false, 'D1 fileID 未配置 → 状态判为不可用')
  ok(!('imageUrl' in pe) && !('promise' in pe), 'D2 fileID 未配置 → 永不带空 imageUrl（危险默认）')
  ok((await scEmpty.probe()) === false, 'D3 fileID 未配置 → 探活直接 false，不发请求')
  require.cache[require.resolve(APPINFO_PATH)].exports = realExports

  sc = fresh()
  mode = 'fail'
  await sc.probe()
  const pEmpty = sc.build()
  ok(pEmpty.title === '' && pEmpty.path === '', 'D4 build() 空参不抛、title/path 兜成空串')
  const base = { title: 'T', path: '/p' }
  sc.build(base)
  ok(!('imageUrl' in base) && !('promise' in base), 'D5 build 不修改传入的 base 对象（无副作用）')
  const pStr = sc.build({ title: null, path: undefined })
  ok(pStr.title === '' && pStr.path === '', 'D6 title/path 为 null/undefined → 空串兜底')

  // ===== E. warmup 时序 =====
  section('E. warmup 时序')
  sc = fresh()
  cloudCalls = 0
  sc.warmup()
  ok(cloudCalls === 0, 'E1 warmup 立即返回：不占启动主路径（当场零网络请求）')
  await wait(1000)
  ok(cloudCalls === 1, 'E2 约 800ms 后异步探活 1 次（实测 ' + cloudCalls + '）')
  ok(sc.getState() === true, 'E3 warmup 完成后状态已知 = 可用')

  sc = fresh()
  mode = 'ok'
  await sc.probe()
  cloudCalls = 0
  sc.warmup()
  await wait(1000)
  ok(cloudCalls === 0, 'E4 已确认可用时不重复探活（省流量）')

  const savedCloud2 = global.wx.cloud
  global.wx.cloud = undefined
  const scNo = fresh()
  let wOk = true
  try { scNo.warmup() } catch (e) { wOk = false }
  ok(wOk, 'E5 无云能力时 warmup 不抛')
  global.wx.cloud = savedCloud2

  // ===== F. 静态契约 =====
  section('F. 静态契约')
  const PAGES = {
    'index': 'pages/index/index.js',
    'write': 'pages/write/write.js',
    'backup': 'pages/backup/backup.js',
    'profile': 'pages/profile/profile.js',
    'detail': 'pages/detail/detail.js',
    'summary-result': 'pages/summary-result/summary-result.js'
  }
  const TITLE_KEY = {
    'index': "title: appInfo.APP_NAME + ' — 你的数字分身'",
    'write': "title: appInfo.APP_NAME + ' — 你的数字分身'",
    'backup': "title: appInfo.APP_NAME + ' — 你的数字分身'",
    'profile': "title: appInfo.APP_NAME + ' — 你的数字分身'",
    'detail': "title: d ? (util.resolveDiaryTitle(d) || '我的日记')",
    'summary-result': "title: this.data.title || '我的 AI 总结'"
  }
  const bad = []
  Object.keys(PAGES).forEach(function (k) {
    const rel = PAGES[k]
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const nReq = (src.match(/require\('\.\.\/\.\.\/utils\/shareCard\.js'\)/g) || []).length
    const nBuild = (src.match(/return shareCard\.build\(\{/g) || []).length
    if (nReq !== 1 || nBuild !== 1) bad.push(rel + ' req=' + nReq + ' build=' + nBuild)
  })
  ok(bad.length === 0, 'F1 6 个分享页面各 1 处 require + 1 处 build（' + bad.join(', ') + '）')

  const titleBad = []
  Object.keys(PAGES).forEach(function (k) {
    const src = fs.readFileSync(path.join(ROOT, PAGES[k]), 'utf8')
    if (src.indexOf(TITLE_KEY[k]) === -1) titleBad.push(k)
  })
  ok(titleBad.length === 0, 'F2 6 页原标题逻辑原样保留（未在改写中丢失）' + (titleBad.length ? ' → ' + titleBad.join(',') : ''))

  const pathBad = []
  Object.keys(PAGES).forEach(function (k) {
    const src = fs.readFileSync(path.join(ROOT, PAGES[k]), 'utf8')
    const i = src.indexOf('onShareAppMessage')
    const seg = src.slice(i, i + 900)
    if (seg.indexOf('path: ') === -1) pathBad.push(k)
  })
  ok(pathBad.length === 0, 'F3 6 页 path 字段仍在（' + pathBad.join(',') + '）')

  // 全项目无裸 imageUrl 残留
  function walk(dir, acc) {
    fs.readdirSync(dir).forEach(function (f) {
      const fp = path.join(dir, f)
      const st = fs.statSync(fp)
      if (st.isDirectory()) { if (f !== 'node_modules') walk(fp, acc) }
      else if (f.endsWith('.js')) acc.push(fp)
    })
    return acc
  }
  const allJs = walk(path.join(ROOT, 'pages'), [])
  let leak = 0
  allJs.forEach(function (fp) {
    if (fs.readFileSync(fp, 'utf8').indexOf('imageUrl: appInfo.SHARE_CARD_FILEID') !== -1) leak++
  })
  ok(leak === 0, 'F4 无页面再裸写 imageUrl（扫 ' + allJs.length + ' 个页面 JS，命中 ' + leak + '）')

  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  ok(appSrc.indexOf("require('./utils/shareCard.js').warmup()") !== -1, 'F5 app.js 已接启动预热')

  const modSrc = fs.readFileSync(SHARE_PATH, 'utf8')
  ok(modSrc.indexOf('if (st === false)') !== -1, 'F6 模块含「已知不可用 ⇒ 不带图」分支')
  ok(modSrc.indexOf('payload.promise = probe().then') !== -1, 'F7 模块含「未知 ⇒ promise 异步定夺」分支')
  ok(modSrc.indexOf('wx.cloud.getTempFileURL') !== -1, 'F8 探活用 getTempFileURL（不受域名白名单限制）')
  const quiet = ['console.log', 'console.warn', 'console.error', 'showToast', 'showModal']
  const noisy = quiet.filter(function (k) { return modSrc.indexOf(k) !== -1 })
  ok(noisy.length === 0, 'F9 模块失败静默（不含日志/弹窗调用）' + (noisy.length ? ' → ' + noisy.join(',') : ''))
  ok(modSrc.indexOf('try {') !== -1 && modSrc.indexOf('clearTimeout(timer)') !== -1,
    'F10 模块含异常兜底与超时清理')

  console.log('\n===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====')
  process.exit(fail ? 1 : 0)
}

main().catch(function (e) {
  console.log('\n✗ 套件自身异常（非业务断言）: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
