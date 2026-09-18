const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const aiCloud = require('../../utils/aiCloud.js')
const aiEdit = require('../../utils/aiEdit.js')
const nameMatch = require('../../utils/nameMatch.js')
const entityClean = require('../../utils/entityClean.js')
const voice = require('../../utils/voice.js')
const weather = require('../../utils/weather.js')
const mediaGuard = require('../../utils/mediaGuard.js')
const transfer = require('../../utils/transfer.js')
const app = getApp()

// 侧栏日记本默认显示的日记条数（其余通过「查看全部」进日记本页）
const SIDEBAR_DIARY_LIMIT = 3

// 每天媒体限额（防存储爆炸）：图片最多 6 张、视频最多 2 个（含同一天已保存的日记）
const MAX_IMAGES_PER_DAY = 6
const MAX_VIDEOS_PER_DAY = 2

// 从日记的 AI 标签中挑侧栏展示的关键字：取第一个不超过 4 字的标签；没有则返回空（不显示）
function pickSidebarKeyword(tags) {
  if (!Array.isArray(tags)) return ''
  for (let i = 0; i < tags.length; i++) {
    const t = String(tags[i] || '').trim()
    if (t && t.length <= 4) return t
  }
  return ''
}

// 表情与颜文字（表情面板数据）
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','🥰','😘','😜','🤪','😎','🤩','🥳','😇','🤗','🤔','🙄','😴','🤤','😭','😅','😓','🥺','😳','🤯','😤','😡','🤮','🤧','🥶','🤠','😈','👻','💀','👽','🤖','🎃','😺','🙈','🙉','🙊','💩','👍','👎','👏','🙏','💪','🤝','✌️','🤞','🖖','👌','🤘','👊','❤️','💔','💕','💖','💗','💘','💞','💓','✨','⭐','🌟','🔥','💧','🌈','☀️','🌙','⚡','❄️','🌸','🌹','🌻','🍀','🎉','🎊','🎂','🍰','🍎','🍉','🍓','🍑','☕','🍵','🍺','🥂','🏠','🚗','✈️','🎵','🎶','📚','📖','💻','📱','🎮','⚽','🏀','🎯','🧩','💡','💰','💎','📌','🔒','🔑','🚀','🛸','⏰','📅','😷','🥵','🥶','🫶','🫡','🫠']
const KAOMOJIS = ['(◕‿◕)','(￣▽￣)','(≧∇≦)','(´･ω･`)','(◐‿◑)','ヽ(´▽`)/','(╯°□°)╯︵┻━┻','(T_T)','(^_^)','(o^^)o','(=^･^=)','(｡•̀ᴗ-)✧','┗(＾0＾)┓','(｡ŏ_ŏ)','(；一_一)','(¬_¬)','(＾▽＾)','(●´ω｀●)','(づ￣ ³￣)づ','(๑˃ᴗ˂)ﻭ','(๑•̀ㅂ•́)و✧','(￣▽￣)ノ','(╥﹏╥)','(ノ﹏ヽ)','(′⌒`)','(´；ω；`)','(｡•́︿•̀｡)','(づ｡◕‿‿◕｡)づ','(ノ◕ヮ◕)ノ*:･ﾟ✧','(╯▽╰)','(°▽°)','(●—●)','(・ω・)ノ','(ง •̀_•́)ง','(╬ Ò﹏Ó)','(｀Д´)','(￣へ￣)','(´-ω-`)','(；￣Д￣)','(ﾟ▽ﾟ*)','(⌒▽⌒)','(＾-＾)','(^o^)','(>_<)','(=_=)','(-_-)','(~_~)','(O_O)','(o_O)','(•̀ᴗ•́)و','(•́ω•̀)','(๑•̀ㅂ•́)','(｀・ω・´)']

const fontSetting = require('../../utils/fontSetting.js')
const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const draft = require('../../utils/draft.js')
const textRules = require('../../utils/textRules.js')
const reminder = require('../../utils/reminder.js')
const guide = require('../../utils/guide.js')
const appInfo = require('../../utils/appInfo.js')
// [dailyquote v1] 侧栏「每日一签」内容源（本地池 + 按日期确定性轮换）
const dailyQuote = require('../../utils/dailyQuote.js')

// 保存后的「非关键步骤」统一兜底：任何一步异常都不得影响「日记已保存」这个事实，
// 更不得吞掉实体识别（备案提醒）——它是保存流程里唯一的交互步骤。
// 2026-09-18 教训：reminder 漏引 → 抛 ReferenceError → 被 doAddDiary 的 catch
// 兜成「补跳详情页」→ checkNewEntities 整段跳过，备案提醒静默失效 8 天。
function safePostSave(step, fn) {
  try {
    return fn()
  } catch (e) {
    console.error('[write] 保存后步骤异常（已忽略，不影响已保存内容）:', step, e)
    return null
  }
}

Page({
  data: {
    // 应用名（唯一来源 utils/appInfo.js）：侧栏标题使用，禁止在 wxml 里写死字面量
    appName: appInfo.APP_NAME,
    // 「日记字体」设置注入的 CSS 变量串：字号/字体作用于本页 UGC 正文
    fontStyle: '',
    // 系统栏适配
    statusBarHeight: 20,
    safeAreaBottom: 0,
    // 日记正文
    content: '',
    // 自定义占位文案（textarea 原生 placeholder 不支持换行，改用覆盖层渲染；支持多行）
    placeholderLine1: textRules.DEFAULT_LINES[0],
    placeholderLine2: textRules.DEFAULT_LINES[1],
    placeholderLine3: textRules.DEFAULT_LINES[2],
    diaryDate: '',
    minDate: '',
    maxDate: '',
    dateLabel: '',
    // 自定义日期选择弹层（月视图日历）
    showDatePicker: false,
    calYear: 0,
    calMonth: 0,
    calTitle: '',
    calDays: [],
    diaryDateSet: {},
    // 心情（默认「一般」）
    mood: 'neutral',
    moodLabel: util.MOOD_MAP.neutral.label,
    moodColor: util.MOOD_MAP.neutral.color,
    moodBg: util.MOOD_MAP.neutral.bg,
    moodOptions: Object.keys(util.MOOD_MAP).map(key => ({
      key: key,
      label: util.MOOD_MAP[key].label
    })),
    showMoodPanel: false,
    showMoodPicker: false,
    // 位置
    location: null,
    // 定位城市 + 天气（日期行右侧展示）
    weatherInfo: null,
    // 媒体：图片/视频，最多9个
    media: [],
    mediaUploading: false,
    // 保存
    saving: false,
    // ===== 底部输入栏（默认语音输入）=====
    recording: false,          // 录音中
    transcribing: false,       // 语音识别中
    recordSeconds: 0,
    voiceCanceling: false,     // 上滑取消状态（录音中 UI 提示）
    // ===== 语音实时净化（第一层处理，区别于 AI 优化）=====
    liveText: '',              // 实时识别 + 净化后的文本（边说边出字）
    liveRemoved: 0,            // 本次说话已过滤的语气词/自言自语数量
    showEmojiPanel: false,
    emojiTab: 'emoji',         // 'emoji' | 'kaomoji'
    emojiList: EMOJIS,
    showAddPanel: false,
    // ===== 侧边栏（日记本 / 我的）=====
    showSidebar: false,
    stats: { total: 0, monthCount: 0, streak: 0 },
    allSidebarDiaries: [],
    sidebarDiaries: [],
    sidebarKeyword: '',
    userInfo: null,
    hasUserInfo: false,
    // [dailyquote v1] 每日一签卡片：{ index, type, icon, line1, line2 }，
    // line1＝诗词名/作者，line2＝正文前 16 字
    dailyQuote: { index: -1, type: '', icon: dailyQuote.ICON, line1: '', line2: '' },
    // ===== AI 优化（最小范围）=====
    optimizing: false,
    aiLoadingText: 'AI正在优化你的日记...',
    aiLoadingSub: '润色表达 · 让文字更通顺',
    showOptimizeResult: false,
    originalContent: '',
    optimizedContent: '',
    optimizeChanges: [],
    showOriginal: false,
    optimized: false,
    // ===== 实体备案弹窗 =====
    showEntityPrompt: false,
    newEntities: [],
    // 修改指令执行结果高亮：{active, title, nodes, count}
    highlight: { active: false, title: '', nodes: [], count: 0 },
    // 新手引导（5 步）：可见性 / 当前步 / 目标矩形 / 高亮孔形状
    // 目标是量出来的（guide.measure），拿不到传 null → 组件只显示卡片、不画高亮孔
    guideVisible: false,
    guideStep: {},
    guideRect: null,
    guideShape: 'rect'
  },

  onLoad() {
    // 隐私查询是否有结论：false = 还不知道要不要弹隐私弹窗（异步查询在途）。
    // 引导靠它让路 —— 结论出来前绝不开播，否则两个弹层会叠着弹（见 maybeStartGuide）
    this._privacyChecked = false
    // 日记本密码：冷启动首屏最早拦截点（需要锁且未解锁 → 立刻跳锁屏页）
    if (lock.guard()) return
    // 微信隐私协议：needAuthorization 为 true 时自绘弹窗征求同意（同意过/旧库均静默）。
    // tryShow 返回 Promise<boolean>（是否需要授权）：拿到结论后才决定放不放行引导
    const privacyPopup = this.selectComponent('#privacyPopup')
    if (privacyPopup && privacyPopup.tryShow) {
      // 兜底：查询长时间不返回（极端）也不让引导永久不播 —— 到点按「无需授权」放行。
      // 放行后裁决里仍会再看一眼弹窗是否可见，所以不会因此叠弹。
      this._privacyTimer = setTimeout(() => this.onPrivacyChecked(false), 1500)
      Promise.resolve(privacyPopup.tryShow()).then(
        (needAuth) => this.onPrivacyChecked(needAuth),
        () => this.onPrivacyChecked(false)
      )
    } else {
      this.onPrivacyChecked(false) // 取不到组件/旧版本：按「无需授权」放行，绝不卡死引导
    }
    // 自定义导航栏适配（safeArea.top 比 statusBarHeight 更能覆盖刘海/灵动岛）
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const statusBarHeight = win.statusBarHeight || 20
    const safeAreaTop = Math.max((win.safeArea && win.safeArea.top) || 0, statusBarHeight, 20)
    this.setData({
      statusBarHeight: statusBarHeight,
      safeAreaTop: safeAreaTop,
      safeAreaBottom: (win.safeArea && win.screenHeight - win.safeArea.bottom) || 0
    })

    const todayKey = util.getDateKey()
    const min = new Date()
    min.setDate(min.getDate() - 3)
    this.setData({
      diaryDate: todayKey,
      minDate: util.getDateKey(min),
      maxDate: todayKey,
      dateLabel: this.buildDateLabel(todayKey)
    })

    // 定位并获取城市天气（失败静默，不影响使用）
    this.loadWeather()

    // 订阅全局录音状态，显示「正在聆听/识别中」浮层；
    // 实时链路下 liveText 为净化后的识别文本（边说边出字），liveRemoved 为已过滤的语气词数量
    this._offVoiceState = voice.onStateChange((s) => {
      this.setData({
        recording: s.recording,
        connecting: s.connecting || false,
        transcribing: s.transcribing,
        recordSeconds: s.seconds,
        liveText: s.liveText || '',
        liveRemoved: s.liveRemoved || 0,
        // 滚动跟随：按行数估算内容高度（每行约 18 字、行高 48rpx），
        // 取值恒不小于最大可滚动距离 → 始终贴底；超过 10 行后旧文字滚出视野（沿用原隐藏逻辑）
        liveScrollTop: Math.ceil(((s.liveText || '').length) / 18) * 48
      })
    })
  },

  onShow() {
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
    this.setData({ fontStyle: fontSetting.buildStyle() })
    // 占位文案：按「打开次数」优先、「日记篇数」次之的规则取三行（云端可配，失败静默回落默认）
    this.applyPlaceholderText()
    // 恢复上次未保存的草稿（输入框为空且有草稿时）
    this.restoreDraft()
    // 注册语音目标：底部「按住说话」识别结果交给本页处理
    this._voiceHandle = (text) => this.handleVoiceText(text)
    app.globalData.voiceTarget = {
      label: '正文',
      handle: this._voiceHandle
    }
    // 消费外部语音草稿（在其他页长按录音带过来的内容）
    if (app.globalData.voiceDraft) {
      const draft = app.globalData.voiceDraft
      app.globalData.voiceDraft = null
      this.processInput(draft, true)
    }
    // 预热语音识别鉴权参数（已授权才拉取，静默）：首次按住说话可跳过云函数等待直接开始录音
    voice.warmup()
    // 刷新侧边栏数据
    this.refreshSidebar()
    // [dailyquote v1] 每日一签：跨天回到页面也要换成当天的（onShow 每次都重取）
    this.refreshDailyQuote()
    // 新手引导：首启自动播一次（是否播过看 guideDone_v1 标记；与隐私弹窗的先后由 maybeStartGuide 兜住）
    this.maybeStartGuide()
  },

  // 写日记页占位文案：按「打开次数」优先、「日记篇数」次之的规则取三行
  applyPlaceholderText() {
    const lines = textRules.getLines(storage.getStats().total)
    this.setData({
      placeholderLine1: lines[0],
      placeholderLine2: lines[1],
      placeholderLine3: lines[2]
    })
  },

  onHide() {
    // 暂存未保存的正文（离开页面即可能被销毁：切后台、被锁屏页 reLaunch）
    this.saveDraft()
    if (app.globalData.voiceTarget && app.globalData.voiceTarget.handle === this._voiceHandle) {
      app.globalData.voiceTarget = null
    }
    this._voiceHandle = null
    this.closeAllPanels()
  },

  onUnload() {
    this.saveDraft()
    if (this._offVoiceState) this._offVoiceState()
    // 兜底：写了媒体但未保存就离开页面时，清掉本会话新上传的云文件（避免孤儿）
    // 保存进行中（_savingMedia）不清理：等保存出口决定，防止误删即将被日记引用的媒体
    if (!this._savingMedia) this.discardSessionUploads()
  },

  // ===== 草稿（防「写了一半离开就没了」）=====
  // 离开页面（切后台 / 被锁屏页 reLaunch 销毁）时暂存正文；内容为空视为用户主动清空，一并作废
  saveDraft() {
    try {
      const c = String(this.data.content || '')
      if (!c.trim()) { draft.clear(); return }
      draft.save(c)
    } catch (e) { /* 草稿失败不影响正文 */ }
  },

  // 回到页面时恢复：仅当输入框为空（不覆盖正在写的内容）
  restoreDraft() {
    try {
      if (String(this.data.content || '').trim()) return
      const d = draft.load()
      if (!d) return
      this.setData({ content: d.content })
      wx.showToast({ title: '已恢复上次未保存的内容', icon: 'none' })
    } catch (e) { /* 静默 */ }
  },

  // ===== 日期 =====
  buildDateLabel(dateStr) {
    const now = new Date()
    const d = new Date(dateStr + 'T12:00:00')
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const diff = Math.round((todayStart - dayStart) / 86400000)
    let prefix = ''
    if (diff === 0) prefix = '今天 · '
    else if (diff === 1) prefix = '昨天 · '
    else if (diff === 2) prefix = '前天 · '
    return prefix + util.formatDate(dateStr + 'T12:00:00')
  },

  // ===== 日期选择：月视图日历 =====

  // 收集所有已保存日记的日期 key（用于月视图中打绿点）
  collectDiaryDates() {
    const set = {}
    storage.getAllDiaries().forEach(d => {
      const key = util.getDateKey(new Date(d.created_at))
      if (key) set[key] = (set[key] || 0) + 1
    })
    return set
  },

  // 构建指定年月的日历网格（前置空白 + 每日：绿点/今天/未来/选中状态）
  buildMonthView(year, month) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    const todayKey = util.getDateKey()
    const diarySet = this.data.diaryDateSet
    const selected = this.data.diaryDate
    const firstDay = new Date(year, month - 1, 1)
    const startWeek = firstDay.getDay() // 0=周日
    const total = new Date(year, month, 0).getDate()
    const days = []
    for (let i = 0; i < startWeek; i++) {
      days.push({ blank: true, key: 'blank' + i })
    }
    for (let d = 1; d <= total; d++) {
      const dateKey = year + '-' + pad(month) + '-' + pad(d)
      days.push({
        blank: false,
        key: dateKey,
        day: d,
        dateKey: dateKey,
        hasDiary: !!diarySet[dateKey],
        isToday: dateKey === todayKey,
        isFuture: dateKey > todayKey,
        isSelected: dateKey === selected
      })
    }
    this.setData({
      calYear: year,
      calMonth: month,
      calTitle: year + '年' + month + '月',
      calDays: days
    })
  },

  // 打开月视图：定位到当前选中日期所在月份，并刷新日记绿点
  initDatePicker(dateStr) {
    const d = new Date((dateStr || util.getDateKey()) + 'T12:00:00')
    this.setData({ diaryDateSet: this.collectDiaryDates() })
    this.buildMonthView(d.getFullYear(), d.getMonth() + 1)
  },

  toggleDatePicker() {
    if (this.data.showDatePicker) {
      this.setData({ showDatePicker: false })
      return
    }
    this.initDatePicker(this.data.diaryDate)
    this.setData({ showMoodPicker: false, showDatePicker: true })
  },

  closeDatePicker() {
    this.setData({ showDatePicker: false })
  },

  // 上一个月（最早可翻到 3 年前）
  prevMonth() {
    const cur = new Date(this.data.calYear, this.data.calMonth - 1, 1)
    cur.setMonth(cur.getMonth() - 1)
    const limit = new Date(new Date().getFullYear() - 3, 0, 1)
    if (cur < limit) return
    this.buildMonthView(cur.getFullYear(), cur.getMonth() + 1)
  },

  // 下一个月（最晚可翻到当前月）
  nextMonth() {
    const cur = new Date(this.data.calYear, this.data.calMonth - 1, 1)
    cur.setMonth(cur.getMonth() + 1)
    const now = new Date()
    if (cur > new Date(now.getFullYear(), now.getMonth(), 1)) return
    this.buildMonthView(cur.getFullYear(), cur.getMonth() + 1)
  },

  // 点击某一天：已有日记 → 进入该日记详情编辑页；没有 → 选定日期并关闭面板
  onCalDayTap(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.calDays[idx]
    if (!item || item.blank || item.isFuture) return
    // 已保存日记的日期：跳到日记详情编辑页（同日多篇取最新一篇）
    if (item.hasDiary) {
      const diaries = storage.getAllDiaries().filter(
        d => util.getDateKey(new Date(d.created_at)) === item.dateKey
      )
      if (diaries.length > 0) {
        this.setData({ showDatePicker: false })
        wx.navigateTo({ url: '/pages/detail/detail?id=' + diaries[0].id + '&edit=1' })
        return
      }
    }
    // 无日记日期：与原「确定」逻辑一致，胶囊显示所选日期
    this.setData({
      diaryDate: item.dateKey,
      dateLabel: this.buildDateLabel(item.dateKey),
      showDatePicker: false
    })
  },

  resolveCreatedAt(dateStr) {
    if (dateStr === util.getDateKey()) {
      return new Date().toISOString()
    }
    return new Date(dateStr + 'T12:00:00').toISOString()
  },

  // ===== 正文编辑 =====
  // 所有写正文的地方都走这里
  _setContent(content, extra) {
    const patch = Object.assign({ content: content }, extra || {})
    this.setData(patch)
  },

  onContentInput(e) {
    this._setContent(e.detail.value)
  },

  // ===== 底部输入：语音 =====

  // 按住开始录音（带300ms防误触）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      // 把当前草稿（textarea 内容）作为"即时上下文"传给语音识别
      // 例如：草稿里已写"王威"，随后口述"把王威改成王伟"——避免"王威"被识别错
      voice.start({ contextText: this.data.content || '' })
    }, 300)
  },

  onHoldEnd() {
    if (this._holdTimer) clearTimeout(this._holdTimer)
    if (this._isHolding) {
      this._isHolding = false
      // 上滑取消：标记本段，识别结果回调（handleVoiceText）将整段丢弃，不写入正文
      if (this.data.voiceCanceling) {
        this._voiceCanceled = true
      }
      voice.stop()
    }
    this.setData({ voiceCanceling: false })
    this._voiceStartY = 0
    this._voiceStartX = 0
  },

  // 上滑取消：录音中手指向上滑动超过 120rpx 时切换为取消状态
  onVoiceTouchMove(e) {
    if (!this._isHolding || !this.data.recording) return
    const touch = (e && e.touches && e.touches[0]) || {}
    const dy = this._voiceStartY - touch.clientY
    const dx = Math.abs((this._voiceStartX || touch.clientX) - touch.clientX)
    // 垂直向上滑动超过 120rpx，且水平偏移不超过垂直偏移的一半（避免误触）
    const canceling = dy > 64 && dx < dy * 0.6
    if (canceling !== this.data.voiceCanceling) {
      this.setData({ voiceCanceling: canceling })
    }
  },

  // 右侧按钮：添加(+) → 打开图片/视频/位置面板
  onAddOrSend() {
    const show = !this.data.showAddPanel
    this.setData({
      showAddPanel: show,
      showEmojiPanel: false,
      showMoodPanel: false
    })
  },

  // 语音识别结果入口
  handleVoiceText(text) {
    if (this._voiceCanceled) {
      this._voiceCanceled = false
      return
    }
    this.processInput(text, true)
  },

  /**
   * 核心处理（语音输入入口；底栏已无键盘快捷输入，文字均在正文编辑框直接输入）：
   * 语音输入实时执行增删改指令——
   *   1. 先做备案名词优先匹配（同音字/拼音串自动替换为备案写法，如「王伟」→备案「王维」）
   *   2. 整条输入是一个指令（如「不是王磊，是王伟」「在北京前边加上首都」）→ 直接执行
   *   3. 混合输入（如「今天很开心。把开心删掉。」）→ 按句拆分，指令句逐条执行，普通句追加
   *   4. 纯内容 → 追加到正文末尾
   * 指令本身不写入日记，执行后高亮显示改动；备案名词替换也高亮显示
   */
  processInput(text, fromVoice) {
    let trimmed = String(text || '').trim()
    if (!trimmed) return

    // 兼容路径：非语音调用按纯内容追加（当前仅语音路径会调用本函数）
    if (!fromVoice) {
      this._setContent(this.appendText(trimmed))
      return
    }

    // 备案名词优先匹配（仅语音输入）：识别结果中的同音字替换为档案中的正确名词
    let matchInfo = null
    if (fromVoice) {
      matchInfo = nameMatch.matchArchives(trimmed, storage.getArchives())
      if (matchInfo.replaced.length > 0) trimmed = matchInfo.text
    }

    // 语音输入用宽松指令识别（识别结果常不带标点，如「不是王磊是王伟」），实时执行
    const loose = { loose: true }

    const single = aiEdit.detect(trimmed, loose)
    if (single) {
      this.execEditCommands([single], '', matchInfo)
      return
    }

    const parsed = aiEdit.splitCommands(trimmed, loose)
    if (parsed.commands.length > 0) {
      this.execEditCommands(parsed.commands, parsed.narrative, matchInfo)
      return
    }

    if (matchInfo && matchInfo.replaced.length > 0) {
      // 纯叙述且有名词替换：追加后高亮替换结果
      const content = this.appendTextTo(this.data.content, trimmed)
      this._setContent(content)
      const words = Array.from(new Set(matchInfo.replaced.map(r => r.to)))
      this.showEditHighlight(this.matchTitle(matchInfo.replaced), content, words)
      return
    }

    this._setContent(this.appendText(trimmed))
  },

  // 备案名词匹配提示文案
  matchTitle(replaced) {
    if (replaced.length === 1) {
      return '已按档案更正：「' + replaced[0].from + '」→「' + replaced[0].to + '」'
    }
    return '已按档案更正 ' + replaced.length + ' 处名词'
  },

  // 执行一批修改指令（按顺序作用于当前正文），再把普通叙述追加到末尾，最后高亮全部改动
  execEditCommands(commands, narrative, matchInfo) {
    let content = this.data.content
    const applied = []
    const words = []
    let firstNotFound = null
    let firstBlocked = null

    for (const cmd of commands) {
      const res = aiEdit.apply(content, cmd)
      if (res.changed) {
        content = res.content
        applied.push(cmd)
        if (res.highlightWord) words.push(res.highlightWord)
      } else if (res.reason === 'notFound' && !firstNotFound) {
        firstNotFound = cmd
      } else if (res.reason === 'allRemove' && !firstBlocked) {
        firstBlocked = cmd
      }
    }

    if (narrative) content = this.appendTextTo(content, narrative)
    this._setContent(content)

    // 名词替换词与指令改动词一起高亮
    const matchWords = matchInfo && matchInfo.replaced.length > 0
      ? Array.from(new Set(matchInfo.replaced.map(r => r.to)))
      : []

    if (applied.length > 0) {
      const title = applied.length === 1
        ? this.editTitle(applied[0])
        : '已执行 ' + applied.length + ' 条修改指令'
      this.showEditHighlight(title, content, words.concat(matchWords))
    } else if (matchWords.length > 0) {
      this.showEditHighlight(this.matchTitle(matchInfo.replaced), content, matchWords)
    } else if (firstBlocked) {
      wx.showToast({ title: '「前边所有内容」不支持删除，请指明要删的内容', icon: 'none' })
    } else if (firstNotFound) {
      const word = firstNotFound.type === 'insert' ? firstNotFound.at : firstNotFound.from
      const scope = aiEdit.scopeText(firstNotFound.scope)
      wx.showToast({
        title: scope ? ('日记' + scope + '找不到「' + word + '」') : ('日记中没有「' + word + '」'),
        icon: 'none'
      })
    }
  },

  // 单条指令的操作摘要文案（高亮浮层标题用）
  editTitle(edit) {
    if (edit.type === 'removeSent') return this.sentRemoveText(edit)
    const scope = aiEdit.scopeText(edit.scope)
    if (edit.type === 'remove') return '已删除' + (scope ? scope + '的' : '') + '「' + edit.from + '」'
    if (edit.type === 'insert') {
      return '已在' + (scope ? scope + '的' : '') + '「' + edit.at + (edit.pos === 'before' ? '前' : '后') + '」加上「' + edit.text + '」'
    }
    return '已修改：' + (scope ? scope + '的' : '') + '「' + edit.from + '」→「' + edit.to + '」'
  },

  // 按位置删句的描述文案：已删除最后一句话 / 已删除第一句话 / 已删除最后两句 / 已删除倒数第二句
  sentRemoveText(edit) {
    const n = edit.count || 1
    if (edit.offset) return '已删除倒数第' + (edit.offset + 1) + '句'
    const numText = n === 1 ? '一句' : (n === 2 ? '两句' : n + '句')
    return '已删除' + (edit.pos === 'first' ? '开头' : '最后') + numText
  },

  // 单条指令的「AI优化要点」条目文案（优化结果面板展示用，pair = {edit, result}）
  editNote(pair) {
    const e = pair.edit
    const r = pair.result || {}
    if (e.type === 'removeSent') return this.sentRemoveText(e)
    const scope = aiEdit.scopeText(e.scope)
    // 字面命中（范围词与目标词连成的原串真实存在）时按原串描述
    const src = r.usedRaw && e.rawFrom ? e.rawFrom : e.from
    if (e.type === 'remove') {
      return '已删除' + (scope ? scope + '的' : '') + '「' + src + '」' + (r.count > 1 ? '（共 ' + r.count + ' 处）' : '')
    }
    if (e.type === 'insert') {
      return '已在' + (scope ? scope + '的' : '') + '「' + e.at + (e.pos === 'before' ? '前' : '后') + '」插入「' + e.text + '」'
    }
    return '已将' + (scope ? scope + '的' : '') + '「' + src + '」替换为「' + e.to + '」' + (r.count > 1 ? '（全部 ' + r.count + ' 处）' : '')
  },

  /**
   * 修改指令执行结果高亮（支持多个改动词同时标出）：
   * 用 rich-text 渲染新正文，所有改动（插入/替换后的新词）以高亮背景标出，
   * 4 秒后或点击任意处自动返回普通编辑框
   */
  showEditHighlight(title, content, words) {
    const built = this.buildHighlightNodes(content, words)
    if (this._hlTimer) clearTimeout(this._hlTimer)
    this.setData({ highlight: { active: true, title: title, nodes: built.nodes, count: built.count } })
    this._hlTimer = setTimeout(() => this.dismissHighlight(), 4000)
  },

  // 把正文按高亮词切分为 rich-text 节点（\n 转 br 保留换行）
  buildHighlightNodes(content, words) {
    const text = String(content || '')
    const wordList = (words || []).filter(w => w && text.indexOf(w) !== -1)
    const segments = []

    if (wordList.length === 0) {
      segments.push({ text: text, mark: false })
    } else {
      // 长词优先匹配，避免短词抢先命中
      const sorted = wordList.slice().sort((a, b) => b.length - a.length)
      const esc = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const re = new RegExp('(' + esc.join('|') + ')', 'g')
      const parts = text.split(re)
      for (const p of parts) {
        if (!p) continue
        segments.push({ text: p, mark: sorted.indexOf(p) !== -1 })
      }
    }

    const nodes = []
    let count = 0
    for (const seg of segments) {
      if (seg.mark) count++
      const lines = seg.text.split('\n')
      lines.forEach((line, i) => {
        if (line) {
          nodes.push({
            name: 'span',
            attrs: { class: seg.mark ? 'hl-mark' : 'hl-plain' },
            children: [{ type: 'text', text: line }]
          })
        }
        if (i < lines.length - 1) nodes.push({ name: 'br' })
      })
    }
    return { nodes: nodes, count: count }
  },

  // 关闭修改结果高亮，回到编辑框
  dismissHighlight() {
    if (this._hlTimer) {
      clearTimeout(this._hlTimer)
      this._hlTimer = null
    }
    if (this.data.highlight && this.data.highlight.active) {
      this.setData({ 'highlight.active': false })
    }
  },

  // 把文字拼接到正文末尾
  appendText(text) {
    return this.appendTextTo(this.data.content, text)
  },

  // 把文字拼接到指定基底末尾
  appendTextTo(base, text) {
    if (!base) return text
    const needSpace = !/[\n\s，。！？、；：.!?]$/.test(base)
    return base + (needSpace ? ' ' : '') + text
  },

  // ===== 表情 / 颜文字 =====
  toggleEmojiPanel() {
    const show = !this.data.showEmojiPanel
    this.setData({
      showEmojiPanel: show,
      showAddPanel: false,
      showMoodPanel: false
    })
  },

  switchEmojiTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({
      emojiTab: tab,
      emojiList: tab === 'kaomoji' ? KAOMOJIS : EMOJIS
    })
  },

  insertEmoji(e) {
    const emoji = e.currentTarget.dataset.emoji
    // 底栏已无文字输入框：表情直接追加到正文（textarea 支持所见即所得）
    this._setContent(this.data.content + emoji)
  },

  // ===== 添加(+)：图片 / 视频 / 心情 / 位置 =====
  chooseImage() {
    this.chooseMediaByType(['image'])
  },

  chooseVideo() {
    this.chooseMediaByType(['video'])
  },

  chooseMediaByType(mediaType) {
    this.setData({ showAddPanel: false, showMoodPanel: false })
    if (this.data.mediaUploading) return

    // 按天限额：同一天已保存的日记 + 当前草稿已选，合计不得超过上限
    const isVideo = mediaType.indexOf('video') !== -1
    const used = storage.countMediaByDate(this.data.diaryDate)
    const curMedia = this.data.media || []
    const usedImages = used.images + curMedia.filter(m => m.type === 'image').length
    const usedVideos = used.videos + curMedia.filter(m => m.type === 'video').length
    const remain = isVideo
      ? MAX_VIDEOS_PER_DAY - usedVideos
      : MAX_IMAGES_PER_DAY - usedImages

    if (remain <= 0) {
      wx.showToast({
        title: isVideo
          ? '今天视频最多 ' + MAX_VIDEOS_PER_DAY + ' 个'
          : '今天图片最多 ' + MAX_IMAGES_PER_DAY + ' 张',
        icon: 'none'
      })
      return
    }

    // 同时受单条日记总上限 9 约束
    const count = Math.min(remain, 9 - this.data.media.length)
    if (count <= 0) {
      wx.showToast({ title: '最多添加 9 个', icon: 'none' })
      return
    }

    wx.chooseMedia({
      count: count,
      mediaType: mediaType,
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const files = (res.tempFiles || []).filter(f => f && f.tempFilePath)
        if (files.length === 0) return
        // 视频护栏：超 30 秒 / 超 25MB 的整段跳过，不上传不占云空间
        const g = mediaGuard.guard(files)
        if (g.tooLong || g.tooBig) wx.showToast({ title: mediaGuard.guardToast(g.tooLong, g.tooBig), icon: 'none' })
        if (g.pass.length === 0) return
        this.uploadMediaFiles(g.pass)
      }
    })
  },

  // 图片强压缩：质量 65、宽不超过 1080px（一张 3-5MB 压到 200-400KB），压缩失败退回原图
  compressImage(src) {
    return new Promise((resolve) => {
      wx.compressImage({
        src: src,
        quality: 65,
        compressedWidth: 1080, // 基础库 2.26.0+ 支持，低版本自动忽略
        success: (res) => resolve(res.tempFilePath || src),
        fail: () => resolve(src)
      })
    })
  },

  async uploadMediaFiles(files) {
    this.setData({ mediaUploading: true })
    wx.showLoading({ title: '上传中...' })
    const added = []
    let failed = 0
    let uploadedBytes = 0
    for (const f of files) {
      const isVideo = f.fileType === 'video'
      try {
        // 图片先强压缩再上传；视频直接传云端（本地不留文件，只存 fileID 引用）
        const uploadPath = isVideo ? f.tempFilePath : await this.compressImage(f.tempFilePath)
        const cloudPath = 'media/' + (isVideo ? 'v' : 'i') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8) + (isVideo ? '.mp4' : '.jpg')
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: uploadPath
        })
        const fsize = await mediaGuard.getFileSize(uploadPath)
        const item = {
          fileID: uploadRes.fileID,
          type: isVideo ? 'video' : 'image',
          duration: isVideo ? Math.round(f.duration || 0) : 0,
          size: fsize, // 记录实际上传字节：删除日记清理云端媒体时同步扣减本地用量估算
          // 会话内预览图：图片用本地压缩路径；视频用首帧封面（优先云端，上传失败退回本地临时图，均不落盘）
          thumb: isVideo ? (f.thumbTempFilePath || f.tempFilePath) : uploadPath
        }
        uploadedBytes += fsize
        // 视频封面：把微信生成的视频首帧小图一并传云端（首页列表展示封面用）；失败不影响视频本身
        if (isVideo && f.thumbTempFilePath) {
          try {
            const thumbSize = await mediaGuard.getFileSize(f.thumbTempFilePath)
            const thumbRes = await wx.cloud.uploadFile({
              cloudPath: 'media/t_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8) + '.jpg',
              filePath: f.thumbTempFilePath
            })
            if (thumbRes && thumbRes.fileID) {
              item.thumb = thumbRes.fileID // 会话预览与持久化均用云端封面
              item.thumbSize = thumbSize
              uploadedBytes += thumbSize
            }
          } catch (e) { /* 封面上传失败忽略：视频照常保存，列表回退占位图 */ }
        }
        added.push(item)
      } catch (e) {
        failed++
      }
    }
    wx.hideLoading()
    if (uploadedBytes > 0) mediaGuard.addMediaUsage(uploadedBytes) // 用量估算累计（达阈值提醒）
    // 记录本次会话新上传的云文件（完整项含封面）：保存/放弃时才据此清理孤儿（移除动作本身不删云端）
    const sess = this._sessionUploaded || (this._sessionUploaded = [])
    added.forEach(a => sess.push(a))
    this.setData({
      mediaUploading: false,
      media: this.data.media.concat(added).slice(0, 9)
    })
    if (failed > 0) {
      wx.showToast({ title: failed + ' 个上传失败，已跳过', icon: 'none' })
    }
  },

  removeMedia(e) {
    const idx = e.currentTarget.dataset.index
    const media = this.data.media.slice()
    media.splice(idx, 1)
    this.setData({ media: media })
  },

  // 预览图片
  previewMedia(e) {
    const idx = e.currentTarget.dataset.index
    const images = this.data.media.filter(m => m.type === 'image').map(m => m.fileID)
    if (images.length === 0) return
    const target = this.data.media[idx]
    const current = target && target.type === 'image' ? target.fileID : images[0]
    wx.previewImage({ current: current, urls: images })
  },

  serializeMedia() {
    return (this.data.media || []).map(m => {
      const isVideo = m.type === 'video'
      // 视频封面：仅持久化云端文件（本地临时路径不落盘，重启后无效）
      const cloudThumb = isVideo && m.thumb && m.thumb.indexOf('cloud://') === 0 ? m.thumb : ''
      return {
        fileID: m.fileID,
        type: m.type,
        duration: m.duration || 0,
        size: m.size || 0, // 保留实际上传字节：删除日记/编辑移除媒体时同步扣减本地用量估算
        thumb: cloudThumb,
        thumbSize: cloudThumb ? (m.thumbSize || 0) : 0
      }
    })
  },

  // ===== 心情 =====

  // 日期行心情胶囊：打开/关闭独立心情选择浮层
  toggleMoodPicker() {
    this.setData({ showMoodPicker: !this.data.showMoodPicker })
  },

  closeMoodPicker() {
    this.setData({ showMoodPicker: false })
  },

  selectMood(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'none') {
      this.setData({ mood: '', moodLabel: '', moodColor: '', moodBg: '', showMoodPanel: false, showMoodPicker: false })
      return
    }
    this.setData({
      mood: key,
      moodLabel: util.MOOD_MAP[key].label,
      moodColor: util.getMoodColor(key),
      moodBg: util.getMoodBg(key),
      showMoodPanel: false,
      showMoodPicker: false
    })
  },

  // ===== 位置 =====
  chooseLocation() {
    this.setData({ showAddPanel: false, showMoodPanel: false })
    wx.chooseLocation({
      success: (res) => {
        if (!res || !res.name) return
        this.setData({
          location: {
            name: res.name,
            address: res.address || '',
            latitude: res.latitude || 0,
            longitude: res.longitude || 0
          }
        })
        // 用所选位置刷新天气
        if (res.latitude && res.longitude) {
          this.fetchWeather(res.latitude, res.longitude)
        }
      },
      fail: (err) => {
        if (err && (err.errMsg || '').indexOf('auth deny') !== -1) {
          wx.showModal({
            title: '需要位置权限',
            content: '记录日记位置需要使用定位，请在设置中开启权限',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
        }
      }
    })
  },

  clearLocation() {
    this.setData({ location: null })
  },

  // ===== 定位城市 + 天气（日期行右侧）=====
  loadWeather() {
    const self = this
    wx.getLocation({
      type: 'gcj02',
      success: (loc) => {
        self.fetchWeather(loc.latitude, loc.longitude)
      },
      fail: () => {
        // 未授权定位或失败：不显示天气，静默处理
      }
    })
  },

  fetchWeather(latitude, longitude) {
    weather.getWeather(latitude, longitude).then((info) => {
      if (info && info.icon) {
        this.setData({ weatherInfo: info })
      }
    })
  },

  closeAllPanels() {
    this.setData({ showEmojiPanel: false, showAddPanel: false, showMoodPanel: false, showMoodPicker: false, showDatePicker: false })
  },

  // ===== 侧边栏（日记本 / 我的）=====
  openSidebar() {
    this.refreshSidebar()
    this.refreshDailyQuote()
    this.setData({ showSidebar: true })
  },

  closeSidebar() {
    this.setData({ showSidebar: false })
  },

  // ===== [dailyquote v1] 每日一签（文化推广位）=====
  // 取「当天那一签」的卡片两行；纯本地计算，不会失败，无需 loading/兜底文案
  refreshDailyQuote() {
    this.setData({ dailyQuote: dailyQuote.getToday() })
  },

  // 进全篇页：透传下标（非法下标由 dailyQuote.safeIndex 回落今天）
  goToDailyQuote() {
    const i = this.data.dailyQuote.index
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/quote/quote?i=' + i })
  },

  // ===== 新手引导（5 步：写日记页 2 步 + 侧栏 2 步 → 设置页 1 步）=====
  // 步骤表 / 状态机 / 几何计算全在 utils/guide.js（纯函数、可单测）；本页只决定
  // 「什么时候播」「怎么把元素量出来交给遮罩组件」。

  // 进页面：够条件就自动开播。裁决逻辑在 guide.evalStart（纯函数、可单测）——
  // 本页只负责把状态喂进去、按回的动作执行。
  maybeStartGuide() {
    const popup = this.selectComponent('#privacyPopup')
    const action = guide.evalStart({
      active: guide.isActive(),
      belongsHere: guide.stepBelongsTo('write'),
      shouldAuto: guide.shouldAutoStart(),
      // 注意用「查询是否有结论」而不是「此刻是否可见」：查询是异步的，
      // 用可见性判会在回调返回前误判成「没有弹层」（首启两弹叠着弹的根因）
      privacyChecked: this._privacyChecked === true,
      privacyVisible: !!(popup && popup.data && popup.data.visible)
    })
    // 让路：隐私弹窗可能马上冒出来 / 正开着 → 记住「在等」，由 onPrivacyClosed 接上
    if (action === 'wait') { this._guideWaiting = true; return }
    if (action === 'none') return
    if (action === 'abort') { guide.abort(); return } // 从设置页返回：半途状态失效（不写标记 → 下次从头播）
    if (action === 'resume') { this.showGuideStep(); return }
    this.startGuide()
  },

  // 隐私查询有结论（tryShow resolve）：需要授权 → 弹窗已显示，等用户处理完再接（bind:close 回调）；
  // 不需要授权 → 直接看引导能不能走
  onPrivacyChecked(needAuth) {
    if (this._privacyTimer) { clearTimeout(this._privacyTimer); this._privacyTimer = null } // 结论已到，撤掉兜底定时器
    this._privacyChecked = true
    if (needAuth) return
    this.resumeGuide()
  },

  // 隐私弹窗关闭回调（组件 bind:close）
  onPrivacyClosed() {
    this._privacyChecked = true // 关闭必然意味着查询已有结论（防御性补齐）
    this.resumeGuide()
  },

  // 让路结束：引导若在等，重新裁决一次（不直接 startGuide —— 中间页面状态可能已变）
  resumeGuide() {
    if (!this._guideWaiting) return
    this._guideWaiting = false
    this.maybeStartGuide()
  },

  startGuide() {
    guide.start()
    // 等首屏布局稳定再量坐标（onShow 里立刻量可能拿到 0 尺寸）
    setTimeout(() => this.showGuideStep(), 300)
  },

  // 展示当前步：需要侧栏的步骤先拉开侧栏 —— 抽屉是 transform 过渡，
  // 必须等动画结束（~300ms）再量，否则量到的是滑出屏幕外的坐标
  showGuideStep() {
    const step = guide.getStep()
    if (!step) { this.endGuide(); return }
    if (step.pre === 'sidebar' && !this.data.showSidebar) {
      this.setData({ showSidebar: true }, () => {
        setTimeout(() => this.measureGuideStep(step), 360)
      })
      return
    }
    this.measureGuideStep(step)
  },

  measureGuideStep(step) {
    guide.measure(this, step.target, (rect) => {
      this.setData({
        guideVisible: true,
        guideStep: step,
        guideRect: rect,
        guideShape: step.shape || 'rect'
      })
    })
  },

  onGuideNext() {
    const step = guide.getStep()
    if (!step) { this.endGuide(); return }
    // 跨页（1.B）：第 4 步「去设置」→ 先推进到第 5 步，再跳设置页续接
    if (step.action === 'goSetting') {
      guide.next()
      this.setData({ guideVisible: false, guideRect: null, showSidebar: false })
      wx.navigateTo({ url: guide.SETTING_URL })
      return
    }
    const nextStep = guide.next()
    if (!nextStep) { this.endGuide(true); return }
    this.showGuideStep()
  },

  onGuideSkip() {
    this.endGuide(true)
  },

  // 收尾：走完或跳过都算「看过」（写标记，不再打扰），并把页面恢复常态
  endGuide(done) {
    if (done) guide.finish()
    else guide.abort()
    this.setData({ guideVisible: false, guideRect: null, showSidebar: false })
    if (done) wx.showToast({ title: '随时可在设置里重看引导', icon: 'none' })
  },

  // 侧栏日记本：默认只显示最近 SIDEBAR_DIARY_LIMIT 篇，其余通过「查看全部」进日记本页
  refreshSidebar() {
    const stats = storage.getStats()
    const list = storage.getAllDiaries().map(d => ({
      id: d.id,
      title: util.stripDiaryTitleSuffix(d.title || '无题'),
      // 仅供搜索匹配用（不展示）
      preview: String(d.content || '').replace(/\n/g, ' ').slice(0, 100),
      // AI 概括的当日日记关键字（最多4字，AI 概括不出为空则不显示）
      keyword: pickSidebarKeyword(d.tags),
      dateText: util.formatRelativeTime(d.created_at)
    }))
    const userInfo = app.globalData.userInfo || wx.getStorageSync('userInfo')
    this.setData({
      stats: { total: stats.total, monthCount: stats.monthCount, streak: stats.streak },
      allSidebarDiaries: list,
      sidebarEmpty: list.length === 0,
      sidebarDiaries: this.applySidebarSearch(this.data.sidebarKeyword, list),
      userInfo: userInfo,
      hasUserInfo: !!userInfo
    })
  },

  applySidebarSearch(keyword, list) {
    const kw = (keyword || '').trim().toLowerCase()
    // 无搜索词：只显示最近 3 篇
    if (!kw) return list.slice(0, SIDEBAR_DIARY_LIMIT)
    // 搜索时在全部日记中匹配（标题 + 内容）
    return list.filter(d =>
      (d.title || '').toLowerCase().indexOf(kw) !== -1 ||
      (d.preview || '').toLowerCase().indexOf(kw) !== -1
    )
  },

  onSidebarSearch(e) {
    const keyword = e.detail.value
    this.setData({
      sidebarKeyword: keyword,
      sidebarDiaries: this.applySidebarSearch(keyword, this.data.allSidebarDiaries)
    })
  },

  clearSidebarSearch() {
    this.setData({
      sidebarKeyword: '',
      sidebarDiaries: this.data.allSidebarDiaries.slice(0, SIDEBAR_DIARY_LIMIT)
    })
  },

  // 点击侧边栏中的日记 → 打开详情
  openDiary(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  goToIndex() {
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/index/index' })
  },

  goToArchive() {
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/archive/archive' })
  },

  // 云端备份（可选加密备份，明文永不上传）
  goBackup() {
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/backup/backup' })
  },

  // 设置页
  goToSetting() {
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/setting/setting' })
  },

  // [sidebar-local-backup v1] 本地备份：全量导出 Word（.docx，含档案），直接触发不建页
  onLocalBackup() {
    this.setData({ showSidebar: false })
    const total = storage.getAllDiaries().length
    if (!total) {
      wx.showToast({ title: '暂无日记可导出', icon: 'none' })
      return
    }
    wx.showModal({
      title: '本地备份',
      content: '将导出全部 ' + total + ' 篇日记（含档案）为 Word 文件',
      success: (res) => {
        if (res.confirm) {
          transfer.exportToWord(() => {
            wx.showToast({ title: '暂无日记可导出', icon: 'none' })
          })
        }
      }
    })
  },

  // 智能总结
  goToSummary() {
    this.setData({ showSidebar: false })
    wx.navigateTo({ url: '/pages/summary/summary' })
  },

  getUserProfile() {
    wx.getUserProfile({
      desc: '用于展示个人信息',
      success: (res) => {
        const userInfo = res.userInfo
        app.globalData.userInfo = userInfo
        wx.setStorageSync('userInfo', userInfo)
        this.setData({ userInfo: userInfo, hasUserInfo: true })
        wx.showToast({ title: '授权成功', icon: 'success' })
      },
      fail: () => {
        wx.showToast({ title: '已取消授权', icon: 'none' })
      }
    })
  },

  showAbout() {
    wx.showModal({
      title: '关于AI日记',
      content: 'AI日记\n\n记录每一天的故事，写完可以用 AI 优化润色，让表达更生动。\n\n所有数据存储在本地，保护你的隐私。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  // ===== AI 优化（最小范围）=====
  onOptimize() {
    let content = this.data.content.trim()
    if (!content) {
      wx.showToast({ title: '请先写下日记内容', icon: 'none' })
      return
    }
    // 清掉上一次的待重放高亮（若本次有指令/名词纠正会重新记录）
    this._pendingEmbedHighlight = null
    // 本地指令执行的「优化要点」条目（与云端 AI 的 changes 合并展示）
    this._localEditNotes = []

    // 手写进正文的增删改指令：先执行（指令句不保留在正文中），并高亮改动
    let pending = null
    const embedded = aiEdit.extractEmbedded(content)
    if (embedded.blocked && embedded.blocked.length) {
      wx.showToast({ title: '「前边所有内容」不支持删除，请指明要删的内容', icon: 'none' })
    }
    if (embedded.changed) {
      content = embedded.content.trim()
      this._localEditNotes = embedded.applied.map(p => this.editNote(p))

      const words = embedded.applied
        .map(p => p.result.highlightWord)
        .filter(w => !!w)
      const title = embedded.applied.length === 1
        ? this.editTitle(embedded.applied[0].edit)
        : '已执行 ' + embedded.applied.length + ' 条修改指令'
      pending = { title: title, words: words }

      if (!content) {
        this._setContent(content)
        wx.showToast({ title: '修改指令已执行，正文为空', icon: 'none' })
        return
      }
    }

    // 备案名词匹配纠正（同音/发音接近/拼音串 → 档案中的正确写法）
    const matchInfo = nameMatch.matchArchives(content, storage.getArchives())
    if (matchInfo.replaced.length > 0) {
      content = matchInfo.text
      const matchWords = Array.from(new Set(matchInfo.replaced.map(r => r.to)))
      if (pending) {
        pending.words = pending.words.concat(matchWords)
        pending.title = pending.title + '；' + this.matchTitle(matchInfo.replaced)
      } else {
        pending = { title: this.matchTitle(matchInfo.replaced), words: matchWords }
      }
    }

    if (pending) {
      this._setContent(content)
      // AI 优化结果面板会盖住高亮视图，记录下来待面板关闭后重放
      this._pendingEmbedHighlight = pending
      this.showEditHighlight(pending.title, content, pending.words)
    }

    if (content.length < 20) {
      wx.showToast({ title: '内容太短，先多写几句吧', icon: 'none' })
      return
    }

    this.setData({
      optimizing: true,
      showOptimizeResult: false,
      aiLoadingText: 'AI正在优化你的日记...',
      aiLoadingSub: '润色表达 · 让文字更通顺'
    })

    // 加载档案供 AI 识别人名地名
    const archives = storage.getArchives().map(a => ({ name: a.name, description: a.description }))

    aiCloud.callAI(content, this.data.mood, 'optimize', archives).then(result => {
      this.setData({ optimizing: false })

      if (!result.optimized) {
        wx.showToast({ title: result.error || '优化失败，请重试', icon: 'none' })
        return
      }
      if (result.from === 'local') {
        wx.showToast({ title: 'AI服务未连接，已用本地简单优化', icon: 'none', duration: 2500 })
      }

      // 优化稿再做一次备案名词匹配纠正（AI 润色时也可能写错名词）
      let optimized = result.optimized
      const optMatch = nameMatch.matchArchives(optimized, storage.getArchives())
      if (optMatch.replaced.length > 0) {
        optimized = optMatch.text
        const optWords = Array.from(new Set(optMatch.replaced.map(r => r.to)))
        if (this._pendingEmbedHighlight) {
          this._pendingEmbedHighlight.words = this._pendingEmbedHighlight.words.concat(optWords)
        } else {
          this._pendingEmbedHighlight = { title: this.matchTitle(optMatch.replaced), words: optWords }
        }
      }

      this.setData({
        showOptimizeResult: true,
        originalContent: content,
        optimizedContent: optimized,
        // 优化要点 = 本地增删改指令条目 + 云端 AI 润色要点
        optimizeChanges: (this._localEditNotes || []).concat(result.changes || []),
        showOriginal: false
      })
    })
  },

  onOptimizedInput(e) {
    this.setData({ optimizedContent: e.detail.value })
  },

  toggleOriginal() {
    this.setData({ showOriginal: !this.data.showOriginal })
  },

  // AI 优化结果面板关闭后，重放手写指令执行结果的高亮（面板打开时被盖住）
  replayEmbedHighlight() {
    const h = this._pendingEmbedHighlight
    this._pendingEmbedHighlight = null
    if (h && h.words && h.words.length > 0) {
      this.showEditHighlight(h.title, this.data.content, h.words)
    }
  },

  applyOptimize() {
    const text = this.data.optimizedContent.trim()
    if (!text) {
      wx.showToast({ title: '优化稿不能为空', icon: 'none' })
      return
    }
    this.setData({
      content: text,
      showOptimizeResult: false,
      optimizedContent: '',
      optimizeChanges: [],
      optimized: true
    })
    wx.showToast({ title: '已应用优化稿', icon: 'success' })
    this.replayEmbedHighlight()
  },

  discardOptimize() {
    this.setData({
      showOptimizeResult: false,
      optimizedContent: '',
      optimizeChanges: []
    })
    this.replayEmbedHighlight()
  },

  reOptimize() {
    this.setData({ showOptimizeResult: false })
    this.onOptimize()
  },

  // ===== 保存 =====
  onSave() {
    const { content, mood, optimized, diaryDate } = this.data
    this._navigated = false // 本次保存的跳转尚未发生（防重入标记复位）
    this._entityCheckActive = false // 本次保存的实体识别尚未发起

    if (!content.trim()) {
      wx.showToast({ title: '请输入日记内容', icon: 'none' })
      return
    }

    // 防炸：本地存储超过 8MB 时提醒清理/导出（提示但不阻断保存，媒体本体都在云端）
    this.checkStorageSpace()

    // 保存前预检容量：不足则提示并中止（不进入保存流程，按钮不会卡在「保存中」）
    const space = storage.precheckDiarySave({
      content: content.trim(),
      mood: mood || '',
      source: optimized ? 'ai' : 'manual',
      tags: [],
      location: this.data.location || null,
      media: this.serializeMedia(),
      created_at: this.resolveCreatedAt(diaryDate)
    })
    if (!space.ok) {
      wx.showModal({
        title: '存储空间不足',
        content: '本地存储已满，本次未保存。\n\n请先「导出备份」保存日记，再删除部分旧日记腾出空间，然后重新点击保存。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    this.setData({ saving: true })
    this._savingMedia = true // 保存进行中：onUnload 不清理会话上传，等本流程出口决定
    const savedContent = content.trim()

    // 【并行优化】点保存即发起实体识别：与标签生成/同日融合/落库并行跑，
    // 避免「落库 + AI」串行叠加后吃掉等待上限，导致识别结果回来时已被放弃
    this._pendingEntityCheck = {
      content: savedContent,
      promise: aiCloud.callAIExtractEntities(savedContent)
    }

    // 检查日记本中是否已有同一天的日记：有则 AI 融合成一篇
    // 必须排除「AI 总结」类产物：总结是产出物，既不能被融合改写，也不能作为融合底稿
    // （否则新日记会并进总结；更糟的是其他普通日记可能被当孤儿删掉）
    const sameDayDiaries = storage.getAllDiaries().filter(d =>
      util.getDateKey(new Date(d.created_at)) === diaryDate && !util.isAiSummaryDiary(d)
    )

    if (sameDayDiaries.length === 0) {
      this.doAddDiary(savedContent, diaryDate, mood, optimized)
    } else {
      this.mergeWithSameDay(sameDayDiaries, savedContent, diaryDate, mood)
    }
  },

  // 防炸：本地存储检查，超过 8MB 提示「空间将满，请清理或导出」（只提示不阻断）
  // 注意：wx.getStorageInfo 返回的 currentSize 单位是 KB，除以 1024 得 MB
  checkStorageSpace() {
    wx.getStorageInfo({
      success: (res) => {
        const usedMB = (res.currentSize || 0) / 1024
        if (usedMB > 8) {
          wx.showModal({
            title: '空间将满',
            content: '本地已使用 ' + usedMB.toFixed(1) + 'MB，请清理或导出备份，以免日记丢失。',
            showCancel: false,
            confirmText: '知道了'
          })
        }
      },
      fail: () => {}
    })
  },

  doAddDiary(savedContent, diaryDate, mood, optimized) {
    // 天气只在记录「今天」时保存（页面天气是实时获取的，补写旧日期会失真）
    const todayWeather = (diaryDate === util.getDateKey() && this.data.weatherInfo)
      ? { ...this.data.weatherInfo }
      : null
    let savedOk = false // 落库成功标记：之后的异常（实体识别/自动分段等）不属于「保存失败」
    aiCloud.callAITags(savedContent, mood).then(tagResult => {
      const finalTags = (tagResult.tags || []).slice(0, 5)
      // 先算好保存媒体与被移除文件：保存成功才清理本会话上传但未保留的云文件
      const savedMedia = this.serializeMedia()
      const removed = mediaGuard.computeRemovedFiles([], this._sessionUploaded || [], savedMedia)

      const saved = storage.saveDiary({
        title: util.getDefaultTitle(diaryDate),
        content: savedContent,
        mood: mood || '',
        source: optimized ? 'ai' : 'manual',
        tags: finalTags,
        location: this.data.location || null,
        media: savedMedia,
        weather: todayWeather,
        created_at: this.resolveCreatedAt(diaryDate)
      })

      if (!saved) {
        this._savingMedia = false // 存储已满：保存终止，用户离开时应由 onUnload 清理会话上传
        this.setData({ saving: false }) // 存储已满：复位按钮状态（提示已在 storage 弹窗）
        return
      }
      savedOk = true // 日记已安全写入本地：之后任何异常都不应报「保存失败」
      console.log('[write] 落库成功, id =', saved.id, '，实体识别已发起')

      // ★ 顺序纪律：实体识别（备案提醒）必须是落库后的第一步。
      //   它是保存流程里唯一的交互步骤，绝不允许被后面任何一步的异常吞掉。
      //   `_lastSavedId` 必须提前就绪：识别结束后由它跳转详情页（afterSaveNavigate 有防重入）。
      this._lastSavedId = saved.id
      this._entityCheckActive = true
      try {
        this.checkNewEntities(savedContent) // 保存后检测新实体，检测完再跳转详情
      } catch (e) {
        this._entityCheckActive = false
        console.error('[write] 实体识别发起异常（直接跳转详情页）:', e)
        this.afterSaveNavigate()
      }

      // ↓↓↓ 以下都是「非关键步骤」：各自兜底，任何一步炸了都不影响已保存的日记，
      //     更不允许反过来影响上面的实体识别。
      safePostSave('标记首页刷新', () => { app.globalData.needRefresh = true })
      safePostSave('清理被移除的云端媒体', () => {
        this._sessionUploaded = []
        if (!removed.length) return
        mediaGuard.deleteMediaItems(removed).then((r) => {
          if (r && r.failed > 0) {
            wx.showToast({ title: r.failed + ' 个云端媒体删除失败', icon: 'none' })
          }
        })
      })
      safePostSave('复位页面状态（含草稿作废）', () => { this.resetAfterSave(diaryDate) })
      safePostSave('保存成功提示', () => { wx.showToast({ title: '保存成功', icon: 'success' }) })
      // 上报「今天已写」（闹钟判断依据）：reminder 内部已静默，这里再兜一层
      safePostSave('闹钟「今天已写」上报', () => { reminder.callMarkWritten(diaryDate) })
    }).catch((err) => {
      this._savingMedia = false
      this.setData({ saving: false })
      if (savedOk) {
        // 日记已安全落库：后续增强步骤的异常不应报「保存失败」吓用户。
        // ⚠️ 但绝不能在这里抢先跳转：实体识别若已在途，跳走会把备案弹窗吃掉
        //    （识别内部有 8 秒上限 + afterSaveNavigate 防重入，交给它跳）。
        console.error('[write] 日记已保存，但后续步骤异常:', err)
        if (!this._entityCheckActive) this.afterSaveNavigate()
        return
      }
      // 真正的保存失败（落库前）：AI 标签获取异常/网络问题，内容保留在输入框可重试
      console.error('[write] 保存失败（未落库）:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    })
  },

  mergeWithSameDay(sameDayDiaries, savedContent, diaryDate, mood) {
    const base = sameDayDiaries[sameDayDiaries.length - 1]
    const oldContent = sameDayDiaries.map(d => d.content).join('\n\n')
    const archives = storage.getArchives().map(a => ({ name: a.name, description: a.description }))

    let savedOk = false // 落库成功标记：之后的异常（实体识别/自动分段等）不属于「保存失败」
    aiCloud.callAIMergeDiary(oldContent, savedContent, {
      oldMood: base.mood || '',
      newMood: mood || '',
      archives: archives
    }).then(result => {
      const mergedContent = (result.merged || oldContent + '\n\n' + savedContent).trim()
      // 天气：记录今天的日记用当前天气，补写旧日期保留原有天气
      const todayWeather = (diaryDate === util.getDateKey() && this.data.weatherInfo)
        ? { ...this.data.weatherInfo }
        : (base.weather || null)

      aiCloud.callAITags(mergedContent, mood).then(tagResult => {
        const finalTags = (tagResult.tags || []).slice(0, 5)
        // 先算好保存媒体与被移除文件：融合后只保留出现在结果中的本会话新传文件
        const savedMedia = this.serializeMedia()
        const removed = mediaGuard.computeRemovedFiles([], this._sessionUploaded || [], savedMedia)

        const updated = storage.updateDiary(base.id, {
          title: util.getDefaultTitle(diaryDate),
          content: mergedContent,
          mood: mood || base.mood || '',
          source: 'merged',
          tags: finalTags,
          location: this.data.location || base.location || null,
          weather: todayWeather,
          media: (base.media || []).concat(savedMedia)
        })

        if (!updated) {
          this._savingMedia = false // 存储已满：保存终止，用户离开时应由 onUnload 清理会话上传
          this.setData({ saving: false }) // 存储已满：复位按钮状态（提示已在 storage 弹窗）
          return
        }
        savedOk = true // 日记已安全写入本地：之后任何异常都不应报「保存失败」

        this._sessionUploaded = []
        if (removed.length) {
          mediaGuard.deleteMediaItems(removed).then((r) => {
            if (r && r.failed > 0) {
              wx.showToast({ title: r.failed + ' 个云端媒体删除失败', icon: 'none' })
            }
          })
        }

        const orphanDiaries = sameDayDiaries.filter(d => d.id !== base.id)
        const orphanIDs = mediaGuard.collectFileIDs(orphanDiaries)
        let orphanBytes = 0
        orphanDiaries.forEach(d => { orphanBytes += mediaGuard.sumMediaBytes(d.media || []) })
        if (orphanBytes > 0) mediaGuard.subtractMediaUsage(orphanBytes)
        orphanDiaries.forEach(d => storage.deleteDiary(d.id))
        if (orphanIDs.length) mediaGuard.deleteCloudFiles(orphanIDs) // 被融合覆盖的旧日记媒体一并清云

        this._lastSavedId = base.id
        this._entityCheckActive = true
        try {
          // 只对「本次新增的内容」识别名词备案，旧日记里已存在的名词不再重复提示
          this.checkNewEntities(savedContent)
        } catch (e) {
          this._entityCheckActive = false
          console.error('[write] 实体识别发起异常（直接跳转详情页）:', e)
          this.afterSaveNavigate()
        }
        safePostSave('标记首页刷新', () => { app.globalData.needRefresh = true })
        safePostSave('复位页面状态（含草稿作废）', () => { this.resetAfterSave(diaryDate) })
        safePostSave('融合保存提示', () => {
          wx.showToast({
            title: result.from === 'cloud' ? '已与当日日记融合保存' : 'AI 融合暂不可用，已合并保存',
            icon: result.from === 'cloud' ? 'success' : 'none'
          })
        })
      }).catch((err) => {
        this._savingMedia = false
        this.setData({ saving: false })
        if (savedOk) {
          // 日记已安全落库：后续步骤异常不报「保存失败」；
          // 实体识别在途时不抢先跳转（跳走会吃掉备案弹窗）
          console.error('[write] 融合已保存，但后续步骤异常:', err)
          if (!this._entityCheckActive) this.afterSaveNavigate()
          return
        }
        // AI 标签获取失败（落库前）：内容保留在输入框可重试
        console.error('[write] 融合保存失败（未落库）:', err)
        wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      })
    }).catch((err) => {
      this._savingMedia = false
      this.setData({ saving: false })
      if (savedOk) {
        // 同上：融合结果已落库，后续异常不影响数据
        console.error('[write] 融合已保存，但后续步骤异常（不影响数据）:', err)
        return
      }
      // AI 融合失败（落库前）：内容保留在输入框可重试
      console.error('[write] AI 融合失败（未落库）:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    })
  },

  resetAfterSave(diaryDate) {
    this._savingMedia = false
    // 已保存：草稿作废（防下次进入误恢复）
    // draft.clear() 内部已静默，这里再兜一层：草稿异常绝不允许中断「保存后复位」
    try { draft.clear() } catch (e) { console.error('[write] 清除草稿异常（已忽略）:', e) }
    this._sessionUploaded = [] // 已保存：丢弃会话上传清单（保留文件已入库；清理动作在保存出口完成）
    const todayKey = util.getDateKey()
    this.setData({
      saving: false,
      content: '',
      mood: '',
      moodLabel: '',
      moodColor: '',
      moodBg: '',
      optimized: false,
      showOptimizeResult: false,
      optimizedContent: '',
      optimizeChanges: [],
      location: null,
      media: [],
      diaryDate: todayKey,
      dateLabel: this.buildDateLabel(todayKey)
    })
  },

  // 丢弃本会话内容：清理新上传但未落入任何保存日记的云文件（静默，取消/离开/保存失败时用）
  discardSessionUploads() {
    const sess = this._sessionUploaded || []
    this._sessionUploaded = []
    if (sess.length) mediaGuard.deleteMediaItems(sess)
  },

  // ===== 实体备案 =====
  checkNewEntities(content) {
    console.log('[write] checkNewEntities 开始（AI 实体识别中，最多等 8 秒）')
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      this._entityCheckActive = false // 实体识别流程结束：解除「在途」标记
      console.log('[write] 实体识别结束, showEntityPrompt =', this.data.showEntityPrompt, '，准备跳转')
      if (!this.data.showEntityPrompt) {
        this.afterSaveNavigate()
      }
    }

    // 上限 8 秒：识别与保存并行后通常 2-4 秒即返回，这里只兜极端慢的情况
    const timeout = setTimeout(finish, 8000)

    // 复用 onSave 里已并行发起的识别请求（内容一致时），否则当场发起
    const pending = this._pendingEntityCheck
    this._pendingEntityCheck = null
    const req = (pending && pending.content === content)
      ? pending.promise
      : aiCloud.callAIExtractEntities(content)

    req.then(result => {
      clearTimeout(timeout)
      if (resolved) return

      if (!result.entities || result.entities.length === 0) {
        finish()
        return
      }

      // 正文始终保持原样（不删除解释部分），这里只负责筛选出可备案的名词
      // 过滤：① name 必须是 2-6 字名词、description 有实际解释意义
      //      ② 机械校验（entityClean.isExplainedNoun）：原文里必须真实存在「名词 + 定义句式」，
      //         排除 AI 误报的虚词（如「分别」）、带助词的短语（如「的第一天」），
      //         以及从更长专有名词里截出的子串（如「中国考古博物馆」→「古博物馆」）
      const existing = new Map(storage.getArchives().map(a => [a.name, a]))
      const all = result.entities
        .filter(e => e.name && e.description && e.name.length >= 2 && e.name.length <= 6 && e.description.length >= 4)
        .filter(e => entityClean.isExplainedNoun(e.name, content))
        .map(e => {
          const old = existing.get(e.name)
          return {
            name: e.name,
            description: e.description,
            explanation: e.explanation || '',
            type: e.type || 'other',
            // 已备案的名词不再提醒存档（二次编辑保存也不重复提示）
            exists: !!old,
            checked: true
          }
        })

      if (all.length === 0) {
        finish()
        return
      }

      // 已备案的名词：不再弹窗提醒存档（避免重复打扰）
      const promptEntities = all.filter(e => !e.exists)

      if (promptEntities.length === 0) {
        finish()
        return
      }

      this.setData({ showEntityPrompt: true, newEntities: promptEntities })
    }).catch(() => {
      clearTimeout(timeout)
      finish()
    })
  },

  // 保存后跳转到刚保存的日记详情
  afterSaveNavigate() {
    if (this._navigated) return // 防重入：兜底路径和正常路径只会跳一次
    this._navigated = true
    console.log('[write] afterSaveNavigate 进入, id =', this._lastSavedId)
    if (this._lastSavedId) {
      const navUrl = '/pages/detail/detail?id=' + this._lastSavedId
      // 先跳转：自动分段是后台增强功能，永远不允许挡在导航前面
      wx.navigateTo({
        url: navUrl,
        success: () => console.log('[write] navigateTo 详情页成功'),
        fail: (err) => {
          console.error('[write] navigateTo 失败，尝试 redirectTo 兜底:', err)
          // 兜底一：navigateTo 失败（页面栈异常等）时，用 redirectTo 替换当前页进入详情
          wx.redirectTo({
            url: navUrl,
            success: () => console.log('[write] redirectTo 兜底成功'),
            fail: (err2) => {
              console.error('[write] redirectTo 也失败:', err2)
              // 兜底二：屏幕上直接弹出失败原因（不依赖 Console，真机也能看到）
              wx.showToast({
                title: '跳转失败: ' + ((err2 && err2.errMsg) || (err && err.errMsg) || '未知'),
                icon: 'none',
                duration: 4000
              })
            }
          })
        }
      })
      // 静默自动分段：长且无换行的日记，后台调 AI 划分段落后原地更新（失败/校验不过保持原文）
      try {
        aiCloud.autoSegmentAfterSave(this._lastSavedId)
      } catch (e) {
        console.error('[write] 自动分段发起异常（不影响已保存日记）:', e)
      }
    }
  },

  toggleEntity(e) {
    const idx = e.currentTarget.dataset.index
    const entities = this.data.newEntities
    entities[idx].checked = !entities[idx].checked
    this.setData({ newEntities: entities })
  },

  confirmAddEntities() {
    const selected = this.data.newEntities.filter(e => e.checked)
    // 日记正文保持原样，不删除解释部分
    if (selected.length === 0) {
      this.setData({ showEntityPrompt: false, newEntities: [] })
      this.afterSaveNavigate()
      return
    }

    const items = selected.map(e => ({
      name: e.name,
      description: e.description
    }))

    // saveArchives 按 name 去重：已备案的名词只会更新描述，档案始终保留一条
    storage.saveArchives(items)
    this.setData({ showEntityPrompt: false, newEntities: [] })
    wx.showToast({ title: '已备案 ' + items.length + ' 条', icon: 'success' })
    setTimeout(() => {
      this.afterSaveNavigate()
    }, 1200)
  },

  skipEntities() {
    this.setData({ showEntityPrompt: false, newEntities: [] })
    this.afterSaveNavigate()
  },

  onShareAppMessage() {
    return {
      title: 'AI日记 — 记录每一天的故事',
      path: '/pages/write/write'
    }
  }
})
