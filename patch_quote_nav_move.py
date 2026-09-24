# -*- coding: utf-8 -*-
"""
[nav-move] ‹›翻日按钮从「诗词」行挪到日期头右侧、贴右缘（2026-09-24）

用户拍板：将「诗词」右边的日期切换按钮 < > 挪到日历栏右边，贴右边框。

实现：
- wxml：日期头 date-head 内新增 .date-nav 容器（margin-left:auto 顶到右内边距缘），
  「诗词」行移除两个翻日按钮；按钮类名 quote-nav-btn/-hover/-off 原样保留（样式零迁移）
- wxss：新增 .date-nav（margin-left:auto + align-self:center 相对两行日期垂直居中）
- 测试：test_quote_date.js 两条 D 段断言改判（date-nav 位置 / kind-row 不再含翻日）

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\quote-nav-move-backup-20260924'

NAV_BLOCK = r'''      <view class="quote-nav-btn {{canPrev ? '' : 'quote-nav-off'}}" hover-class="quote-nav-hover"
            bindtap="onPrevDay" aria-label="前一天">‹</view>
      <view class="quote-nav-btn {{canNext ? '' : 'quote-nav-off'}}" hover-class="quote-nav-hover"
            bindtap="onNextDay" aria-label="后一天">›</view>'''

OPS = [
    # ---- quote.wxml ----
    ('pages/quote/quote.wxml',
     r'''       图标列宽即悬挂缩进，两行文字同一起点；‹›翻日移至「诗词」行 -->''',
     r'''       图标列宽即悬挂缩进，两行文字同一起点；‹›翻日按钮贴日期头右缘（margin-left:auto） -->''',
     '‹›翻日按钮贴日期头右缘（margin-left:auto） -->'),
    ('pages/quote/quote.wxml',
     r'''      <view class="date-line2"><text wx:if="{{lunarFull}}">{{lunarFull}} · </text>{{constellation}}<text wx:if="{{termName}}"> · {{termName}}</text></view>
    </view>
  </view>
  <view class="date-rule"></view>''',
     r'''      <view class="date-line2"><text wx:if="{{lunarFull}}">{{lunarFull}} · </text>{{constellation}}<text wx:if="{{termName}}"> · {{termName}}</text></view>
    </view>
    <view class="date-nav">
''' + NAV_BLOCK + r'''
    </view>
  </view>
  <view class="date-rule"></view>''',
     '<view class="date-nav">'),
    ('pages/quote/quote.wxml',
     r'''      <view class="quote-kind">{{kind}}</view>
''' + NAV_BLOCK + r'''
    </view>''',
     r'''      <view class="quote-kind">{{kind}}</view>
    </view>''',
     '<view class="quote-kind">{{kind}}</view>\n    </view>'),
    # ---- quote.wxss ----
    ('pages/quote/quote.wxss',
     r'''/* 「诗词」行 + ‹›翻日 [quote-date v2]（2.A 紧贴标签右侧，无框、越界置灰） */''',
     r'''/* 「诗词」行 [quote-date v2]（‹›翻日已挪至日期头右侧 .date-nav，无框、越界置灰） */''',
     '/* 「诗词」行 [quote-date v2]（‹›翻日已挪至日期头右侧 .date-nav，无框、越界置灰） */'),
    ('pages/quote/quote.wxss',
     r'''.date-line2 {
  margin-top: 10rpx;
  font-size: 22rpx;
  color: var(--ink-soft);
  letter-spacing: 2rpx;
}
/* [quote-date v4] 日期原小标签样式类已随标签字样一并移除 */''',
     r'''.date-line2 {
  margin-top: 10rpx;
  font-size: 22rpx;
  color: var(--ink-soft);
  letter-spacing: 2rpx;
}
/* ‹›翻日：贴日期头右侧（margin-left:auto 顶到 48rpx 内边距右缘），相对两行日期垂直居中 */
.date-nav {
  margin-left: auto;
  align-self: center;
  display: flex;
  align-items: center;
}
/* [quote-date v4] 日期原小标签样式类已随标签字样一并移除 */''',
     '.date-nav {'),
    # ---- tools/test_quote_date.js ----
    ('tools/test_quote_date.js',
     r'''ok(wxml.indexOf('date-head') >= 0 && wxml.indexOf('bindtap="onPrevDay"') >= 0 &&
   wxml.indexOf('bindtap="onNextDay"') >= 0, 'wxml：日期头与翻日绑定在位（箭头移至「诗词」行）')''',
     r'''ok(wxml.indexOf('date-head') >= 0 && wxml.indexOf('bindtap="onPrevDay"') >= 0 &&
   wxml.indexOf('bindtap="onNextDay"') >= 0 &&
   wxml.indexOf('<view class="date-nav">') > wxml.indexOf('date-head') &&
   wxml.indexOf('<view class="date-nav">') < wxml.indexOf('date-rule'),
  'wxml [nav-move]：‹›翻日移入日期头（date-nav 在 date-head 与 date-rule 之间、贴右）')''',
     "'wxml [nav-move]：‹›翻日移入日期头（date-nav 在 date-head 与 date-rule 之间、贴右）')"),
    ('tools/test_quote_date.js',
     r'''ok(wxml.indexOf('quote-kind-row') >= 0 && wxml.indexOf('quote-nav-btn') >= 0 &&
   wxml.indexOf('quote-nav-off') >= 0, 'wxml：「诗词」行 + 翻日按钮（2.A 紧贴标签右侧）')''',
     r'''const kindRowSeg = wxml.slice(wxml.indexOf('quote-kind-row'), wxml.indexOf('quote-head'))
ok(wxml.indexOf('quote-kind-row') >= 0 && wxml.indexOf('quote-nav-btn') >= 0 &&
   wxml.indexOf('quote-nav-off') >= 0 && kindRowSeg.indexOf('onPrevDay') === -1,
  'wxml [nav-move]：「诗词」行不再含翻日按钮（已挪至日期头右侧）')''',
     "'wxml [nav-move]：「诗词」行不再含翻日按钮（已挪至日期头右侧）')"),
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
            if cnt == 1:
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
