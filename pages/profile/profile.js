const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const transfer = require('../../utils/transfer.js')
const backup = require('../../utils/backup.js')
const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const appInfo = require('../../utils/appInfo.js')
const shareCard = require('../../utils/shareCard.js') // [share-card-fallback v1] 品牌图探活与兜底
const app = getApp()

Page({
  data: {
    appName: appInfo.APP_NAME,
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
    // 云端探测（换机 / 卸载重装后本机没有任何备份状态，仍需发现「云端已有备份」）
    cloudExists: false,
    cloudItemCount: 0,
    // 恢复入口显隐：本机已开启 / 本地密钥还在 / 换机但云端已有备份 —— 三种都要能进
    showRestore: false,
    // 用户已确认「设新密码覆盖云端已有备份」→ 放行 enable 的覆盖护栏
    allowOverwrite: false,
    pwd1: '',
    pwd2: ''
  },

  onLoad() {
    this.loadData()
  },

  onShow() {
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
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
    const enabled = backup.isEnabled()
    const savedKey = backup.hasSavedKey()
    let backupHint = ''
    if (state && state.enabled) {
      const last = state.lastSyncAt ? util.formatDate(state.lastSyncAt) : ''
      backupHint = '已开启 · 上次备份 ' + (state.lastCount || 0) + ' 篇' + (last ? '（' + last + '）' : '') + ' · 日记改动后自动同步\n明文永不上传，服务器只存加密密文'
    } else if (savedKey) {
      backupHint = '云端备份已关闭，云端历史备份保留；点「开启云端备份」输入原备份密码即可继续同步'
    } else {
      backupHint = '默认只存在本机，不上传任何数据；开启后仅上传 AES 加密密文'
    }

    this.setData({
      userInfo: userInfo,
      hasUserInfo: !!userInfo,
      stats: stats,
      backupEnabled: enabled,
      backupHint: backupHint,
      showRestore: !!(enabled || savedKey || this.data.cloudExists)
    })

    this.probeCloud()
  },

  // 云端探测：只读云端 meta 元数据（不需要本机密钥），失败静默、不改任何状态
  probeCloud() {
    // 本机状态已明确（已开启 / 本地还有密钥）时不必探测，省一次云请求
    if (backup.isEnabled() || backup.hasSavedKey()) return
    const seq = (this._probeSeq || 0) + 1
    this._probeSeq = seq
    backup.cloudStatus().then((st) => {
      if (seq !== this._probeSeq) return // 快速重进本页时，旧请求结果作废
      const exists = !!(st && st.exists)
      this.setData({
        cloudExists: exists,
        cloudItemCount: exists ? (st.itemCount || 0) : 0,
        showRestore: !!(backup.isEnabled() || backup.hasSavedKey() || exists)
      })
      if (exists) {
        this.setData({
          backupHint: '云端已有 ' + (st.itemCount || 0) + ' 篇加密备份' +
            (st.updatedAt ? '（' + (util.formatDate(st.updatedAt) || '') + '）' : '') +
            '，本机未开启；点「从云端恢复」输入原备份密码即可取回'
        })
      }
    }).catch(() => {
      // 探测失败：不改状态也不弹窗（本页无红字位；备份页有明确提示，不想打扰用户）
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
  // ===== 云端备份 =====

  // 开启备份：弹出密码设置弹框（首次设置输两次；重新开启校验原密码只输一次）
  openEnableBackup() {
    // 本机还留着备份密钥 → 走原密码校验续用，不涉及覆盖
    if (backup.hasSavedKey()) {
      this.showEnableModal(false)
      return
    }
    // 换机 / 卸载重装：本机没有备份密钥 —— 设新密码会清空云端历史备份，必须先警示。
    // 探测是异步的，此处按需补查一次，避免「刚进页面手快一点」时漏掉警示（消竞态）。
    if (this.data.cloudExists) {
      this.confirmOverwriteEnable(this.data.cloudItemCount)
      return
    }
    wx.showLoading({ title: '正在查询云端…', mask: true })
    backup.cloudStatus().then((st) => {
      wx.hideLoading()
      if (!(st && st.exists)) {
        this.showEnableModal(false) // 云端确实没有备份 → 正常开启
        return
      }
      this.setData({ cloudExists: true, cloudItemCount: st.itemCount || 0 })
      this.confirmOverwriteEnable(st.itemCount || 0)
    }).catch(() => {
      wx.hideLoading()
      // 查不到云端状态：宁可拦住，也不放行可能覆盖云端备份的操作
      wx.showModal({
        title: '无法确认云端状态',
        content: '没有查到云端备份状态（可能网络不稳定）。为避免覆盖云端已有备份，已停止本次操作；请检查网络后重试。',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  // 打开密码设置弹框
  // @param {boolean} allowOverwrite 用户是否已确认「覆盖云端已有备份」；未确认一律 false → enable 护栏会拦下
  showEnableModal(allowOverwrite) {
    this.setData({
      backupModalShow: true,
      backupMode: 'enable',
      reenableMode: backup.hasSavedKey(),
      allowOverwrite: !!allowOverwrite,
      pwd1: '',
      pwd2: ''
    })
  },

  // 覆盖警示：确认后才允许设新密码（覆盖 = 清空云端历史版本，不可逆）
  confirmOverwriteEnable(count) {
    wx.showModal({
      title: '云端已有备份',
      content: '云端已存在 ' + count + ' 篇加密备份。\n\n设置新备份密码会清空云端历史备份并用新密码重建；如果还记得原备份密码，请改用「从云端恢复」。',
      cancelText: '取消',
      confirmText: '设新密码',
      success: (res) => {
        if (res.confirm) this.showEnableModal(true) // 用户明确确认 → 显式授权本次覆盖
      }
    })
  },

  // 从云端恢复：弹出密码输入弹框
  restoreFromCloud() {
    this.setData({ backupModalShow: true, backupMode: 'restore', pwd1: '', pwd2: '' })
  },

  closeBackupModal() {
    // 关闭弹框即撤销覆盖授权：下次再点「开启」必须重新确认一次
    this.setData({ backupModalShow: false, pwd1: '', pwd2: '', allowOverwrite: false })
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
      // 覆盖授权随调用一起显式传入：没有用户在警示弹窗里的确认，utils 层会直接拒绝
      backup.enable(pwd, { allowOverwrite: !!this.data.allowOverwrite }).then((r) => {
        wx.hideLoading()
        this.loadData()
        wx.showToast({ title: '已开启，首次备份 ' + r.itemCount + ' 篇', icon: 'success', duration: 2000 })
      }).catch((e) => {
        wx.hideLoading()
        // 被覆盖护栏拦下：说清原因并指路（不给「重试」死循环 —— 重试多少次都会被拦）
        if (e && e.code === 'CLOUD_EXISTS') {
          this.loadData()
          wx.showModal({
            title: '云端已有备份',
            content: '为避免覆盖云端已有备份，本次「开启」没有执行。\n\n如果还记得原备份密码，请点「从云端恢复」取回数据；确实想重新来过，请先「清空云端备份」。',
            showCancel: false,
            confirmText: '知道了'
          })
          return
        }
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
      title: '关于' + appInfo.APP_NAME,
      content: appInfo.APP_NAME + ' v1.0\n\n记录每一天的故事，写完可以用 AI 优化润色，让表达更生动。\n\n日记默认只存在你的手机里；如需跨设备同步，可在「云端备份」中主动开启（AES 加密，明文永不上传，可随时关闭并删除云数据）。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  // 分享
  onShareAppMessage() {
    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图
    return shareCard.build({
      title: appInfo.APP_NAME + ' — 你的数字分身',
      path: '/pages/write/write'
    })
  }
})
