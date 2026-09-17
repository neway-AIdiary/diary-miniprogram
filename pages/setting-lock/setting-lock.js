/**
 * 日记本密码设置页
 *
 * 三段式输入流程（同一个键盘弹层，靠 padStage 切换）：
 *   set     → 设置 4 位密码（第一次）
 *   confirm → 再次输入确认，一致才落库
 *   verify  → 关闭 / 修改前先验证当前密码（padAction = 'close' | 'change'）
 *
 * 开关用 wx:if 包在弹层外：弹层打开时 switch 被销毁，关闭弹层时按最新 enabled 重建，
 * 这样「取消」后开关能自动回弹到真实状态（受控组件的常见坑）。
 */
const lock = require('../../utils/lock.js')
const theme = require('../../utils/theme.js')

Page({
  data: {
    themeClass: '',
    enabled: false,
    padOpen: false,
    padStage: '',
    padAction: '',
    padTitle: ''
  },

  onLoad() {
    this._pending = ''
  },

  onShow() {
    theme.applyTo(this)
    this.setData({ enabled: lock.isEnabled() })
  },

  pad() {
    return this.selectComponent('#pad')
  },

  tapFeedback() {
    try {
      wx.vibrateShort({ type: 'light' })
    } catch (e) { /* 静默 */ }
  },

  // ===== 弹层开合 =====
  startStage(stage, action) {
    const titles = {
      set: '设置 4 位密码',
      confirm: '再次输入确认',
      verify: action === 'change' ? '输入当前密码以修改' : '输入当前密码以关闭'
    }
    // 只有重新进入「设置」阶段才作废上次输入；confirm 阶段必须沿用 set 阶段存下的 pending
    if (stage === 'set') this._pending = ''
    this.setData({
      padOpen: true,
      padStage: stage,
      padAction: action || '',
      padTitle: titles[stage] || ''
    }, () => {
      const pad = this.pad()
      if (pad) {
        pad.clear()
        const left = lock.freezeLeft()
        if (left > 0) pad.setError('尝试次数过多，请 ' + left + ' 秒后再试')
        else pad.setError('')
      }
    })
  },

  onCancelPad() {
    this._pending = ''
    this.setData({ padOpen: false, padStage: '', padAction: '', padTitle: '' })
  },

  // ===== 开关 =====
  onToggleSwitch(e) {
    const on = !!e.detail.value
    this.tapFeedback()
    if (on) this.startStage('set', '')
    else this.startStage('verify', 'close')
  },

  // 修改密码：先验证旧的
  onChangeCode() {
    this.startStage('verify', 'change')
  },

  // ===== 输满 4 位 =====
  onPadComplete(e) {
    const code = (e.detail && e.detail.code) || ''
    const stage = this.data.padStage

    if (stage === 'verify') {
      const r = lock.attempt(code)
      if (r.ok) {
        this.afterVerify()
      } else if (r.freeze > 0) {
        const pad = this.pad()
        if (pad) pad.fail('尝试次数过多，请 ' + r.freeze + ' 秒后再试')
      } else {
        const pad = this.pad()
        if (pad) pad.fail('密码不对，请重试')
        this.tapFeedback()
      }
      return
    }

    if (stage === 'set') {
      this._pending = code
      this.startStage('confirm', this.data.padAction)
      return
    }

    if (stage === 'confirm') {
      if (code === this._pending) {
        // setData 会同步改写 this.data，先取出 action 再清空
        const isChange = this.data.padAction === 'change'
        lock.setCode(code)
        this._pending = ''
        this.setData({ enabled: true, padOpen: false, padStage: '', padAction: '', padTitle: '' })
        wx.showToast({ title: isChange ? '密码已修改' : '密码已开启', icon: 'none' })
      } else {
        this._pending = ''
        this.setData({ padStage: 'set', padTitle: '设置 4 位密码' })
        const pad = this.pad()
        if (pad) pad.fail('两次输入不一致，请重新设置')
      }
    }
  },

  // 验证通过后的分流：关闭密码 / 进入设置新密码
  afterVerify() {
    const action = this.data.padAction
    if (action === 'close') {
      lock.clear()
      this._pending = ''
      this.setData({ enabled: false, padOpen: false, padStage: '', padAction: '', padTitle: '' })
      wx.showToast({ title: '密码已关闭', icon: 'none' })
      return
    }
    // 修改：接着输新密码（第一次）
    this.setData({ padStage: 'set', padTitle: '设置 4 位密码' })
    const pad = this.pad()
    if (pad) { pad.clear(); pad.setError('') }
  }
})
