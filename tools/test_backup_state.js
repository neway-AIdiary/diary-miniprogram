/**
 * tools/test_backup_state.js — 云端备份「关闭云端备份/重新开启」状态机回归
 *
 * 覆盖：
 *   1. enable 后 isEnabled/hasSavedKey
 *   2. disable 仅置 enabled=false：isEnabled=false、hasSavedKey=true、state 数据保留
 *   3. reenable 密码错误 → reject「密码与原备份不一致」，且 enabled 仍为 false
 *   4. reenable 密码正确 → 复用原密钥（salt/verifier/key 不变）、enabled=true、触发同步
 *   5. 无本地密钥时 reenable → reject
 * 运行：node tools/test_backup_state.js
 */

let passCount = 0
let failCount = 0
function assert(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected) || actual === expected
  if (ok) { passCount++; console.log('  ✓ ' + name) }
  else { failCount++; console.log('  ✗ ' + name + '\n      期望: ' + JSON.stringify(expected) + '\n      实际: ' + JSON.stringify(actual)) }
}

// ===== mock wx storage =====
const mem = {}
global.wx = {
  getStorageSync: (k) => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v },
  removeStorageSync: (k) => { delete mem[k] }
}

// ===== mock api（拦截网络层；记录 PUT 调用）=====
const path = require('path')
const apiAbs = path.resolve(__dirname, '../utils/api.js')
let putCalls = []
require.cache[apiAbs] = {
  id: apiAbs, filename: apiAbs, loaded: true,
  exports: {
    request: function (method) {
      if (method === 'PUT') putCalls.push(1)
      return Promise.resolve({ exists: true, itemCount: 0 })
    }
  }
}

const backup = require('../utils/backup.js')

async function run() {
  // 1. 开启备份
  const r = await backup.enable('test-password-123')
  assert('enable 上传成功', typeof r.itemCount, 'number')
  assert('开启后 isEnabled', backup.isEnabled(), true)
  assert('开启后 hasSavedKey', backup.hasSavedKey(), true)
  const before = backup.getState()

  // 2. 关闭云端备份：仅置 disabled，密钥与状态保留
  backup.disable()
  assert('关闭后 isEnabled', backup.isEnabled(), false)
  assert('关闭后 hasSavedKey', backup.hasSavedKey(), true)
  const after = backup.getState()
  assert('关闭后 salt 保留', after.salt, before.salt)
  assert('关闭后 key 保留', after.key, before.key)
  assert('关闭后 verifier 保留', after.verifier, before.verifier)
  assert('关闭后 enabled=false', after.enabled, false)

  // 3. 错误密码：拒绝且状态不变
  let errMsg = ''
  try { await backup.reenable('wrong-password') } catch (e) { errMsg = e.message }
  assert('错误密码被拒', errMsg, '密码与原备份不一致')
  assert('拒绝后仍关闭', backup.isEnabled(), false)

  // 4. 正确密码：复用原密钥并立即同步
  const r2 = await backup.reenable('test-password-123')
  assert('reenable 同步成功', typeof r2.itemCount, 'number')
  assert('reenable 触发了 PUT 同步', putCalls.length >= 1, true)
  const resumed = backup.getState()
  assert('复用原 salt', resumed.salt, before.salt)
  assert('复用原 key', resumed.key, before.key)
  assert('重新开启 isEnabled', backup.isEnabled(), true)

  // 5. 同步失败留痕 → 成功同步后自动清除（备份页红字提示依据）
  const apiMock = require.cache[apiAbs].exports
  const origRequest = apiMock.request
  apiMock.request = function () { return Promise.reject(new Error('网络超时')) }
  let failMsg = ''
  try { await backup.sync() } catch (e) { failMsg = e.message }
  assert('同步失败向外抛出', failMsg, '网络超时')
  const errRecord = backup.getLastSyncError()
  assert('失败已留痕（含时间与原因）', !!(errRecord && errRecord.message === '网络超时' && errRecord.at), true)
  apiMock.request = origRequest
  await backup.sync()
  assert('成功同步后清除失败记录', backup.getLastSyncError(), null)
  assert('成功同步后仍开启', backup.isEnabled(), true)

  // 6. 无本地密钥时 reenable 拒绝
  mem['cloud_backup_state'] = { enabled: false }
  try { await backup.reenable('test-password-123'); assert('无密钥应拒绝', false, true) }
  catch (e) { assert('无密钥拒绝', !!e.message, true) }

  console.log('\n---\n通过 ' + passCount + ' / 失败 ' + failCount)
  process.exit(failCount ? 1 : 0)
}

run().catch((e) => {
  console.log('\n---\n运行异常：' + e.message)
  process.exit(1)
})
