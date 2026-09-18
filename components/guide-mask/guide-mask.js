/**
 * 新手引导遮罩（纯展示组件）
 *
 * 职责边界：**只画不动**。
 *   - 不查存储、不管步骤表、不跳页面（那些在 utils/guide.js 与页面里）
 *   - 页面把「当前步 + 目标矩形」传进来，这里只负责算位置 + 渲染
 *   - 交互通过事件抛回页面：bind:next / bind:skip
 *
 * 遮罩形态（3.A 聚光灯）：
 *   全屏拦截层（.gm-catch，吃掉所有触摸，防止引导期间误触页面）
 *   + 高亮孔（.gm-spot，用 `box-shadow: 0 0 0 9999rpx <遮罩色>` 反向挖孔，配上过渡平滑移动）
 *   + 文案卡（.gm-card，颜色全走主题令牌 → 深浅色自动适配）
 *
 * 位置计算全在 utils/guide.js 的纯函数里（buildView / placeCard），本组件只做「取值 → setData」。
 * 卡片高度先按估值放，渲染后实测一次再重算（只重算一次，避免抖动）。
 */
const guide = require('../../utils/guide.js')

Component({
  properties: {
    visible: { type: Boolean, value: false },
    // 当前步：{ title, desc, buttonText, index, total }
    step: { type: Object, value: {} },
    // 目标矩形（页面测好传来）：{ left, top, width, height }，拿不到传 null
    rect: { type: Object, value: null },
    // 高亮孔形状：'pill' | 'rect'
    shape: { type: String, value: 'rect' }
  },

  data: {
    view: null
  },

  observers: {
    'visible, rect, shape': function (visible, rect, shape) {
      if (!visible) {
        this.setData({ view: null })
        return
      }
      this._fitted = false
      this._build(rect, shape, 0)
    }
  },

  methods: {
    /* 一帧渲染后实测卡片真实高度，重算一次位置（估值 vs 真实行数可能有差） */
    _fitCard() {
      if (this._fitted) return
      this._fitted = true
      const self = this
      wx.nextTick(function () {
        self.createSelectorQuery().select('.gm-card').boundingClientRect().exec(function (res) {
          const r = res && res[0]
          if (!r || !r.height) return
          self._build(self.data.rect, self.data.shape, r.height)
        })
      })
    },

    _build(rect, shape, cardHeight) {
      const view = guide.buildView(rect, shape, { cardHeight: cardHeight || 0 })
      this.setData({ view: view })
      if (!cardHeight) this._fitCard()
    },

    onNext() {
      this.triggerEvent('next')
    },

    onSkip() {
      this.triggerEvent('skip')
    },

    /* 空实现：拦截层上的点击/滑动（catch 绑定不会冒泡到页面） */
    noop() {}
  }
})
