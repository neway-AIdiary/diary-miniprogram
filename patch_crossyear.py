# -*- coding: utf-8 -*-
"""
[cross-year v1] 跨年场景修复（2026-09-24）—— 严格限定「只在跨年时生效，同年内行为一字不变」

用户拍板：1.2.3 只修有跨年情况的，同一年内不用修。

① [streak-uncap v1]  utils/storage.js  calculateStreak 去掉 365 硬封顶
   —— 连续记录跨过一整年时结果被钉死在 365；改为按「距最早日记的天数」定上限。
   同年内数据跨度必然 < 365，循环照旧遇空档 break ⇒ 非跨年场景结果与旧版逐字一致。

② [date-year v1] 跨年后日期文案补年份（只在「条目不在今年」时生效）
   - utils/util.js   formatCompactDate：列表卡片「8/14 周五」→ 跨年「2026/12/20 周六」
   - utils/util.js   新增 isCrossYearDate（供 index / tagFit 共用）
   - utils/tagFit.js 新增跨年日期宽度档 dateWidthCrossYear=210 + fitTags 第三参 dateW
   - pages/index/index.js  传跨年宽度给标签自适应（否则估 2 行、实排 3 行）
   - utils/dateRange.js    rangeText(custom)：起止跨年时两端都带年份

③ 缺年推断口径（parseCnDate vs looseImport.inferNoYearDate）：穷举 28470 组合，
   6013 处分歧**全部**落在「月日与今天同年」的场景，跨年界场景两套完全一致 ⇒ 按用户口径不动。

用法：--check / --write / --restore
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\cross-year-backup-20260924'

STORAGE = r'utils\storage.js'
UTIL = r'utils\util.js'
TAGFIT = r'utils\tagFit.js'
DATEPICK = r'utils\dateRange.js'
INDEX = r'pages\index\index.js'
T_TAGFIT = r'tools\test_tag_fit.js'
T_DATERANGE = r'tools\test_date_range.js'

# ---- ① streak 去封顶 -------------------------------------------------------
A_OLD = "  let streak = 0\n  const today = new Date()\n  for (let i = 0; i < 365; i++) {"
A_NEW = """  let streak = 0
  const today = new Date()
  // [streak-uncap v1] 旧上限 365 把「连续记录满一年」的结果永久钉死在 365（第 366 天不再增长）。
  // 上限改为「距最早一篇日记的天数 + 1」：同年内数据跨度必然小于 365，循环照旧遇到空档即 break，
  // 所以非跨年场景与旧版逐字一致，只有跨年连续记录才会用上新上限。
  let oldest = today.getTime()
  list.forEach(d => {
    const t = new Date(d.created_at).getTime()
    if (!isNaN(t) && t < oldest) oldest = t
  })
  const span = Math.max(1, Math.ceil((today.getTime() - oldest) / 86400000) + 1)
  for (let i = 0; i < span; i++) {"""
A_GUARD = "[streak-uncap v1]"

# ---- ② formatCompactDate 跨年补年份 ---------------------------------------
B_OLD = """function formatCompactDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  return month + '/' + day + ' 周' + weekDays[d.getDay()]
}"""
B_NEW = """function formatCompactDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  // [date-year v1] 跨年补年份：条目不在今年时「8/14 周五」与今年的同月日分不出
  //（2027 年回看 2026-12-20 会误读成今年 12 月）。同年内保持原样，零视觉变化。
  return (isCrossYearDate(dateStr) ? d.getFullYear() + '/' : '') +
    month + '/' + day + ' 周' + weekDays[d.getDay()]
}

// [date-year v1] 条目日期是否跨年（年份 ≠ 当前年）；空值 / 非法日期一律 false
function isCrossYearDate(dateStr) {
  if (!dateStr) return false
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return false
  return d.getFullYear() !== new Date().getFullYear()
}"""
B_GUARD = "return (isCrossYearDate(dateStr) ? d.getFullYear() + '/' : '') +"

# ---- ② util exports --------------------------------------------------------
C_OLD = "  formatCompactDate,\n  getDefaultTitle,"
C_NEW = "  formatCompactDate,\n  isCrossYearDate,\n  getDefaultTitle,"
C_GUARD = "  formatCompactDate,\n  isCrossYearDate,"

# ---- ② tagFit: 宽度档 ------------------------------------------------------
D1_OLD = "  dateWidth: 108,    // .diary-date 「8/12 周三」@24rpx（含 letter-spacing 余量）"
D1_NEW = ("  dateWidth: 108,    // .diary-date 「8/12 周三」@24rpx（含 letter-spacing 余量）\n"
          "  dateWidthCrossYear: 210, // [date-year v1] .diary-date 跨年档「2026/12/20 周六」@24rpx（含余量）")
D1_GUARD = "dateWidthCrossYear: 210"

# ---- ② tagFit: availWidth 支持传入日期宽 -----------------------------------
D2_OLD = "function availWidth(moodLabel) {\n  let avail = cardInnerWidth() - W.dateWidth"
D2_NEW = ("function availWidth(moodLabel, dateW) {\n"
          "  // [date-year v1] dateW 省略（0/undefined）⇒ 沿用同年档常量，既有调用与断言零变化\n"
          "  let avail = cardInnerWidth() - (dateW > 0 ? dateW : W.dateWidth)")
D2_GUARD = "(dateW > 0 ? dateW : W.dateWidth)"

# ---- ② tagFit: fitTags 第三参 ----------------------------------------------
D3_OLD = "function fitTags(tags, moodLabel) {"
D3_NEW = "function fitTags(tags, moodLabel, dateW) {"
D3_GUARD = "function fitTags(tags, moodLabel, dateW) {"

D4_OLD = "  const avail = availWidth(moodLabel)\n"
D4_NEW = "  const avail = availWidth(moodLabel, dateW)\n"
D4_GUARD = "const avail = availWidth(moodLabel, dateW)"

# ---- ② tagFit: JSDoc ------------------------------------------------------
D5_OLD = " * @param {string}   moodLabel 心情文案（'' 表示本卡无心情 pill）"
D5_NEW = (" * @param {string}   moodLabel 心情文案（'' 表示本卡无心情 pill）\n"
          " * @param {number}   [dateW]   本卡日期文案占宽（rpx）；省略 ⇒ 同年档 W.dateWidth；\n"
          " *                            跨年档（带年份的紧凑日期）传 W.dateWidthCrossYear [date-year v1]")
D5_GUARD = "[dateW]   本卡日期文案占宽"

# ---- ② index.js: 传跨年宽度 ------------------------------------------------
E_OLD = "      d.tagsShown = tagFit.fitTags(d.tags, d.moodText).shown"
E_NEW = ("      // [date-year v1] 跨年（条目不在今年）时日期文案变长「2026/12/20 周六」，\n"
         "      // 标签可用宽度相应收窄，否则估 2 行、实排 3 行（tag-fit 的初衷被破坏）\n"
         "      d.tagsShown = tagFit.fitTags(d.tags, d.moodText,\n"
         "        util.isCrossYearDate(d.created_at) ? tagFit.WIDTHS.dateWidthCrossYear : 0).shown")
E_GUARD = "util.isCrossYearDate(d.created_at) ? tagFit.WIDTHS.dateWidthCrossYear : 0"

# ---- ② dateRange.rangeText 跨年两端带年份 ----------------------------------
F_OLD = """  if (range === 'custom') {
    const cn = s => {
      const d = new Date(s + 'T00:00:00')
      return isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '月' + d.getDate() + '日'
    }
    const a = cn(customStart)
    const b = cn(customEnd)
    return (a && b) ? a + ' 至 ' + b : '所选时间段'
  }"""
F_NEW = """  if (range === 'custom') {
    // [date-year v1] 起止跨年时两端都带年份：否则「12月20日 至 1月5日」与同年区间同形，
    // 看不出实际跨了年（2025-12-20 ~ 2026-01-05）。同年内保持原样。
    const dt = s => {
      const d = new Date(s + 'T00:00:00')
      return isNaN(d.getTime()) ? null : d
    }
    const d1 = dt(customStart)
    const d2 = dt(customEnd)
    const withYear = !!(d1 && d2 && d1.getFullYear() !== d2.getFullYear())
    const cn = d => {
      if (!d) return ''
      return (withYear ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日'
    }
    const a = cn(d1)
    const b = cn(d2)
    return (a && b) ? a + ' 至 ' + b : '所选时间段'
  }"""
F_GUARD = "const withYear = !!(d1 && d2 && d1.getFullYear() !== d2.getFullYear())"

# ---- 测试同步 --------------------------------------------------------------
G1_OLD = "ok(idxJs.indexOf('d.tagsShown = tagFit.fitTags(d.tags, d.moodText).shown') > 0, 'F9 产出 tagsShown 字段')"
G1_NEW = ("ok(idxJs.indexOf('d.tagsShown = tagFit.fitTags(d.tags, d.moodText,') > 0, 'F9 产出 tagsShown 字段')\n"
          "// [date-year v1] 跨年日期文案变长 ⇒ 必须把跨年宽度档传进去，否则标签会排到第三行\n"
          "ok(idxJs.indexOf('util.isCrossYearDate(d.created_at) ? tagFit.WIDTHS.dateWidthCrossYear : 0') > 0,\n"
          "  'F9b 跨年日期宽度已传入标签自适应')")
G1_GUARD = "F9b 跨年日期宽度已传入标签自适应"

G2_OLD = "ok(dateRange.rangeText('all') === '全部时间', 'rangeText(all)')"
G2_NEW = ("ok(dateRange.rangeText('all') === '全部时间', 'rangeText(all)')\n"
          "// [date-year v1] 跨年区间两端带年份；同年区间保持原样（上方 8月1日 至 8月31日 断言）\n"
          "ok(dateRange.rangeText('custom', '2025-12-20', '2026-01-05') === '2025年12月20日 至 2026年1月5日',\n"
          "  'rangeText(custom 跨年) 两端带年份')\n"
          "ok(dateRange.rangeText('custom', '2026-12-20', '2027-01-05') === '2026年12月20日 至 2027年1月5日',\n"
          "  'rangeText(custom 跨年) 跨到再下一年同样带年份')")
G2_GUARD = "rangeText(custom 跨年) 两端带年份"

OPS = [
    (STORAGE, A_OLD, A_NEW, A_GUARD, 1),
    (UTIL, B_OLD, B_NEW, B_GUARD, 1),
    (UTIL, C_OLD, C_NEW, C_GUARD, 1),
    (TAGFIT, D1_OLD, D1_NEW, D1_GUARD, 1),
    (TAGFIT, D2_OLD, D2_NEW, D2_GUARD, 1),
    (TAGFIT, D3_OLD, D3_NEW, D3_GUARD, 1),
    (TAGFIT, D4_OLD, D4_NEW, D4_GUARD, 1),
    (TAGFIT, D5_OLD, D5_NEW, D5_GUARD, 1),
    (INDEX, E_OLD, E_NEW, E_GUARD, 1),
    (DATEPICK, F_OLD, F_NEW, F_GUARD, 1),
    (T_TAGFIT, G1_OLD, G1_NEW, G1_GUARD, 1),
    (T_DATERANGE, G2_OLD, G2_NEW, G2_GUARD, 1),
]


def load(rel):
    raw = open(os.path.join(WORK, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n'), crlf)


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(WORK, rel), 'wb').write(text.encode('utf-8'))


def backup():
    """幂等备份：目标已存在即早退，绝不覆盖干净备份"""
    made = 0
    for rel in sorted(set(r for r, _, _, _, _ in OPS)):
        dst = os.path.join(BK, rel)
        if os.path.exists(dst):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(WORK, rel), dst)
        made += 1
    print('backup: %s (%d files%s)' % (BK, made, '' if made else ', 已存在即跳过'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore'):
        print('usage: patch_crossyear.py --check|--write|--restore')
        return 2
    if mode == 'restore':
        for rel in sorted(set(r for r, _, _, _, _ in OPS)):
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
        return 0

    if mode == 'write':
        backup()

    ok_all = True
    for rel, old, new, guard, expect in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if c_new >= expect:
            print('SKIP(applied)  %-38s guard=%d' % (rel, c_new))
        elif c_old == expect:
            if mode == 'write':
                save(rel, text.replace(old, new), crlf)
            print('OK             %-38s old=%d' % (rel, c_old))
        else:
            ok_all = False
            print('FAIL           %-38s old=%d guard=%d (expect old=%d)' % (rel, c_old, c_new, expect))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
