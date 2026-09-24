# -*- coding: utf-8 -*-
"""
[footer-center v1.1] 空态居中真机兜底（2026-09-23 用户反馈：提示贴到栏上没居中）

根因：scroll-view 内部包裹层高度 auto ⇒ content-inner 的百分比 min-height 真机解析为 auto，
.result-area 的 flex:1 拿不到剩余空间 ⇒ 提示贴底。vm 套件测不出真机布局（静态断言全绿照样翻车）。

修法：JS 实测 .content-scroll 高度 → data.scrollMinHeight(px) → content-inner 内联 min-height
（wxml style 绑定）；onReady / onShow 各测一次；wxss 的 100% 降级为无 JS 兜底。

用法（必须在工程根跑）:
  python patch_footer_center_fix.py --check | --write | --restore
"""
import sys, os, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\summary-center-fix-backup-20260923"

OPS = {
    "pages/summary/summary.js": [
        # op1 data 增加实测高度字段
        (
            "    // 底部安全区适配\n"
            "    safeAreaBottom: 0,",
            "    // 底部安全区适配\n"
            "    safeAreaBottom: 0,\n"
            "    // [footer-center v1.1] content-inner 实测最小高度（px）：scroll-view 内百分比\n"
            "    // min-height 真机不生效，改 JS 测量兜底 —— 空态提示据此在末条模板与底栏间垂直居中\n"
            "    scrollMinHeight: 0,",
            "scrollMinHeight: 0,",
        ),
        # op2 onReady + measureContent
        (
            "  onShow() {\n"
            "    theme.applyTo(this)",
            "  onReady() {\n"
            "    this.measureContent()\n"
            "  },\n"
            "\n"
            "  // [footer-center v1.1] 实测滚动区高度 → content-inner 的 px 最小高度\n"
            "  // （scroll-view 内百分比 min-height 真机不生效，见 2026-09-23 用户反馈）\n"
            "  measureContent() {\n"
            "    if (!wx.createSelectorQuery) return\n"
            "    const q = wx.createSelectorQuery()\n"
            "    q.select('.content-scroll').boundingClientRect()\n"
            "    q.exec((res) => {\n"
            "      const rect = res && res[0]\n"
            "      if (rect && rect.height > 0) {\n"
            "        this.setData({ scrollMinHeight: Math.round(rect.height) })\n"
            "      }\n"
            "    })\n"
            "  },\n"
            "\n"
            "  onShow() {\n"
            "    theme.applyTo(this)",
            "measureContent() {",
        ),
        # op3 onShow 重测（返回本页 / 字体变化后）
        (
            "    this.setData({ fontStyle: fontSetting.buildStyle() })",
            "    this.setData({ fontStyle: fontSetting.buildStyle() })\n"
            "    this.measureContent() // [footer-center v1.1] 返回本页 / 字体设置变化后重测",
            "this.measureContent() // [footer-center v1.1] 返回本页",
        ),
    ],
    "pages/summary/summary.wxml": [
        # op4 content-inner 挂实测 px 最小高度
        (
            "    <view class=\"content-inner\">",
            "    <view class=\"content-inner\" style=\"{{scrollMinHeight ? 'min-height:' + scrollMinHeight + 'px' : ''}}\">",
            "scrollMinHeight ? 'min-height:' + scrollMinHeight + 'px' : ''",
        ),
    ],
    "pages/summary/summary.wxss": [
        # op5 注释改口径：100% 降级为兜底
        (
            "/* [footer-center v1] 撑满滚动区高度并纵向 flex：结果区 flex:1 占据「最后一条模板 ↔ 底栏」\n"
            "   的剩余空间，空态羽毛提示在其中垂直居中（用户拍板 2）；内容超高时照常滚动 */\n"
            ".content-inner {\n"
            "  min-height: 100%;",
            "/* [footer-center v1.1] 撑满滚动区高度并纵向 flex：结果区 flex:1 占据「最后一条模板 ↔ 底栏」\n"
            "   的剩余空间，空态羽毛提示在其中垂直居中（用户拍板 2）；内容超高时照常滚动。\n"
            "   ⚠️ scroll-view 内百分比 min-height 真机不生效（首版翻车：提示贴底）⇒ 实际生效的是 wxml\n"
            "   内联的实测 px（data.scrollMinHeight，measureContent 测定），此处 100% 仅作无 JS 时兜底 */\n"
            ".content-inner {\n"
            "  min-height: 100%;",
            "首版翻车：提示贴底",
        ),
    ],
}


def load(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")
    nl = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n"), nl


def save(path, text, nl):
    with open(path, "wb") as f:
        f.write(text.replace("\n", nl).encode("utf-8"))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode not in ("--check", "--write", "--restore"):
        print("用法: python patch_footer_center_fix.py --check|--write|--restore")
        return 2

    if mode == "--restore":
        if not os.path.isdir(BACKUP_DIR):
            print("RESTORE-FAIL: 备份目录不存在", BACKUP_DIR)
            return 1
        n = 0
        for rel in OPS:
            src = os.path.join(BACKUP_DIR, os.path.basename(rel))
            dst = os.path.join(ROOT, rel)
            if not os.path.exists(src):
                print("RESTORE-FAIL: 备份缺失", rel)
                return 1
            shutil.copy2(src, dst)
            n += 1
        print("RESTORE-OK:", n, "files restored from", BACKUP_DIR)
        return 0

    applied = skipped = missing = multi = 0
    for rel, ops in OPS.items():
        text, nl = load(os.path.join(ROOT, rel))
        for i, (old, new, guard) in enumerate(ops):
            if guard in text:
                skipped += 1
                print("SKIP  %s#%02d（guard 命中，幂等）" % (rel, i + 1))
                continue
            c = text.count(old)
            if c == 0:
                missing += 1
                print("MISS  %s#%02d（锚点 0 命中）" % (rel, i + 1))
            elif c > 1:
                multi += 1
                print("MULTI %s#%02d（锚点 %d 命中，须唯一）" % (rel, i + 1, c))
            else:
                if mode == "--write":
                    text = text.replace(old, new, 1)
                applied += 1
                print("OK    %s#%02d" % (rel, i + 1))
        if mode == "--write" and not missing and not multi:
            save(os.path.join(ROOT, rel), text, nl)

    print("applied=%d skipped=%d miss=%d multi=%d" % (applied, skipped, missing, multi))
    ok = (missing == 0 and multi == 0)
    print(mode + ":", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
