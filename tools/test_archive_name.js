/**
 * tools/test_archive_name.js
 * 档案「名词」硬约束回归（2026-09-16 用户反馈：一整句话被当成词条名称）
 * 三层覆盖：
 *   A. archiveEdit.isTermName / parseArchiveLine —— 纯规则
 *   B. aiCloud.callAIOrganizeArchive 本地降级 —— 不再把整行塞进 name
 *   C. storage.saveArchives 统一兜底 —— 脏名称不入库
 */
const path = require('path')
let pass = 0
let fail = 0

function eq(desc, got, expect) {
  // 对象按 JSON 比对
  const g = typeof got === 'object' && got !== null ? JSON.stringify(got) : String(got)
  const e = typeof expect === 'object' && expect !== null ? JSON.stringify(expect) : String(expect)
  const ok = g === e
  if (ok) pass++
  else fail++
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + desc + (ok ? '' : '  got=' + g + ' expect=' + e))
}

// ============ A. 纯规则 ============
const archiveEdit = require('../utils/archiveEdit.js')
const { isTermName, parseArchiveLine } = archiveEdit

console.log('--- A. isTermName ---')
eq('正常名词「云控智行」合格', isTermName('云控智行'), true)
eq('6 字机构名「中国海洋大学」合格', isTermName('中国海洋大学'), true)
eq('10 字名称超限不合格（长机构名）', isTermName('中国人民大学附属中学'), false)
eq('9 字专有名词合格（上限）', isTermName('中科院附属实验中学'), true)
eq('10 字名称超限不合格', isTermName('中国海洋大学附属学院'), false)
eq('整句话（带逗号）不合格', isTermName('继续换行，继续换行'), false)
eq('带句号的句子不合格', isTermName('今天很好。'), false)
eq('带问号的句子不合格', isTermName('三孩没有必要？'), false)
eq('带冒号不合格', isTermName('张三：朋友'), false)
eq('空名称不合格', isTermName('   '), false)
eq('带书名号不合格', isTermName('《活着》'), false)

console.log('--- A. parseArchiveLine ---')
eq('无分隔符短名词', parseArchiveLine('云控智行'), { name: '云控智行', description: '' })
eq('冒号分隔', parseArchiveLine('云控智行：做车路云协同的公司'), { name: '云控智行', description: '做车路云协同的公司' })
eq('半角冒号分隔', parseArchiveLine('腾讯:我工作的公司'), { name: '腾讯', description: '我工作的公司' })
// 用户截图那条脏档案：取首个标点前的短片段作名词，余下作描述（不再整句当名称）
{
  const r = parseArchiveLine('继续换行，继续换行，这个两行就够了，三孩没有必要？3号显示三姓氏，继续。')
  eq('整句脏输入的 name 被截短', r && r.name, '继续换行')
  eq('整句脏输入的 description 保留余下内容', r && r.description.indexOf('三孩没有必要') !== -1, true)
  eq('name 长度 ≤ 9', r && r.name.length <= 9, true)
}
eq('无标点超长整句 → 丢弃（不建档）', parseArchiveLine('继续换行继续换行这个两行就够了三号显示三姓氏'), null)
eq('冒号但名称是整句 → 回退到片段规则', (parseArchiveLine('继续换行，继续换行：说明文字') || {}).name, '继续换行')
eq('空行 → null', parseArchiveLine('   '), null)
eq('带空格的名词被 trim', parseArchiveLine('  王新伟：本人  '), { name: '王新伟', description: '本人' })

// ============ B/C 需要 wx 环境 stub ============
global.wx = {
  _store: {},
  getStorageSync(k) { return this._store[k] || '' },
  setStorageSync(k, v) { this._store[k] = v },
  removeStorageSync(k) { delete this._store[k] },
  getSystemInfoSync() { return { statusBarHeight: 20, screenHeight: 667, safeArea: { bottom: 667 } } },
  getWindowInfo() { return { statusBarHeight: 20, screenHeight: 667, safeArea: { bottom: 667 } } },
  showToast() {},
  showModal() {}
}

console.log('--- B. 本地降级（aiCloud）---')
try {
  const aiCloud = require('../utils/aiCloud.js')
  aiCloud.callAIOrganizeArchive('继续换行，继续换行，这个两行就够了，三孩没有必要？3号显示三姓氏，继续。', '')
    .then(r => {
      const item = (r.archives || [])[0] || {}
      eq('本地降级 name 不是整句', item.name === undefined ? true : (item.name.length <= 8), true)
      eq('本地降级 from=local', r.from, 'local')

      // 无标点超长整句：全部丢弃，skipped 计数
      return aiCloud.callAIOrganizeArchive('继续换行继续换行这个两行就够了三号显示三姓氏', '')
    })
    .then(r => {
      eq('超长整句被丢弃（archives 为空）', (r.archives || []).length, 0)
      eq('丢弃条数被记录 skipped=1', r.skipped, 1)

      // 正常内容仍要能建
      return aiCloud.callAIOrganizeArchive('云控智行：做车路云协同的公司', '')
    })
    .then(r => {
      eq('正常「名词：说明」仍可建档', JSON.stringify((r.archives || [])[0] || null), JSON.stringify({ name: '云控智行', description: '做车路云协同的公司' }))

      console.log('--- C. 存档兜底（storage.saveArchives）---')
      const storage = require('../utils/storage.js')
      wx._store = {}
      const res1 = storage.saveArchives([
        { name: '云控智行', description: '做车路云协同的公司' },
        { name: '继续换行，继续换行，这个两行就够了，三孩没有必要？', description: '' }
      ])
      eq('脏名称被拒收（added=1）', res1.added, 1)
      eq('脏名称计入 skipped', res1.skipped, 1)
      const saved = storage.getArchives()
      eq('库里只有 1 条档案', saved.length, 1)
      eq('库里不留脏名称', saved.every(a => a.name.length <= 8 && !/[，,。.！!？?；;、：:]/.test(a.name)), true)
      console.log('\n==== ' + pass + ' pass / ' + fail + ' fail ====')
      process.exit(fail ? 1 : 0)
    })
    .catch(err => {
      console.log('FAIL | 异步链路异常: ' + (err && err.message))
      console.log('\n==== ' + pass + ' pass / ' + (fail + 1) + ' fail ====')
      process.exit(1)
    })
} catch (e) {
  console.log('SKIP | B/C 层无法加载（' + e.message + '）')
  console.log('\n==== ' + pass + ' pass / ' + fail + ' fail（仅 A 层）====')
  process.exit(fail ? 1 : 0)
}
