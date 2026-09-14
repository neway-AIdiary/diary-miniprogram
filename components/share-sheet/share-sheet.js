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
    wxacodeId: { type: String, value: '' }
  },

  data: {
    shareAction: '',           // '' | 'poster'(保存海报) | 'text'(复制精简文字)
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
      if (a === 'poster') { this.saveSharePoster(); return }
      if (a === 'text') { this.copyShareText(); return }
      wx.showToast({ title: '请先选择一种分享方式', icon: 'none' })
    },

    // ===== 复制精简文字（脱敏默认配置：日期+天气+心情+标签+摘要） =====
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
                // 左侧琥珀主题条 + 日期
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
    }
  }
})
