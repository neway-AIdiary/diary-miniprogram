/**
 * [date-header-v2] 日期头变体识别回归测试
 * 背景：用户导入 518_202609201137.docx 时，5月12~15日被并进「5月16日 日记」。
 *       根因 = 可见结构解析的标题行要求「整行严格匹配」，不认「号 / 星期五 / 括号备注」等变体，
 *       而未识别的头之后的内容全部并入上一篇；且宽泛识别因「已认出 13 篇」被短路。
 * 覆盖：真实 20 条日期头变体全识别、非日期头不误判、XML 级解析不吞并、
 *       loose 日期头/清理、归一化垫层（幂等 + 正文不动）、保险丝判据、接线静态断言。
 * 运行：node tools/test_date_header_variants.js
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

// 真实 518.docx 的 20 条日期头（顺序与文档一致：倒序）
const REAL_HEADERS = [
  '5月31日 日记', '5月30日 日记', '5月29日 日记', '5月28日 日记', '5月27日 日记',
  '5月26日 日记（修正归档版）', '5月25日 日记（完整归档版）', '5月24日 日记', '5月23日 日记',
  '5月22日 日记', '5月21日日记', '5月20日日记', '5月19日日记', '5月18号日记',
  '5月17日日记', '5月16日日记', '5月15日 星期五 日记', '5月14号日记（已修正人名）',
  '5月13日日记（最终修正版）', '5月12号日记'
]

global.wx = {
  getStorageSync: () => [],
  setStorageSync: () => {},
  removeStorageSync: () => {},
  cloud: undefined
}
const NOW = new Date(2026, 8, 20, 10, 0, 0)
const storage = require(path.join(ROOT, 'utils', 'storage.js'))
const loose = require(path.join(ROOT, 'utils', 'looseImport.js'))

console.log('---- A. 真实 20 条日期头变体（parseNumberedDiaries）----')
let text = REAL_HEADERS.map((h, i) => h + '\n第' + (i + 1) + '篇正文。').join('\n')
let ds = storage.parseNumberedDiaries(text)
ok(ds.length === 20, '20 个日期头 → 20 篇（旧版只认 13 个 → 会并成 13 篇）')
const dates = ds.map(d => d.created_at.slice(0, 10))
ok(dates[0] === '2026-05-31' && dates[19] === '2026-05-12', '首尾日期正确（5-31 / 5-12）')
ok(new Set(dates).size === 20, '20 篇日期互不相同（无吞并）')
ok(ds.every(d => /^第\d+篇正文。$/.test(d.content.trim())), '每篇正文各自独立（无跨篇粘连）')
ok(ds.every(d => /^\d+月\d+日 日记$/.test(d.title)), '标题统一为「X月X日 日记」（走默认标题兜底）')
const d18 = ds.find(d => d.created_at.slice(0, 10) === '2026-05-18')
ok(!!d18, '「5月18号日记」被识别（号 = 日）')
const d15 = ds.find(d => d.created_at.slice(0, 10) === '2026-05-15')
ok(!!d15, '「5月15日 星期五 日记」被识别（星期X + 日记双后缀）')
const d13 = ds.find(d => d.created_at.slice(0, 10) === '2026-05-13')
ok(!!d13, '「5月13日日记（最终修正版）」被识别（行尾括号备注）')

console.log('---- B. 非日期头不得误判 ----')
text = '5月12日 日记\n今天去了公司。\n5月11日 晴\n明天休息。'
ds = storage.parseNumberedDiaries(text)
ok(ds.length === 1, '「5月11日 晴」剩余部分是正文 → 不当作日期头（不误切）')
ok(ds[0].content.indexOf('5月11日 晴') !== -1, '该行原样留在正文里（3.A 不丢字）')
ok(storage.parseNumberedDiaries('3.5公里打卡').length === 0, '裸数值行不误判为日期头')
ok(storage.parseNumberedDiaries('2026年5月12日 日记\n正文。').length === 1, '带年份日期头也认')
ok(storage.parseNumberedDiaries('5月1日、5月2日合并日记\n正文。').length === 1, '多日期「合并日记」仍认（旧格式不回归）')

console.log('---- C. XML 级解析（parseDocxXml 可见结构回退）----')
const xml = REAL_HEADERS.map((h, i) =>
  '<w:p><w:r><w:t>' + h + '</w:t></w:r></w:p>' +
  '<w:p></w:p>' +
  '<w:p><w:r><w:t>第' + (i + 1) + '篇正文。</w:t></w:r></w:p>'
).join('') + '<w:p><w:vanish/><w:r><w:t>AIDIARY:{"x":1}</w:t></w:r></w:p>'
const parsed = storage.parseDocxXml('<?xml version="1.0"?><w:document><w:body>' + xml + '</w:body></w:document>')
ok(parsed.diaries.length === 20, '合成 XML → 20 篇（旧版 13 篇且末篇吞并后续内容）')
let maxLen = 0
parsed.diaries.forEach(d => { const n = String(d.content || '').length; if (n > maxLen) maxLen = n })
ok(maxLen < 100, '最长单篇 < 100 字（无吞并：旧版末篇 3000+ 字）')
ok(parsed.full === false, '可见结构回退标记 full=false（走 importDiaryObjects 而非按 id 合并）')
ok(parsed.diaries.every(d => String(d.content).indexOf('5月') === -1), '隐藏段与日期头行都不入正文')

console.log('---- D. loose 日期头与剩余清洗 ----')
let h = loose.matchDateHeader('5月18号日记')
ok(h && h.month === 5 && h.day === 18 && h.rest === '', '「5月18号日记」→ 号识别 + 剩余清洗为空')
h = loose.matchDateHeader('5月15日 星期五 日记')
ok(h && h.rest === '', '「星期五 日记」剩余被清空（不当作标题）')
h = loose.matchDateHeader('5月13日日记（最终修正版）')
ok(h && h.rest === '', '行尾括号备注被清空（不作标题）')
h = loose.matchDateHeader('2026年5月16号 日记')
ok(h && h.hasYear === true && h.rest === '', '带年 + 号 → 带年日期头')

console.log('---- E. 归一化垫层 normalizeDateHeaders ----')
// 守卫：旧版无此导出 → 记断言红而非崩溃（红灯自检纪律）
const hasNorm = typeof loose.normalizeDateHeaders === 'function'
if (!hasNorm) ok(false, 'looseImport.normalizeDateHeaders 未导出（dhv2 未接线）')
const raw = '5月18号日记\n今天上班。\n5月15日 星期五 日记\n爬山。\n5月13日日记（最终修正版）\n看电影。'
const norm = hasNorm ? loose.normalizeDateHeaders(raw) : ''
ok(hasNorm && norm.split('\n')[0] === '5月18日日记', '「号」→「日」')
ok(hasNorm && norm.split('\n')[2] === '5月15日 日记', '去掉「星期五」，保留尾部「日记」')
ok(hasNorm && norm.split('\n')[4] === '5月13日日记', '去掉行尾括号备注')
ok(hasNorm && norm.indexOf('今天上班。') !== -1 && norm.indexOf('看电影。') !== -1, '正文行一字不动')
ok(hasNorm && loose.normalizeDateHeaders(norm) === norm, '幂等：二次归一化结果不变')
const keepLong = '5月12日 今天去了颐和园，人特别多，排了很久的队。'
ok(hasNorm && loose.normalizeDateHeaders(keepLong) === keepLong, '日期开头的正文行不被改写（防误伤）')

console.log('---- F. 保险丝判据 isSuspectHeaderSplit ----')
const hasSuspect = typeof loose.isSuspectHeaderSplit === 'function'
if (!hasSuspect) ok(false, 'looseImport.isSuspectHeaderSplit 未导出（dhv2 未接线）')
const suspect = (d, t) => (hasSuspect ? loose.isSuspectHeaderSplit(d, t) : null)
const mergedOne = [{ content: 'x'.repeat(1600), created_at: '2026-05-16T04:00:00.000Z' }]
const multiHeaderText = '5月16日 日记\n' + 'x'.repeat(1600) + '\n5月11日 晴\n明天休息。\n5月10日 晴\n后天上班。'
ok(suspect(mergedOne, multiHeaderText) === true, '单篇超长 + 3 个日期头却只切出 1 篇 → 判可疑（触发重解析）')
ok(suspect(parsed.diaries, REAL_HEADERS.join('\n')) === false, '已正确切分 → 不判可疑（不重复劳动）')
ok(suspect([], multiHeaderText) === false, '空输入安全')
ok(suspect([{ content: 'x'.repeat(1600) }], '5月16日 日记\n' + 'x'.repeat(1600)) === false,
   '只多 0 个日期头（正常单篇长文）→ 不判可疑')

console.log('---- G. transfer.js 保险丝接线（静态）----')
const trf = rd('utils/transfer.js')
ok(trf.indexOf('[dhv2#17]') !== -1, 'docx 路径已接保险丝')
ok(trf.indexOf('if (parsed.diaries.length && !parsed.full) {') !== -1,
   '保险丝只在可见结构回退路径生效（隐藏 JSON 完整备份不被替换）')
ok(trf.indexOf('looseImport.isSuspectHeaderSplit(parsed.diaries, guardText)') !== -1, '保险丝调用蓄参正确')
ok(trf.indexOf('looseImport.normalizeDateHeaders(guardText)') !== -1, '重解析走归一化垫层文本')
ok(trf.indexOf('if (reparsed.length > parsed.diaries.length)') !== -1, '只在重解析「篇数更多」时才替换结果（不劣化）')
ok(trf.indexOf('let parsed = storage.parseDocxXml(') !== -1, 'parsed 已改为可重赋值（let）')

console.log('---- H. storage / loose 源码护栏 ----')
const sto = rd('utils/storage.js')
ok((sto.match(/\[dhv2#/g) || []).length === 8, 'storage.js 8 处标记（parseCnDate×2 + 两处 titleRe×2 + dateRe + 星期×2 + 年份×1）')
ok(sto.indexOf('\\d{1,2}[日号]') !== -1, 'titleRe 已兼容「号」')
ok(sto.indexOf('(?:(?:周|星期)[日一二三四五六]|日记)') !== -1, 'titleRe 已兼容「星期五」双后缀')
ok((sto.match(/parseCnDate/g) || []).length >= 3, 'parseCnDate 仍被多处复用（未误改语义）')
const li = rd('utils/looseImport.js')
ok(li.indexOf('normalizeDateHeaders, // [dhv2#16]') !== -1, 'looseImport 已导出 normalizeDateHeaders')
ok(li.indexOf('isSuspectHeaderSplit') !== -1, 'looseImport 已导出 isSuspectHeaderSplit')
ok(!/wx\.(get|set|env|cloud|show|request)/.test(li), 'looseImport 仍为纯函数（不调 wx API）')

console.log('')
console.log('date-header-v2: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
