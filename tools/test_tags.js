/**
 * 单元测试：标签质量闸（tagjunk v1）
 *
 * 背景（2026-09-18 报障）：详情页标签出现「一家」「是一」「好的」这类碎片词。
 *   根因 = utils/tags.js 第 2 步「双字滑窗词频兜底」——「是一家…那是一家」→ 一家/是一；
 *   「比较好的 / 挺好的」→ 好的。词频法在中文里必然产出虚词碎片，已整段移除。
 *
 * 本套件锁定：
 *   ① 报障原文两篇不再产出碎片词，且主题词典命中不受影响；
 *   ② 无词典词 / 无专名的正文 → 空数组（宁缺毋滥，不再硬凑）；
 *   ③ 档案专名补位生效（四维图新 / 北汽新能源 / 魏杰 这类才是标签该有的样子）；
 *   ④ 云端返回的标签同样过闸（碎片词不会从云函数溜进来）；
 *   ⑤ 词汇表与兜底代码的静态护栏（防回归 / 防两端常量分叉）。
 */
const path = require('path')
const fs = require('fs')

// wx 桩：storage / aiCloud 依赖（无 cloud 字段 → 走本地降级路径）
const store = {}
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v }
}

const base = path.resolve(__dirname, '..')
const tags = require(path.join(base, 'utils/tags.js'))
const aiCloud = require(path.join(base, 'utils/aiCloud.js'))

let pass = 0, fail = 0
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) { pass++ } else { fail++; console.log('FAIL:', name, '\n  actual:', JSON.stringify(actual), '\n  expect:', JSON.stringify(expect)) }
}

/* ===== 报障原文（截图逐字）===== */
const CASE1 = '四维图新是一家科技公司。北汽新能源是我上一家公司，那是一家非常好的公司，在那里边我有很多好的朋友同事。'
const CASE2 = '四维图形是一家比较好的公司。我来这个公司已经两个月了，这里边的健身房挺好的，我想尽量在这多待一段时间。'

const JUNK = ['一家', '是一', '好的', '是比较', '挺好']

/* ===== 1. 报障用例：碎片词必须消失，词典命中必须保留 ===== */
{
  const t1 = tags.extractTags(CASE1, 5)
  check('tj-1 case1 无「一家」', t1.indexOf('一家') === -1, true)
  check('tj-2 case1 无「是一」', t1.indexOf('是一') === -1, true)
  check('tj-3 case1 无任何碎片词', JUNK.filter(w => t1.indexOf(w) !== -1), [])
  check('tj-4 case1 保留词典命中（同事）', t1.indexOf('同事') !== -1, true)
  check('tj-5 case1 保留词典命中（朋友）', t1.indexOf('朋友') !== -1, true)

  const t2 = tags.extractTags(CASE2, 5)
  check('tj-6 case2 无「好的」', t2.indexOf('好的') === -1, true)
  check('tj-7 case2 保留词典命中（健身）', t2.indexOf('健身') !== -1, true)
  check('tj-8 case2 不再收录「公司」（非词典非专名）', t2.indexOf('公司') === -1, true)
}

/* ===== 2. 宁可没有：无词典词、无专名 → 空数组 ===== */
{
  check('tj-9 无主题 → 空数组', tags.extractTags('我把那些东西放在桌子上面了。', 5), [])
  check('tj-10 空文本 → 空数组', tags.extractTags('', 5), [])
  check('tj-11 非字符串 → 空数组', tags.extractTags(null, 5), [])
}

/* ===== 3. 档案专名补位 ===== */
{
  const withNames = tags.extractTags(CASE1, 5, ['四维图新', '北汽新能源', '魏杰'])
  check('tj-12 专名入标签（四维图新）', withNames.indexOf('四维图新') !== -1, true)
  check('tj-13 专名入标签（北汽新能源）', withNames.indexOf('北汽新能源') !== -1, true)
  check('tj-14 正文未提到的专名不收（魏杰）', withNames.indexOf('魏杰') === -1, true)
  check('tj-15 专名不挤掉词典命中', withNames.indexOf('同事') !== -1, true)
  check('tj-16 专名同样过质量闸', tags.extractTags('我们的这个东西很好', 5, ['我们', '这个']), [])
  check('tj-16b 心情词「难过」不被尾字规则误伤', tags.isMeaningfulTag('难过'), true)
  check('tj-17 专名去重', tags.extractTags('健身和健身', 5, ['健身']), ['健身'])
  check('tj-18 max 生效', tags.extractTags(CASE1, 2, ['四维图新']).length, 2)
  check('tj-19 缺省 max=5 上限', tags.extractTags(CASE1, undefined, ['四维图新']).length <= 5, true)
}

/* ===== 4. isMeaningfulTag 本体 ===== */
{
  const junk = ['一家', '是一', '好的', '这个', '我们', '时候', '可以', '真的', '感觉', '来了', '在的']
  check('tj-20 碎片/虚词一律拒绝', junk.filter(w => tags.isMeaningfulTag(w)), [])
  const good = ['健身', '同事', '朋友', '四维图新', '北汽新能源', '魏杰', '云南白药', 'OKR']
  check('tj-21 实义词/专名放行', good.filter(w => !tags.isMeaningfulTag(w)), [])
  check('tj-22 单字拒绝', tags.isMeaningfulTag('家'), false)
  check('tj-23 超长拒绝', tags.isMeaningfulTag('中科院附属实验中学'), false)
  check('tj-24 带标点拒绝', tags.isMeaningfulTag('健身，'), false)
  // 主题词典是白名单，必须全部通过质量闸（防将来新增词被闸门误杀）
  const topicWords = (() => {
    const src = fs.readFileSync(path.join(base, 'utils/tags.js'), 'utf8')
    const m = src.match(/const TOPIC_WORDS = \[([\s\S]*?)\]/)
    if (!m) return null
    try { return new Function('return [' + m[1] + ']')() } catch (e) { return null }
  })()
  check('tj-25 主题词典可解析', Array.isArray(topicWords) && topicWords.length > 50, true)
  check('tj-26 主题词典全部通过质量闸', (topicWords || []).filter(w => !tags.isMeaningfulTag(w)), [])
}

/* ===== 5. 真实入口：保存后打标签（本地降级路径）===== */
const ARCHIVE_KEY = 'archives'
const runEntry = () => {
  delete store[ARCHIVE_KEY]
  return aiCloud.callAITags(CASE1, '一般').then(r1 => {
    check('tj-27 入口 from=local', r1.from, 'local')
    check('tj-28 入口无碎片词', JUNK.filter(w => (r1.tags || []).indexOf(w) !== -1), [])
    store[ARCHIVE_KEY] = [
      { name: '四维图新', description: '一家科技公司' },
      { name: '北汽新能源', description: '我上一家公司' }
    ]
    return aiCloud.callAITags(CASE1, '一般')
  }).then(r2 => {
    check('tj-29 入口带档案专名', (r2.tags || []).indexOf('四维图新') !== -1, true)
    check('tj-30 入口带档案专名2', (r2.tags || []).indexOf('北汽新能源') !== -1, true)
    check('tj-31 入口仍无碎片词', JUNK.filter(w => (r2.tags || []).indexOf(w) !== -1), [])
    delete store[ARCHIVE_KEY]
    return aiCloud.callAITags(CASE2, '一般')
  }).then(r3 => {
    check('tj-32 case2 入口无「好的」', (r3.tags || []).indexOf('好的') === -1, true)
    check('tj-33 case2 入口含「健身」', (r3.tags || []).indexOf('健身') !== -1, true)
  })
}

/* ===== 6. 静态护栏 ===== */
function staticGuards() {
  const utilSrc = fs.readFileSync(path.join(base, 'utils/aiCloud.js'), 'utf8')
  const tagSrc = fs.readFileSync(path.join(base, 'utils/tags.js'), 'utf8')
  const fnSrc = fs.readFileSync(path.join(base, 'cloudfunctions/optimizeDiary/index.js'), 'utf8')

  // 6a 词频兜底已彻底移除（防有人「顺手加回来」）
  check('tj-34 tags.js 已删除词频兜底(substr 滑窗)', tagSrc.indexOf('substr(i, 2)') === -1, true)
  check('tj-35 tags.js 已删除词频兜底(freq 统计)', tagSrc.indexOf('freq[w2]') === -1, true)

  // 6b extractTags 只允许被 localTags 调用（保证档案专名一定被带上）
  const callCnt = (utilSrc.match(/tagsEngine\.extractTags\(/g) || []).length
  check('tj-36 extractTags 仅 1 处调用（在 localTags 内）', callCnt, 1)
  check('tj-37 localTags 至少 5 处调用', (utilSrc.match(/localTags\(/g) || []).length >= 5, true)
  check('tj-38 localTags 读取档案', utilSrc.indexOf('storage.getArchives()') !== -1, true)

  // 6c 云端标签也过闸
  check('tj-39 云端标签过滤', utilSrc.indexOf('tagsEngine.isMeaningfulTag(t)') !== -1, true)

  // 6d 云函数：prompt 约束 + 服务端过滤
  check('tj-40 云函数 prompt 禁虚词', fnSrc.indexOf('严禁输出虚词') !== -1, true)
  check('tj-41 云函数 tags 清洗过闸', fnSrc.indexOf('isMeaningfulTag(t) && !seen.has(t)') !== -1, true)
  check('tj-42 云函数批量清洗过闸', fnSrc.indexOf('.filter(t => t && isMeaningfulTag(t))') !== -1, true)

  // 6e 两端词表逐字一致（防分叉）
  const strConst = (src, key) => {
    const m = src.match(new RegExp(key + "\\s*=\\s*'([^']*)'"))
    return m ? m[1] : 'MISSING'
  }
  const arrConst = (src, key) => {
    const m = src.match(new RegExp(key + '\\s*=\\s*\\[([^\\]]*)\\]'))
    return m ? m[1].replace(/[\s']/g, '') : 'MISSING'
  }
  check('tj-43 首字停用表两端一致',
    strConst(tagSrc, 'TAG_HEAD_STOP_CHARS') === strConst(fnSrc, 'TAG_HEAD_STOP_CHARS') &&
    strConst(tagSrc, 'TAG_HEAD_STOP_CHARS') !== 'MISSING', true)
  check('tj-44 尾字停用表两端一致',
    strConst(tagSrc, 'TAG_TAIL_STOP_CHARS') === strConst(fnSrc, 'TAG_TAIL_STOP_CHARS') &&
    strConst(tagSrc, 'TAG_TAIL_STOP_CHARS') !== 'MISSING', true)
  check('tj-45 碎片词表两端一致',
    arrConst(tagSrc, 'TAG_JUNK_WORDS') === arrConst(fnSrc, 'TAG_JUNK_WORDS') &&
    arrConst(tagSrc, 'TAG_JUNK_WORDS') !== 'MISSING', true)
}

runEntry().then(() => {
  staticGuards()
  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
  process.exit(fail > 0 ? 1 : 0)
}).catch(err => {
  fail++
  console.log('FAIL: tj-入口调用异常', err && err.stack || err)
  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')
  process.exit(1)
})
