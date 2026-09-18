const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const storage = require('../../utils/storage.js')
const guide = require('../../utils/guide.js')

const app = getApp()

Page({
  data: {
    themeMode: 'light',
    themeLabel: '浅色',
    themePanelOpen: false,
    // 日记本密码：右侧状态文案
    lockLabel: '已关闭',
    // 新手引导（第 5 步「主题」在本页续接）：同写日记页的四件套
    guideVisible: false,
    guideStep: {},
    guideRect: null,
    guideShape: 'rect'
  },

  onShow() {
    theme.applyTo(this)
    this.syncThemeState()
    this.syncLockState()
    // 新手引导：从写日记页「去设置」跨页过来时，接上第 5 步
    this.maybeShowGuide()
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
  },

  // ===== 新手引导：第 5 步「主题」在本页续接 =====
  // 跨页口径 1.B：写日记页第 4 步点「去设置」→ 本页 onShow 接上（状态只在 utils/guide.js 内存里）

  maybeShowGuide() {
    if (!guide.stepBelongsTo('setting')) return
    const step = guide.getStep()
    // 等页面切换动画结束再量坐标，否则量到的是上一页的布局
    setTimeout(() => {
      guide.measure(this, step.target, (rect) => {
        this.setData({
          guideVisible: true,
          guideStep: step,
          guideRect: rect,
          guideShape: step.shape || 'rect'
        })
      })
    }, 320)
  },

  onGuideNext() {
    this.endGuide(true)
  },

  onGuideSkip() {
    this.endGuide(false)
  },

  // 走完 / 跳过：都算「看过」（写标记，不再自动打扰），想再看就走本页的「新手引导」入口。
  // 走完 → 回写日记页（按钮上写的是「开始写日记」，动作得对得上文案）；
  // 跳过 → 留在本页（用户明确表示不想看，别把他抛到别处）。
  endGuide(goWrite) {
    guide.finish()
    this.setData({ guideVisible: false, guideRect: null })
    wx.showToast({ title: '随时可在设置里重看引导', icon: 'none' })
    // 页面栈只有本页时（如直达设置页）不回退，避免退出小程序
    if (goWrite && getCurrentPages().length > 1) wx.navigateBack({ delta: 1 })
  },

  // 重看引导：清掉标记 → 回写日记页（那一页 onShow 会自动从第 1 步开播）
  restartGuide() {
    guide.reset()
    wx.reLaunch({ url: guide.WRITE_URL })
  }
})
