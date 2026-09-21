/**
 * utils/backup.js — 可选云端加密备份（微信云开发版，2026-09-17 迁移自 Railway diary-server）
 *
 * 隐私模型（零知识，不变）：
 *   - 默认不上传任何数据；开启备份是用户主动行为
 *   - 备份密码只存在于用户脑中：密码 + 随机盐 → PBKDF2 派生 AES-256 密钥（全程在本机）
 *   - 明文日记永远不出设备：上传前完成 AES-256-CBC 加密，云端只存「密文 + 盐 + 校验器」
 *   - 校验器 = SHA256(密钥 + 固定标签)，用于换设备时校验密码，无法反推密码/密钥/原文
 *   - 换新手机：登录同一微信 → 同一 openid → 拉取密文 → 输入备份密码 → 本地解密恢复
 *   - 清空云端：删除 meta 记录 + 云存储文件，物理删除
 *
 * 云端存储布局（无需云函数，客户端直读直写）：
 *   - 云数据库集合 backup_meta（权限：仅创建者可读写）：
 *       { salt, verifier, itemCount, fileID, payloadSize, updatedAt,
 *         versions: [{ fileID, at, itemCount, payloadSize }, ...] }
 *     「仅创建者可读写」权限下，客户端读写自动按 _openid 隔离，换手机同一微信即同一身份
 *   - 云存储 backups/<metaId>/snapshot-<时间戳>-<随机后缀>.dat：密文全文（AES 密文 base64 文本）
 *   - 多版本快照（2026-09-17 起）：每次同步追加一版，云端保留最近 MAX_VERSIONS 份，
 *     超出才删最旧。旧版本不被覆盖 → 改坏了可以回到某个时间点（备份页可选版本恢复）
 *   - 兼容旧数据：meta 只有 fileID 没有 versions 时，视为「1 个版本」
 *
 * 覆盖护栏（2026-09-18，重要）：
 *   enable(password, opts) 在云端已有备份时会清空全部历史版本（旧密文只有旧密码能解，无法沿用）。
 *   该「清空重建」属破坏性动作，故必须由页面在用户确认后显式传 opts.allowOverwrite=true 才放行；
 *   缺省一律 reject（err.code === 'CLOUD_EXISTS'，且此时尚未上传任何密文）。
 *   新增任何调用 enable 的入口（页面/流程）都必须先做覆盖确认，否则会是「保存失败」而非静默丢数据。
 *
 * 导出（在旧版基础上新增 listVersions）：
 *   isEnabled / getState / hasSavedKey / enable / reenable / sync /
 *   getLastSyncError / restore / cloudStatus / listVersions / adoptCloud / clearCloud / disable
 */

const crypto = require('./crypto.js')

const STATE_KEY = 'cloud_backup_state'
const VERIFIER_TAG = 'ai-diary-backup-verify'
const META_COLL = 'backup_meta'
const SNAPSHOT_PREFIX = 'backups/'
const TMP_FILE = '/yidengji-backup-snapshot.tmp'
const MAX_VERSIONS = 5 // 云端保留的历史快照份数（超出自动删最旧；供「改坏了回滚」用）
const SYNCED_KEY = 'backup_synced_count' // 最近一次成功云备份时的日记总篇数 [backup-remind v1]

// ===== 本地状态 =====

function getState() {
  try {
    return wx.getStorageSync(STATE_KEY) || null
  } catch (e) {
    return null
  }
}

function saveState(state) {
  try {
    if (state) wx.setStorageSync(STATE_KEY, state)
    else wx.removeStorageSync(STATE_KEY)
  } catch (e) { /* 忽略 */ }
}

function isEnabled() {
  const s = getState()
  return !!(s && s.enabled && s.key)
}

// ===== 云开发基础封装 =====

function cloudDb() {
  return wx.cloud.database()
}

/** 把云开发英文错误转成简短中文（UI toast 直接可读） */
function cloudErr(e, fallback) {
  const msg = (e && (e.errMsg || e.message)) || ''
  if (msg.indexOf('permission') >= 0 || msg.indexOf('Permission') >= 0) {
    return '云端权限未开通：请在云开发控制台创建 backup_meta 集合（仅创建者可读写）'
  }
  if (msg.indexOf('collection') >= 0 && msg.indexOf('not') >= 0) {
    return '云端集合不存在：请在云开发控制台创建 backup_meta 集合'
  }
  if (msg.indexOf('timeout') >= 0 || msg.indexOf('Timeout') >= 0) {
    return '网络超时，请稍后重试'
  }
  // 兜底分支必须带出真实错误码/信息（2026-09-17 实机报「密文上传失败」无法定位，就是在这里被吞了）
  const code = e && e.errCode !== undefined && e.errCode !== null ? 'errCode=' + e.errCode : ''
  const raw = String(msg || code || '').slice(-70)
  return (fallback || '云端操作失败，请稍后重试') + (raw ? '（' + raw + '）' : '')
}

/**
 * 查询当前用户的 meta 记录（「仅创建者可读写」权限自动按 _openid 过滤）
 * @returns {Promise<object|null>} doc 或 null
 */
function getMeta() {
  return cloudDb()
    .collection(META_COLL)
    .limit(1)
    .get()
    .then((res) => (res.data && res.data.length ? res.data[0] : null))
    .catch((e) => {
      throw new Error(cloudErr(e))
    })
}

/**
 * 确保存在 meta 记录：有则复用，无则新建（首次开启）
 * @returns {Promise<object>} doc（必有 _id）
 */
function ensureMeta() {
  return getMeta().then((meta) => {
    if (meta) return meta
    return cloudDb()
      .collection(META_COLL)
      .add({
        data: {
          salt: '',
          verifier: '',
          itemCount: 0,
          fileID: '',
          payloadSize: 0,
          updatedAt: '',
          versions: []
        }
      })
      .then((res) => {
        return { _id: res._id, salt: '', verifier: '', itemCount: 0, fileID: '', payloadSize: 0, updatedAt: '', versions: [] }
      })
      .catch((e) => {
        throw new Error(cloudErr(e))
      })
  })
}

/** 更新 meta（仅创建者可读写 → 可直接 update 自己的 doc） */
function updateMeta(metaId, patch) {
  return cloudDb()
    .collection(META_COLL)
    .doc(metaId)
    .update({ data: Object.assign({ updatedAt: new Date().toISOString() }, patch) })
    .catch((e) => {
      throw new Error(cloudErr(e))
    })
}

/** 删除 meta 记录 */
function removeMeta(metaId) {
  return cloudDb()
    .collection(META_COLL)
    .doc(metaId)
    .remove()
    .catch((e) => {
      throw new Error(cloudErr(e))
    })
}
// ===== 版本列表（多版本快照）=====

/**
 * 读取 meta 的版本列表（最新在前）。
 * 兼容旧结构：没有任何 versions 但存在 fileID 时，把它当作「1 个版本」。
 * @returns {Array<{fileID:string, at:string, itemCount:number, payloadSize:number}>}
 */
function metaVersions(meta) {
  const list = (meta && Array.isArray(meta.versions))
    ? meta.versions.filter((v) => v && typeof v.fileID === 'string' && v.fileID.length > 0)
    : []
  if (list.length) return list
  if (meta && meta.fileID) {
    return [{
      fileID: String(meta.fileID),
      at: meta.updatedAt || '',
      itemCount: meta.itemCount || 0,
      payloadSize: meta.payloadSize || 0
    }]
  }
  return []
}

/**
 * 把新版本并入列表头部，并按 MAX_VERSIONS 截断。
 * @param {Array} prev 既有版本列表（最新在前）
 * @param {object} entry 新版本 { fileID, at, itemCount, payloadSize }
 * @returns {{versions:Array, dropped:Array}} dropped 为超出上限、待清理的最旧版本
 */
function pushVersion(prev, entry) {
  const list = [entry].concat(prev || [])
  return { versions: list.slice(0, MAX_VERSIONS), dropped: list.slice(MAX_VERSIONS) }
}

/** 批量删除一批版本对应的云存储文件（容忍失败，不阻断主流程） */
function deleteVersions(versionList) {
  return (versionList || []).reduce((chain, v) => {
    return chain.then(() => deleteSnapshot(v && v.fileID))
  }, Promise.resolve())
}

/** 把内存中的密文字符串写到本地临时文件 */
function writeTmpFile(content) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: wx.env.USER_DATA_PATH + TMP_FILE,
      data: content,
      encoding: 'utf8',
      success: () => resolve(),
      fail: (e) => reject(new Error('本地临时文件写入失败：' + ((e && e.errMsg) || '')))
    })
  })
}

/** 读取下载到本地的临时文件内容 */
function readTmpFile(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'utf8',
      success: (res) => resolve(String(res.data || '')),
      fail: (e) => reject(new Error('本地临时文件读取失败：' + ((e && e.errMsg) || '')))
    })
  })
}

/**
 * 上传密文快照到云存储（路径含时间戳 + 随机后缀，避免同毫秒同名互相覆盖；
 * 落库后由调用方按版本上限清理最旧，或按场景删除全部旧版本）
 * @returns {Promise<string>} fileID
 */
function uploadSnapshot(metaId, ciphertext) {
  const cloudPath = SNAPSHOT_PREFIX + metaId + '/snapshot-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6) + '.dat'
  return writeTmpFile(ciphertext).then(() => {
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: wx.env.USER_DATA_PATH + TMP_FILE,
        success: (res) => resolve(res.fileID),
        fail: (e) => {
          console.error('[backup] uploadFile fail', e) // 连开发者工具时可在控制台看全量错误
          reject(new Error(cloudErr(e, '密文上传失败，请检查网络后重试')))
        }
      })
    })
  })
}

/** 从云存储拉取密文（换机恢复用） */
function downloadSnapshot(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID: fileID,
      success: (res) => resolve(res.tempFilePath),
      fail: (e) => reject(new Error(cloudErr(e, '密文下载失败，请检查网络后重试')))
    })
  }).then((tempFilePath) => readTmpFile(tempFilePath))
}

/** 删除云存储文件（容忍失败：删除失败不阻断主流程） */
function deleteSnapshot(fileID) {
  if (!fileID) return Promise.resolve()
  return new Promise((resolve) => {
    wx.cloud.deleteFile({
      fileList: [fileID],
      success: () => resolve(),
      fail: () => resolve()
    })
  })
}

// ===== 数据打包与加密 =====

// 备份内容：全部日记 + 档案（都是加密后整体上传）
function buildPayload() {
  const storage = require('./storage.js')
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    diaries: storage.getAllDiaries(),
    archives: storage.getArchives()
  }
}

// 校验器：SHA256(key || tag)，密码正确时可复现
function makeVerifier(keyBytes) {
  return crypto.sha256Hex(new Uint8Array([...keyBytes, ...crypto.utf8Encode(VERIFIER_TAG)]))
}

// 用指定密钥加密当前数据
function encryptWithKey(keyBytes) {
  const payload = buildPayload()
  const ciphertext = crypto.encryptToBase64(JSON.stringify(payload), keyBytes)
  return {
    ciphertext: ciphertext,
    itemCount: (payload.diaries || []).length,
    archiveCount: (payload.archives || []).length
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

// ===== 同步失败留痕（备份页红字提示）=====

/** 记录最近一次同步失败（自动/手动共用；下一次同步成功自动清除） */
function markAutoSyncFailed(err) {
  const state = getState()
  if (!state || !state.enabled) return
  const msg = (err && err.message) || '网络异常，请稍后重试'
  saveState(Object.assign({}, state, {
    lastSyncError: { at: new Date().toISOString(), message: String(msg).slice(0, 60) }
  }))
}

/** 最近一次同步失败信息（无失败记录返回 null）：{ at: ISO时间, message: 原因 } */
function getLastSyncError() {
  const s = getState()
  return (s && s.lastSyncError) || null
}

// ===== 开启备份（首次全量上传）=====

/**
 * 开启云端备份：设置备份密码 → 本地派生密钥 → 加密全量上传
 *
 * 防误覆盖（2026-09-18）：云端已有备份时本函数会清空其全部历史版本 —— 这是设计使然
 * （旧密文只有旧密码能解开），但必须由调用方显式传 allowOverwrite 才放行，否则一律拒绝。
 * 宁可让保存失败（用户看到「云端已有备份」的提示），也不能在他不知情时静默清空云端备份。
 * @param {string} password 备份密码（>= 6 位）
 * @param {{allowOverwrite?:boolean}} [opts] allowOverwrite=true 表示「用户已在页面上确认覆盖」
 * @returns {Promise<{itemCount:number, archiveCount:number}>}
 */
function enable(password, opts) {
  const pwd = String(password || '')
  if (pwd.length < 6) {
    return Promise.reject(new Error('备份密码至少 6 位'))
  }
  const allowOverwrite = !!(opts && opts.allowOverwrite)
  const salt = crypto.randomBytes(16)
  const key = crypto.pbkdf2(pwd, salt, crypto.ITERATIONS, 32)
  const verifier = makeVerifier(key)
  const enc = encryptWithKey(key)

  return ensureMeta().then((meta) => {
    // 开启场景：本次是用「新密码」建立备份（无本地密钥才会走到 enable），
    // 旧版本是用旧密钥加密的、当前已无人能解开 → 清空历史版本，从第 1 版重建。
    const oldVersions = metaVersions(meta)
    // 覆盖护栏（兜底，2026-09-18）：调用方漏判时在这里拦下 —— 注意此刻还没上传任何密文，
    // 抛错即中止，云端 meta 与历史快照原样不动。
    if (oldVersions.length && !allowOverwrite) {
      const err = new Error('云端已有备份，需确认后才能覆盖')
      err.code = 'CLOUD_EXISTS'
      throw err
    }
    return uploadSnapshot(meta._id, enc.ciphertext).then((fileID) => {
      const now = new Date().toISOString()
      const patch = {
        salt: crypto.bytesToHex(salt),
        verifier: verifier,
        itemCount: enc.itemCount,
        fileID: fileID,
        payloadSize: enc.ciphertext.length,
        versions: [{ fileID: fileID, at: now, itemCount: enc.itemCount, payloadSize: enc.ciphertext.length }]
      }
      return updateMeta(meta._id, patch).then(() => {
        // 清理所有旧版本文件（保留刚上传的这一版）
        return deleteVersions(oldVersions.filter((v) => v.fileID !== fileID))
      }).then(() => {
        saveState({
          enabled: true,
          salt: patch.salt,
          key: crypto.bytesToBase64(key),
          verifier: verifier,
          metaId: meta._id,
          fileID: fileID,
          lastSyncAt: new Date().toISOString(),
          lastCount: enc.itemCount
        })
        markSyncedCount(enc.itemCount)
        return enc
      })
    })
  })
}

// ===== 同步（开启后每次日记变动自动触发，防抖由 storage 层控制）=====

/**
 * 增量全量同步：把当前全部数据加密后覆盖上传（开启备份才执行）
 * @returns {Promise<{itemCount:number}|null>} 未开启返回 null
 */
function sync() {
  const state = getState()
  if (!state || !state.enabled || !state.key) return Promise.resolve(null)
  let keyBytes
  try {
    keyBytes = crypto.base64ToBytes(state.key)
    if (keyBytes.length !== 32) throw new Error('bad key')
  } catch (e) {
    return Promise.reject(new Error('本地密钥损坏，请关闭备份后重新开启'))
  }
  const enc = encryptWithKey(keyBytes)
  return ensureMeta().then((meta) => {
    const prevVersions = metaVersions(meta) // 旧版本一律保留（多版本快照：供回滚）
    return uploadSnapshot(meta._id, enc.ciphertext).then((fileID) => {
      const entry = {
        fileID: fileID,
        at: new Date().toISOString(),
        itemCount: enc.itemCount,
        payloadSize: enc.ciphertext.length
      }
      const pushed = pushVersion(prevVersions, entry)
      return updateMeta(meta._id, {
        salt: state.salt,
        verifier: state.verifier,
        itemCount: enc.itemCount,
        fileID: fileID,
        payloadSize: enc.ciphertext.length,
        versions: pushed.versions
      }).then(() => {
        // 只清理超出保留上限的最旧版本；旧版本不再被覆盖删除
        return deleteVersions(pushed.dropped)
      }).then(() => {
        saveState(Object.assign({}, state, {
          metaId: meta._id,
          fileID: fileID,
          lastSyncAt: new Date().toISOString(),
          lastCount: enc.itemCount,
          lastSyncError: null // 同步成功：清除失败提示
        }))
        markSyncedCount(enc.itemCount)
        return enc
      })
    })
  }).catch((e) => {
    markAutoSyncFailed(e) // 记录失败（自动同步在 storage 层被静默吞掉，这里兜底留痕供备份页提示）
    throw e
  })
}

// ===== 从云端恢复（换设备 / 误删找回）=====

/**
 * 拉取云端密文 → 输入密码本地解密
 * @param {string} password 备份密码
 * @param {number} [versionIndex] 历史版本序号（0 = 最新，1 = 上一版…）；缺省取最新
 * @returns {Promise<{diaries:Array, archives:Array, itemCount:number, exportedAt:string, versionAt:string, versionIndex:number}>}
 */
function restore(password, versionIndex) {
  const pwd = String(password || '')
  if (!pwd) return Promise.reject(new Error('请输入备份密码'))
  const idx = (typeof versionIndex === 'number' && versionIndex >= 0) ? Math.floor(versionIndex) : 0

  return getMeta().then((meta) => {
    const versions = metaVersions(meta)
    if (!meta || !versions.length || !meta.salt || !meta.verifier) {
      throw new Error('云端没有备份数据')
    }
    const actualIdx = versions[idx] ? idx : 0 // 序号越界 → 回退到最新版
    const target = versions[actualIdx]
    // 本地重建密钥（密码 + 云端盐；密码不匹配时校验器对不上）
    const saltBytes = hexToBytes(String(meta.salt))
    const key = crypto.pbkdf2(pwd, saltBytes, crypto.ITERATIONS, 32)
    if (makeVerifier(key) !== meta.verifier) {
      throw new Error('备份密码不正确')
    }
    return downloadSnapshot(target.fileID).then((ciphertext) => {
      let payload
      try {
        payload = JSON.parse(crypto.decryptFromBase64(ciphertext, key))
      } catch (e) {
        throw new Error('解密失败：云端数据可能已损坏')
      }
      return {
        diaries: payload.diaries || [],
        archives: payload.archives || [],
        itemCount: (payload.diaries || []).length,
        exportedAt: payload.exported_at || '',
        versionAt: target.at || '',
        versionIndex: actualIdx
      }
    })
  })
}

/**
 * 接上云端已有备份（换机 / 卸载重装后恢复完成、想继续自动同步）：
 * 用「原备份密码」校验云端 verifier，通过后把该密钥写回本地状态并开启自动备份。
 * 只改本地状态，不上传、不重建 —— 云端已有密文与历史版本原样保留。
 * @param {string} password 原备份密码
 * @returns {Promise<{itemCount:number}>}
 */
function adoptCloud(password) {
  const pwd = String(password || '')
  if (!pwd) return Promise.reject(new Error('请输入备份密码'))
  return getMeta().then((meta) => {
    const versions = metaVersions(meta)
    if (!meta || !versions.length || !meta.salt || !meta.verifier) {
      throw new Error('云端没有备份数据')
    }
    const saltBytes = hexToBytes(String(meta.salt))
    const key = crypto.pbkdf2(pwd, saltBytes, crypto.ITERATIONS, 32)
    if (makeVerifier(key) !== meta.verifier) {
      throw new Error('备份密码不正确')
    }
    const latest = versions[0]
    saveState({
      enabled: true,
      salt: String(meta.salt),
      key: crypto.bytesToBase64(key),
      verifier: String(meta.verifier),
      metaId: meta._id,
      fileID: latest.fileID,
      lastSyncAt: latest.at || new Date().toISOString(),
      lastCount: latest.itemCount || 0
    })
    markSyncedCount(latest.itemCount || 0)
    return { itemCount: latest.itemCount || 0 }
  })
}

// ===== 云端状态查询（未开启也安全）=====

/**
 * 查询云端是否有备份（换设备检测用）
 * @returns {Promise<{exists:boolean, itemCount?:number, updatedAt?:string, versionCount?:number}>}
 */
function cloudStatus() {
  return getMeta().then((meta) => {
    const versions = metaVersions(meta)
    if (!meta || !versions.length) return { exists: false }
    return {
      exists: true,
      itemCount: meta.itemCount || 0,
      updatedAt: meta.updatedAt || '',
      versionCount: versions.length
    }
  })
}

/**
 * 云端历史版本列表（最新在前），供备份页展示与选择恢复。
 * 不含任何日记内容，只有时间 / 篇数 / 密文大小（元数据）。
 * @returns {Promise<Array<{index:number, at:string, itemCount:number, payloadSize:number}>>}
 */
function listVersions() {
  return getMeta().then((meta) => {
    return metaVersions(meta).map((v, i) => ({
      index: i,
      at: v.at || '',
      itemCount: v.itemCount || 0,
      payloadSize: v.payloadSize || 0
    }))
  })
}

// ===== 关闭与清空 =====

/** 本地是否还保存着备份密钥（关闭云端备份后仍保留，用于重新开启时校验密码续用云端数据） */
function hasSavedKey() {
  const s = getState()
  return !!(s && s.key && s.salt && s.verifier)
}

/** 关闭云端备份：仅停止自动同步，云端备份数据与本地密钥都保留 */
function disable() {
  const state = getState()
  if (state) saveState(Object.assign({}, state, { enabled: false }))
}

/**
 * 重新开启自动备份：用原密码校验本地保存的密钥，一致则复用原密钥（云端数据延续），并立即同步一次
 * @param {string} password 原备份密码
 * @returns {Promise<{itemCount:number, archiveCount:number}>}
 */
function reenable(password) {
  const state = getState()
  if (!state || !state.key || !state.salt || !state.verifier) {
    return Promise.reject(new Error('没有已保存的备份密钥，请按新备份设置'))
  }
  const saltBytes = hexToBytes(String(state.salt))
  const key = crypto.pbkdf2(String(password || ''), saltBytes, crypto.ITERATIONS, 32)
  if (makeVerifier(key) !== state.verifier) {
    return Promise.reject(new Error('密码与原备份不一致'))
  }
  saveState(Object.assign({}, state, { enabled: true }))
  return sync()
}

/** 一键清空云端全部备份数据（删除 meta 记录 + 全部历史版本密文文件；本地备份状态保留，下次改动会重新上传） */
function clearCloud() {
  return getMeta().then((meta) => {
    if (!meta) return
    const versions = metaVersions(meta)
    return deleteVersions(versions).then(() => {
      return removeMeta(meta._id)
    })
  })
}

// ===== 未备份提醒辅助（storage 层 remindBackupIfNeeded 使用）[backup-remind v1] =====

/**
 * 记录「最近一次成功云备份时的日记总篇数」
 *
 * [backup-remind v1] 档位必须**归零**：backup_alert_level 的语义是「已提醒到第几档未备份量」，
 * 而备份成功的这一刻未备份量正好归 0。原先写 Math.floor(n / 30)（把「已备份篇数」当档位），
 * 备份 65 篇后要把未备份量攒到 90 篇才再提醒，与「每满 30 篇提醒一次」的设计意图不符。
 */
function markSyncedCount(n) {
  try {
    if (typeof n !== 'number' || n < 0) return
    wx.setStorageSync(SYNCED_KEY, n)
    wx.setStorageSync('backup_alert_level', 0)
  } catch (e) { /* 忽略 */ }
}

/** 最近一次成功云备份时的日记总篇数（从未备份成功过返回 0） */
function getSyncedCount() {
  try { return wx.getStorageSync(SYNCED_KEY) || 0 } catch (e) { return 0 }
}

module.exports = {
  isEnabled: isEnabled,
  getState: getState,
  hasSavedKey: hasSavedKey,
  enable: enable,
  reenable: reenable,
  sync: sync,
  getLastSyncError: getLastSyncError,
  restore: restore,
  cloudStatus: cloudStatus,
  listVersions: listVersions,
  adoptCloud: adoptCloud,
  clearCloud: clearCloud,
  disable: disable,
  markSyncedCount: markSyncedCount,
  getSyncedCount: getSyncedCount
}
