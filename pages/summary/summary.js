/**
 * 智能总结页 pages/summary
 * 全局批量日记分析：文字/语音输入需求 → 前端本地读日记按时间筛选 → 云函数 aiSummary 调大模型 → 生成总结
 * 支持：时间范围筛选、快捷模板、复制结果、保存为日记、重新提问
 */
const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const voice = require('../../utils/voice.js')
const reminder = require('../../utils/reminder.js')
const app = getApp()

// 时间范围选项（弹层内选择，选择「自定义起止日期」时再展开两个日期 picker）
const RANGE_LIST = [
  { key: 'all', label: '全部时间' },
  { key: 'month', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'week7', label: '近 7 天' },
  { key: 'custom', label: '自定义起止日期' }
]

// 快捷模板（点击自动填充输入框）
const SHORTCUTS = [
  { label: '📅 本月日记整体回顾', fill: '帮我回顾一下这段时间的日记，做个整体总结' },
  { label: '😊 分析这段时间情绪变化', fill: '帮我分析所选时间段内我的情绪变化，简单总结' },
  { label: '🏷️ 按标签汇总日记内容', fill: '按标签汇总我的日记内容' },
  { label: '📊 统计工作相关记录', fill: '统计这段时间里工作相关的记录' },
  { label: '📖 生成年度简短回顾', fill: '生成一段简短的年度回顾' },
  { label: '🔍 提取所有运动记录', fill: '提取我所有的运动记录' }
]

// 轻量 markdown → HTML（支持换行分段、- 列表、**加粗**）
function markdownToHtml(text) {
  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = String(text || '').split('\n')
  let html = ''
  let inList = false
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) {
      if (inList) { html += '</ul>'; inList = false }
      continue
    }
    let body = escape(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    if (/^[-•*]\s+/.test(t)) {
      if (!inList) { html += '<ul>'; inList = true }
      html += '<li>' + body.replace(/^[-•*]\s+/, '') + '</li>'
    } else {
      if (inList) { html += '</ul>'; inList = false }
      html += '<p>' + body + '</p>'
    }
  }
  if (inList) html += '</ul>'
  return html
}

Page({
  data: {
    rangeList: RANGE_LIST,
    range: 'all',           // all | month | lastMonth | week7 | custom
    rangeLabel: '全部时间',
    showRangePicker: false,
    customStart: '',
    customEnd: '',
    prompt: '',
    loading: false,
    hasResult: false,
    error: '',
    result: '',
    resultHtml: '',
    diaryCount: 0,
    truncated: false,
    shortcuts: SHORTCUTS,
    // 语音状态
    recording: false,
    connecting: false,
    transcribing: false,
    voiceCanceling: false,
    liveText: ''
  },

  onLoad() {
    // 订阅全局录音状态
    this._offVoiceState = voice.onStateChange((s) => {
      this.setData({
        recording: s.recording,
        connecting: s.connecting || false,
        transcribing: s.transcribing,
        voiceCanceling: false,
        liveText: s.liveText || ''
      })
    })
  },

  onShow() {
    // 注册语音目标：按住说话识别结果填入输入框
    this._voiceHandle = (text) => this.appendPrompt(text)
    app.globalData.voiceTarget = {
      label: '总结需求',
      handle: this._voiceHandle
    }
  },

  onHide() {
    if (app.globalData.voiceTarget && app.globalData.voiceTarget.handle === this._voiceHandle) {
      app.globalData.voiceTarget = null
    }
    this._voiceHandle = null
  },

  onUnload() {
    if (this._offVoiceState) this._offVoiceState()
    if (app.globalData.voiceTarget && app.globalData.voiceTarget.handle === this._voiceHandle) {
      app.globalData.voiceTarget = null
    }
  },

  // ===== 输入 =====
  onPromptInput(e) {
    this.setData({ prompt: e.detail.value })
  },

  appendPrompt(text) {
    const t = String(text || '').trim()
    if (!t) return
    const cur = this.data.prompt.trim()
    this.setData({ prompt: cur ? cur + (cur.slice(-1) === '\n' ? '' : '\n') + t : t })
  },

  // ===== 语音（按住说话）=====
  onHoldStart() {
    this._suppressEnd = false
    this._isHolding = false
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      voice.start({ contextText: this.data.prompt || '' })
    }, 300)
  },

  onHoldEnd() {
    if (this._holdTimer) clearTimeout(this._holdTimer)
    if (this._isHolding) {
      this._isHolding = false
      voice.stop()
    }
    this.setData({ voiceCanceling: false })
  },

  // ===== 时间范围（弹层内选择）=====
  openRangePicker() {
    this.setData({ showRangePicker: true })
  },

  closeRangePicker() {
    this.setData({ showRangePicker: false })
  },

  // 点选某个范围：非「自定义」直接生效并关闭；「自定义」展开日期区，等用户选完点确定
  selectRange(e) {
    const key = e.currentTarget.dataset.key
    const item = RANGE_LIST.find(r => r.key === key)
    if (!item) return
    if (key === 'custom') {
      // 胶囊上显示短文案，完整区间由弹层/右侧提示展示
      this.setData({ range: 'custom', rangeLabel: '自定义日期' })
      return
    }
    this.setData({ range: key, rangeLabel: item.label, showRangePicker: false })
  },

  confirmRange() {
    const { customStart, customEnd } = this.data
    if (!customStart || !customEnd) {
      wx.showToast({ title: '请选择开始和结束日期', icon: 'none' })
      return
    }
    if (customStart > customEnd) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' })
      return
    }
    this.setData({ showRangePicker: false })
  },

  onCustomStart(e) {
    this.setData({ customStart: e.detail.value })
  },

  onCustomEnd(e) {
    this.setData({ customEnd: e.detail.value })
  },

  // 按时间范围筛选日记（返回倒序数组，新的在前）
  filterDiaries(list) {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const range = this.data.range
    if (range === 'month') {
      const s = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      return list.filter(d => new Date(d.created_at).getTime() >= s)
    }
    if (range === 'lastMonth') {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()
      const e = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      return list.filter(d => { const t = new Date(d.created_at).getTime(); return t >= s && t < e })
    }
    if (range === 'week7') {
      const s = todayStart - 6 * 86400000
      return list.filter(d => new Date(d.created_at).getTime() >= s)
    }
    if (range === 'custom') {
      const cs = this.data.customStart, ce = this.data.customEnd
      if (!cs || !ce) return list
      const s = new Date(cs + 'T00:00:00').getTime()
      const e = new Date(ce + 'T23:59:59').getTime()
      return list.filter(d => { const t = new Date(d.created_at).getTime(); return t >= s && t <= e })
    }
    return list // all
  },

  // ===== 快捷模板 =====
  onShortcut(e) {
    const fill = e.currentTarget.dataset.fill
    this.setData({ prompt: fill })
  },

  // ===== 生成总结 =====
  onGenerate() {
    const prompt = this.data.prompt.trim()
    if (!prompt) {
      wx.showToast({ title: '请输入或说出你的需求', icon: 'none' })
      return
    }
    if (this.data.loading) return
    // 自定义范围必须选完起止日期
    if (this.data.range === 'custom' && (!this.data.customStart || !this.data.customEnd)) {
      wx.showToast({ title: '请先选择起止日期', icon: 'none' })
      this.setData({ showRangePicker: true })
      return
    }
    // 3 秒防抖
    if (this._cooling) {
      wx.showToast({ title: '操作太快，请稍候', icon: 'none' })
      return
    }

    // 读本地日记 + 按时间筛选
    const all = storage.getAllDiaries()
    const filtered = this.filterDiaries(all)
    if (!filtered.length) {
      this.setData({ error: '所选时间段暂无日记，请更换时间范围或去写日记', hasResult: false, result: '' })
      return
    }

    // 组装 diaries（新的在前，控制总字符量避免 callFunction 参数过大）
    const MAX_SEND = 15000
    const diaries = []
    let total = 0
    for (const d of filtered) {
      const content = String(d.content || '').slice(0, 1500)
      const date = util.getDateKey(new Date(d.created_at))
      const mood = util.getMoodLabel(d.mood) || ''
      const piece = date + content + mood
      if (total + piece.length > MAX_SEND) break
      diaries.push({ date: date, content: content, mood: mood })
      total += piece.length
    }
    if (!diaries.length) {
      this.setData({ error: '所选时间段暂无日记', hasResult: false, result: '' })
      return
    }

    this._cooling = true
    setTimeout(() => { this._cooling = false }, 3000)
    this.setData({ loading: true, error: '', hasResult: false, result: '' })

    // 云开发不可用（IDE / 非云开发环境）直接报错，避免卡在 loading
    if (!wx.cloud || !wx.cloud.callFunction) {
      this.setData({ loading: false, error: '当前环境未启用云开发，无法使用 AI 总结' })
      return
    }

    const rangeDate = this.getRangeDate()
    wx.cloud.callFunction({
      name: 'aiSummary',
      data: {
        userPrompt: prompt,
        diaries: diaries,
        startDate: rangeDate.start,
        endDate: rangeDate.end
      }
    }).then(res => {
      const r = res && res.result
      if (r && r.success && r.summaryText) {
        this.setData({
          loading: false,
          hasResult: true,
          result: r.summaryText,
          resultHtml: markdownToHtml(r.summaryText),
          diaryCount: r.diaryCount || diaries.length,
          truncated: !!r.truncated
        })
      } else {
        this.setData({
          loading: false,
          hasResult: false,
          error: (r && r.error) || '生成失败，请稍后重试'
        })
      }
    }).catch(err => {
      console.warn('[summary] aiSummary 调用失败:', err && err.errMsg)
      this.setData({
        loading: false,
        hasResult: false,
        error: '网络异常，请稍后重试'
      })
    })
  },

  // 当前筛选对应的起止日期（仅用于记录/回显）
  getRangeDate() {
    const now = new Date()
    const pad = n => n < 10 ? '0' + n : '' + n
    const key = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    if (this.data.range === 'custom') {
      return { start: this.data.customStart || '', end: this.data.customEnd || '' }
    }
    if (this.data.range === 'month') {
      return { start: key(new Date(now.getFullYear(), now.getMonth(), 1)), end: key(now) }
    }
    if (this.data.range === 'lastMonth') {
      return { start: key(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: key(new Date(now.getFullYear(), now.getMonth(), 0)) }
    }
    if (this.data.range === 'week7') {
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
      return { start: key(s), end: key(now) }
    }
    return { start: '', end: '' }
  },

  // ===== 结果操作 =====
  onCopy() {
    if (!this.data.result) return
    wx.setClipboardData({
      data: this.data.result,
      success: () => wx.showToast({ title: '复制成功', icon: 'success' })
    })
  },

  onSave() {
    const content = this.data.result
    if (!content) return
    const todayKey = util.getDateKey()
    const saved = storage.saveDiary({
      title: util.getDefaultTitle(todayKey) + '【AI总结】',
      content: content,
      mood: 'neutral',
      source: 'ai',
      tags: ['AI总结'],
      location: null,
      media: [],
      weather: null,
      created_at: new Date().toISOString()
    })
    if (!saved) {
      wx.showToast({ title: '保存失败', icon: 'none' })
      return
    }
    app.globalData.needRefresh = true
    // 上报今天已写（AI 总结也视为当天有日记，避免闹钟误提醒）
    reminder.callMarkWritten(todayKey)
    wx.showModal({
      title: '已保存到你的日记',
      content: '是否去查看？',
      confirmText: '去查看',
      cancelText: '继续提问',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/detail/detail?id=' + saved.id })
        }
      }
    })
  },

  onReset() {
    this.setData({
      prompt: '',
      hasResult: false,
      error: '',
      result: '',
      resultHtml: '',
      diaryCount: 0,
      truncated: false
    })
  }
})
