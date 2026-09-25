# -*- coding: utf-8 -*-
"""
[roster v1] 花名册 —— 存量文件挂点补丁（4 文件 8 ops）
新文件 utils/roster.js、pages/roster/*、tools/test_roster.js 不在本脚本范围（直接落盘）。
规则（拍板）：纯本地规则提取；排序 = 日期新→旧 主、频次多→少 次；长按删除弹确认。
用法（必须在工程根跑）：
  python patch_roster.py --check        # 只验锚点与幂等判据，不改文件
  python patch_roster.py --write        # 备份 + 落盘（备份已存在则早退，幂等）
  python patch_roster.py --restore-src  # 从备份还原 4 个被改文件（红灯自检用）
"""
import os
import shutil
import sys

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\roster-backup-20260925"
LOG_PATH = r"C:\Users\ThinkPad\WorkBuddy\2026-09-15-09-30-50\patch_roster_out.txt"

FILES = [
    "app.json",
    "pages/archive/archive.wxml",
    "pages/archive/archive.js",
    "utils/hotwords.js",
    "utils/voice.js",
]

# [roster v1] 热词注入块（hotwords.js buildBase，档案之后、高频词之前）
H_ROSTER_BLOCK = (
    "\n"
    "  // 1.5 花名册人名 [roster v1]：用户从花名册确认的名字，优先级仅次于档案、高于自动挖掘；\n"
    "  //     与档案可重名（push 内 seen 去重）；懒加载防循环 require\n"
    "  try {\n"
    "    const roster = require('./roster.js')\n"
    "    const rosterNames = roster.getNames() || []\n"
    "    for (let i = 0; i < rosterNames.length; i++) {\n"
    "      if (push(rosterNames[i])) count.roster++\n"
    "    }\n"
    "  } catch (e) {}"
)

OPS = [
    ("app.json", "a1 注册花名册页",
     '    "pages/summary/summary",\n    "pages/summary-result/summary-result"\n  ],',
     '    "pages/summary/summary",\n    "pages/summary-result/summary-result",\n    "pages/roster/roster"\n  ],'),

    ("pages/archive/archive.wxml", "b1 表情按钮改花名册入口",
     '    <!-- 表情/颜文字（档案页不适用，表情置灰不可用） -->\n    <view class="input-btn input-emoji disabled">',
     '    <!-- 花名册入口 [roster v1]（原表情按钮在档案页置灰弃用，改作花名册入口） -->\n    <view class="input-btn input-emoji" bindtap="onRosterTap">'),

    ("pages/archive/archive.js", "c1 底栏表情 → 花名册跳转",
     '  // 右侧 +：输入框有内容→直接发送；为空→弹出「添加档案」编辑框\n  onPlusTap() {',
     '  // 花名册入口 [roster v1]：底栏表情按钮 → 花名册页\n'
     '  onRosterTap() {\n'
     '    this.setData({ showEmojiPanel: false })\n'
     "    wx.navigateTo({ url: '/pages/roster/roster' })\n"
     '  },\n'
     '\n'
     '  // 右侧 +：输入框有内容→直接发送；为空→弹出「添加档案」编辑框\n  onPlusTap() {'),

    ("utils/hotwords.js", "h1 count 初始化加 roster",
     "  const count = { archive: 0, keyword: 0 }",
     "  const count = { archive: 0, keyword: 0, roster: 0 }"),

    ("utils/hotwords.js", "h2 buildBase 注入花名册（档案之后）",
     "  // 1. 档案名词\n"
     "  try {\n"
     "    const archives = storage.getArchives() || []\n"
     "    for (let i = 0; i < archives.length; i++) {\n"
     "      if (push(archives[i] && archives[i].name)) count.archive++\n"
     "    }\n"
     "  } catch (e) {}",
     "  // 1. 档案名词\n"
     "  try {\n"
     "    const archives = storage.getArchives() || []\n"
     "    for (let i = 0; i < archives.length; i++) {\n"
     "      if (push(archives[i] && archives[i].name)) count.archive++\n"
     "    }\n"
     "  } catch (e) {}" + H_ROSTER_BLOCK),

    ("utils/hotwords.js", "h3 get() 缓存计数带 roster",
     "    cache.count = { archive: base.count.archive, keyword: base.count.keyword }",
     "    cache.count = { archive: base.count.archive, keyword: base.count.keyword, roster: base.count.roster || 0 }"),

    ("utils/hotwords.js", "h4 getLastCount 带 roster + 新增 resetBaseCache",
     "  return {\n"
     "    archive: cache.count ? cache.count.archive : 0,\n"
     "    keyword: cache.count ? cache.count.keyword : 0,\n"
     "    person: lastPersonCount\n"
     "  }\n"
     "}\n"
     "\n"
     "module.exports = { get, build, getContextTerms, getLastCount, estTokens, isValidWord, TOKEN_BUDGET, PERSON_SUB_BUDGET }",
     "  return {\n"
     "    archive: cache.count ? cache.count.archive : 0,\n"
     "    keyword: cache.count ? cache.count.keyword : 0,\n"
     "    roster: cache.count ? (cache.count.roster || 0) : 0,\n"
     "    person: lastPersonCount\n"
     "  }\n"
     "}\n"
     "\n"
     "/** [roster v1] 花名册变更后清基础词缓存（下次 get/build 重建，带上最新名单） */\n"
     "function resetBaseCache() {\n"
     "  cache.dateKey = ''\n"
     "}\n"
     "\n"
     "module.exports = { get, build, getContextTerms, getLastCount, estTokens, isValidWord, TOKEN_BUDGET, PERSON_SUB_BUDGET, resetBaseCache }"),

    ("utils/voice.js", "v1 热词日志加花名册计数",
     "'+ 日记高频', c.keyword, '+ 人名', c.person || 0, '）')",
     "'+ 花名册', c.roster || 0, '+ 日记高频', c.keyword, '+ 人名', c.person || 0, '）')"),
]

LOG_LINES = []
def log(msg):
    print(msg)
    LOG_LINES.append(msg)

def load(rel):
    raw = open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    return raw, eol, raw.replace("\r\n", "\n")

def save(rel, text_norm, eol):
    if eol == "\r\n":
        text_norm = text_norm.replace("\n", "\r\n")
    with open(os.path.join(ROOT, rel), "wb") as f:
        f.write(text_norm.encode("utf-8"))

def do_check():
    ok = True
    for rel, name, old, new in OPS:
        _, _, text = load(rel)
        ca, cn = text.count(old), text.count(new)
        status = "OK" if (ca == 1 and cn == 0) else "FAIL"
        if status == "FAIL":
            ok = False
        log("[%s] %-32s anchor=%d new=%d" % (status, name, ca, cn))
    log("CHECK " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_backup():
    if os.path.isdir(BACKUP_DIR):
        log("备份已存在，早退（幂等）: " + BACKUP_DIR)
        return
    for rel in FILES:
        dst = os.path.join(BACKUP_DIR, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel), dst)
    log("备份完成: " + BACKUP_DIR)

def do_write():
    do_backup()
    ok = True
    for rel, name, old, new in OPS:
        raw, eol, text = load(rel)
        ca, cn = text.count(old), text.count(new)
        if cn > 0:
            log("[SKIP] %-32s 已注入（幂等早退）" % name)
            continue
        if ca != 1:
            log("[FAIL] %-32s anchor 命中 %d 次，不写入" % (name, ca))
            ok = False
            continue
        text = text.replace(old, new, 1)
        save(rel, text, eol)
        # 落盘独立复核（写成功 ≠ 落盘）
        _, _, text2 = load(rel)
        c2 = text2.count(new)
        status = "OK" if c2 == 1 else "FAIL"
        if status == "FAIL":
            ok = False
        log("[%s] %-32s 已写入并复核 new=%d" % (status, name, c2))
    log("WRITE " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_restore():
    if not os.path.isdir(BACKUP_DIR):
        log("无备份可还原: " + BACKUP_DIR)
        return False
    for rel in FILES:
        src = os.path.join(BACKUP_DIR, rel.replace("/", os.sep))
        shutil.copy2(src, os.path.join(ROOT, rel))
        log("[RESTORE] " + rel)
    return True

def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "--check").lstrip("-")  # 踩坑 12：先归一再分支
    if mode == "check":
        do_check()
    elif mode == "write":
        do_write()
    elif mode == "restore-src":
        do_restore()
    else:
        log("未知模式: " + mode)

if __name__ == "__main__":
    try:
        main()
    finally:
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(LOG_LINES))
