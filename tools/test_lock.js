/**
 * 日记本密码（4 位）测试
 * 运行：node tools/test_lock.js
 *
 * A. 常量契约（位数 / 次数 / 冻结与重锁门槛 / 锁屏页路径）
 * B. 开关与哈希：默认关闭、设码、不存明文、随机盐、非法输入拒绝
 * C. 校验：正确 / 错误 / 未开启时恒通过
 * D. 连错冻结：第 5 次触发、冻结期内正确密码也拒绝、期满解除
 * E. 清空：删除的键、日记数据不受影响、清空后不再拦截
 * F. 会话与守卫：initSession / guard 跳转与防抖 / onAppShow 的 30 秒边界
 * G. 草稿模块：空白不存、正常读写、过期作废
 * H. 落地 lint：接入点存在（app.json / app.js / 设置页顺序 / 8 个页面守卫 / 草稿清除时机）
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) pass++
  else { fail++; console.log('  ✗ ' + msg) }
}

// ---------- mock wx ----------
function mockWx() {
  global.wx = {
    _s: {},
    _relaunch: [],
    getStorageSync(k) { return this._s[k] },
    setStorageSync(k, v) { this._s[k] = v },
    removeStorageSync(k) { delete this._s[k] },
    reLaunch(opt) {
      this._relaunch.push(opt.url)
      if (opt.complete) opt.complete()
    }
  }
  return global.wx
}
mockWx()

const lock = require('../utils/lock.js')
const draft = require('../utils/draft.js')

// 注入时钟，便于测冻结与后台停留
let T = 1700000000000
lock._setNow(() => T)
function reset() {
  mockWx()
  lock._resetSession()
}
function code() { return global.wx._s['yidengji_lock_hash'] }
function salt() { return global.wx._s['yidengji_lock_salt'] }

// ============ A. 常量 ============
console.log('== A. 常量契约 ==')
ok(lock.CODE_LEN === 4, '密码位数 = 4')
ok(lock.MAX_FAIL === 5, '连错上限 = 5 次')
ok(lock.FREEZE_SEC === 30, '冻结时长 = 30 秒')
ok(lock.RELOCK_SEC === 30, '后台停留门槛 = 30 秒（回前台重锁）')
ok(lock.LOCK_PAGE === '/pages/lock/lock', '锁屏页路径正确')
ok(lock.HOME_PAGE === '/pages/write/write', '解锁后回写日记页（默认首页）')
ok(lock.ITERATIONS >= 1000, '哈希轮数不小于 1000')

// ============ B. 开关与哈希 ============
console.log('== B. 开关与哈希 ==')
reset()
ok(lock.isEnabled() === false, '默认关闭')

ok(lock.setCode('12') === false, '拒绝 2 位')
ok(lock.setCode('12345') === false, '拒绝 5 位')
ok(lock.setCode('abcd') === false, '拒绝非数字')
ok(lock.setCode('') === false && lock.setCode(null) === false, '拒绝空值')
ok(lock.isEnabled() === false, '非法输入不改变开关')

ok(lock.setCode('1234') === true, '接受 4 位数字')
ok(lock.isEnabled() === true, '设置后开关打开')
ok(code() !== '1234', '不存明文密码')
ok(/^[0-9a-f]{64}$/.test(code() || ''), '哈希为 64 位 hex（SHA-256 输出）')
ok(/^[0-9a-f]{32}$/.test(salt() || ''), '存在 16 字节随机盐（hex）')
ok(lock.isSessionUnlocked() === true, '刚设完密码当前会话视为已解锁')

const h1 = code()
lock.clear()
lock.setCode('1234')
ok(code() !== h1, '同一密码两次设置哈希不同（随机盐生效）')

// ============ C. 校验 ============
console.log('== C. 校验 ==')
reset()
lock.setCode('1234')
ok(lock.verify('1234') === true, '正确密码通过')
ok(lock.verify('1235') === false, '错误密码不通过')
ok(lock.verify(1234) === true, '数字类型入参等价（1234）')

const r1 = (lock.lockSession(), lock.attempt('1234'))
ok(r1.ok === true && r1.freeze === 0, 'attempt 正确 → ok')
ok(lock.isSessionUnlocked() === true, 'attempt 通过后会话解锁')

lock.lockSession()
const r2 = lock.attempt('0000')
ok(r2.ok === false && r2.reason === 'wrong', 'attempt 错误 → reason=wrong')

lock.clear()
ok(lock.isEnabled() === false, '清空后开关关闭')
ok(lock.verify('0000') === true, '未开启密码时校验恒通过')

// ============ D. 连错冻结 ============
console.log('== D. 连错冻结 ==')
reset()
lock.setCode('1234')
lock.lockSession()
for (let i = 0; i < 4; i++) {
  const r = lock.attempt('0000')
  ok(r.freeze === 0, '第 ' + (i + 1) + ' 次错误未冻结')
}
const r5 = lock.attempt('0000')
ok(r5.freeze > 0 && r5.reason === 'wrong', '第 5 次错误触发冻结')
ok(lock.freezeLeft() > 0, 'freezeLeft > 0')

const inFrozen = lock.attempt('1234')
ok(inFrozen.ok === false && inFrozen.reason === 'frozen', '冻结期内正确密码也被拒绝')
ok(lock.isSessionUnlocked() === false, '冻结期内会话仍未解锁')

T += 29 * 1000
ok(lock.freezeLeft() > 0, '29 秒时仍在冻结中')
T += 2 * 1000
ok(lock.freezeLeft() === 0, '31 秒后冻结解除')
const afterFrozen = lock.attempt('1234')
ok(afterFrozen.ok === true, '冻结解除后可正常解锁')
ok(global.wx._s['yidengji_lock_fail'] === undefined, '解锁成功后清空失败计数')

// ============ E. 清空 ============
console.log('== E. 清空 ==')
reset()
lock.setCode('1234')
// 模拟用户已有日记数据
global.wx._s['diaries'] = [{ id: 'd1', title: '今天', content: '内容' }]
global.wx._s['archives'] = [{ id: 'a1', name: '王维' }]
lock.lockSession()

lock.clear()
ok(lock.isEnabled() === false, '清空后开关关闭')
ok(code() === undefined && salt() === undefined, '密码哈希与盐已删除')
ok(global.wx._s['yidengji_lock_fail'] === undefined, '失败计数一并清除')
ok(Array.isArray(global.wx._s['diaries']) && global.wx._s['diaries'].length === 1, '日记数据不受影响')
ok(Array.isArray(global.wx._s['archives']) && global.wx._s['archives'].length === 1, '档案数据不受影响')
ok(lock.isSessionUnlocked() === true, '清空后当前会话视为已解锁')

const anyCode = lock.attempt('9999')
ok(anyCode.ok === true, '清空后任意输入都能进入（密码已不存在）')
ok(lock.guard() === false, '清空后守卫不再拦截')

// ============ F. 会话与守卫 ============
console.log('== F. 会话与守卫 ==')
reset()
ok(lock.initSession() === true, '未开启密码：会话直接解锁')

lock.setCode('1234')
lock._resetSession() // 只复位会话态，不动存储
ok(lock.initSession() === false, '开启密码：冷启动会话为未解锁')

// 守卫：未解锁 → 跳锁屏页，且连续调用只跳一次
global.wx._relaunch = []
ok(lock.guard() === true, '未解锁时守卫返回 true')
ok(global.wx._relaunch.length === 1 && global.wx._relaunch[0] === '/pages/lock/lock', '跳转锁屏页')
lock.guard()
lock.guard()
ok(global.wx._relaunch.length === 1, '连续守卫只跳一次（防抖）')

// 解锁后不再拦截
lock._resetSession()
lock.unlockSession()
global.wx._relaunch = []
ok(lock.guard() === false && global.wx._relaunch.length === 0, '已解锁不拦截')

// 冷启动时序：App.onShow 早于首屏入栈 → 不发起跳转、也不置防抖标记（否则会把首屏守卫一起挡掉 → 漏锁）
lock._resetSession()
global.wx._relaunch = []
global.getCurrentPages = () => []          // 页面栈为空：reLaunch 会失败
ok(lock.guard() === true, '页面栈为空：仍判定「需要锁」')
ok(global.wx._relaunch.length === 0, '页面栈为空：不发起跳转')
global.getCurrentPages = () => [{}]        // 首屏已入栈
ok(lock.guard() === true && global.wx._relaunch.length === 1, '首屏入栈后正常跳锁屏页')
delete global.getCurrentPages

// 冷启动 onAppShow：会话未解锁 → 上锁
lock._resetSession()
global.wx._relaunch = []
ok(lock.onAppShow() === true, '冷启动未解锁 → onAppShow 判定上锁')
ok(global.wx._relaunch.length === 1, '并跳到锁屏页')

// 后台停留门槛
lock._resetSession()
lock.unlockSession()
lock.noteHide()
T += 29 * 1000
global.wx._relaunch = []
ok(lock.onAppShow() === false, '后台 29 秒：不上锁')
ok(lock.isSessionUnlocked() === true, '会话保持解锁')

lock.noteHide()
T += 30 * 1000
ok(lock.onAppShow() === true, '后台满 30 秒：重新上锁')
ok(lock.isSessionUnlocked() === false, '上锁后会话未解锁')

// 未开启密码时不干预
lock.clear()
lock._resetSession()
lock.noteHide()
T += 10 * 60 * 1000
global.wx._relaunch = []
ok(lock.onAppShow() === false && global.wx._relaunch.length === 0, '未开启密码前后台切换不干预')

// ============ G. 草稿模块 ============
console.log('== G. 草稿 ==')
reset()
ok(draft.load() === null, '无草稿时返回 null')

ok(draft.save('   ') === false && draft.load() === null, '纯空白不存草稿')
ok(draft.save('') === false, '空串不存草稿')

ok(draft.save('今天开了两个会，很累。') === true, '存草稿成功')
const d1 = draft.load()
ok(d1 && d1.content === '今天开了两个会，很累。', '读回内容一致')
ok(d1.savedAt > 0, '带写入时间')

// 再次保存覆盖
draft.save('改过的内容')
ok(draft.load().content === '改过的内容', '重复保存覆盖旧草稿')

// 空白覆盖 → 草稿作废（用户主动清空）
ok(draft.save('  ') === false && draft.load() === null, '清空输入框即作废草稿')

// 过期作废
const old = Date.now() - (draft.MAX_AGE_MS + 60 * 1000)
global.wx._s[draft.KEY] = { content: '很久以前的草稿', savedAt: old }
ok(draft.load() === null, '超过 7 天自动作废')
ok(global.wx._s[draft.KEY] === undefined, '过期草稿已清除')

draft.save('有效内容')
draft.clear()
ok(draft.load() === null && global.wx._s[draft.KEY] === undefined, 'clear 后无草稿')

// ============ H. 落地 lint ============
console.log('== H. 落地 lint ==')
const ROOT = path.join(__dirname, '..')
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

const appJson = JSON.parse(read('app.json'))
ok(appJson.pages.indexOf('pages/lock/lock') >= 0, 'app.json 已注册锁屏页')
ok(appJson.pages.indexOf('pages/setting-lock/setting-lock') >= 0, 'app.json 已注册密码设置页')
ok(appJson.pages[0] === 'pages/write/write', '首页仍为写日记页（启动页未被改动）')

const appJs = read('app.js')
ok(appJs.indexOf('initSession') >= 0, 'app.js 冷启动初始化会话')
ok(appJs.indexOf('onAppShow') >= 0, 'app.js onShow 判定重锁')
ok(appJs.indexOf('noteHide') >= 0, 'app.js onHide 记录后台时刻')

const settingWxml = read('pages/setting/setting.wxml')
const iAlarm = settingWxml.indexOf('goToReminder')
const iLock = settingWxml.indexOf('goToLock')
ok(iAlarm >= 0 && iLock > iAlarm, '密码项位于「闹钟」下方')
ok(settingWxml.indexOf('ri-lock-line') >= 0, '使用已有锁图标（不新增字体子集）')
const settingJs = read('pages/setting/setting.js')
ok(settingJs.indexOf('syncLockState') >= 0, '设置页同步开关状态文案')

const guarded = [
  'pages/write/write.js', 'pages/index/index.js', 'pages/detail/detail.js',
  'pages/archive/archive.js', 'pages/summary/summary.js', 'pages/summary-result/summary-result.js',
  'pages/profile/profile.js', 'pages/backup/backup.js'
]
guarded.forEach(p => {
  const s = read(p)
  ok(s.indexOf("require('../../utils/lock.js')") >= 0, '已引入 lock 模块：' + p)
  ok(s.indexOf('lock.guard()') >= 0, 'onShow 守卫已接入：' + p)
})

const wj = read('pages/write/write.js')
ok(wj.indexOf('this.saveDraft()') >= 0, '写日记页离开时存草稿')
ok(wj.indexOf('this.restoreDraft()') >= 0, '写日记页回到时恢复草稿')
ok(/resetAfterSave\s*\(diaryDate\)\s*\{[\s\S]{0,300}?draft\.clear\(\)/.test(wj), '保存成功后草稿作废')
ok(/restoreDraft\s*\(\)\s*\{[\s\S]{0,300}?if \(String\(this\.data\.content \|\| ''\)\.trim\(\)\) return/.test(wj),
  '恢复前检查输入框为空（不覆盖正在写的内容）')

const lockSrc = read('utils/lock.js')
ok(lockSrc.indexOf('pbkdf2') >= 0, '哈希用现成 pbkdf2（crypto.js）')
ok(lockSrc.indexOf('randomBytes') >= 0, '盐来自 crypto.randomBytes')
ok(lockSrc.indexOf("'1234'") < 0 && lockSrc.indexOf('默认密码') < 0, '源码内无任何示例密码')

// 设置页状态机：set → confirm 必须带着上一次输入（曾在 startStage 里被无条件清空过）
const slJs = read('pages/setting-lock/setting-lock.js')
ok(/if \(stage === 'set'\) this\._pending = ''/.test(slJs), 'confirm 阶段保留 pending（两次输入比对依赖它）')
ok(/code === this\._pending/.test(slJs), '两次输入用 pending 比对')

// 锁屏页：忘记密码 = 清空密码 + 回首页（日记不动）
const lockPage = read('pages/lock/lock.js')
ok(/onForget\s*\(\)[\s\S]{0,600}?lock\.clear\(\)/.test(lockPage), '忘记密码走 lock.clear()')
ok(/lock\.clear\(\)[\s\S]{0,200}?goHome\(\)/.test(lockPage), '清空后直接进首页')
ok(/lock\.attempt\(/.test(lockPage), '锁屏页用统一 attempt（共享冻结计数）')

console.log('\n通过 ' + pass + ' / 失败 ' + fail)
if (fail > 0) process.exit(1)
