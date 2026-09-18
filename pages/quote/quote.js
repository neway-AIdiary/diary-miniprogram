/**
 * 每日一签 · 全篇页
 *
 * - 内容唯一来源 utils/dailyQuote.js，本页不写死任何正文
 * - 入参：?i=<池子下标>（侧栏卡片透传）；越界/缺失/非数字一律回落到今天那一签
 * - 主题沿用全站机制：根节点 class="page {{themeClass}}"，onShow 调 theme.applyTo(this)
 */
const theme = require('../../utils/theme.js')
const dailyQuote = require('../../utils/dailyQuote.js')
const appInfo = require('../../utils/appInfo.js')

Page({
  data: {
    themeClass: '',
    appName: appInfo.APP_NAME,
    kind: '',
    head: '',
    byline: '',
    body: '',
    copyText: ''
  },

  onLoad(options) {
    // 仅传下标；下标合法性由 dailyQuote.safeIndex 兜底（不信任 URL 参数）
    const detail = dailyQuote.getDetail(options && options.i)
    this.setData(detail)
  },

  onShow() {
    theme.applyTo(this)
  },

  // 复制全文：含标题与副题，粘到别处自带出处；失败明确告知，不静默
  copyAll() {
    wx.setClipboardData({
      data: this.data.copyText,
      success: () => {
        wx.showToast({ title: '已复制全文', icon: 'none' })
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' })
      }
    })
  }
})
