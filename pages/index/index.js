const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const transfer = require('../../utils/transfer.js')
const app = getApp()

const fontSetting = require('../../utils/fontSetting.js')
const theme = require('../../utils/theme.js')

Page({
  data: {
    // 「日记字体」设置注入的 CSS 变量串：字号/字体作用于本页 UGC 正文
    fontStyle: '',
    diaries: [],
    allDiaries: [],
    isEmpty: false,
    loading: true,
    stats: null,
    // 搜索
    searchKeyword: '',
    isSearching: false,
    searchCount: 0
  },

  onLoad() {
    this.loadData()
  },

  onShow() {
    theme.applyTo(this)
    this.setData({ fontStyle: fontSetting.buildStyle() })
    // 从写日记/详情页返回时刷新
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false
      this.loadData()
    }
    // 从【我的】页导入完成后跳转过来：弹窗提示导入结果
    const imp = app.globalData.importResult
    if (imp) {
      app.globalData.importResult = null
      wx.showModal({
        title: imp.count > 0 ? '导入成功' : '导入提示',
        content: imp.toast,
        showCancel: false,
        confirmText: '知道了'
      })
    }
  },

  loadData() {
    const diaries = storage.getAllDiaries()
    const stats = storage.getStats()

    // 格式化显示
    diaries.forEach(d => {
      d.dateText = util.formatRelativeTime(d.created_at)
      // 标题兜底：无标题时用日期生成默认标题，避免导入/旧数据缺失 title 显示"无题"
      if (!d.title) {
        d.title = util.getDefaultTitle(util.getDateKey(new Date(d.created_at)))
      }
      d.moodText = util.getMoodLabel(d.mood)
      d.moodColor = util.getMoodColor(d.mood)
      d.moodBg = util.getMoodBg(d.mood)
      // 列表预览：去掉换行符，最多显示三行
      const plain = d.content.replace(/\s*\n+\s*/g, ' ').trim()
      d.contentPreview = plain.length > 100 ? plain.substring(0, 100) + '...' : plain
      // 标签最多展示5个；旧数据无 tags 时兜底空数组
      d.tags = Array.isArray(d.tags) ? d.tags.slice(0, 5) : []
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

    this.setData({
      diaries: diaries,
      allDiaries: diaries,
      isEmpty: diaries.length === 0,
      loading: false,
      stats: stats
    })

    // 如果有搜索关键词，重新过滤
    if (this.data.searchKeyword) {
      this.applySearch(this.data.searchKeyword)
    }
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
      diaries: this.data.allDiaries
    })
  },

  applySearch(keyword) {
    if (!keyword) {
      this.setData({
        isSearching: false,
        searchCount: 0,
        diaries: this.data.allDiaries
      })
      return
    }
    const kw = keyword.toLowerCase()
    const filtered = this.data.allDiaries.filter(d => {
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
  onExportDiaries() {
    const searching = this.data.isSearching && this.data.searchKeyword
    if (searching && this.data.searchCount === 0) {
      wx.showToast({ title: '当前搜索无结果，无可导出', icon: 'none' })
      return
    }
    if (searching) {
      // 搜索态：只导出当前搜索结果（diaries 即全量过滤集，本页无分页）
      const list = this.data.diaries
      wx.showModal({
        title: '导出搜索结果',
        content: '将导出搜索结果 ' + list.length + ' 篇日记',
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
          transfer.exportToWord(() => {
            wx.showToast({ title: '暂无日记可导出', icon: 'none' })
          })
        }
      }
    })
  },

  onImportDiaries() {
    transfer.importFromFile({
      onFinish: (added, toast) => {
        // 导入成功后先清空搜索态再刷新，避免新日记被搜索条件挡住看不见
        this.setData({ searchKeyword: '', isSearching: false, searchCount: 0 })
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
    return {
      title: 'AI日记 — 记录每一天的故事',
      path: '/pages/index/index'
    }
  }
})
