/**
 * 天气工具：获取定位城市 + 当前天气
 * 优先调用云函数 getWeather（生产推荐，无 request 域名白名单限制），
 * 失败自动降级为 wx.request 直连（开发者工具勾选「不校验合法域名」即可预览）。
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

module.exports = { getWeather }
