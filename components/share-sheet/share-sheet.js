// components/share-sheet —— 分享弹窗（半屏面板）+ 海报/复制文案逻辑
// 日记详情页与总结结果页共用同一套 UI 与逻辑；卡片分享（open-type="share"）
// 由所在页面各自的 onShareAppMessage 提供内容（页面级接口，组件内无法声明）。
//
// 用法：
//   <share-sheet visible="{{showSharePanel}}" diary="{{diary}}" sheet-title="分享我的日记"
//                wxacode-id="{{id}}" bind:close="closeSharePanel" />
// diary 需为详情页同款 view model：
//   createdAt / content / moodText / moodColor / moodBg / tags / images / weatherText / weatherIcon
const share = require('../../utils/share.js')
const appInfo = require('../../utils/appInfo.js') // [poster-brand v1] 海报品牌行改走唯一来源，不再硬编码「AI 日记」

// 分享弹窗「自定义展示开关」本地记忆键：跨会话保留最后一次设置
// v2：天气/心情默认开，标签/图片默认关——bump 一版让历史全开的用户也回到新默认
const SHARE_SW_KEY = 'share_display_switches_v2'
const SHARE_SW_DEFAULT = { weather: true, mood: true, tags: false, images: false }

Component({
  properties: {
    // 面板是否展开（由页面控制，关闭通过 bind:close 回传）
    visible: { type: Boolean, value: false },
    // 待分享的日记 view model（详情页装饰后的数据结构）
    diary: { type: Object, value: null },
    // 面板标题（日记详情默认「分享我的日记」，总结结果页可传「分享我的 AI 总结」）
    sheetTitle: { type: String, value: '分享我的日记' },
    // 海报小程序码 scene 用的日记 id（未落库的总结可传空，海报自动按无码布局）
    wxacodeId: { type: String, value: '' },
    // [summary-share-align v1] 页面声明「确认分享前必须先落库」：为真且 diary 无 id 时，
    // 确认分享先触发 needsave 事件请页面落库，落库后页面回调 continueShare 继续
    needSavedDiary: { type: Boolean, value: false }
  },

  data: {
    shareAction: '',           // '' | 'poster'(保存海报) | 'text'(复制完整文字)
    shareSw: { weather: true, mood: true, tags: false, images: false },
    safeAreaBottom: 0
  },

  lifetimes: {
    attached() {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      // 恢复分享展示开关的上次设置（跨会话记忆，未存过则用默认值）
      let savedSw = {}
      try {
        savedSw = wx.getStorageSync(SHARE_SW_KEY) || {}
      } catch (e) { savedSw = {} }
      this.setData({
        safeAreaBottom: (win.safeArea && win.screenHeight - win.safeArea.bottom) || 0,
        shareSw: Object.assign({}, SHARE_SW_DEFAULT, savedSw)
      })
    }
  },

  observers: {
    // 每次展开都回到未选择状态（与页面每次打开弹层行为一致）
    visible(v) {
      if (v) this.setData({ shareAction: '' })
    }
  },

  methods: {
    closePanel() {
      this.triggerEvent('close')
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
      if (a === 'poster') {
        if (this._needSavedDiary()) { this.triggerEvent('needsave'); return } // [summary-share-align v1] 先落库再出海报（二维码指向这篇日记）
        this.saveSharePoster(); return
      }
      if (a === 'text') {
        if (this._needSavedDiary()) { this.triggerEvent('needsave'); return } // [summary-share-align v1] 先落库再复制
        this.copyShareText(); return
      }
      wx.showToast({ title: '请先选择一种分享方式', icon: 'none' })
    },

    // [summary-share-align v1] 是否需要页面先落库（仅声明 need-saved-diary 且日记未落库时）
    _needSavedDiary() {
      return !!this.data.needSavedDiary && !(this.data.diary && this.data.diary.id)
    },

    // [summary-share-align v1] 页面落库完成后回调：带最新 diary 继续「确认分享」原动作
    continueShare(diaryOverride) {
      if (diaryOverride) this.setData({ diary: diaryOverride })
      const a = this.data.shareAction
      if (a === 'poster') { this.saveSharePoster(); return }
      if (a === 'text') { this.copyShareText(); return }
    },

    // ===== 复制完整文字（默认配置：日期+天气+心情+标签+全文，保留段落） =====
    copyShareText() {
      const text = share.buildCopyText(this.data.diary)
      if (!text) {
        wx.showToast({ title: '暂无内容可复制', icon: 'none' })
        return
      }
      wx.setClipboardData({
        data: text,
        success: () => {
          this.triggerEvent('close')
          wx.showToast({ title: '已复制，可粘贴到任意平台', icon: 'none' })
          this.triggerEvent('shared', { action: 'text' }) // [summary-share-align v1] 通知页面「分享动作已完成」
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
        this.triggerEvent('close')
        await this.saveImageWithAuth(tmp)
        this.triggerEvent('shared', { action: 'poster' }) // [summary-share-align v1] 通知页面「分享动作已完成」
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
        const id = this.data.wxacodeId || (this.data.diary && this.data.diary.id) || ''
        if (!id) return null
        const res = await wx.cloud.callFunction({
          name: 'getWxacode',
          data: { scene: 'id=' + id }
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
          // 画布像素上限：iOS canvas 总面积约 16.7M、单边约 8192，超限会绘制失败（白屏）
          const MAX_CANVAS_PX = 12e6
          const MAX_CANVAS_DIM = 8000

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
          // 保留原文换行：先按 \n 拆段，段内再按画布宽度折行（画布宽是硬约束，
          // 超过画布的单行必须折开，否则会画出边界被裁掉）；空行原样占一行高度
          const wrapLines = (text, maxW) => {
            const out = []
            const paras = String(text).replace(/\r\n?/g, '\n').split('\n')
            for (let pi = 0; pi < paras.length; pi++) {
              const para = paras[pi]
              if (!para) { out.push(''); continue }
              let cur = ''
              for (const ch of para) {
                if (ctx.measureText(cur + ch).width > maxW && cur) {
                  out.push(cur)
                  cur = ch
                } else {
                  cur += ch
                }
              }
              if (cur) out.push(cur)
            }
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
            // 页脚参数提前确定：正文超长时要用它决定「引导扫码」还是「打开小程序」
            const CODE_SIZE = 112
            const hasCode = !!codeImg
            ctx.textBaseline = 'middle'
            ctx.font = '500 30px sans-serif'
            layout.push({ kind: 'date', y: y })
            y += 56
            let moodW = 0
            if (model.mood) {
              ctx.font = '400 25px sans-serif'
              moodW = ctx.measureText(model.mood).width + 52
              layout.push({ kind: 'mood', y: y, w: moodW })
              y += 54
            }
            if (model.weather) {
              ctx.font = '400 25px sans-serif'
              const wW = ctx.measureText(model.weather).width
              // [poster-weather-inline v1] 有心情时天气与心情同行右侧（放不下才回落独立行）
              if (model.mood && moodW + 24 + wW <= MAXW) {
                layout.push({ kind: 'weather', y: y - 54, x: PAD + moodW + 24, w: wW })
              } else {
                layout.push({ kind: 'weather', y: y, x: PAD, w: wW })
                y += 46
              }
            }
            // [poster-font v1] 正文与说明头分层绘制（拍板 1.A）：
            //   说明头（【总结需求】/【分析范围】）= 25px 浅灰；正文 = 29px 深墨、每段首字空一个字
            const briefSplit = share.splitPosterBrief(model.summary || '')
            let briefLines = 0
            if (briefSplit.brief) {
              ctx.font = '400 25px sans-serif'
              const bl = wrapLines(briefSplit.brief, MAXW)
              briefLines = bl.length
              layout.push({ kind: 'brief', y: y + 12, lines: bl, lineH: 38 })
              y += 12 + bl.length * 38 + 16
            }
            if (briefSplit.body) {
              ctx.font = '400 29px sans-serif'
              const all = wrapLines(share.indentParas(briefSplit.body), MAXW)
              // 双上限：字数上限（share.MAX_SUMMARY_LEN=600）先截，行数上限兜底 canvas 像素
              // （说明头行数计入总行数上限，避免两段相加顶穿像素上限）
              const lines = all.slice(0, Math.max(0, share.MAX_POSTER_LINES - briefLines))
              const cut = all.length > lines.length || !!model.summaryTruncated
              layout.push({ kind: 'summary', y: y + 12, lines: lines, lineH: 48, cut: cut })
              y += 12 + lines.length * 48 + 6
              if (cut) {
                layout.push({ kind: 'summaryMore', y: y + 8, hasCode: hasCode })
                y += 8 + 34
              }
            }
            if (model.tags && model.tags.length) {
              ctx.font = '400 25px sans-serif'
              const rows = []
              let row = []
              let rowW = 0
              model.tags.slice(0, 8).forEach((t) => {
                const txt = t
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
            const H = y + (hasCode ? CODE_SIZE + 44 : 96)
            layout.push({ kind: 'footer', y: footY, hasCode: hasCode, codeSize: CODE_SIZE })

            // 设定画布尺寸（会重置画笔，随后统一重绘）
            // 长正文时画布会很高：dpr 先按总面积与单边上限收紧，再落到整数像素
            const dprEff = Math.max(1, Math.min(dpr, Math.sqrt(MAX_CANVAS_PX / (W * H)), MAX_CANVAS_DIM / H))
            canvas.width = Math.floor(W * dprEff)
            canvas.height = Math.floor(H * dprEff)
            ctx.scale(dprEff, dprEff)
            ctx.textBaseline = 'middle'

            // 背景渐变
            const grad = ctx.createLinearGradient(0, 0, 0, H)
            grad.addColorStop(0, '#FAF6F1')
            grad.addColorStop(1, '#FFFFFF')
            ctx.fillStyle = grad
            ctx.fillRect(0, 0, W, H)

            layout.forEach((b) => {
              if (b.kind === 'date') {
                // 左侧琥珀主题条 + 日期
                ctx.fillStyle = '#C0773A'
                rrectPath(PAD, b.y - 16, 6, 32, 3)
                ctx.fill()
                ctx.fillStyle = '#2A2622'
                ctx.font = '500 30px sans-serif'
                ctx.fillText(model.date || appInfo.APP_NAME, PAD + 22, b.y)
              } else if (b.kind === 'mood') {
                ctx.fillStyle = model.moodBg || 'rgba(138,143,140,0.12)'
                rrectPath(PAD, b.y - 25, b.w, 50, 25)
                ctx.fill()
                ctx.fillStyle = model.moodColor || '#6B5A4A'
                ctx.font = '400 25px sans-serif'
                ctx.fillText(model.mood, PAD + 26, b.y)
              } else if (b.kind === 'weather') {
                ctx.fillStyle = '#6B5A4A'
                ctx.font = '400 25px sans-serif'
                ctx.fillText(model.weather, b.x || PAD, b.y)
              } else if (b.kind === 'brief') {
                // 说明头：小一号 + 浅灰弱化（正文之前的标签块，不缩进）
                ctx.fillStyle = '#8A8F8C'
                ctx.font = '400 25px sans-serif'
                b.lines.forEach((ln, i) => {
                  ctx.fillText(ln, PAD, b.y + i * b.lineH)
                })
              } else if (b.kind === 'summary') {
                ctx.font = '400 29px sans-serif'
                b.lines.forEach((ln, i) => {
                  if (b.cut && i === b.lines.length - 1) {
                    // 末行横向渐隐：示意后文未展示（背景近白，文字色降透明最干净）
                    const lw = ctx.measureText(ln).width
                    const g = ctx.createLinearGradient(PAD, 0, PAD + lw, 0)
                    g.addColorStop(0, 'rgba(42,38,34,1)')
                    g.addColorStop(0.6, 'rgba(42,38,34,0.72)')
                    g.addColorStop(1, 'rgba(42,38,34,0)')
                    ctx.fillStyle = g
                  } else {
                    ctx.fillStyle = '#2A2622'
                  }
                  ctx.fillText(ln, PAD, b.y + i * b.lineH)
                })
              } else if (b.kind === 'summaryMore') {
                ctx.fillStyle = '#9A8F84'
                ctx.font = '400 24px sans-serif'
                ctx.fillText(b.hasCode ? '…完整内容见小程序码' : '…完整内容请打开小程序查看', PAD, b.y)
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
                  // [poster-slogan v1] 品牌行后缀改由 appInfo.APP_SLOGAN 提供（与顶栏标题同一拼法），不再硬编码「记录每一天」
                  ctx.fillText('来自 ' + appInfo.APP_NAME + '·' + appInfo.APP_SLOGAN, PAD, b.y + 26)
                  ctx.fillStyle = '#BCB0A3'
                  ctx.font = '400 20px sans-serif'
                  ctx.fillText('内容摘要已脱敏 · 部分内容可能由 AI 生成', PAD, b.y + 64)
                  ctx.fillStyle = '#9C8D7E'
                  ctx.font = '400 18px sans-serif'
                  ctx.fillText('微信扫码 · 打开这篇日记', PAD, b.y + 94)
                } else {
                  ctx.fillStyle = '#A05F27'
                  ctx.font = '500 26px sans-serif'
                  // [poster-slogan v1] 同上：品牌行后缀走唯一来源
                  const brand = '来自 ' + appInfo.APP_NAME + '·' + appInfo.APP_SLOGAN
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
    }
  }
})
