# -*- coding: utf-8 -*-
"""
[roster-panel v1] 花名册确认面板：列表形式 → 平铺 chip 网格。
- 每个 chip：名字 + 下行小字「出现 N 次」（去掉最近时间）
- 勾选圆点取消，选中态 = chip 品牌实底反白（var(--surface)，禁写死 #fff）
- 点选切换/默认全选逻辑不变，js 不动
用法：python patch_roster_panel.py --check / --write / --restore
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BAK = r"C:\Users\ThinkPad\WorkBuddy\roster-panel-backup-20260925"
FILES = [
    r"pages\roster\roster.wxml",
    r"pages\roster\roster.wxss",
]

OP_WXML1_OLD = """  <!-- 确认面板：默认全选，点行切换 -->"""
OP_WXML1_NEW = """  <!-- 确认面板：默认全选，点 chip 切换 [roster-panel v1] -->"""

OP_WXML2_OLD = """      <view class="panel-item" wx:for="{{candidates}}" wx:key="name"
            bindtap="onToggle" data-name="{{item.name}}">
        <view class="panel-check {{item.checked ? 'on' : ''}}"></view>
        <view class="panel-name">{{item.name}}</view>
        <view class="panel-meta">出现 {{item.count}} 次<text wx:if="{{item.lastDate}}"> · 最近 {{item.lastDate}}</text></view>
      </view>"""

OP_WXML2_NEW = """      <view class="panel-grid">
        <view class="panel-chip {{item.checked ? 'on' : ''}}" wx:for="{{candidates}}" wx:key="name"
              bindtap="onToggle" data-name="{{item.name}}">
          <view class="panel-chip-name">{{item.name}}</view>
          <view class="panel-chip-meta">出现 {{item.count}} 次</view>
        </view>
      </view>"""

OP_CSS_OLD = """.panel-item {
  display: flex;
  align-items: center;
  padding: 22rpx 8rpx;
  border-bottom: 1rpx solid var(--line);
}
.panel-check {
  flex-shrink: 0;
  width: 34rpx;
  height: 34rpx;
  border-radius: 50%;
  border: 2rpx solid var(--ink-faint);
  margin-right: 24rpx;
  box-sizing: border-box;
}
.panel-check.on {
  background: var(--brand);
  border-color: var(--brand);
}
.panel-name {
  font-size: 30rpx;
  font-weight: var(--title-w);
  color: var(--title-ink);
  width: 140rpx;
  flex-shrink: 0;
}
.panel-meta {
  font-size: 22rpx;
  color: var(--ink-faint);
  flex: 1;
  text-align: right;
}"""

OP_CSS_NEW = """.panel-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  padding: 8rpx 0 24rpx;
}
.panel-chip {
  min-width: 150rpx;
  max-width: 220rpx;
  padding: 14rpx 20rpx;
  border-radius: 14rpx;
  border: 2rpx solid var(--line);
  background: var(--surface);
  text-align: center;
  box-sizing: border-box;
}
.panel-chip.on {
  background: var(--brand);
  border-color: var(--brand);
}
.panel-chip-name {
  font-size: 30rpx;
  font-weight: var(--title-w);
  color: var(--title-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-chip-meta {
  font-size: 20rpx;
  color: var(--ink-faint);
  margin-top: 4rpx;
}
.panel-chip.on .panel-chip-name,
.panel-chip.on .panel-chip-meta {
  color: var(--surface); /* 反白文字禁写死 #fff：深色 --brand 提亮后须自动转深字保证对比度 */
}"""

OPS = [
    (FILES[0], "wxml-注释点行改点选", OP_WXML1_OLD, OP_WXML1_NEW, ['点行切换']),
    (FILES[0], "wxml-列表改平铺chip", OP_WXML2_OLD, OP_WXML2_NEW,
     [('class="panel-item"', 0), ('panel-check', 0), ('class="panel-name"', 0), ('class="panel-meta"', 0),
      ('最近 {{item.lastDate}}', 1)]),  # 花名册列表区保留一处（用户仅要求面板去时间）
    (FILES[1], "wxss-行式样式改网格样式", OP_CSS_OLD, OP_CSS_NEW,
     ['.panel-item {', '.panel-check', '.panel-name {', '.panel-meta {']),
]


class F:
    def __init__(self, rel):
        self.rel = rel
        self.path = os.path.join(ROOT, rel)
        with open(self.path, "rb") as f:
            raw = f.read()
        self.crlf = b"\r\n" in raw
        self.text = raw.decode("utf-8").replace("\r\n", "\n")


def main(mode):
    mode = mode.lstrip("-")
    fs = {rel: F(rel) for rel in FILES}
    results = []

    if mode == "write":
        if not os.path.isdir(BAK):
            os.makedirs(BAK)
            for rel in FILES:
                shutil.copy2(os.path.join(ROOT, rel), os.path.join(BAK, os.path.basename(rel)))
            print("BACKUP ->", BAK)
        else:
            print("BACKUP exists, skip (idempotent) ->", BAK)

    for rel, name, a, n, rev in OPS:
        f = fs[rel]
        ca, cn = f.text.count(a), f.text.count(n)
        crev = [(r[0], f.text.count(r[0]), r[1]) for r in rev]
        if mode == "check":
            ok = (ca == 1) and (cn == 0)  # 反向断言只用于写后复核（预改前计数不固定）
            results.append((name, "OK" if ok else "FAIL", "old=%d new=%d rev=%s" % (ca, cn, crev)))
        elif mode == "write":
            if cn >= 1 and ca == 0:
                results.append((name, "SKIP", "already applied (new=%d)" % cn))
            elif ca == 1 and cn == 0:
                f.text = f.text.replace(a, n, 1)
                bad = [r for r in rev if f.text.count(r[0]) != r[1]]
                results.append((name, "OK" if not bad else "FAIL", "applied, rev-left=%s" % bad))
            else:
                results.append((name, "FAIL", "old=%d new=%d" % (ca, cn)))
        elif mode == "restore":
            src = os.path.join(BAK, os.path.basename(rel))
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(ROOT, rel))
                results.append((name, "RESTORED", rel))
            else:
                results.append((name, "FAIL", "no backup file: " + src))
        else:
            print("unknown mode:", mode)
            sys.exit(2)

    if mode == "write":
        for rel, f in fs.items():
            data = f.text.replace("\n", "\r\n") if f.crlf else f.text
            with open(f.path, "wb") as fh:
                fh.write(data.encode("utf-8"))

    print("=== patch_roster_panel [%s] ===" % mode)
    fails = 0
    for name, st, info in results:
        print("%-4s %-28s %s" % (st, name, info))
        if st == "FAIL":
            fails += 1
    print("TOTAL %d, FAILED %d" % (len(results), fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
