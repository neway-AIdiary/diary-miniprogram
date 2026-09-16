const theme = require('../../utils/theme.js')

Page({
  data: {
    themeMode: 'light',
    themeLabel: '浅色',
    themePanelOpen: false
  },

  onShow() {
    theme.applyTo(this)
    this.syncThemeState()
  },

  syncThemeState() {
    const mode = theme.getMode()
    this.setData({
      themeMode: mode,
      themeLabel: mode === 'dark' ? '深色' : '浅色'
    })
  },

  // 主题：展开 / 收起选择面板
  onToggleTheme() {
    this.setData({ themePanelOpen: !this.data.themePanelOpen })
  },

  // 主题：选择并立即生效
  onPickTheme(e) {
    const mode = e.currentTarget.dataset.mode === 'dark' ? 'dark' : 'light'
    theme.setMode(mode)
    theme.applyTo(this)
    this.syncThemeState()
    wx.showToast({ title: mode === 'dark' ? '已切换到深色' : '已切换到浅色', icon: 'none' })
  },

  // 占位功能按钮：AI模型
  onComingSoon(e) {
    const name = e.currentTarget.dataset.name || '该功能'
    wx.showToast({ title: name + '功能开发中', icon: 'none' })
  },

  // 日记字体：跳到字体设置页
  goToFontSetting() {
    wx.navigateTo({ url: '/pages/font-setting/font-setting' })
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
