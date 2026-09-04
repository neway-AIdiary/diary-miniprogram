/**
 * 第一步：生成 docx 测试文件
 * 运行：node gen_docx.js
 */
const path = require('path')
const fs = require('fs')
process.chdir(__dirname)
global.wx = { getStorageSync: () => '', setStorageSync: () => {} }
const storage = require(path.join(__dirname, '..', '..', 'utils', 'storage.js'))

const pngB64 = fs.readFileSync('tmp_img.png').toString('base64')
const diaries = [
  {
    id: 'd1', title: '', mood: 'happy', source: 'manual', tags: ['生活', '测试&<标签>'],
    content: '今天遇到了张三，张三是我大学同学"引号"&<标签>测试。\n第二段内容。',
    location: { name: '腾讯滨海大厦', address: '深圳市南山区', latitude: 22.5, longitude: 113.9 },
    media: [
      { type: 'image', fileID: 'cloud://img1.png' },
      { type: 'video', fileID: 'cloud://vid1.mp4', duration: 12.6 }
    ],
    created_at: '2026-07-01T10:00:00.000Z', updated_at: '2026-07-01T10:00:00.000Z'
  },
  {
    id: 'd2', title: '', mood: 'calm', source: 'auto', tags: [],
    content: '另一篇日记，工作例会讨论了新版本排期。',
    location: null, media: [],
    created_at: '2026-08-30T12:00:00.000Z', updated_at: ''
  }
]
const imgBin = { 'cloud://img1.png': { ext: 'png', b64: pngB64 } }
const videoMap = { 'cloud://vid1.mp4': 'https://example.com/v.mp4?sign=abc&x=1' }

// 文件名断言
console.log('文件名:', storage.buildWordFileName(diaries))
const buf = storage.buildDocx(diaries, imgBin, videoMap)
fs.writeFileSync('test.docx', Buffer.from(buf))
const head = Buffer.from(buf.slice(0, 2)).toString('latin1')
console.log('zip 头:', head === 'PK' ? 'PK OK' : 'FAIL: ' + head)
console.log('文件大小:', buf.byteLength, 'bytes')

// zipWriter 单元断言
const zipWriter = require(path.join(__dirname, '..', '..', 'utils', 'zipWriter.js'))
const size = zipWriter.parseImageSize(fs.readFileSync('tmp_img.png'))
console.log('PNG 尺寸解析:', size && size.w === 3 && size.h === 2 ? 'OK 3x2' : 'FAIL ' + JSON.stringify(size))
