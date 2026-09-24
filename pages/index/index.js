const storage = require('../../utils/storage.js')
const dateRange = require('../../utils/dateRange.js') // [range-toolbar v1] 日期范围公共口径
const util = require('../../utils/util.js')
const transfer = require('../../utils/transfer.js')
const app = getApp()

const fontSetting = require('../../utils/fontSetting.js')
const theme = require('../../utils/theme.js')
const lock = require('../../utils/lock.js')
const appInfo = require('../../utils/appInfo.js')
const shareCard = require('../../utils/shareCard.js') // [share-card-fallback v1] 品牌图探活与兜底
const tagFit = require('../../utils/tagFit.js') // [tag-fit v1] 列表标签两行自适应

Page({
  data: {
    // 「日记字体」设置注入的 CSS 变量串：字号/字体作用于本页 UGC 正文
    fontStyle: '',
    diaries: [],
    allDiaries: [],
    isEmpty: false,
    loading: true,
    // 日期范围（由 range-picker 组件 change 回传；all = 无筛选）[range-toolbar v1]
    rangeKey: 'all',
    rangeCs: '',
    rangeCe: '',
    rangeLabel: '全部时间',
    rangeDiaries: [],
    rangeCount: 0,
    undatedCount: 0,
    // 搜索
    searchKeyword: '',
    isSearching: false,
    searchCount: 0,
    // 列表顺序 [index-sort v1]：desc = 新→旧（默认，即 storage 原序）；asc = 旧→新（无日期仍沉底）
    // 作用对象 = 列表当前内容（范围 × 搜索叠加后仍生效）；仅页面内状态，不持久化、不跨页记忆
    sortOrder: 'desc'
  },

  onLoad() {
    this.loadData()
  },

  onShow() {
    theme.applyTo(this)
    // 日记本密码：需要锁且本会话未解锁 → 跳锁屏页（页面栈清空，退不回内容页）
    if (lock.guard()) return
    this.setData({ fontStyle: fontSetting.buildStyle() })
    // 从写日记/详情页返回时刷新
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false
      this.loadData()
    }
  },

  loadData() {
    const diaries = storage.getAllDiaries()

    // 格式化显示
    diaries.forEach(d => {
      // [list-date-compact v1] 列表卡片用紧凑日期「8/12 周三」腾宽度；他处仍走完整格式
      d.dateText = util.formatRelativeTime(d.created_at, true)
      // 标题兜底 [title-content-fallback v1]：空 title → 正文开头 ≤7 字 → 日期标题
      // 与 storage.getAllDiaries 共用同一口径（util.resolveDiaryTitle），避免两处脱节
      d.title = util.resolveDiaryTitle(d)
      d.moodText = util.getMoodLabel(d.mood)
      d.moodColor = util.getMoodColor(d.mood)
      d.moodBg = util.getMoodBg(d.mood)
      // 列表预览：去掉换行符，最多显示三行
      const plain = d.content.replace(/\s*\n+\s*/g, ' ').trim()
      d.contentPreview = plain.length > 100 ? plain.substring(0, 100) + '...' : plain
      // 标签最多展示5个；旧数据无 tags 时兜底空数组
      d.tags = Array.isArray(d.tags) ? d.tags.slice(0, 5) : []
      // [tag-fit v1] 卡片标签最多两行：估算溢出时从末尾丢（保底留 1 个）。
      // 只改展示 —— d.tags 仍是完整数据，搜索 / 详情页 / 导出 / 备份不受影响
      // [date-year v1] 跨年（条目不在今年）时日期文案变长「2026/12/20 周六」，
      // 标签可用宽度相应收窄，否则估 2 行、实排 3 行（tag-fit 的初衷被破坏）
      d.tagsShown = tagFit.fitTags(d.tags, d.moodText,
        util.isCrossYearDate(d.created_at) ? tagFit.WIDTHS.dateWidthCrossYear : 0).shown
      // 位置：显示位置名
      d.locationText = (d.location && d.location.name) ? d.location.name : ''
      // 天气：图标 + 文本（如「晴 28° · 深圳」），供列表展示与搜索
      const wText = storage.formatWeatherText(d.weather)
      d.weatherText = wText
      d.weatherIcon = (d.weather && d.weather.icon) || ''
      // 媒体：卡片只展示图片缩略图（最多3张），视频用首图占位；旧数据无 media 时兜底空数组
      d.media = Array.isArray(d.media) ? d.media : []
      d.mediaPreview = d.media.filter(m => m && m.fileID).slice(0, 3)
    })

    // [range-toolbar v1] 无日期日记数（created_at 非法）：范围筛选下被排除，空态提示用
    const undated = diaries.filter(d => isNaN(new Date(d.created_at).getTime())).length
    this.setData({
      diaries: diaries,
      allDiaries: diaries,
      isEmpty: diaries.length === 0,
      loading: false,
      undatedCount: undated
    })
    this.applyRange()
  },

  onPullDownRefresh() {
    this.loadData()
    wx.stopPullDownRefresh()
  },

  // ===== 搜索 =====
  onSearchInput(e) {
    const keyword = e.detail.value.trim()
    this.setData({ searchKeyword: e.detail.value })
    this.applySearch(keyword)
  },

  clearSearch() {
    this.setData({
      searchKeyword: '',
      isSearching: false,
      searchCount: 0,
      diaries: this.data.rangeDiaries
    })
  },

  // ===== 日期范围 [range-toolbar v1] =====
  // 组件 change → 更新范围状态；切换范围时清空搜索（搜索总是在当前范围内进行）
  onRangeChange(e) {
    const d = (e && e.detail) || {}
    this.setData({
      rangeKey: d.range || 'all',
      rangeCs: d.customStart || '',
      rangeCe: d.customEnd || '',
      rangeLabel: d.label || '全部时间',
      searchKeyword: '',
      isSearching: false,
      searchCount: 0
    })
    this.applyRange()
  },

  // 清除范围：走组件 reset（会再发 change，状态统一从 onRangeChange 进来）
  clearRange() {
    const rp = this.selectComponent('#rangePicker')
    if (rp && rp.reset) {
      rp.reset()
    } else {
      this.setData({ rangeKey: 'all', rangeCs: '', rangeCe: '', rangeLabel: '全部时间' })
      this.applyRange()
    }
  },

  // 清空搜索 + 日期范围（导入成功后防「新日记被旧筛选挡住看不见」）[range-toolbar v1]
  resetFilters() {
    // [index-sort v1] 先归位排序、再 reset 范围：rp.reset() 会同步 emit change 触发 applyRange，
    // 若顺序反了，那一次重排仍会按旧顺序渲染
    this.setData({ rangeKey: 'all', rangeCs: '', rangeCe: '', rangeLabel: '全部时间', searchKeyword: '', isSearching: false, searchCount: 0, sortOrder: 'desc' })
    const rp = this.selectComponent('#rangePicker')
    if (rp && rp.reset) rp.reset() // reset 会 emit change，范围状态统一从 onRangeChange 进来
  },

  // 全量 → 范围集（无日期日记在非 all 范围下被排除）；套当前展示顺序；再套搜索
  applyRange() {
    const raw = dateRange.filterByRange(this.data.allDiaries, this.data.rangeKey, this.data.rangeCs, this.data.rangeCe)
    // [index-sort v1] 顺序只在「范围集」这一层定一次：搜索是保序 filter ⇒ diaries 自动继承同一顺序
    const list = this.data.sortOrder === 'asc' ? storage.sortDiariesByTimeAsc(raw) : raw
    this.setData({ rangeDiaries: list, rangeCount: list.length })
    if (this.data.searchKeyword) {
      this.applySearch(this.data.searchKeyword)
    } else {
      this.setData({ diaries: list, isSearching: false, searchCount: 0 })
    }
  },

  // 正序 / 倒序切换 [index-sort v1]：只改顺序、不动内容（篇数与搜索计数不受影响）
  onToggleSort() {
    const next = this.data.sortOrder === 'asc' ? 'desc' : 'asc'
    this.setData({ sortOrder: next })
    this.applyRange()
  },

  applySearch(keyword) {
    if (!keyword) {
      this.setData({
        isSearching: false,
        searchCount: 0,
        diaries: this.data.rangeDiaries
      })
      return
    }
    const kw = keyword.toLowerCase()
    const filtered = this.data.rangeDiaries.filter(d => {
      const titleMatch = (d.title || '').toLowerCase().indexOf(kw) !== -1
      const contentMatch = (d.content || '').toLowerCase().indexOf(kw) !== -1
      // 天气也可搜索（如搜「雨」「晴」找到对应天气的日记）
      const weatherMatch = (d.weatherText || '').toLowerCase().indexOf(kw) !== -1 ||
        (d.locationText || '').toLowerCase().indexOf(kw) !== -1
      // 心情也可搜索（如搜「开心」「happy」找到对应心情的日记）
      const moodMatch = (d.moodText || '').toLowerCase().indexOf(kw) !== -1 ||
        (d.mood || '').toLowerCase().indexOf(kw) !== -1
      // 标签也可搜索（命中任意一个标签即算匹配）
      const tagMatch = (d.tags || []).some(t => (t || '').toLowerCase().indexOf(kw) !== -1)
      return titleMatch || contentMatch || weatherMatch || moodMatch || tagMatch
    })
    this.setData({
      diaries: filtered,
      isSearching: true,
      searchCount: filtered.length
    })
  },


  // ===== 导出 / 导入（自侧栏迁移到日记本）=====
  // [range-toolbar v1] 导出口径 =「导出当前列表」四态：全部 / 日期范围 / 搜索结果 / 范围内搜索结果
  onExportDiaries() {
    const hasRange = this.data.rangeKey !== 'all'
    const searching = this.data.isSearching && this.data.searchKeyword
    if (searching) {
      if (this.data.searchCount === 0) {
        wx.showToast({ title: '当前搜索无结果，无可导出', icon: 'none' })
        return
      }
      // 搜索态：只导出当前搜索结果（范围+搜索时为两者交集）
      const list = this.data.diaries
      const title = hasRange ? '导出范围内搜索结果' : '导出搜索结果'
      wx.showModal({
        title: title,
        content: '将导出' + (hasRange ? '范围内搜索结果 ' : '搜索结果 ') + list.length + ' 篇日记',
        success: (res) => {
          if (res.confirm) transfer.exportToWord(null, list)
        }
      })
      return
    }
    if (hasRange) {
      if (this.data.rangeCount === 0) {
        wx.showToast({ title: '该日期范围内没有日记，无可导出', icon: 'none' })
        return
      }
      const list = this.data.rangeDiaries
      wx.showModal({
        title: '导出该日期范围的日记',
        content: '将导出所选日期范围内的 ' + list.length + ' 篇日记',
        success: (res) => {
          if (res.confirm) transfer.exportToWord(null, list)
        }
      })
      return
    }
    const total = this.data.allDiaries.length
    if (!total) {
      wx.showToast({ title: '暂无日记可导出', icon: 'none' })
      return
    }
    wx.showModal({
      title: '导出全部日记',
      content: '将导出全部 ' + total + ' 篇日记',
      success: (res) => {
        if (res.confirm) {
          // [index-sort v1] 全量态由 transfer 自取列表 ⇒ 把当前顺序传下去（2.B：导出跟随列表）
          transfer.exportToWord(() => {
            wx.showToast({ title: '暂无日记可导出', icon: 'none' })
          }, null, this.data.sortOrder)
        }
      }
    })
  },

  onImportDiaries() {
    transfer.importFromFile({
      onFinish: (added, toast) => {
        // [range-toolbar v1] 导入成功后清空搜索与日期范围再刷新，避免新日记被旧筛选挡住看不见
        this.resetFilters()
        this.loadData()
        wx.showModal({
          title: added === -1 ? '导入失败' : (added > 0 ? '导入成功' : '导入提示'),
          content: toast,
          showCancel: false,
          confirmText: '知道了'
        })
      },
      onError: (msg) => {
        wx.showModal({
          title: '导入不成功',
          content: msg,
          showCancel: false,
          confirmText: '知道了'
        })
      }
    })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id
    })
  },

  goToWrite() {
    wx.reLaunch({ url: '/pages/write/write' })
  },

  goToSummary() {
    wx.navigateTo({ url: '/pages/summary/summary' })
  },

  onShareAppMessage() {
    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图
    return shareCard.build({
      title: appInfo.APP_NAME + ' — 你的数字分身',
      path: '/pages/index/index'
    })
  }
})
