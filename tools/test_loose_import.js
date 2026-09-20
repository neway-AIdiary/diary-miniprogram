/**
 * [loose-import v1] 宽泛导入回归测试
 * 覆盖：缺年推断（就近过去年份）、日期头/正文内日期、标题提用、正文原样保留（3.A）、
 *       [loose-block-v2] 日期头之后所有段落归该篇（空行不切篇、段落分隔保留）、
 *       [loose-shortdrop] 无日期短篇（≤10 字）丢弃 + 如实上报、日期头短剩余回填正文（不丢篇）、
 *       [loose-flatline] 整篇不分行时按「两侧都是边界」的日期切段、
 *       开头无日期块单独成篇、全文无日期合一、裸数字边界、
 *       docxXmlToText、安全排序（无日期沉底）、transfer/storage 接线静态断言。
 * 运行：node tools/test_loose_import.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0

function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) }
}

function rd(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

// 测试锚定「现在」：2026-09-20 10:00（当天上午，验证按日期比较不误退年）
const NOW = new Date(2026, 8, 20, 10, 0, 0)

console.log('---- A. 缺年推断（用户规则：未来→退一年）----')
const loose = require(path.join(ROOT, 'utils', 'looseImport.js'))
let t = loose.inferNoYearDate(7, 20, NOW)
ok(t.getFullYear() === 2026 && t.getMonth() === 6 && t.getDate() === 20, '7月20日（已过）→ 2026-07-20')
t = loose.inferNoYearDate(10, 5, NOW)
ok(t.getFullYear() === 2025 && t.getMonth() === 9 && t.getDate() === 5, '10月5日（未来）→ 2025-10-05')
t = loose.inferNoYearDate(9, 20, NOW)
ok(t.getFullYear() === 2026, '9月20日（当天，日期比较不含时间）→ 2026-09-20')
t = loose.inferNoYearDate(9, 21, NOW)
ok(t.getFullYear() === 2025, '9月21日（明天）→ 2025-09-21')
t = loose.inferNoYearDate(1, 1, NOW)
ok(t.getFullYear() === 2026, '1月1日（已过）→ 2026-01-01')
ok(t.getHours() === 12, '推断日期固定当天中午 12 点（与既有口径一致）')

console.log('---- B. 日期头与边界 ----')
let h = loose.matchDateHeader('2026年9月20日')
ok(h && h.hasYear === true && h.rest === '', '2026年9月20日 → 带年日期头')
h = loose.matchDateHeader('9月20日 晴')
ok(h && h.hasYear === false && h.rest === '晴' && h.month === 9 && h.day === 20, '9月20日 晴 → 头 + 剩余「晴」')
h = loose.matchDateHeader('2026-09-20')
ok(h && h.hasYear === true, '2026-09-20 → 带年日期头')
h = loose.matchDateHeader('9.20 晴')
ok(h && h.month === 9 && h.day === 20, '行首 9.20 晴 → 裸数字日期头')
ok(loose.matchDateHeader('3.5公里') === null, '3.5公里 → 不是日期头（后随非标点）')
ok(loose.matchDateHeader('1.2.3版本发布') === null, '1.2.3 → 不是日期头（三段数字）')
ok(loose.matchDateHeader('9月20日。今天…') !== null, '行首 9月20日。→ 仍判定为头（剩余含句点不作标题）')
ok(loose.findDateInText('今天跑了3.5公里。') === null, '正文中部 3.5 → 不识别为日期')
const fd = loose.findDateInText('记得2025年10月1日那天')
ok(fd && fd.hasYear && fd.date.getFullYear() === 2025, '正文中部 2025年10月1日 → 识别（带年）')

console.log('---- C. parseLooseDiaries 行为 ----')
function parse(text) { return loose.parseLooseDiaries(text, { now: NOW }) }

let r = parse('9月20日\n今天爬山。')
ok(r.diaries.length === 1 && r.stats.dated === 1, '日期头 + 正文 → 1 篇 dated')
const expNoon = new Date(2026, 8, 20, 12, 0, 0).toISOString()
ok(r.diaries[0].created_at === expNoon, '缺年 9月20日 → 2026-09-20 中午（本地时区口径）')
ok(r.diaries[0].content === '今天爬山。', '正文不含日期头行')
ok(r.diaries[0].title === '9月20日 日记', 'title 走日期默认')

r = parse('9月20日 晴\n今天爬山。')
ok(r.diaries[0].title === '晴' && r.diaries[0].content === '今天爬山。', '日期头短剩余 → 提为标题')

r = parse('9月20日 今天去了颐和园，人特别多。')
ok(r.diaries.length === 1 && r.stats.dated === 1, '日期在正文行内 → 提取落盘')
ok(r.diaries[0].content === '9月20日 今天去了颐和园，人特别多。', '3.A：正文原样保留（日期句不删）')

r = parse('今天9月20日我们去了长城。')
ok(r.stats.dated === 1 && r.diaries[0].created_at === new Date(2026, 8, 20, 12, 0, 0).toISOString(), '正文内缺年日期 → 推断落盘')

r = parse('2026年7月1日\n建党节出游。')
ok(r.diaries[0].created_at === new Date(2026, 6, 1, 12, 0, 0).toISOString(), '带年日期直接用')

r = parse('10月1日\n国庆。')
ok(r.diaries[0].created_at.indexOf('2025-10-01') === 0, '10月（未来）→ 2025-10-01（用户规则）')

r = parse('7月1日\n出游。')
ok(r.diaries[0].created_at.indexOf('2026-07-01') === 0, '7月（已过）→ 2026-07-01（用户规则）')

r = parse('9月1日\n爬山\n\n心情很好')
ok(r.diaries.length === 1 && r.stats.dated === 1 && r.stats.undated === 0,
  '[block-v2] 空行不再切篇：日期头后所有段落归该篇（旧版会切成 2 篇）')
ok(r.diaries[0].title === '爬山' && r.diaries[0].content === '心情很好',
  '[block-v2] 首行标题样仍提标题，空行之后的段落归该篇正文')

r = parse('9月1日\n爬山\n真开心')
ok(r.diaries.length === 1 && r.diaries[0].content === '真开心' && r.diaries[0].title === '爬山',
   '紧邻行（无空行）→ 追补进同一篇；首行标题样提为标题')

r = parse('今天爬山。\n\n真开心。')
ok(r.diaries.length === 1 && r.stats.undated === 1 && r.diaries[0].created_at === '',
   '全文无日期 → 整篇合为一篇（[block-v2] 口径不变）')
ok(r.diaries[0].content === '今天爬山。\n\n真开心。', '整篇模式保留空行段落')

r = parse('爬山记\n\n今天去了山里，风景很好。')
ok(r.diaries.length === 1 && r.diaries[0].title === '爬山记', '无日期文档首行标题样 → 提为标题')

r = parse('今天跑了3.5公里。感觉不错。')
ok(r.diaries.length === 1 && r.stats.undated === 1, '数值不误判为日期，文字保证落库')

r = parse('2026-09-20 11\n内容。')
ok(r.stats.dated === 1, '带年日期头带数字残渣 → 仍按日期头成篇')
ok(r.diaries[0].title === '9月20日 日记' && r.diaries[0].content === '2026-09-20 11\n内容。', '数字残渣不作标题、整行保留正文')

r = parse('')
ok(r.diaries.length === 0, '空文本 → 0 篇')

console.log('---- C2. 日期头变体与「日期头 + 空行 + 正文」（dhv2）----')
r = parse('9月1日\n\n爬山')
ok(r.diaries.length === 1 && r.stats.dated === 1 && r.diaries[0].content === '爬山',
  '日期头 + 空行 + 正文 → 仍归该篇（Word 排版常见，旧版会丢日期变无日期碎片）')
r = parse('5月12号日记\n今天上班。')
ok(r.stats.dated === 1 && r.diaries[0].created_at === new Date(2026, 4, 12, 12, 0, 0).toISOString(),
  '「号」日期头识别（5月12号）')
r = parse('5月13日日记（最终修正版）\n看电影。')
ok(r.stats.dated === 1 && r.diaries[0].title === '5月13日 日记', '行尾括号备注不作标题（旧版标题会是「日记」）')
r = parse('5月15日 星期五 日记\n打球。')
ok(r.stats.dated === 1 && r.diaries[0].title === '5月15日 日记', '「星期五 日记」双后缀 → 标题走日期默认')

console.log('---- C3. [loose-block-v2] 日期头之后所有段落归该篇（空行不切篇）----')
r = parse('9月1日\n今天爬山，很累。\n\n晚上吃了火锅。')
ok(r.diaries.length === 1 && r.stats.dated === 1 && r.stats.undated === 0,
  '日期头 + 空行分隔的多段落 → 仍是一篇（旧版会切成 2 篇）')
ok(r.diaries[0].content === '今天爬山，很累。\n\n晚上吃了火锅。', '空行作为段落分隔保留（段落不粘连）')
ok(r.diaries[0].title === '9月1日 日记', '首行含标点 → 不提标题，title 走日期默认')

r = parse('9月3日\n甲一。\n\n甲二。\n\n甲三。\n9月2日\n乙一。\n\n乙二。')
ok(r.diaries.length === 2 && r.stats.dated === 2 && r.stats.undated === 0, '两个日期头 → 2 篇（中间段落不另起篇）')
ok(r.diaries[0].content === '甲一。\n\n甲二。\n\n甲三。', '第一篇收全 3 段（直到下一个日期头）')
ok(r.diaries[1].content === '乙一。\n\n乙二。', '第二篇收全 2 段')

r = parse('这是本文档的导入说明与目录，请忽略。\n\n9月1日\n今天爬山。')
ok(r.diaries.length === 2 && r.stats.undated === 1 && r.stats.dated === 1,
  '日期头之前的开头内容（>10 字）→ 单独成篇 + 其后日期篇')
ok(r.diaries[0].created_at === '' && r.diaries[0].content === '这是本文档的导入说明与目录，请忽略。',
  '无日期篇 created_at 留空、内容不丢')
ok(r.diaries[1].content === '今天爬山。' && r.diaries[1].created_at.indexOf('2026-09-01') === 0, '其后日期篇正常落盘')

r = parse('9月1日\n爬山\n\n')
ok(r.diaries.length === 1 && r.diaries[0].content === '爬山', '日期头 + 单行 + 尾空行 → 内容不丢（尾部空行不吃掉整篇）')

r = parse('9月1日\n甲。\n\n\n\n乙。')
ok(r.diaries.length === 1 && r.diaries[0].content === '甲。\n\n乙。', '连续空行压缩为一个（不留大片空白）')

r = parse('9月1日\n\n爬山')
ok(r.diaries.length === 1 && r.diaries[0].content === '爬山', '日期头 + 空行 + 正文 → 归该篇（行首空行忽略）')

r = parse('9月1日\n第一段。\n\n第二段。\n\n第三段。')
ok(r.diaries[0].content.split('\n\n').length === 3, 'Word 稿形态（段间空行）完整保留分段结构')

console.log('---- C4. [loose-flatline] 整篇不分行 → 按带边界日期切段 ----')
r = parse('2026年9月1日 今天上班 2026年9月2日 今天休息')
ok(r.diaries.length === 2 && r.stats.dated === 2, '单行 + 2 个带边界日期 → 2 篇（旧版全挤一篇）')
ok(r.diaries.length === 2 && r.diaries[0].created_at.indexOf('2026-09-01') === 0 &&
  r.diaries[1].created_at.indexOf('2026-09-02') === 0,
  '两篇日期各自正确（带年形式）')
ok(r.diaries[0].content === '今天上班' && r.diaries[0].title === '9月1日 日记',
  '短句回填正文、标题走日期默认（内容不丢）')

r = parse('2026年9月1日 今天上班。2026年9月2日 今天休息。')
ok(r.diaries.length === 2 && r.stats.dated === 2, '标点作边界也算（『。』在句尾 / 日期前）')
ok(r.diaries[0].content.indexOf('2026年9月1日') === 0, '3.A：日期句原样留在正文')

r = parse('会议定在 9月2日 上午，我去了 9月3日 下午')
ok(r.diaries.length === 2 && r.stats.dated === 2 && r.stats.dropped === 1,
  '缺年 X月X日 也认切点；日期前的短块按 1.A 丢弃（4 字）')

r = parse('今天上班心情非常好也很充实 2026年9月1日 明天休息 2026年9月2日 后天放假')
ok(r.diaries.length === 3 && r.stats.dated === 2 && r.stats.undated === 1,
  '日期前的长块（>10 字）保留为无日期篇')

r = parse('我们2026年9月1日去了长城，2026年9月2日回来')
ok(r.diaries.length === 1 && r.stats.dated === 1, '两侧不同时是边界（句子中间的日期）→ 不切、不误劈')

r = parse('2026年9月1日 只有一天')
ok(r.diaries.length === 1 && r.stats.dated === 1, '只有 1 个带边界日期 → 不启用切分（不为一次提及劈开）')

const hasFlat = typeof loose.splitFlatLine === 'function'
if (!hasFlat) ok(false, 'looseImport.splitFlatLine 未导出（loose-flatline 未接线）')
ok(hasFlat && loose.splitFlatLine('第一段\n第二段') === '第一段\n第二段', 'splitFlatLine：已有多行 → 原样返回（不动正常文本）')
ok(hasFlat && loose.splitFlatLine('2026年9月1日 只有一天') === '2026年9月1日 只有一天', 'splitFlatLine：仅 1 个切点 → 原样返回')

console.log('---- C5. [loose-shortdrop] 过短无日期篇丢弃 + 如实上报 ----')
r = parse('518-日记\n\n9月1日\n今天爬山。')
ok(r.diaries.length === 1 && r.stats.dated === 1 && r.stats.undated === 0,
  '开头 ≤10 字无日期块 → 丢弃（518-日记 场景）')
ok(r.stats.dropped === 1 && r.stats.droppedSamples.join('').indexOf('518-日记') !== -1,
  '丢弃计数 + 样本可复核（3.A 如实上报，不静默丢）')

r = parse('今天上班心情非常好也很充实\n\n9月1日\n今天爬山。')
ok(r.diaries.length === 2 && r.stats.undated === 1 && r.stats.dropped === 0, '开头 >10 字无日期块 → 保留')

r = parse('9月1日\n晴')
ok(r.diaries.length === 1 && r.stats.dated === 1 && r.stats.dropped === 0, '1.A：有日期的短篇一律保留（不丢）')
ok(r.diaries.length === 1 && r.diaries[0].content === '晴' && r.diaries[0].title === '9月1日 日记',
  '短篇正文回填不丢字（旧版这里会整篇消失）')

r = parse('今天很累')
ok(r.diaries.length === 1 && r.stats.undated === 1 && r.stats.dropped === 0,
  '2.A：全文无日期整篇合一不适用丢弃（用户主动记的整篇）')
ok(parse('').stats.dropped === 0 && parse('').stats.droppedSamples.length === 0, '空文本 stats 结构完整（dropped 字段存在）')

const hasSuffix = typeof loose.statsSuffix === 'function'
if (!hasSuffix) ok(false, 'looseImport.statsSuffix 未导出（loose-shortdrop 未接线）')
ok(hasSuffix && loose.statsSuffix({ dropped: 0 }) === '', 'statsSuffix：无忽略 → 空串（不污染正常文案）')
const suf = hasSuffix ? loose.statsSuffix({ dropped: 2, droppedSamples: ['『甲』', '『乙』'] }) : ''
ok(suf.indexOf('已忽略 2 处过短内容') !== -1 && suf.indexOf('『甲』') !== -1, 'statsSuffix：有忽略 → 计数 + 样本')
ok(hasSuffix && loose.statsSuffix({}) === '', 'statsSuffix：stats 缺字段安全')

console.log('---- D. docxXmlToText 与安全排序 ----')
global.wx = {
  getStorageSync: () => [],
  setStorageSync: () => {},
  cloud: undefined
}
const storage = require(path.join(ROOT, 'utils', 'storage.js'))
const xml = '<w:p><w:r><w:t>9月1日</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>爬山</w:t></w:r></w:p>' +
  '<w:p><w:vanish/><w:r><w:t>AIDIARY:{"x":1}</w:t></w:r></w:p>' +
  '<w:p></w:p>' +
  '<w:p><w:r><w:t>心情很好</w:t></w:r></w:p>'
// 守卫：旧版无此导出 → 记断言红而非崩溃（红灯自检纪律）
if (typeof storage.docxXmlToText !== 'function') {
  ok(false, 'storage.docxXmlToText 未导出（loose-import 未接线）')
} else {
  const txt = storage.docxXmlToText(xml)
  ok(txt === '9月1日\n爬山\n\n心情很好', 'docxXmlToText：vanish 段剔除、空段留空行')
}
const sorted = [
  { created_at: '2026-01-01T12:00:00.000Z' },
  { created_at: '' },
  { created_at: '2026-06-01T12:00:00.000Z' }
]
storage.importDiaryObjects.length // 触碰导出
// 直接导出函数未暴露 → 用 importDiaryObjects 间接验证排序（见 E 组）

console.log('---- E. 落库集成：无日期条目不破坏排序 ----')
let seq = 0
let store = {}
global.wx.getStorageSync = (k) => store[k]
global.wx.setStorageSync = (k, v) => { store[k] = JSON.parse(JSON.stringify(v)) }
global.wx.removeStorageSync = (k) => { delete store[k] }
const pre = [{ id: 'e1', content: '已有日记', created_at: '2026-05-01T12:00:00.000Z' }]
store.diaries = JSON.parse(JSON.stringify(pre))
const r2 = storage.importDiaryObjects([
  { id: 'u1', title: '', content: '无日期日记', mood: '', tags: [], location: null, media: [], weather: null, created_at: '' },
  { id: 'd1', title: '', content: '带日期日记', mood: '', tags: [], location: null, media: [], weather: null, created_at: '2026-04-01T12:00:00.000Z' }
], false)
ok(r2.added === 2, 'importDiaryObjects 正常写入 2 条')
const after = store.diaries
ok(after.length === 3, '总数 3')
ok(after[0].id === 'e1' && after[1].id === 'd1', '有效日期倒序排列（5月 > 4月）')
ok(after[2].id === 'u1' && after[2].created_at === '', '无日期条目沉底、不破坏其余排序')
// 再导一次（同内容去重）
const r3 = storage.importDiaryObjects([
  { id: 'u2', title: '', content: '无日期日记', mood: '', tags: [], location: null, media: [], weather: null, created_at: '' }
], false)
ok(r3.added === 0, '无日期条目按「日期+内容」去重，二次导入 0 新增')

console.log('---- F. 接线静态断言 ----')
const trf = rd('utils/transfer.js')
ok((trf.match(/looseImport\.parseLooseDiaries/g) || []).length === 2, 'transfer.js 两处调用宽泛引擎（txt + docx）')
ok(trf.indexOf("[loose-import v1][t2]") !== -1, 'docx 路径宽泛分支已接线')
ok(trf.indexOf("[loose-import v1][t3]") !== -1, 'txt 路径宽泛分支已接线')
ok(trf.indexOf("aiParseFlow(raw, mode, opts, finish)") !== -1, 'AI 兜底仍在（宽泛识别无产出时）')
const sto = rd('utils/storage.js')
ok(sto.indexOf('docxXmlToText, // [loose-import v1][s3]') !== -1, 'storage.js 已导出 docxXmlToText')
ok((sto.match(/sortDiariesByTimeDesc\(/g) || []).length === 4, '三处排序 + 函数定义均已接安全排序')
const liSrc = rd('utils/looseImport.js')
ok(!/wx\.(get|set|env|cloud|show|request)/.test(liSrc), 'looseImport.js 纯函数，不调用 wx API')

console.log('')
console.log('loose-import: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
