# -*- coding: utf-8 -*-
"""[tech-credit-about v1] 技术支持行自设置页页脚移入关于页最底部（2026-09-24 用户指令）。
op1: setting.wxml 删除 .page-foot 整块（技术支持行离开设置页）
op2: about.wxml 信息卡区块之后、页面根闭合前插入技术支持行（{{appName}} 不硬编码）
op3: setting.wxss 删除 .page-foot/.tech-credit* 样式节（设置页不再使用）
op4: about.wxss 追加 .tech-credit* 样式节（元素随迁、样式随迁）
op5: test_about_info.js 断言改判到关于页 + 新增「设置页不再有该行」
幂等判据：applied = 各 op 的 guard 特征串已存在。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = [
    # op1 setting.wxml 删页脚块
    (
        "pages/setting/setting.wxml",
        '  <!-- 页脚（2026-09-24）：技术支持说明自首页左下角移入 -->\n'
        '  <view class="page-foot">\n'
        '    <view class="tech-credit">\n'
        '      <text class="tech-credit-icon ri ri-quill-pen-line"></text>\n'
        '      <text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>\n'
        '    </view>\n'
        '  </view>\n',
        "",
        ("gone", "page-foot"),
        "sw 删页脚块",
    ),
    # op2 about.wxml 插入技术支持行
    (
        "pages/about/about.wxml",
        '        <text class="about-copy">查看</text>\n'
        '      </view>\n'
        '    </view>\n'
        '  </view>\n'
        '</view>',
        '        <text class="about-copy">查看</text>\n'
        '      </view>\n'
        '    </view>\n'
        '  </view>\n'
        '\n'
        '  <!-- 页脚（2026-09-24）：技术支持说明自设置页移入 [tech-credit-about v1] -->\n'
        '  <view class="tech-credit">\n'
        '    <text class="tech-credit-icon ri ri-quill-pen-line"></text>\n'
        '    <text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>\n'
        '  </view>\n'
        '</view>',
        ("new", "[tech-credit-about v1]"),
        "aw 加技术支持行",
    ),
    # op3 setting.wxss 删样式节
    (
        "pages/setting/setting.wxss",
        '/* ===== 页脚（2026-09-24，setting-credit v1）=====\n'
        '   技术支持说明自首页左下角移入：羽毛笔图标 + 弱化小字，页脚内居中；\n'
        '   与「我的」页页脚同款口径（20rpx / ink-faint / 字距 0.5rpx） */\n'
        '.page-foot {\n'
        '  margin-top: 48rpx;\n'
        '  text-align: center;\n'
        '}\n'
        '\n'
        '.tech-credit {\n'
        '  display: flex;\n'
        '  align-items: center;\n'
        '  justify-content: center;\n'
        '  gap: 6rpx;\n'
        '}\n'
        '\n'
        '.tech-credit-icon {\n'
        '  font-size: 22rpx;\n'
        '  color: var(--ink-faint);\n'
        '  opacity: 0.7;\n'
        '}\n'
        '\n'
        '.tech-credit-text {\n'
        '  font-size: 20rpx;\n'
        '  line-height: 1.2;\n'
        '  color: var(--ink-faint);\n'
        '  letter-spacing: 0.5rpx;\n'
        '}\n',
        "",
        ("gone", ".tech-credit"),
        "swx 删样式节",
    ),
    # op4 about.wxss 追加样式节
    (
        "pages/about/about.wxss",
        '.about-copy {\n'
        '  flex-shrink: 0;\n'
        '  margin-left: 16rpx;\n'
        '  padding: 6rpx 18rpx;\n'
        '  font-size: 22rpx;\n'
        '  color: var(--brand);\n'
        '  border: 1rpx solid var(--brand-tint-25);\n'
        '  border-radius: var(--r-pill);\n'
        '}',
        '.about-copy {\n'
        '  flex-shrink: 0;\n'
        '  margin-left: 16rpx;\n'
        '  padding: 6rpx 18rpx;\n'
        '  font-size: 22rpx;\n'
        '  color: var(--brand);\n'
        '  border: 1rpx solid var(--brand-tint-25);\n'
        '  border-radius: var(--r-pill);\n'
        '}\n'
        '\n'
        '/* ===== 页脚：技术支持说明（2026-09-24 自设置页移入）[tech-credit-about v1] ===== */\n'
        '.tech-credit {\n'
        '  margin-top: 48rpx;\n'
        '  display: flex;\n'
        '  align-items: center;\n'
        '  justify-content: center;\n'
        '  gap: 6rpx;\n'
        '}\n'
        '\n'
        '.tech-credit-icon {\n'
        '  font-size: 22rpx;\n'
        '  color: var(--ink-faint);\n'
        '  opacity: 0.7;\n'
        '}\n'
        '\n'
        '.tech-credit-text {\n'
        '  font-size: 20rpx;\n'
        '  line-height: 1.2;\n'
        '  color: var(--ink-faint);\n'
        '  letter-spacing: 0.5rpx;\n'
        '}',
        ("new", "[tech-credit-about v1]"),
        "awx 加样式节",
    ),
    # op5 测试断言改判
    (
        "tools/test_about_info.js",
        "ok('技术支持行已移出首页（write.wxml 不再有该元素）[tech-credit-move v1]',\n"
        "  writeWxml.indexOf('tech-credit') === -1)\n"
        "ok('设置页页脚技术支持行绑定 {{appName}}（品牌不硬编码）[setting-credit v1]',\n"
        "  read('pages/setting/setting.wxml').indexOf('<text class=\"tech-credit-text\">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>') !== -1)\n"
        "ok('设置页技术支持行羽毛笔图标前置 [setting-credit v1]',\n"
        "  read('pages/setting/setting.wxml').indexOf('tech-credit-icon ri ri-quill-pen-line') !== -1)\n"
        "ok('我的页不再有技术支持行（唯一位于设置页）[setting-credit v1]',\n"
        "  read('pages/profile/profile.wxml').indexOf('tech-credit') === -1)",
        "ok('技术支持行已移出首页（write.wxml 不再有该元素）[tech-credit-move v1]',\n"
        "  writeWxml.indexOf('tech-credit') === -1)\n"
        "ok('技术支持行已移出设置页（setting.wxml 不再有该元素）[tech-credit-about v1]',\n"
        "  read('pages/setting/setting.wxml').indexOf('tech-credit') === -1)\n"
        "ok('关于页底部技术支持行绑定 {{appName}}（品牌不硬编码）[tech-credit-about v1]',\n"
        "  read('pages/about/about.wxml').indexOf('<text class=\"tech-credit-text\">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>') !== -1)\n"
        "ok('关于页技术支持行羽毛笔图标前置 [tech-credit-about v1]',\n"
        "  read('pages/about/about.wxml').indexOf('tech-credit-icon ri ri-quill-pen-line') !== -1)\n"
        "ok('我的页不再有技术支持行（唯一位于关于页）[tech-credit-about v1]',\n"
        "  read('pages/profile/profile.wxml').indexOf('tech-credit') === -1)",
        ("new", "[tech-credit-about v1]"),
        "测试断言改判",
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
