# -*- coding: utf-8 -*-
"""
patch_tag_fit.py — [tag-fit v1] 日记本列表「心情 + 标签」最多两行 + 日期文案缩短

用户 2026-09-22 拍板：方案 3 + 日期文案缩短（「8月12日 周三」→「8/12 周三」）
  1. 日期**保持横排**（不竖排），只把**列表卡片**的日期文案缩短以腾横向宽度；
  2. 标签只在「估算会溢出到第三行」时才动手：从**末尾**丢标签，丢到剩余能保证两行；
  3. 平时（≤2 行）一个都不丢；**保底留 1 个**；
  4. 只改列表展示 —— 存储 / 详情页 / 导出 / 备份 零改动（d.tags 仍是完整数据）。

宽度实测口径（rpx）：视口 750 − 列表 padding 24×2 − 卡片 padding(36+32) = 634 卡片内宽；
  日期「8/12 周三」约占 108 ⇒ 无心情可用 526、有心情（2 字 pill + 24 间距）可用 426。
  （缩短前日期约占 150 ⇒ 可用仅 325，这正是用户截图那张卡溢出的原因。）

用法：
  python patch_tag_fit.py --check          # 预检（唯一锚点 + 幂等判据）
  python patch_tag_fit.py --write          # 落盘（先备份）
  python patch_tag_fit.py --restore-src    # 仅还原源码（保留新建文件）
  python patch_tag_fit.py --restore        # 全部还原（含删除新建文件）
"""
import io
import os
import sys
import shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\tag-fit-backup-20260922'

CRLF = chr(13) + chr(10)
LF = chr(10)

# ============================================================
# 新文件（整份写入）
# ============================================================
NEW_TAGFIT = """/**
 * utils/tagFit.js
 * [tag-fit v1] 日记本列表卡片「心情 + 标签」两行自适应。
 *
 * 背景：.tag-list 是 flex-wrap 且行数无上限，标签一多一长就撑到三行，
 *   把 .diary-card-footer（align-items:center）的日期挤到卡片中间，卡片也被撑高。
 *
 * 口径（用户拍板 · 方案 3）：
 *   - 只在「估算会溢出到第三行」时才动手；平时一行就一行，一个都不丢；
 *   - 溢出时从**末尾**丢标签，直到剩余能保证两行；
 *   - **保底留 1 个**（单 chip 是 nowrap + ellipsis，最多占一行，天然安全）；
 *   - 日期保持横排不竖排，宽度靠「8/12 周三」这种紧凑文案腾出来。
 *
 * 纯函数、不依赖 wx、不逐卡测量：宽度用静态估算，系数刻意**偏保守**
 * （宁可多丢一个，也不能漏成三行）。样式改了必须同步本文件的宽度常量。
 */

// 宽度口径（rpx）—— 与 pages/index/index.wxss 的盒模型一一对应
const W = {
  viewport: 750,
  listPadX: 24,      // .diary-list   padding 左右
  cardPadL: 36,      // .diary-card   padding-left
  cardPadR: 32,      // .diary-card   padding-right
  dateWidth: 108,    // .diary-date 「8/12 周三」@24rpx（含 letter-spacing 余量）
  moodGapL: 24,      // .tag-list     margin-left
  moodFont: 22,      // .tag-mood     font-size
  moodPadX: 16,      // .tag-mood     padding 左右
  chipFont: 22,      // .tag-item     font-size
  chipPadX: 16,      // .tag-item     padding 左右
  chipBorderX: 2,    // .tag-item     左右边框各 1rpx
  chipGapR: 12,      // .tag-item     margin-right
  asciiRatio: 0.6,   // 数字/字母宽 ≈ 0.6em（中文/全角按 1em）
  safety: 1.06,      // 保守系数
}

const MAX_LINES = 2

// 卡片内容宽 = 750 − 列表左右 padding − 卡片左右 padding = 634rpx
function cardInnerWidth() {
  return W.viewport - W.listPadX * 2 - W.cardPadL - W.cardPadR
}

// 文本估算宽（rpx）：ASCII 按 asciiRatio em、其余按 1em。
// 用 charCodeAt 逐码元判断（不走正则转义），代理对会算 2 个中文宽 ⇒ 偏保守，符合本模块取向。
function textWidth(text, fontRpx) {
  const s = String(text == null ? '' : text)
  let units = 0
  for (let i = 0; i < s.length; i++) {
    units += s.charCodeAt(i) < 256 ? W.asciiRatio : 1
  }
  return units * fontRpx
}

// 单个标签 chip 占宽（含右侧间距）
function chipWidth(tag) {
  return textWidth(tag, W.chipFont) * W.safety + W.chipPadX * 2 + W.chipBorderX + W.chipGapR
}

// 心情 pill 占宽（不含与标签区之间的间距）；无心情返回 0
function moodWidth(moodLabel) {
  const s = String(moodLabel == null ? '' : moodLabel)
  if (!s) return 0
  return textWidth(s, W.moodFont) * W.safety + W.moodPadX * 2
}

// 本卡片「标签区」可用宽（rpx）
function availWidth(moodLabel) {
  let avail = cardInnerWidth() - W.dateWidth
  const mw = moodWidth(moodLabel)
  if (mw > 0) avail -= mw + W.moodGapL
  return avail
}

// 贪心装箱估算行数；末尾 chip 也计一次间距 ⇒ 偏保守
function estimateLines(tags, avail) {
  if (!tags || !tags.length) return 0
  if (avail <= 0) return tags.length
  let lines = 1
  let cur = 0
  for (let i = 0; i < tags.length; i++) {
    const w = chipWidth(tags[i])
    if (cur === 0) {
      cur = w
    } else if (cur + w <= avail) {
      cur += w
    } else {
      lines += 1
      cur = w
    }
  }
  return lines
}

/**
 * 列表卡片标签自适应：估算溢出到第 3 行时，从末尾丢到能保证两行（保底留 1 个）。
 * @param {string[]} tags      标签数组（列表侧最多 5 个）
 * @param {string}   moodLabel 心情文案（'' 表示本卡无心情 pill）
 * @return {{shown: string[], dropped: number, lines: number}}
 */
function fitTags(tags, moodLabel) {
  // 过滤空串与纯空白标签（trim 覆盖半角/全角空格）—— 它们白占宽度却看不见
  const list = (Array.isArray(tags) ? tags : []).filter(function (t) {
    return String(t == null ? '' : t).trim() !== ''
  })
  const out = { shown: list, dropped: 0, lines: 0 }
  if (!list.length) return out
  const avail = availWidth(moodLabel)
  out.lines = estimateLines(list, avail)
  if (out.lines <= MAX_LINES) return out
  let n = list.length
  while (n > 1 && estimateLines(list.slice(0, n), avail) > MAX_LINES) {
    n -= 1
  }
  out.shown = list.slice(0, n)
  out.dropped = list.length - n
  out.lines = estimateLines(out.shown, avail)
  return out
}

module.exports = {
  fitTags: fitTags,
  estimateLines: estimateLines,
  availWidth: availWidth,
  chipWidth: chipWidth,
  moodWidth: moodWidth,
  cardInnerWidth: cardInnerWidth,
  textWidth: textWidth,
  WIDTHS: W,
  MAX_LINES: MAX_LINES,
}
"""

# ============================================================
# 已有文件的锚点操作（按文件分组，同文件内串行）
# ============================================================
OPS = [
    # ---------------- utils/util.js ----------------
    ('utils/util.js', {
        'tag': 'A1 新增 formatCompactDate（紧邻 formatDate 之后）',
        'sig': 'function formatCompactDate(dateStr) {',
        'old': """  return month + '月' + day + '日 周' + weekDays[d.getDay()]
}
""",
        'new': """  return month + '月' + day + '日 周' + weekDays[d.getDay()]
}

// 紧凑日期 [list-date-compact v1] — 「8/14 周五」。仅供日记本列表卡片使用（省横向宽度给标签），
// 其他调用点（备份 / 我的 / 导出 / 分享）仍走 formatDate 的「8月14日 周五」，互不影响。
function formatCompactDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  return month + '/' + day + ' 周' + weekDays[d.getDay()]
}
""",
    }),
    ('utils/util.js', {
        'tag': 'A2 formatRelativeTime 增加 compact 参数',
        'sig': 'function formatRelativeTime(dateStr, compact) {',
        'old': """function formatRelativeTime(dateStr) {
""",
        'new': """// compact=true ⇒ 超过 7 天的档位改用紧凑日期「8/14 周五」（仅日记本列表卡片传 true）
function formatRelativeTime(dateStr, compact) {
""",
    }),
    ('utils/util.js', {
        'tag': 'A3 末档按 compact 分流',
        'sig': 'return compact ? formatCompactDate(dateStr) : formatDate(dateStr)',
        'old': """  if (days < 7) return days + '天前'
  return formatDate(dateStr)
""",
        'new': """  if (days < 7) return days + '天前'
  // [list-date-compact v1] 不传 compact 时行为与改动前完全一致（其他页面零影响）
  return compact ? formatCompactDate(dateStr) : formatDate(dateStr)
""",
    }),
    ('utils/util.js', {
        'tag': 'A4 导出 formatCompactDate',
        'sig': """  formatCompactDate,
""",
        'old': """  formatRelativeTime,
""",
        'new': """  formatRelativeTime,
  formatCompactDate,
""",
    }),

    # ---------------- pages/index/index.js ----------------
    ('pages/index/index.js', {
        'tag': 'B1 引入 tagFit',
        'sig': "const tagFit = require('../../utils/tagFit.js')",
        'old': """const appInfo = require('../../utils/appInfo.js')
""",
        'new': """const appInfo = require('../../utils/appInfo.js')
const tagFit = require('../../utils/tagFit.js') // [tag-fit v1] 列表标签两行自适应
""",
    }),
    ('pages/index/index.js', {
        'tag': 'B2 列表卡片改用紧凑日期',
        'sig': 'util.formatRelativeTime(d.created_at, true)',
        'old': """      d.dateText = util.formatRelativeTime(d.created_at)
""",
        'new': """      // [list-date-compact v1] 列表卡片用紧凑日期「8/12 周三」腾宽度；他处仍走完整格式
      d.dateText = util.formatRelativeTime(d.created_at, true)
""",
    }),
    ('pages/index/index.js', {
        'tag': 'B3 产出 tagsShown（只改展示）',
        'sig': 'd.tagsShown = tagFit.fitTags(d.tags, d.moodText).shown',
        'old': """      d.tags = Array.isArray(d.tags) ? d.tags.slice(0, 5) : []
""",
        'new': """      d.tags = Array.isArray(d.tags) ? d.tags.slice(0, 5) : []
      // [tag-fit v1] 卡片标签最多两行：估算溢出时从末尾丢（保底留 1 个）。
      // 只改展示 —— d.tags 仍是完整数据，搜索 / 详情页 / 导出 / 备份不受影响
      d.tagsShown = tagFit.fitTags(d.tags, d.moodText).shown
""",
    }),

    # ---------------- pages/index/index.wxml ----------------
    ('pages/index/index.wxml', {
        'tag': 'C1 标签区判空改用 tagsShown',
        'sig': 'item.tagsShown.length > 0',
        'old': """            <view class="tag-list" wx:if="{{item.tags.length > 0}}">
""",
        'new': """            <view class="tag-list" wx:if="{{item.tagsShown.length > 0}}">
""",
    }),
    ('pages/index/index.wxml', {
        'tag': 'C2 列表渲染 tagsShown',
        'sig': """wx:for="{{item.tagsShown}}" """,
        'old': """              <text class="tag-item" wx:for="{{item.tags}}" wx:for-item="tag" wx:key="*this">{{tag}}</text>
""",
        'new': """              <text class="tag-item" wx:for="{{item.tagsShown}}" wx:for-item="tag" wx:key="*this">{{tag}}</text>
""",
    }),
]


def load(rel):
    p = os.path.join(ROOT, rel)
    with io.open(p, 'rb') as f:
        raw = f.read().decode('utf-8')
    crlf = CRLF in raw
    text = raw.replace(CRLF, LF)
    return raw, text, crlf


def save(rel, text, crlf):
    p = os.path.join(ROOT, rel)
    out = text.replace(LF, CRLF) if crlf else text
    with io.open(p, 'wb') as f:
        f.write(out.encode('utf-8'))


def do_backup(rel):
    src = os.path.join(ROOT, rel)
    dst = os.path.join(BACKUP, rel.replace('/', os.sep))
    d = os.path.dirname(dst)
    if not os.path.isdir(d):
        os.makedirs(d)
    shutil.copy2(src, dst)


def new_file_state(rel, content):
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p):
        return 'PENDING'
    with io.open(p, 'rb') as f:
        cur = f.read().decode('utf-8')
    return 'SKIP' if cur.replace(CRLF, LF) == content else 'ERR_NEW_DIFF'


def run(mode):
    do_write = (mode == '--write')
    counts = {'OK': 0, 'SKIP': 0, 'PENDING': 0, 'ERR': 0}
    cache = {}

    for rel, op in OPS:
        if rel not in cache:
            raw, text, crlf = load(rel)
            cache[rel] = {'text': text, 'crlf': crlf, 'dirty': False}
        ent = cache[rel]
        text = ent['text']
        sig = op['sig']
        old = op['old']
        if sig in text:
            st = 'SKIP'
        else:
            n = text.count(old)
            if n == 1:
                ent['text'] = text.replace(old, op['new'], 1)
                ent['dirty'] = True
                st = 'OK'
            elif n == 0:
                st = 'ERR_ANCHOR_MISSING'
            else:
                st = 'ERR_ANCHOR_DUP(%d)' % n
        key = 'ERR' if st.startswith('ERR') else st
        counts[key] += 1
        print('[%s] %s -> %s' % (mode, rel + ' :: ' + op['tag'], st))

    # 新文件
    for rel, content in [('utils/tagFit.js', NEW_TAGFIT)]:
        st = new_file_state(rel, content)
        if st == 'PENDING' and do_write:
            p = os.path.join(ROOT, rel)
            if not os.path.isdir(os.path.dirname(p)):
                os.makedirs(os.path.dirname(p))
            with io.open(p, 'wb') as f:
                f.write(content.replace(LF, CRLF).encode('utf-8'))
            st = 'OK'
        key = 'ERR' if st.startswith('ERR') else st
        counts[key] += 1
        print('[%s] %s -> %s' % (mode, rel + ' :: 新增模块', st))

    # 写盘（每文件只在全部 op 处理完后写一次）
    if do_write:
        for rel, ent in cache.items():
            if ent['dirty']:
                do_backup(rel)
                save(rel, ent['text'], ent['crlf'])
                print('[write] %s 已落盘（已备份到 %s）' % (rel, BACKUP))

    print('RESULT: OK=%d SKIP=%d PENDING=%d ERR=%d' % (
        counts['OK'], counts['SKIP'], counts['PENDING'], counts['ERR']))
    return 1 if counts['ERR'] else 0


def restore(include_new):
    files = sorted(set([rel for rel, _ in OPS]))
    for rel in files:
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        if not os.path.isfile(src):
            print('[restore] 缺备份 %s' % rel)
            continue
        dst = os.path.join(ROOT, rel)
        shutil.copy2(src, dst)
        print('[restore] %s' % rel)
    if include_new:
        for rel in ['utils/tagFit.js']:
            p = os.path.join(ROOT, rel)
            if os.path.isfile(p):
                os.remove(p)
                print('[restore] 删除新建 %s' % rel)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--check':
        sys.exit(run('--check'))
    elif mode == '--write':
        sys.exit(run('--write'))
    elif mode == '--restore-src':
        restore(False)
    elif mode == '--restore':
        restore(True)
    else:
        print('用法: --check | --write | --restore-src | --restore')
