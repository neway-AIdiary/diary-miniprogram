/**
 * 天气工具：获取定位城市 + 当前天气
 * 优先调用云函数 getWeather（生产推荐，无 request 域名白名单限制），
 * 失败自动降级为 wx.request 直连（天气/地理两个域名已在后台配好合法域名，真机可用）。
 *
 * [weather-cache-retry v1] 修「天气时有时无」——以前是「一次性获取、任一环失败就静默消失」：
 *   ① 本地缓存：成功取到就落 storage，下次进页面先秒显上次的值（失败也不清空，胶囊不消失）
 *   ② 退避重试：整条链路（定位 → 云函数 → 直连降级）失败后按 3s / 8s 再试两次
 *   ③ 页面侧配合：回到页面仍缺天气时补拉一次（见 pages/write/write.js#loadWeather）
 *
 * [weather-city-backfill v1] 修「天气有了但城市不显示」：城市这路（逆地理编码）偶发失败时
 *   天气照常显示、城市留空；缓存会记下坐标，之后由页面调 fillCity() 单独补拉城市，
 *   且新取到的天气会先继承旧缓存里的城市名，避免城市无故消失。
 */

// WMO 天气代码 → 中文描述 + emoji 图标（与云函数保持一致）
const WMO = {
  0: { text: '晴', icon: '☀️' },
  1: { text: '大致晴朗', icon: '🌤️' },
  2: { text: '多云', icon: '⛅' },
  3: { text: '阴', icon: '☁️' },
  45: { text: '雾', icon: '🌫️' },
  48: { text: '雾凇', icon: '🌫️' },
  51: { text: '毛毛雨', icon: '🌦️' },
  53: { text: '毛毛雨', icon: '🌦️' },
  55: { text: '毛毛雨', icon: '🌦️' },
  56: { text: '冻毛毛雨', icon: '🌧️' },
  57: { text: '冻毛毛雨', icon: '🌧️' },
  61: { text: '小雨', icon: '🌧️' },
  63: { text: '中雨', icon: '🌧️' },
  65: { text: '大雨', icon: '🌧️' },
  66: { text: '冻雨', icon: '🌧️' },
  67: { text: '冻雨', icon: '🌧️' },
  71: { text: '小雪', icon: '❄️' },
  73: { text: '中雪', icon: '❄️' },
  75: { text: '大雪', icon: '❄️' },
  77: { text: '雪粒', icon: '❄️' },
  80: { text: '阵雨', icon: '🌧️' },
  81: { text: '阵雨', icon: '🌧️' },
  82: { text: '强阵雨', icon: '🌧️' },
  85: { text: '阵雪', icon: '❄️' },
  86: { text: '阵雪', icon: '❄️' },
  95: { text: '雷暴', icon: '⛈️' },
  96: { text: '雷暴伴冰雹', icon: '⛈️' },
  99: { text: '雷暴伴冰雹', icon: '⛈️' }
}

function wmoInfo(code) {
  return WMO[code] || { text: '未知', icon: '🌡️' }
}

// ===== [weather-cache-retry v1] ① 本地缓存（修「时有时无」的底座）=====
// 只要成功取到过一次，之后任何抖动都还能显示上次的天气；过期/异常一律当无缓存，绝不抛错。
const CACHE_KEY = 'weather_cache_v1'
const CACHE_TTL = 30 * 60 * 1000   // 缓存有效期：30 分钟
const FRESH_MS = 5 * 60 * 1000     // 5 分钟内的缓存视为够新，进页面不再打网络（省调用）
const RETRY_DELAYS = [3000, 8000]  // 失败重试退避：共 3 次尝试

function isValidWeather(info) {
  return !!(info && info.icon)
}

function pickWeather(info) {
  return {
    city: info.city || '',
    temp: info.temp,
    text: info.text || '',
    icon: info.icon
  }
}

/**
 * 读缓存
 * @param {number} [now] 注入当前时间（测试用）
 * @returns {{info:object, age:number}|null} 过期 / 时钟回拨 / 脏数据一律 null
 */
function readCache(now) {
  try {
    const c = wx.getStorageSync(CACHE_KEY)
    if (!c || typeof c !== 'object' || !isValidWeather(c.info)) return null
    const ts = Number(c.ts)
    if (!isFinite(ts) || ts <= 0) return null
    const cur = (typeof now === 'number') ? now : Date.now()
    const age = cur - ts
    if (age < 0 || age > CACHE_TTL) return null
    let coords = null
    if (c.coords && typeof c.coords.lat === 'number' && typeof c.coords.lon === 'number') {
      coords = { lat: c.coords.lat, lon: c.coords.lon }
    }
    return { info: pickWeather(c.info), age: age, coords: coords }
  } catch (e) {
    return null
  }
}

/**
 * 写缓存（无效值不写、不覆盖旧值）
 * @returns {boolean} 是否写入成功
 */
function writeCache(info, now, coords) {
  try {
    if (!isValidWeather(info)) return false
    const entry = {
      ts: (typeof now === 'number') ? now : Date.now(),
      info: pickWeather(info)
    }
    // [weather-city-backfill v1] 记下坐标：之后城市缺失时可单独补拉
    if (coords && typeof coords.lat === 'number' && typeof coords.lon === 'number') {
      entry.coords = { lat: coords.lat, lon: coords.lon }
    }
    wx.setStorageSync(CACHE_KEY, entry)
    return true
  } catch (e) {
    return false
  }
}

function clearCache() {
  try { wx.removeStorageSync(CACHE_KEY) } catch (e) { /* 静默 */ }
}

// ===== [weather-cache-retry v1] ② 退避重试 =====
/**
 * 带退避重试的取值：fetchOnce(i) 每次尝试都重新执行（定位/网络都重来）。
 * 成功即返回；全程失败 resolve(null) —— 永不 reject，调用方无需 try/catch。
 * @param {function(number):Promise} fetchOnce
 * @param {{delays?:number[], timer?:function}} [opts] timer 可注入（测试用）
 */
function withRetry(fetchOnce, opts) {
  opts = opts || {}
  const delays = opts.delays || RETRY_DELAYS
  const timer = opts.timer || (typeof setTimeout === 'function' ? setTimeout : null)

  function backoff(i) {
    if (i >= delays.length || !timer) return null
    return new Promise(function (resolve) {
      timer(function () { resolve(attempt(i + 1)) }, delays[i])
    })
  }
  function attempt(i) {
    return Promise.resolve()
      .then(function () { return fetchOnce(i) })
      .then(function (info) { return isValidWeather(info) ? info : backoff(i) })
      .catch(function () { return backoff(i) })
  }
  return Promise.resolve().then(function () { return attempt(0) })
}

// ===== [weather-city-backfill v1] 城市单独补拉 =====
/**
 * 只拉城市（逆地理编码，中文）。任何失败 resolve('')，永不 reject。
 */
function fetchCity(lat, lon) {
  return new Promise((resolve) => {
    wx.request({
      url: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
      data: { latitude: lat, longitude: lon, localityLanguage: 'zh' },
      timeout: 8000,
      success: (res) => {
        const g = res && res.data
        const c = g ? String(g.city || g.locality || g.principalSubdivision || '').trim() : ''
        console.log('[weather] fetchCity ok:', c || '(空)')
        resolve(c)
      },
      fail: (err) => {
        console.log('[weather] fetchCity fail:', err && err.errMsg)
        resolve('')
      }
    })
  })
}

/**
 * 新天气没带城市时，继承旧缓存里的城市名（不看 TTL —— 城市名不怕旧，就怕丢）。
 */
function mergeCityFromCache(info) {
  if (info && info.city) return info
  let oldCity = ''
  try {
    const c = wx.getStorageSync(CACHE_KEY)
    if (c && typeof c === 'object' && c.info && isValidWeather(c.info)) {
      oldCity = String(c.info.city || '').trim()
    }
  } catch (e) { oldCity = '' }
  return oldCity ? Object.assign({}, info, { city: oldCity }) : info
}

// ===== ③ 页面级入口（都自带缓存写入，页面只管 setData）=====
/**
 * 定位 + 取天气（带重试）。定位失败、天气失败都会按退避重试。
 * @param {{locate?:function, delays?:number[], timer?:function, onSettle?:function}} [opts] 可注入依赖（测试用）
 * @returns {Promise<object|null>}
 */
function locateWeather(opts) {
  opts = opts || {}
  // [privacy-weather-gate v2] onSettle：**首次**定位调用有结论时回调一次（成功 / 失败 / 空坐标都算），
  // 重试不重复回调。页面靠它判断「系统定位授权弹框已被用户处理完」，再把新手引导放出来
  //（两个弹层不同屏）。回调异常一律吞掉 —— 绝不能因为引导的事影响取天气。
  const onSettle = (typeof opts.onSettle === 'function') ? opts.onSettle : null
  let settled = false
  function markSettled() {
    if (settled) return
    settled = true
    if (onSettle) { try { onSettle() } catch (e) { /* 静默 */ } }
  }
  const locate = opts.locate || function (cb) {
    // [weather-city-backfill v2] 失败原因打日志（真机调试 Console 可见：auth deny / 系统定位关闭 / api 未声明）
    wx.getLocation({
      type: 'gcj02',
      success: function (res) {
        console.log('[weather] getLocation ok:', res.latitude, res.longitude)
        cb.success(res)
      },
      fail: function (err) {
        console.log('[weather] getLocation fail:', err && err.errMsg)
        cb.fail(err)
      }
    })
  }
  let lastCoords = null
  return withRetry(function () {
    return new Promise(function (resolve) {
      locate({
        success: function (loc) {
          markSettled()
          if (!loc || !loc.latitude || !loc.longitude) { resolve(null); return }
          lastCoords = { lat: loc.latitude, lon: loc.longitude }
          resolve(getWeather(loc.latitude, loc.longitude))
        },
        fail: function () { markSettled(); resolve(null) }
      })
    })
  }, { delays: opts.delays, timer: opts.timer }).then(function (info) {
    // [weather-city-backfill v1] 天气到了但城市空 → 先继承旧缓存的城市，再单独补拉一次
    if (!isValidWeather(info)) return info
    const merged = mergeCityFromCache(info)
    if (merged.city) { writeCache(merged, null, lastCoords); return merged }
    if (!lastCoords) { writeCache(merged, null, null); return merged }
    return fetchCity(lastCoords.lat, lastCoords.lon).then(function (city) {
      const out = city ? Object.assign({}, merged, { city: city }) : merged
      writeCache(out, null, lastCoords)
      return out
    })
  })
}

/**
 * 指定坐标取天气（带重试）——「位置」面板选完位置后刷新用
 * @returns {Promise<object|null>}
 */
function fetchByCoords(lat, lon, opts) {
  opts = opts || {}
  const coords = { lat: lat, lon: lon }
  return withRetry(function () {
    return getWeather(lat, lon)
  }, { delays: opts.delays, timer: opts.timer }).then(function (info) {
    // [weather-city-backfill v1] 同 locateWeather：城市空 → 继承旧值 + 单独补拉
    if (!isValidWeather(info)) return info
    const merged = mergeCityFromCache(info)
    if (merged.city) { writeCache(merged, null, coords); return merged }
    return fetchCity(lat, lon).then(function (city) {
      const out = city ? Object.assign({}, merged, { city: city }) : merged
      writeCache(out, null, coords)
      return out
    })
  })
}

/**
 * [weather-city-backfill v1] 缓存里有天气但没城市 → 用缓存坐标单独补拉城市并回写缓存。
 * @param {{fetchCity?:function, now?:number}} [opts] 可注入依赖（测试用）
 * @returns {Promise<object|null>} 补到城市时返回合并后的 info；否则 null（页面不用 setData）
 */
function fillCity(opts) {
  opts = opts || {}
  const fcity = opts.fetchCity || fetchCity
  const c = readCache(opts.now)
  if (!c || c.info.city || !c.coords) return Promise.resolve(null)
  return fcity(c.coords.lat, c.coords.lon).then(function (city) {
    if (!city) return null
    const merged = Object.assign({}, c.info, { city: city })
    writeCache(merged, opts.now, c.coords)
    return merged
  })
}

/**
 * 优先走云函数
 * @returns {Promise<object|null>}
 */
function cloudGet(lat, lon) {
  return new Promise((resolve) => {
    if (!wx.cloud) {
      resolve(null)
      return
    }
    wx.cloud.callFunction({
      name: 'getWeather',
      data: { latitude: lat, longitude: lon }
    }).then(res => {
      const r = res && res.result
      console.log('[weather] cloud:', r && JSON.stringify({ city: r.city, cityError: r.cityError, temp: r.temp }))
      if (r && r.temp !== undefined && r.icon) {
        resolve({
          city: r.city || '',
          temp: r.temp,
          text: r.text || '',
          icon: r.icon
        })
      } else {
        resolve(null)
      }
    }).catch(() => resolve(null))
  })
}

/**
 * 降级：wx.request 直连（开发预览用）
 * @returns {Promise<object|null>}
 */
function directGet(lat, lon) {
  return new Promise((resolve) => {
    let weather = null
    let city = ''
    let pending = 2
    let done = false
    const settle = () => {
      if (--pending > 0) return
      if (done) return
      done = true
      if (weather) {
        resolve({
          city: city,
          temp: weather.temp,
          text: weather.text,
          icon: weather.icon
        })
      } else {
        resolve(null)
      }
    }

    // 天气
    wx.request({
      url: 'https://api.open-meteo.com/v1/forecast',
      data: { latitude: lat, longitude: lon, current_weather: true, timezone: 'auto' },
      timeout: 8000,
      success: (res) => {
        const cur = res.data && res.data.current_weather
        if (cur && cur.weathercode !== undefined) {
          const w = wmoInfo(cur.weathercode)
          weather = {
            temp: Math.round(cur.temperature),
            text: w.text,
            icon: w.icon
          }
        }
      },
      fail: () => {},
      complete: settle
    })

    // 城市（逆地理）
    wx.request({
      url: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
      data: { latitude: lat, longitude: lon, localityLanguage: 'zh' },
      timeout: 8000,
      success: (res) => {
        const g = res.data
        if (g) {
          city = String(g.city || g.locality || g.principalSubdivision || '').trim()
        }
      },
      fail: () => {},
      complete: settle
    })
  })
}

/**
 * 获取定位城市与天气
 * @param {number} lat 纬度
 * @param {number} lon 经度
 * @returns {Promise<{city:string, temp:number, text:string, icon:string}|null>} 失败返回 null
 */
function getWeather(lat, lon) {
  return cloudGet(lat, lon).then((r) => r || directGet(lat, lon))
}

module.exports = {
  // [weather-cache-retry v1] 新增导出：缓存 + 重试 + 页面级入口
  getWeather,
  locateWeather,
  fetchByCoords,
  readCache,
  writeCache,
  clearCache,
  withRetry,
  fetchCity,
  fillCity,
  CACHE_KEY,
  CACHE_TTL,
  FRESH_MS,
  RETRY_DELAYS
}
