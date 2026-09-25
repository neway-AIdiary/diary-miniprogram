/**
 * 智能总结页 pages/summary
 * 全局批量日记分析：文字/语音输入需求 → 前端本地读日记按时间筛选 → 云函数 aiSummary 调大模型 → 生成总结
 * 生成成功后跳「总结结果」页（pages/summary-result）显示 / 分享 / 编辑 / 保存，本页只负责生成
 */
const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const voice = require('../../utils/voice.js')
const dateRange = require('../../utils/dateRange.js') // [range-toolbar v1] 日期范围公共口径
const summaryNudge = require('../../utils/summaryNudge.js') // [summary-nudge v1] 智能总结篇数引导
const app = getApp()

// 快捷模板（[summary-shortcut v1.3] 六条）
// chip = 前几字（按钮：点击即按整句生成）；label = 整句（行内点按只填入输入框，不生成）
// 口径（拍板 1）：输入框所见即所得 —— prompt 就是 label 原句，不加任何前缀包装
// [v1.2] 不联动时间范围：点 chip 只填需求 + 生成，范围完全由顶部胶囊决定（原「拍板 2」撤销）
// [monthly-review v1] 例外：「月度复盘」chip 点击即按「本月 + 上月」生成（固定近两月，不看顶部胶囊）；
//   近两月无日记 → 提示「近两月没有日记记录，无法分析」。整句填入路径不触发该区间；
//   用户手动改过输入框后标志失效（恢复由胶囊决定）。见 onQuickGenerate / onGenerate 的 review 分支
const SHORTCUTS = [
  { chip: '月度复盘', label: '近两月日记的整体回顾' },
  { chip: '心迹追踪', label: '分析情绪与心态变化' },
  { chip: '强身规划', label: '对比运动记录拟定健身方案' },
  { chip: '学途建言', label: '总结学习情况给出提升建议' },
  { chip: '大事速览', label: '简要提取里程碑事件' },
  { chip: '年度剪影', label: '生成一份年度简短回顾' }
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
    // [footer-center v1.1] content-inner 实测最小高度（px）：scroll-view 内百分比
    // min-height 真机不生效，改 JS 测量兜底 —— 空态提示据此在末条模板与底栏间垂直居中
    scrollMinHeight: 0,
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
    liveText: '',
    voiceScrollTop: 0
  },

  onLoad() {
    // [range-toolbar v1] 日期范围状态：由 range-picker 组件 change 事件维护
    this._rangeState = { range: 'all', customStart: '', customEnd: '' }
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
      }, () => {
        // [voice-scroll v1] 说话多了自动滚到底：文本高于视口时把 scroll-top 推到底部
        //（内容单调变长 => 高度差单调增 => 每出新行都会触发一次滚动；文本未变则不 setData）
        if (!s.liveText || !wx.createSelectorQuery) return
        const q = wx.createSelectorQuery()
        q.select('.voice-text').boundingClientRect()
        q.select('.voice-text-scroll').boundingClientRect()
        q.exec((res) => {
          const txt = res && res[0]
          const box = res && res[1]
          if (!txt || !box || txt.height <= box.height) return
          const top = Math.ceil(txt.height - box.height)
          if (top > (this.data.voiceScrollTop || 0)) this.setData({ voiceScrollTop: top })
        })
      })
    })
  },

  onReady() {
    this.measureContent()
  },

  // [footer-center v1.1] 实测滚动区高度 → content-inner 的 px 最小高度
  // （scroll-view 内百分比 min-height 真机不生效，见 2026-09-23 用户反馈）
  measureContent() {
    if (!wx.createSelectorQuery) return
    const q = wx.createSelectorQuery()
    q.select('.content-scroll').boundingClientRect()
    q.exec((res) => {
      const rect = res && res[0]
      if (rect && rect.height > 0) {
        this.setData({ scrollMinHeight: Math.round(rect.height) })
      }
    })
  },

  onShow() {
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
    this.setData({ fontStyle: fontSetting.buildStyle() })
    this.measureContent() // [footer-center v1.1] 返回本页 / 字体设置变化后重测
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
    // [summary-freeze v1] 生成中冻结整页：不接收输入（遮罩已挡，此处是原生 textarea 的兜底）
    if (this.data.loading) return
    // [monthly-review v1] 手动改过需求 → 近两月固定区间失效（恢复由顶部胶囊决定）
    this._reviewRange = false
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
    // [summary-freeze v1] 生成中冻结整页：不起录
    // ⚠️ onHoldEnd **故意不加守卫** —— 生成开始前已在录音的会话必须能正常松手收尾，否则录音挂死
    if (this.data.loading) return
    this._suppressEnd = false
    // [hold-fast v1] 按下即起录：不再等 300ms，误触判定移到 voice.js#stop()
    this._isHolding = true
    voice.start({ contextText: this.data.prompt || '' })
  },

  onHoldEnd() {
    if (this._holdTimer) clearTimeout(this._holdTimer)
    if (this._isHolding) {
      this._isHolding = false
      voice.stop()
    }
    this.setData({ voiceCanceling: false })
  },

  // ===== 时间范围（range-picker 公共组件）[range-toolbar v1] =====
  onRangeChange(e) {
    // [summary-freeze v1] 生成中冻结整页：忽略范围变更
    // （本次生成已取区间快照，生成中改范围只会让用户误以为「改了生效」）
    if (this.data.loading) return
    const d = (e && e.detail) || {}
    this._rangeState = { range: d.range || 'all', customStart: d.customStart || '', customEnd: d.customEnd || '' }
  },

  // ===== 快捷模板 =====
  // 行内非 chip 区域（整句描述）：只填入输入框，用户可改完再点「生成总结」
  onShortcut(e) {
    // [summary-freeze v1] 生成中冻结整页：静默忽略（静默是用户口径：整页无响应，
    // 不再用 toast 提示「你点错了」；chip 压暗 + 遮罩压暗已给出「不可操作」信号）
    if (this.data.loading) return
    const fill = e.currentTarget.dataset.fill
    this._reviewRange = false // [monthly-review v1] 整句填入只填需求，不触发近两月固定区间
    this.setData({ prompt: fill })
    // [summary-shortcut v1.3] 点整句只填入、不生成 —— 用 toast 交代去向（否则用户不知道它去哪了）
    if (fill) wx.showToast({ title: '已填入输入框，可修改后生成', icon: 'none' })
  },

  // [summary-shortcut v1.3] 点 chip（前几字）：填入整句后立即生成（不改动时间范围）
  onQuickGenerate(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    // [summary-freeze v1] 生成中整页冻结：静默早退。
    // 前身是 v1.3 的「给反馈、不静默早退」——那条铁律的初衷是防**静默失败**（用户以为操作生效了），
    // 此处不适用：已有一个生成在跑 + 遮罩压暗 + chip 压暗，用户不会误解为「已按新要求生成」。
    // 用户 2026-09-23 拍板：生成中整页点击不反应（静默是口径的一部分）
    if (this.data.loading) return
    // [monthly-review v1] 「月度复盘」chip：本次生成固定用近两月区间（上月 1 日 ~ 今天），
    // 不看顶部胶囊；其余 chip 照旧只管需求
    this._reviewRange = (ds.chip === '月度复盘')
    if (ds.label) this.setData({ prompt: ds.label })
    this.onGenerate()
    // [v1.3] 确认反馈：让用户知道点对了地方。**只在真的进入生成态时才弹** ——
    // onGenerate 可能因「无日记 / 3 秒防抖 / 自定义范围未选完 / 云开发不可用」早退，
    // 那些情况它自己会弹提示，这里抢着说「正在生成」就是谎报，还会把它的提示顶掉
    if (this.data.loading) {
      wx.showToast({ title: '正在按「' + (ds.chip || '模板') + '」生成', icon: 'none' })
    }
  },

  // [summary-freeze v1] 冻结遮罩的点击/滑动接收器：**故意空实现**。
  // wxml 里它同时挂在 catchtap 与 catchtouchmove 上 —— 事件在遮罩层就被吃掉（catch 不冒泡），
  // 下面的胶囊/输入框/快捷模板/按住说话因此收不到任何触摸。
  // 这里不做任何事，也绝不允许有副作用（B27 盯这条）
  onFrozenTap() {},

  // ===== 生成总结 =====
  onGenerate() {
    const prompt = this.data.prompt.trim()
    if (!prompt) {
      wx.showToast({ title: '请输入或说出你的需求', icon: 'none' })
      return
    }
    if (this.data.loading) return
    // 自定义范围必须选完起止日期（组件保证 change 只在完整时发出，此处为防御）[range-toolbar v1]
    const rs = this._rangeState || {}
    if (rs.range === 'custom' && (!rs.customStart || !rs.customEnd)) {
      wx.showToast({ title: '请先选择起止日期', icon: 'none' })
      return
    }
    // 3 秒防抖
    if (this._cooling) {
      wx.showToast({ title: '操作太快，请稍候', icon: 'none' })
      return
    }

    // [monthly-review v1] 生效区间：默认跟随顶部胶囊；「月度复盘」chip 强制近两月
    // （上月 1 日 00:00 ~ 今天 23:59，与 custom 档同口径）。只影响本次生成的区间，胶囊状态不动
    const review = this._reviewRange === true
    let effRange = rs.range
    let effStart = rs.customStart
    let effEnd = rs.customEnd
    if (review) {
      const now = new Date()
      const pad = (x) => (x < 10 ? '0' + x : '' + x)
      const lmFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      effRange = 'custom'
      effStart = lmFirst.getFullYear() + '-' + pad(lmFirst.getMonth() + 1) + '-01'
      effEnd = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    }

    // 读本地日记 + 按时间筛选
    const all = storage.getAllDiaries()
    // 静默排除「AI 总结」生成的日记：总结结果是产出物，不再作为下一轮总结的输入
    const sourceList = all.filter(d => !util.isAiSummaryDiary(d))
    const filtered = dateRange.filterByRange(sourceList, effRange, effStart, effEnd) // [range-toolbar v1]
    if (!filtered.length) {
      // [monthly-review v1] 近两月固定区间下无日记：按用户口径提示，不引导去换时间范围
      this.setData({ error: review ? '近两月没有日记记录，无法分析' : '所选时间段暂无日记，请更换时间范围或去写日记', hasResult: false, result: '' })
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
      this.setData({ error: review ? '近两月没有日记记录，无法分析' : '所选时间段暂无日记', hasResult: false, result: '' })
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

    const rangeDate = dateRange.rangeDateKeys(effRange, effStart, effEnd) // [range-toolbar v1]
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
          rangeText: dateRange.rangeText(effRange, effStart, effEnd), // [range-toolbar v1]
          diaryCount: r.diaryCount || diaries.length,
          truncated: !!r.truncated || frontTruncated,
          // [summary-token-cap v1] 输出被长度上限截断（内容没生成完）：透传给结果页如实提示
          outputTruncated: !!r.outputTruncated
        }
        app.globalData.summaryResult = payload // 兜底：eventChannel 未命中时结果页读全局
        summaryNudge.refreshAnchor() // [summary-nudge v1] 生成成功即刷新篇数锚点（拍板：2.1）
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

  // 结果展示/复制/保存已移至「总结结果」页（pages/summary-result），本页只负责生成

  onReset() {
    this._reviewRange = false // [monthly-review v1] 重置清标志
    this.setData({
      prompt: '',
      error: ''
    })
  }
})
