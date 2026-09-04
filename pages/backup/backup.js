const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const backup = require('../../utils/backup.js')
const app = getApp()

Page({
  data: {
    // 云端备份状态
    backupEnabled: false,
    backupHint: '',
    // 备份密码弹框
    backupModalShow: false,
    backupMode: 'enable',   // 'enable' | 'restore'
    reenableMode: false,    // 重新开启（本地密钥还在，校验原密码续用）：只输一次密码
    pwd1: '',
    pwd2: '',
    // 清空云端备份确认弹层
    confirmClearShow: false,
    // 关闭云端备份确认弹层
    confirmDisableShow: false
  },

  onShow() {
    this.loadData()
  },

  loadData() {
    const state = backup.getState()
    let backupHint = ''
    if (state && state.enabled) {
      const last = state.lastSyncAt ? util.formatDate(state.lastSyncAt) : ''
      backupHint = '已开启 · 上次备份 ' + (state.lastCount || 0) + ' 篇' + (last ? '（' + last + '）' : '') + ' · 日记改动后自动同步\n明文永不上传，服务器只存加密密文'
    } else if (backup.hasSavedKey()) {
      // 已关闭云端备份但本地密钥还在，云端仍有历史备份：重新开启可续用
      backupHint = '自动备份已关闭；云端仍有历史备份，重新开启后继续同步\n明文永不上传，服务器只存加密密文'
    } else {
      backupHint = '默认只存在本机，不上传任何数据；开启后仅上传 AES 加密密文'
    }

    this.setData({
      backupEnabled: backup.isEnabled(),
      backupHint: backupHint
    })
  },

  // ===== 云端备份 =====

  // 开启备份：弹出密码设置弹框（首次设置输两次；重新开启校验原密码只输一次）
  openEnableBackup() {
    this.setData({
      backupModalShow: true,
      backupMode: 'enable',
      reenableMode: backup.hasSavedKey(),
      pwd1: '',
      pwd2: ''
    })
  },

  // 从云端恢复：弹出密码输入弹框
  restoreFromCloud() {
    this.setData({ backupModalShow: true, backupMode: 'restore', pwd1: '', pwd2: '' })
  },

  closeBackupModal() {
    this.setData({ backupModalShow: false, pwd1: '', pwd2: '' })
  },

  onPwd1Input(e) {
    this.setData({ pwd1: e.detail.value })
  },

  onPwd2Input(e) {
    this.setData({ pwd2: e.detail.value })
  },

  confirmBackupModal() {
    const pwd = this.data.pwd1
    if (this.data.backupMode === 'enable') {
      if (!pwd || pwd.length < 6) {
        wx.showToast({ title: '备份密码至少 6 位', icon: 'none' })
        return
      }
      // 重新开启（校验原密码续用）只输一次；首次设置才要求二次确认
      if (!this.data.reenableMode && pwd !== this.data.pwd2) {
        wx.showToast({ title: '两次输入的密码不一致', icon: 'none' })
        return
      }
      this.setData({ backupModalShow: false })
      // 本地还留有上次的备份密钥：校验原密码后直接续用（云端备份数据延续，不重建）
      if (backup.hasSavedKey()) {
        wx.showLoading({ title: '正在重新开启…', mask: true })
        backup.reenable(pwd).then((r) => {
          wx.hideLoading()
          this.loadData()
          wx.showToast({ title: '已重新开启，备份 ' + r.itemCount + ' 篇', icon: 'success', duration: 2000 })
        }).catch((e) => {
          wx.hideLoading()
          wx.showModal({
            title: '开启失败',
            content: (e && e.message) === '密码与原备份不一致'
              ? '密码与原备份不一致。若忘记原密码，可先「清空云端备份」删除云端数据，再重新设置备份密码。'
              : (e && e.message) || '网络异常，请稍后重试',
            showCancel: false,
            confirmText: '知道了'
          })
        })
        return
      }
      wx.showLoading({ title: '加密并上传中…', mask: true })
      backup.enable(pwd).then((r) => {
        wx.hideLoading()
        this.loadData()
        wx.showToast({ title: '已开启，首次备份 ' + r.itemCount + ' 篇', icon: 'success', duration: 2000 })
      }).catch((e) => {
        wx.hideLoading()
        wx.showModal({
          title: '开启失败',
          content: (e && e.message) || '网络异常，请稍后重试',
          showCancel: false,
          confirmText: '知道了'
        })
      })
    } else {
      // 恢复：拉密文 → 本地解密 → 选择合并/覆盖
      if (!pwd) {
        wx.showToast({ title: '请输入备份密码', icon: 'none' })
        return
      }
      this.setData({ backupModalShow: false })
      wx.showLoading({ title: '解密恢复中…', mask: true })
      backup.restore(pwd).then((r) => {
        wx.hideLoading()
        this.applyRestored(r)
      }).catch((e) => {
        wx.hideLoading()
        wx.showModal({
          title: '恢复失败',
          content: (e && e.message) || '网络异常，请稍后重试',
          showCancel: false,
          confirmText: '知道了'
        })
      })
    }
  },

  // 恢复落地：合并（去重追加）或覆盖本地
  applyRestored(r) {
    wx.showActionSheet({
      itemList: ['合并到本机（去重追加，共 ' + r.itemCount + ' 篇）', '覆盖本机全部日记'],
      success: (res) => {
        const replace = res.tapIndex === 1
        let added = 0
        if (replace) {
          added = storage.replaceAllDiaries(r.diaries)
          storage.replaceArchives(r.archives || [])
        } else {
          added = storage.importDiaries(r.diaries)
          storage.saveArchives(r.archives || [])
        }
        app.globalData.needRefresh = true
        this.loadData()
        const msg = added === -1
          ? '本机存储已满，恢复失败'
          : '已恢复 ' + (added > 0 ? added + ' 篇新日记' : '（内容均已存在）')
        wx.showModal({
          title: replace ? '已覆盖恢复' : '已合并恢复',
          content: msg + '\n\n档案信息已一并恢复。',
          showCancel: false,
          confirmText: '知道了'
        })
      },
      fail: () => { /* 取消 */ }
    })
  },

  // 立即备份
  backupNow() {
    wx.showLoading({ title: '加密并上传中…', mask: true })
    backup.sync().then((r) => {
      wx.hideLoading()
      this.loadData()
      wx.showToast({ title: '已备份 ' + (r ? r.itemCount : 0) + ' 篇到云端', icon: 'success', duration: 2000 })
    }).catch((e) => {
      wx.hideLoading()
      wx.showModal({
        title: '备份失败',
        content: (e && e.message) || '网络异常，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  // 一键清空云端备份：先弹页面内确认层，用户确认后才物理删除云端密文（备份保持开启，之后改动会重新上传）
  clearCloudBackup() {
    this.setData({ confirmClearShow: true })
  },

  closeConfirmClear() {
    this.setData({ confirmClearShow: false })
  },

  // 用户确认后执行清空云端备份
  doClearCloud() {
    this.setData({ confirmClearShow: false })
    wx.showLoading({ title: '删除中…', mask: true })
    backup.clearCloud().then(() => {
      wx.hideLoading()
      this.loadData()
      wx.showToast({ title: '云端备份数据已删除', icon: 'success' })
    }).catch((e) => {
      wx.hideLoading()
      wx.showModal({
        title: '删除失败',
        content: (e && e.message) || '网络异常，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  // 关闭云端备份：先弹页面内确认层，确认后仅停止自动同步（云端备份与本地密钥保留）
  disableBackup() {
    this.setData({ confirmDisableShow: true })
  },

  closeConfirmDisable() {
    this.setData({ confirmDisableShow: false })
  },

  // 用户确认后执行关闭云端备份
  doDisableBackup() {
    this.setData({ confirmDisableShow: false })
    backup.disable()
    this.loadData()
    wx.showToast({ title: '已关闭云端备份', icon: 'success' })
  },

  onShareAppMessage() {
    return {
      title: 'AI日记 — 记录每一天的故事',
      path: '/pages/write/write'
    }
  }
})
