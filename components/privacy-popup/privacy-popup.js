/**
 * 微信隐私协议弹窗（自绘，极简琥珀风）
 *
 * 机制（方案 B）：
 *   - 页面 onLoad 调 tryShow()：wx.getPrivacySetting 查 needAuthorization，
 *     微信侧记录「已同意」状态 —— 用户同意过就不再弹；平台日后更新《用户隐私保护指引》
 *     会自动把 needAuthorization 翻回 true，弹窗自动再现，因此**不做本地缓存标记**
 *   - 同意按钮 open-type="agreePrivacyAuthorization"（微信官方口径），
 *     点击即视为同意，无需额外 API
 *   - 「暂不同意」/点蒙层 = 仅收起，不阻断功能；之后真触发隐私接口时，
 *     平台会弹官方默认弹窗兜底（未自绘监听 onNeedPrivacyAuthorization 的默认行为）
 *   - 颜色全部走主题令牌，深浅色由页面根节点 theme-dark 覆盖令牌自动生效
 */
Component({
  data: {
    visible: false
  },

  methods: {
    /* 页面 onLoad 时调用：需要授权才显示，其余情况一概静默。
     * 返回 Promise<boolean>：true = 需要授权且弹窗已显示（页面须等 bind:close 再接后续弹层）；
     * false = 无需授权 / 旧基础库 / 查询失败（不显示弹窗，页面可直接继续）。
     * 必须返回结论：查询是异步的，页面只有拿到结论才知道「该不该给后面等」——
     * 用「此刻 visible」当判据会漏掉回调返回前的那段时间（首启两弹层叠着弹的就是这个原因）。 */
    tryShow() {
      if (typeof wx.getPrivacySetting !== 'function') return Promise.resolve(false) // 旧基础库：交给平台兜底
      return new Promise((resolve) => {
        wx.getPrivacySetting({
          success: (res) => {
            const need = !!(res && res.needAuthorization)
            if (need) this.setData({ visible: true })
            resolve(need)
          },
          fail: () => { resolve(false) } // 查询失败静默：后续触发隐私接口时平台默认弹窗兜底
        })
      })
    },

    /* 官方同意按钮：open-type="agreePrivacyAuthorization" 回调 */
    onAgree() {
      this.setData({ visible: false })
      // 通知页面「弹窗已收」：新手引导靠这个回调接上，两个弹层不叠着弹
      this.triggerEvent('close')
    },

    /* 暂不同意 / 点蒙层：只收起，不缓存「已拒绝」（下次仍会询问） */
    onDisagree() {
      this.setData({ visible: false })
      this.triggerEvent('close')
    },

    /* 跳协议全文页（弹窗保持：返回后继续完成同意/不同意） */
    goAgreement() {
      wx.navigateTo({ url: '/pages/agreement/agreement?tab=privacy' })
    },

    goTerms() {
      wx.navigateTo({ url: '/pages/agreement/agreement?tab=terms' })
    },

    /* 空实现：挡住蒙层关闭（bindtap 冒泡拦截） */
    noop() {}
  }
})
