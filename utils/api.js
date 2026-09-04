/**
 * utils/api.js — diary-server（Railway）HTTP 请求层
 *
 * - 统一 BASE_URL（如更换服务器只改这里）
 * - 微信登录：wx.login code → POST /api/auth/wechat-login → JWT token（本地缓存）
 * - 所有需要认证的请求自动带 Authorization: Bearer <token>，401 自动重登录重试一次
 *
 * 注意：正式环境需要在微信公众平台把本域名加入 request 合法域名；
 *      开发阶段可在开发者工具中勾选「不校验合法域名」。
 */

const BASE_URL = 'https://diary-server-production-9e56.up.railway.app'
const TOKEN_KEY = 'server_token'

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

function saveToken(token) {
  try {
    wx.setStorageSync(TOKEN_KEY, token)
  } catch (e) { /* 忽略 */ }
}

// 微信登录（code → JWT）。code 一次性，失败自动重取
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('wx.login 未返回 code'))
          return
        }
        wx.request({
          url: BASE_URL + '/api/auth/wechat-login',
          method: 'POST',
          data: { code: res.code },
          timeout: 15000,
          success: (r) => {
            const body = r.data || {}
            if (r.statusCode === 200 && body.code === 0 && body.data && body.data.token) {
              saveToken(body.data.token)
              resolve(body.data.token)
            } else {
              reject(new Error(body.message || ('登录失败(' + r.statusCode + ')')))
            }
          },
          fail: (err) => {
            reject(new Error((err && err.errMsg) || '网络异常，登录失败'))
          }
        })
      },
      fail: () => reject(new Error('微信登录调用失败'))
    })
  })
}

// 确保已登录（有 token 直接用；无 token 先登录）
function ensureLogin() {
  const token = getToken()
  if (token) return Promise.resolve(token)
  return login()
}

/**
 * 统一请求：自动登录、自动带 token、401 自动重登重试一次
 * @param {string} method GET/POST/PUT/DELETE
 * @param {string} path 如 /api/backup
 * @param {object} data body（GET 时忽略）
 * @param {object} opts { silent: true } 静默模式（错误不弹 toast，由调用方处理）
 * @returns {Promise<object>} 服务端 data 字段
 */
function request(method, path, data, opts) {
  opts = opts || {}
  return ensureLogin().then((token) => {
    return new Promise((resolve, reject) => {
      wx.request({
        url: BASE_URL + path,
        method: method,
        data: data || {},
        timeout: 60000,
        header: {
          'content-type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        success: (r) => {
          const body = r.data || {}
          if (r.statusCode === 200 && body.code === 0) {
            resolve(body.data !== undefined ? body.data : body)
          } else if (r.statusCode === 401) {
            // token 过期：重登录后重试一次
            saveToken('')
            login().then(() => {
              wx.request({
                url: BASE_URL + path,
                method: method,
                data: data || {},
                timeout: 60000,
                header: {
                  'content-type': 'application/json',
                  'Authorization': 'Bearer ' + getToken()
                },
                success: (r2) => {
                  const b2 = r2.data || {}
                  if (r2.statusCode === 200 && b2.code === 0) {
                    resolve(b2.data !== undefined ? b2.data : b2)
                  } else {
                    reject(new Error(b2.message || ('请求失败(' + r2.statusCode + ')')))
                  }
                },
                fail: (e2) => reject(new Error((e2 && e2.errMsg) || '网络异常'))
              })
            }).catch(reject)
          } else {
            const msg = body.message || ('请求失败(' + r.statusCode + ')')
            if (!opts.silent) wx.showToast({ title: msg, icon: 'none' })
            reject(new Error(msg))
          }
        },
        fail: (err) => {
          const msg = (err && err.errMsg && err.errMsg.indexOf('domain') !== -1)
            ? '域名未加入小程序 request 合法域名（开发工具请勾选「不校验合法域名」）'
            : ((err && err.errMsg) || '网络异常')
          if (!opts.silent) wx.showToast({ title: msg, icon: 'none', duration: 2500 })
          reject(new Error(msg))
        }
      })
    })
  })
}

module.exports = {
  BASE_URL: BASE_URL,
  login: login,
  ensureLogin: ensureLogin,
  request: request
}
