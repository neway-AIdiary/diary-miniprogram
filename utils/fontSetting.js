/**
 * 日记字体设置（字号 + 字体）
 *
 * 作用对象：用户生成内容（UGC）—— 日记正文 / AI 总结正文 / 各类输入框 /
 *           语音实时文本 / 档案词条名与描述 / 首页卡片摘要 / AI 高亮预览 / 导出 Word 正文。
 *           明确不作用：标题层级（--title-*）、菜单项、字段标签、海报图。
 *
 * 落地方式：本模块只负责「读写设置 + 生成 CSS 变量串 + 按需加载托管字体」。
 *           各页面在 onShow 里把 buildStyle() 注入根节点 style，
 *           对应样式类通过 var(--content-size) / var(--content-name-size) /
 *           var(--content-font) 引用，从而实现「改一处、全站 UGC 生效」。
 *
 * 字体策略（3 种）：
 *   - 系统黑体：各端内置，零成本。
 *   - 宋体/楷体：iOS 内置（Songti SC / Kaiti SC）直接命中；安卓无内置中文衬线，
 *     通过 wx.loadFontFace 从云存储加载自托管子集字体（约 2MB/款，OFL 开源协议），
 *     加载完成前回落黑体，失败也静默回落，绝不阻塞。
 *   - 字体栈尾一律回落 sans-serif（安卓落泛型 serif 会串字体）。
 */

const STORAGE_KEY = 'fontSetting'

// 字号三档
// rpx     : 内容正文字号（日记/总结正文、输入框、语音实时、档案描述、卡片摘要）
// nameRpx : 内容标题字号（档案词条名）
// docx    : 导出 Word 时的正文半磅值（28 半磅 = 14pt ≈ 小四）
const SIZE_OPTIONS = [
  { key: 'small', label: '小', rpx: 28, nameRpx: 30, docx: 24 },
  { key: 'medium', label: '中', rpx: 32, nameRpx: 34, docx: 28 },
  { key: 'large', label: '大', rpx: 36, nameRpx: 38, docx: 32 }
]

// 自托管字体下载地址：必须是「永久地址」（目录权限=所有用户可读后的无签名链接）。
// ⚠️ 控制台复制的「下载地址」是临时签名链接（?sign=&t=过期时间，约 2 小时），不能用！
// 注意：该文件所在域名需加入小程序后台「downloadFile 合法域名」
const REMOTE_URLS = {
  // ?v=2：换缓存 key，绕开 CDN 上早年缓存的「无跨域头」旧响应（CDN 缓存不区分 Origin）
  song: 'https://6169-aidiary-d6grgxkct50c30f45-1468488197.tcb.qcloud.la/fonts/yidengji-song.woff2?v=2',
  kai: 'https://6169-aidiary-d6grgxkct50c30f45-1468488197.tcb.qcloud.la/fonts/yidengji-kai.woff2?v=2'
}

// 字体族（3 种）：
//   sans = 系统黑体（默认）；serif = 宋体；kai = 楷体。
//   宋/楷的栈首是自托管字体注册名（loadFontFace 成功后命中），
//   随后依次尝试 iOS 内置名，安卓在远程字体就绪前回落 sans-serif。
const FONT_OPTIONS = [
  {
    key: 'sans',
    label: '系统黑体',
    desc: '系统默认，最通用',
    stack: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
  },
  {
    key: 'serif',
    label: '宋体',
    desc: '杂志感，适合长文',
    stack: "'YDSongti', 'Songti SC', 'STSong', 'SimSun', sans-serif"
  },
  {
    key: 'kai',
    label: '楷体',
    desc: '手写感，适合短记',
    stack: "'YDKaiti', 'Kaiti SC', 'STKaiti', 'KaiTi', sans-serif"
  }
]

// key 必须与 FONT_OPTIONS 的 key 一致（serif=宋体 / kai=楷体），否则 ensureLoaded 查不到会静默跳过！
const REMOTE_FONTS = {
  serif: { family: 'YDSongti', url: REMOTE_URLS.song },
  kai: { family: 'YDKaiti', url: REMOTE_URLS.kai }
}

// 默认：中档字号 + 系统黑体
const DEFAULT_SETTING = { size: 'medium', font: 'sans' }

// 内存缓存：避免每个页面 onShow 都读一次 storage
let cache = null

// 已完成/进行中的远程字体加载（进程级缓存，loadFontFace global 生效后无需重复加载）
const loadedRemotes = {}

function findOption(list, key) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i]
  }
  return null
}

// 归一化：非法/缺失值一律回落默认档，保证下游取到的一定可用
// （历史遗留的 fangsong / round 选项已下线，会自动回落默认）
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    size: findOption(SIZE_OPTIONS, s.size) ? s.size : DEFAULT_SETTING.size,
    font: findOption(FONT_OPTIONS, s.font) ? s.font : DEFAULT_SETTING.font
  }
}

function getSetting() {
  if (cache) return cache
  let raw = null
  try {
    raw = wx.getStorageSync(STORAGE_KEY)
  } catch (e) {
    raw = null // 无 wx 环境（如 Node 测试）时回落默认
  }
  cache = normalize(raw)
  return cache
}

function saveSetting(patch) {
  const next = normalize(Object.assign({}, getSetting(), patch || {}))
  cache = next
  try {
    wx.setStorageSync(STORAGE_KEY, next)
  } catch (e) {
    // 存储失败不阻塞交互：内存缓存已更新，本次会话内仍然生效
  }
  return next
}

function setSize(key) {
  return saveSetting({ size: key })
}

function setFont(key) {
  const next = saveSetting({ font: key })
  ensureLoaded(next.font)
  return next
}

function getSizeOption(key) {
  return findOption(SIZE_OPTIONS, key) || findOption(SIZE_OPTIONS, getSetting().size) || SIZE_OPTIONS[1]
}

function getFontOption(key) {
  return findOption(FONT_OPTIONS, key) || findOption(FONT_OPTIONS, getSetting().font) || FONT_OPTIONS[0]
}

/**
 * 按需加载自托管字体（宋/楷），供 app 启动与设置页调用。
 * - 非托管字体（sans）、地址未配置、已加载/加载中：直接跳过
 * - 任何异常静默：加载失败 = 回落系统字体，绝不阻塞页面
 */
function ensureLoaded(fontKey) {
  const key = fontKey || getSetting().font
  let remote = null
  try {
    remote = REMOTE_FONTS[key]
  } catch (e) {
    return false
  }
  if (!remote || !remote.url) return false
  if (loadedRemotes[key]) return true
  loadedRemotes[key] = true // 先占位，防止并发重复加载
  try {
    wx.loadFontFace({
      global: true,
      family: remote.family,
      source: 'url("' + remote.url + '")',
      success() {},
      fail(err) {
        // 失败则清占位，允许下次重试；打印原因便于排查（403=权限/链接失效）
        console.warn('[fontSetting] 托管字体加载失败:', remote.family, err)
        loadedRemotes[key] = false
      }
    })
  } catch (e) {
    loadedRemotes[key] = false
    return false
  }
  return true
}

/**
 * 生成注入页面根节点的 CSS 变量串
 * 用法：<view class="page" style="{{fontStyle}}">
 */
function buildStyle(setting) {
  const s = normalize(setting || getSetting())
  const size = getSizeOption(s.size)
  const font = getFontOption(s.font)
  return '--content-size:' + size.rpx + 'rpx;' +
    '--content-name-size:' + size.nameRpx + 'rpx;' +
    '--content-font:' + font.stack + ';'
}

// 导出 Word 的正文半磅值（供 utils/storage.js 使用）
function getDocxSize() {
  return getSizeOption().docx
}

// 测试/调试用：清空内存缓存，强制下次读取 storage
function clearCache() {
  cache = null
}

module.exports = {
  STORAGE_KEY,
  SIZE_OPTIONS,
  FONT_OPTIONS,
  REMOTE_FONTS,
  DEFAULT_SETTING,
  getSetting,
  saveSetting,
  setSize,
  setFont,
  getSizeOption,
  getFontOption,
  ensureLoaded,
  buildStyle,
  getDocxSize,
  clearCache
}
