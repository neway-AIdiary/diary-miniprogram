/**
 * tools/test_media_guard.js
 * 云端媒体管理回归：
 *   1. 视频限时 30s / 限体积 25MB 过滤
 *   2. 图片恒通过、正常视频通过
 *   3. 用量累计与 4GB 阈值一次性提醒；扣减与归零
 *   4. 删除日记媒体收集（fileID 去重 / 只收 cloud://）
 *   5. 编辑保存差集清理 computeRemovedFiles（旧媒体被移除 ∪ 会话新传未保留）
 *   6. 批量云删除（分批 50 / 失败计数 / 无云环境降级）与 deleteMediaItems（扣减用量+云删）
 * 运行：node tools/test_media_guard.js
 */
const store = {}
let modalShown = null
const cloudCalls = []
let cloudFailSet = null // 命中这些 fileID 模拟失败
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  showModal: (opts) => { modalShown = opts },
  getFileInfo: () => {},
  cloud: {
    deleteFile: (opts) => {
      cloudCalls.push(opts.fileList)
      const res = { fileList: opts.fileList.map((id) => {
        if (cloudFailSet && cloudFailSet.indexOf(id) !== -1) return { fileID: id, status: -1, errMsg: 'fail' }
        return { fileID: id, status: 0 }
      }) }
      opts.success && opts.success(res)
    }
  }
}

const mg = require('../utils/mediaGuard.js')

let passCount = 0
let failCount = 0
function assert(name, actual, expect) {
  const ok = actual === expect
  if (ok) { passCount++ } else { failCount++ }
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | expect=' + JSON.stringify(expect) + ' actual=' + JSON.stringify(actual)))
}
function reset() {
  for (const k in store) delete store[k]
  modalShown = null
  cloudCalls.length = 0
  cloudFailSet = null
}

// ===== 1. 视频限时 / 限体积（30s / 25MB）=====
let r = mg.guard([
  { fileType: 'image', tempFilePath: '/a.jpg' },
  { fileType: 'video', tempFilePath: '/v1.mp4', duration: 10, size: 5 * 1024 * 1024 },   // 正常
  { fileType: 'video', tempFilePath: '/v2.mp4', duration: 31, size: 5 * 1024 * 1024 },   // 超时
  { fileType: 'video', tempFilePath: '/v3.mp4', duration: 5, size: 26 * 1024 * 1024 }    // 超体积
])
assert('视频护栏：正常视频+图片通过', r.pass.length, 2)
assert('视频护栏：超 30 秒计数', r.tooLong, 1)
assert('视频护栏：超 25MB 计数', r.tooBig, 1)
assert('视频护栏：超限项不进 pass', r.pass.some(f => f.tempFilePath.indexOf('v2') !== -1 || f.tempFilePath.indexOf('v3') !== -1), false)

// 边界值：正好 30 秒 / 正好 25MB 放行
r = mg.guard([
  { fileType: 'video', tempFilePath: '/v30.mp4', duration: 30, size: 25 * 1024 * 1024 }
])
assert('视频护栏：边界值(30s/25MB)放行', r.pass.length, 1)

// 视频无 duration/size 信息（异常数据）→ 放行由上传失败兜底
r = mg.guard([{ fileType: 'video', tempFilePath: '/vx.mp4' }])
assert('视频护栏：无元数据不误拦', r.pass.length, 1)

// guardToast 文案
const g2 = mg.guard([
  { fileType: 'video', duration: 45, size: 40 * 1024 * 1024 },
  { fileType: 'video', duration: 35, size: 1 },
  { fileType: 'video', duration: 3, size: 26 * 1024 * 1024 }
])
assert('guardToast 含两种原因', mg.guardToast(g2.tooLong, g2.tooBig), '2 个超 30 秒，1 个超 25MB，已跳过')

// ===== 2. 用量累计与提醒 =====
reset()
mg.addMediaUsage(300 * 1024)           // 300KB
mg.addMediaUsage(2 * 1024 * 1024)      // +2MB
assert('用量累计', mg.getMediaUsage(), 300 * 1024 + 2 * 1024 * 1024)
assert('未达阈值不提醒', modalShown, null)

reset()
mg.addMediaUsage(3 * 1024 * 1024 * 1024)               // 3GB，未达 4GB 阈值
assert('3GB 不提醒', modalShown, null)
mg.addMediaUsage(2 * 1024 * 1024 * 1024)               // 累计 5GB，越过 4GB
assert('越过阈值触发提醒', modalShown && modalShown.title, '云端存储用量提醒')
assert('提醒文案含估算 GB', modalShown && modalShown.content.indexOf('GB') !== -1, true)

// 提醒只弹一次
modalShown = null
mg.addMediaUsage(1024 * 1024)
assert('提醒只弹一次', modalShown, null)

// 非法输入不破坏累计
reset()
mg.addMediaUsage(0)
mg.addMediaUsage(-5)
mg.addMediaUsage(100)
assert('非法输入被忽略', mg.getMediaUsage(), 100)

// ===== 3. 用量扣减与归零 =====
reset()
mg.addMediaUsage(10 * 1024 * 1024)
mg.subtractMediaUsage(4 * 1024 * 1024)
assert('用量扣减', mg.getMediaUsage(), 6 * 1024 * 1024)
mg.subtractMediaUsage(100 * 1024 * 1024)
assert('扣减下限 0', mg.getMediaUsage(), 0)
mg.addMediaUsage(5 * 1024 * 1024)
mg.clearMediaUsage()
assert('用量归零', mg.getMediaUsage(), 0)
mg.subtractMediaUsage(-3)
mg.subtractMediaUsage(0)
assert('非法扣减被忽略', mg.getMediaUsage(), 0)

// ===== 4. 删除媒体收集 =====
const d1 = { id: '1', media: [
  { fileID: 'cloud://env.a/b/i_1.jpg', type: 'image', size: 2048 },
  { fileID: 'cloud://env.a/b/v_1.mp4', type: 'video', size: 10 * 1024 * 1024 }
] }
const d2 = { id: '2', media: [
  { fileID: 'cloud://env.a/b/i_1.jpg', type: 'image', size: 2048 },          // 与 d1 重复 → 去重
  { fileID: 'https://x/img.png', type: 'image' },                            // 非云 fileID → 不收
  { fileID: '', type: 'video' },                                             // 空 → 不收
  { type: 'image' }                                                          // 无 fileID → 不收
] }
const collected = mg.collectFileIDs([d1, d2])
assert('收集去重后数量', collected.length, 2)
assert('收集内容正确', collected.indexOf('cloud://env.a/b/i_1.jpg') !== -1 && collected.indexOf('cloud://env.a/b/v_1.mp4') !== -1, true)
assert('单对象收集', mg.collectFileIDs(d1).length, 2)
assert('无媒体返回空', mg.collectFileIDs([]).length, 0)

// sumMediaBytes：只加有 size 的正数
assert('媒体字节汇总', mg.sumMediaBytes(d1.media), 2048 + 10 * 1024 * 1024)
assert('缺 size 旧数据按 0', mg.sumMediaBytes([{ fileID: 'cloud://a' }, { fileID: 'cloud://b', size: -1 }, { fileID: 'cloud://c', size: 100 }]), 100)

// ===== 5. 编辑保存差集清理（computeRemovedFiles）=====
// 场景：编辑旧日记，移除 b.jpg/v.mp4，新增 new_keep/new_gone（new_gone 又被移除），a.jpg 与新传保留
const originMedia = [
  { fileID: 'cloud://env.a/b/i_keep.jpg', type: 'image', size: 1024 },           // 保留
  { fileID: 'cloud://env.a/b/i_gone.jpg', type: 'image', size: 2048 },           // 被移除 → 清理
  { fileID: 'cloud://env.a/b/v_gone.mp4', type: 'video', size: 5 * 1024 * 1024 },// 被移除 → 清理
  { fileID: 'https://x/old.png', type: 'image', size: 888 },                     // 非云引用不可能被移除（仅测试防护）
  { fileID: '', type: 'image', size: 1 }
]
const sessionUploaded = [
  { fileID: 'cloud://env.a/b/new_keep.jpg', type: 'image', size: 4096 },   // 新传且保留
  { fileID: 'cloud://env.a/b/new_gone.jpg', type: 'image', size: 8192 }    // 新传又移除 → 清理
]
const finalMedia = [
  { fileID: 'cloud://env.a/b/i_keep.jpg', type: 'image', size: 1024 },
  { fileID: 'cloud://env.a/b/new_keep.jpg', type: 'image', size: 4096 }
]
const removedFiles = mg.computeRemovedFiles(originMedia, sessionUploaded, finalMedia)
assert('差集清理数量(2旧+1新传)', removedFiles.length, 3)
assert('差集含被移除旧媒体', removedFiles.some(m => m.fileID === 'cloud://env.a/b/i_gone.jpg') && removedFiles.some(m => m.fileID === 'cloud://env.a/b/v_gone.mp4'), true)
assert('差集含新传未保留', removedFiles.some(m => m.fileID === 'cloud://env.a/b/new_gone.jpg'), true)
assert('差集不含保留项', !removedFiles.some(m => m.fileID === 'cloud://env.a/b/i_keep.jpg' || m.fileID === 'cloud://env.a/b/new_keep.jpg'), true)
assert('差集保留 size 供扣减', removedFiles.reduce((s, m) => s + m.size, 0), 2048 + 5 * 1024 * 1024 + 8192)
assert('无增删差集为空', mg.computeRemovedFiles(originMedia, sessionUploaded, originMedia.concat(sessionUploaded)).length, 0)
assert('无会话上传只清被移除旧媒体', mg.computeRemovedFiles(originMedia, [], finalMedia.slice(0, 1)).length, 2)
assert('缺省入参不抛错', mg.computeRemovedFiles(null, null, null).length, 0)

// ===== 5.5 视频封面（thumb）随主文件收集/统计/差集清理 =====
const vKeep = { fileID: 'cloud://env.a/b/v_keep.mp4', type: 'video', size: 5 * 1024 * 1024, thumb: 'cloud://env.a/b/t_keep.jpg', thumbSize: 30 * 1024 }
const vGone = { fileID: 'cloud://env.a/b/v_gone.mp4', type: 'video', size: 6 * 1024 * 1024, thumb: 'cloud://env.a/b/t_gone.jpg', thumbSize: 40 * 1024 }
const dCover = { id: 'c1', media: [vKeep, vGone] }
const coverCollected = mg.collectFileIDs(dCover)
assert('收集含视频主文件与封面', coverCollected.length, 4)
assert('封面 fileID 入收集', coverCollected.indexOf('cloud://env.a/b/t_keep.jpg') !== -1 && coverCollected.indexOf('cloud://env.a/b/t_gone.jpg') !== -1, true)
assert('媒体字节汇总含封面', mg.sumMediaBytes(dCover.media), 5 * 1024 * 1024 + 30 * 1024 + 6 * 1024 * 1024 + 40 * 1024)
assert('无封面视频不重复收集', mg.collectFileIDs([{ media: [{ fileID: 'cloud://env.a/b/v.mp4', type: 'video', size: 1, thumb: '/tmp/local.jpg' }] }]).length, 1)
assert('本地 thumb 不入汇总', mg.sumMediaBytes([{ fileID: 'cloud://env.a/b/v.mp4', type: 'video', size: 100, thumb: '/tmp/local.jpg', thumbSize: 999 }]), 100)

// 编辑差集：保留视频 → 封面不清理
const removedCoverKeep = mg.computeRemovedFiles([vKeep, vGone], [], [vKeep])
assert('移除视频封面一并入清理', removedCoverKeep.length, 2)
assert('保留视频封面不清理', removedCoverKeep.some(m => m.fileID === 'cloud://env.a/b/t_keep.jpg'), false)
const removedCoverBoth = mg.computeRemovedFiles([vKeep, vGone], [], [])
assert('两视频及封面全清理', removedCoverBoth.length, 4)
// 会话上传含封面的新视频被移除 → 主文件+封面都清理
const removedSessionCover = mg.computeRemovedFiles([], [{ fileID: 'cloud://env.a/b/new.mp4', type: 'video', size: 1, thumb: 'cloud://env.a/b/new_t.jpg', thumbSize: 2 }], [])
assert('会话新传视频移除封面一并清', removedSessionCover.length, 2)

// ===== 6. 批量云删除 / deleteMediaItems =====
reset()
mg.deleteCloudFiles([]).then((res) => {
  assert('空列表直接成功', JSON.stringify(res), JSON.stringify({ deleted: 0, failed: 0, total: 0 }))
  return mg.deleteCloudFiles(['https://not-cloud/x.jpg'])
}).then((res) => {
  assert('非云 fileID 不入队', JSON.stringify(res), JSON.stringify({ deleted: 0, failed: 0, total: 0 }))
  const ids = []
  for (let i = 0; i < 51; i++) ids.push('cloud://env.a/x_' + i + '.jpg')
  return mg.deleteCloudFiles(ids)
}).then((res) => {
  assert('51 个文件全删成功', res.deleted, 51)
  assert('51 个自动分 2 批', cloudCalls.length, 2)
  assert('每批不超过 50', cloudCalls.every(b => b.length <= 50), true)
  assert('总数 51', res.total, 51)
  cloudFailSet = ['cloud://env.a/x_2.jpg']
  return mg.deleteCloudFiles(['cloud://env.a/x_1.jpg', 'cloud://env.a/x_2.jpg'])
}).then((res) => {
  assert('部分失败计数', res.deleted, 1)
  assert('失败数正确', res.failed, 1)
  cloudFailSet = null
  return mg.deleteCloudFiles(['cloud://env.a/x_1.jpg', 'cloud://env.a/x_2.jpg'])
}).then((res) => {
  assert('失败恢复后全删成功', res.deleted, 2)
  // deleteMediaItems：扣减用量后再云删
  reset()
  mg.addMediaUsage(2048 + 6 * 1024 * 1024)
  return mg.deleteMediaItems([
    { fileID: 'cloud://env.a/x_1.jpg', size: 2048 },
    { fileID: 'cloud://env.a/v_1.mp4', size: 6 * 1024 * 1024 },
    { fileID: 'cloud://env.a/x_1.jpg', size: 2048 },   // 重复 → 去重
    { fileID: 'https://x/a.png', size: 999 }           // 非云 → 不入队
  ])
}).then((res) => {
  assert('deleteMediaItems 删 2 个', res.deleted, 2)
  assert('deleteMediaItems 同步扣减用量', mg.getMediaUsage(), 0)
  assert('deleteMediaItems 只调一次云删', cloudCalls.length, 1)
  return mg.deleteMediaItems([])
}).then((res) => {
  assert('deleteMediaItems 空输入', JSON.stringify(res), JSON.stringify({ deleted: 0, failed: 0, total: 0 }))
  return mg.deleteMediaItems([{ fileID: 'https://x/only.png', size: 100 }])
}).then((res) => {
  assert('deleteMediaItems 全非云不入队', JSON.stringify(res), JSON.stringify({ deleted: 0, failed: 0, total: 0 }))
  // 视频封面随主文件一并删除并扣减用量
  reset()
  mg.addMediaUsage(6 * 1024 * 1024 + 40 * 1024)
  return mg.deleteMediaItems([
    { fileID: 'cloud://env.a/v_cover.mp4', type: 'video', size: 6 * 1024 * 1024, thumb: 'cloud://env.a/t_cover.jpg', thumbSize: 40 * 1024 }
  ])
}).then((res) => {
  assert('deleteMediaItems 封面随主文件删除', res.deleted, 2)
  assert('封面删除同步扣减用量', mg.getMediaUsage(), 0)
  reset()
  global.wx.cloud = null
  return mg.deleteCloudFiles(['cloud://env.a/x.jpg'])
}).then((res) => {
  assert('无云环境降级不抛错', res.skipped, true)
  return mg.deleteMediaItems([{ fileID: 'cloud://env.a/x.jpg', size: 100 }])
}).then((res) => {
  assert('deleteMediaItems 无云环境降级', res.skipped, true)
  console.log('\n---\n通过 ' + passCount + ' / 失败 ' + failCount)
  process.exit(failCount ? 1 : 0)
}).catch((e) => {
  console.log('\n---\n运行异常：' + e.message)
  process.exit(1)
})
