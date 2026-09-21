/**
 * 天气「时有时无」回归：[weather-cache-retry v1]
 * 运行：node tools/test_weather_cache.js
 *
 * 背景（真机反馈）：写日记页顶部天气胶囊时有时无。
 * 根因：只在 onLoad 拉一次，「定位授权 / 云函数 / 直连降级」任一环失败即静默消失，
 *       且无缓存、无重试；直连降级在真机上还受合法域名限制（现已在后台配置）。
 * 本套件真跑 utils/weather.js 的新逻辑：
 *   ① 本地缓存（TTL / 时钟回拨 / 脏数据 / 无效值不覆盖 / 返回副本）
 *   ② withRetry 退避重试（成功即止 / 全失败 resolve(null) / 抛异常与 reject 都兜住）
 *   ③ locateWeather 端到端（定位失败也重试、成功才写缓存、失败不污染缓存）
 *   ④ fetchByCoords 直连降级可用且写缓存
 * 并对页面接线做静态断言（先显缓存、失败不清空、onShow 补拉）。
 * 红灯守卫：旧版（无 readCache/withRetry/locateWeather）必须「精准红、不崩溃」。
 * [weather-city-backfill v1] 增 F 段：城市单独补拉（fetchCity/fillCity）、坐标缓存、城市继承。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}

// ---------------- wx 桩 ----------------
const store = {}
const ctl = { locateCalls: 0, requests: 0, cloudOk: false, requestOk: false, cloudCity: undefined }
const T0 = 1700000000000
const W = { city: '深圳市', temp: 28, text: '晴', icon: '☀️' }

const resetStore = () => { Object.keys(store).forEach((k) => { delete store[k] }) }

global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  getLocation: (o) => { if (o.fail) o.fail({ errMsg: 'getLocation:fail' }) },
  cloud: {
    callFunction: () => (ctl.cloudOk
      ? Promise.resolve({ result: { city: ctl.cloudCity === undefined ? '深圳市' : ctl.cloudCity, temp: 28, text: '晴', icon: '☀️' } })
      : Promise.reject(new Error('cloud fail')))
  },
  request: (o) => {
    ctl.requests++
    if (!ctl.requestOk) {
      if (o.fail) o.fail({ errMsg: 'request:fail' })
      if (o.complete) o.complete()
      return
    }
    if (/open-meteo/.test(o.url)) o.success({ data: { current_weather: { weathercode: 0, temperature: 28 } } })
    else o.success({ data: { city: '深圳市' } })
    if (o.complete) o.complete()
  }
}

const weather = require(path.join(ROOT, 'utils', 'weather.js'))

// 旧版守卫（红灯时精准红、不崩溃）
const readCache = (typeof weather.readCache === 'function') ? weather.readCache : () => null
const writeCache = (typeof weather.writeCache === 'function') ? weather.writeCache : () => false
const clearCache = (typeof weather.clearCache === 'function') ? weather.clearCache : () => {}
const withRetry = (typeof weather.withRetry === 'function') ? weather.withRetry : () => Promise.resolve(null)
const locateWeather = (typeof weather.locateWeather === 'function') ? weather.locateWeather : () => Promise.resolve(null)
const fetchByCoords = (typeof weather.fetchByCoords === 'function') ? weather.fetchByCoords : () => Promise.resolve(null)
const fetchCity = (typeof weather.fetchCity === 'function') ? weather.fetchCity : () => Promise.resolve('')
const fillCity = (typeof weather.fillCity === 'function') ? weather.fillCity : () => Promise.resolve(null)
const CACHE_KEY = weather.CACHE_KEY || 'weather_cache_v1'
const CACHE_TTL = weather.CACHE_TTL
const FRESH_MS = (typeof weather.FRESH_MS === 'number') ? weather.FRESH_MS : -1
const RETRY_DELAYS = Array.isArray(weather.RETRY_DELAYS) ? weather.RETRY_DELAYS : []

const immTimer = (fn) => setImmediate(fn)

function makeLocate(results) {
  let i = 0
  return (cb) => {
    ctl.locateCalls++
    const okNow = results[Math.min(i, results.length - 1)]
    i++
    if (okNow) cb.success({ latitude: 22.54, longitude: 114.06 })
    else cb.fail({ errMsg: 'getLocation:fail auth deny' })
  }
}

async function main() {
  console.log('== S) 导出与常量 ==')
  ok(typeof weather.readCache === 'function' && typeof weather.writeCache === 'function',
    'S1 导出 readCache / writeCache（缓存层入口）')
  ok(typeof weather.locateWeather === 'function' && typeof weather.fetchByCoords === 'function',
    'S2 导出 locateWeather / fetchByCoords（页面级入口）')
  ok(CACHE_KEY === 'weather_cache_v1', 'S3 缓存 key = weather_cache_v1')
  ok(CACHE_TTL === 30 * 60 * 1000, 'S4 缓存有效期 = 30 分钟', CACHE_TTL)
  ok(FRESH_MS === 5 * 60 * 1000, 'S5 FRESH_MS = 5 分钟（够新则不打网络）', FRESH_MS)
  ok(RETRY_DELAYS.join(',') === '3000,8000', 'S6 退避序列 = [3000, 8000]', RETRY_DELAYS)

  console.log('== A) 本地缓存 ==')
  resetStore()
  ok(readCache() === null, 'A1 无缓存 → null')
  ok(writeCache(W, T0) === true, 'A2 有效值写缓存成功')
  ok(store[CACHE_KEY] && store[CACHE_KEY].ts === T0 && store[CACHE_KEY].info.icon === '☀️',
    'A3 缓存结构 = { ts, info }')
  let c = readCache(T0 + 60000)
  ok(c && c.age === 60000 && c.info.city === '深圳市' && c.info.temp === 28 && c.info.text === '晴',
    'A4 新鲜缓存可读（age 正确、四字段完整）')
  ok(readCache(T0 + CACHE_TTL) !== null, 'A5 TTL 边界（满 30 分钟）仍有效')
  ok(readCache(T0 + CACHE_TTL + 1) === null, 'A6 超 TTL → 过期 null')
  ok(readCache(T0 - 1000) === null, 'A7 时钟回拨（ts 在未来）→ null')
  ok(writeCache(null, T0) === false &&
    !!(store[CACHE_KEY] && store[CACHE_KEY].info && store[CACHE_KEY].info.icon === '☀️'),
    'A8 无效值不写、不覆盖旧缓存（旧值仍在）')
  ok(writeCache({ city: 'x', temp: 1 }, T0) === false, 'A9 缺 icon 视为无效 → 不写')
  store[CACHE_KEY] = 'garbage'
  ok(readCache(T0) === null, 'A10 脏数据（字符串）→ null 不崩')
  store[CACHE_KEY] = { ts: 'abc', info: W }
  ok(readCache(T0) === null, 'A11 ts 非法 → null')
  store[CACHE_KEY] = { ts: T0, info: W }
  const copy = readCache(T0 + 1000)
  if (copy && copy.info) copy.info.city = '被外部改动'
  const again = readCache(T0 + 1000)
  ok(again && again.info.city === '深圳市', 'A12 返回副本（改返回值不污染 storage）')
  clearCache()
  ok(readCache(T0) === null, 'A13 clearCache 生效')

  console.log('== B) 退避重试 withRetry ==')
  let calls = 0
  let delays = []
  let r = await withRetry(() => { calls++; return Promise.resolve(W) },
    { timer: (fn, ms) => { delays.push(ms); setImmediate(fn) } })
  ok(r === W && calls === 1, 'B1 首次成功 → 只调 1 次、不再重试', calls)

  calls = 0; delays = []
  r = await withRetry((i) => { calls++; return Promise.resolve(i < 2 ? null : W) },
    { timer: (fn, ms) => { delays.push(ms); setImmediate(fn) } })
  ok(r === W && calls === 3, 'B2 前两次失败、第三次成功 → 调用 3 次', calls)
  ok(delays.join(',') === '3000,8000', 'B3 退避延迟序列 = 3s / 8s', delays)

  calls = 0
  r = await withRetry(() => { calls++; return Promise.resolve(null) }, { timer: immTimer })
  ok(r === null && calls === 3, 'B4 全失败 → resolve(null)（不 reject），共 3 次尝试', calls)

  calls = 0
  r = await withRetry(() => { calls++; if (calls === 1) throw new Error('boom'); return Promise.resolve(W) },
    { timer: immTimer })
  ok(r === W && calls === 2, 'B5 同步抛异常也重试（页面不需 try/catch）', calls)

  calls = 0
  r = await withRetry(() => { calls++; return Promise.reject(new Error('boom')) }, { timer: immTimer })
  ok(r === null && calls === 3, 'B6 全程 reject → 也收敛为 resolve(null)', calls)

  console.log('== C) locateWeather：定位失败也重试 ==')
  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = true; ctl.requestOk = false
  let info = await locateWeather({ locate: makeLocate([false, true]), timer: immTimer })
  ok(info && info.icon === '☀️' && ctl.locateCalls === 2,
    'C1 定位首次失败 → 重试成功（定位调用 2 次）', ctl.locateCalls)
  ok(readCache() !== null && readCache().info.temp === 28, 'C2 成功后自动写缓存（下次进页面秒显）')

  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = false; ctl.requestOk = false
  info = await locateWeather({ locate: makeLocate([true]), timer: immTimer })
  ok(info === null, 'C3 定位成功但天气全失败 → resolve(null)，页面保留旧显示')
  ok(readCache() === null, 'C4 失败不写缓存（不污染上次的值）')

  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = true
  let n = 0
  info = await locateWeather({
    locate: (cb) => {
      ctl.locateCalls++
      n++
      if (n < 2) cb.success({ latitude: 0, longitude: 0 })
      else cb.success({ latitude: 22.5, longitude: 114 })
    },
    timer: immTimer
  })
  ok(info && info.icon === '☀️' && ctl.locateCalls === 2, 'C5 空坐标视为失败 → 重试', ctl.locateCalls)

  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = false; ctl.requestOk = false
  info = await locateWeather({ locate: makeLocate([false]), timer: immTimer })
  ok(info === null && ctl.locateCalls === 3,
    'C6 全失败共 3 次尝试（1 + RETRY_DELAYS.length）', ctl.locateCalls)

  console.log('== D) fetchByCoords：直连降级（真机已配合法域名）==')
  resetStore(); ctl.cloudOk = false; ctl.requestOk = true; ctl.requests = 0
  info = await fetchByCoords(22.54, 114.06, { timer: immTimer })
  ok(info && info.temp === 28 && info.city === '深圳市' && info.text === '晴',
    'D1 云函数失败 → 直连降级取到天气+城市')
  ok(readCache() && readCache().info.icon === '☀️', 'D2 直连成功也写缓存')
  ok(ctl.requests === 2, 'D3 直连只请求一次（天气 + 城市各一次），成功不重试', ctl.requests)

  console.log('== F) [weather-city-backfill v1] 城市补拉 ==')
  ok(typeof weather.fetchCity === 'function' && typeof weather.fillCity === 'function',
    'F1 导出 fetchCity / fillCity（城市单独补拉入口）')

  resetStore()
  ok(writeCache(W, T0, { lat: 22.54, lon: 114.06 }) === true, 'F2 writeCache 带坐标写入成功')
  c = readCache(T0 + 1000)
  ok(c && c.coords && c.coords.lat === 22.54 && c.coords.lon === 114.06,
    'F2 缓存记录坐标（之后可单独补城市）', c && c.coords)
  store[CACHE_KEY] = { ts: T0, info: W, coords: { lat: 'x', lon: null } }
  ok(readCache(T0 + 1000) !== null && readCache(T0 + 1000).coords === null, 'F3 坐标脏数据 → coords 为 null，不崩')

  resetStore(); ctl.locateCalls = 0; ctl.cloudOk = true; ctl.cloudCity = ''; ctl.requestOk = false
  info = await locateWeather({ locate: makeLocate([true]), timer: immTimer })
  ok(info && info.icon === '☀️' && info.city === '', 'F4 云函数只缺城市 → 天气照常返回（city 为空串）')
  const c4 = readCache()
  ok(c4 && c4.info.city === '' && c4.coords && c4.coords.lat === 22.54,
    'F4 无城市结果也写缓存，且带坐标', c4 && c4.coords)

  resetStore(); ctl.cloudOk = true; ctl.cloudCity = ''
  writeCache({ city: '深圳市', temp: 27, text: '多云', icon: '⛅' }, T0, { lat: 22.54, lon: 114.06 })
  info = await locateWeather({ locate: makeLocate([true]), timer: immTimer })
  ok(info && info.city === '深圳市' && info.temp === 28, 'F5 新天气缺城市 → 继承旧缓存的城市名')

  resetStore(); ctl.cloudOk = true; ctl.cloudCity = ''; ctl.requestOk = true
  writeCache({ city: '', temp: 30, text: '晴', icon: '☀️' }, Date.now(), { lat: 22.54, lon: 114.06 })
  info = await fillCity()
  ok(info && info.city === '深圳市' && info.temp === 30, 'F6 fillCity 补到城市 → 返回合并 info')
  ok(readCache() && readCache().info.city === '深圳市' && readCache().info.temp === 30,
    'F6 fillCity 回写缓存（天气本体不变）')

  ok(await fillCity() === null, 'F7 城市已补上 → 再调返回 null（无需 setData）')
  resetStore()
  ok(await fillCity() === null, 'F7 无缓存 → null')
  writeCache({ city: '', temp: 30, text: '晴', icon: '☀️' }, Date.now())
  ok(await fillCity() === null, 'F7 缓存无坐标 → null')

  resetStore()
  writeCache({ city: '', temp: 30, text: '晴', icon: '☀️' }, Date.now(), { lat: 22.54, lon: 114.06 })
  ctl.requestOk = false
  ok(await fillCity() === null, 'F8 补拉失败 → null，不 reject')
  ok(readCache() && readCache().info.city === '', 'F8 失败不写缓存（下次仍可再补）')

  ctl.cloudCity = undefined; ctl.requestOk = false

  console.log('== E) 页面接线静态断言 ==')
  const wjs = read(path.join('pages', 'write', 'write.js'))
  const wxml = read(path.join('pages', 'write', 'write.wxml'))
  const wxjs = read(path.join('utils', 'weather.js'))
  const idx = wjs.indexOf('loadWeather() {')
  const seg = wjs.slice(idx, wjs.indexOf('  closeAllPanels() {'))
  ok(idx >= 0 && seg.indexOf('weather.readCache()') >= 0, 'E1 loadWeather 先读本地缓存')
  ok(seg.indexOf('weather.locateWeather()') > seg.indexOf('weather.readCache()'),
    'E2 缓存展示在网络请求之前（先秒显、再刷新）')
  ok(/cached\.age < weather\.FRESH_MS/.test(seg), 'E3 缓存够新则不打网络（省云函数调用）')
  ok(!/weatherInfo:\s*null/.test(seg), 'E4 失败不清空 weatherInfo（胶囊不消失）')
  ok(/if \(this\._weatherLoading\) return/.test(seg), 'E5 防重复请求（onLoad + onShow 紧邻触发）')
  ok(/if \(!this\.data\.weatherInfo\) this\.loadWeather\(\)/.test(wjs), 'E6 onShow 缺天气时补拉一次')
  ok(/weather\.fetchByCoords\(latitude, longitude\)/.test(wjs),
    'E7「选完位置刷新天气」也走带重试的入口')
  ok(/cloudGet\(lat, lon\)\.then\(\(r\) => r \|\| directGet\(lat, lon\)\)/.test(wxjs),
    'E8 云函数 → 直连 的降级顺序未变')
  ok(/function withRetry\(fetchOnce, opts\)/.test(wxjs) && /opts\.timer/.test(wxjs),
    'E9 重试支持注入 timer（可单测）')
  ok(CACHE_KEY.indexOf('diaries_') !== 0, 'E10 缓存 key 不与日记分片命名冲突')
  ok(wxml.indexOf('wx:if="{{weatherInfo}}"') >= 0,
    'E11 胶囊仍按 weatherInfo 有无显示（与「失败不清空」配套）')
  ok(/weather\.fillCity\(\)\.then/.test(seg) && /!cached\.info\.city/.test(seg),
    'E12 缓存缺城市时页面调 fillCity 单独补拉（天气本体不动）')
  ok(/noCoords/.test(seg) && /cached\.age < weather\.FRESH_MS && !noCoords/.test(seg),
    'E13 [v2] 旧格式缓存（无坐标）不吃「够新」短路 —— 否则坐标/城市永远补不回来')
  const cf = read(path.join('cloudfunctions', 'getWeather', 'index.js'))
  ok(/cityError/.test(cf) && /requestJson\(cityUrl, 12000\)/.test(cf),
    'E14 [v2] 云函数城市腿：超时放宽 12s + 失败重试 + cityError 标记')
  ok(/\[weather\] getLocation fail:/.test(wxjs) && /\[weather\] fetchCity fail:/.test(wxjs) && /\[weather\] cloud:/.test(wxjs),
    'E15 [v2] 三条链路的失败日志齐备（真机调试 Console 可见）')

  finish()
}

function finish() {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': pass=' + pass + ' fail=' + fail)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  ok(false, '测试运行异常（不应发生）', String((e && e.stack) || e))
  finish()
})
