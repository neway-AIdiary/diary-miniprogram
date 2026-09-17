/**
 * docx 档案节回归：全量导出附带档案（文档末尾）+ 导入识别与追加合并
 * 运行：node tools/test_docx_archives.js
 */
const fs = require('fs')
const path = require('path')

// ---- wx mock（内存版存储） ----
const memStore = {}
global.wx = {
  getStorageSync: (k) => (k in memStore ? memStore[k] : ''),
  setStorageSync: (k, v) => { memStore[k] = v },
  getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10 * 1024 })
}
const storage = require(path.join(__dirname, '..', 'utils', 'storage.js'))

let pass = 0, fail = 0
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log((cond ? '  PASS ' : '  FAIL ') + msg) }

// zip 是 store（不压缩）方式打包，document.xml 在 buffer 中是明文 UTF-8，可直接截取
function extractDocumentXml(buf) {
  const s = Buffer.from(buf).toString('utf8')
  const di = s.indexOf('<w:document ')
  if (di < 0) return ''
  const start = s.lastIndexOf('<?xml', di)
  const end = s.indexOf('</w:document>', di)
  if (start < 0 || end < 0) return ''
  return s.slice(start, end + '</w:document>'.length)
}

const diary = {
  id: 'd1', title: '', content: '今天去了海边。', mood: 'happy',
  tags: ['散步'], location: null, media: [], weather: null,
  created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z'
}
const archives = [
  { name: '小明的猫', description: '橘猫，爱吃鱼' },
  { name: '公司', description: '腾讯滨海大厦' }
]

console.log('== 全量导出：文档末尾带档案节 ==')
const buf = storage.buildDocx([diary], {}, {}, archives)
const xml = extractDocumentXml(buf)
ok(xml.length > 100, 'document.xml 可提取（' + xml.length + ' 字）')
ok(xml.indexOf('档案') !== -1, '可见档案标题存在')
ok(xml.indexOf('· 小明的猫：橘猫，爱吃鱼') !== -1, '档案「小明的猫」可见行')
ok(xml.indexOf('· 公司：腾讯滨海大厦') !== -1, '档案「公司」可见行')
ok(xml.indexOf('ai-diary-archives') !== -1, '隐藏档案 JSON 存在')

const round = storage.parseDocxXml(xml)
ok(round.full === true, 'full=true')
ok(round.diaries.length === 1 && round.diaries[0].content === '今天去了海边。', '日记还原且不受档案节影响')
ok(Array.isArray(round.archives) && round.archives.length === 2, '档案解析出 2 条')
ok(round.archives[0].name === '小明的猫' && round.archives[0].description === '橘猫，爱吃鱼', '档案内容无损（含特殊标点）')
ok(round.archives[1].name === '公司', '档案顺序保持')

console.log('== 导入侧：saveArchives 追加合并 ==')
memStore['archives'] = [{ id: 'a_old', name: '小明的猫', description: '白色', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' }]
const ar = storage.saveArchives(round.archives)
ok(ar.added === 1 && ar.updated === 1, '新增 1 条、合并 1 条（实际 ' + ar.added + '/' + ar.updated + '）')
const saved = storage.getArchives()
const mao = saved.find(a => a.name === '小明的猫')
ok(mao && mao.description.indexOf('白色') !== -1 && mao.description.indexOf('橘猫，爱吃鱼') !== -1, '旧描述保留、新描述追加（' + (mao && mao.description) + '）')
ok(saved.some(a => a.name === '公司'), '新档案入库')

console.log('== 子集导出（不传档案）与旧格式文档 ==')
const buf2 = storage.buildDocx([diary], {}, {})
const xml2 = extractDocumentXml(buf2)
ok(xml2.indexOf('ai-diary-archives') === -1, '不带档案参数时不生成档案节')
ok(xml2.indexOf('· 小明的猫') === -1, '无档案可见行')
const round2 = storage.parseDocxXml(xml2)
ok(Array.isArray(round2.archives) && round2.archives.length === 0, 'roundtrip archives 为空数组')
const round3 = storage.parseDocxXml('<?xml version="1.0"?><w:document xmlns:w="u"><w:body><w:p><w:r><w:t>无隐藏段</w:t></w:r></w:p></w:body></w:document>')
ok(round3.diaries.length === 0 && round3.archives.length === 0, '旧格式/空文档 archives 为空数组')

console.log('== 回退路径：档案节可见行不入正文 ==')
const stripped = xml.replace(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:vanish[\s\S]*?<\/w:p>/g, '')
const p2 = storage.parseDocxXml(stripped)
ok(p2.full === false && p2.diaries.length === 1, '回退解析出 1 篇日记')
const lastContent = p2.diaries[0].content
ok(lastContent.indexOf('档案') === -1, '「档案」标题行不混入正文')
ok(lastContent.indexOf('· 小明的猫') === -1, '「· 名字：描述」行不混入正文')
ok(lastContent.indexOf('今天去了海边') !== -1, '日记正文完整')

console.log('== transfer.js 接线（源码断言） ==')
const transferSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'transfer.js'), 'utf8')
ok(transferSrc.indexOf('isFullExport') !== -1, 'exportToWord 区分全量/子集')
ok(transferSrc.indexOf('storage.getArchives()') !== -1, '全量导出读取档案')
ok(transferSrc.indexOf('storage.buildDocx(list, media.imgBin, media.videoMap, archives)') !== -1, '档案传入 buildDocx')
ok(transferSrc.indexOf('storage.saveArchives(parsed.archives)') !== -1, '导入侧接入 saveArchives')
ok(transferSrc.indexOf('并导入档案') !== -1, '导入完成提示含档案信息')
// 剪贴板导出不应被改动（不含档案逻辑）
ok(transferSrc.indexOf('exportToClipboard') !== -1, '剪贴板导出函数仍在')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
