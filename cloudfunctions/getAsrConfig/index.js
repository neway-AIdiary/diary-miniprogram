// 云函数 getAsrConfig
// 用途：把火山引擎流式语音识别（WebSocket 直连）所需的鉴权参数下发给前端。
//
// 火山 v3 流式接口鉴权放在 WebSocket 握手 HTTP header：
//   新版控制台：X-Api-Key（单 Key）
//   旧版控制台：X-Api-App-Key（AppID）+ X-Api-Access-Key（Access Token）
// 通过云函数下发（而不是写死在代码包里），密钥不进小程序包、可随时云端吊销/更换。
//
// 本函数不使用任何云开发 API（不碰数据库/存储），因此【不依赖 wx-server-sdk】，
// 任何方式上传部署都不会因依赖缺失而报错。
//
// 可在云函数环境变量配置（新旧二选一，不配则用下方兜底密钥）：
//   新版：VOLC_ASR_API_KEY
//   旧版：VOLC_ASR_APP_ID + VOLC_ASR_ACCESS_TOKEN
//   可选：VOLC_ASR_RESOURCE_ID（默认 volc.bigasr.sauc.duration 小时版；
//         并发版填 volc.bigasr.sauc.concurrent）
// 兜底密钥：未配置环境变量时使用（更换密钥只需改这里重新部署，或配置环境变量覆盖）
// 2026-08-31 实测有效的火山旧版双 Key（App ID + Access Token）
const FALLBACK_APP_ID = '7992637022'
const FALLBACK_ACCESS_TOKEN = '_KDN_ncc9T4ydrv2mn4XhjiegwBOtNp7'

exports.main = async () => {
  const apiKey = process.env.VOLC_ASR_API_KEY || ''
  const appId = process.env.VOLC_ASR_APP_ID || FALLBACK_APP_ID
  const accessToken = process.env.VOLC_ASR_ACCESS_TOKEN || FALLBACK_ACCESS_TOKEN

  if (!apiKey && !(appId && accessToken)) {
    return { error: '未配置火山ASR参数' }
  }

  return {
    apiKey: apiKey || '',
    appId: appId || '',
    accessToken: accessToken || '',
    resourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration'
  }
}
