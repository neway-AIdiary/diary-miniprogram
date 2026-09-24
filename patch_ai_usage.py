# -*- coding: utf-8 -*-
"""
patch_ai_usage.py —— [ai-usage v1] 商业化埋点（2026-09-24 用户拍板执行①）
每次 AI/ASR 调用写一条 ai_usage 云库记录：openid / fn / action / date / ts /
ok / model / promptTokens / completionTokens / totalTokens / costMs / audioBytes。
用途：算「人均月成本」与定价依据；写失败只告警，绝不阻塞业务返回。

改动：
  op1  optimizeDiary 头注释更新（声明新增 wx-server-sdk 依赖）
  op2  optimizeDiary 插入 logAiUsage + CURRENT_ACTION + getBeijingDateKey
  op3  optimizeDiary runPrompt 加 startedAt
  op4  optimizeDiary runPrompt 响应后记账（覆盖全部 8 个 action）
  op5  optimizeDiary exports.main 设置 CURRENT_ACTION
  op6  optimizeDiary package.json 加 wx-server-sdk 依赖
  op7  aiSummary 插入 logAiUsage（复用已有 db/cloud/getBeijingDateKey）
  op8  aiSummary main 响应后记账（含 diaryCount）
  op9  aiSummary catch 异常路径记账
  op10 speechToText 插入 logAiUsage
  op11 speechToText main 成功/失败双路记账
  op12 新增 getAiStats 云函数（index.js + package.json；restore 时删除）

用法：python patch_ai_usage.py --check | --write | --restore
铁律：锚点 count==1；guard 判幂等（guard 与注入文本逐字一致）；
      --write 自动备份幂等；LF 匹配、写盘还原 CRLF
"""
import sys, os, shutil, io

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
F_OD = os.path.join(ROOT, 'cloudfunctions', 'optimizeDiary', 'index.js')
F_ODP = os.path.join(ROOT, 'cloudfunctions', 'optimizeDiary', 'package.json')
F_AS = os.path.join(ROOT, 'cloudfunctions', 'aiSummary', 'index.js')
F_STT = os.path.join(ROOT, 'cloudfunctions', 'speechToText', 'index.js')
D_STATS = os.path.join(ROOT, 'cloudfunctions', 'getAiStats')
BK = r'C:\Users\ThinkPad\WorkBuddy\ai-usage-backup-20260924'

OD_HELPER = """// [ai-usage v1] 商业化埋点：每次 DeepSeek 调用写一条 ai_usage（成本核算与额度依据）。
// 集合不存在/写失败只告警，绝不阻塞业务返回。部署时需「云端安装依赖」（新增 wx-server-sdk 依赖）。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const usageDb = cloud.database()
let CURRENT_ACTION = '-'
function getBeijingDateKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = n => n < 10 ? '0' + n : '' + n
  return now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
}
async function logAiUsage(fields) {
  try {
    const wxContext = cloud.getWXContext()
    await usageDb.collection('ai_usage').add({
      data: Object.assign({
        openid: (wxContext && wxContext.OPENID) || 'unknown',
        fn: 'optimizeDiary',
        action: CURRENT_ACTION,
        date: getBeijingDateKey(),
        ts: Date.now()
      }, fields)
    })
  } catch (e) {
    console.warn('[ai-usage] optimizeDiary 记账失败(不阻塞):', e && e.message)
  }
}"""

AS_HELPER = """// [ai-usage v1] 商业化埋点：每次 DeepSeek 调用写一条 ai_usage（复用已有 db/cloud/getBeijingDateKey）。
// 集合不存在/写失败只告警，绝不阻塞业务返回
async function logAiUsage(fields) {
  try {
    const wxContext = cloud.getWXContext()
    await db.collection('ai_usage').add({
      data: Object.assign({
        openid: (wxContext && wxContext.OPENID) || 'unknown',
        fn: 'aiSummary',
        date: getBeijingDateKey(),
        ts: Date.now()
      }, fields)
    })
  } catch (e) {
    console.warn('[ai-usage] aiSummary 记账失败(不阻塞):', e && e.message)
  }
}"""

STT_HELPER = """// [ai-usage v1] 商业化埋点：每次语音识别写一条 ai_usage（绝不阻塞业务返回）
function getBeijingDateKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = n => n < 10 ? '0' + n : '' + n
  return now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate())
}
async function logAiUsage(fields) {
  try {
    const wxContext = cloud.getWXContext()
    await cloud.database().collection('ai_usage').add({
      data: Object.assign({
        openid: (wxContext && wxContext.OPENID) || 'unknown',
        fn: 'speechToText',
        date: getBeijingDateKey(),
        ts: Date.now()
      }, fields)
    })
  } catch (e) {
    console.warn('[ai-usage] speechToText 记账失败(不阻塞):', e && e.message)
  }
}"""

STATS_INDEX = """/**
 * 云函数：getAiStats
 * [ai-usage v1] 商业化埋点统计：聚合 ai_usage 集合，为定价与 AI 成本红线提供数据。
 *
 * 调用方式（当前仅开发者自用）：
 *   开发者工具 → 云函数 → getAiStats → 云端测试，入参 { "days": 30 }
 *   或在小程序端 wx.cloud.callFunction({ name: 'getAiStats', data: { days: 30 } })
 *
 * 返回（仅聚合，无 openid 全文——top 列表只给尾号 6 位）：
 *   { days, total, truncated, users, okCount, totalTokens, byFn, byDay, topUsers }
 *
 * 门槛：环境变量 STATS_ADMIN_OPENID 配置后仅该 openid 可查；未配置时放行
 *       （当前没有客户端入口，只有云端测试能调到）。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const admin = process.env.STATS_ADMIN_OPENID || ''
  if (admin && (!wxContext || wxContext.OPENID !== admin)) {
    return { error: '无权限' }
  }

  const days = Math.min(Math.max(parseInt(event && event.days, 10) || 30, 1), 365)
  const sinceTs = Date.now() - days * 86400000

  // 分页拉取（服务端单次 get 上限 1000 条；埋点量级远低于此，10000 封顶防失控）
  const rows = []
  let skip = 0
  while (rows.length < 10000) {
    const batch = await db.collection('ai_usage')
      .where({ ts: _.gte(sinceTs) })
      .orderBy('ts', 'desc')
      .skip(skip)
      .limit(1000)
      .get()
    const data = batch.data || []
    rows.push.apply(rows, data)
    if (data.length < 1000) break
    skip += 1000
  }

  const byFn = {}
  const byDay = {}
  const byUser = {}
  let totalTokens = 0
  let okCount = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const fn = String(r.fn || 'unknown')
    const day = String(r.date || '-')
    if (!byFn[fn]) byFn[fn] = { count: 0, ok: 0, totalTokens: 0 }
    byFn[fn].count++
    if (r.ok) byFn[fn].ok++
    byFn[fn].totalTokens += (r.totalTokens || 0)
    if (!byDay[day]) byDay[day] = { count: 0, totalTokens: 0 }
    byDay[day].count++
    byDay[day].totalTokens += (r.totalTokens || 0)
    const oid = String(r.openid || '')
    if (oid) byUser[oid] = (byUser[oid] || 0) + 1
    totalTokens += (r.totalTokens || 0)
    if (r.ok) okCount++
  }
  const topUsers = Object.keys(byUser)
    .map(function (k) { return { openidTail: k.slice(-6), calls: byUser[k] } })
    .sort(function (a, b) { return b.calls - a.calls })
    .slice(0, 10)

  return {
    days: days,
    total: rows.length,
    truncated: rows.length >= 10000,
    users: Object.keys(byUser).length,
    okCount: okCount,
    totalTokens: totalTokens,
    byFn: byFn,
    byDay: byDay,
    topUsers: topUsers
  }
}
"""

STATS_PKG = """{
  "name": "getAiStats",
  "version": "1.0.0",
  "description": "AI 用量埋点统计（[ai-usage v1]）：按功能/按天聚合 ai_usage，为定价与成本红线提供数据",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }
}
"""

OPS = [
    ('op1 od-头注释', F_OD,
     """ * 说明：本函数不依赖 wx-server-sdk，仅用 Node 内置 https 模块调用
 *       DeepSeek，任何 Node 版本都能运行，部署无需安装依赖。""",
     """ * 说明：调用 DeepSeek 用 Node 内置 https 模块；[ai-usage v1] 起引入 wx-server-sdk
 *       （仅用于 openid 与用量记账），部署时需勾选「云端安装依赖」。""",
     '[ai-usage v1] 起引入 wx-server-sdk'),
    ('op2 od-记账助手', F_OD,
     "const MODEL = 'deepseek-chat'",
     "const MODEL = 'deepseek-chat'\n\n" + OD_HELPER,
     "async function logAiUsage(fields) {\n  try {\n    const wxContext = cloud.getWXContext()\n    await usageDb.collection('ai_usage')"),
    ('op3 od-startedAt', F_OD,
     """async function runPrompt(prompt, maxTokens, temperature, systemPrompt) {
  const res = await callDeepSeek({""",
     """async function runPrompt(prompt, maxTokens, temperature, systemPrompt) {
  const startedAt = Date.now()
  const res = await callDeepSeek({""",
     'const startedAt = Date.now()'),
    ('op4 od-响应记账', F_OD,
     """    response_format: { type: 'json_object' }
  })

  if (res.status !== 200) {""",
     """    response_format: { type: 'json_object' }
  })

  // [ai-usage v1] 记账：usage 来自 DeepSeek 响应（HTTP 非 200 也记，算失败率）。
  // 阻塞 await：防止云函数在未落库前返回被冻结丢记录
  const usage = (res.body && res.body.usage) || {}
  await logAiUsage({
    ok: res.status === 200,
    model: MODEL,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    costMs: Date.now() - startedAt
  })

  if (res.status !== 200) {""",
     "await logAiUsage({\n    ok: res.status === 200,\n    model: MODEL,"),
    ('op5 od-action标记', F_OD,
     """exports.main = async (event, context) => {
  const action = String(((event && event.action) || 'optimize')).trim()""",
     """exports.main = async (event, context) => {
  const action = String(((event && event.action) || 'optimize')).trim()
  CURRENT_ACTION = action || '-'""",
     "CURRENT_ACTION = action || '-'"),
    ('op6 od-package依赖', F_ODP,
     """  "description": "调用 DeepSeek 大模型优化/续写日记（零依赖，仅用 Node 内置模块）",
  "main": "index.js",
  "dependencies": {}""",
     """  "description": "调用 DeepSeek 大模型优化/续写日记（[ai-usage v1] 起依赖 wx-server-sdk 记账）",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }""",
     '"wx-server-sdk": "~2.6.3"'),
    ('op7 as-记账助手', F_AS,
     '// 构造系统提示词（文档十一节给的固定前缀）',
     AS_HELPER + '\n\n// 构造系统提示词（文档十一节给的固定前缀）',
     "fn: 'aiSummary'"),
    ('op8 as-响应记账', F_AS,
     """  try {
    const res = await callDeepSeek(messages)
    if (res.status !== 200) {""",
     """  try {
    const res = await callDeepSeek(messages)
    // [ai-usage v1] 记账：usage 来自 DeepSeek 响应（阻塞 await，防云函数提前冻结丢记录）
    const usage = (res.body && res.body.usage) || {}
    await logAiUsage({
      ok: res.status === 200,
      model: MODEL,
      diaryCount: ctx.count,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0
    })
    if (res.status !== 200) {""",
     'const usage = (res.body && res.body.usage) || {}'),
    ('op9 as-异常记账', F_AS,
     """  } catch (e) {
    console.error('[aiSummary] 调用 AI 失败:', e && e.message)
    return { success: false, error: 'AI 分析超时，请缩短时间范围后重试' }
  }""",
     """  } catch (e) {
    console.error('[aiSummary] 调用 AI 失败:', e && e.message)
    // [ai-usage v1] 异常路径也记账（算失败率）
    await logAiUsage({ ok: false, error: String((e && e.message) || 'exception').slice(0, 120) })
    return { success: false, error: 'AI 分析超时，请缩短时间范围后重试' }
  }""",
     "await logAiUsage({ ok: false, error: String((e && e.message) || 'exception')"),
    ('op10 stt-记账助手', F_STT,
     'exports.main = async (event) => {',
     STT_HELPER + '\n\nexports.main = async (event) => {',
     "fn: 'speechToText'"),
    ('op11 stt-双路记账', F_STT,
     """  try {
    // 1. 从云存储下载录音文件
    const fileRes = await cloud.downloadFile({ fileID })
    // 2. 调用火山极速版识别（带上小程序端传来的热词）
    const text = await recognizeFlash(fileRes.fileContent, audioFormat, hotwords)
    // 3. 清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    return { text }
  } catch (err) {
    // 出错也清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    return { error: err.message || '语音识别失败' }
  }""",
     """  const startedAt = Date.now()
  try {
    // 1. 从云存储下载录音文件
    const fileRes = await cloud.downloadFile({ fileID })
    // 2. 调用火山极速版识别（带上小程序端传来的热词）
    const text = await recognizeFlash(fileRes.fileContent, audioFormat, hotwords)
    // 3. 清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    // [ai-usage v1] 记账：成功也记（阻塞 await，防云函数提前冻结丢记录）
    await logAiUsage({ ok: true, audioBytes: fileRes.fileContent.length, costMs: Date.now() - startedAt })
    return { text }
  } catch (err) {
    // 出错也清理临时文件
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
    // [ai-usage v1] 记账：失败也记（算失败率，不阻塞错误返回）
    await logAiUsage({ ok: false, error: String((err && err.message) || 'asr error').slice(0, 120), costMs: Date.now() - startedAt })
    return { error: err.message || '语音识别失败' }
  }""",
     'await logAiUsage({ ok: true, audioBytes: fileRes.fileContent.length'),
]

def load(path):
    raw = io.open(path, encoding='utf-8', newline='').read()
    crlf = '\r\n' in raw
    return raw, (raw.replace('\r\n', '\n') if crlf else raw), crlf

def dump(path, text_lf, crlf):
    out = text_lf.replace('\n', '\r\n') if crlf else text_lf
    io.open(path, 'w', encoding='utf-8', newline='').write(out)

def create_stats():
    os.makedirs(D_STATS, exist_ok=True)
    io.open(os.path.join(D_STATS, 'index.js'), 'w', encoding='utf-8', newline='').write(STATS_INDEX.replace('\n', '\r\n'))
    io.open(os.path.join(D_STATS, 'package.json'), 'w', encoding='utf-8', newline='').write(STATS_PKG)
    print('op12 getAiStats OK (created index.js + package.json)')

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    mode = mode.lstrip('-')
    if mode not in ('check', 'write', 'restore'):
        print('usage: patch_ai_usage.py --check|--write|--restore'); sys.exit(2)

    if mode == 'restore':
        for rel in [r'cloudfunctions\optimizeDiary\index.js', r'cloudfunctions\optimizeDiary\package.json',
                    r'cloudfunctions\aiSummary\index.js', r'cloudfunctions\aiSummary\package.json',
                    r'cloudfunctions\speechToText\index.js', r'cloudfunctions\speechToText\package.json']:
            b = os.path.join(BK, rel)
            if os.path.exists(b):
                shutil.copy2(b, os.path.join(ROOT, rel)); print('RESTORED', rel)
        if os.path.isdir(D_STATS):
            shutil.rmtree(D_STATS); print('REMOVED getAiStats/')
        return

    if mode == 'write':
        for rel in [r'cloudfunctions\optimizeDiary\index.js', r'cloudfunctions\optimizeDiary\package.json',
                    r'cloudfunctions\aiSummary\index.js', r'cloudfunctions\aiSummary\package.json',
                    r'cloudfunctions\speechToText\index.js', r'cloudfunctions\speechToText\package.json']:
            b = os.path.join(BK, rel)
            if not os.path.exists(b):
                shutil.copy2(os.path.join(ROOT, rel), b); print('BACKUP', rel)
            else:
                print('BACKUP exists, skip', rel)

    ok = True
    for name, f, old, new, guard in OPS:
        raw, text, crlf = load(f)
        if guard in text:
            print(name, 'SKIP (guard present)'); continue
        c = text.count(old)
        if c != 1:
            print(name, 'FAIL: anchor count =', c); ok = False; continue
        if mode == 'write':
            text = text.replace(old, new)
            dump(f, text, crlf)
            _, text2, _ = load(f)
            if guard not in text2:
                print(name, 'FAIL: 写盘复核未命中 guard'); ok = False; continue
            print(name, 'OK (written & verified)')
        else:
            print(name, 'OK (anchor unique, would apply)')

    if mode == 'write' and ok:
        create_stats()
    elif mode == 'check':
        print('op12 getAiStats OK (would create)')

    print('====', mode, 'result:', 'ALL OK' if ok else 'HAS FAIL')
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
