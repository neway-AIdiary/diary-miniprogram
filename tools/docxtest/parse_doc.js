/**
 * 第三步：解析 document.xml，验证导入往返（完整还原 + 回退路径）
 * 运行：node parse_doc.js
 */
const path = require('path')
const fs = require('fs')
process.chdir(__dirname)
global.wx = { getStorageSync: () => '', setStorageSync: () => {} }
const storage = require(path.join(__dirname, '..', '..', 'utils', 'storage.js'))

let pass = 0, fail = 0
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log((cond ? '  PASS ' : '  FAIL ') + msg) }

const xml = fs.readFileSync('doc.xml', 'utf8')

console.log('== 完整还原（隐藏 JSON） ==')
const parsed = storage.parseDocxXml(xml)
ok(parsed.full === true, 'full=true')
ok(parsed.diaries.length === 2, '解析出 2 篇（实际 ' + parsed.diaries.length + '）')
const d1 = parsed.diaries[0]
ok(d1.id === 'd1', 'id 保留')
ok(d1.content.indexOf('"引号"&<标签>测试') !== -1, '特殊字符往返无损')
ok(d1.content.indexOf('第二段内容') !== -1, '多段落内容完整')
ok(d1.mood === 'happy', '心情还原')
ok(Array.isArray(d1.tags) && d1.tags.length === 2, '标签还原')
ok(d1.media.length === 2 && d1.media[0].fileID === 'cloud://img1.png', '图片 fileID 还原')
ok(d1.media[1].type === 'video' && d1.media[1].fileID === 'cloud://vid1.mp4', '视频 fileID 还原')
ok(d1.location && d1.location.name === '腾讯滨海大厦', '位置还原')
ok(d1.created_at === '2026-07-01T10:00:00.000Z', '时间还原')

console.log('== 回退路径（模拟文档被编辑、隐藏数据丢失） ==')
const visibleOnly = xml.replace(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:vanish[\s\S]*?<\/w:p>/g, '')
const p2 = storage.parseDocxXml(visibleOnly)
ok(p2.full === false, 'full=false')
ok(p2.diaries.length === 2, '回退解析出 2 篇（实际 ' + p2.diaries.length + '）')
ok(p2.diaries.some(d => d.content.indexOf('大学同学') !== -1), '回退内容正确')
ok(p2.diaries.some(d => d.location && d.location.name === '腾讯滨海大厦'), '回退位置还原')
ok(p2.notes.length > 0, '回退带提示说明')

console.log('== 空文件/异常输入 ==')
ok(storage.parseDocxXml('').diaries.length === 0, '空输入安全')
ok(storage.parseDocxXml('<w:body><w:p><w:r><w:t>无日记</w:t></w:r></w:p></w:body>').diaries.length === 0, '无日记内容返回空')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
