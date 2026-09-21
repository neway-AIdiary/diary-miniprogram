# -*- coding: utf-8 -*-
"""
[weather-city-backfill v2] 真机仍不显示城市 → 补漏洞 + 加固 + 诊断
  1) 漏洞：旧格式缓存（无 coords）在 FRESH_MS 内会短路 refresh ⇒ 坐标永远补不上、城市永远补不回来
  2) 诊断：定位失败 / 逆地理失败 / 云函数返回 三条链路都打 [weather] 日志（真机调试 Console 可见）
  3) 加固：云函数城市腿超时 8s→12s + 失败重试一次 + 返回 cityError 标记
用法: --check / --write / --restore-src
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP = r"C:\Users\ThinkPad\WorkBuddy\city-backfill2-backup-20260921"
REL_FILES = [
    "utils/weather.js",
    "pages/write/write.js",
    "cloudfunctions/getWeather/index.js",
    "tools/test_weather_cache.js",
]

OPS = {
    "utils/weather.js": [
        dict(
            tag="v2-locate-log",
            old="""  const locate = opts.locate || function (cb) {
    wx.getLocation({ type: 'gcj02', success: cb.success, fail: cb.fail })
  }""",
            new="""  const locate = opts.locate || function (cb) {
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
  }""",
            sig="[weather] getLocation fail:",
        ),
        dict(
            tag="v2-fetchcity-log",
            old="""      success: (res) => {
        const g = res && res.data
        resolve(g ? String(g.city || g.locality || g.principalSubdivision || '').trim() : '')
      },
      fail: () => resolve('')""",
            new="""      success: (res) => {
        const g = res && res.data
        const c = g ? String(g.city || g.locality || g.principalSubdivision || '').trim() : ''
        console.log('[weather] fetchCity ok:', c || '(空)')
        resolve(c)
      },
      fail: (err) => {
        console.log('[weather] fetchCity fail:', err && err.errMsg)
        resolve('')
      }""",
            sig="[weather] fetchCity fail:",
        ),
        dict(
            tag="v2-cloud-log",
            old="""      const r = res && res.result
      if (r && r.temp !== undefined && r.icon) {""",
            new="""      const r = res && res.result
      console.log('[weather] cloud:', r && JSON.stringify({ city: r.city, cityError: r.cityError, temp: r.temp }))
      if (r && r.temp !== undefined && r.icon) {""",
            sig="[weather] cloud:",
        ),
    ],
    "pages/write/write.js": [
        dict(
            tag="v2-fresh-hole",
            old="""    if (cached && cached.age < weather.FRESH_MS) return   // 缓存够新，不再打网络
    this.refreshWeather()""",
            new="""    // [weather-city-backfill v2] 旧格式缓存（没有坐标）即便「够新」也必须打一次网络 ——
    // 否则坐标永远补不上、城市也永远补不回来（v1 的漏洞）
    const noCoords = !!(cached && !cached.coords)
    if (cached && cached.age < weather.FRESH_MS && !noCoords) return   // 缓存够新，不再打网络
    this.refreshWeather()""",
            sig="[weather-city-backfill v2]",
        ),
    ],
    "cloudfunctions/getWeather/index.js": [
        dict(
            tag="v2-cloud-city-retry",
            old="""  // 2) 城市（逆地理编码，中文优先）
  const g = await requestJson(
    'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=zh'
  )
  if (g) {
    result.city = String(g.city || g.locality || g.principalSubdivision || '').trim()
  }""",
            new="""  // 2) 城市（逆地理编码，中文优先）
  // [weather-city-backfill v2] 跨境接口首包可能 >8s：超时放宽到 12s，失败再试一次；
  //    仍失败时返回 cityError 标记（客户端会打日志，便于真机定位）
  const cityUrl = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=zh'
  let g = await requestJson(cityUrl, 12000)
  if (!g) g = await requestJson(cityUrl, 12000)
  if (g) {
    result.city = String(g.city || g.locality || g.principalSubdivision || '').trim()
  }
  if (!result.city) result.cityError = true""",
            sig="[weather-city-backfill v2]",
        ),
    ],
    "tools/test_weather_cache.js": [
        dict(
            tag="v2-assert",
            old="""  ok(/weather\\.fillCity\\(\\)\\.then/.test(seg) && /!cached\\.info\\.city/.test(seg),
    'E12 缓存缺城市时页面调 fillCity 单独补拉（天气本体不动）')""",
            new="""  ok(/weather\\.fillCity\\(\\)\\.then/.test(seg) && /!cached\\.info\\.city/.test(seg),
    'E12 缓存缺城市时页面调 fillCity 单独补拉（天气本体不动）')
  ok(/noCoords/.test(seg) && /cached\\.age < weather\\.FRESH_MS && !noCoords/.test(seg),
    'E13 [v2] 旧格式缓存（无坐标）不吃「够新」短路 —— 否则坐标/城市永远补不回来')
  const cf = read(path.join('cloudfunctions', 'getWeather', 'index.js'))
  ok(/cityError/.test(cf) && /requestJson\\(cityUrl, 12000\\)/.test(cf),
    'E14 [v2] 云函数城市腿：超时放宽 12s + 失败重试 + cityError 标记')
  ok(/\\[weather\\] getLocation fail:/.test(wxjs) && /\\[weather\\] fetchCity fail:/.test(wxjs) && /\\[weather\\] cloud:/.test(wxjs),
    'E15 [v2] 三条链路的失败日志齐备（真机调试 Console 可见）')""",
            sig="E15 [v2] \u4e09\u6761\u94fe\u8def",
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
        st = ""
        for op in ops:
            if op["sig"] in text:
                st = "SKIP"
            elif op["old"] in text:
                if do_write:
                    if text.count(op["old"]) != 1:
                        st = "ERR(锚点不唯一)"
                    else:
                        text = text.replace(op["old"], op["new"])
                        st = "OK"
                else:
                    st = "PENDING"
            else:
                st = "ERR(锚点0命中)"
            print("[%s] %s %s -> %s" % (mode, rel, op["tag"], st))
            if st.startswith("ERR"):
                bad += 1
        if do_write and not st.startswith("ERR"):
            backup()
            save(rel, raw, text)
    print("RESULT: " + ("FAIL x%d" % bad if bad else "ALL OK"))


main()
