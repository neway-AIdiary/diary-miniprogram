/**
 * test_reminder_window.js — [reminder-window v1] 提醒触发器 5 分钟化验证（2026-09-25）
 *
 * 验证三件事：
 *   r-1~r-3  结构锁：触发器改为每 5 分钟（cron 分钟位星号斜杠 5）；查询改为窗口 _.in 匹配；
 *            旧的「time == 当前分钟」精确匹配无残留
 *   r-4~r-6  行为验证（桩跑 main，fake Date.now 使北京时间为 00:00:30）：
 *            r-4 跨小时窗口正确（含 "23:51"~"00:00" 共 10 个分钟串）
 *            r-5 落在窗口内的提醒（time=23:58）被推送且标记 lastSentCycle
 *            r-6 lastSentCycle 已标记同周期时不重复推送（窗口内幂等）
 *   r-7      非 5 倍数分钟档（如 21:03）落在窗口内被命中——窗口语义的核心收益
 * 红灯判据：旧源码（每分钟 + 精确匹配）下结构断言全红、行为断言 r-4/r-5/r-7 红。
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')) }
}
function eq(name, actual, expected) {
  check(name + '（' + JSON.stringify(actual) + ' === ' + JSON.stringify(expected) + '）', actual === expected, { actual: actual, expected: expected })
}

const ROOT = path.resolve(__dirname, '..')
const CFG = path.join(ROOT, 'cloudfunctions', 'reminderTask', 'config.json')
const SRC = path.join(ROOT, 'cloudfunctions', 'reminderTask', 'index.js')

// ---------- r-1~r-3 结构断言 ----------
const cfgText = fs.readFileSync(CFG, 'utf-8')
check('r-1 config.json 触发器 = 每 5 分钟（0 */5 * * * * *）', cfgText.indexOf('"config": "0 */5 * * * * *"') !== -1, cfgText)
check('r-1b 旧的每分钟触发器已消失', cfgText.indexOf('"config": "0 * * * * * *"') === -1)

const src = fs.readFileSync(SRC, 'utf-8').replace(/\r\n/g, '\n')
check('r-2 存在窗口常量 REMINDER_WINDOW_MIN = 10 与同步警示', src.indexOf('const REMINDER_WINDOW_MIN = 10') !== -1 && src.indexOf('触发间隔 × 2') !== -1)
check('r-2b 存在 minuteWindow 函数', src.indexOf('function minuteWindow(nowMs, n)') !== -1)
check('r-3 查询使用 _.in(minuteWindow(...))', src.indexOf('_.in(minuteWindow(Date.now(), REMINDER_WINDOW_MIN))') !== -1)
check('r-3b 旧精确匹配 time: timeStr 已从查询中消失', src.indexOf('time: timeStr\n  }).limit') === -1)
check('r-3c 引入 db.command（_ 可用）', src.indexOf('const _ = db.command') !== -1)

// ---------- 桩：wx-server-sdk ----------
const state = {
  whereConds: [],   // [{name, cond}] 记录 where 条件
  reminders: [],    // reminders 集合返回数据
  sendCalls: [],    // subscribeMessage.send 调用参数
  updates: []       // [{id, data}] doc().update()
}
const sdk = {
  DYNAMIC_CURRENT_ENV: '[DYNAMIC_CURRENT_ENV]',
  init: function () {},
  database: function () {
    return {
      command: {
        in: function (arr) { return { $in: arr } }
      },
      collection: function (name) {
        const q = {
          where: function (cond) { state.whereConds.push({ name: name, cond: cond }); return q },
          limit: function () { return q },
          get: async function () {
            return { data: name === 'reminders' ? state.reminders : [] }
          },
          doc: function (id) {
            return {
              update: async function (op) { state.updates.push({ id: id, data: op && op.data }) }
            }
          }
        }
        return q
      }
    }
  },
  openapi: {
    subscribeMessage: {
      send: async function (msg) { state.sendCalls.push(msg) }
    }
  }
}

// 屏蔽真实 wx-server-sdk（本机未安装，直接换桩）
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return sdk
  return origLoad.apply(this, arguments)
}

function loadReminder() {
  delete require.cache[require.resolve(SRC)]
  return require(SRC)
}
function resetState() {
  state.whereConds = []
  state.reminders = []
  state.sendCalls = []
  state.updates = []
}

// fake Date.now → 北京时间 2026-09-25 00:00:30（= UTC 2026-09-24 16:00:30）
const FAKE_MS = Date.UTC(2026, 8, 24, 16, 0, 30)
const realNow = Date.now
Date.now = function () { return FAKE_MS }

function lastCond() {
  for (let i = state.whereConds.length - 1; i >= 0; i--) {
    if (state.whereConds[i].name === 'reminders') return state.whereConds[i].cond
  }
  return null
}

async function run() {
  try {
    // ---------- r-4 跨小时窗口 ----------
    resetState()
    state.reminders = []
    let mod = loadReminder()
    await mod.main()
    let cond = lastCond()
    check('r-4 查询条件带 $in 窗口', !!cond && !!cond.time && Array.isArray(cond.time.$in), cond)
    if (cond && cond.time && cond.time.$in) {
      const win = cond.time.$in
      eq('r-4a 窗口长度 = REMINDER_WINDOW_MIN(10)', win.length, 10)
      check('r-4b 跨小时：含前一小时 "23:51"', win.indexOf('23:51') !== -1, win)
      check('r-4c 含当前分钟 "00:00"', win.indexOf('00:00') !== -1, win)
      // 跨午夜场景下字典序必然乱序，改为硬编码时间序期望逐位比对（更有牙齿）
      check('r-4d 窗口为时间序（期望 23:51→00:00 逐位全等）',
        win.join(',') === ['23:51','23:52','23:53','23:54','23:55','23:56','23:57','23:58','23:59','00:00'].join(','), win)
    }

    // ---------- r-5 窗口内提醒被推送并标记周期 ----------
    resetState()
    state.reminders = [
      { _id: 'r1', openid: 'oU1', cycle: 'daily', time: '23:58', enabled: true, lastSentCycle: '' },
    ]
    mod = loadReminder()
    let ret = await mod.main()
    eq('r-5a 窗口内(23:58)提醒被推送', state.sendCalls.length, 1)
    eq('r-5b 推送对象 openid 正确', state.sendCalls[0] && state.sendCalls[0].touser, 'oU1')
    check('r-5c 标记 lastSentCycle 防重发', state.updates.some(function (u) { return u.id === 'r1' && u.data && typeof u.data.lastSentCycle === 'string' && u.data.lastSentCycle.length > 0 }), state.updates)
    eq('r-5d 返回 sent=1', ret.sent, 1)

    // ---------- r-6 同周期已发不重复推送（窗口幂等） ----------
    resetState()
    state.reminders = [
      { _id: 'r1', openid: 'oU1', cycle: 'daily', time: '23:58', enabled: true, lastSentCycle: '2026-09-25' },
    ]
    mod = loadReminder()
    ret = await mod.main()
    eq('r-6 同周期已标记 → 不再推送', state.sendCalls.length, 0)

    // ---------- r-7 非整 5 分钟档命中（窗口语义核心收益） ----------
    resetState()
    state.reminders = [
      { _id: 'r2', openid: 'oU2', cycle: 'daily', time: '23:57', enabled: true, lastSentCycle: '' },
    ]
    mod = loadReminder()
    ret = await mod.main()
    eq('r-7 非整5分钟档(23:57)也命中推送', state.sendCalls.length, 1)
  } catch (e) {
    fail++
    console.log('CRASH ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' << ') : String(e)))
  } finally {
    Date.now = realNow
    Module._load = origLoad
  }

  console.log('TOTAL: pass ' + pass + ', fail ' + fail)
  process.exit(fail ? 1 : 0)
}

run()
