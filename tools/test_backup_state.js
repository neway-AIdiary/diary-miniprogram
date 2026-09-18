/**
 * tools/test_backup_state.js — 云端备份「云开发版」回归（2026-09-17 迁移自 Railway 后重写）
 *
 * 覆盖：
 *   1. enable 后 isEnabled/hasSavedKey；云端 meta 与密文文件已写入
 *   2. disable 仅置 enabled=false：isEnabled=false、hasSavedKey=true、state 数据保留
 *   3. reenable 密码错误 → reject「密码与原备份不一致」，且 enabled 仍为 false
 *   4. reenable 密码正确 → 复用原密钥（salt/verifier/key 不变）、enabled=true、触发同步
 *   5. 无本地密钥时 reenable → reject
 *   6. 云端闭环：sync 覆盖（旧文件删除、meta 更新）→ restore 正确密码拿回原日记 / 错误密码拒绝
 *   7. clearCloud 物理删除：meta 与云存储文件都删除，cloudStatus.exists=false，本地 key 保留
 *   8. 云端无数据时 restore / cloudStatus 安全
 *   9. 集合不存在 → 中文友好错误
 *  10. 多版本快照：版本累积、封顶 MAX_VERSIONS(5)、listVersions、
 *      按序号恢复历史版本、越界回退最新、旧结构（无 versions）兼容、
 *      clearCloud 删除全部版本文件
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
  removeStorageSync: (k) => { delete mem[k] },
  env: { USER_DATA_PATH: '/user-data' }
}

// ===== mock 云开发：数据库 + 云存储 + 本地文件系统 =====
let metaDocs = []       // backup_meta 集合内存版（每条含 _id）
let idSeq = 0
const cloudFiles = {}   // cloudPath -> content
const fileIDToPath = {}
let cloudBroken = false // 置 true 模拟「集合不存在/云端不可用」

function dbErr(msg) {
  return { errMsg: msg }
}

const mockDb = {
  collection() {
    return {
      limit() {
        return {
          get: () => new Promise((resolve, reject) => {
            if (cloudBroken) return reject(dbErr('errCode: -502004 collection backup_meta not exists'))
            resolve({ data: metaDocs.slice(0, 1) })
          })
        }
      },
      add(opts) {
        return new Promise((resolve, reject) => {
          if (cloudBroken) return reject(dbErr('errCode: -502004 collection backup_meta not exists'))
          const id = 'meta_' + (++idSeq)
          metaDocs.push(Object.assign({ _id: id }, opts.data))
          resolve({ _id: id })
        })
      },
      doc(id) {
        return {
          update(opts) {
            return new Promise((resolve, reject) => {
              if (cloudBroken) return reject(dbErr('errCode: -502004 collection backup_meta not exists'))
              const d = metaDocs.find((x) => x._id === id)
              if (!d) return reject(dbErr('document not exists'))
              Object.assign(d, opts.data)
              resolve({})
            })
          },
          remove() {
            return new Promise((resolve, reject) => {
              if (cloudBroken) return reject(dbErr('errCode: -502004 collection backup_meta not exists'))
              metaDocs = metaDocs.filter((x) => x._id !== id)
              resolve({})
            })
          }
        }
      }
    }
  }
}

const localFiles = {}
const mockFs = {
  writeFile(opts) {
    localFiles[opts.filePath] = String(opts.data)
    setTimeout(() => opts.success && opts.success(), 0)
  },
  readFile(opts) {
    setTimeout(() => {
      if (opts.filePath in localFiles) opts.success && opts.success({ data: localFiles[opts.filePath] })
      else opts.fail && opts.fail({ errMsg: 'readFile:fail no such file' })
    }, 0)
  }
}

global.wx.getFileSystemManager = () => mockFs
global.wx.cloud = {
  database: () => mockDb,
  uploadFile(opts) {
    setTimeout(() => {
      if (cloudBroken) return opts.fail && opts.fail({ errMsg: 'uploadFile:fail env check invalid' })
      cloudFiles[opts.cloudPath] = localFiles[opts.filePath]
      const fileID = 'cloud://aidiary/' + opts.cloudPath
      fileIDToPath[fileID] = opts.cloudPath
      opts.success && opts.success({ fileID: fileID })
    }, 0)
  },
  downloadFile(opts) {
    setTimeout(() => {
      const p = fileIDToPath[opts.fileID]
      if (!p || !(p in cloudFiles)) return opts.fail && opts.fail({ errMsg: 'downloadFile:fail file not exists' })
      const tmp = '/tmp/' + p.replace(/\//g, '_')
      localFiles[tmp] = cloudFiles[p]
      opts.success && opts.success({ tempFilePath: tmp })
    }, 0)
  },
  deleteFile(opts) {
    setTimeout(() => {
      ;(opts.fileList || []).forEach((f) => {
        const p = fileIDToPath[f]
        if (p) delete cloudFiles[p]
        delete fileIDToPath[f]
      })
      opts.success && opts.success({ fileList: opts.fileList || [] })
    }, 0)
  }
}

// ===== mock storage（buildPayload 依赖；返回固定假日记）=====
const path = require('path')
const storageAbs = path.resolve(__dirname, '../utils/storage.js')
require.cache[storageAbs] = {
  id: storageAbs, filename: storageAbs, loaded: true,
  exports: {
    getAllDiaries: () => [{ id: 'd1', title: '第一篇', content: '今天写了测试日记。' }],
    getArchives: () => [{ name: '工作' }]
  }
}

const backup = require('../utils/backup.js')

async function run() {
  // 1. 云端为空：状态查询与恢复都安全
  let status = await backup.cloudStatus()
  assert('初始云端无备份', status.exists, false)
  let noDataMsg = ''
  try { await backup.restore('test-password-123') } catch (e) { noDataMsg = e.message }
  assert('云端无数据时 restore 报「云端没有备份数据」', noDataMsg, '云端没有备份数据')

  // 2. 开启备份
  const r = await backup.enable('test-password-123')
  assert('enable 上传成功（1 篇）', r.itemCount, 1)
  assert('开启后 isEnabled', backup.isEnabled(), true)
  assert('开启后 hasSavedKey', backup.hasSavedKey(), true)
  const before = backup.getState()
  assert('本地 state 记录 metaId', typeof before.metaId === 'string' && before.metaId.length > 0, true)
  assert('本地 state 记录 fileID', typeof before.fileID === 'string' && before.fileID.length > 0, true)
  assert('云端 meta 已写入（1 条）', metaDocs.length, 1)
  assert('云端 meta 带 verifier', metaDocs[0].verifier.length > 0, true)
  assert('云端密文文件已存在', Object.keys(cloudFiles).length, 1)
  assert('云端 itemCount 记录', metaDocs[0].itemCount, 1)
  status = await backup.cloudStatus()
  assert('cloudStatus.exists=true', status.exists, true)

  // 3. 关闭云端备份：仅置 disabled，密钥与状态保留
  backup.disable()
  assert('关闭后 isEnabled', backup.isEnabled(), false)
  assert('关闭后 hasSavedKey', backup.hasSavedKey(), true)
  const after = backup.getState()
  assert('关闭后 salt 保留', after.salt, before.salt)
  assert('关闭后 key 保留', after.key, before.key)
  assert('关闭后 verifier 保留', after.verifier, before.verifier)
  assert('关闭后 enabled=false', after.enabled, false)

  // 4. 错误密码：拒绝且状态不变
  let errMsg = ''
  try { await backup.reenable('wrong-password') } catch (e) { errMsg = e.message }
  assert('错误密码被拒', errMsg, '密码与原备份不一致')
  assert('拒绝后仍关闭', backup.isEnabled(), false)

  // 5. 正确密码：复用原密钥并立即同步
  const r2 = await backup.reenable('test-password-123')
  assert('reenable 同步成功', typeof r2.itemCount, 'number')
  assert('reenable 后云端累积为 2 版（多版本快照：旧版不再被删）', Object.keys(cloudFiles).length, 2)
  const resumed = backup.getState()
  assert('复用原 salt', resumed.salt, before.salt)
  assert('复用原 key', resumed.key, before.key)
  assert('重新开启 isEnabled', backup.isEnabled(), true)

  // 6. 云端闭环：restore 拿回原日记
  const restored = await backup.restore('test-password-123')
  assert('restore 返回 1 篇日记', restored.diaries.length, 1)
  assert('restore 内容一致', restored.diaries[0].content, '今天写了测试日记。')
  assert('restore 档案一并返回', restored.archives.length, 1)
  let wrongMsg = ''
  try { await backup.restore('wrong-password') } catch (e) { wrongMsg = e.message }
  assert('restore 错误密码报「备份密码不正确」', wrongMsg, '备份密码不正确')

  // 7. 同步失败留痕 → 成功同步后自动清除（备份页红字提示依据）
  cloudBroken = true
  let failMsg = ''
  try { await backup.sync() } catch (e) { failMsg = e.message }
  assert('同步失败向外抛出', typeof failMsg === 'string' && failMsg.length > 0, true)
  const errRecord = backup.getLastSyncError()
  assert('失败已留痕（含时间与原因）', !!(errRecord && errRecord.message && errRecord.at), true)
  cloudBroken = false
  await backup.sync()
  assert('成功同步后清除失败记录', backup.getLastSyncError(), null)
  assert('成功同步后仍开启', backup.isEnabled(), true)

  // 8. 集合不存在 → 中文友好错误（真实云开发报错是英文长串）
  cloudBroken = true
  mem['cloud_backup_state'] = null
  let collMsg = ''
  try { await backup.cloudStatus() } catch (e) { collMsg = e.message }
  assert('集合不存在时给出中文指引', collMsg.indexOf('backup_meta') >= 0 && collMsg.indexOf('控制台') >= 0, true)
  cloudBroken = false

  // 9. clearCloud 物理删除：meta 与文件都删，本地 key 保留
  // 覆盖护栏（2026-09-18）：清空前的云端已有备份，此时未显式授权的 enable 必须被拒
  const versionsBefore = (metaDocs[0].versions || []).length
  let guardMsg = ''
  try { await backup.enable('test-password-123') } catch (e) { guardMsg = e.message }
  assert('未授权 enable 被覆盖护栏拒绝', guardMsg.indexOf('云端已有备份') >= 0, true)
  assert('被拒后云端版本数不变（没被静默清空）', (metaDocs[0].versions || []).length, versionsBefore)
  await backup.enable('test-password-123', { allowOverwrite: true }) // 确保有云端数据（显式授权覆盖）
  const preClear = backup.getState()
  assert('清空前云端有 1 份快照', Object.keys(cloudFiles).length, 1)
  await backup.clearCloud()
  assert('清空后 meta 已删除', metaDocs.length, 0)
  assert('清空后云存储文件已删除', Object.keys(cloudFiles).length, 0)
  status = await backup.cloudStatus()
  assert('清空后 cloudStatus.exists=false', status.exists, false)
  assert('清空后本地 key 保留', backup.hasSavedKey(), true)
  assert('清空后本地日记不受影响（storage mock 未被触碰）', preClear.key, backup.getState().key)

  // 10. 清空后再次开启 → 重建 meta（ensureMeta 自愈）
  const r3 = await backup.enable('test-password-123')
  assert('清空后重新 enable 成功', r3.itemCount, 1)
  assert('meta 重建（1 条）', metaDocs.length, 1)

  // 11. 无本地密钥时 reenable 拒绝
  mem['cloud_backup_state'] = { enabled: false }
  try { await backup.reenable('test-password-123'); assert('无密钥应拒绝', false, true) }
  catch (e) { assert('无密钥拒绝', !!e.message, true) }

  // ===== 12. 多版本快照 =====
  // 重置云端与本地状态（模拟全新用户）
  mem['cloud_backup_state'] = null
  metaDocs = []
  Object.keys(cloudFiles).forEach((k) => { delete cloudFiles[k] })
  Object.keys(fileIDToPath).forEach((k) => { delete fileIDToPath[k] })

  await backup.enable('test-password-123')
  let mv = metaDocs[0]
  assert('版本列表初始 1 版', mv.versions.length, 1)
  assert('最新版 fileID 与 meta.fileID 一致', mv.versions[0].fileID, mv.fileID)
  assert('版本项记录时间与篇数', !!(mv.versions[0].at && typeof mv.versions[0].itemCount === 'number'), true)

  // 连续同步 6 次：版本累积但封顶 MAX_VERSIONS
  for (let i = 0; i < 6; i++) await backup.sync()
  mv = metaDocs[0]
  assert('同步 6 次后版本数封顶 5', mv.versions.length, 5)
  assert('云存储文件数与版本数一致（超限最旧已删）', Object.keys(cloudFiles).length, 5)

  // 版本列表接口
  const vers = await backup.listVersions()
  assert('listVersions 返回 5 版', vers.length, 5)
  assert('listVersions 首项 index=0（最新）', vers[0].index, 0)
  assert('listVersions 末项 index=4', vers[4].index, 4)
  assert('listVersions 含篇数', typeof vers[0].itemCount, 'number')

  // 按序号恢复历史版本
  const oldest = await backup.restore('test-password-123', 4)
  assert('按序号恢复最旧版本成功', oldest.diaries.length, 1)
  assert('恢复结果带版本时间', typeof oldest.versionAt === 'string' && oldest.versionAt.length > 0, true)
  assert('恢复结果带版本序号', oldest.versionIndex, 4)
  const fallback = await backup.restore('test-password-123', 99)
  assert('越界序号回退到最新版', fallback.versionIndex, 0)
  let badPwdMsg = ''
  try { await backup.restore('wrong-password', 3) } catch (e) { badPwdMsg = e.message }
  assert('历史版本恢复同样校验密码', badPwdMsg, '备份密码不正确')

  // cloudStatus 暴露版本数
  const vst = await backup.cloudStatus()
  assert('cloudStatus.versionCount=5', vst.versionCount, 5)

  // 旧结构兼容：meta 只有 fileID（迁移前的历史数据）→ 视为 1 版
  const snapshotMeta = JSON.parse(JSON.stringify(metaDocs[0]))
  metaDocs[0] = {
    _id: snapshotMeta._id,
    salt: snapshotMeta.salt,
    verifier: snapshotMeta.verifier,
    itemCount: snapshotMeta.itemCount,
    fileID: snapshotMeta.versions[0].fileID,
    payloadSize: snapshotMeta.payloadSize,
    updatedAt: snapshotMeta.updatedAt
  }
  const compat = await backup.listVersions()
  assert('旧结构（无 versions）视为 1 版', compat.length, 1)
  const compatRestore = await backup.restore('test-password-123')
  assert('旧结构仍可正常恢复', compatRestore.diaries.length, 1)

  // enable 重置版本：新密码场景清空历史版本，从第 1 版重建
  // （2026-09-18 起这条「清空重建」路径必须显式授权，否则会被覆盖护栏拒绝）
  metaDocs[0].versions = snapshotMeta.versions
  await backup.enable('test-password-123', { allowOverwrite: true })
  assert('enable 后版本重置为 1 版', metaDocs[0].versions.length, 1)
  assert('enable 后云存储只剩 1 个文件（旧版本已清）', Object.keys(cloudFiles).length, 1)

  // clearCloud 删除全部版本文件
  for (let i = 0; i < 3; i++) await backup.sync()
  assert('清空前云端 4 个版本文件', Object.keys(cloudFiles).length, 4)
  await backup.clearCloud()
  assert('清空后云存储文件全部删除（含历史版本）', Object.keys(cloudFiles).length, 0)
  assert('清空后 meta 已删除', metaDocs.length, 0)

  console.log('\n---\n通过 ' + passCount + ' / 失败 ' + failCount)
  process.exit(failCount ? 1 : 0)
}

run().catch((e) => {
  console.log('\n---\n运行异常：' + e.message)
  process.exit(1)
})
