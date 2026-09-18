/**
 * 行为测试：备份页「云端探测」（修：换机后看不到云端备份）
 *
 * 为什么需要这一套：
 *   2026-09-18 用户在另一台手机（同一微信号）登录，云端备份页显示「未开启 / 不上传任何数据」，
 *   历史版本与「从云端恢复」入口全部不可见 —— 但云开发后台 backup_meta 里记录明明在。
 *   根因：备份页所有判定都读本机 localStorage，换机后本机为空；为换机设计的 backup.cloudStatus()
 *   写了却从没被页面调用，「从云端恢复」还被包在 wx:else 里（只有已开启才显示）。
 *   这类「云端明明有、界面却看不见」的缺陷，静态语法检查与纯工具函数单测都抓不到，
 *   必须把页面真加载起来跑一遍 loadData 才能发现，故单独立套。
 *
 * 覆盖断言：
 *   1) 换机场景（本机无状态 + 云端有备份）→ 识别出云端已有备份、文案三态正确、恢复入口露出、
 *      且「本机没密钥也去查历史版本」（loadVersions 被放开）
 *   2) 已开启 / 曾开启（本地密钥还在）/ 全新用户 三种本机态文案互不串味
 *   3) 探测失败（网络异常）→ 红字提示、且不误报「云端有备份」
 *   4) 换机场景点「开启云端备份」→ 先弹覆盖警示，确认后才开密码弹框（防静默清空云端历史备份）
 *   5) 恢复成功后（本机原本没密钥）→ 询问是否用该密码接上自动备份 → adoptCloud 被调用
 *   6) 静态护栏：loadData 必须调 probeCloud、probeCloud 必须调 cloudStatus；
 *      wxml 恢复入口必须是 showRestore（不得再被 wx:else 包裹）
 *   7) 红灯自检：对改动前的备份文件跑同一套护栏，必须不通过（证明断言有区分度）
 *
 * 2026-09-18 补充（第二个入口）：备份页堵上后，「我的」页 pages/profile 那条路仍是裸的 ——
 *   profile.wxml 的 wx:if="{{!backupEnabled}}" 换机后正好显形，profile.js 的 openEnableBackup
 *   没有任何警示，直接走 backup.enable() → 静默清空云端历史版本。故本次三管齐下：
 *     a) utils/backup.js 的 enable(password, opts) 自己加覆盖护栏（云端已有 versions 且未显式
 *        allowOverwrite → reject，且此刻尚未上传任何密文）—— 调用方漏判时是「失败」而非「丢数据」；
 *     b) 「我的」页补云端探测 + 同款覆盖警示 + 恢复入口（给用户安全替代路径）；
 *     c) 两页点「开启」时按需补查云端（探测是异步的，防「刚进页面手快一点」漏警示）。
 *   断言：
 *   8) 「我的」页换机场景：识别云端已有备份 / 恢复入口露出 / 点开启先警示 / 确认后 enable 才拿到授权
 *   9) utils 层护栏：未授权 → 拒绝且零上传、零改动；显式授权 → 正常覆盖；云端为空 → 不误拦
 *  10) 两页查不到云端状态时一律拦住（宁可不做，也不冒覆盖风险）
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const BK = 'C:\\Users\\ThinkPad\\WorkBuddy\\cloudprobe-backup-20260918'
const BK2 = 'C:\\Users\\ThinkPad\\WorkBuddy\\enableguard-backup-20260918'
const PJ = path.join(base, 'pages', 'backup', 'backup.js')
const PW = path.join(base, 'pages', 'backup', 'backup.wxml')
const QJ = path.join(base, 'pages', 'profile', 'profile.js')
const QW = path.join(base, 'pages', 'profile', 'profile.wxml')
const UJ = path.join(base, 'utils', 'backup.js')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}

const sink = { modals: [], toasts: [], sheets: [], sheetIndex: 0 }
const store = {}

/* ===== 云开发桩：真实 enable() 的覆盖护栏需要（云数据库 / 云存储 / 文件系统）===== */
const cloudState = {
  meta: null,     // 云端 meta 文档（null = 不存在）
  uploads: [],    // 上传过的 cloudPath
  updates: [],    // updateMeta 收到的 patch
  deletes: []     // deleteFile 收到过的 fileID
}
function resetCloud(meta) {
  cloudState.meta = meta ? JSON.parse(JSON.stringify(meta)) : null
  cloudState.uploads = []
  cloudState.updates = []
  cloudState.deletes = []
}

global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  showToast: (o) => { sink.toasts.push(o && o.title) },
  showModal: (o) => { sink.modals.push(o) }, // 不自动确认：由用例手动触发，才能断言中间态
  showLoading: () => {},
  hideLoading: () => {},
  showActionSheet: (o) => { sink.sheets.push(o); if (o && o.success) o.success({ tapIndex: sink.sheetIndex }) },
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({
    writeFile: (o) => { if (o.success) o.success({}); return Promise.resolve() },
    readFile: (o) => { if (o.success) o.success({ data: '' }); return Promise.resolve() }
  }),
  cloud: {
    database: () => ({
      collection: () => {
        const chain = {
          limit: () => chain,
          get: () => Promise.resolve({ data: cloudState.meta ? [cloudState.meta] : [] }),
          add: (o) => {
            cloudState.meta = Object.assign({ _id: 'M1' }, o.data)
            return Promise.resolve({ _id: 'M1' })
          },
          doc: () => ({
            update: (o) => {
              cloudState.updates.push(o.data)
              cloudState.meta = Object.assign({}, cloudState.meta, o.data)
              return Promise.resolve({ stats: { updated: 1 } })
            },
            remove: () => { cloudState.meta = null; return Promise.resolve({}) }
          })
        }
        return chain
      }
    }),
    uploadFile: (o) => {
      const fileID = 'cloud://fake/' + o.cloudPath
      cloudState.uploads.push(o.cloudPath)
      if (o.success) o.success({ fileID })
      return Promise.resolve({ fileID })
    },
    deleteFile: (o) => {
      cloudState.deletes = cloudState.deletes.concat(o.fileList || [])
      if (o.success) o.success({})
      return Promise.resolve({})
    },
    downloadFile: (o) => {
      if (o.success) o.success({ tempFilePath: '/tmp/snapshot.dat' })
      return Promise.resolve({})
    }
  }
}
global.getApp = () => ({ globalData: {} })

const backupMod = require(path.join(base, 'utils', 'backup.js'))
// 提前抓住真实 enable：stub() 会覆盖模块导出，但模块内部调用的是闭包里的原函数
const realEnable = backupMod.enable
const storageMod = require(path.join(base, 'utils', 'storage.js'))
// 恢复落地会写本机存储：打桩，避免用例依赖 storage 内部结构
storageMod.importDiaries = () => 1
storageMod.replaceAllDiaries = () => 1
storageMod.saveArchives = () => {}
storageMod.replaceArchives = () => {}
storageMod.getStats = () => ({})

// 云端最新版列表（元数据）
const VERSIONS = [
  { index: 0, at: '2026-09-17T10:00:00.000Z', itemCount: 12, payloadSize: 2048 },
  { index: 1, at: '2026-09-16T10:00:00.000Z', itemCount: 11, payloadSize: 1900 },
  { index: 2, at: '2026-09-15T10:00:00.000Z', itemCount: 9, payloadSize: 1600 }
]

let adoptCalls = []
let restoreCalls = []
let enableCalls = []   // 记录 enable 收到的 (pwd, opts)：验「覆盖授权随调用传入」

/**
 * 打桩 backup 模块（页面运行时按名查表，故打桩立即生效）
 * @param {object} o { local, cloud, cloudError, versions }
 *   local      —— 本机 cloud_backup_state（null = 换机 / 全新）
 *   cloud      —— cloudStatus 返回（{exists, itemCount, updatedAt, versionCount}）
 *   cloudError —— 非空则 cloudStatus reject
 */
function stub(o) {
  const local = o.local || null
  backupMod.getState = () => local
  backupMod.isEnabled = () => !!(local && local.enabled && local.key)
  backupMod.hasSavedKey = () => !!(local && local.key && local.salt && local.verifier)
  backupMod.getLastSyncError = () => null
  backupMod.cloudStatus = () => (o.cloudError
    ? Promise.reject(new Error(o.cloudError))
    : Promise.resolve(o.cloud || { exists: false }))
  backupMod.listVersions = () => Promise.resolve(o.versions || [])
  backupMod.adoptCloud = (pwd) => { adoptCalls.push(pwd); return Promise.resolve({ itemCount: 12 }) }
  backupMod.restore = (pwd, idx) => {
    restoreCalls.push({ pwd, idx })
    return Promise.resolve({
      diaries: [{ id: 'd1', title: 'T', content: 'C', date: '2026-09-01' }],
      archives: [], itemCount: 1, exportedAt: '', versionAt: '', versionIndex: 0
    })
  }
  backupMod.disable = () => {}
  backupMod.enable = (pwd, opts) => { enableCalls.push({ pwd, opts }); return Promise.resolve({ itemCount: 1 }) }
  backupMod.reenable = () => Promise.resolve({ itemCount: 1 })
  backupMod.sync = () => Promise.resolve({ itemCount: 1 })
  backupMod.clearCloud = () => Promise.resolve()
  backupMod.getLastSyncError = () => null
}

function loadPage() {
  let pageObj = null
  global.Page = (o) => { pageObj = o }
  const dir = path.join(base, 'pages', 'backup')
  const fakeRequire = (p) => require(path.resolve(dir, p))
  const src = fs.readFileSync(PJ, 'utf8')
  const wrapper = vm.runInThisContext(
    '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'backup.js' })
  wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  return pageObj
}

const pageObj = loadPage()

function newPage() {
  const p = Object.create(pageObj)
  p.data = Object.assign({}, pageObj.data)
  p.setData = function (d) { Object.assign(this.data, d) }
  return p
}

// 「我的」页（pages/profile）：它的 openEnableBackup 是第二条通往 enable() 的路
function loadProfilePage() {
  let profileObj = null
  global.Page = (o) => { profileObj = o }
  const dir = path.join(base, 'pages', 'profile')
  const fakeRequire = (p) => require(path.resolve(dir, p))
  const src = fs.readFileSync(QJ, 'utf8')
  const wrapper = vm.runInThisContext(
    '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'profile.js' })
  wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  return profileObj
}

const profileObj = loadProfilePage()

function newProfilePage() {
  const p = Object.create(profileObj)
  p.data = Object.assign({}, profileObj.data)
  p.setData = function (d) { Object.assign(this.data, d) }
  return p
}

const flush = () => new Promise((r) => setTimeout(r, 30))
const lastModal = () => sink.modals[sink.modals.length - 1]
const titles = () => sink.modals.map((m) => m && m.title)

/* ===== 静态护栏：页面必须真的去问云端 ===== */
;(function staticGuard() {
  const j = fs.readFileSync(PJ, 'utf8')
  const w = fs.readFileSync(PW, 'utf8')
  const u = fs.readFileSync(UJ, 'utf8')

  ok(j.indexOf('backup.cloudStatus()') !== -1, 'sg-1 页面确实调用 cloudStatus（换机探测）')
  ok(j.indexOf('this.probeCloud()') !== -1, 'sg-2 loadData 流程里接了 probeCloud')
  ok(j.indexOf('this.probeCloud()') < j.indexOf('  probeCloud() {'), 'sg-3 probeCloud 定义在 loadData 之后')
  ok(j.indexOf('this.confirmOverwriteEnable(this.data.cloudItemCount)') !== -1, 'sg-4 设新密码前有覆盖警示分支')
  ok(j.indexOf('this.askAdoptCloud(this._restorePwd)') !== -1, 'sg-5 恢复完成后会询问接上自动备份')
  ok(u.indexOf('adoptCloud: adoptCloud,') !== -1, 'sg-6 utils/backup.js 导出 adoptCloud')

  ok(w.indexOf('wx:if="{{showRestore}}"') !== -1, 'sg-7 恢复入口条件是 showRestore')
  ok(w.indexOf('</block>') === -1, 'sg-8 菜单不再用 block wx:else 包裹')
  ok(w.indexOf('{{statusTitle}}') !== -1 && w.indexOf('{{statusSub}}') !== -1, 'sg-9 状态卡改用三态文案')
  ok(w.indexOf('{{probeErrorText}}') !== -1, 'sg-10 探测失败有提示位')
  // 菜单区内不得再出现 wx:else（密码弹框 desc 的那处 if/else 不受影响）
  const menu = w.slice(w.indexOf('menu-section'), w.indexOf('privacy-section'))
  ok(menu.indexOf('wx:else') === -1, 'sg-11 菜单区无 wx:else', menu.indexOf('wx:else'))

  /* ===== 2026-09-18 追加：utils 层护栏 + 「我的」页那条路 ===== */
  const qj = fs.readFileSync(QJ, 'utf8')
  const qw = fs.readFileSync(QW, 'utf8')
  ok(u.indexOf('@param {{allowOverwrite?:boolean}}') !== -1, 'sg-12 utils 层 enable 支持 allowOverwrite 显式授权')
  ok(u.indexOf("err.code = 'CLOUD_EXISTS'") !== -1, 'sg-13 护栏抛 CLOUD_EXISTS 供页面指路')
  ok(u.indexOf('if (oldVersions.length && !allowOverwrite)') !== -1, 'sg-14 护栏条件：云端有版本且未授权')
  ok(u.indexOf("err.code = 'CLOUD_EXISTS'") < u.indexOf('return uploadSnapshot(meta._id, enc.ciphertext)'),
    'sg-15 护栏在 uploadSnapshot 之前（拒绝时不产生任何上传）')
  ok(qj.indexOf('backup.cloudStatus()') !== -1, 'sg-16 「我的」页也会探测云端')
  ok(qj.indexOf('this.probeCloud()') !== -1, 'sg-17 「我的」页 loadData 接了 probeCloud')
  ok(qj.indexOf('confirmOverwriteEnable') !== -1, 'sg-18 「我的」页有覆盖警示')
  ok(qj.indexOf('backup.enable(pwd, { allowOverwrite') !== -1, 'sg-19 「我的」页 enable 带显式授权')
  ok(qj.indexOf("e.code === 'CLOUD_EXISTS'") !== -1, 'sg-20 「我的」页接住护栏错误并指路')
  ok(qw.indexOf('wx:if="{{showRestore}}"') !== -1, 'sg-21 「我的」页恢复入口按 showRestore')
  ok(qw.indexOf('wx:if="{{backupEnabled}}" bindtap="backupNow"') !== -1, 'sg-22 「我的」页管理项改由 backupEnabled 守卫')
  // 两页的 showEnableModal 都必须显式传参（防止有人改回无参调用，把覆盖授权默认成真）
  ok(j.indexOf('showEnableModal(allowOverwrite)') !== -1 && j.indexOf('this.showEnableModal()') === -1,
    'sg-23 备份页 showEnableModal 必须显式传参')
  ok(qj.indexOf('showEnableModal(allowOverwrite)') !== -1 && qj.indexOf('this.showEnableModal()') === -1,
    'sg-24 「我的」页 showEnableModal 必须显式传参')
})()

/* ===== 红灯自检：改动前的文件跑同一套护栏必须不通过 ===== */
;(function redCheck() {
  const ow = path.join(BK, 'pages', 'backup', 'backup.wxml')
  const oj = path.join(BK, 'pages', 'backup', 'backup.js')
  if (!fs.existsSync(ow) || !fs.existsSync(oj)) {
    ok(true, 'rc-0 备份目录缺失，跳过红灯自检')
    return
  }
  const w = fs.readFileSync(ow, 'utf8')
  const j = fs.readFileSync(oj, 'utf8')
  ok(j.indexOf('backup.cloudStatus()') === -1, 'rc-1 改动前：页面从不探测云端（断言有区分度）')
  ok(w.indexOf('showRestore') === -1, 'rc-2 改动前：无 showRestore（断言有区分度）')
  ok(w.indexOf('</block>') !== -1, 'rc-3 改动前：菜单被 wx:else 包裹（断言有区分度）')

  // 2026-09-18 追加：对「改动前」的 utils/backup.js 与我的页跑同一套护栏，必须不通过
  const bu = path.join(BK2, 'utils', 'backup.js')
  const bqj = path.join(BK2, 'pages', 'profile', 'profile.js')
  const bqw = path.join(BK2, 'pages', 'profile', 'profile.wxml')
  if (!fs.existsSync(bu) || !fs.existsSync(bqj) || !fs.existsSync(bqw)) {
    ok(true, 'rc-8 覆盖护栏备份目录缺失，跳过该组红灯自检')
  } else {
    const uu = fs.readFileSync(bu, 'utf8')
    const qj2 = fs.readFileSync(bqj, 'utf8')
    const qw2 = fs.readFileSync(bqw, 'utf8')
    ok(uu.indexOf('allowOverwrite') === -1, 'rc-4 改动前：utils 层无覆盖护栏（断言有区分度）')
    ok(qj2.indexOf('backup.cloudStatus()') === -1, 'rc-5 改动前：「我的」页从不探测云端（断言有区分度）')
    ok(qj2.indexOf('confirmOverwriteEnable') === -1, 'rc-6 改动前：「我的」页无覆盖警示（断言有区分度）')
    ok(qj2.indexOf('backup.enable(pwd, { allowOverwrite') === -1, 'rc-7 改动前：enable 未带授权（断言有区分度）')
    ok(qw2.indexOf('showRestore') === -1, 'rc-9 改动前：「我的」页无恢复入口（断言有区分度）')
  }
})()

;(async () => {
  /* ===== 1. 换机场景：本机什么都没有，云端有备份 ===== */
  ;(() => { adoptCalls = []; restoreCalls = []; sink.modals = []; })()
  stub({
    local: null,
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const A = newPage()
  A.loadData()
  await flush()
  ok(A.data.backupEnabled === false, 'A-1 本机仍显示未开启', A.data.backupEnabled)
  ok(A.data.cloudExists === true, 'A-2 探测到云端已有备份', A.data.cloudExists)
  ok(A.data.cloudItemCount === 12, 'A-3 云端篇数正确', A.data.cloudItemCount)
  ok(A.data.statusTitle === '云端已有备份', 'A-4 状态卡标题=云端已有备份', A.data.statusTitle)
  ok(String(A.data.statusSub).indexOf('12 篇') !== -1, 'A-5 状态卡副标题带篇数', A.data.statusSub)
  ok(A.data.showRestore === true, 'A-6 「从云端恢复」入口露出（换机可见）', A.data.showRestore)
  ok(String(A.data.backupHint).indexOf('从云端恢复') !== -1, 'A-7 提示引导去恢复', A.data.backupHint)
  ok((A.data.versions || []).length === 3, 'A-8 本机无密钥也能列出云端历史版本', (A.data.versions || []).length)
  ok(A.data.probeErrorText === '', 'A-9 探测成功无错误提示', A.data.probeErrorText)

  /* ===== 2. 本机已开启 ===== */
  stub({
    local: { enabled: true, key: 'K', salt: 'S', verifier: 'V' },
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const B = newPage()
  B.loadData()
  await flush()
  ok(B.data.statusTitle === '云端备份已开启', 'B-1 已开启文案', B.data.statusTitle)
  ok(B.data.statusSub === '日记改动后自动加密同步', 'B-2 已开启副标题', B.data.statusSub)
  ok(String(B.data.backupHintWarn).indexOf('明文永不上传') !== -1, 'B-3 保留加密承诺', B.data.backupHintWarn)
  ok(B.data.showRestore === true, 'B-4 已开启时恢复入口也在', B.data.showRestore)

  /* ===== 3. 曾开启过但已关闭（本地密钥还在） ===== */
  stub({
    local: { enabled: false, key: 'K', salt: 'S', verifier: 'V' },
    cloud: { exists: false },
    versions: []
  })
  const C = newPage()
  C.loadData()
  await flush()
  ok(C.data.statusTitle === '云端备份已关闭', 'C-1 已关闭文案', C.data.statusTitle)
  ok(C.data.showRestore === true, 'C-2 有密钥时恢复入口在', C.data.showRestore)
  ok(String(C.data.backupHint).indexOf('原备份密码') !== -1, 'C-3 引导用原密码续用', C.data.backupHint)
  ok(String(C.data.backupHintWarn).indexOf('明文永不上传') !== -1, 'C-4 保留加密承诺', C.data.backupHintWarn)

  /* ===== 4. 全新用户：本机空、云端也空 ===== */
  stub({ local: null, cloud: { exists: false }, versions: [] })
  const D = newPage()
  D.loadData()
  await flush()
  ok(D.data.statusTitle === '云端备份未开启', 'D-1 全新用户文案', D.data.statusTitle)
  ok(D.data.showRestore === false, 'D-2 云端无备份时不露出恢复入口', D.data.showRestore)
  ok(String(D.data.backupHint).indexOf('不上传任何数据') !== -1, 'D-3 默认不上传提示', D.data.backupHint)
  ok((D.data.versions || []).length === 0, 'D-4 无备份时版本列表为空', (D.data.versions || []).length)

  /* ===== 5. 探测失败：不得误报「云端有备份」，要有红字提示 ===== */
  stub({ local: null, cloudError: '网络超时，请稍后重试', versions: VERSIONS })
  const E = newPage()
  E.loadData()
  await flush()
  ok(E.data.cloudExists === false, 'E-1 探测失败不误报有备份', E.data.cloudExists)
  ok(String(E.data.probeErrorText).indexOf('云端状态查询失败') !== -1, 'E-2 有红字失败提示', E.data.probeErrorText)
  ok(E.data.statusTitle === '云端备份未开启', 'E-3 文案落回未开启', E.data.statusTitle)
  ok(E.data.showRestore === false, 'E-4 状态未知时不露出恢复入口', E.data.showRestore)
  ok((E.data.versions || []).length === 0, 'E-5 状态未知时不列出云端版本', (E.data.versions || []).length)

  /* ===== 6. 换机场景点「开启云端备份」→ 必须先弹覆盖警示 ===== */
  sink.modals = []
  stub({
    local: null,
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const F = newPage()
  F.loadData()
  await flush()
  F.openEnableBackup()
  ok(sink.modals.length === 1, 'F-1 弹了覆盖警示', titles())
  ok(lastModal().title === '云端已有备份', 'F-2 警示标题', lastModal().title)
  ok(String(lastModal().content).indexOf('清空云端历史备份') !== -1, 'F-3 警示说明会清空', lastModal().content)
  ok(String(lastModal().content).indexOf('从云端恢复') !== -1, 'F-4 警示指路去恢复', lastModal().content)
  ok(F.data.backupModalShow === false, 'F-5 未确认前不打开密码弹框', F.data.backupModalShow)
  lastModal().success({ confirm: false }) // 用户取消
  ok(F.data.backupModalShow === false, 'F-6 取消后仍不开密码弹框', F.data.backupModalShow)
  F.openEnableBackup()
  sink.modals[sink.modals.length - 1].success({ confirm: true }) // 用户坚持设新密码
  ok(F.data.backupModalShow === true, 'F-7 确认后才打开密码弹框', F.data.backupModalShow)
  ok(F.data.allowOverwrite === true, 'F-7b 确认后带上覆盖授权标记', F.data.allowOverwrite)
  // 确认后真正提交 → enable 必须收到 allowOverwrite: true（收不到就会被护栏拦，等于白确认）
  enableCalls = []
  F.data.pwd1 = 'pw123456'
  F.data.pwd2 = 'pw123456'
  F.confirmBackupModal()
  await flush()
  ok(enableCalls.length === 1, 'F-8 确认后确实调用 enable', enableCalls)
  ok(enableCalls[0].opts && enableCalls[0].opts.allowOverwrite === true,
    'F-9 覆盖授权随调用传入（真正堵住静默覆盖）', enableCalls[0] && enableCalls[0].opts)

  /* ===== 7. 无云端备份 / 已开启时，点开启不该有警示 ===== */
  sink.modals = []
  stub({ local: null, cloud: { exists: false }, versions: [] })
  const G = newPage()
  G.loadData()
  await flush()
  G.openEnableBackup()
  await flush() // 现在点开启时会按需补查一次云端，故为异步
  ok(sink.modals.length === 0, 'G-1 云端无备份时不弹警示', titles())
  ok(G.data.backupModalShow === true, 'G-2 直接打开密码弹框', G.data.backupModalShow)
  ok(G.data.reenableMode === false, 'G-3 本机无密钥 → 首次设置模式（输两次）', G.data.reenableMode)
  ok(G.data.allowOverwrite === false, 'G-3b 未确认覆盖 → 授权为 false（护栏会兜底）', G.data.allowOverwrite)

  /* ===== 7b. 进页面探测失败 + 点击时补查也失败 → 拦住，不放行可能覆盖的操作 ===== */
  sink.modals = []
  stub({ local: null, cloudError: '网络超时，请稍后重试', versions: [] })
  const G2 = newPage()
  G2.loadData()
  await flush()
  G2.openEnableBackup()
  await flush()
  ok(sink.modals.length === 1 && lastModal().title === '无法确认云端状态',
    'G-4 备份页：查不到云端状态时拦住', titles())
  ok(G2.data.backupModalShow === false, 'G-5 备份页：拦住后不开密码弹框', G2.data.backupModalShow)

  sink.modals = []
  stub({
    local: { enabled: false, key: 'K', salt: 'S', verifier: 'V' },
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const H = newPage()
  H.loadData()
  await flush()
  H.openEnableBackup()
  ok(sink.modals.length === 0, 'H-1 本机有密钥时不弹覆盖警示（走原密码校验）', titles())
  ok(H.data.backupModalShow === true && H.data.reenableMode === true, 'H-2 已开启过 → 输一次原密码续用',
    { show: H.data.backupModalShow, reenable: H.data.reenableMode })

  /* ===== 8. 换机恢复成功后 → 询问是否接上自动备份 ===== */
  adoptCalls = []
  restoreCalls = []
  sink.modals = []
  sink.sheets = []
  sink.toasts = []
  sink.sheetIndex = 0 // 「合并到本机」
  stub({
    local: null,
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const I = newPage()
  I.loadData()
  await flush()
  I.data.backupMode = 'restore'
  I.data.pwd1 = 'mypassword'
  I.confirmBackupModal()
  await flush()
  ok(restoreCalls.length === 1 && restoreCalls[0].pwd === 'mypassword', 'I-1 用输入的密码发起恢复', restoreCalls)
  ok(sink.sheets.length === 1, 'I-2 恢复后询问合并/覆盖', sink.sheets.length)
  ok(titles().indexOf('已合并恢复') !== -1, 'I-3 落地提示出现', titles())
  const mergedModal = sink.modals.filter((m) => m.title === '已合并恢复')[0]
  ok(!!mergedModal && typeof mergedModal.complete === 'function', 'I-4 落地弹窗带 complete 链（避免两弹窗打架）')
  ok(!sink.modals.some((m) => m.title === '开启自动备份？'), 'I-5 落地弹窗尚未关闭时不叠弹询问')
  mergedModal.complete({}) // 用户点「知道了」关闭落地弹窗
  const ask = sink.modals[sink.modals.length - 1]
  ok(!!ask && ask.title === '开启自动备份？', 'I-6 关闭落地弹窗后询问是否开启自动备份', titles())
  ok(adoptCalls.length === 0, 'I-7 询问未确认前不写本地状态', adoptCalls)
  ask.success({ confirm: true })
  await flush()
  ok(adoptCalls.length === 1 && adoptCalls[0] === 'mypassword', 'I-8 确认后用该密码接上自动备份', adoptCalls)
  ok(sink.toasts.some((t) => String(t).indexOf('已开启自动备份') !== -1), 'I-9 有成功提示', sink.toasts)

  /* ===== 9. 恢复后用户选择「暂不开启」→ 不写状态 ===== */
  adoptCalls = []
  sink.modals = []
  sink.sheets = []
  stub({
    local: null,
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const J = newPage()
  J.loadData()
  await flush()
  J.data.backupMode = 'restore'
  J.data.pwd1 = 'pw123456'
  J.confirmBackupModal()
  await flush()
  const mergedJ = sink.modals.filter((m) => m.title === '已合并恢复')[0]
  ok(!!mergedJ, 'J-0 恢复落地弹窗出现', titles())
  mergedJ.complete({})
  const askJ = sink.modals[sink.modals.length - 1]
  ok(!!askJ && askJ.title === '开启自动备份？', 'J-1 同样弹出询问', titles())
  askJ.success({ confirm: false })
  await flush()
  ok(adoptCalls.length === 0, 'J-2 选择暂不开启则不接上备份', adoptCalls)
  ok(String(askJ.content).indexOf('不会被清空重建') !== -1, 'J-3 询问文案说明不会清空云端', askJ.content)

  /* ===== 10. 「我的」页（第二条通往 enable 的路）：同样必须先警示 =====
     这一条是本次修的重点：profile.wxml 的 wx:if="{{!backupEnabled}}" 换机后正好显形，
     profile.js 原先没有任何警示，点进去设新密码就把云端历史备份静默清了。 */
  enableCalls = []
  sink.modals = []
  stub({
    local: null,
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const P = newProfilePage()
  P.loadData()
  await flush()
  ok(P.data.backupEnabled === false, 'L-1 我的页：换机后显示未开启', P.data.backupEnabled)
  ok(P.data.cloudExists === true, 'L-2 我的页：探测到云端已有备份', P.data.cloudExists)
  ok(P.data.showRestore === true, 'L-3 我的页：恢复入口露出（不再只有「开启」一条路）', P.data.showRestore)
  ok(String(P.data.backupHint).indexOf('从云端恢复') !== -1, 'L-4 我的页：提示引导去恢复', P.data.backupHint)
  ok(P.data.allowOverwrite === false, 'L-5 我的页：默认不带覆盖授权', P.data.allowOverwrite)

  sink.modals = []
  P.openEnableBackup()
  ok(sink.modals.length === 1 && lastModal().title === '云端已有备份', 'L-6 我的页：点开启先弹覆盖警示', titles())
  ok(String(lastModal().content).indexOf('清空云端历史备份') !== -1, 'L-7 我的页：警示说明会清空', lastModal().content)
  ok(P.data.backupModalShow === false, 'L-8 我的页：未确认前不开密码弹框', P.data.backupModalShow)
  ok(enableCalls.length === 0, 'L-9 我的页：未确认前不调用 enable', enableCalls)

  lastModal().success({ confirm: false }) // 用户取消
  ok(P.data.backupModalShow === false, 'L-10 我的页：取消后不开密码弹框', P.data.backupModalShow)
  ok(P.data.allowOverwrite === false, 'L-11 我的页：取消不带覆盖授权', P.data.allowOverwrite)

  P.openEnableBackup()
  lastModal().success({ confirm: true }) // 用户坚持设新密码
  ok(P.data.backupModalShow === true, 'L-12 我的页：确认后才开密码弹框', P.data.backupModalShow)
  ok(P.data.allowOverwrite === true, 'L-13 我的页：确认后带覆盖授权', P.data.allowOverwrite)
  P.data.pwd1 = 'pw123456'
  P.data.pwd2 = 'pw123456'
  P.confirmBackupModal()
  await flush()
  ok(enableCalls.length === 1, 'L-14 我的页：确认后确实调用 enable', enableCalls)
  ok(enableCalls[0].opts && enableCalls[0].opts.allowOverwrite === true,
    'L-15 我的页：覆盖授权随调用传入（真正堵住静默覆盖）', enableCalls[0] && enableCalls[0].opts)

  /* ===== 10b. 我的页：全新用户（云端空）→ 不弹警示，且不带覆盖授权 ===== */
  enableCalls = []
  sink.modals = []
  stub({ local: null, cloud: { exists: false }, versions: [] })
  const P2 = newProfilePage()
  P2.loadData()
  await flush()
  ok(P2.data.showRestore === false, 'L-16 我的页：全新用户无恢复入口', P2.data.showRestore)
  P2.openEnableBackup()
  await flush()
  ok(sink.modals.length === 0, 'L-17 我的页：云端无备份时不弹警示', titles())
  ok(P2.data.backupModalShow === true, 'L-18 我的页：直接开密码弹框', P2.data.backupModalShow)
  ok(P2.data.allowOverwrite === false, 'L-19 我的页：全新用户不带覆盖授权', P2.data.allowOverwrite)

  /* ===== 10c. 我的页：本机有密钥 → 走原密码续用，不弹覆盖警示 ===== */
  sink.modals = []
  stub({
    local: { enabled: false, key: 'K', salt: 'S', verifier: 'V' },
    cloud: { exists: true, itemCount: 12, updatedAt: '2026-09-17T10:00:00.000Z', versionCount: 3 },
    versions: VERSIONS
  })
  const P3 = newProfilePage()
  P3.loadData()
  await flush()
  P3.openEnableBackup()
  ok(sink.modals.length === 0, 'L-20 我的页：本机有密钥时不弹警示', titles())
  ok(P3.data.backupModalShow === true && P3.data.reenableMode === true, 'L-21 我的页：走原密码续用模式',
    { show: P3.data.backupModalShow, reenable: P3.data.reenableMode })

  /* ===== 10d. 我的页：查不到云端状态 → 拦住，不放行可能覆盖的操作 ===== */
  enableCalls = []
  sink.modals = []
  stub({ local: null, cloudError: '网络超时，请稍后重试', versions: [] })
  const P4 = newProfilePage()
  P4.loadData()
  await flush()
  P4.openEnableBackup()
  await flush()
  ok(sink.modals.length === 1 && lastModal().title === '无法确认云端状态',
    'L-22 我的页：查不到状态时拦住', titles())
  ok(P4.data.backupModalShow === false, 'L-23 我的页：拦住后不开密码弹框', P4.data.backupModalShow)
  ok(enableCalls.length === 0, 'L-24 我的页：拦住后不调用 enable', enableCalls)

  /* ===== 11. utils 层覆盖护栏（真实 enable）：漏判时是「失败」，不是「丢数据」 ===== */
  storageMod.getAllDiaries = () => []
  storageMod.getArchives = () => []
  const META3 = {
    _id: 'M1',
    salt: '00112233445566778899aabbccddeeff',
    verifier: 'VVV',
    itemCount: 12,
    fileID: 'cloud://old/3',
    payloadSize: 2048,
    updatedAt: '2026-09-17T10:00:00.000Z',
    versions: [
      { fileID: 'cloud://old/3', at: '2026-09-17T10:00:00.000Z', itemCount: 12, payloadSize: 2048 },
      { fileID: 'cloud://old/2', at: '2026-09-16T10:00:00.000Z', itemCount: 11, payloadSize: 1900 }
    ]
  }

  // 11a 云端已有备份 + 未授权 → 必须拒绝，且云端一个字节都不动
  resetCloud(META3)
  let errK = null
  await realEnable('pw123456').catch((e) => { errK = e })
  ok(!!errK, 'K-1 未授权时 enable 被拒', errK && errK.message)
  ok(errK && errK.code === 'CLOUD_EXISTS', 'K-2 错误码 CLOUD_EXISTS（页面据此指路）', errK && errK.code)
  ok(cloudState.uploads.length === 0, 'K-3 被拒时零上传（没产生新密文）', cloudState.uploads.length)
  ok(cloudState.updates.length === 0, 'K-4 被拒时 meta 未被改写', cloudState.updates.length)
  ok(cloudState.meta && cloudState.meta.versions.length === 2, 'K-5 云端历史版本原样保留',
    cloudState.meta && cloudState.meta.versions.length)
  ok(cloudState.meta && cloudState.meta.fileID === 'cloud://old/3', 'K-6 云端 fileID 未被改',
    cloudState.meta && cloudState.meta.fileID)
  ok(cloudState.deletes.length === 0, 'K-7 被拒时没有删除任何云端密文', cloudState.deletes.length)

  // 11b 显式授权 → 正常覆盖（行为与新密码重建的语义一致）
  resetCloud(META3)
  let okK = null
  await realEnable('pw123456', { allowOverwrite: true }).then((r) => { okK = r })
  ok(!!okK, 'K-8 显式授权后 enable 成功', okK && okK.itemCount)
  ok(cloudState.uploads.length === 1, 'K-9 授权后确实上传了新快照', cloudState.uploads.length)
  ok(cloudState.meta && cloudState.meta.versions.length === 1, 'K-10 覆盖后只剩新版本',
    cloudState.meta && cloudState.meta.versions.length)
  ok(cloudState.deletes.length === 2, 'K-11 云端旧版本密文被清理（覆盖语义未变）', cloudState.deletes.length)

  // 11c 云端为空 → 不误拦（全新用户开启不该被挡）
  resetCloud(null)
  let okK2 = null
  await realEnable('pw123456').then((r) => { okK2 = r })
  ok(!!okK2, 'K-12 云端为空时无需授权也能开启（不误拦）', okK2 && okK2.itemCount)
  ok(cloudState.uploads.length === 1, 'K-13 全新用户正常上传', cloudState.uploads.length)

  console.log('\n[test_backup_probe] ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail === 0 ? 0 : 1)
})()
