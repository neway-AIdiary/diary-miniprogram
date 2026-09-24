# -*- coding: utf-8 -*-
"""
[quote-date v4] 每日一签日期头改版 + 页脚文案（2026-09-24）

用户拍板：
1. 去掉「公历」「农历」标签字样
2. 第一行 = 日期 + 星期几（字体与原公历日期一致，即沿用 date-line1 主视觉样式）
3. 第二行 = 农历日期（不带「农历」字样）+ 星座 + 节气
4. 页脚「一灯记 · 每日一签」→「一灯记 · 以一灯传诸灯，终至万灯皆明」
   （「一灯记」仍走 {{appName}}，test_daily_quote.js L308 禁止 wxml 出现字面量）

数据层（utils/lunarDate.js）零改动：lunarFull 本就是「丙午年八月十三」式干支串，无「农历」前缀。

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\quote-date-v4-backup-20260924'

# (rel_path, old, new, guard)  guard 必须与 new 中的原句逐字一致（幂等判据）
OPS = [
    # ---- quote.wxml ----
    ('pages/quote/quote.wxml',
     r'''  <!-- [quote-date v3] 日期头：日历图标 + 两行文字，整块左对齐（1.B）；节气不带 emoji（2.A）；
       「星 ↔ 公」对齐 = 图标列宽即悬挂缩进，两行文字同一起点；‹›翻日移至「诗词」行 -->''',
     r'''  <!-- [quote-date v4] 日期头：日历图标 + 两行文字，整块左对齐；节气不带 emoji；
       第 1 行 = 日期 + 星期几（主视觉）；第 2 行 = 干支日期 + 星座 + 节气；
       图标列宽即悬挂缩进，两行文字同一起点；‹›翻日移至「诗词」行 -->''',
     "[quote-date v4] 日期头：日历图标 + 两行文字，整块左对齐"),
    ('pages/quote/quote.wxml',
     r'''      <view class="date-line1"><text class="date-cal">公历</text>{{gregorian}}　<text class="date-cal">农历</text>{{lunarFull}}</view>
      <view class="date-line2">{{weekday}} · {{constellation}}<text wx:if="{{termName}}"> · {{termName}}</text></view>''',
     r'''      <view class="date-line1">{{gregorian}}　{{weekday}}</view>
      <view class="date-line2"><text wx:if="{{lunarFull}}">{{lunarFull}} · </text>{{constellation}}<text wx:if="{{termName}}"> · {{termName}}</text></view>''',
     '<view class="date-line1">{{gregorian}}\u3000{{weekday}}</view>'),
    ('pages/quote/quote.wxml',
     r'''    <view class="quote-foot">{{appName}} · 每日一签</view>''',
     r'''    <view class="quote-foot">{{appName}} · 以一灯传诸灯，终至万灯皆明</view>''',
     '{{appName}} · 以一灯传诸灯，终至万灯皆明</view>'),
    # ---- quote.wxss ----
    ('pages/quote/quote.wxss',
     r'''/* ===== [quote-date v3] 日期头：日历图标 + 两行文字，整块左对齐 =====
   拍板 1.B：整块贴左（杂志页眉感）；2.A：节气不带 emoji；
   第 1 行主视觉（公历+农历，深墨加大加粗）；第 2 行浅灰小字（星期·星座·节气）；''',
     r'''/* ===== [quote-date v4] 日期头：日历图标 + 两行文字，整块左对齐 =====
   整块贴左（杂志页眉感）；节气不带 emoji；
   第 1 行主视觉（公历日期+星期几）；第 2 行浅灰小字（农历·星座·节气）；''',
     "/* ===== [quote-date v4] 日期头：日历图标 + 两行文字，整块左对齐 ====="),
    ('pages/quote/quote.wxss',
     r'''.date-line2 {
  margin-top: 10rpx;
  font-size: 22rpx;
  color: var(--ink-soft);
  letter-spacing: 2rpx;
}
.date-cal {
  color: var(--ink-faint);
}''',
     r'''.date-line2 {
  margin-top: 10rpx;
  font-size: 22rpx;
  color: var(--ink-soft);
  letter-spacing: 2rpx;
}
/* [quote-date v4] 日期原小标签样式类已随标签字样一并移除 */''',
     '/* [quote-date v4] 日期原小标签样式类已随标签字样一并移除 */'),
    # ---- quote.js（仅头注释同步口径）----
    ('pages/quote/quote.js',
     r''' * - 日期头 [quote-date v2]：两行轻文字（星期·星座·节气 / 公历+农历），数据来自 utils/lunarDate.js；''',
     r''' * - 日期头 [quote-date v4]：两行轻文字（公历日期+星期几 / 农历·星座·节气），数据来自 utils/lunarDate.js；''',
     " * - 日期头 [quote-date v4]：两行轻文字（公历日期+星期几 / 农历·星座·节气），数据来自 utils/lunarDate.js；"),
    # ---- tools/test_quote_date.js（D 段静态断言同步，随补丁一起可回退）----
    ('tools/test_quote_date.js',
     r'''ok(wxml.indexOf('date-line2') >= 0 && wxml.indexOf('公历') >= 0 && wxml.indexOf('农历') >= 0 &&
   wxml.indexOf('{{gregorian}}') >= 0 && wxml.indexOf('{{lunarFull}}') >= 0,
  'wxml：第二行 = 公历 + 农历（干支年）')''',
     r'''ok(wxml.indexOf('date-line1') >= 0 && wxml.indexOf('{{gregorian}}') >= 0 &&
   wxml.indexOf('{{weekday}}') >= 0 && wxml.indexOf('date-cal') === -1 &&
   wxml.indexOf('公历') === -1 && wxml.indexOf('农历') === -1,
  'wxml [quote-date v4]：第一行 = 公历日期 + 星期几，「公历/农历」标签字样清零')
ok(wxml.indexOf('{{lunarFull}}') >= 0 && wxml.indexOf('{{constellation}}') >= 0 &&
   wxml.indexOf('{{termName}}') >= 0,
  'wxml [quote-date v4]：第二行 = 农历 + 星座 + 节气')''',
     "'wxml [quote-date v4]：第一行 = 公历日期 + 星期几，「公历/农历」标签字样清零')"),
    ('tools/test_quote_date.js',
     r'''ok(wxml.indexOf('{{weekday}}') >= 0 && wxml.indexOf('{{constellation}}') >= 0,
  'wxml：第二行 = 星期 · 星座 · 节气 [quote-date v3]')''',
     r'''ok(wxml.indexOf('quote-foot') >= 0 &&
   wxml.indexOf('{{appName}} · 以一灯传诸灯，终至万灯皆明') >= 0,
  'wxml [quote-date v4]：页脚 = {{appName}} · 以一灯传诸灯，终至万灯皆明（无品牌字面量）')''',
     "'wxml [quote-date v4]：页脚 = {{appName}} · 以一灯传诸灯，终至万灯皆明（无品牌字面量）')"),
    ('tools/test_quote_date.js',
     r'''ok(wxss.indexOf('.date-big') === -1 && wxss.indexOf('.date-vert') === -1 && wxss.indexOf('.date-lunar') === -1,
  'wxss：旧版大数字/竖排/农历行样式整体移除')''',
     r'''ok(wxss.indexOf('.date-big') === -1 && wxss.indexOf('.date-vert') === -1 &&
   wxss.indexOf('.date-lunar') === -1 && wxss.indexOf('.date-cal') === -1,
  'wxss：旧版大数字/竖排/农历行/「公历农历」小标签样式整体移除')''',
     "'wxss：旧版大数字/竖排/农历行/「公历农历」小标签样式整体移除')"),
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    return raw.replace('\r\n', '\n'), nl


def apply_ops(text, ops, replace_old_with_new=True):
    """返回 (新文本, 明细列表)；锚点必须 count==1（或 guard 幂等命中）"""
    detail = []
    for i, (rel, old, new, guard) in enumerate(ops):
        a, b = (old, new) if replace_old_with_new else (new, old)
        cnt = text.count(a)
        gcnt = text.count(guard) if guard else 0
        if cnt == 1:
            text = text.replace(a, b, 1)
            detail.append('op%d APPLIED' % i)
        elif guard and gcnt > 0:
            detail.append('op%d SKIP(幂等)' % i)
        else:
            detail.append('op%d FAIL 锚点命中 %d 次: %s...' % (i, cnt, a[:40].replace('\n', '\\n')))
    return text, detail


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
    loaded = {rel: load(rel) for rel in files}
    ok_all = True
    for rel in files:
        text, nl = loaded[rel]
        ops = [op for op in OPS if op[0] == rel]
        new_text, detail = apply_ops(text, ops, replace_old_with_new=(mode != '--restore'))
        for d in detail:
            print('%-34s %s' % (rel, d))
        if any('FAIL' in d for d in detail):
            ok_all = False
        if mode in ('--write', '--restore'):
            changed = [d for d in detail if 'APPLIED' in d]
            if changed:
                out = new_text.replace('\n', nl)
                open(os.path.join(ROOT, rel), 'wb').write(out.encode('utf-8'))
    print('==== %s: %s ====' % (mode, 'OK' if ok_all else 'HAS FAIL'))
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
