/**
 * 日记字体设置页
 * 字号三档 + 字体族；点选即存即生效（各页面 onShow 重新读取设置并注入 CSS 变量）
 */
const fontSetting = require('../../utils/fontSetting.js')
const theme = require('../../utils/theme.js')

// 预览文案：《清平乐·六盘山》
const PREVIEW_TEXT = '天高云淡，望断南飞雁。不到长城非好汉，屈指行程二万。六盘山上高峰，红旗漫卷西风。今日长缨在手，何时缚住苍龙？'

Page({
  data: {
    size: '',
    font: '',
    sizeOptions: [],
    fontOptions: [],
    previewStyle: '',
    previewText: PREVIEW_TEXT
  },

  onLoad() {
    this.refresh()
  },

  // 每次进入都重读，避免从其他入口再次打开时拿到旧值
  onShow() {
    theme.applyTo(this)
    this.refresh()
  },

  refresh() {
    const s = fontSetting.getSetting()
    // 进入页面即触发托管字体按需加载（宋/楷在安卓上的首次下载）
    fontSetting.ensureLoaded(s.font)
    this.setData({
      size: s.size,
      font: s.font,
      sizeOptions: fontSetting.SIZE_OPTIONS,
      fontOptions: fontSetting.FONT_OPTIONS,
      previewStyle: fontSetting.buildStyle(s)
    })
  },

  // 轻震动反馈（部分机型/基础库不支持，静默）
  tapFeedback() {
    try {
      wx.vibrateShort({ type: 'light' })
    } catch (e) {
      // 忽略
    }
  },

  onPickSize(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.size) return
    fontSetting.setSize(key)
    this.refresh()
    this.tapFeedback()
  },

  onPickFont(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.font) return
    fontSetting.setFont(key)
    this.refresh()
    this.tapFeedback()
  }
})
