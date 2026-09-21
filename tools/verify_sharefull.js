// tools/verify_sharefull.js —— 复核：复制全文输出 + 海报最坏几何（canvas 像素上限校核）
const share = require('../utils/share.js')

// —— 用与 share-sheet.js 相同的字体参数估算换行（CJK 单字宽 = 字号）——
const W = 600, PAD = 46, MAXW = W - PAD * 2, FONT = 29, LINEH = 48   // [poster-font v1] 与 share-sheet 同步
function wrapCount(text) {
  const per = Math.floor(MAXW / FONT)
  return Math.ceil(text.length / per)
}

const sample = '今天上班，路上差点撞车，有一个人强行加塞，特别危险。\n\n' +
  '到公司就开始做我的小程序，然后个体工商户申请，遇到点麻烦，说是说啥来着啊？\n\n' +
  '晚上回家煮了面，看了两集纪录片。'.repeat(6)

const diary = {
  createdAt: '2026年9月15日 20:53',
  content: sample,
  moodText: '一般', moodColor: '#8A8F8C', moodBg: 'rgba(138,143,140,0.12)',
  weatherIcon: '⛅', weatherText: '多云 26° · 深圳',
  tags: ['上班', '项目', '感冒'],
  images: ['cloud://a/b1.jpg', 'cloud://a/b2.jpg']
}

const copy = share.buildCopyText(diary)
const pm = share.buildPosterModel(diary, {})

console.log('=== 样本正文 ===')
console.log('  原始字数（含换行）:', sample.length)
console.log('  段落数:', sample.split('\n').filter(Boolean).length)
console.log()
console.log('=== 复制文字（改后）===')
console.log('  总长:', copy.length, '字')
console.log('  含换行:', copy.indexOf('\n') !== -1)
console.log('--- 前 6 行 ---')
copy.split('\n').slice(0, 6).forEach(l => console.log('  | ' + l.slice(0, 44)))
console.log()
console.log('=== 海报正文 ===')
console.log('  摘要长度:', pm.summary.length, '（上限', share.MAX_SUMMARY_LEN, '）')
console.log('  标记截断:', pm.summaryTruncated)
const lines = wrapCount(pm.summary)
console.log('  估算行数:', lines, '（上限', share.MAX_POSTER_LINES, '）')
console.log()
console.log('=== 最坏几何（600 字满额 + 1 张大图 + 码 + 全部模块）===')
const H = PAD + 6 + 56 + 54 + 46 + (12 + 4 * 38 + 16) + (12 + 40 * LINEH + 6) + (8 + 34) + (6 + 52 + 4) + (10 + 420 + 8) + 26 + 112 + 44
console.log('  画布高:', H, 'px（宽 600）')
const MAX_CANVAS_PX = 12e6, MAX_CANVAS_DIM = 8000
;[1, 2, 3].forEach(base => {
  const dpr = Math.max(1, Math.min(base, Math.sqrt(MAX_CANVAS_PX / (W * H)), MAX_CANVAS_DIM / H))
  const cw = Math.floor(W * dpr), ch = Math.floor(H * dpr)
  const px = cw * ch
  console.log('  机型 dpr=' + base + ' → 实际 dpr=' + dpr.toFixed(2) + ' → ' + cw + '×' + ch +
    ' = ' + (px / 1e6).toFixed(2) + 'M 像素  ' + (px > 16.7e6 || ch > 8192 ? '!! 超限' : 'OK'))
})
console.log()
console.log('=== 对照：改造前 150 字（dpr=3）===')
const H150 = PAD + 6 + 56 + 54 + 46 + (12 + 4 * 38 + 16) + (12 + 10 * LINEH + 6) + (6 + 52 + 4) + (10 + 420 + 8) + 26 + 112 + 44
console.log('  画布 1800×' + (H150 * 3) + ' = ' + (1800 * H150 * 3 / 1e6).toFixed(2) + 'M 像素')
