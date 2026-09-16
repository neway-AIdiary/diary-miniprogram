/**
 * 「写日记页占位文案规则」测试（utils/textRules.js）
 * 运行：node tools/test_textrules.js
 *
 * A. 常量与默认文案（零回归：默认三行必须与改造前完全一致）
 * B. normalizeLines：去空行 / 最多 3 行 / 不足 3 行继承默认
 * C. normalizeRules：非法丢弃、开关、区间纠正、排序
 * D. pickLines：打开次数优先于日记篇数、区间端点、兜底默认
 * E. 打开次数计数（无 wx 降级 / mock wx 持久化）
 * F. refresh：集合名、成功写缓存、空数据不覆盖、失败静默
 * G. 接入 lint：write.js / app.js 接线正确，且示例日记插入已移除（防回归）
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log('  ✗ ' + msg)
  }
}

// 先加载模块（无 wx 环境，验证静默降级不抛）
const textRules = require('../utils/textRules.js')

// ============ A. 常量与默认文案 ============
console.log('== A. 常量与默认文案 ==')
ok(textRules.DEFAULT_LINES.length === 3, '默认文案 3 行')
ok(textRules.MAX_LINES === 3, '最多 3 行')
ok(textRules.COLLECTION === 'text_rules', '集合名 = text_rules')
ok(textRules.COUNT_KEY === 'launchCount', '打开次数存储键')
ok(textRules.DEFAULT_LINES[0] === '您可以语音或手动输入内容，自动记录和融合到当天的日记', '默认第 1 行与改造前一致（零回归）')
ok(textRules.DEFAULT_LINES[1] === '输入改动指令直接更改内容，如：把王威改成王伟，删除第一句', '默认第 2 行与改造前一致')
ok(textRules.DEFAULT_LINES[2] === '最终还可以通过点击AI优化按钮，完善您的日记', '默认第 3 行与改造前一致')

// 默认文案长度约束：覆盖层逐行渲染，单行过长会折行撑高，压到下方说明文字
textRules.DEFAULT_LINES.forEach((line, i) => {
  ok(line.length <= 30, '默认第 ' + (i + 1) + ' 行不超过 30 字（实际 ' + line.length + '）')
})

// ============ B. normalizeLines ============
console.log('== B. normalizeLines ==')
ok(textRules.normalizeLines(['a', 'b', 'c', 'd']).length === 3, '超过 3 行截断')
const nl1 = textRules.normalizeLines(['a', '', 'b'])
ok(nl1.length === 3 && nl1[0] === 'a' && nl1[1] === 'b' && nl1[2] === textRules.DEFAULT_LINES[2],
  '去空行 + 不足 3 行继承默认')
ok(textRules.normalizeLines([]).length === 0, '空数组返回空（由 normalizeRules 丢弃）')
ok(textRules.normalizeLines('a')[0] === 'a', '字符串兼容（单行简写）')
ok(textRules.normalizeLines([null, undefined, '  x  '])[0] === 'x', '忽略 null/undefined 并去空格')
ok(textRules.normalizeLines('   ').length === 0, '全空白字符串返回空')

// ============ C. normalizeRules ============
console.log('== C. normalizeRules ==')
ok(textRules.normalizeRules(null).length === 0, '非数组输入返回空')
ok(textRules.normalizeRules([{ type: 'x', lines: ['a'] }]).length === 0, '非法 type 丢弃')
ok(textRules.normalizeRules([{ type: 'launch', lines: [] }]).length === 0, '无文案丢弃')
ok(textRules.normalizeRules([{ type: 'launch', lines: [''] }]).length === 0, '文案全空丢弃')
ok(textRules.normalizeRules([{ type: 'launch', enabled: false, lines: ['a'] }]).length === 0, 'enabled=false 丢弃')
ok(textRules.normalizeRules([{ type: 'launch', enabled: 0, lines: ['a'] }]).length === 0, 'enabled=0 丢弃')
ok(textRules.normalizeRules([{ type: 'launch', enabled: 'false', lines: ['a'] }]).length === 0, 'enabled="false" 丢弃')
ok(textRules.normalizeRules([{ type: 'launch', lines: ['a'] }]).length === 1, 'enabled 缺省视为启用')

const rMax = textRules.normalizeRules([{ type: 'launch', min: 5, lines: ['a'] }])
ok(rMax[0].max === Infinity, 'max 缺省 = 无上限')
const rMin = textRules.normalizeRules([{ type: 'launch', lines: ['a'] }])
ok(rMin[0].min === 0, 'min 缺省 = 0')
const rInv = textRules.normalizeRules([{ type: 'launch', min: 9, max: 2, lines: ['a'] }])
ok(rInv[0].max === 9, 'min/max 倒置时 max 纠正为 min')
const rBadNum = textRules.normalizeRules([{ type: 'launch', min: 'abc', max: null, lines: ['a'] }])
ok(rBadNum[0].min === 0 && rBadNum[0].max === Infinity, '非法数字回落 0/无上限')
// 回归点：Number(null) === 0，若 toNum 不特判，控制台把 max 清空会让区间变成 [0,0] 永不命中
const rNull = textRules.normalizeRules([{ type: 'launch', min: null, max: null, lines: ['a'] }])
ok(rNull[0].min === 0 && rNull[0].max === Infinity, '★ min/max 为 null（控制台清空字段）回落 0/无上限')
const rEmpty = textRules.normalizeRules([{ type: 'launch', min: '', max: '', lines: ['a'] }])
ok(rEmpty[0].min === 0 && rEmpty[0].max === Infinity, 'min/max 为空字符串回落 0/无上限')
ok(textRules.pickLines(rNull, { launchCount: 88, diaryCount: 0 })[0] === 'a', 'max 留空 = 无上限（第 88 次仍命中）')

const rSort = textRules.normalizeRules([
  { _id: 'b', order: 30, type: 'launch', lines: ['c'] },
  { _id: 'a', order: 10, type: 'launch', lines: ['a'] },
  { _id: 'c', order: 20, type: 'launch', lines: ['b'] }
])
ok(rSort[0].lines[0] === 'a' && rSort[1].lines[0] === 'b' && rSort[2].lines[0] === 'c', '按 order 升序')
const rNoOrder = textRules.normalizeRules([
  { _id: 'p', type: 'launch', lines: ['p'] },
  { _id: 'q', type: 'launch', lines: ['q'] }
])
ok(rNoOrder[0].lines[0] === 'p' && rNoOrder[1].lines[0] === 'q', '未填 order 按记录顺序兜底')
ok(textRules.normalizeRules([{ type: 'launch', lines: ['a'] }])[0].lines.length === 3, '归一化后文案恒为 3 行')

// ============ D. pickLines ============
console.log('== D. pickLines（打开次数优先于篇数）==')
const RULES = textRules.normalizeRules([
  { order: 10, type: 'launch', min: 1, max: 1, lines: ['A1', 'A2', 'A3'] },
  { order: 20, type: 'launch', min: 2, max: 5, lines: ['B1', 'B2', 'B3'] },
  { order: 30, type: 'diary', min: 0, max: 9, lines: ['C1', 'C2', 'C3'] },
  { order: 40, type: 'diary', min: 10, max: 999, lines: ['D1', 'D2', 'D3'] }
])
ok(RULES.length === 4, '规则表归一化 4 条')
ok(textRules.pickLines(RULES, { launchCount: 1, diaryCount: 0 })[0] === 'A1', '第 1 次打开命中 launch 1~1')
ok(textRules.pickLines(RULES, { launchCount: 3, diaryCount: 0 })[0] === 'B1',
  '★ 冲突时以打开次数为准（launch 2~5 vs diary 0~9）')
ok(textRules.pickLines(RULES, { launchCount: 3, diaryCount: 15 })[0] === 'B1',
  '★ 冲突时以打开次数为准（launch 命中即不看篇数）')
ok(textRules.pickLines(RULES, { launchCount: 9, diaryCount: 0 })[0] === 'C1', '次数未命中 → 落篇数 0~9')
ok(textRules.pickLines(RULES, { launchCount: 9, diaryCount: 15 })[0] === 'D1', '次数未命中 → 落篇数 10~999')
ok(textRules.pickLines(RULES, { launchCount: 5, diaryCount: 0 })[0] === 'B1', '区间上限含端点（次数 5）')
ok(textRules.pickLines(RULES, { launchCount: 6, diaryCount: 0 })[0] === 'C1', '区间外（次数 6）回落篇数规则')
ok(textRules.pickLines(RULES, { launchCount: 9, diaryCount: 9 })[0] === 'C1', '区间上限含端点（篇数 9）')
ok(textRules.pickLines(RULES, { launchCount: 9, diaryCount: 10 })[0] === 'D1', '区间下限含端点（篇数 10）')
ok(textRules.pickLines(RULES, { launchCount: 9, diaryCount: 1000 })[0] === textRules.DEFAULT_LINES[0],
  '全部未命中回落默认（篇数 1000 超出 diary max=999）')
ok(textRules.pickLines(RULES, {})[0] === 'A1', 'ctx 缺省时按第 1 次打开处理')
ok(textRules.pickLines([], { launchCount: 5, diaryCount: 5 })[0] === textRules.DEFAULT_LINES[0], '空规则表回落默认')
ok(textRules.pickLines(null, {})[0] === textRules.DEFAULT_LINES[0], '非法规则表回落默认')
ok(textRules.pickLines(RULES, { launchCount: 1, diaryCount: 0 }).length === 3, '返回值恒为 3 行')

// 只改第 1 行：后两行必须沿用默认（控制台可只填一行）
const rOneLine = textRules.normalizeRules([{ type: 'launch', min: 1, max: 1, lines: ['只有一行'] }])
const oneLine = textRules.pickLines(rOneLine, { launchCount: 1, diaryCount: 0 })
ok(oneLine[0] === '只有一行' && oneLine[1] === textRules.DEFAULT_LINES[1] && oneLine[2] === textRules.DEFAULT_LINES[2],
  '只填 1 行时，其余行沿用默认文案')

// 顺序敏感：order 小的优先（即使两条都命中）
const rDup = textRules.normalizeRules([
  { order: 20, type: 'launch', min: 1, max: 9, lines: ['后'] },
  { order: 10, type: 'launch', min: 1, max: 9, lines: ['先'] }
])
ok(textRules.pickLines(rDup, { launchCount: 3 })[0] === '先', 'order 小的规则优先命中')

// ============ E. 打开次数 ============
console.log('== E. 打开次数计数 ==')
delete global.wx
textRules.clearCache()
ok(textRules.getLaunchCount() === 1, '无 wx 环境：未计过数视为第 1 次')
ok(textRules.bumpLaunchCount() === 1, '无 wx 环境：首次 bump 得 1（不抛出）')
ok(textRules.getLaunchCount() === 1, 'bump 后读取一致')
ok(textRules.bumpLaunchCount() === 2, '再次 bump 得 2')

global.wx = {
  _s: {},
  getStorageSync(k) { return this._s[k] },
  setStorageSync(k, v) { this._s[k] = v }
}
textRules.clearCache()
ok(textRules.getLaunchCount() === 1, '空存储视为第 1 次')
ok(textRules.bumpLaunchCount() === 1, '首次启动 bump -> 1')
ok(global.wx._s.launchCount === 1, '次数已持久化到 storage')
ok(textRules.bumpLaunchCount() === 2, '第二次启动 -> 2')
ok(global.wx._s.launchCount === 2, '第二次已持久化')

// 脏数据兜底
global.wx._s.launchCount = 'abc'
textRules.clearCache()
ok(textRules.getLaunchCount() === 1, '脏次数回落第 1 次')
global.wx._s.launchCount = -5
textRules.clearCache()
ok(textRules.getLaunchCount() === 1, '负数次数回落第 1 次')

// storage 抛异常不崩
global.wx.setStorageSync = () => { throw new Error('boom') }
textRules.clearCache()
let threwCount = false
try { textRules.bumpLaunchCount() } catch (e) { threwCount = true }
ok(!threwCount, 'storage 写入异常不抛出')

// ============ F. refresh ============
console.log('== F. refresh 云端拉取 ==')
function mockCloud(store) {
  return {
    _s: store,
    getStorageSync(k) { return this._s[k] },
    setStorageSync(k, v) { this._s[k] = v },
    _coll: null,
    _limit: null,
    _req: null,
    cloud: {
      database() {
        return {
          collection(name) {
            global.wx._coll = name
            return {
              limit(n) { global.wx._limit = n; return this },
              get(opt) { global.wx._req = opt; return this }
            }
          }
        }
      }
    }
  }
}

global.wx = mockCloud({})
textRules.clearCache()
ok(textRules.refresh() === true, 'refresh 发起请求')
ok(global.wx._coll === 'text_rules', '请求集合 = text_rules')
ok(global.wx._limit === 20, '单次取数上限 = 20（客户端上限）')
global.wx._req.success({
  data: [
    { _id: 'r1', order: 10, type: 'launch', min: 1, max: 1, lines: ['云1', '云2', '云3'] }
  ]
})
ok(global.wx._s.textRulesCache.length === 1, '云端规则已写入本地缓存')
ok(textRules.getRules().length === 1, '云端规则已进入内存缓存')
ok(textRules.getLines(0)[0] === '云1', '第 1 次打开用云端规则（端到端）')
ok(textRules.getLines(0)[1] === '云2' && textRules.getLines(0)[2] === '云3', '三行全部来自云端')

// 用户的验收场景：第 1 次打开显示云端隐私文案，第 2 次起回落现有文案
global.wx._s.launchCount = 2
textRules.clearCache()
ok(textRules.getLines(0)[0] === textRules.DEFAULT_LINES[0],
  '★ 第 2 次打开：次数规则不命中 → 回落现有文案（用户验收场景）')

// 篇数维度：加一条 diary 规则后按篇数切换
global.wx._s.launchCount = 2
global.wx._s.textRulesCache = [
  { _id: 'a', order: 10, type: 'launch', min: 1, max: 1, lines: ['云1', '云2', '云3'] },
  { _id: 'b', order: 20, type: 'diary', min: 5, max: 999, lines: ['多篇1', '多篇2', '多篇3'] }
]
textRules.clearCache()
ok(textRules.getLines(3)[0] === textRules.DEFAULT_LINES[0], '3 篇：未达 5 篇阈值 → 默认文案')
ok(textRules.getLines(5)[0] === '多篇1', '5 篇：命中篇数规则')
ok(textRules.getLines(999)[0] === '多篇1', '999 篇：max 无上限持续命中')

// 恢复成单条云端规则的缓存，供后续节复用
global.wx._s.textRulesCache = [
  { _id: 'r1', order: 10, type: 'launch', min: 1, max: 1, lines: ['云1', '云2', '云3'] }
]
textRules.clearCache()

// 云端返回空：不覆盖本地缓存
textRules.clearCache()
global.wx._req = null
textRules.refresh()
ok(global.wx._req !== null, 'refresh 再次发起请求')
global.wx._req.success({ data: [] })
ok(global.wx._s.textRulesCache.length === 1, '★ 云端返回空数组不覆盖本地缓存')
ok(textRules.getRules().length === 1, '内存缓存未被清空')

// 云端返回非法记录：整批被丢弃 → 不覆盖缓存
textRules.clearCache()
global.wx._req = null
textRules.refresh()
global.wx._req.success({ data: [{ type: 'oops', lines: ['x'] }] })
ok(global.wx._s.textRulesCache.length === 1, '云端全非法记录时保留原缓存')

// fail 回调静默
textRules.clearCache()
global.wx._req = null
textRules.refresh()
let threwFail = false
try { global.wx._req.fail({ errMsg: 'collection not exists' }) } catch (e) { threwFail = true }
ok(!threwFail, 'fail 回调静默不抛')
ok(textRules.getRules().length === 1, 'fail 后仍可用本地缓存')

// 无 cloud 能力
global.wx = { _s: {}, getStorageSync(k) { return this._s[k] }, setStorageSync(k, v) { this._s[k] = v } }
textRules.clearCache()
ok(textRules.refresh() === false, '无 cloud 能力返回 false 且不抛')

// getLines 在无任何配置时回落默认
delete global.wx
textRules.clearCache()
ok(textRules.getLines(0)[0] === textRules.DEFAULT_LINES[0], '无 wx 环境 getLines 回落默认')

// ============ G. 接入 lint ============
console.log('== G. 接入 lint（防回归）==')
const writeSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'write', 'write.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
const wxmlSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'write', 'write.wxml'), 'utf8')

ok(writeSrc.indexOf("require('../../utils/textRules.js')") !== -1, 'write.js 已接入 textRules')
ok(writeSrc.indexOf('this.applyPlaceholderText()') !== -1, 'write.js onShow 已调用 applyPlaceholderText')
ok(writeSrc.indexOf('textRules.getLines(storage.getStats().total)') !== -1, '篇数取自 storage.getStats().total')
ok(writeSrc.indexOf('placeholderLine1: textRules.DEFAULT_LINES[0]') !== -1, 'data 默认文案单一来源（引用 DEFAULT_LINES）')
ok((writeSrc.match(/applyPlaceholderText/g) || []).length === 2, 'applyPlaceholderText 定义 1 处 + 调用 1 处（无重复插入）')
ok((writeSrc.match(/require\('\.\.\/\.\.\/utils\/textRules\.js'\)/g) || []).length === 1, 'textRules 仅 require 一次')

ok(appSrc.indexOf('textRules.bumpLaunchCount()') !== -1, 'app.js 启动时打开次数 +1')
ok(appSrc.indexOf('textRules.refresh()') !== -1, 'app.js 启动时拉取云端规则')
ok(appSrc.indexOf('initSampleData') === -1, '★ 示例日记插入逻辑已彻底移除（防回归）')
ok(appSrc.indexOf('cleanupSampleDiaries') !== -1, 'app.js 含历史示例日记清理')
ok(appSrc.indexOf('this.cleanupSampleDiaries()') !== -1, 'onLaunch 调用了清理')
ok(appSrc.indexOf('忙碌而充实的一天') !== -1 && appSrc.indexOf('午后随笔') !== -1,
  '清理清单含原始示例标题（严格匹配用）')

ok(wxmlSrc.indexOf('{{placeholderLine1}}') !== -1, 'wxml 第 1 行绑定未变')
ok(wxmlSrc.indexOf('{{placeholderLine2}}') !== -1, 'wxml 第 2 行绑定未变')
ok(wxmlSrc.indexOf('{{placeholderLine3}}') !== -1, 'wxml 第 3 行绑定未变')

// ============ 结果 ============
console.log('')
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
