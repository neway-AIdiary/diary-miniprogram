const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const backup = require('../../utils/backup.js')
const mediaGuard = require('../../utils/mediaGuard.js')
const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const appInfo = require('../../utils/appInfo.js')
const shareCard = require('../../utils/shareCard.js') // [share-card-fallback v1] 品牌图探活与兜底
const app = getApp()

Page({
  data: {
    // 云端备份状态
    backupEnabled: false,
    backupHint: '',
    backupHintWarn: '',
    syncErrorText: '',
    // 备份密码弹框
    backupModalShow: false,
    backupMode: 'enable',   // 'enable' | 'restore'
    reenableMode: false,    // 重新开启（本地密钥还在，校验原密码续用）：只输一次密码
    allowOverwrite: false,  // 用户已确认「设新密码覆盖云端已有备份」→ 放行 enable 的覆盖护栏
    pwd1: '',
    pwd2: '',
    // 清空云端备份确认弹层
    confirmClearShow: false,
    // 关闭云端备份确认弹层
    confirmDisableShow: false,
    // 云端探测：换机 / 卸载重装后本机没有任何备份状态，仍需发现「云端已有备份」
    cloudExists: false,
    cloudItemCount: 0,
    cloudUpdatedAtText: '',
    cloudVersionCount: 0,
    probeErrorText: '',
    // 状态卡文案与恢复入口显隐（随本机开关 + 云端状态变化）
    statusTitle: '云端备份未开启',
    statusSub: '日记只存在本机，不上传任何数据',
    showRestore: false,
    // 云端历史版本（多版本快照：最新在前）
    versions: [],
    // 从指定历史版本恢复时的版本序号（0 = 最新）
    pendingVersionIndex: 0,
    // 清理云端图片/视频确认弹层与规模提示
    confirmMediaShow: false,
    mediaFileCount: 0,
    mediaSizeText: ''
  },

  onShow() {
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
    this.loadData()
  },

  loadData() {
    // 自动同步失败留痕：红字提示用户手动重试（成功同步后自动消失）
    let syncErrorText = ''
    if (backup.isEnabled()) {
      const err = backup.getLastSyncError()
      if (err && err.at) {
        syncErrorText = '上次同步失败（' + (util.formatDate(err.at) || '') + (err.message ? '：' + err.message : '') + '），云端备份可能不是最新，请点「立即备份到云端」重试'
      }
    }

    this.setData({
      backupEnabled: backup.isEnabled(),
      syncErrorText: syncErrorText
    })

    this.refreshTexts()
    this.loadVersions()
    this.probeCloud()
  },

  // 状态卡与提示文案：随「本机开关状态 + 云端是否有备份」变化（探测回来后需重算）
  refreshTexts() {
    const d = this.data
    let statusTitle = ''
    let statusSub = ''
    let backupHint = ''
    let backupHintWarn = ''
    const cloudAt = d.cloudUpdatedAtText ? '（' + d.cloudUpdatedAtText + '）' : ''

    if (d.backupEnabled) {
      // 状态卡已展示「云端备份已开启」，不再重复状态行；只保留加密承诺（标红展示）
      statusTitle = '云端备份已开启'
      statusSub = '日记改动后自动加密同步'
      backupHintWarn = '明文永不上传，服务器只存加密密文'
    } else if (backup.hasSavedKey()) {
      // 已关闭云端备份但本地密钥还在，云端仍有历史备份：重新开启可续用
      statusTitle = '云端备份已关闭'
      statusSub = '改动不再自动同步，云端历史备份保留'
      backupHint = '云端仍有历史备份，点「开启云端备份」输入原备份密码即可继续同步'
      backupHintWarn = '明文永不上传，服务器只存加密密文'
    } else if (d.cloudExists) {
      // 换机 / 卸载重装：本机没有任何备份状态，但云端已有加密备份（换设备靠同一微信 openid 认人）
      statusTitle = '云端已有备份'
      statusSub = '云端有 ' + d.cloudItemCount + ' 篇加密备份' + cloudAt + '，本机未开启'
      backupHint = '本机还没开启备份，云端已有 ' + d.cloudItemCount + ' 篇' + cloudAt + '；点「从云端恢复」输入原备份密码即可取回。'
    } else {
      statusTitle = '云端备份未开启'
      statusSub = '日记只存在本机，不上传任何数据'
      backupHint = '默认只存在本机，不上传任何数据；开启后仅上传 AES 加密密文'
    }

    this.setData({
      statusTitle: statusTitle,
      statusSub: statusSub,
      backupHint: backupHint,
      backupHintWarn: backupHintWarn,
      showRestore: !!(d.backupEnabled || backup.hasSavedKey() || d.cloudExists)
    })
  },

  // 云端探测（换机 / 卸载重装场景）：本机可能拿不到任何备份状态，但云端已有加密备份。
  // 「仅创建者可读写」下由云开发按 _openid 隔离，同一微信换设备即同一身份。
  // 失败降级为红字提示（不阻断页面），探测结果只影响文案与入口显隐。
  probeCloud() {
    const seq = (this._probeSeq || 0) + 1
    this._probeSeq = seq
    backup.cloudStatus().then((st) => {
      if (seq !== this._probeSeq) return // 快速重进本页时，旧请求结果作废
      const exists = !!(st && st.exists)
      this.setData({
        cloudExists: exists,
        cloudItemCount: exists ? (st.itemCount || 0) : 0,
        cloudUpdatedAtText: exists ? (util.formatDate(st.updatedAt) || '') : '',
        cloudVersionCount: exists ? (st.versionCount || 0) : 0,
        probeErrorText: ''
      })
      this.refreshTexts()
      if (exists) this.loadVersions() // 换机场景：历史版本也能看（只读元数据，不需要本机密钥）
    }).catch((e) => {
      if (seq !== this._probeSeq) return
      this.setData({
        cloudExists: false,
        probeErrorText: '云端状态查询失败：' + ((e && e.message) || '网络异常') + '；请检查网络后重新进入本页再操作备份'
      })
      this.refreshTexts()
    })
  },

  // 云端历史版本列表（多版本快照）：本机留有密钥、或云端已有备份（换机场景）时查询；
  // 只读云端 meta 的元数据（时间/篇数/大小），不需要本机密钥；失败静默，不影响主流程
  loadVersions() {
    // 换机场景：本机没有备份密钥，但云端已有备份（listVersions 只读元数据，不需要密钥）
    if (!backup.hasSavedKey() && !this.data.cloudExists) {
      this.setData({ versions: [] })
      return
    }
    backup.listVersions().then((list) => {
      this.setData({
        versions: (list || []).map((v, i) => ({
          index: v.index,
          itemCount: v.itemCount,
          label: (util.formatDate(v.at) || '时间未知') + (i === 0 ? '（最新）' : '')
        }))
      })
    }).catch(() => {
      this.setData({ versions: [] })
    })
  },

  // ===== 云端备份 =====

  // 开启备份：弹出密码设置弹框（首次设置输两次；重新开启校验原密码只输一次）
  openEnableBackup() {
    // 本机还留着备份密钥 → 走原密码校验续用，不涉及覆盖
    if (backup.hasSavedKey()) {
      this.showEnableModal(false)
      return
    }
    // 换机 / 卸载重装：本机没有备份密钥 —— 设新密码会清空云端历史备份，必须先警示。
    // 已探明的直接警示；探测是异步的（probeCloud 可能还没回来），故此处按需补查一次，
    // 避免「刚进页面手快一点」时 cloudExists 还是 false 而漏掉警示（消竞态）。
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
      this.setData({
        cloudExists: true,
        cloudItemCount: st.itemCount || 0,
        cloudUpdatedAtText: util.formatDate(st.updatedAt) || ''
      })
      this.refreshTexts()
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

  // 打开密码设置弹框（首次设置输两次；重新开启校验原密码只输一次）
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

  // 从云端恢复（默认最新版本）：弹出密码输入弹框
  restoreFromCloud() {
    this.setData({ backupModalShow: true, backupMode: 'restore', pendingVersionIndex: 0, pwd1: '', pwd2: '' })
  },

  // 从指定历史版本恢复：记住版本序号，走同一套密码弹框
  restoreVersion(e) {
    const idx = Number(e.currentTarget.dataset.index) || 0
    this.setData({
      backupModalShow: true,
      backupMode: 'restore',
      pendingVersionIndex: idx,
      pwd1: '',
      pwd2: ''
    })
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
      // 恢复：拉密文 → 本地解密 → 选择合并/覆盖（可指定历史版本）
      if (!pwd) {
        wx.showToast({ title: '请输入备份密码', icon: 'none' })
        return
      }
      const versionIndex = this.data.pendingVersionIndex || 0
      this._restorePwd = pwd // 换机恢复后若要接上自动备份，复用这个密码
      this.setData({ backupModalShow: false })
      wx.showLoading({ title: '解密恢复中…', mask: true })
      backup.restore(pwd, versionIndex).then((r) => {
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
    const verText = r.versionAt ? '（版本时间 ' + (util.formatDate(r.versionAt) || r.versionAt) + '）' : ''
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
          content: msg + '\n\n档案信息已一并恢复。' + verText,
          showCancel: false,
          confirmText: '知道了',
          complete: () => {
            // 换机场景：恢复前本机没有备份密钥 → 用刚恢复用的密码接上自动备份，否则后续改动不会自动同步
            if (!backup.hasSavedKey() && this._restorePwd) this.askAdoptCloud(this._restorePwd)
          }
        })
      },
      fail: () => { /* 取消 */ }
    })
  },

  // 用刚恢复用的密码接上云端自动备份（云端已有数据沿用：不上传、不重建、不清空）
  askAdoptCloud(password) {
    const pwd = password
    this._restorePwd = null
    wx.showModal({
      title: '开启自动备份？',
      content: '是否用这个备份密码开启自动备份？开启后日记再有改动会自动加密同步到云端；云端现有备份继续沿用，不会被清空重建。',
      cancelText: '暂不开启',
      confirmText: '开启',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '正在开启…', mask: true })
        backup.adoptCloud(pwd).then((r) => {
          wx.hideLoading()
          this.loadData()
          wx.showToast({ title: '已开启自动备份（' + (r ? r.itemCount : 0) + ' 篇）', icon: 'success', duration: 2000 })
        }).catch((e) => {
          wx.hideLoading()
          wx.showModal({
            title: '开启失败',
            content: (e && e.message) || '网络异常，请稍后重试',
            showCancel: false,
            confirmText: '知道了'
          })
        })
      }
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
      this.loadData() // 手动备份失败也留痕，页面显示红字提示
      wx.showModal({
        title: '备份失败',
        content: (e && e.message) || '网络异常，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  // 清理云端图片/视频：范围 = 当前本机日记引用的云端媒体（客户端无法列举云端孤儿文件）
  clearCloudMedia() {
    const diaries = storage.getAllDiaries()
    const ids = mediaGuard.collectFileIDs(diaries)
    if (!ids.length) {
      wx.showModal({
        title: '没有可清理的媒体',
        content: '当前本机没有带图片/视频的日记，无法确定云端媒体归属，因此没有可安全清理的对象。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    const allMedia = []
    diaries.forEach((d) => { (d.media || []).forEach((m) => allMedia.push(m)) })
    const bytes = mediaGuard.sumMediaBytes(allMedia)
    this._mediaIDs = ids
    this.setData({
      confirmMediaShow: true,
      mediaFileCount: ids.length,
      mediaSizeText: bytes > 0 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : '大小未知'
    })
  },

  closeConfirmMedia() {
    this.setData({ confirmMediaShow: false })
  },

  // 用户确认后删除云端媒体文件（含视频封面），并同步扣减本机用量估算
  doClearCloudMedia() {
    this.setData({ confirmMediaShow: false })
    const ids = this._mediaIDs || []
    if (!ids.length) return
    const diaries = storage.getAllDiaries()
    const allMedia = []
    diaries.forEach((d) => { (d.media || []).forEach((m) => allMedia.push(m)) })
    const bytes = mediaGuard.sumMediaBytes(allMedia)
    wx.showLoading({ title: '删除中…', mask: true })
    mediaGuard.deleteCloudFiles(ids).then((r) => {
      wx.hideLoading()
      if (bytes > 0) mediaGuard.subtractMediaUsage(bytes)
      this._mediaIDs = null
      this.loadData()
      const failed = (r && r.failed) || 0
      wx.showModal({
        title: failed ? '部分删除失败' : '已清理云端媒体',
        content: '已删除 ' + ((r && r.deleted) || 0) + ' 个云端图片/视频文件'
          + (failed ? '，' + failed + ' 个删除失败（可稍后重试）' : '') + '。',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  // 一键清空云端备份：先弹页面内确认层，用户确认后才物理删除云端全部版本密文（备份保持开启，之后改动会重新上传）
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
    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图
    return shareCard.build({
      title: appInfo.APP_NAME + ' — 你的数字分身',
      path: '/pages/write/write'
    })
  }
})
