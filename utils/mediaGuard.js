/**
 * utils/mediaGuard.js
 * 云端媒体管理（图片/视频上传与删除共用）：
 *   1. 视频限时：单段超过 30 秒拒收（云存储大头是长视频）
 *   2. 视频限体积：单段超过 25MB 拒收（避免超大原片直传）
 *   3. 存储用量估算：本地累计已上传字节（删除日记/编辑移除媒体并清理云端时会同步扣减
 *      所删媒体的 size，近似云存储真实占用），达到默认免费额度量级（5GB）的 80% 时弹窗提醒一次
 *   4. 删除日记自动清理云端媒体：上传成功会在媒体项记录 size，
 *      删除日记时收集 fileID 调 wx.cloud.deleteFile 批量删除，并同步扣减本地用量估算
 *   5. 编辑日记移除媒体「保存时才真删」：编辑会话内先只从编辑列表移除（不立即删云端，
 *      避免取消编辑导致日记引用的文件已删）；保存成功时用 computeRemovedFiles 算出
 *      「旧媒体中被移除的 ∪ 会话新增但未保留的」统一清理（deleteMediaItems）；
 *      取消编辑/放弃页面时用 deleteMediaItems 清理会话内未保存的新传文件
 *   注意：用量为估算值，精确数据以「微信云开发控制台-存储」为准。
 */

var MAX_VIDEO_SECONDS = 30
var MAX_VIDEO_SIZE_MB = 25
var MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024

var USAGE_KEY = 'media_usage_bytes'          // 累计已上传字节数（本地估算）
var ALERTED_KEY = 'media_usage_alerted'      // 是否已提醒过（只提醒一次）
var ALERT_THRESHOLD = 5 * 1024 * 1024 * 1024 * 0.8 // 5GB 额度的 80% = 4GB

/**
 * 校验一组待选媒体：
 * @param {Array<{fileType:string, duration?:number, size?:number}>} files
 * @returns {{pass:Array, tooLong:number, tooBig:number}}
 *   pass 为通过校验的文件（图片恒通过；视频超限剔除）
 */
function guard(files) {
  const pass = []
  let tooLong = 0
  let tooBig = 0
  for (const f of files || []) {
    if (f && f.fileType === 'video') {
      const dur = Math.round(f.duration || 0)
      const size = f.size || 0
      if (dur > MAX_VIDEO_SECONDS) { tooLong++; continue }
      if (size > MAX_VIDEO_SIZE_BYTES) { tooBig++; continue }
    }
    if (f) pass.push(f)
  }
  return { pass: pass, tooLong: tooLong, tooBig: tooBig }
}

// 超限提示文案（供调用方 toast）
function guardToast(tooLong, tooBig) {
  const msgs = []
  if (tooLong) msgs.push(tooLong + ' 个超 ' + MAX_VIDEO_SECONDS + ' 秒')
  if (tooBig) msgs.push(tooBig + ' 个超 ' + MAX_VIDEO_SIZE_MB + 'MB')
  return msgs.join('，') + '，已跳过'
}

// 读取本地临时文件的真实大小（字节）
function getFileSize(filePath) {
  return new Promise((resolve) => {
    if (!filePath) return resolve(0)
    try {
      wx.getFileInfo({
        filePath: filePath,
        success: (res) => resolve(res.size || 0),
        fail: () => resolve(0)
      })
    } catch (e) {
      resolve(0)
    }
  })
}

// 记录本次实际上传字节（估算），达到阈值提醒一次
function addMediaUsage(bytes) {
  bytes = Math.max(0, Math.round(bytes || 0))
  if (!bytes) return
  let total = 0
  try { total = wx.getStorageSync(USAGE_KEY) || 0 } catch (e) {}
  total += bytes
  try { wx.setStorageSync(USAGE_KEY, total) } catch (e) {}
  const alerted = (() => { try { return wx.getStorageSync(ALERTED_KEY) } catch (e) { return 0 } })()
  if (!alerted && total >= ALERT_THRESHOLD) {
    try { wx.setStorageSync(ALERTED_KEY, 1) } catch (e) {}
    const gb = (total / 1024 / 1024 / 1024).toFixed(1)
    wx.showModal({
      title: '云端存储用量提醒',
      content: '已上传约 ' + gb + 'GB（估算），接近免费额度（约 5GB）的 80%。\n建议到「微信云开发控制台 → 存储」查看精确用量；也可删除含视频的旧日记来控制占用。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
  return total
}

// 删除日记清理云端媒体后，从本地累计用量扣减对应字节（下限 0）
function subtractMediaUsage(bytes) {
  bytes = Math.max(0, Math.round(bytes || 0))
  if (!bytes) return 0
  let total = 0
  try { total = wx.getStorageSync(USAGE_KEY) || 0 } catch (e) {}
  total = Math.max(0, total - bytes)
  try { wx.setStorageSync(USAGE_KEY, total) } catch (e) {}
  return total
}

// 清空全部日记时，本地用量估算一并归零
function clearMediaUsage() {
  try { wx.setStorageSync(USAGE_KEY, 0) } catch (e) {}
}

// 当前估算用量（字节）
function getMediaUsage() {
  try { return wx.getStorageSync(USAGE_KEY) || 0 } catch (e) { return 0 }
}

/**
 * 汇总一组日记媒体项中记录的上传字节（用于删除后扣减估算）
 * @param {Array} mediaList 日记的 media 数组
 * @returns {number} 字节（无 size 的旧数据按 0 计，不影响删除本身）
 */
function sumMediaBytes(mediaList) {
  let total = 0
  ;(mediaList || []).forEach(m => {
    if (m && typeof m.size === 'number' && m.size > 0) total += m.size
  })
  return total
}

/**
 * 收集需清理的云文件 fileID（去重；仅收 cloud:// 开头，避免误删本地/导入媒体）
 * @param {Array|Object} diaries 单条日记或日记数组
 * @returns {Array<string>}
 */
function collectFileIDs(diaries) {
  const list = Array.isArray(diaries) ? diaries : [diaries]
  const seen = {}
  const out = []
  list.forEach(d => {
    ;(d && d.media || []).forEach(m => {
      const id = m && m.fileID
      if (id && typeof id === 'string' && id.indexOf('cloud://') === 0 && !seen[id]) {
        seen[id] = 1
        out.push(id)
      }
    })
  })
  return out
}

/**
 * 计算「编辑保存后应清理」的云端媒体项（编辑日记移除媒体/新增又移除时用）：
 *   旧媒体中被移除的 ∪ 本会话新增上传但最终未保留的。
 * 仅收 cloud:// 开头（避免误删本地/导入媒体），按 fileID 去重，保留 size 供用量扣减。
 * @param {Array} originMedia  进入编辑前的日记 media（保存前快照）
 * @param {Array} sessionUploaded 本次编辑会话内新上传的媒体项 {fileID,size,...}
 * @param {Array} finalMedia   保存结果的 media（不在其中的旧/会话文件将被清理）
 * @returns {Array<{fileID:string, type?:string, size:number}>}
 */
function computeRemovedFiles(originMedia, sessionUploaded, finalMedia) {
  const keep = {}
  ;(finalMedia || []).forEach(m => {
    const id = m && m.fileID
    if (id) keep[id] = 1
  })
  const out = []
  const seen = {}
  const scan = (list) => {
    ;(list || []).forEach(m => {
      const id = m && m.fileID
      if (!id || typeof id !== 'string' || id.indexOf('cloud://') !== 0 || seen[id] || keep[id]) return
      seen[id] = 1
      out.push({ fileID: id, type: m.type, size: (typeof m.size === 'number' && m.size > 0) ? m.size : 0 })
    })
  }
  scan(originMedia)
  scan(sessionUploaded)
  return out
}

/**
 * 删除一批媒体项（含 fileID/size）：先按 size 汇总扣减本地用量估算，再批量云删
 * @param {Array<{fileID:string, size?:number}>} items
 * @returns {Promise<{deleted:number, failed:number, total:number, skipped?:boolean}>}
 */
function deleteMediaItems(items) {
  const valid = computeRemovedFiles([], items, []) // 复用：全部视为「未保留」，仅收 cloud 且去重
  if (!valid.length) return Promise.resolve({ deleted: 0, failed: 0, total: 0 })
  const bytes = valid.reduce((s, m) => s + (m.size || 0), 0)
  if (bytes > 0) subtractMediaUsage(bytes)
  return deleteCloudFiles(valid.map(m => m.fileID))
}

/**
 * 批量删除云端媒体文件（微信云开发一次最多 50 个，自动分批）
 * @param {Array<string>} fileList
 * @returns {Promise<{deleted:number, failed:number, total:number, skipped?:boolean}>}
 */
function deleteCloudFiles(fileList) {
  const valid = []
  const seen = {}
  ;(fileList || []).forEach(id => {
    if (id && typeof id === 'string' && id.indexOf('cloud://') === 0 && !seen[id]) {
      seen[id] = 1
      valid.push(id)
    }
  })
  if (!valid.length) return Promise.resolve({ deleted: 0, failed: 0, total: 0 })
  if (!wx.cloud || !wx.cloud.deleteFile) {
    return Promise.resolve({ deleted: 0, failed: 0, total: valid.length, skipped: true })
  }
  const batches = []
  for (let i = 0; i < valid.length; i += 50) batches.push(valid.slice(i, i + 50))
  let deleted = 0
  return batches.reduce((chain, batch) => {
    return chain.then(() => new Promise((resolve) => {
      wx.cloud.deleteFile({
        fileList: batch,
        success: (res) => {
          ;(res.fileList || []).forEach(f => {
            if (f && f.status === 0) deleted++
          })
          resolve()
        },
        fail: () => resolve()
      })
    }))
  }, Promise.resolve()).then(() => {
    return { deleted: deleted, failed: valid.length - deleted, total: valid.length }
  })
}

module.exports = {
  MAX_VIDEO_SECONDS: MAX_VIDEO_SECONDS,
  MAX_VIDEO_SIZE_MB: MAX_VIDEO_SIZE_MB,
  guard: guard,
  guardToast: guardToast,
  getFileSize: getFileSize,
  addMediaUsage: addMediaUsage,
  subtractMediaUsage: subtractMediaUsage,
  clearMediaUsage: clearMediaUsage,
  getMediaUsage: getMediaUsage,
  sumMediaBytes: sumMediaBytes,
  collectFileIDs: collectFileIDs,
  computeRemovedFiles: computeRemovedFiles,
  deleteMediaItems: deleteMediaItems,
  deleteCloudFiles: deleteCloudFiles
}
