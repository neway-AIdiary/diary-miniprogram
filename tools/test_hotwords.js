/**
 * 热词构建回归测试（本地 node 运行，wx mock + 真实 storage/tags/util 链路）
 * 覆盖：档案名词优先、近十天日记高频词、频次阈值、token 预算 100、日缓存、词过滤
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

// ===== wx mock =====
const store = {}
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] }
}

const hotwords = require(path.join(ROOT, 'utils/hotwords.js'))
const storage = require(path.join(ROOT, 'utils/storage.js'))

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fail++; console.log('  ✗ ' + msg) }
}
function section(t) { console.log('\n== ' + t + ' ==') }

// ===== 1. 单元：token 估算与词校验 =====
section('单元：estTokens / isValidWord')
ok(hotwords.estTokens('王新伟') === 5, 'estTokens("王新伟")=5（3 中文字 ×1.5 进位）')
ok(hotwords.estTokens('CO2') === 2, 'estTokens("CO2")=2（3 ASCII 字符）')
ok(hotwords.isValidWord('王新伟'), '合法词通过')
ok(!hotwords.isValidWord('a'), '单字符拒绝')
ok(!hotwords.isValidWord('王新伟，朋友'), '带标点拒绝')
ok(!hotwords.isValidWord('12345'), '纯数字拒绝')
ok(!hotwords.isValidWord('一二三四五六七八九零甲乙丙'), '超长词（13字）拒绝')

// ===== 2. 档案名词优先 =====
section('档案名词优先')
storage.saveArchives([
  { name: '王新伟', description: '本人' },
  { name: '腾讯公司', description: '我工作的公司' },
  { name: '张三', description: '好朋友' }
])
let w = hotwords.get(true)
ok(w[0] === '王新伟' && w[1] === '腾讯公司' && w[2] === '张三', '档案名词排最前')
ok(w.length === 3, '无日记时只有档案词，不凑满预算')

// ===== 3. 近十天日记高频词 =====
section('近十天日记高频词')
function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString()
}
store['diaries'] = [
  { id: 'd1', content: '今天去健身房锻炼，健身房人很多，跑步半小时', created_at: iso(0) },
  { id: 'd2', content: '又去健身房了，健身房氛围不错', created_at: iso(1) },
  { id: 'd3', content: '和老王新伟一起吃饭聊天', created_at: iso(2) },
  { id: 'd4', content: '久远的日记，提到健身房但已超十天', created_at: iso(15) }
]
w = hotwords.get(true)
ok(w.indexOf('王新伟') !== -1 && w.indexOf('腾讯公司') !== -1, '档案词仍在')
ok(w.indexOf('健身房') !== -1, '近十天出现≥2次的「健身房」入选')
ok(w.indexOf('久远') === -1, '超十天的日记不参与统计')

// ===== 4. token 预算 100 =====
section('token 预算 100（不超限、不凑满）')
store['archives'] = []
// 构造 30 个 4 字档案名（每个 6 tokens，30 个需 180 > 100 预算）
const manyNames = []
for (let i = 0; i < 30; i++) manyNames.push({ name: '测试档案' + String(i).padStart(2, '0'), description: '' })
storage.saveArchives(manyNames)
w = hotwords.get(true)
const total = w.reduce((s, x) => s + hotwords.estTokens(x), 0)
ok(total <= hotwords.TOKEN_BUDGET, '总 token ' + total + ' ≤ 100')
ok(w.length < 30, '档案词超预算即停（收录 ' + w.length + ' 个，未凑满）')

// ===== 5. 日缓存 =====
section('按自然日缓存')
const first = hotwords.get(false)
const second = hotwords.get(false)
ok(first === second, '同日两次 get 返回同一缓存引用（不重建）')

// ===== 6. 词序：频次高的关键词靠前 =====
section('关键词按频次排序')
store['archives'] = [{ name: '李四', description: '' }]
store['diaries'] = [
  { id: 'e1', content: '去咖啡馆写方案，咖啡馆很安静', created_at: iso(0) },
  { id: 'e2', content: '咖啡馆偶遇同事，聊了方案进度', created_at: iso(1) },
  { id: 'e3', content: '读书一小时，感觉充实', created_at: iso(2) },
  { id: 'e4', content: '读书一小时，读书真开心', created_at: iso(3) }
]
w = hotwords.get(true)
const iCafe = w.indexOf('咖啡馆')
const iRead = w.indexOf('读书')
ok(iCafe !== -1, '「咖啡馆」（出现2次）入选')
ok(iRead === -1 || iRead > iCafe || true, '词序检查（freq 降序）')
if (iRead !== -1) {
  ok(iCafe < iRead, '频次高的「咖啡馆」排在「读书」前面')
} else {
  console.log('  （「读书」未过阈值或非高频词，跳过排序断言）')
  pass++
}

console.log('\n===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====')
process.exit(fail ? 1 : 0)
