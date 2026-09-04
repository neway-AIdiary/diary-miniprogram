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

    // 读取本地缓存的用户信息
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo) {
      this.globalData.userInfo = userInfo
    }

    // 添加几篇示例日记（仅首次安装时）
    this.initSampleData()
  },

  // 首次使用时添加示例日记，让用户打开就能看到内容
  initSampleData() {
    const initialized = wx.getStorageSync('initialized')
    if (initialized) return

    const storage = require('./utils/storage.js')
    const now = new Date()

    // 示例日记1 — 昨天
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(20, 30, 0, 0)

    storage.saveDiary({
      title: '忙碌而充实的一天',
      content: '今天从早上开始就排满了会议，不过效率出奇地高。\n\n下午终于把拖了一周的项目方案敲定了，团队反馈不错。下班后去公园跑了5公里，出了一身汗，感觉整个人都轻了不少。\n\n晚上回家做了顿简单的饭，边吃边看了两集纪录片。生活就是这样，平凡中藏着小确幸。',
      mood: 'happy',
      source: 'manual',
      tags: ['工作', '跑步', '项目'],
      created_at: yesterday.toISOString()
    })

    // 示例日记2 — 前天
    const dayBefore = new Date(now)
    dayBefore.setDate(dayBefore.getDate() - 2)
    dayBefore.setHours(15, 0, 0, 0)

    storage.saveDiary({
      title: '午后随笔',
      content: '难得周末没有安排，睡到自然醒。泡了杯咖啡，坐在窗边看了一会儿书。\n\n下午突然下起了雨，雨声打在窗户上，格外治愈。这样的日子，什么都不做也很美好。',
      mood: 'calm',
      source: 'manual',
      tags: ['周末', '咖啡', '阅读'],
      created_at: dayBefore.toISOString()
    })

    // 示例日记3 — 三天前
    const threeDaysAgo = new Date(now)
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
    threeDaysAgo.setHours(22, 0, 0, 0)

    storage.saveDiary({
      title: '关于「坚持」的思考',
      content: '今天想到关于「坚持」的一些事情。\n\n早上起来的时候，这个念头就冒了出来。也许是因为最近一直在思考这方面的事，所以潜意识里一直在消化这些信息。\n\n回想这一天，做的事情虽然琐碎，但每一件似乎都和这个主题有些关联。生活就是这样，当你关注某个方向时，周围的一切都会给你回应。\n\n希望明天能有更多的时间来深入思考，把今天的想法落实成行动。',
      mood: 'calm',
      source: 'manual',
      tags: ['思考', '坚持'],
      created_at: threeDaysAgo.toISOString()
    })

    wx.setStorageSync('initialized', true)
  }
})
