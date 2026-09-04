/**
 * 云函数：getWeather
 * 输入：{ latitude, longitude }
 * 输出：{ city, temp, text, icon, code }（任一环节失败返回部分字段，前端自行容错）
 *
 * 数据源（均免费、无需 API Key）：
 *   - 天气：Open-Meteo  https://api.open-meteo.com/v1/forecast?current_weather=true
 *   - 城市：BigDataCloud reverse-geocode（localityLanguage=zh 返回中文）
 *
 * 说明：本函数不依赖 wx-server-sdk，仅用 Node 内置 https 模块，部署无需安装依赖。
 */

const https = require('https')

function requestJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs || 8000 }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

// WMO 天气代码 → 中文描述 + emoji 图标
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

exports.main = async (event) => {
  const lat = Number((event && event.latitude) || 0)
  const lon = Number((event && event.longitude) || 0)
  if (!lat || !lon) return { error: '缺少经纬度' }

  const result = {}

  // 1) 当前天气
  const w = await requestJson(
    'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current_weather=true&timezone=auto'
  )
  if (w && w.current_weather) {
    const code = w.current_weather.weathercode
    const wmo = WMO[code] || { text: '未知', icon: '🌡️' }
    result.temp = Math.round(w.current_weather.temperature)
    result.code = code
    result.text = wmo.text
    result.icon = wmo.icon
  }

  // 2) 城市（逆地理编码，中文优先）
  const g = await requestJson(
    'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=zh'
  )
  if (g) {
    result.city = String(g.city || g.locality || g.principalSubdivision || '').trim()
  }

  return result
}
