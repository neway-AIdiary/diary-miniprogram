/**
 * 4 位数字密码键盘（圆点 + 自绘键盘）
 *
 * 为什么自绘：不用系统键盘，避免遮挡与风格割裂，键盘与圆点在同一块面板里。
 * 用法：
 *   <pin-pad id="pad" show-forget="{{true}}" bind:complete="onComplete" bind:forget="onForget" />
 *   外部通过 selectComponent('#pad').fail('密码不对') / .clear() / .setError('...') 反馈
 * 输入满 4 位触发 complete{code}（延迟 60ms 让圆点先点亮，视觉上不跳）
 */
Component({
  properties: {
    // 是否显示「忘记密码？」
    showForget: { type: Boolean, value: false },
    // 冻结/禁用态：键盘不响应
    disabled: { type: Boolean, value: false }
  },

  data: {
    code: '',
    error: '',
    shake: false,
    keys: [
      { k: '1' }, { k: '2' }, { k: '3' },
      { k: '4' }, { k: '5' }, { k: '6' },
      { k: '7' }, { k: '8' }, { k: '9' },
      { k: '' }, { k: '0' }, { k: 'del' }
    ]
  },

  methods: {
    onKey(e) {
      if (this.data.disabled) return
      const k = e.currentTarget.dataset.k
      if (!k) return
      if (k === 'del') {
        this.setData({ code: this.data.code.slice(0, -1), error: '' })
        return
      }
      const next = this.data.code + k
      if (next.length > 4) return
      this.setData({ code: next, error: '' })
      if (next.length === 4) {
        const self = this
        setTimeout(function () { self.triggerEvent('complete', { code: next }) }, 60)
      }
    },

    onForget() {
      if (this.data.disabled) return
      this.triggerEvent('forget')
    },

    // 清空输入（外部在切换阶段时调用）
    clear() {
      this.setData({ code: '', error: '' })
    },

    // 只改提示文案，不动已输入内容
    setError(msg) {
      this.setData({ error: msg || '' })
    },

    // 校验失败：清空 + 抖动 + 提示
    fail(msg) {
      const self = this
      this.setData({ code: '', error: msg || '密码不对，请重试', shake: true })
      setTimeout(function () { self.setData({ shake: false }) }, 420)
    }
  }
})
