// 天气元素全链路测试：保存格式化 → 文本/Word(.doc)/docx 导出 → 导入还原
const path = require('path')
let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg) }
  else { failed++; console.log('  ✗ ' + msg) }
}

global.wx = {
  _store: {},
  getStorageSync(k) { return this._store[k] },
  setStorageSync(k, v) { this._store[k] = v },
  removeStorageSync(k) { delete this._store[k] },
  getStorageInfoSync() { return { currentSize: 0, limitSize: 10240 } },
  showModal(o) { console.log('  [modal] ' + (o && o.content || '')) }
}
const storage = require(path.join(process.cwd(), 'utils', 'storage.js'))

const W1 = { city: '深圳', temp: 28, text: '晴', icon: '☀️' }
const W2 = { city: '杭州', temp: -2, text: '中雪', icon: '❄️' }
const diaries = [
  { id: 'd1', title: '', mood: 'happy', source: 'manual', tags: ['生活'],
    content: '今天遇到了张三，聊了很久。\n下午去图书馆看书。',
    location: { name: '深圳市图书馆', address: '福田区', latitude: 22.55, longitude: 114.05 },
    media: [], weather: W1, created_at: '2026-07-01T10:00:00.000Z', updated_at: '' },
  { id: 'd2', title: '', mood: 'calm', source: 'auto', tags: [],
    content: '工作例会讨论排期。',
    location: null, media: [], weather: W2, created_at: '2026-08-30T12:00:00.000Z', updated_at: '' },
  { id: 'd3', title: '', mood: '', source: 'manual', tags: [],  // 旧数据：无天气
    content: '旧日记没有天气字段。',
    location: null, media: [], created_at: '2026-08-15T12:00:00.000Z', updated_at: '' }
]

console.log('== 1. 天气文本格式化/解析 ==')
assert(storage.formatWeatherText(W1) === '晴 28° · 深圳', 'formatWeatherText: 晴 28° · 深圳')
assert(storage.formatWeatherText(W2) === '中雪 -2° · 杭州', 'formatWeatherText 负温: 中雪 -2° · 杭州')
assert(storage.formatWeatherText(null) === '', 'formatWeatherText(null) 为空')
let p = storage.parseWeatherText('☀️ 晴 28° · 深圳')
assert(p && p.text === '晴' && p.temp === 28 && p.city === '深圳' && p.icon === '☀️', 'parseWeatherText 带图标+城市')
p = storage.parseWeatherText('中雪 -2°')
assert(p && p.text === '中雪' && p.temp === -2 && !p.city, 'parseWeatherText 负温无城市')
p = storage.parseWeatherText('多云')
assert(p && p.text === '多云', 'parseWeatherText 仅描述')
assert(storage.parseWeatherText('') === null, 'parseWeatherText 空串返回 null')

console.log('== 2. 纯文本导出/导入 ==')
global.wx._store.diaries = diaries
const ex = storage.exportDiariesToText()
assert(ex.text.indexOf('【天气】☀️ 晴 28° · 深圳') !== -1, '文本导出含【天气】行')
assert(ex.text.indexOf('【天气】❄️ 中雪 -2° · 杭州') !== -1, '文本导出含第二篇天气')
const d3block = ex.text.split(/={10,}\s*/m).find(b => b.indexOf('旧日记') !== -1) || ''
assert(d3block.indexOf('【天气】') === -1, '旧数据（无天气）不输出天气行')
const parsed = storage.parseDiariesFromText(ex.text)
assert(parsed.length === 3, '文本导入解析 3 篇')
const pd1 = parsed.find(x => x.content.indexOf('张三') !== -1)
assert(pd1 && pd1.weather && pd1.weather.text === '晴' && pd1.weather.temp === 28 && pd1.weather.city === '深圳' && pd1.weather.icon === '☀️', '文本导入还原天气对象（含图标/温度/城市）')
const pd3 = parsed.find(x => x.content.indexOf('旧日记') !== -1)
assert(pd3 && !pd3.weather, '旧数据导入后无天气字段（不报错）')

console.log('== 3. Word(.doc HTML) 导出/导入 ==')
const html = storage.buildWordHtml(diaries, {}, {})
assert(html.indexOf('天气：☀️ 晴 28° · 深圳') !== -1, 'doc 可见 meta 行含天气')
const fullDoc = storage.parseWordHtml(html)
assert(fullDoc.full === true && fullDoc.diaries.length === 3, 'doc 完整还原 3 篇')
const fd1 = fullDoc.diaries.find(x => x.id === 'd1')
assert(fd1 && fd1.weather && fd1.weather.temp === 28 && fd1.weather.city === '深圳', 'doc 隐藏 JSON 还原天气')
const fd3 = fullDoc.diaries.find(x => x.id === 'd3')
assert(fd3 && !fd3.weather, '旧数据 doc 往返无天气')
// 回退路径：手工剥离隐藏 JSON，模拟文档被编辑过
const stripped = html.replace(/<div class="ai-diary-data"[^>]*>[\s\S]*?<\/div>/g, '')
const fbDoc = storage.parseWordHtml(stripped)
assert(fbDoc.full === false && fbDoc.diaries.length >= 1, 'doc 回退解析出日记')
const fbd1 = fbDoc.diaries.find(x => x.content.indexOf('张三') !== -1)
assert(fbd1 && fbd1.weather && fbd1.weather.text === '晴' && fbd1.weather.city === '深圳', 'doc 回退路径从 meta 行还原天气')

console.log('== 4. docx 导出/导入 ==')
const zipWriter = require(path.join(process.cwd(), 'utils', 'zipWriter.js'))
const docxBuf = storage.buildDocx(diaries, {}, {})
const U8 = new Uint8Array(docxBuf)
assert(U8[0] === 0x50 && U8[1] === 0x4b, 'docx 是合法 zip（PK 头）')
// 用 zipWriter 反解 document.xml（测试环境无 fs.unzip，直接按结构提取）
// docx 的 word/document.xml 为 STORED 或 DEFLATED；zipWriter 只写 STORED，可手工解
// 这里借助 Node zlib 解 inflate（若 deflate）——zipWriter 生成的是 STORED，直接定位读取
function readStoredEntry(buf, name) {
  const u8 = new Uint8Array(buf)
  const dv = new DataView(buf)
  // 找 Local File Header
  let off = 0
  while (off < u8.length - 4) {
    if (u8[off] === 0x50 && u8[off + 1] === 0x4b && u8[off + 2] === 0x03 && u8[off + 3] === 0x04) {
      const nameLen = dv.getUint16(off + 26, true)
      const extraLen = dv.getUint16(off + 28, true)
      const csize = dv.getUint32(off + 18, true)
      const entryName = Buffer.from(u8.slice(off + 30, off + 30 + nameLen)).toString('utf8')
      if (entryName === name) {
        const start = off + 30 + nameLen + extraLen
        return Buffer.from(u8.slice(start, start + csize)).toString('utf8')
      }
      off = off + 30 + nameLen + extraLen + csize
    } else {
      off++
    }
  }
  return null
}
const xml = readStoredEntry(docxBuf, 'word/document.xml')
assert(!!xml, '提取 document.xml 成功')
assert(xml.indexOf('天气：☀️ 晴 28° · 深圳') !== -1, 'docx 可见 meta 行含天气')
const dx = storage.parseDocxXml(xml)
assert(dx.full === true && dx.diaries.length === 3, 'docx 完整还原 3 篇')
const dx1 = dx.diaries.find(x => x.content.indexOf('张三') !== -1)
assert(dx1 && dx1.weather && dx1.weather.text === '晴' && dx1.weather.temp === 28 && dx1.weather.icon === '☀️', 'docx 隐藏 JSON 还原天气对象')
const dx3 = dx.diaries.find(x => x.content.indexOf('旧日记') !== -1)
assert(dx3 && !dx3.weather, '旧数据 docx 往返无天气')
// 回退路径：去掉 vanish 隐藏段，模拟被编辑
const strippedXml = xml.replace(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:vanish[\s\S]*?<\/w:p>/g, '')
const fbx = storage.parseDocxXml(strippedXml)
assert(fbx.full === false && fbx.diaries.length >= 2, 'docx 回退解析出日记')
const fbdx1 = fbx.diaries.find(x => x.content.indexOf('张三') !== -1)
assert(fbdx1 && fbdx1.weather && fbdx1.weather.text === '晴' && fbdx1.weather.city === '深圳', 'docx 回退路径从合并 meta 行还原天气（心情|天气|标签 同行）')
const fbdx2 = fbx.diaries.find(x => x.content.indexOf('工作例会') !== -1)
assert(fbdx2 && fbdx2.weather && fbdx2.weather.temp === -2, 'docx 回退路径还原负温')

console.log('== 5. AI 识别导入 ==')
const ai = storage.buildDiaryFromAI({ content: 'AI 识别的内容', date: '2026-08-20', mood: '开心', weather: '☀️ 晴 30° · 北京' })
assert(ai.weather && ai.weather.city === '北京' && ai.weather.temp === 30, 'AI 识别结果 weather 字段还原')
const ai2 = storage.buildDiaryFromAI({ content: '无天气' })
assert(!ai2.weather, 'AI 识别无 weather 不报错')

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败')
process.exit(failed ? 1 : 0)
