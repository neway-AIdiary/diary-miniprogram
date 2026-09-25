# -*- coding: utf-8 -*-
"""
[summary-nudge v1] 智能总结篇数引导 —— 挂点补丁（3 文件 7 ops）
规则（拍板）：阈值 >20；两档弹窗（去试试/以后不再）；anchor 在总结生成成功时刷新。
用法（必须在工程根跑）：
  python patch_summary_nudge.py --check        # 只验锚点与幂等判据，不改文件
  python patch_summary_nudge.py --write        # 备份 + 落盘（备份已存在则早退，幂等）
  python patch_summary_nudge.py --restore-src  # 从备份还原 3 个被改文件（红灯自检用）
新文件 utils/summaryNudge.js 与 tools/test_summary_nudge.js 不在本脚本范围（直接落盘）。
输出同时写会话目录 patch_nudge_out.txt（PowerShell stdout 会被吞，以 log 为准）。
"""
import os
import shutil
import sys

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\summary-nudge-backup-20260925"
LOG_PATH = r"C:\Users\ThinkPad\WorkBuddy\2026-09-15-09-30-50\patch_nudge_out.txt"

FILES = [
    "pages/write/write.js",
    "pages/detail/detail.js",
    "pages/summary/summary.js",
]

# (文件, 名称, old, new)。追加型 op 的 new = old + 追加行：write 条件统一 count(a)==1 && count(n)==0（踩坑 6）
SN_REQ_WRITE = "const summaryNudge = require('../../utils/summaryNudge.js') // [summary-nudge v1] 智能总结篇数引导"
SN_REQ_DETAIL = "const summaryNudge = require('../../utils/summaryNudge.js') // [summary-nudge v1] 智能总结篇数引导"
SN_REQ_SUMMARY = "const summaryNudge = require('../../utils/summaryNudge.js') // [summary-nudge v1] 智能总结篇数引导"

OPS = [
    ("pages/write/write.js", "w1 require summaryNudge",
     "const transfer = require('../../utils/transfer.js')",
     "const transfer = require('../../utils/transfer.js')\n" + SN_REQ_WRITE),

    ("pages/write/write.js", "w2 导入结果弹窗串行接引导",
     "          title: added === -1 ? '导入失败' : (added > 0 ? '导入成功' : '导入提示'),\n"
     "          content: toast,\n"
     "          showCancel: false,\n"
     "          confirmText: '知道了'\n"
     "        })",
     "          title: added === -1 ? '导入失败' : (added > 0 ? '导入成功' : '导入提示'),\n"
     "          content: toast,\n"
     "          showCancel: false,\n"
     "          confirmText: '知道了',\n"
     "          // [summary-nudge v1] 导入结果弹窗关掉后再判引导（showModal 不可叠加，须串行在回调里）\n"
     "          success: () => { if (added > 0) summaryNudge.maybePrompt() }\n"
     "        })"),

    ("pages/write/write.js", "w3 afterSaveNavigate 置待提示标志",
     "    this._navigated = true\n"
     "    console.log('[write] afterSaveNavigate 进入, id =', this._lastSavedId)",
     "    this._navigated = true\n"
     "    console.log('[write] afterSaveNavigate 进入, id =', this._lastSavedId)\n"
     "    // [summary-nudge v1] 保存落定：已达阈值只置标志，引导由详情页 onShow 弹（不与备案弹窗抢时序）\n"
     "    try { summaryNudge.markSavedPending(app) } catch (e) { console.warn('[write] 总结引导标志失败:', e) }"),

    ("pages/detail/detail.js", "d1 require summaryNudge",
     "const lock = require('../../utils/lock.js')",
     "const lock = require('../../utils/lock.js')\n" + SN_REQ_DETAIL),

    ("pages/detail/detail.js", "d2 onShow 消费待提示标志",
     "  onShow() {\n    theme.applyTo(this)",
     "  onShow() {\n"
     "    theme.applyTo(this)\n"
     "    // [summary-nudge v1] 保存后待提示的智能总结引导：详情页落定后弹，避免与写页备案弹窗抢时序\n"
     "    try { summaryNudge.consumePending(app) } catch (e) { console.warn('[detail] 总结引导弹窗失败:', e) }"),

    ("pages/summary/summary.js", "s1 require summaryNudge",
     "const dateRange = require('../../utils/dateRange.js') // [range-toolbar v1] 日期范围公共口径",
     "const dateRange = require('../../utils/dateRange.js') // [range-toolbar v1] 日期范围公共口径\n" + SN_REQ_SUMMARY),

    ("pages/summary/summary.js", "s2 生成成功刷锚点",
     "app.globalData.summaryResult = payload // 兜底：eventChannel 未命中时结果页读全局",
     "app.globalData.summaryResult = payload // 兜底：eventChannel 未命中时结果页读全局\n"
     "        summaryNudge.refreshAnchor() // [summary-nudge v1] 生成成功即刷新篇数锚点（拍板：2.1）"),
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
        # 落盘独立复核（Edit/写成功 ≠ 落盘）
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
