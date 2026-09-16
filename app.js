App({
  globalData: {
    userInfo: null,
    needRefresh: false,
    // AI 能力状态：'cloud'（云函数可用）| 'local'（仅本地规则）
    aiMode: 'cloud',
    // 导入结果传递：{ count: N, toast: '提示文案' }，日记本页 onShow 消费后清空
    importResult: null,
    // 语音输入目标：{ label: '正文', handle: fn }，页面 onShow 注册、onHide 注销
    voiceTarget: null,
    // 无目标页面时的语音草稿，写日记页 onShow 消费
    voiceDraft: null
  },

  onLaunch() {
    // 云开发初始化（用于 AI 优化云函数），指定环境 ID
    if (wx.cloud) {
      wx.cloud.init({ env: 'aidiary-d6grgxkct50c30f45', traceUser: true })
    }

    // 日记字体：若用户选了托管字体（宋/楷），启动时按需预载（非托管字体此处为零开销）
    require('./utils/fontSetting.js').ensureLoaded()

    // 写日记页占位文案：打开次数 +1（首次安装后的第一次启动 = 第 1 次），
    // 并静默拉取云端文案规则（失败回落本地默认，不阻塞启动）
    const textRules = require('./utils/textRules.js')
    textRules.bumpLaunchCount()
    textRules.refresh()

    // 读取本地缓存的用户信息
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo) {
      this.globalData.userInfo = userInfo
    }

    // 清理历史版本首次安装时写入的 3 篇示例日记（严格匹配，仅执行一次）
    this.cleanupSampleDiaries()
  },

  // 清理历史版本首次安装时写入的 3 篇示例日记：
  // 只删「标题 + 内容前缀」与原始示例完全一致的（用户编辑过的一律保留），且仅执行一次。
  cleanupSampleDiaries() {
    const DONE_KEY = 'sampleCleaned'
    try {
      if (wx.getStorageSync(DONE_KEY)) return
      wx.setStorageSync(DONE_KEY, true)

      const SAMPLES = [
        { title: '忙碌而充实的一天', prefix: '今天从早上开始就排满了会议' },
        { title: '午后随笔', prefix: '难得周末没有安排，睡到自然醒' },
        { title: '关于「坚持」的思考', prefix: '今天想到关于「坚持」的一些事情' }
      ]

      const storage = require('./utils/storage.js')
      const list = storage.getAllDiaries() || []
      let removed = 0
      for (let i = 0; i < list.length; i++) {
        const t = String(list[i].title || '')
        const c = String(list[i].content || '')
        for (let j = 0; j < SAMPLES.length; j++) {
          if (t === SAMPLES[j].title && c.indexOf(SAMPLES[j].prefix) === 0) {
            storage.deleteDiary(list[i].id)
            removed++
            break
          }
        }
      }
      if (removed) console.log('[app] 已清理示例日记 ' + removed + ' 篇')
    } catch (e) {
      console.warn('[app] 清理示例日记失败（忽略）:', e)
    }
  }
})
