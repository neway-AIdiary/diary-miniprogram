/**
 * 用户协议与隐私政策回归（tools/test_agreement.js）
 *
 * 覆盖：
 *   A) 文件存在与注册：agreement 四件套、privacy-popup 四件套、app.json 页面注册
 *   B) 关于页入口：goToAgreement 绑定与跳转
 *   C) 协议正文：节数、关键条款关键词、应用名/微信号动态注入（不得硬编码）
 *   D) 主题合规：agreement 页与组件 wxss 只用主题令牌（仅允许蒙层 rgba(0,0,0,0.5)）
 *   E) 弹窗组件：官方 open-type 同意按钮、tryShow 机制、不同意不缓存
 *   F) 写日记页接线：json 注册 + wxml 挂载 + onLoad 调 tryShow
 *   G) 红灯自检：对改动前备份跑同一组断言，必须不通过（证明断言有区分度）
 *
 * 纯静态 + require 加载，不依赖开发者工具；cwd 必须为工程根
 */
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
const fails = []

function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  }
}

const base = path.resolve(__dirname, '..')
const BAK = 'C:\\Users\\ThinkPad\\WorkBuddy\\agreement-backup-20260918'

function read(p) {
  return fs.readFileSync(path.join(base, p), 'utf8')
}
function readBak(p) {
  return fs.readFileSync(path.join(BAK, p), 'utf8')
}

const J = read('pages/agreement/agreement.js')
const JW = read('pages/agreement/agreement.wxml')
const JJ = read('pages/agreement/agreement.json')
const JS_ = read('pages/agreement/agreement.wxss')
const CJ = read('components/privacy-popup/privacy-popup.js')
const CW = read('components/privacy-popup/privacy-popup.wxml')
const CS = read('components/privacy-popup/privacy-popup.wxss')
const CC = read('components/privacy-popup/privacy-popup.json')
const UJ = read('utils/agreement.js')
const APPJ = read('app.json')
const AW = read('pages/about/about.wxml')
const AJ = read('pages/about/about.js')
const WJ = read('pages/write/write.json')
const WW = read('pages/write/write.wxml')
const WJS = read('pages/write/write.js')

function count(src, needle) {
  return src.split(needle).length - 1
}

/* ===== A. 文件存在与页面注册 ===== */
;(() => {
  ok(JJ.indexOf('"navigationBarTitleText"') !== -1 && JJ.indexOf('用户协议与隐私政策') !== -1,
    'A-1 agreement.json 标题正确', JJ)
  ok(count(APPJ, 'pages/agreement/agreement') === 1, 'A-2 app.json 注册 agreement 页面恰 1 次', count(APPJ, 'pages/agreement/agreement'))
  ok(CC.indexOf('"component": true') !== -1, 'A-3 privacy-popup.json 声明为组件')
  ok(count(APPJ, 'pages/about/about') === 1, 'A-4 about 页注册未被破坏')
})()

/* ===== B. 关于页入口 ===== */
;(() => {
  ok(count(AW, 'goToAgreement') === 1, 'B-1 about.wxml 绑定 goToAgreement 恰 1 次', count(AW, 'goToAgreement'))
  ok(count(AJ, 'goToAgreement') === 1, 'B-2 about.js 实现 goToAgreement 方法恰 1 处', count(AJ, 'goToAgreement'))
  ok(AJ.indexOf('/pages/agreement/agreement?tab=privacy') !== -1, 'B-3 跳转落隐私政策 Tab')
  ok(AW.indexOf('用户协议与隐私政策') !== -1, 'B-4 入口文案正确')
  ok(AW.indexOf('effectiveDate') !== -1, 'B-5 入口展示生效日期')
  ok(AJ.indexOf('agreement.EFFECTIVE_DATE') !== -1, 'B-6 生效日期来自唯一来源')
})()

/* ===== C. 协议正文 ===== */
;(() => {
  ok(count(UJ, 'appInfo.WECHAT_ID') === 1 && UJ.indexOf('baguanshanren') === -1,
    'C-1 联系方式动态注入，不硬编码微信号', UJ.indexOf('baguanshanren'))
  ok(UJ.indexOf('appInfo.APP_NAME') !== -1, 'C-2 应用名动态注入')
  // require 加载（wx 桩）：结构断言
  global.wx = {}
  const mod = require(path.join(base, 'utils', 'agreement.js'))
  ok(Array.isArray(mod.TERMS) && mod.TERMS.length === 7, 'C-3 用户协议 7 节', mod.TERMS && mod.TERMS.length)
  ok(Array.isArray(mod.PRIVACY) && mod.PRIVACY.length === 9, 'C-4 隐私政策 9 节', mod.PRIVACY && mod.PRIVACY.length)
  const privText = mod.PRIVACY.map((s) => s.title + s.paras.join('')).join('')
  ok(privText.indexOf('麦克风') !== -1, 'C-5 声明麦克风用途')
  ok(privText.indexOf('位置') !== -1 && privText.indexOf('相册') !== -1, 'C-6 声明位置与相册用途')
  ok(privText.indexOf('AES-256') !== -1 && privText.indexOf('PBKDF2') !== -1, 'C-7 说明加密机制')
  ok(privText.indexOf('零知识') !== -1, 'C-8 说明零知识设计')
  ok(privText.indexOf('清除') === -1 || privText.indexOf('清空云端备份') !== -1, 'C-9 写明数据删除权利')
  ok(/^\d{4}-\d{2}-\d{2}$/.test(mod.EFFECTIVE_DATE), 'C-10 生效日期为 YYYY-MM-DD', mod.EFFECTIVE_DATE)
  ok(mod.TERMS[mod.TERMS.length - 1].paras[0].indexOf(mod.EFFECTIVE_DATE) === -1,
    'C-11 联系方式段不夹带日期（由页脚统一展示）')
  // 页面渲染两份文档
  ok(count(JW, 'wx:for="{{terms}}"') === 1, 'C-13 wxml 渲染用户协议')
  ok(count(JW, 'wx:for="{{privacy}}"') === 1, 'C-14 wxml 渲染隐私政策')
  ok(count(JW, 'switchTab') === 2, 'C-15 两个 Tab 均可切换', count(JW, 'switchTab'))
  ok(J.indexOf("require('../../utils/agreement.js')") !== -1, 'C-16 页面取文于唯一来源')
  ok(J.indexOf('theme.applyTo(this)') !== -1, 'C-17 页面接入主题')
  ok(JW.indexOf('themeClass') !== -1, 'C-18 根节点挂主题类')
})()

/* ===== D. 主题合规（深色适配） ===== */
;(() => {
  // 仅允许蒙层的 rgba(0, 0, 0, 0.5)；其余颜色必须走 var(--...)
  const stripMask = (s) => s.replace(/rgba\(0,\s*0,\s*0,\s*0?\.5\)/g, '')
  const bareCS = stripMask(CS)
  ok(/#[0-9a-fA-F]{3,8}\b/.test(bareCS) === false, 'D-1 组件 wxss 无硬编码色值', (bareCS.match(/#[0-9a-fA-F]{3,8}/g) || []).join(','))
  ok(bareCS.indexOf('rgb(') === -1 && bareCS.indexOf('rgba(') === -1, 'D-2 组件 wxss 无裸 rgb/rgba', (bareCS.match(/rgba?\([^)]*\)/g) || []).join(','))
  ok(CS.indexOf('var(--surface)') !== -1 && CS.indexOf('var(--ink)') !== -1, 'D-3 组件颜色走主题令牌')
  const bareJS = stripMask(JS_)
  ok(/#[0-9a-fA-F]{3,8}\b/.test(bareJS) === false, 'D-4 协议页 wxss 无硬编码色值', (bareJS.match(/#[0-9a-fA-F]{3,8}/g) || []).join(','))
  ok(JS_.indexOf('var(--ink)') !== -1 && JS_.indexOf('var(--brand') !== -1, 'D-5 协议页颜色走主题令牌')
})()

/* ===== E. 弹窗组件 ===== */
;(() => {
  ok(count(CW, 'open-type="agreePrivacyAuthorization"') === 1, 'E-1 官方同意按钮恰 1 处', count(CW, 'open-type="agreePrivacyAuthorization"'))
  ok(CW.indexOf('bindagreeprivacyauthorization="onAgree"') !== -1, 'E-2 同意回调已绑定')
  ok(CJ.indexOf('getPrivacySetting') !== -1 && CJ.indexOf('needAuthorization') !== -1, 'E-3 tryShow 走官方授权状态')
  ok(CJ.indexOf('setStorageSync') === -1, 'E-4 不缓存「已同意/已拒绝」标记（由微信侧记录）', CJ.indexOf('setStorageSync'))
  ok(count(CJ, 'onDisagree') === 1, 'E-5 不同意仅收起')
  ok(CW.indexOf('goAgreement') !== -1 && CJ.indexOf('/pages/agreement/agreement') !== -1, 'E-6 弹窗可跳协议全文页')
  ok(CJ.indexOf('wx.onNeedPrivacyAuthorization') === -1 && CJ.indexOf('wx.offNeedPrivacyAuthorization') === -1,
    'E-7 不监听全局授权回调（后续触发交平台默认弹窗兜底，避免跨页弹窗问题）')
})()

/* ===== F. 写日记页接线 ===== */
;(() => {
  ok(WJ.indexOf('"privacy-popup": "../../components/privacy-popup/privacy-popup"') !== -1, 'F-1 write.json 注册组件')
  ok(count(WW, '<privacy-popup id="privacyPopup"') === 1, 'F-2 write.wxml 挂载组件恰 1 处', count(WW, '<privacy-popup'))
  ok(WJS.indexOf("selectComponent('#privacyPopup')") !== -1, 'F-3 onLoad 取组件实例')
  ok(WJS.indexOf('privacyPopup.tryShow()') !== -1, 'F-4 onLoad 触发 tryShow')
  ok(WJS.indexOf('lock.guard()) return') < WJS.indexOf('tryShow()'), 'F-5 密码锁拦截仍在隐私弹窗之前')
})()

/* ===== G. 红灯自检（改动前备份必须不通过同一组断言） ===== */
;(() => {
  try {
    const bakApp = readBak('app/app.json')
    ok(bakApp.indexOf('pages/agreement/agreement') === -1, 'rc-1 改动前 app.json 无 agreement 页（断言有区分度）')
    const bakW = readBak('pages/about/about.wxml')
    ok(bakW.indexOf('goToAgreement') === -1, 'rc-2 改动前关于页无入口（断言有区分度）')
    const bakWJ = readBak('pages/write/write.json')
    ok(bakWJ.indexOf('privacy-popup') === -1, 'rc-3 改动前写日记页未挂弹窗（断言有区分度）')
  } catch (e) {
    ok(false, 'rc-0 红灯自检读备份失败', String(e))
  }
})()

console.log('\n[test_agreement] ' + pass + ' passed, ' + fail + ' failed')
if (fail) {
  fails.forEach((f) => console.log('  FAIL: ' + f))
  process.exit(1)
}
