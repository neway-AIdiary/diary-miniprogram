/**
 * 导入去重回归 [import-dedup v1]（A + D）
 * 运行：node tools/test_import_dedup.js
 *
 * 背景（真机问题）：先导入 .docx、再导入内容相同的 .txt，日记本同一日期出现两份重复。
 * 根因：去重键 = `日期|content.trim()`，逐字比对原文；而 txt 的空行是「一个空格」（段间隔 "\n \n"），
 *       docx 解出来是干净空行（段间隔 "\n\n"）⇒ 键不等 ⇒ 同一篇被判两篇。
 *       （实测：31 篇里只有全文无空行的 2026-06-07 一篇键相同 ⇒ 其余 30 篇全重复）
 * 修法：A) 键改用 util.contentFingerprint()：只归一化 换行符 / 行首尾空白 / 纯空白行 / 多余空行，
 *          不改动入库原文；正文真有差异（改一句、多一段）时仍判两篇。
 *       D) mergeIntoShards → importDiaryObjects 透出 skipped，导入提示如实报「另有 N 篇已自动跳过」。
 *
 * 本套件覆盖：指纹纯函数 / 真实两形态等价 / storage 去重真跑（含 skipped）/ 文本入口 /
 *            结果文案 / 静态口径断言。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------- wx 桩（内存存储） ----------------
const store = {}
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
  showModal: (o) => { if (o.success) o.success({ confirm: true }) },
  showToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  cloud: null
}
global.getApp = () => ({ globalData: {} })

const util = require(path.join(ROOT, 'utils', 'util.js'))
const storage = require(path.join(ROOT, 'utils', 'storage.js'))
const transfer = require(path.join(ROOT, 'utils', 'transfer.js'))

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}

// 指纹守卫：还原旧源码跑本套件时必须「精准变红、零崩溃」（旧版没有这个导出）
const NO_FP = '\u0000__NO_FINGERPRINT__'
const fp = (t) => (typeof util.contentFingerprint === 'function' ? util.contentFingerprint(t) : NO_FP)
// 本地中午，避开时区把日期推到前一天/后一天
const ct = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).toISOString()

console.log('\n== A. contentFingerprint 纯函数 ==')
ok(fp('a \nb') === 'a\nb', 'A1 行尾空格被归一')
ok(fp('a\t\nb') === 'a\nb', 'A2 行尾 Tab 被归一')
// [import-dedup v1.1] 连续换行统一压成 1 个：段间分隔与单换行在指纹里等价。
// 真机 docx（parseDocxXml）段间是单个 \n，txt 空行分段归一后是 \n\n —— 保留两档则跨格式必不等。
ok(fp('a\n \nb') === 'a\nb', 'A3 「只含空格的行」与单换行等价（本问题的核心）')
ok(fp('a\n　\nb') === 'a\nb', 'A4 全角空格行与单换行等价')
ok(fp('a\r\nb') === 'a\nb', 'A5 CRLF → LF')
ok(fp('a\rb') === 'a\nb', 'A6 单独 CR → LF')
ok(fp('  a\n\tb') === 'a\nb', 'A7 行首缩进被归一')
ok(fp('a\n\n\n\nb') === 'a\nb', 'A8 连续空行折叠为单换行（段间距档位抹平）')
ok(fp('\n\na\n\n') === 'a', 'A9 首尾空白被削掉')
ok(fp(fp('a\n \nb')) === fp('a\n \nb'), 'A10 幂等（跑两次结果一致）')
ok(fp('') === '' && fp(null) === '' && fp(undefined) === '', 'A11 空值安全 → 空串')
ok(fp('a\nb') !== fp('a\nc'), 'A12 正文改一个字仍判不同（不误并）')
ok(fp('a') !== fp('a\n\n补记一句。'), 'A13 追加一段仍判不同（空行归一不会吞内容）')

console.log('\n== B. 真实三形态等价（docx 单换行 / 纯空行 / txt 空格空行） ==')
// 与用户两份文件同构：正文含两个段落。⚠️ 真机 docx 走 parseDocxXml，段间是【单个 \n】
// （v1 曾误用 docxXmlToText+parseDiariesFromText 验证成 \n\n，导致真机跨格式判重失败）
const DOCX_BODY = '六月五日，晴。\n下午去了图书馆。'
const TXT_BODY = '六月五日，晴。\n \n下午去了图书馆。'
const TXT_BODY2 = '六月五日，晴。\n\n下午去了图书馆。'
ok(DOCX_BODY !== TXT_BODY && TXT_BODY !== TXT_BODY2, 'B1 三种形态的原文确实两两不同')
ok(fp(DOCX_BODY) === fp(TXT_BODY) && fp(DOCX_BODY) === fp(TXT_BODY2) && fp(TXT_BODY) === fp(TXT_BODY2),
  'B2 三种形态的指纹全部相等 ⇒ 判为同一篇（本次修复目标）')
ok(fp('六月五日，晴。下午去了图书馆。') !== fp(DOCX_BODY),
  'B2b 无换行的粘连体 ≠ 分段体（换行位置在指纹里仍保留）')
ok(fp('六月五日，晴。\n上午去了公园。') !== fp(DOCX_BODY), 'B3 内容改了字，指纹仍不同')

console.log('\n== C. storage 去重真跑（importDiaryObjects） ==')
const DOCX_LIST = () => ([
  { id: 'k1', content: DOCX_BODY, created_at: ct(2026, 6, 5) },
  { id: 'k2', content: '六月六日，阴。', created_at: ct(2026, 6, 6) }
])
// 同日期、同内容，但空行里多一个空格 + id 不同
const TXT_LIST = () => ([
  { id: 'x1', content: TXT_BODY, created_at: ct(2026, 6, 5) },
  { id: 'x2', content: '六月六日，阴。', created_at: ct(2026, 6, 6) }
])
const r1 = storage.importDiaryObjects(DOCX_LIST(), false)
ok(r1.added === 2, 'C1 首次导入（docx 形态）新增 2 篇', r1)
ok(r1.skipped === 0, 'C2 首次导入 skipped 为 0', r1)
const r2 = storage.importDiaryObjects(TXT_LIST(), false)
ok(r2.added === 0, 'C3 再导 txt 形态（同日期同内容）新增 0 篇 —— 旧代码这里会新增 2 篇', r2)
ok(r2.skipped === 2, 'C4 skipped === 2（如实上报跳过篇数）', r2)
ok(typeof r2.skipped === 'number', 'C5 skipped 是数字（供提示拼接）', typeof r2.skipped)
ok(storage.getAllDiaries().length === 2, 'C6 库里仍然只有 2 篇（未产生重复）', storage.getAllDiaries().length)
const r3 = storage.importDiaryObjects(
  [{ id: 'z1', content: '六月五日，换了内容的一段。', created_at: ct(2026, 6, 5) }], false)
ok(r3.added === 1, 'C7 同一天但正文不同 → 照常新增（不误并真日记）', r3)
const r4 = storage.importDiaryObjects(DOCX_LIST(), true)
ok(r4.skipped === 0, 'C8 覆盖模式（replace）skipped 恒为 0', r4)

console.log('\n== T. 文本入口 importDiariesFromText（走另一条 keyOf） ==')
const T_CLEAN = ['2026年6月7日', '', '六月七日，晴。', '', '下午去了图书馆。', '', '2026年6月8日', '', '六月八日，阴。'].join('\n')
const T_SPACE = ['2026年6月7日', ' ', '六月七日，晴。', ' ', '下午去了图书馆。', '', '2026年6月8日', ' ', '六月八日，阴。'].join('\n')
const t1 = storage.importDiariesFromText(T_CLEAN, false)
ok(t1.added === 2, 'T1 文本首次导入 2 篇', t1)
const t2 = storage.importDiariesFromText(T_SPACE, false)
ok(t2.added === 0, 'T2 空格空行版再导 → 0 新增（两入口口径一致）', t2)
ok(t2.skipped === 2, 'T3 文本入口同样上报 skipped', t2)

console.log('\n== D. 导入结果文案（buildImportResult） ==')
const d0 = transfer.buildImportResult(3, '', [], 0)
ok(d0.message.indexOf('另有') < 0, 'D1 skipped=0 时不出现「另有…已跳过」', d0.message)
const d1 = transfer.buildImportResult(3, '', [], 3)
ok(d1.message.indexOf('另有 3 篇与已有日记内容相同，已自动跳过') >= 0,
  'D2 skipped=3 时文案如实说明', d1.message)
const d2 = transfer.buildImportResult(3, '', [])
ok(d2.message.indexOf('另有') < 0, 'D3 不传 skipped（旧调用点）不崩、不出现该行', d2.message)
const d3 = transfer.buildImportResult(0, '', [], 2)
ok(d3.base.indexOf('没有新增日记') >= 0 && d3.message.indexOf('另有 2 篇') >= 0,
  'D4 全部重复时：基础文案不变 + 追加跳过篇数', d3.message)
const d4 = transfer.buildImportResult(-1, '', [], 5)
ok(d4.base.indexOf('本地存储已满') >= 0 && d4.message.indexOf('另有') < 0,
  'D5 存储已满（added=-1）时失败文案优先，不混入跳过说明', d4.message)

console.log('\n== E. 静态口径断言 ==')
const utilSrc = read(path.join('utils', 'util.js'))
const storageSrc = read(path.join('utils', 'storage.js'))
const transferSrc = read(path.join('utils', 'transfer.js'))
ok(utilSrc.indexOf('function contentFingerprint(text) {') >= 0 &&
  utilSrc.indexOf('\n  contentFingerprint,') >= 0, 'E1 util.js 定义并导出 contentFingerprint')
ok(storageSrc.split('util.contentFingerprint(d.content)').length - 1 === 2,
  'E2 storage.js 两处去重键（对象入口 + 文本入口）都用指纹')
// 只断言「去重键」这一组合式的旧形态已消失：裸的 String(d.content||'').trim() 还有 3 处，
// 那是文本/HTML/docx 导出用的，与去重无关，不该被这条断言管（写宽了会误报）
ok(storageSrc.indexOf("+ '|' + String(d.content || '').trim()") < 0,
  'E3 旧的逐字比对键已无残留（导出用的 trim 不在管辖内）')
ok(storageSrc.indexOf('total: total, skipped: skipped') >= 0 &&
  storageSrc.indexOf('const skipped = items.length - addedItems.length') >= 0,
  'E4 mergeIntoShards 回传 skipped')
ok(transferSrc.indexOf('function buildImportResult(added, extraMsg, list, skipped) {') >= 0 &&
  transferSrc.indexOf('const finish = (added, extraMsg, list, skipped) => {') >= 0,
  'E5 finish / buildImportResult 已接 skipped 参数')
const passedSites = (transferSrc.split(', r.skipped)').length - 1) +
  (transferSrc.split(', result.skipped)').length - 1) +
  (transferSrc.split(', skippedCount)').length - 1)
ok(passedSites >= 6, 'E6 各导入路径的 finish 调用都带上跳过篇数', passedSites)

console.log('\n---------------- 结果 ----------------')
console.log('PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
