# -*- coding: utf-8 -*-
"""
[quote-zodiac] 每日一签日期头第二行加生肖（2026-09-24）

用户拍板：在农历和星座之间加上生肖。

实现：
- utils/lunarDate.js：header() 透传库的 animal 字段 → 新增 zodiac 返回值
  （solarlunar 以农历年定生肖：2026 丙午→马、2024 甲辰→龙，与干支年同源同分界）
- pages/quote/quote.js：data 加 zodiac 字段（applyDate 经 Object.assign 自动透传）
- pages/quote/quote.wxml：date-line2 在农历与星座之间插入
  `<text wx:if="{{zodiac}}">{{zodiac}} · </text>`（生肖缺失时不留悬空分隔符）
- 测试：test_quote_date.js 新增 4 条断言 + 结构断言升级

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\quote-zodiac-backup-20260924'

OPS = [
    # ---- utils/lunarDate.js ----
    ('utils/lunarDate.js',
     r''' *            termIcon:string, lunarFull:string}}''',
     r''' *            termIcon:string, lunarFull:string, zodiac:string}}''',
     'termIcon:string, lunarFull:string, zodiac:string}}'),
    ('utils/lunarDate.js',
     r'''  let weekday = ''
  let lunarFull = ''''',
     r'''  let weekday = ''
  let lunarFull = ''
  let zodiac = ''''',
     '  let zodiac = \'\''),
    ('utils/lunarDate.js',
     r'''      if (r.gzYear && r.monthCn && r.dayCn) {
        lunarFull = r.gzYear + '年' + r.monthCn + r.dayCn
      }''',
     r'''      if (r.gzYear && r.monthCn && r.dayCn) {
        lunarFull = r.gzYear + '年' + r.monthCn + r.dayCn
      }
      if (r.animal) zodiac = r.animal''',
     'if (r.animal) zodiac = r.animal'),
    ('utils/lunarDate.js',
     r'''    lunarFull: lunarFull
  }''',
     r'''    lunarFull: lunarFull,
    zodiac: zodiac
  }''',
     '    zodiac: zodiac\n  }'),
    # ---- pages/quote/quote.js ----
    ('pages/quote/quote.js',
     r'''    lunarFull: '',      // 丙午年八月十一''',
     r'''    lunarFull: '',      // 丙午年八月十一
    zodiac: '',         // 马（生肖；显示于农历与星座之间）''',
     '    zodiac: \'\',         // 马（生肖；显示于农历与星座之间）'),
    # ---- pages/quote/quote.wxml ----
    ('pages/quote/quote.wxml',
     r'''       第 1 行 = 日期 + 星期几（主视觉）；第 2 行 = 干支日期 + 星座 + 节气；''',
     r'''       第 1 行 = 日期 + 星期几（主视觉）；第 2 行 = 干支日期 + 生肖 + 星座 + 节气；''',
     '第 2 行 = 干支日期 + 生肖 + 星座 + 节气；'),
    ('pages/quote/quote.wxml',
     r'''      <view class="date-line2"><text wx:if="{{lunarFull}}">{{lunarFull}} · </text>{{constellation}}<text wx:if="{{termName}}"> · {{termName}}</text></view>''',
     r'''      <view class="date-line2"><text wx:if="{{lunarFull}}">{{lunarFull}} · </text><text wx:if="{{zodiac}}">{{zodiac}} · </text>{{constellation}}<text wx:if="{{termName}}"> · {{termName}}</text></view>''',
     '<text wx:if="{{zodiac}}">{{zodiac}} · </text>'),
    # ---- tools/test_quote_date.js ----
    ('tools/test_quote_date.js',
     r'''ok(h.lunarFull === '丙午年八月十一', '2026-9-21 lunarFull=丙午年八月十一（got ' + h.lunarFull + '）')''',
     r'''ok(h.lunarFull === '丙午年八月十一', '2026-9-21 lunarFull=丙午年八月十一（got ' + h.lunarFull + '）')
ok(h.zodiac === '马', '2026-9-21 zodiac=马（丙午马年，got ' + h.zodiac + '）')''',
     "'2026-9-21 zodiac=马（丙午马年，got '"),
    ('tools/test_quote_date.js',
     r'''ok(h.lunarFull === '甲辰年正月初一', '2024-2-10（春节）lunarFull=甲辰年正月初一（got ' + h.lunarFull + '）')''',
     r'''ok(h.lunarFull === '甲辰年正月初一', '2024-2-10（春节）lunarFull=甲辰年正月初一（got ' + h.lunarFull + '）')
ok(h.zodiac === '龙', '2024-2-10（甲辰）zodiac=龙（got ' + h.zodiac + '）')''',
     "'2024-2-10（甲辰）zodiac=龙（got '"),
    ('tools/test_quote_date.js',
     r'''   typeof h.lunarFull === 'string', 'header() 缺省返回完整结构（v2 字段）')''',
     r'''   typeof h.lunarFull === 'string' && typeof h.zodiac === 'string',
  'header() 缺省返回完整结构（v2 字段 + zodiac）')''',
     "'header() 缺省返回完整结构（v2 字段 + zodiac）')"),
    ('tools/test_quote_date.js',
     r'''  ok(p.data.lunarFull === '甲辰年正月初一', '2024-2-10 农历行=甲辰年正月初一')''',
     r'''  ok(p.data.lunarFull === '甲辰年正月初一', '2024-2-10 农历行=甲辰年正月初一')
  ok(p.data.zodiac === '龙', '2024-2-10 生肖=龙（页面数据透传）')''',
     "'2024-2-10 生肖=龙（页面数据透传）')"),
    ('tools/test_quote_date.js',
     r'''ok(wxml.indexOf('{{lunarFull}}') >= 0 && wxml.indexOf('{{constellation}}') >= 0 &&
   wxml.indexOf('{{termName}}') >= 0,
  'wxml [quote-date v4]：第二行 = 农历 + 星座 + 节气')''',
     r'''ok(wxml.indexOf('{{lunarFull}}') >= 0 && wxml.indexOf('{{zodiac}} · ') >= 0 &&
   wxml.indexOf('{{constellation}}') >= 0 && wxml.indexOf('{{termName}}') >= 0 &&
   wxml.indexOf('{{zodiac}} · ') > wxml.indexOf('{{lunarFull}}') &&
   wxml.indexOf('{{zodiac}} · ') < wxml.indexOf('{{constellation}}'),
  'wxml [quote-zodiac]：第二行 = 干支日期 + 生肖 + 星座 + 节气（生肖在农历与星座之间）')''',
     "'wxml [quote-zodiac]：第二行 = 干支日期 + 生肖 + 星座 + 节气（生肖在农历与星座之间）')"),
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    return raw.replace('\r\n', '\n'), nl


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    files = sorted(set(op[0] for op in OPS))
    if mode == '--write':
        if os.path.isdir(BACKUP):
            print('backup exists, skip auto-backup (幂等)')
        else:
            os.makedirs(BACKUP)
            for rel in files:
                src = os.path.join(ROOT, rel)
                dst = os.path.join(BACKUP, rel.replace('/', '_'))
                open(dst, 'wb').write(open(src, 'rb').read())
            print('auto-backup -> ' + BACKUP)
    ok_all = True
    for rel in files:
        text, nl = load(rel)
        ops = [op for op in OPS if op[0] == rel]
        new_text = text
        for i, (rel_, old, new, guard) in enumerate(ops):
            a, b = (old, new) if mode != '--restore' else (new, old)
            cnt = new_text.count(a)
            gcnt = new_text.count(guard) if guard else 0
            # guard 优先：追加型 op 的锚点在写入后依然存在（锚点行未被替换），
            # 若先判锚点会恒 APPLIED ⇒ 二次 --write 重复注入（坑 #6 变体）。
            # guard 均取 new 独有串，命中即已应用；--restore 模式不适用（盘上必有 guard）。
            if mode != '--restore' and guard and gcnt > 0:
                print('%-30s op%d SKIP(幂等)' % (rel, i))
            elif cnt == 1:
                new_text = new_text.replace(a, b, 1)
                print('%-30s op%d APPLIED' % (rel, i))
            elif guard and gcnt > 0:
                print('%-30s op%d SKIP(幂等)' % (rel, i))
            else:
                print('%-30s op%d FAIL 锚点命中 %d 次' % (rel, i, cnt))
                ok_all = False
        if mode in ('--write', '--restore') and new_text != text:
            out = new_text.replace('\n', nl)
            open(os.path.join(ROOT, rel), 'wb').write(out.encode('utf-8'))
    print('==== %s: %s ====' % (mode, 'OK' if ok_all else 'HAS FAIL'))
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
