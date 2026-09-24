# -*- coding: utf-8 -*-
"""
[fab-small v1] 日记本页悬浮按钮直径减半（2026-09-24 用户指令）

改动（单一文件 pages/index/index.wxss，3 个 op）：
  1. .summary-fab 整块：width/height 120rpx -> 60rpx，投影同步收细
  2. .summary-fab:active：按下投影同步收细
  3. .summary-fab-icon：font-size 44rpx -> 24rpx（按同比例缩，留 2rpx 保证小字号笔画清晰）

用法：
  python patch_fab_small.py --check     # 只检查锚点/幂等，不写盘
  python patch_fab_small.py --write     # 写盘（先自动备份，幂等）
  python patch_fab_small.py --restore   # 从自动备份还原
"""
import io
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REL = "pages/index/index.wxss"
BAK = os.path.join(BASE, "_autobak_fab_small", "index.wxss")

# ---- op1: .summary-fab 整块 ----
A1 = """.summary-fab {
  position: fixed;
  right: 32rpx;
  bottom: 64rpx;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 120rpx;
  height: 120rpx;
  background: linear-gradient(135deg, var(--ai) 0%, var(--ai-deep) 60%);
  border-radius: 50%;
  box-shadow: 0 8rpx 24rpx var(--ai-shadow-25);
}"""
N1 = """/* [fab-small v1] 直径 120rpx -> 60rpx（2026-09-24 用户指令：悬浮按钮缩小，直径改为一半） */
.summary-fab {
  position: fixed;
  right: 32rpx;
  bottom: 64rpx;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60rpx;
  height: 60rpx;
  background: linear-gradient(135deg, var(--ai) 0%, var(--ai-deep) 60%);
  border-radius: 50%;
  box-shadow: 0 4rpx 12rpx var(--ai-shadow-25);
}"""

# ---- op2: :active 按下投影 ----
A2 = """.summary-fab:active {
  transform: translateY(2rpx);
  box-shadow: 0 6rpx 14rpx var(--ai-shadow-25);
}"""
N2 = """.summary-fab:active {
  transform: translateY(1rpx);
  box-shadow: 0 3rpx 8rpx var(--ai-shadow-25);
}"""

# ---- op3: 图标字号 ----
A3 = """.summary-fab-icon {
  font-size: 44rpx;"""
N3 = """.summary-fab-icon {
  font-size: 24rpx;"""

OPS = [
    ("summary-fab 整块（60rpx + 投影 4/12）", A1, N1),
    ("summary-fab:active（投影 3/8）", A2, N2),
    ("summary-fab-icon（44 -> 24rpx）", A3, N3),
]


def load(p):
    with io.open(p, "rb") as f:
        return f.read().decode("utf-8")


def save(p, raw):
    with io.open(p, "wb") as f:
        f.write(raw.encode("utf-8"))


def main(mode):
    p = os.path.join(BASE, REL.replace("/", os.sep))
    raw = load(p)
    nl = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")

    if mode == "--restore":
        if not os.path.exists(BAK):
            print("RESTORE FAIL: 无自动备份")
            sys.exit(1)
        shutil.copyfile(BAK, p)
        print("RESTORE OK:", REL)
        return

    ok = True
    for name, a, n in OPS:
        ca = text.count(a)
        cn = text.count(n)
        if ca == 1:
            state = "APPLY"
        elif ca == 0 and cn == 1:
            state = "SKIP(已应用)"
        else:
            state = "FAIL(锚点%d次 / 新文本%d次)" % (ca, cn)
            ok = False
        print("%-34s %s" % (name, state))

    if mode == "--check":
        if not ok:
            sys.exit(1)
        print("CHECK OK（锚点均唯一）")
        return

    if mode == "--write":
        if not ok:
            print("WRITE ABORT: 存在 FAIL 项")
            sys.exit(1)
        if not os.path.exists(BAK):
            os.makedirs(os.path.dirname(BAK), exist_ok=True)
            shutil.copyfile(p, BAK)
            print("AUTObak ->", BAK)
        else:
            print("AUTObak 已存在，跳过（幂等）")
        for name, a, n in OPS:
            if text.count(a) == 1:
                text = text.replace(a, n, 1)
        save(p, text.replace("\n", nl))
        print("WRITE OK:", REL)
        return

    print("用法: --check | --write | --restore")
    sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
