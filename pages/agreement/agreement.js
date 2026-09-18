/**
 * 用户协议与隐私政策（合一页，Tab 切换）
 *
 * - 文本唯一来源 utils/agreement.js，本页不写死正文
 * - 主题沿用全站机制：根节点 class="page {{themeClass}}"，onShow 调 theme.applyTo(this)
 */
const theme = require('../../utils/theme.js')
const agreement = require('../../utils/agreement.js')

Page({
  data: {
    themeClass: '',
    appName: '',
    tab: 'privacy', // 默认落在隐私政策（用户最关心）；'terms' | 'privacy'
    terms: agreement.TERMS,
    privacy: agreement.PRIVACY,
    effectiveDate: agreement.EFFECTIVE_DATE
  },

  onLoad(options) {
    // 支持 about 页带 tab 参数直达（?tab=terms / ?tab=privacy）
    const t = options && options.tab === 'terms' ? 'terms' : 'privacy'
    this.setData({ tab: t, appName: require('../../utils/appInfo.js').APP_NAME })
  },

  onShow() {
    theme.applyTo(this)
  },

  switchTab(e) {
    const t = e.currentTarget.dataset.tab
    if (t && t !== this.data.tab) this.setData({ tab: t })
  }
})
