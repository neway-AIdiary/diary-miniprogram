const storage = require('../../utils/storage.js')
const aiCloud = require('../../utils/aiCloud.js')
const voice = require('../../utils/voice.js')
const archiveEdit = require('../../utils/archiveEdit.js')
const hotwords = require('../../utils/hotwords.js')
const app = getApp()

// 表情与颜文字（表情面板数据，与主页一致）
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','🥰','😘','😜','🤪','😎','🤩','🥳','😇','🤗','🤔','🙄','😴','🤤','😭','😅','😓','🥺','😳','🤯','😤','😡','🤮','🤧','🥶','🤠','😈','👻','💀','👽','🤖','🎃','😺','🙈','🙉','🙊','💩','👍','👎','👏','🙏','💪','🤝','✌️','🤞','🖖','👌','🤘','👊','❤️','💔','💕','💖','💗','💘','💞','💓','✨','⭐','🌟','🔥','💧','🌈','☀️','🌙','⚡','❄️','🌸','🌹','🌻','🍀','🎉','🎊','🎂','🍰','🍎','🍉','🍓','🍑','☕','🍵','🍺','🥂','🏠','🚗','✈️','🎵','🎶','📚','📖','💻','📱','🎮','⚽','🏀','🎯','🧩','💡','💰','💎','📌','🔒','🔑','🚀','🛸','⏰','📅','😷','🥵','🥶','🫶','🫡','🫠']
const KAOMOJIS = ['(◕‿◕)','(￣▽￣)','(≧∇≦)','(´･ω･`)','(◐‿◑)','ヽ(´▽`)/','(╯°□°)╯︵┻━┻','(T_T)','(^_^)','(o^^)o','(=^･^=)','(｡•̀ᴗ-)✧','┗(＾0＾)┓','(｡ŏ_ŏ)','(；一_一)','(¬_¬)','(＾▽＾)','(●´ω｀●)','(づ￣ ³￣)づ','(๑˃ᴗ˂)ﻭ','(๑•̀ㅂ•́)و✧','(￣▽￣)ノ','(╥﹏╥)','(ノ﹏ヽ)','(′⌒`)','(´；ω；`)','(｡•́︿•̀｡)','(づ｡◕‿‿◕｡)づ','(ノ◕ヮ◕)ノ*:･ﾟ✧','(╯▽╰)','(°▽°)','(●—●)','(・ω・)ノ','(ง •̀_•́)ง','(╬ Ò﹏Ó)','(｀Д´)','(￣へ￣)','(´-ω-`)','(；￣Д￣)','(ﾟ▽ﾟ*)','(⌒▽⌒)','(＾-＾)','(^o^)','(>_<)','(=_=)','(-_-)','(~_~)','(O_O)','(o_O)','(•̀ᴗ•́)و','(•́ω•̀)','(๑•̀ㅂ•́)','(｀・ω・´)']

Page({
  data: {
    archives: [],
    // 底部输入栏（主页同款三件套：表情 / 按住说话 / +；默认语音，点表情后切键盘输入）
    voiceMode: true,           // true=按住说话 / false=键盘输入
    quickText: '',             // 底部输入框内容
    recording: false,          // 录音中
    transcribing: false,       // 语音识别中
    recordSeconds: 0,
    voiceCanceling: false,     // 上滑取消状态（录音中 UI 提示）
    // 草稿上下文热词调试提示（按住说话前能看到已锁定的专名）
    hotwordHintList: [],
    hotwordHintText: '',
    hotwordHintOn: true,
    // 表情面板（与主页一致）
    showEmojiPanel: false,
    emojiTab: 'emoji',         // 'emoji' | 'kaomoji'
    emojiList: EMOJIS,
    // 词条编辑弹框
    editShow: false,
    editTitle: '',             // 编辑档案 / 添加档案
    editName: '',
    editDesc: '',
    // 系统栏适配
    statusBarHeight: 20,
    safeAreaBottom: 0,
    // AI 整理中（新增档案时）
    organizing: false
  },

  onLoad() {
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: win.statusBarHeight || 20,
      safeAreaBottom: (win.safeArea && win.screenHeight - win.safeArea.bottom) || 0
    })
    this.loadArchives()
    // 订阅全局录音状态，显示「正在聆听/识别中」浮层；
    // 实时链路下 liveText 为净化后的识别文本（边说边出字）
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
  },

  onUnload() {
    if (this._offVoiceState) this._offVoiceState()
  },

  onShow() {
    this.loadArchives()
    // 预热语音识别鉴权参数（静默）：缩短按住说话的启动等待
    voice.warmup()
    // 注册语音目标：底部「按住说话」识别结果交给本页处理
    this._voiceHandle = (text) => this.handleVoiceText(text)
    app.globalData.voiceTarget = {
      label: '档案',
      handle: this._voiceHandle
    }
  },

  onHide() {
    if (app.globalData.voiceTarget && app.globalData.voiceTarget.handle === this._voiceHandle) {
      app.globalData.voiceTarget = null
    }
    this._voiceHandle = null
  },

  loadArchives() {
    this.setData({ archives: storage.getArchives() })
  },

  // ===== 底部输入栏（主页同款三件套：表情 / 按住说话 / +）=====

  // 表情面板：打开时切到键盘输入（插入的表情可见）；关闭时输入框为空则回到按住说话
  toggleEmojiPanel() {
    const show = !this.data.showEmojiPanel
    this.setData({
      showEmojiPanel: show,
      voiceMode: show ? false : (this.data.quickText.trim() ? false : true)
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
    this.setData({ quickText: this.data.quickText + emoji, voiceMode: false })
  },

  // 按住开始录音（带300ms防误触；与主页一致：记录起点坐标、复位取消标记）
  onHoldStart(e) {
    this._suppressEnd = false
    this._voiceCanceled = false
    const touch = (e && e.touches && e.touches[0]) || {}
    this._voiceStartY = touch.clientY || 0
    this._voiceStartX = touch.clientX || 0
    if (this._holdTimer) clearTimeout(this._holdTimer)
    this._holdTimer = setTimeout(() => {
      this._isHolding = true
      // 把当前备注草稿作为"即时上下文"传给语音识别：档案页说话前若已输入了人名/机构名，
      // 这些词会被作为最高优先级热词下发，提升同名实体的识别准确率
      voice.start({ contextText: this.data.quickText || this.data.content || '' })
    }, 300)
  },

  onHoldEnd() {
    if (this._holdTimer) clearTimeout(this._holdTimer)
    if (this._isHolding) {
      this._isHolding = false
      // 上滑取消：标记本段，识别结果回调（handleVoiceText）将整段丢弃，不新增/修改档案
      if (this.data.voiceCanceling) {
        this._voiceCanceled = true
      }
      voice.stop()
    }
    this.setData({ voiceCanceling: false })
    this._voiceStartY = 0
    this._voiceStartX = 0
  },

  // 上滑取消：录音中手指向上滑动超过阈值时切换为取消状态（与主页一致）
  onVoiceTouchMove(e) {
    if (!this._isHolding || !this.data.recording) return
    const touch = (e && e.touches && e.touches[0]) || {}
    const dy = this._voiceStartY - touch.clientY
    const dx = Math.abs((this._voiceStartX || touch.clientX) - touch.clientX)
    // 垂直向上滑动超过 64rpx，且水平偏移不超过垂直偏移的 60%（避免误触）
    const canceling = dy > 64 && dx < dy * 0.6
    if (canceling !== this.data.voiceCanceling) {
      this.setData({ voiceCanceling: canceling })
    }
  },

  onQuickInput(e) {
    const text = e.detail.value
    this.setData({ quickText: text })
    this._refreshHotwordHint(text)
  },

  // ===== 草稿上下文热词调试提示（与主页共用 hotwords.getContextTerms） =====
  _refreshHotwordHint(text) {
    if (!this.data.hotwordHintOn) {
      if (this.data.hotwordHintText) this.setData({ hotwordHintList: [], hotwordHintText: '' })
      return
    }
    const list = hotwords.getContextTerms(text || '')
    if (!list || !list.length) {
      if (this.data.hotwordHintText) this.setData({ hotwordHintList: [], hotwordHintText: '' })
      return
    }
    const shown = list.slice(0, 8)
    const rest = list.length - shown.length
    const shownText = shown.join(' · ') + (rest > 0 ? ' · …' : '')
    const text2 = '已锁定专名：' + shownText + '（共 ' + list.length + ' 个）'
    if (text2 !== this.data.hotwordHintText) {
      this.setData({ hotwordHintList: list, hotwordHintText: text2 })
    }
  },

  onHotwordHintTap() {
    const newOn = !this.data.hotwordHintOn
    this.setData({ hotwordHintOn: newOn })
    if (!newOn) {
      this.setData({ hotwordHintList: [], hotwordHintText: '' })
    } else {
      this._refreshHotwordHint(this.data.quickText)
    }
  },

  // 右侧 +：输入框有内容→直接发送；为空→弹出「添加档案」编辑框
  onPlusTap() {
    this.setData({ showEmojiPanel: false })
    if (this.data.quickText.trim()) {
      this.sendQuick()
    } else {
      this.openEditModal(null)
    }
  },

  // 发送：识别修改意图，否则 AI 整理并新增
  sendQuick() {
    const text = this.data.quickText
    this.setData({ quickText: '' })
    this.processInput(text)
  },

  // ===== 词条编辑弹框 =====

  // 点击词条卡片：弹出编辑框（名称+说明可改，卡片 UI 不变）
  onEditArchive(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.archives.find((a) => a.id === id)
    if (item) this.openEditModal(item)
  },

  openEditModal(item) {
    this._editId = item ? item.id : ''
    this.setData({
      showEmojiPanel: false,
      editShow: true,
      editTitle: item ? '编辑档案' : '添加档案',
      editName: item ? item.name : '',
      editDesc: item ? (item.description || '') : ''
    })
  },

  closeEditModal() {
    this._editId = ''
    this.setData({ editShow: false })
  },

  onEditNameInput(e) {
    this.setData({ editName: e.detail.value })
  },

  onEditDescInput(e) {
    this.setData({ editDesc: e.detail.value })
  },

  onSaveEdit() {
    const name = this.data.editName.trim()
    const desc = this.data.editDesc.trim()
    const editId = this._editId

    // 新增模式：复用统一录入链路（已有名称→追加说明；新名称→AI 整理新增）
    if (!editId) {
      if (!name && !desc) {
        wx.showToast({ title: '请输入名称或说明', icon: 'none' })
        return
      }
      this.closeEditModal()
      const text = name ? (desc ? `${name}：${desc}` : name) : desc
      this.processInput(text)
      return
    }

    // 编辑模式
    if (!name) {
      wx.showToast({ title: '名称不能为空', icon: 'none' })
      return
    }
    const archives = this.data.archives.slice()
    const idx = archives.findIndex((a) => a.id === editId)
    if (idx < 0) {
      this.closeEditModal()
      return
    }

    // 改名撞上已有词条：说明追加合并到该词条（不覆盖），并删除当前词条
    const dupIdx = archives.findIndex((a) => a.id !== editId && a.name === name)
    if (dupIdx >= 0) {
      const merged = archiveEdit.appendArchiveDescription(archives[dupIdx].description, desc)
      if (merged !== null) archives[dupIdx].description = merged
      archives.splice(idx, 1)
      storage.replaceArchives(archives)
      this.loadArchives()
      this.closeEditModal()
      wx.showToast({ title: '已合并到同名档案', icon: 'none', duration: 2000 })
      return
    }

    archives[idx] = Object.assign({}, archives[idx], { name: name, description: desc })
    storage.replaceArchives(archives)
    this.loadArchives()
    this.closeEditModal()
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  // 语音识别结果入口
  handleVoiceText(text) {
    // 上滑取消的录音：整段丢弃，不新增/修改档案
    if (this._voiceCanceled) {
      this._voiceCanceled = false
      return
    }
    this.processInput(text)
  },

  /**
   * 核心处理（与主页日记录入一致）：
   * 1. 先判断是否为对已有档案的修改（指令式 / 意图式，如「王磊是我大学同学」）
   * 2. 不是修改 → AI 整理并新增档案
   */
  processInput(text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return

    const edit = archiveEdit.detectEdit(trimmed, this.data.archives)
    if (edit) {
      const res = archiveEdit.applyEdit(this.data.archives, edit)
      if (res.changed) {
        storage.replaceArchives(res.archives)
        this.loadArchives()
      }
      wx.showToast({ title: res.msg || '无需修改', icon: 'none', duration: 2000 })
      return
    }

    // 不是修改 → AI 整理并新增
    this.onOrganize(trimmed)
  },

  // ===== AI 整理并添加（新增档案）=====
  onOrganize(text) {
    if (!text) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }
    this.setData({ organizing: true })

    aiCloud.callAIOrganizeArchive(text, '').then(result => {
      this.setData({ organizing: false })

      if (!result.archives || result.archives.length === 0) {
        wx.showToast({ title: '未识别到有效内容', icon: 'none' })
        return
      }

      const saveResult = storage.saveArchives(result.archives)
      const msg = saveResult.added > 0 && saveResult.updated > 0
        ? `添加 ${saveResult.added} 条，更新 ${saveResult.updated} 条`
        : saveResult.added > 0
          ? `已添加 ${saveResult.added} 条档案`
          : saveResult.updated > 0
            ? `已更新 ${saveResult.updated} 条档案`
            : '没有新增或更新'

      this.loadArchives()
      wx.showToast({ title: msg, icon: 'success', duration: 2000 })
    })
  },

  // ===== 删除档案 =====
  onDeleteArchive(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除档案',
      content: '确定删除这条档案吗？',
      confirmColor: '#FA5151',
      success: (res) => {
        if (res.confirm) {
          storage.deleteArchive(id)
          this.loadArchives()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  }
})
