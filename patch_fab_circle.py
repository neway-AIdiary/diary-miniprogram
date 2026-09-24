# -*- coding: utf-8 -*-
"""[fab-circle v1] 日记本页「智能总结」悬浮按钮改辅助触控式圆形（2026-09-24 用户指令）。
保留 AI 琥珀渐变（用主题令牌，深色自动适配）；去掉文字，羽毛笔居中；尺寸稍大（120rpx 圆 / 44rpx 图标）。
op1: index.wxml 删除 summary-fab-text 文字节点
op2: index.wxss .summary-fab 胶囊 → 正圆（定宽高 + 50% 圆角 + 居中，去 padding/gap）
op3: index.wxss .summary-fab-icon 字号 32→44rpx
op4: index.wxss 删除 .summary-fab-text 规则（已无引用）
幂等判据：applied = 各 op 的 guard 特征串已存在 / 删除型特征串已消失。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = [
    # op1 删文字节点
    (
        "pages/index/index.wxml",
        '    <text class="summary-fab-icon ri ri-quill-pen-line"></text>\n'
        '    <text class="summary-fab-text">智能总结</text>\n',
        '    <text class="summary-fab-icon ri ri-quill-pen-line"></text>\n',
        ("gone", 'class="summary-fab-text"'),
        "wxml 删文字",
    ),
    # op2 胶囊 → 正圆
    (
        "pages/index/index.wxss",
        '/* ===== 智能总结悬浮按钮（右下角，层级高于日记卡片） ===== */\n'
        '.summary-fab {\n'
        '  position: fixed;\n'
        '  right: 32rpx;\n'
        '  bottom: 64rpx;\n'
        '  z-index: 100;\n'
        '  display: flex;\n'
        '  align-items: center;\n'
        '  gap: 10rpx;\n'
        '  padding: 22rpx 32rpx;\n'
        '  background: linear-gradient(135deg, var(--ai) 0%, var(--ai-deep) 60%);\n'
        '  border-radius: var(--r-pill);\n'
        '  box-shadow: 0 8rpx 24rpx var(--ai-shadow-25);\n'
        '}',
        '/* ===== 智能总结悬浮按钮（右下角，层级高于日记卡片）=====\n'
        '   [fab-circle v1] 2026-09-24：改辅助触控式正圆——只留羽毛笔居中、无文字；\n'
        '   底色沿用 AI 渐变令牌（--ai/--ai-deep 深浅主题各自取值，自动兼顾深色） */\n'
        '.summary-fab {\n'
        '  position: fixed;\n'
        '  right: 32rpx;\n'
        '  bottom: 64rpx;\n'
        '  z-index: 100;\n'
        '  display: flex;\n'
        '  align-items: center;\n'
        '  justify-content: center;\n'
        '  width: 120rpx;\n'
        '  height: 120rpx;\n'
        '  background: linear-gradient(135deg, var(--ai) 0%, var(--ai-deep) 60%);\n'
        '  border-radius: 50%;\n'
        '  box-shadow: 0 8rpx 24rpx var(--ai-shadow-25);\n'
        '}',
        ("new", "border-radius: 50%;"),
        "wxss 改正圆",
    ),
    # op3 图标字号
    (
        "pages/index/index.wxss",
        '.summary-fab-icon {\n'
        '  font-size: 32rpx;\n'
        '  line-height: 1;\n'
        '  color: var(--ink-invert);\n'
        '}',
        '.summary-fab-icon {\n'
        '  font-size: 44rpx;\n'
        '  line-height: 1;\n'
        '  color: var(--ink-invert);\n'
        '}',
        ("new", "font-size: 44rpx;"),
        "wxss 图标字号",
    ),
    # op4 删文字样式
    (
        "pages/index/index.wxss",
        '\n'
        '.summary-fab-text {\n'
        '  font-size: 28rpx;\n'
        '  color: var(--ink-invert);\n'
        '  font-weight: 500;\n'
        '}\n',
        '\n',
        ("gone", ".summary-fab-text {"),
        "wxss 删文字样式",
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
            print("%-14s SKIP(已应用)" % desc)
            continue
        cnt = text.count(old)
        if cnt != 1:
            print("%-14s FAIL 锚点命中 %d 次" % (desc, cnt))
            fails += 1
            continue
        if mode == "--check":
            print("%-14s OK(可写)" % desc)
        elif mode == "--write":
            save(p, text.replace(old, new, 1), nl)
            print("%-14s APPLIED" % desc)
        elif mode == "--restore":
            if new and new in text and text.count(new) == 1:
                save(p, text.replace(new, old, 1), nl)
                print("%-14s RESTORED" % desc)
            else:
                print("%-14s FAIL 恢复锚点异常（删除型请用备份目录）" % desc)
                fails += 1
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
