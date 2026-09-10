Page({
  data: {},

  // 占位功能按钮：主题 / 日记字体 / AI模型
  onComingSoon(e) {
    const name = e.currentTarget.dataset.name || '该功能'
    wx.showToast({ title: name + '功能开发中', icon: 'none' })
  },

  // 闹钟：跳到闹钟设置页
  goToReminder() {
    wx.navigateTo({ url: '/pages/setting-reminder/setting-reminder' })
  },

  // 关于：复用原侧栏介绍弹窗
  showAbout() {
    wx.showModal({
      title: '关于AI日记',
      content: 'AI日记\n\n记录每一天的故事，写完可以用 AI 优化润色，让表达更生动。\n\n所有数据存储在本地，保护你的隐私。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
