# -*- coding: utf-8 -*-
"""[about-title v1] 关于页导航标题「一灯记」→「关于我们」（2026-09-24 用户指令）。
页内 H1「一灯记」与 {{appName}} 均不动，只改顶栏导航标题。
op1: about.json navigationBarTitleText 改值
op2: test_about_info.js 断言改判（页面功能名，不再等于 APP_NAME）
幂等判据：applied = 新值/新断言已存在。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = [
    (
        "pages/about/about.json",
        '"navigationBarTitleText": "一灯记",',
        '"navigationBarTitleText": "关于我们",',
        '"navigationBarTitleText": "关于我们"',
        "json 标题",
    ),
    (
        "tools/test_about_info.js",
        "ok('导航标题与 APP_NAME 一致', aboutJson.navigationBarTitleText === info.APP_NAME,\n"
        "  'json=' + aboutJson.navigationBarTitleText + ' / appInfo=' + info.APP_NAME)",
        "ok('导航标题 = 关于我们（页面功能名，2026-09-24 用户指令；页内 H1 仍是 {{appName}}）[about-title v1]',\n"
        "  aboutJson.navigationBarTitleText === '关于我们',\n"
        "  'json=' + aboutJson.navigationBarTitleText)",
        "[about-title v1]",
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
    for rel, old, new, guard, desc in OPS:
        p = BASE + "\\" + rel.replace("/", "\\")
        raw = load(p)
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        if guard in text:
            print("%-12s SKIP(已应用)" % desc)
            continue
        cnt = text.count(old)
        if cnt != 1:
            print("%-12s FAIL 锚点命中 %d 次" % (desc, cnt))
            fails += 1
            continue
        if mode == "--check":
            print("%-12s OK(可写)" % desc)
        elif mode == "--write":
            save(p, text.replace(old, new, 1), nl)
            print("%-12s APPLIED" % desc)
        elif mode == "--restore":
            if new in text and text.count(new) == 1:
                save(p, text.replace(new, old, 1), nl)
                print("%-12s RESTORED" % desc)
            else:
                print("%-12s FAIL 恢复锚点异常" % desc)
                fails += 1
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
