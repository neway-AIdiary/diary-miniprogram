# -*- coding: utf-8 -*-
"""[ai-model-hide v1] 设置页「AI模型」入口暂时隐藏（2026-09-24 用户指令）。
仅 WXML 注释掉，JS（onComingSoon）与 WXSS（.menu-item-ai）原样保留，后期版本恢复即用。
op1: setting.wxml 将该 menu-item 块包进 WXML 注释（外层加标记注释说明缘由）。
幂等判据：guard = "[ai-model-hide v1]" 已存在即跳过。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OLD = (
    '      <view class="menu-item menu-item-ai" bindtap="onComingSoon" data-name="AI模型">\n'
    '        <text class="menu-icon ri ri-quill-pen-line"></text><text class="menu-text">AI模型</text>\n'
    '        <text class="menu-arrow ri ri-arrow-right-s-line"></text>\n'
    '      </view>'
)
NEW = (
    '      <!-- [ai-model-hide v1] 2026-09-24 用户指令：AI模型入口暂时隐藏；仅注释保留代码，后期版本恢复 -->\n'
    '      <!--\n'
    '      <view class="menu-item menu-item-ai" bindtap="onComingSoon" data-name="AI模型">\n'
    '        <text class="menu-icon ri ri-quill-pen-line"></text><text class="menu-text">AI模型</text>\n'
    '        <text class="menu-arrow ri ri-arrow-right-s-line"></text>\n'
    '      </view>\n'
    '      -->'
)
GUARD = "[ai-model-hide v1]"
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
    if GUARD in text:
        print("wxml 注释 AI模型栏  SKIP(已应用)")
        sys.exit(0)
    cnt = text.count(OLD)
    if cnt != 1:
        print("wxml 注释 AI模型栏  FAIL 锚点命中 %d 次" % cnt)
        sys.exit(1)
    if mode == "--check":
        print("wxml 注释 AI模型栏  OK(可写)")
    elif mode == "--write":
        save(p, text.replace(OLD, NEW, 1), nl)
        print("wxml 注释 AI模型栏  APPLIED")
    elif mode == "--restore":
        if NEW in text and text.count(NEW) == 1:
            save(p, text.replace(NEW, OLD, 1), nl)
            print("wxml 注释 AI模型栏  RESTORED")
        else:
            print("wxml 注释 AI模型栏  FAIL 恢复锚点异常")
            sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
