# -*- coding: utf-8 -*-
"""
[panel-mask v1] 底栏面板透明遮罩 —— 补丁（3 文件 3 ops，全部追加型）
用户指令（2026-09-25）：表情/+ 面板展开时，点击其他区域收起（保留原按钮 toggle 收起）。
方案 A（拍板）：全屏透明遮罩 z 29（< 底栏容器 z 30），catchtap=closeAllPanels 防穿透；
archive 档案页**不改**（用户拍板 1）。
用法（必须在工程根跑）：
  python patch_panel_mask.py --check        # 只验锚点与幂等判据，不改文件
  python patch_panel_mask.py --write        # 备份 + 落盘（备份已存在则早退，幂等）
  python patch_panel_mask.py --restore-src  # 从备份还原 3 个被改文件（红灯自检用，
                                            # ⚠️ 测试文件不在本脚本范围，不会被还原）
输出同时写会话目录 patch_panelmask_out.txt。
"""
import os
import shutil
import sys

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\panel-mask-backup-20260925"
LOG_PATH = r"C:\Users\ThinkPad\WorkBuddy\2026-09-15-09-30-50\patch_panelmask_out.txt"

FILES = [
    "app.wxss",
    "pages/write/write.wxml",
    "pages/detail/detail.wxml",
]

MASK_WXML_WRITE = (
    "  <!-- [panel-mask v1] 面板展开时的透明遮罩：点击面板外区域收起（catchtap 防穿透） -->\n"
    "  <view class=\"panel-mask\" wx:if=\"{{showEmojiPanel || showAddPanel}}\" catchtap=\"closeAllPanels\"></view>\n"
)
MASK_WXML_DETAIL = (
    "      <!-- [panel-mask v1] 面板展开时的透明遮罩：点击面板外区域收起（catchtap 防穿透） -->\n"
    "      <view class=\"panel-mask\" wx:if=\"{{showEmojiPanel || showAddPanel}}\" catchtap=\"closeAllPanels\"></view>\n"
)
MASK_WXSS = (
    "\n"
    "/* [panel-mask v1] 底栏面板透明遮罩：面板展开时盖住内容区（z 29 < 底栏容器 z 30，\n"
    "   不盖面板与输入栏），点击面板外任意区域收起；wxml 侧用 catchtap 防点击穿透 */\n"
    ".panel-mask {\n"
    "  position: fixed;\n"
    "  left: 0;\n"
    "  right: 0;\n"
    "  top: 0;\n"
    "  bottom: 0;\n"
    "  z-index: 29;\n"
    "  background: transparent;\n"
    "}"
)

OPS = [
    ("app.wxss", "m1 共用 .panel-mask 类",
     "/* 深色下 AI 渐变两端都被提亮（--ai → --ai-deep 浅蓝），按钮白字对比不足，\n"
     "   字色改用表面深色（浅色主题零变化，本条只在 .theme-dark 下生效） */\n"
     ".theme-dark .generate-btn {\n"
     "  color: var(--surface);\n"
     "}",
     "/* 深色下 AI 渐变两端都被提亮（--ai → --ai-deep 浅蓝），按钮白字对比不足，\n"
     "   字色改用表面深色（浅色主题零变化，本条只在 .theme-dark 下生效） */\n"
     ".theme-dark .generate-btn {\n"
     "  color: var(--surface);\n"
     "}" + MASK_WXSS),

    ("pages/write/write.wxml", "m2 写字页遮罩",
     "  <!-- ===== 底部固定区：面板 + 输入栏，面板展开时压盖编辑区/AI优化·保存按钮 ===== -->",
     MASK_WXML_WRITE + "  <!-- ===== 底部固定区：面板 + 输入栏，面板展开时压盖编辑区/AI优化·保存按钮 ===== -->"),

    ("pages/detail/detail.wxml", "m3 详情页遮罩",
     "      <!-- 底部固定区：面板 + 输入栏，面板展开时压盖编辑区/取消/保存按钮 -->",
     MASK_WXML_DETAIL + "      <!-- 底部固定区：面板 + 输入栏，面板展开时压盖编辑区/取消/保存按钮 -->"),
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
        log("[%s] %-24s anchor=%d new=%d" % (status, name, ca, cn))
    log("CHECK " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_backup():
    if os.path.isdir(BACKUP_DIR):
        log("备份已存在，早退（幂等）: " + BACKUP_DIR)
        return
    os.makedirs(BACKUP_DIR)
    for rel in FILES:
        shutil.copy2(os.path.join(ROOT, rel), os.path.join(BACKUP_DIR, rel.replace("/", "__")))
        log("backup: " + rel)

def do_write():
    do_backup()
    ok = True
    for rel, name, old, new in OPS:
        _, eol, text = load(rel)  # 只 load 一次（踩坑 5）
        ca, cn = text.count(old), text.count(new)
        if ca == 1 and cn == 0:
            save(rel, text.replace(old, new), eol)
            _, _, after = load(rel)
            # 追加型 op（old 是 new 的子串）落盘后 old 仍在，不能要求清零
            old_gone_ok = True if new.find(old) != -1 else after.count(old) == 0
            ok2 = after.count(new) == 1 and old_gone_ok
            log("[OK]  %-24s 落盘复核=%s" % (name, "OK" if ok2 else "FAIL"))
            ok = ok and ok2
        elif cn == 1:
            # 已是补丁态：追加型 op 落盘后 old 仍在（ca==1），统一看 new 是否在场
            log("[SKIP] %-23s 已是补丁态（幂等）" % name)
        else:
            log("[FAIL] %-24s anchor=%d new=%d —— 未写盘" % (name, ca, cn))
            ok = False
    log("WRITE " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_restore_src():
    if not os.path.isdir(BACKUP_DIR):
        log("无备份可还原: " + BACKUP_DIR)
        return False
    for rel in FILES:
        dst = os.path.join(BACKUP_DIR, rel.replace("/", "__"))
        if not os.path.isfile(dst):
            log("[FAIL] 备份缺文件: " + rel)
            return False
        shutil.copy2(dst, os.path.join(ROOT, rel))
        log("restore: " + rel)
    log("RESTORE ALL=OK")
    return True

def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "--check").lstrip("-")  # 踩坑 12：先归一再分支
    if mode == "check":
        ok = do_check()
    elif mode == "write":
        ok = do_write()
    elif mode == "restore-src":
        ok = do_restore_src()
    else:
        log("unknown mode: " + mode)
        ok = False
    try:
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(LOG_LINES))
    except Exception as e:
        print("log write failed:", e)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
