const storage = require('../../utils/storage.js')
const util = require('../../utils/util.js')
const voice = require('../../utils/voice.js')
const aiEdit = require('../../utils/aiEdit.js')
const mediaGuard = require('../../utils/mediaGuard.js')
const share = require('../../utils/share.js')
const app = getApp()

// 编辑模式媒体限额（与写日记页一致）：图片最多 6 张、视频最多 2 个（按日记所属日期统计）
const MAX_IMAGES_PER_DAY = 6
const MAX_VIDEOS_PER_DAY = 2

// 每行媒体数（3 列网格，与写日记页一致）
const MEDIA_COLS = 3

// 表情与颜文字（底栏表情面板数据，与写日记页一致）
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','🥰','😘','😜','🤪','😎','🤩','🥳','😇','🤗','🤔','🙄','😴','🤤','😭','😅','😓','🥺','😳','🤯','😤','😡','🤮','🤧','🥶','🤠','😈','👻','💀','👽','🤖','🎃','😺','🙈','🙉','🙊','💩','👍','👎','👏','🙏','💪','🤝','✌️','🤞','🖖','👌','🤘','👊','❤️','💔','💕','💖','💗','💘','💞','💓','✨','⭐','🌟','🔥','💧','🌈','☀️','🌙','⚡','❄️','🌸','🌹','🌻','🍀','🎉','🎊','🎂','🍰','🍎','🍉','🍓','🍑','☕','🍵','🍺','🥂','🏠','🚗','✈️','🎵','🎶','📚','📖','💻','📱','🎮','⚽','🏀','🎯','🧩','💡','💰','💎','📌','🔒','🔑','🚀','🛸','⏰','📅','😷','🥵','🥶','🫶','🫡','🫠']
const KAOMOJIS = ['(◕‿◕)','(￣▽￣)','(≧∇≦)','(´･ω･`)','(◐‿◑)','ヽ(´▽`)/','(╯°□°)╯︵┻━┻','(T_T)','(^_^)','(o^^)o','(=^･^=)','(｡•̀ᴗ-)✧','┗(＾0＾)┓','(｡ŏ_ŏ)','(；一_一)','(¬_¬)','(＾▽＾)','(●´ω｀●)','(づ￣ ³￣)づ','(๑˃ᴗ˂)ﻭ','(๑•̀ㅂ•́)و✧','(￣▽￣)ノ','(╥﹏╥)','(ノ﹏ヽ)','(′⌒`)','(´；ω；`)','(｡•́︿•̀｡)','(づ｡◕‿‿◕｡)づ','(ノ◕ヮ◕)ノ*:･ﾟ✧','(╯▽╰)','(°▽°)','(●—●)','(・ω・)ノ','(ง •̀_•́)ง','(╬ Ò﹏Ó)','(｀Д´)','(￣へ￣)','(´-ω-`)','(；￣Д￣)','(ﾟ▽ﾟ*)','(⌒▽⌒)','(＾-＾)','(^o^)','(>_<)','(=_=)','(-_-)','(~_~)','(O_O)','(o_O)','(•̀ᴗ•́)و','(•́ω•̀)','(๑•̀ㅂ•́)','(｀・ω・´)']

// 媒体网格布局（朋友圈式拖动排序）：200rpx 缩略图 + 16rpx 间距，3 列
const MEDIA_ITEM_RPX = 200
const MEDIA_GAP_RPX = 16

// 分享弹窗「自定义展示开关」本地记忆键：跨会话保留最后一次设置
const SHARE_SW_KEY = 'share_display_switches'
const SHARE_SW_DEFAULT = { weather: true, mood: true, tags: true, images: true }

Page({
  data: {
    id: '',
    diary: null,
    loading: true,
    editing: false,
    title: '',
    content: '',
    mood: '',
    moodLabel: '',
    moodOptions: Object.keys(util.MOOD_MAP).map(key => ({
      key: key,
      label: util.MOOD_MAP[key].label
    })),
    showMoodPicker: false,
    // 顶部安全区：编辑模式下标题输入框必须避开系统导航栏/刘海
    safeAreaTop: 20,
    pageTop: 28,
    editTop: 52,
    safeAreaBottom: 0,
    // 编辑模式素材：位置 + 媒体（图片/视频，可增删排序）
    editLocation: null,
    editMedia: [],
    mediaUploading: false,
    // 媒体网格布局（长按拖动排序用）
    mediaPositions: [],
    mediaGridHeight: 0,
    dragIndex: -1,
    dragPos: { left: 0, top: 0 },
    // ===== 底部输入栏（默认语音输入）=====
    recording: false,          // 录音中
    connecting: false,         // 正在连接语音服务
    transcribing: false,       // 语音识别中
    recordSeconds: 0,
    voiceCanceling: false,     // 上滑取消状态（录音中 UI 提示）
    liveText: '',              // 实时识别 + 净化后的文本（边说边出字）
    liveRemoved: 0,            // 本次说话已过滤的语气词/自言自语数量
    liveScrollTop: 0,
    showEmojiPanel: false,
    emojiTab: 'emoji',         // 'emoji' | 'kaomoji'
    emojiList: EMOJIS,
    showAddPanel: false,
    // ===== 分享 =====
    showSharePanel: false,
    shareAction: '',           // '' | 'poster'(保存海报) | 'text'(复制精简文字)
    shareSw: { weather: true, mood: true, tags: true, images: true },
    shareMissing: false        // 好友点开分享卡片但本机无数据（云端通道未开通）时的占位
  },

  onLoad(options) {
    // 顶部安全区适配：状态栏/刘海屏高度（页面内容不再被压盖）
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const safeAreaTop = Math.max(
      win.statusBarHeight || 20,
      (win.safeArea && win.safeArea.top) || 20,
      20
    )
    this.setData({
      safeAreaTop: safeAreaTop,
      pageTop: safeAreaTop + 8,
      // detail 页是系统导航栏，内容天然从导航栏下方开始，编辑区只需极小顶部间距
      editTop: 8,
      safeAreaBottom: (win.safeArea && win.screenHeight - win.safeArea.bottom) || 0
    })
    // 恢复分享展示开关的上次设置（跨会话记忆，未存过则用默认值）
    let savedSw = {}
    try {
      savedSw = wx.getStorageSync(SHARE_SW_KEY) || {}
    } catch (e) { savedSw = {} }
    this.setData({
      shareSw: Object.assign({}, SHARE_SW_DEFAULT, savedSw)
    })
    // 订阅全局录音状态：底栏「按住说话」浮层（实时净化文本边说边出字）
    this._offVoiceState = voice.onStateChange((s) => {
      this.setData({
        recording: s.recording,
        connecting: s.connecting || false,
        transcribing: s.transcribing,
        recordSeconds: s.seconds,
        liveText: s.liveText || '',
        liveRemoved: s.liveRemoved || 0,
        liveScrollTop: ((s.liveText || '').length) * 2
      })
    })
    // 扫小程序码进入：scene 形如 "id=d_1693xxxx_ab"，支持 URL 编码
    let entryId = options.id
    if (!entryId && options.scene) {
      try {
        const sceneStr = decodeURIComponent(options.scene)
        const m = /(?:^|&)id=([^&]+)/.exec(sceneStr)
        if (m) entryId = m[1]
      } catch (e) {
        // scene 解码失败则忽略，按无参数处理
      }
    }
    if (entryId) {
      this.setData({ id: entryId })
      this._fromShare = options.share === '1'
      this.loadDetail(entryId)
      // 从主页月历绿点进入：直接进入编辑模式（等节点渲染后再算媒体布局）
      if (options.edit === '1') {
        setTimeout(() => this.startEdit(), 120)
      }
    }
  },

  onShow() {
    // 编辑模式下注册语音目标：底栏「按住说话」识别结果追加到日记正文
    if (this.data.editing) {
      this.registerVoiceTarget()
      // 预热语音识别鉴权参数（静默）：缩短编辑页首次按住说话的启动等待
      voice.warmup()
    }
  },

  onHide() {
    this.unregisterVoiceTarget()
    this.closeAllPanels()
  },

  onUnload() {
    this.unregisterVoiceTarget()
    if (this._offVoiceState) this._offVoiceState()
    // 兜底：编辑中未保存直接返回页面时，清掉本次会话新上传的云文件（避免孤儿；已保存则清单已清空）
    this.discardSessionUploads()
  },

  // 注册语音识别结果接收（编辑模式才占用全局语音目标）
  registerVoiceTarget() {
    if (this._voiceHandle) return
    this._voiceHandle = (text) => this.handleVoiceText(text, true)
    app.globalData.voiceTarget = {
      label: '正文',
      handle: this._voiceHandle
    }
  },

  unregisterVoiceTarget() {
    if (this._voiceHandle && app.globalData.voiceTarget && app.globalData.voiceTarget.handle === this._voiceHandle) {
      app.globalData.voiceTarget = null
    }
    this._voiceHandle = null
  },

  loadDetail(id) {
    const diary = storage.getDiaryById(id)

    if (diary) {
      this.decorateDiary(diary)
      // 兼容旧数据：去掉默认标题里的"的"字（"X月X日 的日记" → "X月X日 日记"）
      if (diary.title) diary.title = util.stripDiaryTitleSuffix(diary.title)
      this.setData({
        diary: diary,
        title: diary.title || '',
        content: diary.content || '',
        mood: diary.mood || '',
        moodLabel: util.getMoodLabel(diary.mood),
        loading: false,
        // 编辑模式：带入日记原有的位置与媒体（图片/视频）
        editLocation: diary.location ? { ...diary.location } : null,
        editMedia: this.buildEditMedia(diary.media),
        mediaUploading: false
      })
      this.recalcMediaLayout()
    } else {
      this.setData({ loading: false })
      // 从分享卡片进入但本机没有这篇日记：跨设备数据通道未开通，展示友好占位而非报错返回
      if (this._fromShare) {
        this.setData({ shareMissing: true })
        return
      }
      wx.showToast({ title: '日记不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
    }
  },

  // 把日记媒体转为编辑用数组：{ fileID, type, duration, size, thumb, thumbSize }
  buildEditMedia(media) {
    if (!Array.isArray(media)) return []
    return media
      .filter(m => m && m.fileID)
      .map(m => {
        const isVideo = m.type === 'video'
        const cloudThumb = isVideo && m.thumb && String(m.thumb).indexOf('cloud://') === 0 ? m.thumb : ''
        return {
          fileID: m.fileID,
          type: isVideo ? 'video' : 'image',
          duration: m.duration || 0,
          size: m.size || 0,
          thumb: cloudThumb, // 已保存视频的云端封面（重新保存不丢）
          thumbSize: cloudThumb ? (m.thumbSize || 0) : 0
        }
      })
  },

  // 给日记补充展示字段：日期、心情、位置、媒体拆分为图片/视频
  decorateDiary(diary) {
    diary.createdAt = util.formatFullDate(diary.created_at)
    diary.isAIOptimized = diary.source === 'ai'
    diary.moodText = util.getMoodLabel(diary.mood)
    diary.moodColor = util.getMoodColor(diary.mood)
    diary.moodBg = util.getMoodBg(diary.mood)
    diary.locationText = (diary.location && diary.location.name) ? diary.location.name : ''
    // 天气：图标 + 「晴 28° · 深圳」
    const weatherText = storage.formatWeatherText(diary.weather)
    if (weatherText) {
      diary.weatherIcon = diary.weather.icon || ''
      diary.weatherText = weatherText
    } else {
      diary.weatherIcon = ''
      diary.weatherText = ''
    }
    const media = Array.isArray(diary.media) ? diary.media : []
    diary.images = media.filter(m => m && m.type === 'image' && m.fileID).map(m => m.fileID)
    diary.videos = media.filter(m => m && m.type === 'video' && m.fileID)
  },

  // 预览图片
  previewMedia(e) {
    const idx = e.currentTarget.dataset.index
    const images = this.data.diary.images
    if (!images || images.length === 0) return
    wx.previewImage({
      current: images[idx] || images[0],
      urls: images
    })
  },

  // 进入编辑模式
  startEdit() {
    this._sessionUploaded = [] // 新会话：本次新上传的云文件清单（保存/取消时据此清理）
    this.setData({
      editing: true,
      showEmojiPanel: false,
      showAddPanel: false,
      dragIndex: -1
    })
    this.recalcMediaLayout()
    this.registerVoiceTarget()
  },

  // 取消编辑
  cancelEdit() {
    const diary = this.data.diary
    this.setData({
      editing: false,
      title: diary.title || '',
      content: diary.content || '',
      mood: diary.mood || '',
      moodLabel: util.getMoodLabel(diary.mood),
      // 恢复原始素材（丢弃本次增删/排序/位置的改动）
      editLocation: diary.location ? { ...diary.location } : null,
      editMedia: this.buildEditMedia(diary.media),
      mediaUploading: false,
      // 底栏状态清理
      showEmojiPanel: false,
      showAddPanel: false,
      dragIndex: -1
    })
    this.recalcMediaLayout()
    this.unregisterVoiceTarget()
    // 取消编辑：清理本次会话新上传但未保存的云文件（旧媒体仍被日记引用，绝不删除）
    this.discardSessionUploads()
  },

  // 丢弃本次编辑的会话上传（静默）：仅清清单内本会话新传文件——保存后清单已清空不会误删；
  // 取消编辑/未保存直接返回页面时调用，避免云孤儿
  discardSessionUploads() {
    const sess = this._sessionUploaded || []
    this._sessionUploaded = []
    if (sess.length) mediaGuard.deleteMediaItems(sess)
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value })
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value })
  },

  toggleMoodPicker() {
    this.setData({ showMoodPicker: !this.data.showMoodPicker })
  },

  selectMood(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'none') {
      this.setData({ mood: '', moodLabel: '', showMoodPicker: false })
      return
    }
    this.setData({
      mood: key,
      moodLabel: util.MOOD_MAP[key].label,
      showMoodPicker: false
    })
  },

  // ===== 编辑模式：位置 =====
  chooseEditLocation() {
    this.setData({ showAddPanel: false, showEmojiPanel: false })
    wx.chooseLocation({
      success: (res) => {
        if (!res || !res.name) return
        this.setData({
          editLocation: {
            name: res.name,
            address: res.address || '',
            latitude: res.latitude || 0,
            longitude: res.longitude || 0
          }
        })
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

  clearEditLocation() {
    this.setData({ editLocation: null })
  },

  // ===== 底部输入栏（默认语音输入）=====

  // 按住开始录音（带 300ms 防误触）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      voice.start()
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

  // 上滑取消：录音中手指向上滑动超过阈值时切换为取消状态
  onVoiceTouchMove(e) {
    if (!this._isHolding || !this.data.recording) return
    const touch = (e && e.touches && e.touches[0]) || {}
    const dy = this._voiceStartY - touch.clientY
    const dx = Math.abs((this._voiceStartX || touch.clientX) - touch.clientX)
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
      showEmojiPanel: false
    })
  },

  // 输入统一入口：语音输入实时执行增删改指令；如需文字输入，直接点正文编辑区打字（系统键盘）
  // 语音：整条是指令 → 直接执行；混合输入 → 指令句逐条执行、普通句追加；纯内容 → 追加
  handleVoiceText(text, fromVoice) {
    if (this._voiceCanceled) {
      this._voiceCanceled = false
      return
    }
    const trimmed = String(text || '').trim()
    if (!trimmed) return

    // 语音输入：实时执行增删改指令（宽松识别，识别结果常不带标点）
    const loose = { loose: true }
    const single = aiEdit.detect(trimmed, loose)
    if (single) {
      this.execEditCommands([single], '')
      return
    }

    const parsed = aiEdit.splitCommands(trimmed, loose)
    if (parsed.commands.length > 0) {
      this.execEditCommands(parsed.commands, parsed.narrative)
      return
    }

    this.setData({ content: this.appendTextTo(this.data.content, trimmed) })
  },

  // 执行一批修改指令（按顺序作用于当前正文），再把普通叙述追加到末尾，toast 提示执行结果
  execEditCommands(commands, narrative) {
    let content = this.data.content
    const applied = []
    let firstNotFound = null

    for (const cmd of commands) {
      const res = aiEdit.apply(content, cmd)
      if (res.changed) {
        content = res.content
        applied.push(cmd)
      } else if (res.reason === 'notFound' && !firstNotFound) {
        firstNotFound = cmd
      }
    }

    if (narrative) content = this.appendTextTo(content, narrative)
    this.setData({ content: content })

    if (applied.length === 1) {
      wx.showToast({ title: this.editTitle(applied[0]), icon: 'none' })
    } else if (applied.length > 1) {
      wx.showToast({ title: '已执行 ' + applied.length + ' 条修改指令', icon: 'none' })
    } else if (firstNotFound) {
      const word = firstNotFound.type === 'insert' ? firstNotFound.at : firstNotFound.from
      wx.showToast({ title: '日记中没有「' + word + '」', icon: 'none' })
    }
  },

  // 单条指令的操作摘要文案（toast 提示用）
  editTitle(edit) {
    if (edit.type === 'removeSent') return this.sentRemoveText(edit)
    if (edit.type === 'remove') return '已删除「' + edit.from + '」'
    if (edit.type === 'insert') {
      return '已在「' + edit.at + (edit.pos === 'before' ? '前' : '后') + '」加上「' + edit.text + '」'
    }
    return '已修改：「' + edit.from + '」→「' + edit.to + '」'
  },

  // 按位置删句的描述文案：已删除最后一句话 / 已删除第一句话 / 已删除最后两句 / 已删除倒数第二句
  sentRemoveText(edit) {
    const n = edit.count || 1
    if (edit.offset) return '已删除倒数第' + (edit.offset + 1) + '句'
    const numText = n === 1 ? '一句' : (n === 2 ? '两句' : n + '句')
    return '已删除' + (edit.pos === 'first' ? '开头' : '最后') + numText
  },

  // 把文字拼接到指定基底末尾
  appendTextTo(base, text) {
    if (!base) return text
    const needSpace = !/[\n\s，。！？、；：.!?]$/.test(base)
    return base + (needSpace ? ' ' : '') + text
  },

  // ===== 表情 / 颜文字（底栏表情面板）=====
  toggleEmojiPanel() {
    const show = !this.data.showEmojiPanel
    this.setData({
      showEmojiPanel: show,
      showAddPanel: false
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
    this.setData({ content: this.data.content + emoji })
  },

  closeAllPanels() {
    this.setData({ showEmojiPanel: false, showAddPanel: false, showMoodPicker: false })
  },

  // ===== 编辑模式：媒体（图片/视频，增删排序）=====
  chooseEditImage() {
    this.chooseEditMediaByType(['image'])
  },

  chooseEditVideo() {
    this.chooseEditMediaByType(['video'])
  },

  // 选图/视频（与写日记页一致的天限额：图片 6/天、视频 2/天，按日记所属日期统计）
  chooseEditMediaByType(mediaType) {
    if (this.data.mediaUploading) return
    this.setData({ showAddPanel: false, showEmojiPanel: false })

    const isVideo = mediaType.indexOf('video') !== -1
    const dateKey = util.getDateKey(new Date(this.data.diary.created_at))
    const used = storage.countMediaByDate(dateKey)
    // 当天总量 = 其他日记的媒体 + 本篇编辑中的媒体（本篇已保存的媒体要从 used 中扣除，避免重复计数）
    const own = this.data.diary.media || []
    const ownImages = own.filter(m => m.type !== 'video').length
    const ownVideos = own.filter(m => m.type === 'video').length
    const curImages = this.data.editMedia.filter(m => m.type !== 'video').length
    const curVideos = this.data.editMedia.filter(m => m.type === 'video').length
    const usedImages = used.images - ownImages + curImages
    const usedVideos = used.videos - ownVideos + curVideos

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
    const count = Math.min(remain, 9 - this.data.editMedia.length)
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
        this.uploadEditMediaFiles(g.pass)
      }
    })
  },

  // 图片强压缩：质量 65、宽不超过 1080px，压缩失败退回原图
  compressImage(src) {
    return new Promise((resolve) => {
      wx.compressImage({
        src: src,
        quality: 65,
        compressedWidth: 1080,
        success: (res) => resolve(res.tempFilePath || src),
        fail: () => resolve(src)
      })
    })
  },

  // 上传并追加到编辑媒体（图片先压缩再传；视频直传云端，本地只存 fileID）
  async uploadEditMediaFiles(files) {
    this.setData({ mediaUploading: true })
    wx.showLoading({ title: '上传中...' })
    const added = []
    let failed = 0
    let uploadedBytes = 0
    for (const f of files) {
      const isVideo = f.fileType === 'video'
      try {
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
          // 会话内预览图：图片用本地压缩路径；视频用首帧封面（优先云端，失败退回本地临时图）
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
              item.thumb = thumbRes.fileID
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
    // 记录本次编辑会话新上传的云文件（完整项含封面）：保存/取消时才据此决定是否清理孤儿
    const sess = this._sessionUploaded || (this._sessionUploaded = [])
    added.forEach(a => sess.push(a))
    this.setData({
      mediaUploading: false,
      editMedia: this.data.editMedia.concat(added).slice(0, 9)
    })
    this.recalcMediaLayout()
    if (failed > 0) {
      wx.showToast({ title: failed + ' 个上传失败，已跳过', icon: 'none' })
    }
  },

  // 删除某个媒体
  removeEditMedia(e) {
    if (this.data.dragIndex >= 0) return
    const idx = e.currentTarget.dataset.index
    const editMedia = this.data.editMedia.slice()
    editMedia.splice(idx, 1)
    this.setData({ editMedia: editMedia })
    this.recalcMediaLayout()
  },

  // ===== 媒体排序：长按拖动（与微信朋友圈调整图片顺序逻辑一致）=====

  // 网格布局参数：200rpx 缩略图 + 16rpx 间距，3 列（px 值，屏幕宽度换算）
  getGridMetrics() {
    if (this._gridMetrics) return this._gridMetrics
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const rpx2px = win.windowWidth / 750
    this._gridMetrics = {
      itemSize: Math.round(MEDIA_ITEM_RPX * rpx2px),
      gap: Math.round(MEDIA_GAP_RPX * rpx2px)
    }
    return this._gridMetrics
  },

  // 重算所有媒体项的位置与网格高度（编辑媒体增/删/排序后调用）
  recalcMediaLayout() {
    const g = this.getGridMetrics()
    const len = this.data.editMedia.length
    const positions = []
    for (let i = 0; i < len; i++) {
      const col = i % MEDIA_COLS
      const row = Math.floor(i / MEDIA_COLS)
      positions.push({
        left: col * (g.itemSize + g.gap),
        top: row * (g.itemSize + g.gap)
      })
    }
    const rows = Math.ceil(len / MEDIA_COLS)
    this.setData({
      mediaPositions: positions,
      mediaGridHeight: rows > 0 ? rows * g.itemSize + (rows - 1) * g.gap : 0
    })
  },

  // 长按媒体进入拖动模式：记录手指起点与网格位置
  onMediaLongPress(e) {
    const idx = e.currentTarget.dataset.index
    const touch = e.touches && e.touches[0]
    if (!touch || idx === undefined) return
    this._dragMoved = false
    const self = this
    wx.createSelectorQuery().in(this).select('.edit-media-grid').boundingClientRect((rect) => {
      if (!rect) return
      const g = self.getGridMetrics()
      self._gridInfo = {
        left: rect.left,
        top: rect.top,
        itemSize: g.itemSize,
        gap: g.gap
      }
      const pos = self.data.mediaPositions[idx] || { left: 0, top: 0 }
      self.setData({
        dragIndex: idx,
        // 初始跟手位置 = 当前槽位（无跳变），随后由 touchmove 更新
        dragPos: { left: pos.left, top: pos.top }
      })
    }).exec()
  },

  // 拖动中：媒体项跟随手指 + 实时计算目标槽位并让位
  onMediaTouchMove(e) {
    if (this.data.dragIndex < 0) return
    const touch = e.touches && e.touches[0]
    const g = this._gridInfo
    if (!touch || !g) return
    this._dragMoved = true

    const half = g.itemSize / 2
    const x = touch.pageX - g.left
    const y = touch.pageY - g.top
    this.setData({
      dragPos: { left: x - half, top: y - half }
    })

    // 手指中心所在槽位（列/行）→ 目标索引
    const col = this.clamp(Math.round((x - half) / (g.itemSize + g.gap)), 0, MEDIA_COLS - 1)
    const maxRow = Math.max(0, Math.ceil(this.data.editMedia.length / MEDIA_COLS) - 1)
    const row = this.clamp(Math.round((y - half) / (g.itemSize + g.gap)), 0, maxRow)
    let targetIndex = row * MEDIA_COLS + col
    targetIndex = this.clamp(targetIndex, 0, this.data.editMedia.length - 1)

    // 目标槽位变化 → 数组实时重排，其他项平滑让位
    if (targetIndex !== this.data.dragIndex) {
      const media = this.data.editMedia.slice()
      const moved = media.splice(this.data.dragIndex, 1)
      media.splice(targetIndex, 0, moved[0])
      this.setData({
        editMedia: media,
        dragIndex: targetIndex
      })
      this.recalcMediaLayout()
    }
  },

  // 拖动结束：退出拖动模式
  onMediaTouchEnd() {
    if (this.data.dragIndex < 0) return
    this.setData({ dragIndex: -1 })
    // 抑制拖动结束后的 tap 误触（避免松手弹出图片预览）
    this._dragMoved = true
    setTimeout(() => { this._dragMoved = false }, 120)
  },

  // 点击媒体：拖动结束后立即松手可能触发 tap，需跳过
  onEditMediaTap(e) {
    if (this._dragMoved) return
    this.previewEditMedia(e)
  },

  clamp(v, min, max) {
    return Math.min(Math.max(v, min), max)
  },

  // 预览编辑中的图片/视频（混合全屏预览，视频直接播放）
  previewEditMedia(e) {
    const idx = e.currentTarget.dataset.index
    const list = this.data.editMedia || []
    const target = list[idx]
    if (!target) return
    const sources = list.map(m => ({
      url: m.fileID,
      type: m.type === 'video' ? 'video' : 'image'
    }))
    if (wx.previewMedia) {
      wx.previewMedia({ sources: sources, current: idx })
    } else {
      // 旧基础库兜底：仅图片可预览
      const images = list.filter(m => m.type === 'image').map(m => m.fileID)
      if (target.type === 'image' && images.length > 0) {
        wx.previewImage({ current: target.fileID, urls: images })
      } else {
        wx.showToast({ title: '当前微信版本不支持预览视频', icon: 'none' })
      }
    }
  },

  // 编辑媒体序列化为存储格式
  serializeEditMedia() {
    return (this.data.editMedia || []).map(m => {
      const isVideo = m.type === 'video'
      // 视频封面：仅持久化云端文件（本地临时路径不落盘，重启后无效）
      const cloudThumb = isVideo && m.thumb && String(m.thumb).indexOf('cloud://') === 0 ? m.thumb : ''
      return {
        fileID: m.fileID,
        type: m.type,
        duration: m.duration || 0,
        size: m.size || 0, // 保留实际上传字节：删除日记清理云端媒体时同步扣减本地用量估算
        thumb: cloudThumb,
        thumbSize: cloudThumb ? (m.thumbSize || 0) : 0
      }
    })
  },

  // 保存编辑
  saveEdit() {
    if (!this.data.content.trim()) {
      wx.showToast({ title: '内容不能为空', icon: 'none' })
      return
    }

    // 原本就是AI优化的日记，继续标记为 source: ai（保留历史标签）
    const isAI = !!(this.data.diary && this.data.diary.source === 'ai')
    // 先算好保存结果媒体与被移除文件（在更新 diary 之前，旧 media 还是进入编辑时的引用）
    const newMedia = this.serializeEditMedia()
    const removed = mediaGuard.computeRemovedFiles(this.data.diary.media || [], this._sessionUploaded || [], newMedia)
    const updated = storage.updateDiary(this.data.id, {
      title: this.data.title.trim() || util.getDefaultTitle(),
      content: this.data.content.trim(),
      mood: this.data.mood,
      source: isAI ? 'ai' : 'manual',
      // 素材一并保存：位置 + 图片/视频（含本次增删与排序结果）
      location: this.data.editLocation || null,
      media: newMedia
    })

    if (updated) {
      // 移除动作不立即删云端，保存成功才真正清理（取消编辑不会误删日记引用的媒体）
      this._sessionUploaded = []
      if (removed.length) {
        mediaGuard.deleteMediaItems(removed).then((r) => {
          if (r && r.failed > 0) {
            wx.showToast({ title: r.failed + ' 个云端媒体删除失败', icon: 'none' })
          }
        })
      }
      this.decorateDiary(updated)
      this.setData({
        diary: updated,
        editing: false,
        editLocation: updated.location ? { ...updated.location } : null,
        editMedia: this.buildEditMedia(updated.media),
        // 底栏状态清理
        showEmojiPanel: false,
        showAddPanel: false,
        dragIndex: -1
      })
      this.unregisterVoiceTarget()
      app.globalData.needRefresh = true
      wx.showToast({ title: '保存成功', icon: 'success' })
    } else {
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  // 删除日记（同步清理云端媒体）
  deleteDiary() {
    wx.showModal({
      title: '确认删除',
      content: '删除后不可恢复（含已上传的云端图片/视频），确定要删除这篇日记吗？',
      confirmColor: '#B8453A',
      success: (res) => {
        if (res.confirm) {
          const target = storage.getDiaryById(this.data.id)
          if (target) {
            // 先快照：删本地前扣减用量估算并收集云文件，避免误删同 id 新数据
            const bytes = mediaGuard.sumMediaBytes(target.media || [])
            if (bytes > 0) mediaGuard.subtractMediaUsage(bytes)
            const fileIDs = mediaGuard.collectFileIDs(target)
            storage.deleteDiary(this.data.id)
            if (fileIDs.length) {
              mediaGuard.deleteCloudFiles(fileIDs).then((r) => {
                if (r && r.failed > 0) {
                  wx.showToast({ title: r.failed + ' 个云端媒体删除失败', icon: 'none' })
                }
              })
            }
          } else {
            storage.deleteDiary(this.data.id)
          }
          app.globalData.needRefresh = true
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => {
            wx.navigateBack()
          }, 1000)
        }
      }
    })
  },

  // ===================== 分享弹窗 =====================
  openSharePanel() {
    if (this.data.editing) return
    this.setData({ showSharePanel: true })
  },

  closeSharePanel() {
    this.setData({ showSharePanel: false, shareAction: '' })
  },

  preventTouchMove() {},

  selectShareAction(e) {
    this.setData({ shareAction: e.currentTarget.dataset.action })
  },

  toggleShareSwitch(e) {
    const key = e.currentTarget.dataset.key
    const shareSw = Object.assign({}, this.data.shareSw)
    shareSw[key] = e.detail.value
    this.setData({ shareSw: shareSw })
    // 记住本次设置：下次进小程序/打开分享弹窗仍生效
    try {
      wx.setStorageSync(SHARE_SW_KEY, shareSw)
    } catch (err) { /* 存储异常静默：下次退回默认值 */ }
  },

  confirmShare() {
    const a = this.data.shareAction
    if (a === 'poster') { this.saveSharePoster(); return }
    if (a === 'text') { this.copyShareText(); return }
    wx.showToast({ title: '请先选择一种分享方式', icon: 'none' })
  },

  goBackHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  // ===== 复制精简文字（脱敏默认配置：日期+天气+心情+标签+摘要） =====
  copyShareText() {
    const d = this.data.diary
    const text = share.buildCopyText(d)
    if (!text) {
      wx.showToast({ title: '暂无内容可复制', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        this.closeSharePanel()
        wx.showToast({ title: '已复制，可粘贴到任意平台', icon: 'none' })
      }
    })
  },

  // ===== 保存分享海报（公开分享 · canvas 2d 脱敏绘制） =====
  async saveSharePoster() {
    const d = this.data.diary
    const model = share.buildPosterModel(d, this.data.shareSw)
    // 兜底：无任何可公开内容（空日记/仅视频且开关全关）不生成空海报
    if (!model.summary && !model.mood && !model.weather && !model.tags.length && !model.images.length) {
      wx.showToast({ title: '暂无内容可生成海报', icon: 'none' })
      return
    }
    wx.showLoading({ title: '生成海报中…', mask: true })
    try {
      const [urls, codeUrl] = await Promise.all([
        this.loadPosterImages(model.images),
        this.loadWxacode()
      ])
      await this.drawPoster(model, urls, codeUrl)
      const tmp = await this.exportPosterTempFile()
      wx.hideLoading()
      this.closeSharePanel()
      await this.saveImageWithAuth(tmp)
    } catch (e) {
      wx.hideLoading()
      const msg = (e && (e.errMsg || e.message)) || ''
      if (msg.indexOf('cancel') !== -1) return // 用户主动取消（如取消相册授权弹窗），不提示
      console.error('saveSharePoster fail', e)
      wx.showToast({ title: '海报生成失败，请重试', icon: 'none' })
    }
  },

  // 取小程序码临时链接（云函数生成太阳码 → 云存储临时 URL）
  // 任一环节失败都返回 null：海报按「无码」布局自适应，不阻塞生成
  async loadWxacode() {
    try {
      const d = this.data.diary
      if (!d || !d.id) return null
      const res = await wx.cloud.callFunction({
        name: 'getWxacode',
        data: { scene: 'id=' + d.id }
      })
      const r = (res && res.result) || {}
      if (!r.fileID) {
        console.warn('getWxacode fail', r.errMsg || r.error)
        return null
      }
      const t = await wx.cloud.getTempFileURL({ fileList: [r.fileID] })
      const f = (t && t.fileList && t.fileList[0]) || {}
      return f.tempFileURL || null
    } catch (e) {
      console.warn('loadWxacode fail', e)
      return null
    }
  },

  // 图片 fileID → 可绘制地址（cloud:// 转临时链接；其余直接用）
  loadPosterImages(list) {
    if (!list || !list.length) return Promise.resolve([])
    const cloudIds = list.filter(u => u.indexOf('cloud://') === 0)
    const direct = list.filter(u => u.indexOf('cloud://') !== 0)
    const jobs = []
    if (cloudIds.length) {
      jobs.push(wx.cloud.getTempFileURL({ fileList: cloudIds }).then(res => {
        const map = {}
        ;(res.fileList || []).forEach(f => { if (f && f.fileID) map[f.fileID] = f.tempFileURL || '' })
        return cloudIds.map(id => map[id]).filter(Boolean)
      }))
    }
    jobs.push(Promise.resolve(direct))
    return Promise.all(jobs).then(groups => [].concat.apply([], groups))
  },

  // 海报画布：离屏 <canvas type="2d"> 绘制（codeUrl 小程序码可选，失败自动退回无码布局）
  drawPoster(model, imageUrls, codeUrl) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#sharePosterCanvas').fields({ node: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('画布初始化失败'))
          return
        }
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = Math.max(1, Math.min(info.pixelRatio || 2, 3))
        const W = 600
        const PAD = 46
        const MAXW = W - PAD * 2

        // —— 绘制工具 ——
        const rrectPath = (x, y, w, h, r) => {
          ctx.beginPath()
          ctx.moveTo(x + r, y)
          ctx.arcTo(x + w, y, x + w, y + h, r)
          ctx.arcTo(x + w, y + h, x, y + h, r)
          ctx.arcTo(x, y + h, x, y, r)
          ctx.arcTo(x, y, x + w, y, r)
          ctx.closePath()
        }
        const wrapLines = (text, maxW) => {
          const out = []
          let cur = ''
          for (const ch of String(text)) {
            if (ctx.measureText(cur + ch).width > maxW && cur) {
              out.push(cur)
              cur = ch
            } else {
              cur += ch
            }
          }
          if (cur) out.push(cur)
          return out
        }
        const drawCover = (img, dx, dy, dw, dh, r) => {
          const s = Math.max(dw / img.width, dh / img.height)
          const sw = dw / s
          const sh = dh / s
          const sx = (img.width - sw) / 2
          const sy = (img.height - sh) / 2
          ctx.save()
          rrectPath(dx, dy, dw, dh, r)
          ctx.clip()
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
          ctx.restore()
        }

        // —— 下载图片素材（失败自动跳过） ——
        const imgs = []
        const loadTask = (u) => new Promise((ok) => {
          const img = canvas.createImage()
          let done = false
          const fin = () => { if (!done) { done = true; ok() } }
          img.onload = () => { imgs.push(img); fin() }
          img.onerror = fin
          img.src = u
          setTimeout(fin, 6000)
        })
        // 小程序码单独加载：加载成功才进布局，失败按无码排版
        let codeImg = null
        const loadCode = (u) => new Promise((ok) => {
          if (!u) { ok(); return }
          const img = canvas.createImage()
          let done = false
          const fin = (okFlag) => { if (!done) { done = true; if (okFlag) codeImg = img; ok() } }
          img.onload = () => fin(true)
          img.onerror = () => fin(false)
          img.src = u
          setTimeout(() => fin(!!codeImg), 6000)
        })
        Promise.all((imageUrls || []).map(loadTask).concat([loadCode(codeUrl)])).then(() => {
          // 第一遍：纯测量，得到各块纵向位置与总高（canvas 高度必须先定）
          const layout = []
          let y = PAD + 6
          ctx.textBaseline = 'middle'
          ctx.font = '500 30px sans-serif'
          layout.push({ kind: 'date', y: y })
          y += 56
          if (model.mood) {
            ctx.font = '400 27px sans-serif'
            layout.push({ kind: 'mood', y: y, w: ctx.measureText(model.mood).width + 52 })
            y += 54
          }
          if (model.weather) {
            ctx.font = '400 27px sans-serif'
            layout.push({ kind: 'weather', y: y, w: ctx.measureText(model.weather).width })
            y += 46
          }
          if (model.summary) {
            ctx.font = '400 33px sans-serif'
            const lines = wrapLines(model.summary, MAXW).slice(0, 12)
            layout.push({ kind: 'summary', y: y + 12, lines: lines, lineH: 54 })
            y += 12 + lines.length * 54 + 6
          }
          if (model.tags && model.tags.length) {
            ctx.font = '400 25px sans-serif'
            const rows = []
            let row = []
            let rowW = 0
            model.tags.slice(0, 8).forEach((t) => {
              const txt = '#' + t
              const tw = ctx.measureText(txt).width + 34
              if (row.length && rowW + tw > MAXW) {
                rows.push(row)
                row = []
                rowW = 0
              }
              row.push(txt)
              rowW += tw + 12
            })
            if (row.length) rows.push(row)
            layout.push({ kind: 'tags', y: y + 6, rows: rows })
            y += 6 + rows.length * 52 + 4
          }
          if (imgs.length) {
            const n = imgs.length
            const gap = 16
            const each = n === 1 ? Math.min(420, MAXW) : n === 2 ? (MAXW - gap) / 2 : (MAXW - gap * 2) / 3
            const left = (W - n * each - gap * (n - 1)) / 2
            layout.push({ kind: 'images', y: y + 10, left: left, each: each, gap: gap })
            y += 10 + each + 8
          }
          y += 26
          const footY = y
          const CODE_SIZE = 112
          const hasCode = !!codeImg
          const H = y + (hasCode ? CODE_SIZE + 44 : 96)
          layout.push({ kind: 'footer', y: footY, hasCode: hasCode, codeSize: CODE_SIZE })

          // 设定画布尺寸（会重置画笔，随后统一重绘）
          canvas.width = W * dpr
          canvas.height = H * dpr
          ctx.scale(dpr, dpr)
          ctx.textBaseline = 'middle'

          // 背景渐变
          const grad = ctx.createLinearGradient(0, 0, 0, H)
          grad.addColorStop(0, '#FAF6F1')
          grad.addColorStop(1, '#FFFFFF')
          ctx.fillStyle = grad
          ctx.fillRect(0, 0, W, H)

          layout.forEach((b) => {
            if (b.kind === 'date') {
              // 左侧绿色主题条 + 日期
              ctx.fillStyle = '#C0773A'
              rrectPath(PAD, b.y - 16, 6, 32, 3)
              ctx.fill()
              ctx.fillStyle = '#2A2622'
              ctx.font = '500 30px sans-serif'
              ctx.fillText(model.date || 'AI 日记', PAD + 22, b.y)
            } else if (b.kind === 'mood') {
              ctx.fillStyle = model.moodBg || 'rgba(138,143,140,0.12)'
              rrectPath(PAD, b.y - 25, b.w, 50, 25)
              ctx.fill()
              ctx.fillStyle = model.moodColor || '#6B5A4A'
              ctx.font = '400 27px sans-serif'
              ctx.fillText(model.mood, PAD + 26, b.y)
            } else if (b.kind === 'weather') {
              ctx.fillStyle = '#6B5A4A'
              ctx.font = '400 27px sans-serif'
              ctx.fillText(model.weather, PAD, b.y)
            } else if (b.kind === 'summary') {
              ctx.fillStyle = '#2A2622'
              ctx.font = '400 33px sans-serif'
              b.lines.forEach((ln, i) => {
                ctx.fillText(ln, PAD, b.y + i * b.lineH)
              })
            } else if (b.kind === 'tags') {
              ctx.font = '400 25px sans-serif'
              b.rows.forEach((rowArr, ri) => {
                let x = PAD
                const rowY = b.y + ri * 52
                rowArr.forEach((txt) => {
                  const w = ctx.measureText(txt).width + 36
                  ctx.fillStyle = '#F2E3CE'
                  rrectPath(x, rowY - 22, w, 44, 22)
                  ctx.fill()
                  ctx.fillStyle = '#A05F27'
                  ctx.fillText(txt, x + 18, rowY)
                  x += w + 12
                })
              })
            } else if (b.kind === 'images') {
              imgs.forEach((img, i) => {
                drawCover(img, b.left + i * (b.each + b.gap), b.y, b.each, b.each, 20)
              })
            } else if (b.kind === 'footer') {
              // 品牌 + AI 合规注脚（不带昵称/头像水印）
              if (b.hasCode) {
                // 有小程序码：码靠右下，文案左侧两行左对齐
                const cs = b.codeSize
                const cx = W - PAD - cs
                const cy = b.y - 8
                ctx.fillStyle = '#FFFFFF'
                rrectPath(cx - 6, cy - 6, cs + 12, cs + 12, 12)
                ctx.fill()
                ctx.drawImage(codeImg, cx, cy, cs, cs)
                ctx.fillStyle = '#A05F27'
                ctx.font = '500 26px sans-serif'
                ctx.fillText('来自 AI 日记 · 记录每一天', PAD, b.y + 26)
                ctx.fillStyle = '#BCB0A3'
                ctx.font = '400 20px sans-serif'
                ctx.fillText('内容摘要已脱敏 · 部分内容可能由 AI 生成', PAD, b.y + 64)
                ctx.fillStyle = '#9C8D7E'
                ctx.font = '400 18px sans-serif'
                ctx.fillText('微信扫码 · 打开这篇日记', PAD, b.y + 94)
              } else {
                ctx.fillStyle = '#A05F27'
                ctx.font = '500 26px sans-serif'
                const brand = '来自 AI 日记 · 记录每一天'
                ctx.fillText(brand, (W - ctx.measureText(brand).width) / 2, b.y + 22)
                ctx.fillStyle = '#BCB0A3'
                ctx.font = '400 20px sans-serif'
                const note = '内容摘要已脱敏 · 部分内容可能由 AI 生成'
                ctx.fillText(note, (W - ctx.measureText(note).width) / 2, b.y + 58)
              }
            }
          })
          resolve()
        })
      })
    })
  },

  // canvas 2d → 临时图片文件
  exportPosterTempFile() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#sharePosterCanvas').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('画布获取失败'))
          return
        }
        const canvas = res[0].node
        wx.canvasToTempFilePath({
          canvas: canvas,
          fileType: 'jpg',
          quality: 0.92,
          success: (r) => resolve(r.tempFilePath),
          fail: (e) => reject(new Error('海报导出失败'))
        })
      })
    })
  },

  // 保存到相册（首次授权，拒绝后引导去设置）
  saveImageWithAuth(tmp) {
    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath: tmp,
        success: () => {
          wx.showToast({ title: '海报已保存到相册', icon: 'success' })
          resolve()
        },
        fail: (e) => {
          const msg = (e && e.errMsg) || ''
          if (msg.indexOf('auth') !== -1 || msg.indexOf('deny') !== -1 || msg.indexOf('authorize') !== -1) {
            wx.showModal({
              title: '需要相册权限',
              content: '保存海报需要访问你的相册，请在设置中开启权限',
              confirmText: '去设置',
              success: (r) => {
                if (r.confirm) wx.openSetting()
              }
            })
          } else if (msg.indexOf('cancel') === -1) {
            wx.showToast({ title: '保存失败，请重试', icon: 'none' })
          }
          reject(e)
        }
      })
    })
  },

  // 分享（私密卡片：好友/群）
  onShareAppMessage() {
    const d = this.data.diary
    const id = this.data.id
    return {
      title: d ? (d.title || '我的日记') : '我的AI日记',
      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'
    }
  }
})
