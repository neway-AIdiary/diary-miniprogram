const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const storage = require('../../utils/storage.js')

const app = getApp()

Page({
  data: {
    themeMode: 'light',
    themeLabel: '浅色',
    themePanelOpen: false,
    // 日记本密码：右侧状态文案
    lockLabel: '已关闭'
  },

  onShow() {
    theme.applyTo(this)
    this.syncThemeState()
    this.syncLockState()
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

  // 日记本密码：跳到密码设置页
  goToLock() {
    wx.navigateTo({ url: '/pages/setting-lock/setting-lock' })
  },

  // 日记本密码：右侧显示当前状态
  syncLockState() {
    this.setData({ lockLabel: lock.isEnabled() ? '已开启' : '已关闭' })
  },

  // 清除所有日记：仅删除本机全部日记；云端备份与云端图片/视频一律保留
  clearAllDiaries() {
    wx.showModal({
      title: '确认清除',
      content: '将删除本机全部日记。本机数据删除后不可撤销，建议先将日记备份。确定继续吗？',
      confirmColor: '#e74c3c',
      success: (res) => {
        if (res.confirm) {
          storage.clearAllDiaries()
          app.globalData.needRefresh = true
          wx.showToast({ title: '已清除全部日记', icon: 'success' })
        }
      }
    })
  },

  // 关于：跳「关于」页（简介 / 版本号 / 备案号 / 联系方式）
  goToAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  }
})
