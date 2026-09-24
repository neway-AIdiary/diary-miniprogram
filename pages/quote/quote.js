/**
 * 每日一签 · 全篇页
 *
 * - 内容唯一来源 utils/dailyQuote.js，本页不写死任何正文
 * - 入参：?i=<池子下标>（侧栏卡片透传，兼容保留）；?d=YYYY-MM-DD（日期头翻日入口）
 *   下标/日期非法、或指向未来，一律回落到今天那一签
 * - 日期头 [quote-date v4]：两行轻文字（公历日期+星期几 / 农历·星座·节气），数据来自 utils/lunarDate.js；
 *   ‹ › 箭头移至「诗词」标签右侧（2.A 紧贴），±1 天翻日，作用对象 = 该日那一签
 *   （getDetail 按日期确定性取模，同日恒定）；拍板 3.A：未来禁止（到今天 canNext 即 false），过去不限
 * - 主题沿用全站机制：根节点 class="page {{themeClass}}"，onShow 调 theme.applyTo(this)
 */
const theme = require('../../utils/theme.js')
const dailyQuote = require('../../utils/dailyQuote.js')
const lunarDate = require('../../utils/lunarDate.js')
const appInfo = require('../../utils/appInfo.js')

// 本地日期 → 'YYYY-MM-DD'（日期头与翻日比较共用的字符串口径；等长定长可直接字典序比较）
function dateToStr(d) {
  const m = ('' + (d.getMonth() + 1)).padStart(2, '0')
  const day = ('' + d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

// 'YYYY-MM-DD' → 本地 0 点 Date；非法（格式错/不存在的日期）一律 null，由调用方回落今天。
// 回读校验：'2026-02-30' 这类会被 JS 顺位成 3 月，必须挡掉。
function strToDate(s) {
  if (typeof s !== 'string') return null
  const t = s.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const parts = t.split('-')
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  if (dateToStr(d) !== t) return null
  return d
}

Page({
  data: {
    themeClass: '',
    appName: appInfo.APP_NAME,
    kind: '',
    head: '',
    byline: '',
    body: '',
    copyText: '',
    // [quote-date v2] 日期头（两行轻文字）
    dateStr: '',        // 当前日期 'YYYY-MM-DD'
    gregorian: '',      // 2026年09月21日（零填充）
    weekday: '',        // 星期一
    constellation: '',  // 处女座
    termName: '',       // 当前节气段（白露/秋分…，1.B 常驻）
    termIcon: '',       // 节气 emoji（🍁…）
    lunarFull: '',      // 丙午年八月十一
    zodiac: '',         // 马（生肖；显示于农历与星座之间）
    canPrev: false,     // ‹ 可用（过去不限，恒 true；占位以便旧态渲染灰）
    canNext: false      // › 可用（到今天为止）
  },

  onLoad(options) {
    const today = new Date()
    this._todayStr = dateToStr(today)
    this._dayKey = this._todayStr // 跨天重置锚：页面停留跨 0 点时用
    const opt = options || {}
    // ?d= 日期头入口：非法或指向未来一律回落今天（拍板 3.A）
    const d = strToDate(opt.d)
    const target = (d && dateToStr(d) <= this._todayStr) ? d : today
    // ?i= 侧栏透传（兼容保留）：合法下标优先展示，语义与「今天那一签」一致
    this.applyDate(target, opt.i !== undefined ? opt.i : null)
  },

  onShow() {
    theme.applyTo(this)
    // 跨天回到页面：日期头与一签一起重置回今天（停留跨 0 点 / 次日再进都覆盖）
    const now = new Date()
    const nowStr = dateToStr(now)
    if (nowStr !== this._dayKey) {
      this._dayKey = nowStr
      this._todayStr = nowStr
      this.applyDate(now, null)
    }
  },

  // 渲染某一天：日期头 + 该日一签。idx 仅侧栏 ?i 入口使用；翻日路径传 null → 按日期取模
  applyDate(d, idx) {
    const ds = dateToStr(d)
    const detail = dailyQuote.getDetail(idx, d)
    const head = lunarDate.header(d)
    this.setData(Object.assign({
      dateStr: ds,
      canPrev: true, // 过去不限（拍板 3.A 只钳未来）
      canNext: ds < this._todayStr
    }, detail, head))
  },

  // ‹ 前一天
  onPrevDay() {
    if (!this.data.canPrev) return
    const cur = strToDate(this.data.dateStr) || new Date()
    this.applyDate(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1), null)
  },

  // › 后一天（到今天为止，越界点击无效）
  onNextDay() {
    if (!this.data.canNext) return
    const cur = strToDate(this.data.dateStr) || new Date()
    this.applyDate(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1), null)
  },

  // 复制全文：含标题与副题，粘到别处自带出处；失败明确告知，不静默
  copyAll() {
    wx.setClipboardData({
      data: this.data.copyText,
      success: () => {
        wx.showToast({ title: '已复制全文', icon: 'none' })
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' })
      }
    })
  }
})
