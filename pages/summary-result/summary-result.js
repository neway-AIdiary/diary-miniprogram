/**
 * 总结结果页 pages/summary-result
 * 承接「智能总结」的生成结果：不在智能总结页就地展示，独立成页做阅读/分享/编辑/保存。
 *
 * 显示框架复用日记详情页（卡片 + 固定标题 + meta + 独立滚动正文），差异：
 *   页面标题「总结结果」；日记标题「X月X日 AI总结」；正文顶部先给「总结需求 + 数据范围」；
 *   底部三按钮 = 分享 / 编辑 / 保存。
 *
 * 数据来源：智能总结页通过 eventChannel('summaryResult') 传入（正文可能几千字，不走 URL 传参），
 *          兜底读 app.globalData.summaryResult。
 *
 * 保存规则（关键）：
 *   - 只有点【保存】、或【编辑】后保存，才写入日记本；直接返回不保存；
 *   - 【编辑】为了让日记详情页的编辑态能复用，先把这篇落库成「草稿」再跳详情页编辑；
 *     若用户在详情页取消或未保存返回，详情页会回滚删除这篇草稿（传 draft=1 参数识别）；
 *   - 保存的总结日记带 entryType: 'summary' + tags: ['AI总结']：不参与后续 AI 总结（见 summary 页 isAiSummaryDiary）。
 */
const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const reminder = require('../../utils/reminder.js')
const app = getApp()

Page({
  data: {
    prompt: '',        // 本次总结需求（如「提取我所有的运动」）
    content: '',       // 总结正文
    contentBlocks: [], // 正文拆行结果（小标题行 heading=true，wxml 逐行渲染加粗）
    title: '',         // X月X日 AI总结
    createdAt: '',     // 展示用完整日期
    rangeText: '',     // 数据范围文案（如「最近一个月」）
    diaryCount: 0,     // 参与分析的有效篇数
    truncated: false,  // 是否因日记过多只选取了最近部分
    showSharePanel: false,
    shareDiary: null,  // 分享组件用的 view model
    busy: false        // 保存/编辑落库进行中：三个按钮置灰，防重复点击产生重复日记/草稿
  },

  onLoad() {
    const ch = this.getOpenerEventChannel ? this.getOpenerEventChannel() : null
    if (ch && ch.on) {
      ch.on('summaryResult', (payload) => this.initFromPayload(payload))
    }
    // 兜底：eventChannel 未取到数据时读全局临时结果（均为内存数据，返回即丢弃）
    setTimeout(() => {
      if (!this._inited) this.initFromPayload(app.globalData.summaryResult)
    }, 100)
  },

  onUnload() {
    if (this._saving) app.globalData.needRefresh = true
  },

  // 载入总结结果
  initFromPayload(payload) {
    const p = payload || {}
    const content = String(p.content || '').trim()
    if (!content) {
      wx.showToast({ title: '总结内容为空', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    this._inited = true
    const createdAt = util.formatFullDate(new Date().toISOString())
    const title = util.getDefaultTitle().replace(/日记$/, 'AI总结')
    this.setData({
      prompt: String(p.prompt || '').trim(),
      content: content,
      contentBlocks: util.buildContentLines(content),
      title: title,
      createdAt: createdAt,
      rangeText: p.rangeText || '所选时间段',
      diaryCount: p.diaryCount || 0,
      truncated: !!p.truncated,
      // 分享组件所需的 diary view model（形态与详情页一致）
      shareDiary: {
        id: '',
        title: title,
        createdAt: createdAt,
        content: content,
        moodText: '',
        moodColor: '',
        moodBg: '',
        tags: ['AI总结'],
        images: [],
        locationText: '',
        weatherText: '',
        weatherIcon: ''
      }
    })
  },

  // ===================== 分享（与日记详情页共用组件） =====================
  openSharePanel() {
    if (this._saving) return // 保存/编辑落库进行中不再弹分享
    this.setData({ showSharePanel: true })
  },

  closeSharePanel() {
    this.setData({ showSharePanel: false })
  },

  // 分享卡片内容：未保存的总结没有详情页可打开，退回写日记主页，避免分享出失效链接
  onShareAppMessage() {
    const id = this._savedId || ''
    return {
      title: this.data.title || '我的 AI 总结',
      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'
    }
  },

  // ===================== 编辑 =====================
  // 先落库成草稿 → 进日记详情编辑页（复用其完整编辑能力）；未保存返回则草稿被回滚删除
  onEdit() {
    if (this._saving) return
    const draft = storage.saveDiary(this.buildDiaryData())
    if (!draft) {
      wx.showToast({ title: '保存失败', icon: 'none' })
      return
    }
    // 防重复：草稿已落库，双击/连点不能再产生第二份草稿
    this._saving = true
    this.setData({ busy: true })
    app.globalData.needRefresh = true
    wx.navigateTo({ url: '/pages/detail/detail?id=' + draft.id + '&edit=1&draft=1' })
  },

  // ===================== 保存 =====================
  onSave() {
    if (this._saving) return
    const saved = storage.saveDiary(this.buildDiaryData())
    if (!saved) {
      wx.showToast({ title: '保存失败', icon: 'none' })
      return
    }
    this._saving = true
    this.setData({ busy: true })
    this._savedId = saved.id
    app.globalData.needRefresh = true
    // 上报今天已写（与写日记一致，避免闹钟误提醒）
    reminder.callMarkWritten(util.getDateKey())
    wx.showToast({ title: '已保存到日记本', icon: 'success' })
    // 保存后展示日记本页（reLaunch 清掉智能总结/结果页栈，避免返回看到旧状态）
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
  },

  // 说明头（两行式）：落库时拼到正文顶部，日记本里可追溯本次总结的需求与数据范围。
  // 页面展示与分享都不用它——结果页顶部有独立的说明卡，分享只发纯总结正文。
  buildBriefBlock() {
    const d = this.data
    const range = '共读取' + (d.rangeText || '所选时间段') + ' ' + (d.diaryCount || 0) + ' 篇日记进行分析' +
      (d.truncated ? '（日记较多，已选取最近部分）' : '')
    return '【总结需求】' + (d.prompt || '（未填写需求）') + '\n【分析范围】' + range
  },

  // 待写入日记本的数据（保存 / 编辑草稿共用）
  buildDiaryData() {
    const brief = this.buildBriefBlock()
    const body = this.data.content || ''
    // 幂等保护：编辑后正文已带说明头时不再重复拼接
    const content = body.indexOf('【总结需求】') === 0 ? body : brief + '\n\n' + body
    return {
      title: this.data.title,
      content: content,
      mood: 'neutral',
      source: 'ai',
      entryType: 'summary', // 标记「AI 总结」产物：不参与后续 AI 总结
      tags: ['AI总结'],
      location: null,
      media: [],
      weather: null,
      created_at: new Date().toISOString()
    }
  }
})
