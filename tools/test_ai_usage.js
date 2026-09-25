/**
 * test_ai_usage.js — [ai-usage v1] 埋点与业务共存性验证（2026-09-24）
 *
 * 目标：埋点不能影响已有云函数的业务行为。用桩替换 wx-server-sdk 与 https，
 *       真实加载 4 个云函数代码（optimizeDiary / aiSummary / speechToText / getAiStats），
 *       逐条验证：
 *   A. 业务返回值与埋点前契约一致（成功/失败/早退路径全覆盖）
 *   B. 每条 AI 调用恰写一条 ai_usage（字段齐全），早退路径不写
 *   C. 记账通道故障（add 抛错 / getWXContext 抛错）绝不阻塞业务返回
 *   D. 红灯自检：把 logAiUsage 的 try/catch 拆掉（模拟会阻塞的埋点实现），
 *      对应用例必须翻红 → 证明 C 类用例真的拦得住「埋点搞挂业务」
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')
const EventEmitter = require('events')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++ } else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')) }
}
function eq(name, actual, expected) {
  check(name, actual === expected, { actual: actual, expected: expected })
}

// ===== 桩：wx-server-sdk =====
const state = {
  records: [],        // 所有 add 写入 {collection, data}
  calls: [],          // [st-6/st-7] 收尾调用观测：'deleteFile' / 'add' 的发起顺序
  deferDelete: false, // [st-6/st-7] 让 deleteFile 挂住不返回（模拟云存储抖动）
  deferAdd: false,    // [st-7] 让 ai_usage 写入挂住不返回（模拟云库抖动）
  releaseDelete: null,
  releaseAdd: null,
  failAdd: false,     // 令 add 抛错（模拟云库故障）
  throwWXContext: false,
  httpStatus: 200,
  httpHeaders: {},
  httpBody: {},
  httpFail: false,    // 令 https 请求直接 error
  httpCalls: 0,
  queryAiUsage: [],   // getAiStats 分页数据源
  queryQuota: [],     // summary_quota 查询结果
  downloadFile: null, // function({fileID}) => {fileContent}
}
const sdk = {
  DYNAMIC_CURRENT_ENV: '[DYNAMIC_CURRENT_ENV]',
  init: function () {},
  getWXContext: function () {
    if (state.throwWXContext) throw new Error('mock wx context boom')
    return { OPENID: 'oTEST-openid-abc123' }
  },
  database: function () {
    return {
      command: { inc: function (n) { return { $inc: n } }, gte: function (v) { return { $gte: v } } },
      collection: function (name) {
        const q = {
          _skip: 0, _limit: 100,
          where: function () { return q },
          orderBy: function () { return q },
          skip: function (n) { q._skip = n; return q },
          limit: function (n) { q._limit = n; return q },
          get: async function () {
            const src = name === 'ai_usage' ? state.queryAiUsage : state.queryQuota
            return { data: src.slice(q._skip, q._skip + q._limit) }
          },
          add: async function (op) {
            if (name === 'ai_usage') state.calls.push('add')
            if (state.failAdd) throw new Error('mock add fail')
            if (state.deferAdd) {
              return new Promise(function (res) { state.releaseAdd = res })
            }
            state.records.push({ collection: name, data: (op && op.data) || {} })
            return { _id: 'id' + state.records.length }
          },
          doc: function () {
            return { update: async function () { if (state.failAdd) throw new Error('mock update fail'); return {} } }
          }
        }
        return q
      }
    }
  },
  downloadFile: async function (ev) {
    if (state.downloadFile) return state.downloadFile(ev)
    throw new Error('no mock downloadFile')
  },
  deleteFile: async function () {
    state.calls.push('deleteFile')
    if (state.deferDelete) {
      return new Promise(function (res) { state.releaseDelete = res })
    }
    return {}
  }
}

// ===== 桩：https =====
const fakeHttps = {
  request: function (opts, cb) {
    state.httpCalls++
    const req = new EventEmitter()
    req.write = function () {}
    if (state.httpFail) {
      req.end = function () { setTimeout(function () { req.emit('error', new Error('mock net down')) }, 0) }
    } else {
      req.end = function () {
        setTimeout(function () {
          const res = new EventEmitter()
          res.statusCode = state.httpStatus
          res.headers = state.httpHeaders
          cb(res)
          setTimeout(function () {
            res.emit('data', Buffer.from(JSON.stringify(state.httpBody)))
            res.emit('end')
          }, 0)
        }, 0)
      }
    }
    req.destroy = function (e) { req.emit('error', e || new Error('mock timeout')) }
    return req
  }
}

// 劫持模块解析（仅本进程内）
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return sdk
  if (request === 'https') return fakeHttps
  // [asr-nostream v1] 屏蔽真实 ws：speechToText 优先流式 2.0，此处令其即刻失败走 flash 回退路径
  if (request === 'ws') throw new Error('mock: ws blocked')
  return origLoad.apply(this, arguments)
}

process.env.DEEPSEEK_API_KEY = 'test-key-123'

const optFn = require(path.join(__dirname, '..', 'cloudfunctions', 'optimizeDiary', 'index.js'))
const aiFn = require(path.join(__dirname, '..', 'cloudfunctions', 'aiSummary', 'index.js'))
const asrFn = require(path.join(__dirname, '..', 'cloudfunctions', 'speechToText', 'index.js'))
const statsFn = require(path.join(__dirname, '..', 'cloudfunctions', 'getAiStats', 'index.js'))

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function resetHttp() {
  state.httpStatus = 200
  state.httpHeaders = {}
  state.httpBody = {}
  state.httpFail = false
}
function usageRecords() {
  return state.records.filter(function (r) { return r.collection === 'ai_usage' })
}

async function run() {
  // ================= A. optimizeDiary =================
  resetHttp()
  state.httpBody = {
    choices: [{ message: { content: '{"optimized":"润色后的正文","changes":["改动一"]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }
  }
  let before = state.records.length
  let ret = await optFn.main({ action: 'optimize', content: '今天去公园散步，心情很好。' })
  eq('od-1 业务返回 optimized', ret.optimized, '润色后的正文')
  eq('od-1 业务返回 changes', ret.changes.length, 1)
  eq('od-1 业务返回 action', ret.action, 'optimize')
  let recs = usageRecords()
  eq('od-2 恰写一条 ai_usage', recs.length - (before ? usageRecords().length : 0) >= 1 && state.records.length - before === 1, true, state.records.slice(before))
  let rec = state.records[state.records.length - 1].data
  eq('od-2 fn', rec.fn, 'optimizeDiary')
  eq('od-2 action', rec.action, 'optimize')
  eq('od-2 ok', rec.ok, true)
  eq('od-2 promptTokens', rec.promptTokens, 12)
  eq('od-2 completionTokens', rec.completionTokens, 34)
  eq('od-2 totalTokens', rec.totalTokens, 46)
  check('od-2 costMs 数值', typeof rec.costMs === 'number' && rec.costMs >= 0, rec.costMs)
  eq('od-2 openid', rec.openid, 'oTEST-openid-abc123')
  check('od-2 date 格式', /^\d{4}-\d{2}-\d{2}$/.test(rec.date), rec.date)
  check('od-2 ts 数值', typeof rec.ts === 'number', rec.ts)

  // 早退路径（内容为空）：不写埋点、不发 https
  before = state.records.length
  let httpBefore = state.httpCalls
  ret = await optFn.main({ action: 'optimize', content: '' })
  eq('od-3 早退返回', ret.error, '内容为空')
  eq('od-3 早退不写埋点', state.records.length - before, 0)
  eq('od-3 早退不发 https', state.httpCalls - httpBefore, 0)

  // HTTP 非 200：业务照旧返回错误；埋点记 ok:false（算失败率）
  resetHttp()
  state.httpStatus = 500
  state.httpBody = { error: { message: 'rate limited' } }
  ret = await optFn.main({ action: 'optimize', content: '正文内容。' })
  check('od-4 非200 业务返回错误', ret.error && ret.error.indexOf('AI 接口错误') === 0, ret)
  rec = state.records[state.records.length - 1].data
  eq('od-4 非200 记 ok:false', rec.ok, false)

  // 记账通道故障：add 抛错 → 业务返回绝不受影响
  resetHttp()
  state.httpBody = {
    choices: [{ message: { content: '{"optimized":"再次润色","changes":[]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
  state.failAdd = true
  ret = await optFn.main({ action: 'optimize', content: '正文内容。' })
  eq('od-5 add抛错 业务不受影响', ret.optimized, '再次润色')
  state.failAdd = false

  // getWXContext 抛错 + add 抛错 双重故障：业务仍不受影响
  state.failAdd = true
  state.throwWXContext = true
  ret = await optFn.main({ action: 'tags', content: '写个标签的内容' })
  check('od-6 双重故障 业务不受影响', (ret.tags && ret.tags.length >= 0) || (ret.error && ret.error.indexOf('AI') === 0), ret)
  state.failAdd = false
  state.throwWXContext = false

  // 网络层异常：业务返回「调用 AI 失败」（契约同埋点前）
  resetHttp()
  state.httpFail = true
  ret = await optFn.main({ action: 'optimize', content: '正文内容。' })
  check('od-7 网络异常 业务返回错误', ret.error && ret.error.indexOf('调用 AI 失败') === 0, ret)
  state.httpFail = false

  // ================= B. aiSummary =================
  resetHttp()
  state.httpBody = {
    choices: [{ message: { content: '## 本月回顾\n- 第一件事\n- 第二件事' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  }
  before = state.records.length
  ret = await aiFn.main({
    userPrompt: '总结本月',
    diaries: [
      { date: '2026-09-01', content: '九月一号的事' },
      { date: '2026-09-15', content: '九月十五的事' }
    ]
  })
  eq('as-1 业务 success', ret.success, true)
  eq('as-1 排版归一化不回归（标题前补空行，标题后不补——既有行为）', ret.summaryText, '◆ 本月回顾\n· 第一件事\n· 第二件事')
  eq('as-1 diaryCount', ret.diaryCount, 2)
  eq('as-1 quotaUsed', ret.quotaUsed, 1)
  eq('as-1 outputTruncated', ret.outputTruncated, false)
  rec = state.records[state.records.length - 1].data
  eq('as-2 fn', rec.fn, 'aiSummary')
  eq('as-2 diaryCount 记账', rec.diaryCount, 2)
  eq('as-2 ok', rec.ok, true)
  eq('as-2 totalTokens', rec.totalTokens, 150)
  const quotaRec = state.records.filter(function (r) { return r.collection === 'summary_quota' })
  eq('as-3 原有限流逻辑正常（quota add）', quotaRec.length, 1)

  // 配额耗尽：早退不写 ai_usage（埋点不干扰限流语义）
  state.queryQuota = [{ _id: 'q1', count: 10 }]
  before = usageRecords().length
  ret = await aiFn.main({ userPrompt: '再来一次', diaries: [{ date: '2026-09-20', content: '内容' }] })
  eq('as-4 配额耗尽返回', ret.error, '今日 AI 总结次数已用完，明天再来')
  eq('as-4 配额耗尽不写埋点', usageRecords().length - before, 0)
  state.queryQuota = []

  // 配额 update 分支（count=3 → used=4），埋点照写
  resetHttp()
  state.httpBody = {
    choices: [{ message: { content: '## 回顾\n- 一件事' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }
  state.queryQuota = [{ _id: 'q2', count: 3 }]
  ret = await aiFn.main({ userPrompt: '总结', diaries: [{ date: '2026-09-21', content: '内容' }] })
  eq('as-5 配额 update 分支 used', ret.quotaUsed, 4)
  eq('as-5 update 分支仍 success', ret.success, true)
  state.queryQuota = []

  // HTTP 非 200：业务返回友好错误 + 记 ok:false
  resetHttp()
  state.httpStatus = 429
  state.httpBody = { error: { message: 'too many' } }
  ret = await aiFn.main({ userPrompt: '总结', diaries: [{ date: '2026-09-22', content: '内容' }] })
  eq('as-6 非200 业务返回', ret.error, 'AI 分析失败，请稍后重试')
  rec = state.records[state.records.length - 1].data
  eq('as-6 非200 记 ok:false', rec.ok, false)

  // 网络异常：catch 路径记账
  resetHttp()
  state.httpFail = true
  ret = await aiFn.main({ userPrompt: '总结', diaries: [{ date: '2026-09-23', content: '内容' }] })
  eq('as-7 网络异常 业务返回', ret.error, 'AI 分析超时，请缩短时间范围后重试')
  rec = state.records[state.records.length - 1].data
  eq('as-7 异常路径记 ok:false', rec.ok, false)
  check('as-7 异常路径带 error', typeof rec.error === 'string' && rec.error.length > 0, rec)

  // 记账故障：业务不受影响
  resetHttp()
  state.httpBody = {
    choices: [{ message: { content: '## 回顾\n- 另一件事' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
  state.failAdd = true
  ret = await aiFn.main({ userPrompt: '总结', diaries: [{ date: '2026-09-24', content: '内容' }] })
  eq('as-8 add抛错 业务不受影响', ret.success, true)
  state.failAdd = false

  // ================= C. speechToText =================
  ret = await asrFn.main({})
  eq('st-1 缺文件ID早退', ret.error, '缺少音频文件')

  resetHttp()
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '识别出的文字内容' } }
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }
  ret = await asrFn.main({ fileID: 'cloud://f1', format: 'wav' })
  eq('st-2 业务返回文字', ret.text, '识别出的文字内容')
  rec = state.records[state.records.length - 1].data
  eq('st-2 fn', rec.fn, 'speechToText')
  eq('st-2 ok', rec.ok, true)
  eq('st-2 audioBytes', rec.audioBytes, 9)

  // ASR 错误码：业务照旧返回错误 + 记 ok:false
  state.httpHeaders = { 'x-api-status-code': '20000003' }
  state.httpBody = {}
  ret = await asrFn.main({ fileID: 'cloud://f2', format: 'wav' })
  eq('st-3 ASR错误 业务返回', ret.error, '没听清，请再试一次')
  rec = state.records[state.records.length - 1].data
  eq('st-3 记 ok:false', rec.ok, false)

  // 下载失败：错误路径记账
  state.downloadFile = function () { throw new Error('download boom') }
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  ret = await asrFn.main({ fileID: 'cloud://f3', format: 'wav' })
  check('st-4 下载失败 业务返回错误', ret.error && ret.error.indexOf('download boom') !== -1, ret)
  rec = state.records[state.records.length - 1].data
  eq('st-4 记 ok:false', rec.ok, false)
  state.downloadFile = function () { return { fileContent: Buffer.from('fakeaudio') } }

  // 记账故障：业务不受影响（重新给全 mock 响应，防止走到「AI 返回为空」分支）
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '识别出的文字内容' } }
  state.failAdd = true
  ret = await asrFn.main({ fileID: 'cloud://f4', format: 'wav' })
  eq('st-5 add抛错 业务不受影响', ret.text, '识别出的文字内容')
  state.failAdd = false
  state.downloadFile = null

  // ===== [ai-usage v2] 收尾提速：清理 ‖ 记账 并行 + 有界等待 =====
  // st-6（并行性）：deleteFile 挂住不返回时，「记账已发出」——旧版串行 await ⇒ add 永不发出 ⇒ 红
  resetHttp()
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '并行收尾' } }
  state.downloadFile = function () { return { fileContent: Buffer.from('xx') } }
  state.calls = []
  state.deferDelete = true
  const p6 = asrFn.main({ fileID: 'cloud://f6', format: 'wav' })
  await wait(60)
  check('st-6 清理挂起时记账已并行发起（不再串行等清理）',
    state.calls.indexOf('deleteFile') >= 0 && state.calls.indexOf('add') >= 0, state.calls.slice())
  state.deferDelete = false
  if (state.releaseDelete) state.releaseDelete()
  const r6 = await p6
  eq('st-6 并行收尾后业务返回不变', r6.text, '并行收尾')

  // st-7（有界性）：清理与记账双双挂住时，仍须在等待上限内返回识别结果
  //（旧版会一直挂住 ⇒ 客户端等到函数执行超时 ⇒ 正是 iOS 长录音「云函数调用失败」的形态）
  resetHttp()
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '限时兜底' } }
  state.calls = []
  state.deferDelete = true
  state.deferAdd = true
  const t7 = Date.now()
  const r7 = await Promise.race([
    asrFn.main({ fileID: 'cloud://f7', format: 'wav' }),
    wait(2500).then(function () { return 'TIMEOUT' })
  ])
  const cost7 = Date.now() - t7
  check('st-7 收尾双双挂起时仍限时返回（不被拖到函数超时）',
    r7 !== 'TIMEOUT' && r7.text === '限时兜底', { cost: cost7, ret: r7 })
  check('st-7 收尾等待上限约 1s', r7 !== 'TIMEOUT' && cost7 >= 900 && cost7 < 2200, cost7)
  state.deferDelete = false
  state.deferAdd = false
  state.releaseDelete = null
  state.releaseAdd = null
  state.downloadFile = null

  // ================= D. getAiStats 聚合 =================
  const day = '2026-09-24'
  state.queryAiUsage = [
    { openid: 'oAAAA123456', fn: 'optimizeDiary', ok: true, totalTokens: 10, date: day },
    { openid: 'oAAAA123456', fn: 'aiSummary', ok: true, totalTokens: 20, date: day },
    { openid: 'oBBBB654321', fn: 'speechToText', ok: false, totalTokens: 0, date: day }
  ]
  ret = await statsFn.main({ days: 30 })
  eq('gs-1 total', ret.total, 3)
  eq('gs-1 okCount', ret.okCount, 2)
  eq('gs-1 totalTokens', ret.totalTokens, 30)
  eq('gs-1 users', ret.users, 2)
  eq('gs-1 byFn.optimizeDiary', ret.byFn.optimizeDiary.count, 1)
  eq('gs-1 byFn.optimizeDiary.ok', ret.byFn.optimizeDiary.ok, 1)
  eq('gs-1 byDay', ret.byDay[day].count, 3)
  eq('gs-1 topUsers 脱敏', ret.topUsers[0].openidTail, '123456')
  eq('gs-1 truncated', ret.truncated, false)

  state.queryAiUsage = []
  ret = await statsFn.main({ days: 30 })
  eq('gs-2 空集不崩', ret.total, 0)

  // 分页终止：1500 条 → 1000 + 500 两批拉完
  for (let i = 0; i < 1500; i++) state.queryAiUsage.push({ openid: 'oX' + i, fn: 'aiSummary', ok: true, totalTokens: 1, date: day })
  ret = await statsFn.main({ days: 30 })
  eq('gs-3 分页拉全', ret.total, 1500)
  state.queryAiUsage = []

  // ================= E. 红灯自检 =================
  // 把 optimizeDiary 的 logAiUsage try/catch 拆掉（模拟「会阻塞业务的埋点实现」），
  // od-5 同场景（add 抛错）必须让业务失败 —— 证明 C 类用例真的拦得住回归。
  try {
    const srcPath = path.join(__dirname, '..', 'cloudfunctions', 'optimizeDiary', 'index.js')
    let src = fs.readFileSync(srcPath, 'utf8')
    const marker = "console.warn('[ai-usage] optimizeDiary 记账失败(不阻塞):', e && e.message)"
    if (src.indexOf(marker) === -1) throw new Error('红灯夹具锚点未命中')
    src = src.replace(marker, 'throw e')
    const redPath = path.join(os.tmpdir(), 'test_ai_usage_red_optimizeDiary.js')
    fs.writeFileSync(redPath, src)
    delete require.cache[require.resolve(redPath)]
    const redFn = require(redPath)
    state.failAdd = true
    let blocked = false
    try {
      resetHttp()
      state.httpBody = {
        choices: [{ message: { content: '{"optimized":"x","changes":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
      const redRet = await redFn.main({ action: 'optimize', content: '红灯正文' })
      // exports.main 的 catch 会把异常吃掉转成 {error}（不 reject）——
      // 红灯判据 = 业务结果退化：拿不到 optimized 即为「埋点阻塞了业务」
      blocked = !redRet || redRet.optimized === undefined
    } catch (e) {
      blocked = true
    }
    state.failAdd = false
    try { fs.unlinkSync(redPath) } catch (e) {}
    eq('red-1 拆掉try/catch后 add抛错会打断业务（证明od-5有效）', blocked, true)
  } catch (e) {
    fail++
    console.log('FAIL red-1 红灯夹具异常: ' + (e && e.message))
  }

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
  process.exit(fail ? 1 : 0)
}

run().catch(function (e) {
  fail++
  console.log('FAIL 套件级异常: ' + (e && e.stack || e))
  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
  process.exit(1)
})
