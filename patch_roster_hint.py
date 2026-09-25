# -*- coding: utf-8 -*-
"""
[roster-hint v1] 花名册页提示栏样式对齐档案页 hint-bar：
1. roster.wxml：两行说明文案并入 hint-bar（原 roster-head 行删除）
2. roster.wxss：.hint-bar 补背景/边框/圆角（与档案页一致，全部走主题令牌）
3. roster.wxss：.roster-head 规则删除（替换为注释标记）
用法：python patch_roster_hint.py --check / --write / --restore
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BAK = r"C:\Users\ThinkPad\WorkBuddy\roster-hint-backup-20260925"
FILES = [
    r"pages\roster\roster.wxml",
    r"pages\roster\roster.wxss",
]

OP_WXML_OLD = """  <!-- 提示栏（用户指定文案） -->
  <view class="hint-bar">
    <view class="hint-text">添加名字到花名册后，语音识别会更精准</view>
  </view>

  <view class="roster-head">花名册（{{count}}/100）· 长按名字可删除</view>"""

OP_WXML_NEW = """  <!-- 提示栏（用户指定文案，样式对齐档案页提示区） -->
  <view class="hint-bar">
    <view class="hint-text">添加名字到花名册后，语音识别会更精准</view>
    <view class="hint-text">花名册（{{count}}/100）· 长按名字可删除</view>
  </view>"""

OP_CSS1_OLD = """.hint-bar {
  flex-shrink: 0;
  padding: 20rpx 32rpx 4rpx;
}"""

OP_CSS1_NEW = """.hint-bar {
  flex-shrink: 0;
  padding: 20rpx 32rpx;
  background: var(--brand-tint-08);
  border: 1rpx solid var(--brand-tint-12);
  border-radius: var(--r-md);
}"""

OP_CSS2_OLD = """.roster-head {
  padding: 8rpx 32rpx 16rpx;
  font-size: 24rpx;
  color: var(--ink-faint);
}

"""

OP_CSS2_NEW = """/* 头部统计行已并入提示栏第二行 [roster-hint v1] */

"""

# (文件, op名, old, new, 附加反向断言列表)
OPS = [
    (FILES[0], "wxml-两行并入hint-bar", OP_WXML_OLD, OP_WXML_NEW,
     ['class="roster-head"']),
    (FILES[1], "wxss-hint-bar样式", OP_CSS1_OLD, OP_CSS1_NEW, []),
    (FILES[1], "wxss-roster-head规则删除", OP_CSS2_OLD, OP_CSS2_NEW,
     ['.roster-head {']),
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
        crev = [(r, f.text.count(r)) for r in rev]
        if mode == "check":
            ok = (ca == 1) and (cn == 0) and all(c == (1 if not r.startswith('class=') else 1) for r, c in crev)
            results.append((name, "OK" if ok else "FAIL", "old=%d new=%d rev=%s" % (ca, cn, crev)))
        elif mode == "write":
            if cn >= 1 and ca == 0:
                results.append((name, "SKIP", "already applied (new=%d)" % cn))
            elif ca == 1 and cn == 0:
                f.text = f.text.replace(a, n, 1)
                bad = [r for r, c in [(r, f.text.count(r)) for r in rev] if c != 0]
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

    print("=== patch_roster_hint [%s] ===" % mode)
    fails = 0
    for name, st, info in results:
        print("%-4s %-28s %s" % (st, name, info))
        if st == "FAIL":
            fails += 1
    print("TOTAL %d, FAILED %d" % (len(results), fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
