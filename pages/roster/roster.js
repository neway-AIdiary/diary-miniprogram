/**
 * 花名册页 [roster v1]
 * 入口：档案页底栏表情按钮（原在档案页置灰弃用）。一键提取人名 → 确认面板 → 注入语音热词。
 * 主题机制与全站一致：onShow 调 theme.applyTo(this)；首帧由 utils/firstPaint.js 兜底。
 */
const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const theme = require('../../utils/theme.js')
const roster = require('../../utils/roster.js')
const aiCloud = require('../../utils/aiCloud.js')

Page({
  data: {
    fontStyle: '',
    items: [],          // 花名册 [{ name, count, lastDate }]
    count: 0,
    safeAreaBottom: 0,
    extracting: false,
    panelShow: false,
    candidates: [],     // [{ name, count, lastDate, checked }]
    checkedCount: 0
  },

  onLoad() {
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      safeAreaBottom: (win.safeArea && win.screenHeight - win.safeArea.bottom) || 0
    })
  },

  onShow() {
    theme.applyTo(this)
    this.refresh()
  },

  refresh() {
    const list = roster.getList()
    this.setData({ items: list, count: list.length })
  },

  // ===== 一键提取 =====

  onExtract() {
    if (this.data.extracting) return
    if (this.data.count >= roster.MAX_ROSTER) {
      wx.showToast({ title: '花名册已满 100 个', icon: 'none' })
      return
    }
    const diaries = (storage.getAllDiaries() || []).map(function (d) {
      return {
        dateKey: d && d.created_at ? util.getDateKey(new Date(d.created_at)) : '',
        content: String((d && d.content) || '')
      }
    })
    this.setData({ extracting: true })
    wx.showLoading({ title: '正在翻日记…', mask: true })
    // setTimeout 让 loading 先上屏再跑提取（154 篇量级本地规则 <1s）
    setTimeout(() => {
      try {
        const existing = roster.getNames()
        const cap = roster.MAX_ROSTER - existing.length
        const cands = roster.extractCandidates(diaries, existing, cap)
        wx.hideLoading()
        this.setData({ extracting: false })
        if (!cands.length) {
          wx.showToast({ title: '没有发现新名字', icon: 'none' })
          return
        }
        const rows = cands.map(function (c) {
          return { name: c.name, count: c.count, lastDate: c.lastDate, checked: true }
        })
        this.setData({ panelShow: true, candidates: rows, checkedCount: rows.length })
      } catch (e) {
        wx.hideLoading()
        this.setData({ extracting: false })
        console.warn('[roster] 提取失败:', e)
        wx.showToast({ title: '提取失败，请重试', icon: 'none' })
      }
    }, 50)
  },

  onToggle(e) {
    const name = e.currentTarget.dataset.name
    let checked = 0
    const rows = this.data.candidates.map(function (c) {
      if (c.name === name) c.checked = !c.checked
      if (c.checked) checked++
      return c
    })
    this.setData({ candidates: rows, checkedCount: checked })
  },

  onPanelCancel() {
    this.setData({ panelShow: false, candidates: [], checkedCount: 0 })
  },

  onPanelConfirm() {
    const picked = this.data.candidates.filter(function (c) { return c.checked })
    if (!picked.length) {
      this.onPanelCancel()
      return
    }
    const added = roster.addNames(picked)
    this.onPanelCancel()
    this.refresh()
    wx.showToast({ title: '已添加 ' + added + ' 个名字', icon: 'none' })
    this.maybeAiReview()
  },

  // [roster-filter v1] 满 100 后自动触发一次 AI 复核：静默剔除 AI 判定的非人名（含「张部/王总」类带职位头衔的称呼）。
  // 失败静默降级不动名单，下次确认添加时重试；成功才标记本轮已完成，绝不重复调用。
  maybeAiReview() {
    if (!roster.needsAiReview()) return
    const that = this
    aiCloud.callAIRosterReview(roster.getNames()).then(function (kept) {
      if (!Array.isArray(kept)) return
      roster.keepOnly(kept)
      roster.markAiReviewDone()
      that.refresh()
    })
  },

  // ===== 长按删除（先确认防误触） =====

  onRemoveName(e) {
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除名字',
      content: '将「' + name + '」移出花名册？',
      confirmText: '删除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return
        roster.removeName(name)
        this.refresh()
      }
    })
  }
})
