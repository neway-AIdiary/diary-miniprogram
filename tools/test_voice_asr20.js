// tools/test_voice_asr20.js
// [volc-asr20 v1] 火山流式语音识别 1.0 → 2.0 切换的一致性锁（2026-09-24）
//
// 背景：官方已把豆包流式语音识别模型 1.0 标为历史版本，2.0 为推荐版本。
// 切换之所以只改「一个字符串」：`/api/v3/sauc/bigmodel_async`（双向流式优化版）是
// 1.0/2.0 **共用端点**，服务端靠 X-Api-Resource-Id 区分版本；请求参数两版一致。
//
// 本套件锁三件事（静态契约，真机实测另行进行）：
//   ① 云函数 getAsrConfig 未配环境变量时的默认 resourceId = 2.0 小时版
//      —— 注意：环境变量 VOLC_ASR_RESOURCE_ID 优先级更高，若后台仍配 1.0 会覆盖本默认值；
//   ② 客户端 voice.js 云端下发缺字段时的兜底值 = 2.0 小时版（两处必须同值，否则分叉）；
//   ③ 端点与 header 取值方式不变（header 取配置值，不得硬编码版本）。
const path = require('path')
const fs = require('fs')

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8')
const count = (s, sub) => s.split(sub).length - 1

let pass = 0, fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}

const cfg = read('cloudfunctions/getAsrConfig/index.js')
const vj = read('utils/voice.js')

const V20 = "|| 'volc.seedasr.sauc.duration'"
const V10 = "|| 'volc.bigasr.sauc.duration'"

console.log('[A] 静态契约：版本资源 ID 两处同值、零 1.0 残留')
{
  ok(cfg.indexOf(V20) !== -1,
    'asr20-1 云函数默认 resourceId = 2.0 小时版（volc.seedasr.sauc.duration）')

  ok(vj.indexOf(V20) !== -1,
    'asr20-2 客户端兜底 resourceId = 2.0 小时版（两处必须同值，防「云端 2.0 / 兜底 1.0」分叉）')

  ok(cfg.indexOf(V10) === -1,
    'asr20-3 ★ 云函数零 1.0 兜底残留（环境变量缺失时不会退回旧版）', count(cfg, V10))

  ok(vj.indexOf(V10) === -1,
    'asr20-4 ★ 客户端零 1.0 兜底残留', count(vj, V10))

  ok(vj.indexOf("url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'") !== -1,
    'asr20-5 端点未变：仍是 1.0/2.0 共用的双向流式优化版（切版本不改端点）')

  ok(count(vj, "headers['X-Api-Resource-Id'] = cfg.resourceId") === 1,
    'asr20-6 握手 header 取配置值（版本由云端下发，不在客户端硬编码）', count(vj, "headers['X-Api-Resource-Id']"))
}

console.log('\n[test_voice_asr20] ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
