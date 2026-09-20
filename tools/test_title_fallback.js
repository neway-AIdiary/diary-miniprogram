/**
 * 展示层标题兜底回归 [title-content-fallback v1]
 * 规则：title 为空 → 取正文开头（遇第一个断句标点即停，≤7 字）→ 正文也取不到才用日期标题「X月X日 日记」
 * 运行：node tools/test_title_fallback.js
 *
 * 背景：导入/旧数据的 title 可能是空串，界面靠展示层兜底；
 *      兜底直接显示日期标题时没有信息量，改为优先取正文开头几个字。
 *      兜底**只作用于展示**，存储里的空 title 保持不动（用户明确要求不回填）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---- wx 桩（内存存储） ----
// 注意：getStorageSync 必须返回**深拷贝** —— 真实微信返回的是反序列化后的新对象，
// 若直接返回同一个引用，业务代码在「读取结果」上的改动会假性污染存储（本套件 C 段会误报）。
const clone = (v) => JSON.parse(JSON.stringify(v))
const memStore = {}
global.wx = {
  getStorageSync: (k) => (k in memStore ? clone(memStore[k]) : ''),
  setStorageSync: (k, v) => { memStore[k] = clone(v) },
  getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10 * 1024, keys: Object.keys(memStore) })
}

const util = require(path.join(ROOT, 'utils', 'util.js'))
const storage = require(path.join(ROOT, 'utils', 'storage.js'))

// 红灯自检用：改动前的版本没有这两个导出，直接调用会抛错让整套崩掉。
// 这里补上空实现，让旧版本的失败表现为「断言红」而不是「测试崩溃」（不参与 D 段的源码断言）。
if (typeof util.titleFromContent !== 'function') util.titleFromContent = () => ''
if (typeof util.resolveDiaryTitle !== 'function') util.resolveDiaryTitle = () => ''

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}
const dateTitle = (iso) => util.getDefaultTitle(util.getDateKey(new Date(iso)))

// ============================================================
console.log('== A) titleFromContent：遇到第一个断句标点就停，最多 7 个字 ==')
{
  ok(util.titleFromContent('今天去了趟公司，很开心') === '今天去了趟公司',
    '超长截到 7 字（实际 ' + util.titleFromContent('今天去了趟公司，很开心') + '）')
  ok(util.titleFromContent('早上很堵') === '早上很堵', '短于 7 字原样保留')
  ok(util.titleFromContent('一二三四五六七') === '一二三四五六七', '恰好 7 字不截断')
  ok(util.titleFromContent('一二三四五六七八') === '一二三四五六七',
    '8 字截到 7 字（实际 ' + util.titleFromContent('一二三四五六七八') + '）')
  ok(util.titleFromContent('\n\n  今天很好，晚上散步  ') === '今天很好',
    '开头换行/空白先压平，再在逗号处停（实际 ' + util.titleFromContent('\n\n  今天很好，晚上散步  ') + '）')
  ok(util.titleFromContent('你好，世界！') === '你好',
    '遇第一个标点即停（实际 ' + util.titleFromContent('你好，世界！') + '）')
  ok(util.titleFromContent('今天去了趟公司吧，') === '今天去了趟公司',
    '标点落在 7 字之外时仍按 7 字截（实际 ' + util.titleFromContent('今天去了趟公司吧，') + '）')

  // ---- v2 新增：断句标点优先 ----
  ok(util.titleFromContent('早上很堵，我开车去公司') === '早上很堵',
    'v2 核心：逗号处停，不硬凑 7 字（实际 ' + util.titleFromContent('早上很堵，我开车去公司') + '）')
  ok(util.titleFromContent('今天天气很好。晚上去散步') === '今天天气很好',
    '句号也停（实际 ' + util.titleFromContent('今天天气很好。晚上去散步') + '）')
  ok(util.titleFromContent('今天很好：晚上去散步') === '今天很好', '冒号也算断句标点')
  ok(util.titleFromContent('2026-09-20 去爬山') === '2026', '连字符算断句标点（不会截出「2026-09-2」）')
  ok(util.titleFromContent('，今天很堵') === '今天很堵',
    '开头的标点跳过、不计入已取内容（实际 ' + util.titleFromContent('，今天很堵') + '）')
  ok(util.titleFromContent('。。。今天很好') === '今天很好', '连串开头标点全部跳过')
  ok(util.titleFromContent('😀今天，很好') === '😀今天', 'emoji 与标点共存时同样按标点停')
  ok(util.titleFromContent('今天很好”’') === '今天很好',
    '引号不在断句集里，靠结尾标点清理收口（实际 ' + util.titleFromContent('今天很好”’') + '）')
  ok(util.titleFromContent('😀😀😀😀😀😀😀😀今天') === '😀😀😀😀😀😀😀',
    '按码点截断，不截坏 emoji（实际 ' + util.titleFromContent('😀😀😀😀😀😀😀😀今天') + '）')
  ok(util.titleFromContent('。！？，、') === '', '通篇标点 → 空串（交给下一级兜底）')
  ok(util.titleFromContent('') === '' && util.titleFromContent(null) === '' &&
    util.titleFromContent(undefined) === '' && util.titleFromContent('   \n  ') === '',
    '空值/纯空白 → 空串')
  ok(util.titleFromContent('一二三四五六七八九十', 3) === '一二三',
    'max 参数可覆盖默认上限（传 3 → 3 字）', util.titleFromContent('一二三四五六七八九十', 3))
}

// ============================================================
console.log('\n== B) resolveDiaryTitle：三级兜底顺序 ==')
{
  ok(util.resolveDiaryTitle({ title: '周末爬山', content: '正文很长很长' }) === '周末爬山',
    '① 有 title → 原样')
  ok(util.resolveDiaryTitle({ title: '   ', content: '今天去了趟公司，很开心' }) === '今天去了趟公司',
    '② title 是纯空白也算空 → 用正文开头（实际 ' +
    util.resolveDiaryTitle({ title: '   ', content: '今天去了趟公司，很开心' }) + '）')
  ok(util.resolveDiaryTitle({ title: '', content: '今天去了趟公司，很开心' }) === '今天去了趟公司',
    '② 空 title → 正文开头 ≤7 字')
  const onlyDate = util.resolveDiaryTitle({ title: '', content: '', created_at: '2026-09-03T12:00:00.000Z' })
  ok(onlyDate === dateTitle('2026-09-03T12:00:00.000Z'),
    '③ 正文也空 → 日期标题「X月X日 日记」（实际 ' + onlyDate + '）')
  const punctOnly = util.resolveDiaryTitle({ title: '', content: '。。！', created_at: '2026-09-03T12:00:00.000Z' })
  ok(punctOnly === dateTitle('2026-09-03T12:00:00.000Z'),
    '③ 正文只有标点 → 同样退到日期标题（实际 ' + punctOnly + '）')
  ok(util.resolveDiaryTitle(null) === '' && util.resolveDiaryTitle(undefined) === '', 'null/undefined 安全返回空串')
}

// ============================================================
console.log('\n== C) getAllDiaries 端到端：兜底生效 + 存储不被改写 ==')
{
  memStore['diaries'] = [
    { id: 'x1', title: '', content: '今天去了趟公司，很开心', created_at: '2026-09-01T12:00:00.000Z' },
    { id: 'x2', title: '周末爬山', content: '正文', created_at: '2026-09-02T12:00:00.000Z' },
    { id: 'x3', title: '', content: '   \n  ', created_at: '2026-09-03T12:00:00.000Z' }
  ]
  const list = storage.getAllDiaries()
  const byId = {}
  list.forEach(d => { byId[d.id] = d.title })
  ok(byId.x1 === '今天去了趟公司', '空 title 的旧条目按正文开头显示（实际 ' + byId.x1 + '）')
  ok(byId.x2 === '周末爬山', '有 title 的原样保留')
  ok(byId.x3 === dateTitle('2026-09-03T12:00:00.000Z'),
    '正文为空的退到日期标题（实际 ' + byId.x3 + '）')
  const raws = memStore['diaries'].map(d => d.title)
  ok(raws[0] === '' && raws[2] === '',
    '存储里的空 title 保持不动（展示层兜底不写回，用户要求「不回填」）', raws)
}

// ============================================================
console.log('\n== D) 静态护栏：三处展示出口共用同一口径 ==')
{
  const utilSrc = read('utils/util.js')
  const storageSrc = read('utils/storage.js')
  const indexSrc = read('pages/index/index.js')
  const detailSrc = read('pages/detail/detail.js')
  const detailWxml = read('pages/detail/detail.wxml')

  ok(utilSrc.indexOf('function titleFromContent(') !== -1 &&
    utilSrc.indexOf('function resolveDiaryTitle(') !== -1 &&
    utilSrc.indexOf('\n  resolveDiaryTitle,') !== -1,
    'util 已定义并导出 resolveDiaryTitle / titleFromContent')
  ok(utilSrc.indexOf('const TITLE_STOP_RE =') !== -1,
    'v2 断句标点集 TITLE_STOP_RE 存在（遇第一个标点即停的规则载体）')
  ok(storageSrc.indexOf('d.title = util.resolveDiaryTitle(d)') !== -1, '列表数据源 getAllDiaries 走统一口径')
  ok(indexSrc.indexOf('d.title = util.resolveDiaryTitle(d)') !== -1, '日记本列表页走统一口径')
  ok(detailSrc.indexOf('displayTitle: util.resolveDiaryTitle(diary)') !== -1, '详情页浏览态走统一口径')
  ok(detailSrc.indexOf('title: d ? (util.resolveDiaryTitle(d)') !== -1, '分享卡片标题走统一口径')
  ok(detailWxml.indexOf('{{displayTitle ||') !== -1, '详情页 wxml 渲染 displayTitle（不再用空的 diary.title）')

  // 反向：旧的「直接用日期标题」兜底不得残留在展示链路里
  ok(indexSrc.indexOf('util.getDefaultTitle(util.getDateKey(new Date(d.created_at)))') === -1,
    '列表页不再残留旧的「直接日期标题」兜底')
  // 反向：getAllDiaries 函数体内不得再自己拼日期标题（口径必须只有一处）
  const gadStart = storageSrc.indexOf('function getAllDiaries()')
  const gad = storageSrc.slice(gadStart, storageSrc.indexOf('function saveDiary('))
  ok(gadStart !== -1 && gad.indexOf('util.resolveDiaryTitle(d)') !== -1 && gad.indexOf('getDefaultTitle') === -1,
    'getAllDiaries 函数体内只走 resolveDiaryTitle（不自己拼日期标题）', gad.length)

  // 上限硬约束：任何正文取标题都不得超过 7 字
  ok(util.titleFromContent('一二三四五六七八九十') === '一二三四五六七',
    '默认上限就是 7 字（写死断言，防后人悄悄调大）')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
