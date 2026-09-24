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
 *   - 点【保存】/【编辑】/【确认分享】（海报·复制）/转发卡片，都会写入日记本（[summary-share-align v1]：
 *     确认分享成功后与【保存】同款回到日记本）；直接返回不保存；
 *   - 【编辑】为了让日记详情页的编辑态能复用，先把这篇落库成「草稿」再跳详情页编辑；
 *     若用户在详情页取消或未保存返回，详情页会回滚删除这篇草稿（传 draft=1 参数识别）；
 *   - 保存的总结日记带 entryType: 'summary' + tags: ['AI总结']：不参与后续 AI 总结（见 summary 页 isAiSummaryDiary）。
 */
const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const reminder = require('../../utils/reminder.js')
const app = getApp()

const fontSetting = require('../../utils/fontSetting.js')
const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const appInfo = require('../../utils/appInfo.js') // [share-card v1] 分享卡片品牌图引用
const shareCard = require('../../utils/shareCard.js') // 分享卡片品牌图探活与兜底

Page({
  data: {
    // 「日记字体」设置注入的 CSS 变量串：字号/字体作用于本页 UGC 正文
    fontStyle: '',
    prompt: '',        // 本次总结需求（如「提取我所有的运动」）
    content: '',       // 总结正文
    contentBlocks: [], // 正文拆行结果（小标题行 heading=true，wxml 逐行渲染加粗）
    title: '',         // X月X日 AI总结
    createdAt: '',     // 展示用完整日期
    rangeText: '',     // 数据范围文案（如「最近一个月」）
    diaryCount: 0,     // 参与分析的有效篇数
    truncated: false,  // 是否因日记过多只选取了最近部分
    outputTruncated: false, // [summary-token-cap v1] 是否因输出长度上限被截断（内容未生成完）
    showSharePanel: false,
    shareDiary: null,  // 分享组件用的 view model
    busy: false        // 保存/编辑落库进行中：三个按钮置灰，防重复点击产生重复日记/草稿
  },

  onShow() {
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
  },

  onLoad() {
    this.setData({ fontStyle: fontSetting.buildStyle() })
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
    // [summary-share-align v1] 说明头数据源：setData 尚未执行，须用 payload 局部值而非 this.data
    const src = {
      prompt: String(p.prompt || '').trim(),
      rangeText: p.rangeText || '所选时间段',
      diaryCount: p.diaryCount || 0,
      truncated: !!p.truncated,
      outputTruncated: !!p.outputTruncated
    }
    this.setData({
      prompt: String(p.prompt || '').trim(),
      content: content,
      contentBlocks: util.buildContentLines(content),
      title: title,
      createdAt: createdAt,
      rangeText: p.rangeText || '所选时间段',
      diaryCount: p.diaryCount || 0,
      truncated: !!p.truncated,
      outputTruncated: !!p.outputTruncated,
      // [summary-share-align v1] 分享视图模型与落库口径对齐：
      //   正文 = 说明头（总结需求/分析范围）+ 总结正文（与 buildDiaryData 同一拼装，幂等）
      //   心情标签 = 与保存后同源（mood 'neutral' → util.getMood*），海报/复制与保存后的分享完全一致
      shareDiary: {
        id: '',
        title: title,
        createdAt: createdAt,
        content: (content.indexOf('【总结需求】') === 0) ? content : this.buildBriefBlock(src) + '\n\n' + content,
        moodText: util.getMoodLabel('neutral'),
        moodColor: util.getMoodColor('neutral'),
        moodBg: util.getMoodBg('neutral'),
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

  // [summary-share-align v1] 转发卡片先落库（拍板③）：卡片直达这篇日记的详情页；
  // 落库失败退回写日记主页（与旧兜底一致）。不配「取消分享删草稿」（拍板③明确）
  onShareAppMessage() {
    const id = this.ensureDiarySaved()
    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图
    return shareCard.build({
      title: this.data.title || '我的 AI 总结',
      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'
    })
  },

  // [summary-share-align v1] 未落库则先落库（幂等），返回日记 id（失败空串）。
  // 确认分享与转发共用：分享即定稿，落库后后续动作（海报二维码/转发路径）都指向这篇日记
  ensureDiarySaved() {
    if (this._savedId) return this._savedId
    const saved = storage.saveDiary(this.buildDiaryData())
    if (!saved) return ''
    this._savedId = saved.id
    app.globalData.needRefresh = true
    return saved.id
  },

  // [summary-share-align v1] 组件请求先落库（need-saved-diary）：落库后带新 id 让组件继续原分享动作
  onShareNeedSave() {
    const id = this.ensureDiarySaved()
    if (!id) {
      wx.showToast({ title: '保存失败', icon: 'none' })
      this.setData({ showSharePanel: false })
      return
    }
    const sd = Object.assign({}, this.data.shareDiary, { id: id })
    this.setData({ shareDiary: sd })
    const sheet = this.selectComponent('#shareSheet')
    if (sheet) sheet.continueShare(sd)
  },

  // [summary-share-align v1] 分享动作完成（海报已存相册/文字已复制）：与【保存】同款回到日记本
  onShareSheetShared() {
    const id = this.ensureDiarySaved()
    if (!id || this._saving) return
    this._saving = true
    this.setData({ busy: true })
    reminder.callMarkWritten(util.getDateKey())
    wx.showToast({ title: '已保存到日记本', icon: 'success' })
    // reLaunch 清掉智能总结/结果页栈，避免返回看到旧状态（与 onSave 一致）
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
  },

  // ===================== 编辑 =====================
  // 先落库成草稿 → 进日记详情编辑页（复用其完整编辑能力）；未保存返回则草稿被回滚删除
  onEdit() {
    if (this._saving) return
    // [summary-share-align v1] 已因分享落库过：直接编辑那篇真日记（不带 draft=1，取消不删除），
    // 避免再落库产生第二份相同内容
    if (this._savedId) {
      wx.navigateTo({ url: '/pages/detail/detail?id=' + this._savedId + '&edit=1' })
      return
    }
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
    // [summary-share-align v1] 已因分享落库过：不重复落库，直接按保存完成的流程回日记本
    if (this._savedId) {
      this._saving = true
      this.setData({ busy: true })
      wx.showToast({ title: '已保存到日记本', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
      return
    }
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
  buildBriefBlock(src) {
    // [summary-share-align v1] 支持传入数据源（initFromPayload 时 this.data 还没更新）
    const d = src || this.data
    // [summary-token-cap v1] 两种「不完整」都要如实标注：输入被裁剪 / 输出被截断。
    // 落库正文自带说明，避免事后只看到一段半截内容却无从判断原因
    const notes = []
    if (d.truncated) notes.push('日记较多，已选取最近部分')
    if (d.outputTruncated) notes.push('内容较长，本次生成未完成')
    const range = '共读取' + (d.rangeText || '所选时间段') + ' ' + (d.diaryCount || 0) + ' 篇日记进行分析' +
      (notes.length ? '（' + notes.join('；') + '）' : '')
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
