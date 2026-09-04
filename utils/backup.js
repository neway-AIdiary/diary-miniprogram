/**
 * utils/backup.js — 可选云端加密备份
 *
 * 隐私模型（零知识）：
 *   - 默认不上传任何数据；开启备份是用户主动行为
 *   - 备份密码只存在于用户脑中：密码 + 随机盐 → PBKDF2 派生 AES-256 密钥（全程在本机）
 *   - 明文日记永远不出设备：上传前完成 AES-256-CBC 加密，服务器只存「密文 + 盐 + 校验器」
 *   - 校验器 = SHA256(密钥 + 固定标签)，用于换设备时校验密码，无法反推密码/密钥/原文
 *   - 换新手机：登录同一微信账号 → 拉取密文 → 输入备份密码 → 本地解密恢复
 *   - 清空云端：DELETE 即物理删除，云端不留任何数据
 *   - 关闭云端备份：仅停止自动同步，云端已有备份保留，本地密钥保留（重新开启需校验原密码）
 */

const crypto = require('./crypto.js')
const api = require('./api.js')

const STATE_KEY = 'cloud_backup_state'
const VERIFIER_TAG = 'ai-diary-backup-verify'

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

// ===== 开启备份（首次全量上传）=====

/**
 * 开启云端备份：设置备份密码 → 本地派生密钥 → 加密全量上传
 * @param {string} password 备份密码（>= 6 位）
 * @returns {Promise<{itemCount:number, archiveCount:number}>}
 */
function enable(password) {
  const pwd = String(password || '')
  if (pwd.length < 6) {
    return Promise.reject(new Error('备份密码至少 6 位'))
  }
  const salt = crypto.randomBytes(16)
  const key = crypto.pbkdf2(pwd, salt, crypto.ITERATIONS, 32)
  const verifier = makeVerifier(key)
  const enc = encryptWithKey(key)

  return api.request('PUT', '/api/backup', {
    salt: crypto.bytesToHex(salt),
    verifier: verifier,
    ciphertext: enc.ciphertext,
    itemCount: enc.itemCount
  }, { silent: true }).then(() => {
    saveState({
      enabled: true,
      salt: crypto.bytesToHex(salt),
      key: crypto.bytesToBase64(key),
      verifier: verifier,
      lastSyncAt: new Date().toISOString(),
      lastCount: enc.itemCount
    })
    return enc
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
  return api.request('PUT', '/api/backup', {
    salt: state.salt,
    verifier: state.verifier,
    ciphertext: enc.ciphertext,
    itemCount: enc.itemCount
  }, { silent: true }).then(() => {
    saveState(Object.assign({}, state, {
      lastSyncAt: new Date().toISOString(),
      lastCount: enc.itemCount
    }))
    return enc
  })
}

// ===== 从云端恢复（换设备 / 误删找回）=====

/**
 * 拉取云端密文 → 输入密码本地解密
 * @param {string} password 备份密码
 * @returns {Promise<{diaries:Array, archives:Array, itemCount:number, exportedAt:string}>}
 */
function restore(password) {
  const pwd = String(password || '')
  if (!pwd) return Promise.reject(new Error('请输入备份密码'))

  return api.request('GET', '/api/backup', null, { silent: true }).then((data) => {
    if (!data || !data.exists) {
      throw new Error('云端没有备份数据')
    }
    // 本地重建密钥（密码 + 服务器返回的盐；密码不匹配时校验器对不上）
    const saltBytes = hexToBytes(String(data.salt || ''))
    const key = crypto.pbkdf2(pwd, saltBytes, crypto.ITERATIONS, 32)
    if (makeVerifier(key) !== data.verifier) {
      throw new Error('备份密码不正确')
    }
    let payload
    try {
      payload = JSON.parse(crypto.decryptFromBase64(data.ciphertext, key))
    } catch (e) {
      throw new Error('解密失败：云端数据可能已损坏')
    }
    return {
      diaries: payload.diaries || [],
      archives: payload.archives || [],
      itemCount: (payload.diaries || []).length,
      exportedAt: payload.exported_at || ''
    }
  })
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

// ===== 云端状态查询（未登录/未开启也安全）=====

/**
 * 查询云端是否有备份（换设备检测用）
 * @returns {Promise<{exists:boolean, itemCount?:number, updatedAt?:string}>}
 */
function cloudStatus() {
  return api.request('GET', '/api/backup', null, { silent: true }).then((data) => {
    if (!data || !data.exists) return { exists: false }
    return {
      exists: true,
      itemCount: data.itemCount || 0,
      updatedAt: data.updatedAt || ''
    }
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

/** 一键清空云端全部备份数据（物理删除；本地备份状态保留，下次改动会重新上传） */
function clearCloud() {
  return api.request('DELETE', '/api/backup', null, { silent: true })
}

module.exports = {
  isEnabled: isEnabled,
  getState: getState,
  hasSavedKey: hasSavedKey,
  enable: enable,
  reenable: reenable,
  sync: sync,
  restore: restore,
  cloudStatus: cloudStatus,
  clearCloud: clearCloud,
  disable: disable
}
