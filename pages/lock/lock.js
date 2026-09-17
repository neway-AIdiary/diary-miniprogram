/**
 * 锁屏页（日记本密码）
 *
 * 进入方式：app.onShow / 各页 onShow 守卫判定后 wx.reLaunch 过来（页面栈被清空，
 * 因此物理返回键退不回内容页）。未开启密码或本会话已解锁时进到本页 → 直接回首页。
 *
 * 交互：输满 4 位自动校验 → 通过则回首页；失败清空 + 抖动 + 震动；
 *      连错 5 次冻结 30 秒（倒计时禁用键盘）；底部「忘记密码？」清空密码进入。
 */
const lock = require('../../utils/lock.js')
const theme = require('../../utils/theme.js')

Page({
  data: {
    themeClass: '',
    statusBarTop: 20,
    frozenLeft: 0
  },

  onLoad() {
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const statusBarHeight = win.statusBarHeight || 20
    const safeTop = Math.max((win.safeArea && win.safeArea.top) || 0, statusBarHeight, 20)
    this.setData({ statusBarTop: safeTop })
  },

  onShow() {
    theme.applyTo(this)
    // 未开启密码 / 本会话已解锁：本页不该停留
    if (!lock.isEnabled() || lock.isSessionUnlocked()) {
      lock.goHome()
      return
    }
    this.syncFreeze()
  },

  onHide() {
    this.stopFreezeTimer()
  },

  onUnload() {
    this.stopFreezeTimer()
  },

  pad() {
    return this.selectComponent('#pad')
  },

  // ===== 冻结倒计时 =====
  syncFreeze() {
    const left = lock.freezeLeft()
    if (left <= 0) {
      this.setData({ frozenLeft: 0 })
      return
    }
    this.enterFreeze(left)
  },

  enterFreeze(sec) {
    this.setData({ frozenLeft: sec })
    this.renderFreezeHint(sec)
    this.stopFreezeTimer()
    this._freezeTimer = setInterval(() => {
      const left = lock.freezeLeft()
      if (left <= 0) {
        this.stopFreezeTimer()
        this.setData({ frozenLeft: 0 })
        const pad = this.pad()
        if (pad) pad.setError('')
        return
      }
      this.setData({ frozenLeft: left })
      this.renderFreezeHint(left)
    }, 1000)
  },

  renderFreezeHint(sec) {
    const pad = this.pad()
    if (!pad) return
    pad.clear()
    pad.setError('尝试次数过多，请 ' + sec + ' 秒后再试')
  },

  stopFreezeTimer() {
    if (this._freezeTimer) {
      clearInterval(this._freezeTimer)
      this._freezeTimer = null
    }
  },

  tapFeedback(type) {
    try {
      wx.vibrateShort({ type: type || 'medium' })
    } catch (e) { /* 部分机型不支持，静默 */ }
  },

  // ===== 输满 4 位 =====
  onComplete(e) {
    const code = (e.detail && e.detail.code) || ''
    const r = lock.attempt(code)

    if (r.ok) {
      this.stopFreezeTimer()
      lock.goHome()
      return
    }

    // 冻结中（本次尝试未被计数）
    if (r.freeze > 0) {
      this.enterFreeze(r.freeze)
      return
    }

    const pad = this.pad()
    if (pad) pad.fail('密码不对，请重试')
    this.tapFeedback('medium')
  },

  // ===== 忘记密码：清空密码后进入（日记不删）=====
  onForget() {
    if (this.data.frozenLeft > 0) return
    wx.showModal({
      title: '忘记密码？',
      content: '清除密码后可直接进入日记本，你的日记不会丢失。需要时可在「设置 → 日记本密码」重新开启。',
      confirmText: '清除密码',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        lock.clear()
        wx.showToast({ title: '密码已清除', icon: 'none' })
        setTimeout(() => lock.goHome(), 700)
      }
    })
  }
})
