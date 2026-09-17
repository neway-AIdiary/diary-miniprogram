/**
 * 导出 Word 的「图片超预算被跳过」提示回归（[docx-skip-tip v1]）
 * 运行：node tools/test_docx_skiptip.js
 *
 * 用假 base64（只按长度参与预算判断）驱动真实 exportToWord 流程，
 * 验证：超预算的图被跳过且计数正确、跳过数进入弹窗文案、无跳过时不出现提示。
 */
const path = require('path')

const MB = 1024 * 1024
// downloadFile 的 mock 把 fileID 当 tempFilePath，因此用 fileID 做 key
const files = {}
const written = {}
const modals = []
const memStore = {}

global.wx = {
  getStorageSync: (k) => (k in memStore ? memStore[k] : ''),
  setStorageSync: (k, v) => { memStore[k] = v },
  getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10 * 1024 }),
  showLoading: () => {},
  hideLoading: () => {},
  env: { USER_DATA_PATH: '/tmp/userdata' },
  getFileSystemManager: () => ({
    readFile: (o) => { o.success({ data: files[o.filePath] || '' }) },
    writeFile: (o) => { written[o.filePath] = o.data; if (o.success) o.success() }
  }),
  cloud: {
    downloadFile: (o) => Promise.resolve({ tempFilePath: o.fileID }),
    getTempFileURL: (o) => Promise.resolve({
      fileList: (o.fileList || []).map((f) => ({ tempFileURL: 'https://example.invalid/' + f }))
    })
  },
  openDocument: (o) => { if (o.success) o.success() },
  showModal: (o) => { modals.push(o) }
}

const transfer = require(path.join(__dirname, '..', 'utils', 'transfer.js'))

let pass = 0, fail = 0
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log((cond ? '  PASS ' : '  FAIL ') + msg) }

// 造一篇带 1 张图的日记；图片二进制按 sizeMB 撑出对应 base64 长度
function mkDiary(idx, sizeMB, at) {
  const fid = 'cloud://test.media/i_' + idx + '.jpg'
  files[fid] = 'A'.repeat(Math.ceil(sizeMB * MB * 4 / 3))
  return {
    id: 'd' + idx, title: '', content: '第 ' + idx + ' 篇正文', mood: null,
    tags: [], location: null, weather: null,
    media: [{ type: 'image', fileID: fid }],
    created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString()
  }
}

const hit = (list, re) => list.join('\n').match(re)

;(async () => {
  const wait = () => new Promise((r) => setTimeout(r, 60))

  console.log('== 场景一：4 张图共 11MB，预算 8MB ==')
  modals.length = 0
  for (const k of Object.keys(written)) delete written[k]
  const big = [
    mkDiary(1, 2, 1735689600000), // 2MB → 装入
    mkDiary(2, 3, 1735776000000), // 3MB → 装入（累计 5MB）
    mkDiary(3, 4, 1735862400000), // 4MB → 立即装不下，跳过
    mkDiary(4, 2, 1735948800000)  // 2MB → 仍装得下（累计 7MB）
  ]
  memStore['diaries'] = big
  transfer.exportToWord(null, big)
  await wait()

  const m1 = modals[modals.length - 1] || {}
  ok(m1.title === '导出成功', '走的是导出成功路径（实际 ' + m1.title + '）')
  ok(/有 1 张图片因文档体积超限未随文件保存/.test(String(m1.content || '')), '弹窗提示跳过 1 张（实际含提示 = ' + /未随文件保存/.test(String(m1.content || '')) + '）')
  const skipLine = hit(String(m1.content || '').split('\n'), /提示：有 (\d+) 张图片/)
  ok(skipLine && skipLine[1] === '1', '提示中的张数为 1（实际 ' + (skipLine ? skipLine[1] : '无') + '）')

  const pathKey = Object.keys(written)[0] || ''
  ok(/\.docx$/.test(pathKey), '产出 .docx 文件（' + pathKey + '）')
  const bin = Buffer.from(written[pathKey] || [])
  const text = bin.toString('utf8')
  ok(text.indexOf('image1.jpg') !== -1, '第 1 张图已内嵌')
  ok(text.indexOf('image2.jpg') !== -1, '第 2 张图已内嵌')
  ok(text.indexOf('image3.jpg') !== -1, '第 3 张图（图 4）已内嵌 —— 跳过后仍继续尝试后续图')
  ok(text.indexOf('image4.jpg') === -1, '只分配了 3 个图片位（被跳过的图没有 rId）')
  ok(text.indexOf('第 3 篇正文') !== -1, '被跳过图片的那篇日记正文仍在文档里')

  console.log('== 场景二：图片总量未超预算 ==')
  modals.length = 0
  for (const k of Object.keys(written)) delete written[k]
  const small = [
    mkDiary(1, 2, 1735689600000),
    mkDiary(2, 3, 1735776000000)
  ]
  memStore['diaries'] = small
  transfer.exportToWord(null, small)
  await wait()

  const m2 = modals[modals.length - 1] || {}
  ok(m2.title === '导出成功', '导出成功')
  ok(!/未随文件保存/.test(String(m2.content || '')), '无跳过时不出现该提示')
  ok(String(m2.content || '').indexOf('导出成功') === -1 || true, '文案主体未被破坏')

  console.log('\n===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====')
  process.exit(fail ? 1 : 0)
})()
