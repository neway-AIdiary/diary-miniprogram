# -*- coding: utf-8 -*-
"""[menu-swap v1] 设置页【关于】与【新手引导】上下互换（2026-09-24 用户指令，其他不变）。
op1: setting.wxml 两块整体换序（新手引导在上、关于在下，注释随块走）。
幂等判据：guard = 换序后的特征串已存在。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OLD = (
    '      <view class="menu-item" bindtap="goToAbout">\n'
    '        <text class="menu-icon ri ri-information-line"></text><text class="menu-text">关于</text>\n'
    '        <text class="menu-arrow ri ri-arrow-right-s-line"></text>\n'
    '      </view>\n'
    '      <!-- 新手引导（重看入口）：清掉「已看过」标记 → 回写日记页，由那一页自动开播 -->\n'
    '      <view class="menu-item" bindtap="restartGuide">\n'
    '        <text class="menu-icon ri ri-book-open-line"></text><text class="menu-text">新手引导</text>\n'
    '        <text class="menu-value">再看看主要功能</text>\n'
    '        <text class="menu-arrow ri ri-arrow-right-s-line"></text>\n'
    '      </view>'
)
NEW = (
    '      <!-- 新手引导（重看入口）：清掉「已看过」标记 → 回写日记页，由那一页自动开播 -->\n'
    '      <view class="menu-item" bindtap="restartGuide">\n'
    '        <text class="menu-icon ri ri-book-open-line"></text><text class="menu-text">新手引导</text>\n'
    '        <text class="menu-value">再看看主要功能</text>\n'
    '        <text class="menu-arrow ri ri-arrow-right-s-line"></text>\n'
    '      </view>\n'
    '      <view class="menu-item" bindtap="goToAbout">\n'
    '        <text class="menu-icon ri ri-information-line"></text><text class="menu-text">关于</text>\n'
    '        <text class="menu-arrow ri ri-arrow-right-s-line"></text>\n'
    '      </view>'
)
GUARD = (
    '      <!-- 新手引导（重看入口）：清掉「已看过」标记 → 回写日记页，由那一页自动开播 -->\n'
    '      <view class="menu-item" bindtap="restartGuide">'
)
REL = "pages/setting/setting.wxml"


def load(p):
    with io.open(p, "r", encoding="utf-8", newline="") as f:
        return f.read()


def save(p, t, nl):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(t.replace("\n", nl))


def main(mode):
    p = BASE + "\\" + REL.replace("/", "\\")
    raw = load(p)
    nl = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    # applied 判据：restartGuide 出现在 goToAbout 之前（换序后的顺序）
    if text.find("restartGuide") != -1 and text.find("goToAbout") != -1 \
            and text.find("restartGuide") < text.find("goToAbout"):
        print("wxml 两栏换序  SKIP(已应用)")
        sys.exit(0)
    cnt = text.count(OLD)
    if cnt != 1:
        print("wxml 两栏换序  FAIL 锚点命中 %d 次" % cnt)
        sys.exit(1)
    if mode == "--check":
        print("wxml 两栏换序  OK(可写)")
    elif mode == "--write":
        save(p, text.replace(OLD, NEW, 1), nl)
        print("wxml 两栏换序  APPLIED")
    elif mode == "--restore":
        if NEW in text and text.count(NEW) == 1:
            save(p, text.replace(NEW, OLD, 1), nl)
            print("wxml 两栏换序  RESTORED")
        else:
            print("wxml 两栏换序  FAIL 恢复锚点异常")
            sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
