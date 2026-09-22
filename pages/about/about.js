/**
 * 关于页：应用名 + 版本号 + 简介 + 出品方 + 备案号 + 联系方式
 *
 * 所有文案取自 utils/appInfo.js，本页不写死任何业务常量。
 * 备案号必须展示完整编号并让用户能核验：小程序内无法外链工信部域名
 * （加不进业务域名白名单），因此采取「点击复制 + 提示到 beian.miit.gov.cn
 * 查询核对」这一通行做法，符合备案号需置于显著位置并可查询的要求。
 */
const theme = require('../../utils/theme.js')
const appInfo = require('../../utils/appInfo.js')
const agreement = require('../../utils/agreement.js')

Page({
  data: {
    themeClass: '',
    appName: appInfo.APP_NAME,
    version: appInfo.APP_VERSION,
    intro: appInfo.APP_INTRO,
    icpNo: appInfo.ICP_NO,
    producer: appInfo.PRODUCER,
    wechatId: appInfo.WECHAT_ID,
    effectiveDate: agreement.EFFECTIVE_DATE
  },

  onShow() {
    theme.applyTo(this)
  },

  // 复制工具：失败时明确告知，不静默
  copy(text, tip) {
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: tip, icon: 'none' })
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' })
      }
    })
  },

  // 备案号：复制后引导到工信部系统核对（小程序内无法直接外链）
  copyIcp() {
    this.copy(appInfo.ICP_NO, '已复制，可到 ' + appInfo.ICP_SITE + ' 核对')
  },

  // 出品方：主体名称需逐字准确（报备 / 开票常要填），整行可点即复制
  copyProducer() {
    this.copy(appInfo.PRODUCER, '出品方已复制')
  },

  // 微信号：直接复制，免得用户手抄
  copyWechat() {
    this.copy(appInfo.WECHAT_ID, '微信号已复制')
  },

  // 用户协议与隐私政策：独立子页，默认落在隐私政策 Tab
  goToAgreement() {
    wx.navigateTo({ url: '/pages/agreement/agreement?tab=privacy' })
  }
})
