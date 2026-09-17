/**
 * 智能总结页 pages/summary
 * 全局批量日记分析：文字/语音输入需求 → 前端本地读日记按时间筛选 → 云函数 aiSummary 调大模型 → 生成总结
 * 生成成功后跳「总结结果」页（pages/summary-result）显示 / 分享 / 编辑 / 保存，本页只负责生成
 */
const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const voice = require('../../utils/voice.js')
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
  { icon: 'ri-calendar-line', label: '本月日记整体回顾', fill: '帮我回顾一下这段时间的日记，做个整体总结' },
  { icon: 'ri-emotion-line', label: '分析这段时间情绪变化', fill: '帮我分析所选时间段内我的情绪变化，简单总结' },
  { icon: 'ri-price-tag-3-line', label: '按标签汇总日记内容', fill: '按标签汇总我的日记内容' },
  { icon: 'ri-bar-chart-2-line', label: '统计工作相关记录', fill: '统计这段时间里工作相关的记录' },
  { icon: 'ri-book-open-line', label: '生成年度简短回顾', fill: '生成一段简短的年度回顾' },
  { icon: 'ri-search-line', label: '提取所有运动记录', fill: '提取我所有的运动记录' }
]

// 是否为「AI 总结」生成的日记：共用判据在 utils/util.js（isAiSummaryDiary），
// 同日融合、自动分段等处使用同一套规则，避免各写一份后口径漂移

// 注：结果的 markdown 渲染/复制/保存已移至 pages/summary-result（本页只负责调用 AI 生成）

const fontSetting = require('../../utils/fontSetting.js')
const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')

Page({
  data: {
    // 「日记字体」设置注入的 CSS 变量串：字号/字体作用于本页 UGC 正文
    fontStyle: '',
    // 底部安全区适配
    safeAreaBottom: 0,
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
    // 底部安全区适配（与写日记主页 / 详情编辑页 / 档案页一致）
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      safeAreaBottom: (win.safeArea && win.screenHeight - win.safeArea.bottom) || 0
    })

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
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
    this.setData({ fontStyle: fontSetting.buildStyle() })
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
    // 静默排除「AI 总结」生成的日记：总结结果是产出物，不再作为下一轮总结的输入
    const sourceList = all.filter(d => !util.isAiSummaryDiary(d))
    const filtered = this.filterDiaries(sourceList)
    if (!filtered.length) {
      this.setData({ error: '所选时间段暂无日记，请更换时间范围或去写日记', hasResult: false, result: '' })
      return
    }

    // 组装 diaries（新的在前；总量上限与云函数 MAX_CONTEXT_CHARS=50000 对齐，
    // 日记多时自动缩小每篇正文配额，尽量把整段时间的日记都带上）
    const MAX_SEND = 50000        // 发送给云函数的日记文本总量上限（字符）
    const PER_DIARY_MAX = 1500    // 单篇正文常规上限
    const PER_DIARY_MIN = 80      // 日记极多时的单篇正文下限（只保留开头，避免整段被丢弃）
    const OVERHEAD = 24           // 每篇日期/心情/分隔符等额外开销估算

    const totalCount = filtered.length
    let perDiary = Math.floor((MAX_SEND - totalCount * OVERHEAD) / totalCount)
    perDiary = Math.max(PER_DIARY_MIN, Math.min(PER_DIARY_MAX, perDiary))

    const diaries = []
    let total = 0
    for (const d of filtered) {
      const raw = String(d.content || '').trim()
      const content = raw.length > perDiary ? raw.slice(0, perDiary) + '…' : raw
      const date = util.getDateKey(new Date(d.created_at))
      const mood = util.getMoodLabel(d.mood) || ''
      const piece = date + content + mood
      if (total + piece.length > MAX_SEND) break
      diaries.push({ date: date, content: content, mood: mood })
      total += piece.length
    }
    // 发送量超限导致有日记没带上时，页面上给出「已选取最近部分」提示
    const frontTruncated = diaries.length < totalCount
    this.setData({ truncated: frontTruncated })
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
        // 生成成功：结果交给「总结结果」页显示（本页不再就地展示），通过 eventChannel 传递
        const payload = {
          content: r.summaryText,
          prompt: prompt,
          rangeText: this.getRangeText(),
          diaryCount: r.diaryCount || diaries.length,
          truncated: !!r.truncated || frontTruncated
        }
        app.globalData.summaryResult = payload // 兜底：eventChannel 未命中时结果页读全局
        // 本页回到初始态（保留输入的需求方便继续提问），避免返回时残留 loading / 旧结果
        this.setData({ loading: false, hasResult: false, result: '', resultHtml: '', diaryCount: 0, truncated: false })
        wx.navigateTo({
          url: '/pages/summary-result/summary-result',
          success: (nav) => {
            if (nav && nav.eventChannel) nav.eventChannel.emit('summaryResult', payload)
          },
          fail: () => {
            this.setData({ error: '结果页打开失败，请重试' })
          }
        })
      } else {
        this.setData({
          loading: false,
          hasResult: false,
          error: (r && r.error) || '生成失败，请稍后重试'
        })
      }
    }).catch(err => {
      // 暴露真实错误（网络异常 / 云函数失败 / 模块找不到 都会反映在 err.errMsg / err.result）
      const r = err && err.result
      const detail = (r && r.errorMessage) || (err && (err.errMsg || err.message)) || ''
      console.warn('[summary] aiSummary 调用失败:', err, 'detail:', detail)
      this.setData({
        loading: false,
        hasResult: false,
        error: 'AI 调用失败：' + (detail || '网络异常') + '\n（请把错误文案发给 AI 助手定位）'
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

  // 数据范围文案（总结结果页展示用，如「本月 / 上月 / 近 7 天 / 全部时间 / 9月1日 至 9月11日」）
  getRangeText() {
    const range = this.data.range
    if (range === 'month') return '本月'
    if (range === 'lastMonth') return '上月'
    if (range === 'week7') return '近 7 天'
    if (range === 'custom') {
      const cn = (s) => {
        const d = new Date(s + 'T00:00:00')
        if (isNaN(d.getTime())) return ''
        return (d.getMonth() + 1) + '月' + d.getDate() + '日'
      }
      const a = cn(this.data.customStart)
      const b = cn(this.data.customEnd)
      if (a && b) return a + ' 至 ' + b
      return '所选时间段'
    }
    return '全部时间'
  },

  // 结果展示/复制/保存已移至「总结结果」页（pages/summary-result），本页只负责生成

  onReset() {
    this.setData({
      prompt: '',
      error: ''
    })
  }
})
