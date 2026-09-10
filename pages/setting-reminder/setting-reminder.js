/**
 * 闹钟提醒设置页
 * 功能：周期（每日/每周）+ 时间 + 周几 + 开关（开启时调订阅消息授权）
 */
const util = require('../../utils/util.js')

// 微信公众平台「我的模板」中的订阅消息模板 ID
const SUBSCRIBE_TPL_ID = 'vLvztBed6Og4EEVcO2phVJUYFLtKU-BlVMS-bVEqA80'

// 周几标签：value 1-7（1=周一）
const WEEKDAY_LABELS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' }
]

// 状态文案模板
function buildStatusText(enabled, cycle, time, dayOfWeek) {
  if (!enabled) return '未开启'
  if (cycle === 'weekly') {
    const wk = WEEKDAY_LABELS.find(w => w.value === dayOfWeek)
    return '已开启 · 每周' + (wk ? wk.label : '一') + ' ' + time
  }
  return '已开启 · 每日 ' + time
}

function buildHintText(enabled) {
  if (enabled) {
    return '到点若未写日记，会通过微信服务通知提醒你。\n频繁推送请引导勾选「总是保持以上选择」以静默续期。'
  }
  return '开启后需授权微信订阅消息，到点会推送「每日记录提醒」。\n授权一次可发送一条，勾选「总是保持」可静默续期。'
}

Page({
  data: {
    cycle: 'daily',
    time: '21:00',
    dayOfWeek: 1,
    enabled: false,
    weekdayLabels: WEEKDAY_LABELS,
    statusText: '未开启',
    hintText: '',
    _initial: null // 记录切换前的状态，开关失败时回滚
  },

  onLoad() {
    this.setData({
      hintText: buildHintText(false),
      statusText: buildStatusText(false, this.data.cycle, this.data.time, this.data.dayOfWeek)
    })
    this.loadRemoteReminder()
  },

  // 从云端读现有配置（云数据库 reminders 集合：客户端自动按 _openid 过滤）
  loadRemoteReminder() {
    if (!wx.cloud) return
    const db = wx.cloud.database()
    db.collection('reminders').limit(1).get({
      success: (res) => {
        const list = res.data || []
        if (list.length) {
          const r = list[0]
          const next = {
            cycle: r.cycle === 'weekly' ? 'weekly' : 'daily',
            time: r.time || '21:00',
            dayOfWeek: r.dayOfWeek || 1,
            enabled: !!r.enabled
          }
          this.setData({
            cycle: next.cycle,
            time: next.time,
            dayOfWeek: next.dayOfWeek,
            enabled: next.enabled,
            statusText: buildStatusText(next.enabled, next.cycle, next.time, next.dayOfWeek),
            hintText: buildHintText(next.enabled)
          })
        }
      },
      fail: () => { /* 集合可能不存在；保持默认配置 */ }
    })
  },

  // 周期切换
  onPickCycle(e) {
    const cycle = e.currentTarget.dataset.cycle
    if (cycle === this.data.cycle) return
    this.setData({
      cycle,
      statusText: buildStatusText(this.data.enabled, cycle, this.data.time, this.data.dayOfWeek)
    })
    if (this.data.enabled) this.saveRemote()
  },

  // 点击时间行：触发 picker
  onPickTime() {
    // picker 已在 wxml 中静态渲染；通过 wx:if 控制可见性确保 picker 实例存在
    this.setData({ showTimePicker: true }, () => {
      // 用 selectComponent 触发点击
      const picker = this.selectComponent ? this.selectComponent('#timePicker') : null
      // 备选方案：直接用 createSelectorQuery
    })
    // 直接模拟点击：使用 picker 自带的「值变化事件」，这里手动调起：
    // 微信 picker 没有 .show() API，需触发 wxml 中 picker 元素的 tap。
    // 简单做法：picker 包一层 view，bindtap 时 wx.showActionSheet 让用户选时间，或者用 picker-view 自定义。
    // 这里简化：用 actionSheet 给几个时段选项。
    // —— 实际方案：用 picker mode=time 通过 setData 后 wx 的 tap 在触发后会弹出。
    // 兜底方案：弹个 modal 手输
    this.chooseTimeFallback()
  },

  // 兜底时间选择（picker 不便程序触发时用 actionSheet）
  chooseTimeFallback() {
    const presets = ['08:00', '12:00', '18:00', '20:00', '21:00', '22:00']
    const idxs = presets.indexOf(this.data.time)
    wx.showActionSheet({
      itemList: presets,
      success: (res) => {
        const t = presets[res.tapIndex]
        this.onTimeChange({ detail: { value: t } })
      },
      fail: () => {
        this.setData({ showTimePicker: false })
      }
    })
  },

  // 时间 picker 回调
  onTimeChange(e) {
    const time = e.detail.value
    this.setData({
      time,
      showTimePicker: false,
      statusText: buildStatusText(this.data.enabled, this.data.cycle, time, this.data.dayOfWeek)
    })
    if (this.data.enabled) this.saveRemote()
  },

  // 周几选择
  onPickWeekday(e) {
    const day = Number(e.currentTarget.dataset.day)
    if (day === this.data.dayOfWeek) return
    this.setData({
      dayOfWeek: day,
      statusText: buildStatusText(this.data.enabled, this.data.cycle, this.data.time, day)
    })
    if (this.data.enabled) this.saveRemote()
  },

  // 开关切换
  onToggle(e) {
    const target = !!e.detail.value
    // 关闭 → 直接落库（不需要重新授权订阅）
    if (!target) {
      this.setData({ enabled: false })
      this.saveRemote({ onFail: () => {
        // 回滚
        this.setData({ enabled: true, statusText: buildStatusText(true, this.data.cycle, this.data.time, this.data.dayOfWeek) })
      }})
      return
    }

    // 开启 → 先请求订阅授权（用户主动操作），再落库
    this.setData({ enabled: true, statusText: buildStatusText(true, this.data.cycle, this.data.time, this.data.dayOfWeek) })

    if (typeof wx.requestSubscribeMessage !== 'function') {
      // 旧基础库兜底：直接保存
      this.saveRemote()
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TPL_ID],
      success: (res) => {
        // 用户允许 / 总是保持 → 落库
        // 用户拒绝单次（res[ID] === 'reject'）→ 也允许保存，下次到点无法推送会静默失败
        this.saveRemote()
      },
      fail: () => {
        // API 失败（系统级）→ 回滚并提示
        this.setData({ enabled: false, statusText: buildStatusText(false, this.data.cycle, this.data.time, this.data.dayOfWeek) })
        wx.showToast({ title: '订阅授权失败', icon: 'none' })
      }
    })
  },

  // 落库（默认 enabled 取当前 data.enabled）
  saveRemote(opts) {
    const onFail = (opts && opts.onFail) || (() => {})
    wx.cloud.callFunction({
      name: 'saveReminder',
      data: {
        cycle: this.data.cycle,
        time: this.data.time,
        dayOfWeek: this.data.cycle === 'weekly' ? this.data.dayOfWeek : null,
        enabled: this.data.enabled
      },
      success: (res) => {
        if (res && res.result && res.result.ok) {
          // 成功：更新底部文案
          this.setData({
            statusText: buildStatusText(this.data.enabled, this.data.cycle, this.data.time, this.data.dayOfWeek),
            hintText: buildHintText(this.data.enabled)
          })
        } else {
          onFail()
          wx.showToast({ title: (res && res.result && res.result.error) || '保存失败', icon: 'none' })
        }
      },
      fail: () => {
        onFail()
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      }
    })
  }
})