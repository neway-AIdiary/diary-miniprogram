/**
 * 导入刷新回归：导入完成必须「上报调用方 + 置首页刷新」
 * 运行：node tools/test_import_refresh.js
 *
 * 背景（真机故障）：导入 word 后提示「已导入 N 条」，但日记本里看不到。
 * 根因：utils/transfer.js 的 finish() 在「带说明文字」时弹完窗就 return，
 *       调用方挂在 onFinish 里的刷新永远不执行。
 * 本套件真跑 transfer.importFromFile 的
 *   ① .docx 回退解析（带说明 → 故障路径）
 *   ② .docx 完整备份（无说明 → 回归路径）
 *   ③ 无 onFinish（兜底弹窗必须出现）
 * 并对 finish() 结构、死代码清理做静态断言。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------- wx 桩（内存存储 + 可观测弹窗） ----------------
const store = {}
const sink = { modals: [], toasts: [], loads: [] }
let nextFile = { name: 'backup.docx', path: 'C:\\fake\\backup.docx' }
let nextXml = null
const globalData = { needRefresh: false }

global.wx = {
  env: { USER_DATA_PATH: 'C:\\fake\\userdata' },
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
  showModal: (o) => {
    sink.modals.push({ title: o.title, content: String(o.content) })
    if (o.success) o.success({ confirm: true })
  },
  showToast: (o) => sink.toasts.push(o.title),
  showLoading: () => {},
  hideLoading: () => {},
  showActionSheet: (o) => { if (o.success) o.success({ tapIndex: 0 }) },   // 0 = 导入日记（合并）
  chooseMessageFile: (o) => { if (o.success) o.success({ tempFiles: [nextFile] }) },
  getFileSystemManager: () => ({
    unzip: (o) => { if (o.success) o.success({}) },                       // 解压交给 readFile 桩返回 XML
    rmdir: (o) => { if (o.fail) o.fail({}) },
    readFile: (o) => {
      if (nextXml != null && /word[\\/]document\.xml$/.test(o.filePath)) {
        if (o.success) o.success({ data: nextXml })
        return
      }
      try {
        if (o.success) o.success({ data: fs.readFileSync(o.filePath, o.encoding === 'utf8' ? 'utf8' : undefined) })
      } catch (e) {
        if (o.fail) o.fail({ errMsg: e.message })
      }
    },
    writeFile: () => {}
  }),
  // cloud 置空：让 enrichDiariesWithMeta / uploadParsedImages 走「无云环境」短路，导入链路完全同步可测
  cloud: null
}
global.getApp = () => ({ globalData })

const storage = require(path.join(ROOT, 'utils', 'storage.js'))
const transfer = require(path.join(ROOT, 'utils', 'transfer.js'))

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}

// ---------------- 构造极简 docx（store 模式 zip → document.xml 明文可截取） ----------------
function extractDocumentXml(buf) {
  const s = Buffer.from(buf).toString('utf8')
  const di = s.indexOf('<w:document ')
  if (di < 0) return ''
  const start = s.lastIndexOf('<?xml', di)
  const end = s.indexOf('</w:document>', di)
  if (start < 0 || end < 0) return ''
  return s.slice(start, end + '</w:document>'.length)
}
// 去掉隐藏 JSON 段 → 模拟「被 Word/WPS 编辑过」的文档（回退解析 + 必然带说明文字）
function stripHidden(xml) {
  return xml.replace(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:vanish[\s\S]*?<\/w:p>/g, '')
}

const MARCH_APRIL = [
  { id: 'i1', title: '', content: '三月最后一天，下班很晚。', mood: '', tags: [], media: [], weather: null, created_at: '2026-03-31T12:00:00.000Z' },
  { id: 'i2', title: '', content: '四月一号，天气转暖。', mood: '', tags: [], media: [], weather: null, created_at: '2026-04-01T12:00:00.000Z' },
  { id: 'i3', title: '', content: '四月十号，项目上线。', mood: '', tags: [], media: [], weather: null, created_at: '2026-04-10T12:00:00.000Z' },
  { id: 'i4', title: '', content: '四月二十三号，收尾。', mood: '', tags: [], media: [], weather: null, created_at: '2026-04-23T12:00:00.000Z' }
]
const XML_FULL = extractDocumentXml(storage.buildDocx(MARCH_APRIL, {}, {}, null))
const XML_FALLBACK = stripHidden(XML_FULL)

const SEED = [
  { id: 'a1', title: '9月19日 日记', content: '今天去了趟公司。', mood: '', tags: [], media: [], created_at: '2026-09-19T12:00:00.000Z' },
  { id: 'a2', title: '9月18日 日记', content: '写了一点东西。', mood: '', tags: [], media: [], created_at: '2026-09-18T12:00:00.000Z' },
  { id: 'a3', title: '9月17日 日记', content: '普通的一天。', mood: '', tags: [], media: [], created_at: '2026-09-17T12:00:00.000Z' }
]

function reset(seed) {
  Object.keys(store).forEach(k => delete store[k])
  store['diaries'] = JSON.parse(JSON.stringify(seed || SEED))
  sink.modals.length = 0
  sink.toasts.length = 0
  globalData.needRefresh = false
  nextFile = { name: 'backup.docx', path: 'C:\\fake\\backup.docx' }
}

// [shard-storage v1] 日记按年份分格存储：统计/读取一律走「分格 + 旧格」并集
function allDiariesInStore() {
  const out = []
  Object.keys(store).forEach(k => {
    if (/^diaries(_\d{4})?$/.test(k) && Array.isArray(store[k])) out.push(...store[k])
  })
  return out
}

// ============================================================
console.log('== 0) 夹具自检（必须是「回退解析 + 带说明」这条路径）==')
{
  ok(XML_FULL.length > 100, 'docx 的 document.xml 可提取（' + XML_FULL.length + ' 字）')
  ok(XML_FULL.indexOf('vanish') >= 0, '完整备份含隐藏 JSON 段')
  const pFull = storage.parseDocxXml(XML_FULL)
  const pFb = storage.parseDocxXml(XML_FALLBACK)
  ok(pFull.full === true && pFull.diaries.length === 4, '完整备份：full=true / 4 篇', pFull.diaries.length)
  ok(pFb.full === false && pFb.diaries.length === 4, '回退解析：full=false / 4 篇', pFb.diaries.length)
  ok(Array.isArray(pFb.notes) && pFb.notes.length === 1, '回退解析必然带 1 条说明文字（本次故障的触发条件）', pFb.notes)
  // [parse-title v1] 回退解析必须当场写 title：落库的是对象本身，展示层兜底救不了云备份/导出
  const utilM = require(path.join(ROOT, 'utils', 'util.js'))
  const titles = pFb.diaries.map(d => d.title)
  ok(titles.every(t => !!t), '4 篇 title 全部非空（旧版只给最后一条补）', titles)
  ok(titles[0] === utilM.getDefaultTitle(utilM.getDateKey(new Date(MARCH_APRIL[0].created_at))),
    '首条 title 与展示层兜底同口径（实际 ' + titles[0] + '）')
}

console.log('\n== 0.2) 端到端：导入落库的 title 必须非空 ==')
{
  reset()
  nextXml = XML_FALLBACK
  transfer.importFromFile({})
  const raw = allDiariesInStore()
  const imported = raw.filter(d => /三月最后一天|四月一号|四月十号|四月二十三号/.test(String(d.content || '')))
  ok(imported.length === 4, '导入 4 篇落库', imported.map(d => String(d.content).slice(0, 4)))
  ok(imported.every(d => !!d.title), '落库对象自带 title（不是仅展示层兜底）', imported.map(d => d.title))
}

// ============================================================
console.log('\n== A) 故障路径：带说明文字的 .docx 导入必须上报 + 置刷新 ==')
{
  reset()
  nextXml = XML_FALLBACK
  let called = null
  let errMsg = null
  transfer.importFromFile({
    onFinish: (added, message, extra) => { called = { added, message, extra } },
    onError: (m) => { errMsg = m }
  })
  ok(errMsg === null, 'A-1 没有走 onError（' + JSON.stringify(errMsg) + '）')
  ok(called !== null, 'A-2 onFinish 必须被调用（旧代码在这里被 return 吃掉）', called)
  const added = called ? called.added : -1
  ok(added === 4, 'A-3 新增篇数 = 4', added)
  ok(allDiariesInStore().length === 7, 'A-4 数据确实落库（3 + 4 = 7）', allDiariesInStore().length)
  ok(globalData.needRefresh === true, 'A-5 导入成功即置首页刷新标志（不依赖回调）', globalData.needRefresh)
  const msg = called ? called.message : ''
  ok(msg.indexOf('已导入 4 条日记') >= 0, 'A-6 基础结果在文案里')
  ok(/已在日记本中按日期插入 \d{1,2}月\d{1,2}日( – \d{1,2}月\d{1,2}日)?，共 4 篇/.test(msg),
    'A-7 文案写清落点（日期区间 + 篇数）', msg)
  ok(msg.indexOf('下拉刷新即可看到') >= 0, 'A-8 文案提示可下拉刷新')
  ok(msg.indexOf('文档中没有找到完整备份数据') >= 0, 'A-9 解析说明不再吞掉（旧代码吞掉的是刷新）')
  ok(called && called.extra && called.extra.indexOf('文档中没有找到完整备份数据') >= 0,
    'A-10 第三个参数单独回传说明部分（供调用方排版）', called && called.extra)
  ok(sink.modals.length === 0, 'A-11 有 onFinish 时 transfer 不再自己弹窗（避免双弹）', sink.modals.length)
}

// ============================================================
console.log('\n== B) 无 onFinish：兜底弹窗必须把结果给用户看 ==')
{
  reset()
  nextXml = XML_FALLBACK
  transfer.importFromFile({})
  ok(sink.modals.length === 1, 'B-1 兜底弹窗出现', sink.modals.length)
  const m = sink.modals[0] || {}
  ok(m.title === '导入完成', 'B-2 标题正确：' + m.title)
  ok(String(m.content).indexOf('已在日记本中按日期插入') >= 0, 'B-3 兜底弹窗也带落点提示')
  ok(globalData.needRefresh === true, 'B-4 无回调也要置刷新标志', globalData.needRefresh)
  ok(allDiariesInStore().length === 7, 'B-5 数据落库', allDiariesInStore().length)
}

// ============================================================
console.log('\n== C) 回归路径：完整备份（无说明）照旧上报 ==')
{
  reset()
  nextXml = XML_FULL
  let called = null
  transfer.importFromFile({ onFinish: (added, message, extra) => { called = { added, message, extra } } })
  ok(called !== null && called.added === 4, 'C-1 完整备份导入上报正常', called && called.added)
  ok(called && called.message.indexOf('下拉刷新即可看到') >= 0, 'C-2 刷新提示对所有导入都生效')
  ok(called && typeof called.extra === 'string' && called.extra.indexOf('文档中没有找到完整备份数据') < 0,
    'C-3 完整备份不带解析说明（extra 只有落点与刷新提示）', called && called.extra)
  ok(sink.modals.length === 0, 'C-4 不产生多余弹窗', sink.modals.length)
}

// ============================================================
console.log('\n== D) 纯函数：落点文案与结果文案 ==')
{
  // 旧版本没有这两个导出 → 用 typeof 兜住，保证「旧代码 = 断言红」而不是崩溃
  const hasTip = typeof transfer.importPlacementTip === 'function'
  const hasRes = typeof transfer.buildImportResult === 'function'
  ok(hasTip, 'D-0a importPlacementTip 已导出')
  ok(hasRes, 'D-0b buildImportResult 已导出')

  const tip = hasTip ? transfer.importPlacementTip([
    { created_at: '2026-04-23T12:00:00.000Z' },
    { created_at: '2026-03-31T12:00:00.000Z' }
  ], 14) : ''
  ok(tip === '已在日记本中按日期插入 3月31日 – 4月23日，共 14 篇', 'D-1 跨月区间：' + tip)

  const one = hasTip ? transfer.importPlacementTip([{ created_at: '2026-03-31T12:00:00.000Z' }], 1) : ''
  ok(one === '已在日记本中按日期插入 3月31日，共 1 篇', 'D-2 单日不显示破折号：' + one)

  ok(hasTip && transfer.importPlacementTip([], 3) === '', 'D-3 空清单不产生落点')
  ok(hasTip && transfer.importPlacementTip(MARCH_APRIL, 0) === '', 'D-4 无新增时不产生落点')

  const r0 = hasRes ? transfer.buildImportResult(0, '', null) : { base: '', message: '' }
  ok(r0.base.indexOf('没有新增日记') >= 0 && r0.message.indexOf('下拉刷新') < 0,
    'D-5 无新增：提示「内容已存在」且不劝刷新：' + r0.base)

  const rNeg = hasRes ? transfer.buildImportResult(-1, '', null) : { base: '', message: '' }
  ok(rNeg.base.indexOf('本地存储已满') >= 0 && rNeg.message.indexOf('下拉刷新') < 0,
    'D-6 存储已满：明确失败文案、不提刷新')

  const rExtra = hasRes
    ? transfer.buildImportResult(2, '并导入档案 3 条', [{ created_at: '2026-04-01T12:00:00.000Z' }])
    : { base: '', extra: '', message: '' }
  ok(String(rExtra.extra).split('\n').length === 3, 'D-7 落点 / 刷新提示 / 说明三段齐全', rExtra.extra)
  ok(rExtra.message === rExtra.base + '\n\n' + rExtra.extra, 'D-8 message = base + 空行 + extra')
}

// ============================================================
console.log('\n== S) 静态护栏 ==')
{
  const tSrc = read('utils/transfer.js')

  // S-1 finish() 体内不得出现 return（正是这次的根因写法）
  const lines = tSrc.split('\n')
  const start = lines.findIndex(l => l.indexOf('const finish = (added') >= 0)
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \},?\s*$/.test(lines[i])) { end = i; break }
  }
  const body = start >= 0 && end > start ? lines.slice(start, end + 1).join('\n') : ''
  ok(body.length > 0, 'S-1a 能定位到 finish() 函数体')
  ok(body.indexOf('return') < 0, 'S-1b finish() 体内不得出现 return（防再次吃掉刷新）',
    body.split('\n').filter(l => l.indexOf('return') >= 0))

  // S-2 onFinish 必须在任何 return 之前（等于「无条件上报」）
  const fi = body.indexOf('opts.onFinish(')
  const ri = body.indexOf('return')
  ok(fi >= 0 && (ri < 0 || fi < ri), 'S-2 onFinish 调用早于任何 return')

  // S-3 所有 finish(...) 调用点都带上导入清单（否则算不出落点）
  const oneArg = tSrc.match(/finish\([a-zA-Z.]+\)/g) || []
  ok(oneArg.length === 0, 'S-3a 不再有「只传篇数」的 finish 调用点', oneArg)
  // [import-dedup v1] 调用点分两类，必须分开断言（用「含第 4 参的完整串」而非前缀，
  // 否则旧串会命中新调用的前缀，形成假绿）：
  //  · 走 importDiaryObjects（按「日期+内容指纹」去重）的 → 必须带第 4 参 skipped
  //  · 走 importDiaries（按 id 去重）的完整备份 / JSON 路径 → 保持 3 参
  //    （id 去重里「已存在」= 同一个 id，没有「内容相同被跳过」的语义，硬塞会误导）
  const EXPECT4 = [
    "finish(r.added, looseMsg, loose.diaries, r.skipped)",
    "finish(r.added, parsed.notes && parsed.notes.length ? parsed.notes.join('\\n') : '', parsed.diaries, r.skipped)",
    "finish(added, parsed.notes && parsed.notes.length ? parsed.notes.join('\\n') : '', list, skippedCount)",
    "finish(result.added, looseMsg, loose.diaries, result.skipped)",
    "finish(result.added, '', list, result.skipped)",
    "finish(r.added, '', list, r.skipped)"
  ]
  const missing4 = EXPECT4.filter(s => tSrc.indexOf(s) < 0)
  ok(missing4.length === 0, 'S-3b 六条指纹去重路径的 finish 调用点都带第 4 参 skipped', missing4)
  const EXPECT3 = [
    'finish(added, extra, parsed.diaries)',
    "finish(added, '', jsonList)"
  ]
  const missing3 = EXPECT3.filter(s => tSrc.indexOf(s) < 0)
  ok(missing3.length === 0, 'S-3c 两条 id 去重路径（docx 完整备份 / JSON）保持 3 参调用', missing3)

  // S-4 AI 兜底路径也走同一个 finish
  ok(tSrc.indexOf('aiParseFlow(raw, mode, opts, finish)') >= 0, 'S-4 AI 识别路径复用同一 finish')

  // S-5 死代码清理（只扫小程序运行代码 pages/ utils/ 与 app.js；tools/ 是测试，不算）
  const dead = []
  ;(function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (e.name === 'node_modules' || e.name === 'backup' || e.name === 'tools' || e.name === 'cloudfunctions') return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return walk(p)
      if (!e.name.endsWith('.js')) return
      if (fs.readFileSync(p, 'utf8').indexOf('importResult') >= 0) dead.push(path.relative(ROOT, p))
    })
  })(ROOT)
  ok(dead.length === 0, 'S-5 运行代码里不再有 importResult 死代码', dead)
  ok(/module\.exports\s*=\s*\{[\s\S]{0,200}importPlacementTip[\s\S]{0,80}buildImportResult/.test(tSrc),
    'S-5b 新纯函数已导出（供单测与后续复用）')

  // S-6 两个入口页都仍在 onFinish 里刷新
  const idxSrc = read('pages/index/index.js')
  const pflSrc = read('pages/profile/profile.js')
  ok(idxSrc.indexOf('transfer.importFromFile(') >= 0 && /onFinish:[\s\S]{0,400}this\.loadData\(\)/.test(idxSrc),
    'S-6a 日记本页：onFinish 里刷新列表')
  ok(pflSrc.indexOf('transfer.importFromFile(') >= 0 && /onFinish:[\s\S]{0,300}needRefresh = true/.test(pflSrc),
    'S-6b 我的页：onFinish 里置 needRefresh')
  ok(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').indexOf('needRefresh: false') >= 0,
    'S-6c app.globalData.needRefresh 仍存在（markHomeRefresh 写入的目标）')

  // [empty-import-move v1] 第三个导入入口：写日记页侧栏（前两个 = 日记本页工具行 / 我的页）
  const wJs = read('pages/write/write.js')
  const wWxml = read('pages/write/write.wxml')
  ok(wJs.indexOf('transfer.importFromFile(') >= 0 && /onFinish:[\s\S]{0,200}this\.refreshSidebar\(\)/.test(wJs),
    'S-6d 侧栏导入入口：onFinish 里刷新侧栏（新日记立刻可见，3.A）')
  ok(wWxml.indexOf('class="sidebar-import"') >= 0 && wWxml.indexOf('bindtap="onSidebarImport"') >= 0,
    'S-6e 侧栏导入入口在位（带 ri-download-2-line 图标）')
  ok(wWxml.indexOf('sidebarDiaries.length === 0') >= 0,
    'S-6f 入口仅在无日记时显示（2.A）')
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
