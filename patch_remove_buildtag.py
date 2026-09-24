# -*- coding: utf-8 -*-
"""移除设置页临时构建标记 build 0924d（版本排查已完成，用户确认 OK）。
op1: setting.wxml 页脚注释去掉「；含临时构建标记」
op2: setting.wxml 删除标记行（注释行 + footer-build 视图）
op3: setting.wxss 删除 .footer-build 样式块（含注释行）
幂等判据：替换型看新串是否已存在；删除型看旧标记是否已消失。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

# (文件, old, new, applied判据: (方向, 串), 说明)
OPS = [
    (
        "pages/setting/setting.wxml",
        "  <!-- 页脚（2026-09-24）：技术支持说明自首页左下角移入；含临时构建标记 -->",
        "  <!-- 页脚（2026-09-24）：技术支持说明自首页左下角移入 -->",
        ("new", "  <!-- 页脚（2026-09-24）：技术支持说明自首页左下角移入 -->"),
        "wxml 注释更新",
    ),
    (
        "pages/setting/setting.wxml",
        "    </view>\n    <!-- 临时构建标记（版本排查用，定位后移除） -->\n    <view class=\"footer-build\">build 0924d</view>\n  </view>",
        "    </view>\n  </view>",
        ("gone", "<view class=\"footer-build\">build 0924d</view>"),
        "wxml 删标记行",
    ),
    (
        "pages/setting/setting.wxss",
        "\n/* 临时构建标记（版本排查用，定位后移除） */\n.footer-build {\n  margin-top: 12rpx;\n  font-size: 20rpx;\n  color: var(--ink-faint);\n  opacity: 0.6;\n}\n",
        "\n",
        ("gone", ".footer-build {"),
        "wxss 删标记样式块",
    ),
]

def load(p):
    with io.open(p, "r", encoding="utf-8", newline="") as f:
        return f.read()

def save(p, t, nl):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(t.replace("\n", nl))

def main(mode):
    fails = 0
    for rel, old, new, (direction, marker), desc in OPS:
        p = BASE + "\\" + rel.replace("/", "\\")
        raw = load(p)
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        applied = (marker in text) if direction == "new" else (marker not in text)
        if applied:
            print("%-18s SKIP(已应用)" % desc)
            continue
        cnt = text.count(old)
        if cnt != 1:
            print("%-18s FAIL 锚点命中 %d 次" % (desc, cnt))
            fails += 1
            continue
        if mode == "--check":
            print("%-18s OK(可写)" % desc)
        elif mode == "--write":
            save(p, text.replace(old, new, 1), nl)
            print("%-18s APPLIED" % desc)
        elif mode == "--restore":
            print("%-18s FAIL 已应用但无法按锚点恢复（请用备份目录）" % desc)
            fails += 1
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
