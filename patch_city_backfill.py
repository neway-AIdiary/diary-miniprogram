# -*- coding: utf-8 -*-
"""
[weather-city-backfill v1] 修「天气有了但城市不显示」
  - utils/weather.js : 缓存记坐标 / fetchCity+fillCity 单独补拉城市 / 城市继承
  - pages/write/write.js : loadWeather 秒显缓存后发现缺城市 → 调 fillCity 补拉
  - tools/test_weather_cache.js : 新增 F 段 + E12 静态断言
用法: --check / --write / --restore / --restore-src
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP = r"C:\Users\ThinkPad\WorkBuddy\city-backfill-backup-20260921"
REL_FILES = ["utils/weather.js", "pages/write/write.js", "tools/test_weather_cache.js"]

OPS = {
    "utils/weather.js": [
        # w1 头注释
        dict(
            tag="w1-header",
            old=""" *   \u2462 \u9875\u9762\u4fa7\u914d\u5408\uff1a\u56de\u5230\u9875\u9762\u4ecd\u7f3a\u5929\u6c14\u65f6\u8865\u62c9\u4e00\u6b21\uff08\u89c1 pages/write/write.js#loadWeather\uff09
 */""",
            new=""" *   \u2462 \u9875\u9762\u4fa7\u914d\u5408\uff1a\u56de\u5230\u9875\u9762\u4ecd\u7f3a\u5929\u6c14\u65f6\u8865\u62c9\u4e00\u6b21\uff08\u89c1 pages/write/write.js#loadWeather\uff09
 *
 * [weather-city-backfill v1] \u4fee\u300c\u5929\u6c14\u6709\u4e86\u4f46\u57ce\u5e02\u4e0d\u663e\u793a\u300d\uff1a\u57ce\u5e02\u8fd9\u8def\uff08\u9006\u5730\u7406\u7f16\u7801\uff09\u5076\u53d1\u5931\u8d25\u65f6
 *   \u5929\u6c14\u7167\u5e38\u663e\u793a\u3001\u57ce\u5e02\u7559\u7a7a\uff1b\u7f13\u5b58\u4f1a\u8bb0\u4e0b\u5750\u6807\uff0c\u4e4b\u540e\u7531\u9875\u9762\u8c03 fillCity() \u5355\u72ec\u8865\u62c9\u57ce\u5e02\uff0c
 *   \u4e14\u65b0\u53d6\u5230\u7684\u5929\u6c14\u4f1a\u5148\u7ee7\u627f\u65e7\u7f13\u5b58\u91cc\u7684\u57ce\u5e02\u540d\uff0c\u907f\u514d\u57ce\u5e02\u65e0\u6545\u6d88\u5931\u3002
 */""",
            sig="[weather-city-backfill v1]",
        ),
        # w2 writeCache 支持坐标
        dict(
            tag="w2-writecache-coords",
            old="""function writeCache(info, now) {
  try {
    if (!isValidWeather(info)) return false
    wx.setStorageSync(CACHE_KEY, {
      ts: (typeof now === 'number') ? now : Date.now(),
      info: pickWeather(info)
    })
    return true""",
            new="""function writeCache(info, now, coords) {
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
    return true""",
            sig="entry.coords = { lat: coords.lat, lon: coords.lon }",
        ),
        # w3 readCache 返回坐标
        dict(
            tag="w3-readcache-coords",
            old="""    if (age < 0 || age > CACHE_TTL) return null
    return { info: pickWeather(c.info), age: age }""",
            new="""    if (age < 0 || age > CACHE_TTL) return null
    let coords = null
    if (c.coords && typeof c.coords.lat === 'number' && typeof c.coords.lon === 'number') {
      coords = { lat: c.coords.lat, lon: c.coords.lon }
    }
    return { info: pickWeather(c.info), age: age, coords: coords }""",
            sig="coords = { lat: c.coords.lat, lon: c.coords.lon }",
        ),
        # w4 插入 fetchCity + mergeCityFromCache
        dict(
            tag="w4-fetchcity",
            old="// ===== \u2462 \u9875\u9762\u7ea7\u5165\u53e3\uff08\u90fd\u81ea\u5e26\u7f13\u5b58\u5199\u5165\uff0c\u9875\u9762\u53ea\u7ba1 setData\uff09=====",
            new="""// ===== [weather-city-backfill v1] 城市单独补拉 =====
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
        resolve(g ? String(g.city || g.locality || g.principalSubdivision || '').trim() : '')
      },
      fail: () => resolve('')
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

// ===== \u2462 \u9875\u9762\u7ea7\u5165\u53e3\uff08\u90fd\u81ea\u5e26\u7f13\u5b58\u5199\u5165\uff0c\u9875\u9762\u53ea\u7ba1 setData\uff09=====""",
            sig="function mergeCityFromCache(info)",
        ),
        # w5 locateWeather 重写收尾段
        dict(
            tag="w5-locateweather",
            old="""  return withRetry(function () {
    return new Promise(function (resolve) {
      locate({
        success: function (loc) {
          if (!loc || !loc.latitude || !loc.longitude) { resolve(null); return }
          resolve(getWeather(loc.latitude, loc.longitude))
        },
        fail: function () { resolve(null) }
      })
    })
  }, { delays: opts.delays, timer: opts.timer }).then(function (info) {
    if (isValidWeather(info)) writeCache(info)
    return info
  })""",
            new="""  let lastCoords = null
  return withRetry(function () {
    return new Promise(function (resolve) {
      locate({
        success: function (loc) {
          if (!loc || !loc.latitude || !loc.longitude) { resolve(null); return }
          lastCoords = { lat: loc.latitude, lon: loc.longitude }
          resolve(getWeather(loc.latitude, loc.longitude))
        },
        fail: function () { resolve(null) }
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
  })""",
            sig="let lastCoords = null",
        ),
        # w6 fetchByCoords 重写收尾段
        dict(
            tag="w6-fetchbycoords",
            old="""  return withRetry(function () {
    return getWeather(lat, lon)
  }, { delays: opts.delays, timer: opts.timer }).then(function (info) {
    if (isValidWeather(info)) writeCache(info)
    return info
  })""",
            new="""  const coords = { lat: lat, lon: lon }
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
  })""",
            sig="\u540c locateWeather\uff1a\u57ce\u5e02\u7a7a \u2192 \u7ee7\u627f\u65e7\u503c",
        ),
        # w7 fillCity 插到 cloudGet 前
        dict(
            tag="w7-fillcity",
            old="""/**
 * 优先走云函数
 * @returns {Promise<object|null>}
 */
function cloudGet(lat, lon) {""",
            new="""/**
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
function cloudGet(lat, lon) {""",
            sig="function fillCity(opts)",
        ),
        # w8 导出
        dict(
            tag="w8-exports",
            old="""  clearCache,
  withRetry,
  CACHE_KEY,""",
            new="""  clearCache,
  withRetry,
  fetchCity,
  fillCity,
  CACHE_KEY,""",
            sig="  fillCity,",
        ),
    ],
    "pages/write/write.js": [
        # j1 loadWeather 接线
        dict(
            tag="j1-loadweather",
            old="""    const cached = weather.readCache()
    if (cached) this.setData({ weatherInfo: cached.info })
    if (cached && cached.age < weather.FRESH_MS) return   // 缓存够新，不再打网络
    this.refreshWeather()""",
            new="""    const cached = weather.readCache()
    if (cached) this.setData({ weatherInfo: cached.info })
    // [weather-city-backfill v1] 天气在但城市空 → 用缓存坐标单独补拉城市（天气本体不动）
    if (cached && !cached.info.city && cached.coords) {
      weather.fillCity().then((info) => {
        if (info && info.city) this.setData({ weatherInfo: info })
      })
    }
    if (cached && cached.age < weather.FRESH_MS) return   // 缓存够新，不再打网络
    this.refreshWeather()""",
            sig="weather.fillCity().then",
        ),
    ],
    "tools/test_weather_cache.js": [
        # t1 ctl 加 cloudCity
        dict(
            tag="t1-ctl",
            old="const ctl = { locateCalls: 0, requests: 0, cloudOk: false, requestOk: false }",
            new="const ctl = { locateCalls: 0, requests: 0, cloudOk: false, requestOk: false, cloudCity: undefined }",
            sig="cloudCity: undefined",
        ),
        # t2 云桩可控 city
        dict(
            tag="t2-stub",
            old="""  cloud: {
    callFunction: () => (ctl.cloudOk
      ? Promise.resolve({ result: { city: '深圳市', temp: 28, text: '晴', icon: '☀️' } })
      : Promise.reject(new Error('cloud fail')))
  },""",
            new="""  cloud: {
    callFunction: () => (ctl.cloudOk
      ? Promise.resolve({ result: { city: ctl.cloudCity === undefined ? '深圳市' : ctl.cloudCity, temp: 28, text: '晴', icon: '☀️' } })
      : Promise.reject(new Error('cloud fail')))
  },""",
            sig="ctl.cloudCity === undefined ? '深圳市' : ctl.cloudCity",
        ),
        # t3 守卫
        dict(
            tag="t3-guards",
            old="const fetchByCoords = (typeof weather.fetchByCoords === 'function') ? weather.fetchByCoords : () => Promise.resolve(null)",
            new="""const fetchByCoords = (typeof weather.fetchByCoords === 'function') ? weather.fetchByCoords : () => Promise.resolve(null)
const fetchCity = (typeof weather.fetchCity === 'function') ? weather.fetchCity : () => Promise.resolve('')
const fillCity = (typeof weather.fillCity === 'function') ? weather.fillCity : () => Promise.resolve(null)""",
            sig="const fillCity = (typeof weather.fillCity === 'function')",
        ),
        # t4 头注释
        dict(
            tag="t4-header",
            old=""" * 红灯守卫：旧版（无 readCache/withRetry/locateWeather）必须「精准红、不崩溃」。
 */""",
            new=""" * 红灯守卫：旧版（无 readCache/withRetry/locateWeather）必须「精准红、不崩溃」。
 * [weather-city-backfill v1] 增 F 段：城市单独补拉（fetchCity/fillCity）、坐标缓存、城市继承。
 */""",
            sig="[weather-city-backfill v1] \u589e F \u6bb5",
        ),
        # t5 F 段
        dict(
            tag="t5-section-f",
            old="  console.log('== E) 页面接线静态断言 ==')",
            new="""  console.log('== F) [weather-city-backfill v1] 城市补拉 ==')
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

  console.log('== E) 页面接线静态断言 ==')""",
            sig="F8 \u8865\u62c9\u5931\u8d25",
        ),
        # t6 E12
        dict(
            tag="t6-e12",
            old="""  ok(wxml.indexOf('wx:if="{{weatherInfo}}"') >= 0,
    'E11 胶囊仍按 weatherInfo 有无显示（与「失败不清空」配套）')

  finish()""",
            new="""  ok(wxml.indexOf('wx:if="{{weatherInfo}}"') >= 0,
    'E11 胶囊仍按 weatherInfo 有无显示（与「失败不清空」配套）')
  ok(/weather\\.fillCity\\(\\)\\.then/.test(seg) && /!cached\\.info\\.city/.test(seg),
    'E12 缓存缺城市时页面调 fillCity 单独补拉（天气本体不动）')

  finish()""",
            sig="E12 \u7f13\u5b58\u7f3a\u57ce\u5e02",
        ),
    ],
}


def load(rel):
    raw = open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")
    return raw, raw.replace("\r\n", "\n")


def save(rel, raw, text):
    nl = "\r\n" if "\r\n" in raw else "\n"
    out = text.replace("\n", nl) if nl == "\r\n" else text
    open(os.path.join(ROOT, rel), "wb").write(out.encode("utf-8"))


def backup():
    if os.path.isdir(BACKUP):
        return
    for rel in REL_FILES:
        dst = os.path.join(BACKUP, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace("/", os.sep)), dst)


def apply(text, op, do_write):
    if op["sig"] in text:
        return text, "SKIP"
    if op["old"] in text:
        if not do_write:
            return text, "PENDING"
        if text.count(op["old"]) != 1:
            return text, "ERR(锚点不唯一)"
        return text.replace(op["old"], op["new"]), "OK"
    # 恢复模式：old 不在、sig 也不在 → 可能需要回退
    return text, "ERR(锚点0命中)"


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    do_write = mode == "--write"
    bad = 0
    for rel, ops in OPS.items():
        raw, text = load(rel)
        if mode == "--restore-src":
            src = os.path.join(BACKUP, rel.replace("/", os.sep))
            shutil.copy2(src, os.path.join(ROOT, rel.replace("/", os.sep)))
            print("[RESTORED] " + rel)
            continue
        for op in ops:
            text, st = apply(text, op, do_write)
            print("[%s] %s %s → %s" % (mode, rel, op["tag"], st))
            if st.startswith("ERR"):
                bad += 1
        if do_write and not st.startswith("ERR"):
            backup()
            save(rel, raw, text)
    if mode == "--restore-src":
        print("done: source restored from backup")
        return
    print("RESULT: " + ("FAIL x%d" % bad if bad else "ALL OK"))


main()
