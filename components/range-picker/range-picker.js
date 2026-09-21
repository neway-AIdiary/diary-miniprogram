/**
 * components/range-picker
 * 日期范围选择胶囊 + 底部弹层，日记本页（pages/index）与智能总结页（pages/summary）共用。
 * 口径唯一来源：utils/dateRange.js（本组件不自行实现任何区间规则）。
 *
 * 契约：
 * - 自持状态，对外只发 change 事件：detail = { range, label, customStart, customEnd, startTs, endTs }
 *   （startTs/endTs 已解析：all → 双 null；custom 未完成的选择绝不 emit）
 * - 「自定义起止日期」两个日期都选完立即生效并关闭（无「确定」按钮）
 * - 点遮罩关闭弹层：未生效的草稿选择一律丢弃（不污染已生效范围）
 * - getRange()：任意时刻取当前生效范围（页面生成总结等场景用）
 * - reset()：回到「全部时间」并 emit change（导入成功后清范围等场景用）
 */
const dateRange = require('../../utils/dateRange.js')

Component({
  properties: {
    // [range-detail v1] 日记本页传 diary-detail：胶囊右侧显示「所有日记/本月日记/上月日记…」；
    // 默认 false（智能总结页等），保持原样（仅自定义范围显示起止日期）
    diaryDetail: { type: Boolean, value: false }
  },

  data: {
    rangeList: dateRange.RANGE_LIST,
    range: 'all',        // 已生效范围
    draftKey: 'all',     // 弹层内草稿选项（高亮 / 展开自定义日期区）
    label: '全部时间',   // 胶囊文案
    detail: '',          // 自定义生效时胶囊右侧「X 至 Y」
    showSheet: false,
    draftStart: '',
    draftEnd: ''
  },

  lifetimes: {
    attached() {
      this._snapshot = { range: 'all', customStart: '', customEnd: '' }
      if (this.properties.diaryDetail) this.setData({ detail: '所有日记' }) // [range-detail v1]
    }
  },

  methods: {
    // ===== 弹层开关 =====
    openSheet() {
      // 打开时记快照：关闭弹层时丢弃一切未生效的草稿选择
      this._snapshot = { range: this.data.range, customStart: this.data.customStart, customEnd: this.data.customEnd }
      this.setData({ showSheet: true, draftKey: this.data.range, draftStart: this.data.customStart, draftEnd: this.data.customEnd })
    },

    closeSheet() {
      // 点遮罩 = 取消本次弹层内的所有操作，回到打开前状态
      const s = this._snapshot || { range: 'all', customStart: '', customEnd: '' }
      this.setData({
        showSheet: false,
        range: s.range,
        draftKey: s.range,
        label: dateRange.labelOf(s.range),
        detail: this._detailFor(s.range, s.customStart, s.customEnd),
        customStart: s.customStart,
        customEnd: s.customEnd
      })
    },

    // ===== 弹层内选择 =====
    selectOption(e) {
      const key = e.currentTarget.dataset.key
      const item = dateRange.RANGE_LIST.find(r => r.key === key)
      if (!item) return
      if (key === 'custom') {
        // 只切草稿视图，展开日期区，等两个日期都选完才生效
        this.setData({ draftKey: 'custom' })
        return
      }
      // 非自定义：立即生效并关闭
      this.setData({ range: key, draftKey: key, label: item.label, detail: this._detailFor(key, '', ''), showSheet: false })
      this._emit()
    },

    onDraftStart(e) {
      this.setData({ draftStart: e.detail.value })
      this._tryApplyCustom()
    },

    onDraftEnd(e) {
      this.setData({ draftEnd: e.detail.value })
      this._tryApplyCustom()
    },

    // 自定义日期：两个都选完 → 立即生效并关闭（选完即生效，不设「确定」按钮）
    _tryApplyCustom() {
      const cs = this.data.draftStart
      const ce = this.data.draftEnd
      if (!cs || !ce) return // 还没选完，保持弹层打开
      if (cs > ce) {
        wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' })
        return
      }
      this.setData({
        range: 'custom',
        draftKey: 'custom',
        customStart: cs,
        customEnd: ce,
        label: dateRange.labelOf('custom'),
        detail: this._detailFor('custom', cs, ce),
        showSheet: false
      })
      this._emit()
    },

    // 胶囊右侧说明文字 [range-detail v1]（口径：utils/dateRange.js）
    // - diaryDetail=false（默认，总结页）：仅自定义范围显示「X月X日 至 X月X日」
    // - diaryDetail=true（日记本页）：全部时间→所有日记；本月→本月日记；上月→上月日记；
    //   近 7 天→近 7 天日记；自定义→仍显示起止日期（不带「日记」字样）
    _detailFor(range, cs, ce) {
      if (range === 'custom') {
        return (cs && ce) ? dateRange.rangeText('custom', cs, ce) : ''
      }
      if (!this.properties.diaryDetail) return ''
      if (range === 'all') return '所有日记'
      return dateRange.rangeText(range, cs, ce) + '日记'
    },

    // ===== 对外接口 =====
    _emit() {
      this.triggerEvent('change', this.getRange())
    },

    getRange() {
      const { range, customStart, customEnd } = this.data
      const { start, end } = dateRange.resolveRange(range, customStart, customEnd)
      return { range, label: this.data.label, customStart, customEnd, startTs: start, endTs: end }
    },

    reset() {
      this.setData({
        range: 'all',
        draftKey: 'all',
        label: '全部时间',
        detail: this._detailFor('all', '', ''),
        customStart: '',
        customEnd: '',
        draftStart: '',
        draftEnd: ''
      })
      this._emit()
    }
  }
})
