const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const transfer = require('../../utils/transfer.js')
const backup = require('../../utils/backup.js')
const mediaGuard = require('../../utils/mediaGuard.js')
const app = getApp()

Page({
  data: {
    userInfo: null,
    stats: null,
    hasUserInfo: false,
    // 云端备份状态
    backupEnabled: false,
    backupHint: '',
    // 备份密码弹框
    backupModalShow: false,
    backupMode: 'enable',   // 'enable' | 'restore'
    reenableMode: false,    // 重新开启（本地密钥还在，校验原密码续用）：只输一次密码
    pwd1: '',
    pwd2: ''
  },

  onLoad() {
    this.loadData()
  },

  onShow() {
    this.loadData()
  },

  loadData() {
    const userInfo = app.globalData.userInfo || wx.getStorageSync('userInfo')
    const stats = storage.getStats()

    // 格式化日期
    if (stats.firstDate) {
      stats.firstDateText = util.formatDate(stats.firstDate)
    }
    if (stats.lastDate) {
      stats.lastDateText = util.formatDate(stats.lastDate)
    }

    // 云端备份状态提示
    const state = backup.getState()
    let backupHint = ''
    if (state && state.enabled) {
      const last = state.lastSyncAt ? util.formatDate(state.lastSyncAt) : ''
      backupHint = '已开启 · 上次备份 ' + (state.lastCount || 0) + ' 篇' + (last ? '（' + last + '）' : '') + ' · 日记改动后自动同步\n明文永不上传，服务器只存加密密文'
    } else {
      backupHint = '默认只存在本机，不上传任何数据；开启后仅上传 AES 加密密文'
    }

    this.setData({
      userInfo: userInfo,
      hasUserInfo: !!userInfo,
      stats: stats,
      backupEnabled: backup.isEnabled(),
      backupHint: backupHint
    })
  },

  // 获取用户头像昵称
  getUserProfile() {
    wx.getUserProfile({
      desc: '用于展示个人信息',
      success: (res) => {
        const userInfo = res.userInfo
        app.globalData.userInfo = userInfo
        wx.setStorageSync('userInfo', userInfo)
        this.setData({
          userInfo: userInfo,
          hasUserInfo: true
        })
        wx.showToast({ title: '授权成功', icon: 'success' })
      },
      fail: () => {
        wx.showToast({ title: '已取消授权', icon: 'none' })
      }
    })
  },

  // 跳转到日记列表
  goToIndex() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  // 跳转到写日记（主页面）
  goToWrite() {
    wx.reLaunch({ url: '/pages/write/write' })
  },

  // 跳转到档案
  goToArchive() {
    wx.navigateTo({ url: '/pages/archive/archive' })
  },

  // 清除所有日记（同步清理云端媒体、归零本地用量估算）
  clearAllDiaries() {
    wx.showModal({
      title: '确认清除',
      content: '将删除所有日记数据（含已上传的云端图片/视频），且不可恢复，确定继续吗？建议先导出备份。',
      confirmColor: '#e74c3c',
      success: (res) => {
        if (res.confirm) {
          const snapshot = storage.getAllDiaries()
          const fileIDs = mediaGuard.collectFileIDs(snapshot)
          storage.clearAllDiaries()
          app.globalData.needRefresh = true
          mediaGuard.clearMediaUsage()
          this.loadData()
          wx.showToast({ title: '已清除全部日记', icon: 'success' })
          if (fileIDs.length) {
            mediaGuard.deleteCloudFiles(fileIDs).then((r) => {
              if (r && r.failed > 0) {
                wx.showToast({ title: r.failed + ' 个云端媒体删除失败', icon: 'none' })
              }
            })
          }
        }
      }
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
      if (this.data.reenableMode) {
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

  // 一键清空云端备份（物理删除云端密文；备份保持开启，之后改动会重新上传）
  clearCloudBackup() {
    wx.showModal({
      title: '清空云端备份',
      content: '将物理删除云端全部加密备份数据。\n\n注意：备份仍处于开启状态，日记再有改动后会重新上传加密备份。若只想停止自动同步、保留云端数据，请用「关闭云端备份」。',
      confirmColor: '#FA5151',
      confirmText: '删除云数据',
      success: (res) => {
        if (!res.confirm) return
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
      }
    })
  },

  // 关闭云端备份（仅停止自动同步，云端备份与本地密钥保留）
  disableBackup() {
    wx.showModal({
      title: '关闭云端备份',
      content: '将停止日记改动后的自动加密同步（本机日记不受影响）。\n\n云端已有备份会保留，可随时从云端恢复；重新开启后继续同步。',
      confirmText: '关闭云端备份',
      success: (res) => {
        if (!res.confirm) return
        backup.disable()
        this.loadData()
        wx.showToast({ title: '已关闭云端备份', icon: 'success' })
      }
    })
  },

  // ===== 导出日记 =====
  exportDiaries() {
    transfer.exportToWord(() => {
      wx.showToast({ title: '暂无日记可导出', icon: 'none' })
    })
  },

  // ===== 导入日记 =====
  importDiaries() {
    transfer.importFromFile({
      onFinish: (added, toast) => {
        app.globalData.needRefresh = true
        wx.showModal({
          title: added === -1 ? '导入失败' : (added > 0 ? '导入成功' : '导入提示'),
          content: toast,
          showCancel: false,
          confirmText: '知道了'
        })
        this.loadData()
      },
      onError: (msg) => {
        wx.showModal({
          title: '导入不成功',
          content: msg,
          showCancel: false,
          confirmText: '知道了'
        })
      }
    })
  },

  // 关于
  showAbout() {
    wx.showModal({
      title: '关于AI日记',
      content: 'AI日记 v1.0\n\n记录每一天的故事，写完可以用 AI 优化润色，让表达更生动。\n\n日记默认只存在你的手机里；如需跨设备同步，可在「云端备份」中主动开启（AES 加密，明文永不上传，可随时关闭并删除云数据）。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  // 分享
  onShareAppMessage() {
    return {
      title: 'AI日记 — 记录每一天的故事',
      path: '/pages/write/write'
    }
  }
})
