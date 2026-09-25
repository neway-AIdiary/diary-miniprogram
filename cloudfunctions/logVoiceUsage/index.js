/**
 * 云函数：logVoiceUsage
 * [voice-usage v1] 流式语音用量记账（2026-09-24）
 *
 * 为什么需要它：语音的两条链路里，**火山流式识别由客户端直连**（Android/开发者工具），
 * 全程不调用任何云函数 ⇒ 云函数侧 logAiUsage 覆盖不到 ⇒ 用量不可计。
 * 客户端在流式会话收尾时调本函数上报一次；iOS / 流式失败回退那条路由 speechToText
 * 云函数内部自行记账（本函数不参与），因此**不会双计**。
 *
 * 入参：{ mode:'stream', seconds:number（本次录音秒数，用于额度制的语音分钟数）, ok:boolean（是否识别出内容） }
 * 出参：{ ok:true } / { ok:false, error }  —— 客户端不 await 结果，失败仅告警
 *
 * 写入 ai_usage：fn 固定为 'speechToText'（与云函数侧同一口径 ⇒ byFn.speechToText.count
 * 天然等于全部语音次数），mode='stream'、source='client' 用于区分链路。
 * ⚠️ 集合不存在 / 写失败只 warn，绝不阻塞客户端。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 北京时间自然日键（与 aiSummary / speechToText 内的同款实现保持一致）
function getBeijingDateKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = n => n < 10 ? '0' + n : '' + n
  return now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  // 秒数夹紧 [0, 3600]：一次语音不可能超过 1 小时，防脏数据污染额度统计
  const rawSeconds = parseInt(event && event.seconds, 10)
  const seconds = Math.max(0, Math.min(isNaN(rawSeconds) ? 0 : rawSeconds, 3600))
  try {
    await db.collection('ai_usage').add({
      data: {
        openid: (wxContext && wxContext.OPENID) || 'unknown',
        fn: 'speechToText',
        mode: 'stream',
        source: 'client',
        ok: !(event && event.ok === false),
        seconds: seconds,
        date: getBeijingDateKey(),
        ts: Date.now()
      }
    })
    return { ok: true }
  } catch (e) {
    console.warn('[ai-usage] logVoiceUsage 记账失败(不阻塞):', e && e.message)
    return { ok: false, error: String((e && e.message) || 'log fail') }
  }
}
