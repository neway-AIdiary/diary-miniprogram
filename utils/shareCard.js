/**
 * 分享卡片品牌图探活 + 失败回落页面截图 [share-card-fallback v1]（2026-09-24）
 *
 * 背景：onShareAppMessage 一旦返回 imageUrl 但图取不到，微信**不会**回落到
 * 「当前页面截图」，而是显示破图占位。所以要兜底必须做到：
 *   探不到图 ⇒ **根本不返回 imageUrl** ⇒ 微信自动截图。
 *
 * 三级判定（危险默认：默认不带图 = 截图，只有确认可达才带图）：
 *   1. 内存/缓存已知**可用** → 同步返回带 imageUrl（零延迟，绝大多数情况）
 *   2. 内存/缓存已知**不可用** → 同步返回不带 imageUrl（直接走页面截图）
 *   3. 状态**未知** → 返回 promise 字段异步定夺（基础库 2.12.0+）：
 *      3 秒内未 resolve 微信用传入的默认参数（= 不带图 = 截图）；
 *      低版本基础库直接忽略 promise 字段，同样落到「不带图 = 截图」，安全降级。
 *
 * 探活手段：wx.cloud.getTempFileURL（云能力，不受合法域名白名单限制），
 * status === 0 且拿到 tempFileURL 才算可达；1.5 秒超时即判不可用。
 * 缓存策略：可用 7 天 / 不可用 10 分钟（用户重新上传图后能较快自愈）。
 *
 * ⚠️ 全程失败静默：探活不弹窗、不报错、不打日志、绝不阻塞或拖慢分享面板弹出。
 * ⚠️ 只判「文件存在且可读」，不做图片解码校验（getImageInfo 走网络图需域名白名单，
 *    会误判）。文件在但内容不是图片属极端上传错误，不在此兜底范围。
 */
const appInfo = require('./appInfo.js')

const CACHE_KEY = 'shareCardFileOk'
const TTL_OK = 7 * 24 * 3600 * 1000     // 可用：7 天
const TTL_FAIL = 10 * 60 * 1000         // 不可用：10 分钟（重传后可自愈）
const PROBE_TIMEOUT = 1500              // 探活硬超时
const WARMUP_DELAY = 800                // 启动预热延迟（避开启动高峰）

let memState = null   // true 可用 / false 不可用 / null 未知（本次会话内存态）
let inFlight = null   // 探活去重

function readCache() {
  try {
    const c = wx.getStorageSync(CACHE_KEY)
    if (!c || typeof c.ok !== 'boolean' || !c.ts) return null
    const ttl = c.ok ? TTL_OK : TTL_FAIL
    if (Date.now() - c.ts > ttl) return null
    return c.ok
  } catch (e) {
    return null
  }
}

function writeCache(ok) {
  try {
    wx.setStorageSync(CACHE_KEY, { ok: !!ok, ts: Date.now() })
  } catch (e) {}
}

/* 同步状态：true 可用 / false 不可用（含未配置 fileID）/ null 未知 */
function getState() {
  if (!appInfo.SHARE_CARD_FILEID) return false
  if (memState !== null) return memState
  const c = readCache()
  if (c !== null) memState = c
  return c
}

/* 异步探活：去重、硬超时、永不 reject，结果写内存 + 本地缓存 */
function probe() {
  if (inFlight) return inFlight

  const p = new Promise(function (resolve) {
    let settled = false
    function done(ok) {
      if (settled) return
      settled = true
      memState = !!ok
      writeCache(!!ok)
      resolve(!!ok)
    }

    const timer = setTimeout(function () { done(false) }, PROBE_TIMEOUT)
    try {
      if (!appInfo.SHARE_CARD_FILEID || !wx.cloud || !wx.cloud.getTempFileURL) {
        clearTimeout(timer)
        return done(false)
      }
      wx.cloud.getTempFileURL({
        fileList: [appInfo.SHARE_CARD_FILEID],
        success: function (res) {
          const f = (res && res.fileList && res.fileList[0]) || null
          clearTimeout(timer)
          done(!!(f && f.status === 0 && f.tempFileURL))
        },
        fail: function () {
          clearTimeout(timer)
          done(false)
        }
      })
    } catch (e) {
      clearTimeout(timer)
      done(false)
    }
  })

  inFlight = p
  // 清理放微任务：即使 wx 桩同步回调（done 早于赋值执行）也不会把已完成的 promise 长期挂住
  p.then(function () { if (inFlight === p) inFlight = null })
  return p
}

/**
 * 构造 onShareAppMessage 的返回值。页面只需给 title / path。
 * @param {{title: string, path: string}} base
 */
function build(base) {
  const title = (base && base.title) || ''
  const path = (base && base.path) || ''
  const st = getState()

  if (st === true) {
    return { title: title, path: path, imageUrl: appInfo.SHARE_CARD_FILEID }
  }
  if (st === false) {
    // 不带 imageUrl ⇒ 微信自动截取当前页面（兜底）
    return { title: title, path: path }
  }

  // 未知：交给 promise 字段异步定夺；失败/超时/低版本基础库一律落到「不带图 = 截图」
  const payload = { title: title, path: path }
  payload.promise = probe().then(function (ok) {
    if (ok) return { title: title, path: path, imageUrl: appInfo.SHARE_CARD_FILEID }
    return { title: title, path: path }
  })
  return payload
}

/* 启动预热：异步探活一次，让分享时尽量走「同步已知」零延迟路径。失败静默、不阻塞启动 */
function warmup() {
  try {
    setTimeout(function () {
      if (getState() !== true) probe()
    }, WARMUP_DELAY)
  } catch (e) {}
}

module.exports = {
  getState,
  probe,
  build,
  warmup
}
