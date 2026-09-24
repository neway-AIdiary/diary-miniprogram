# -*- coding: utf-8 -*-
"""
[transcribing-tip v1] 识别态「处理中…」提示移除（2026-09-23）

现象：iPhone 真机，松手进入语音识别（transcribing）阶段，浮层 footer 的
提示小字「处理中…」正好叠在底栏「按住 说话」按钮上，视觉像残留的脏字。

决策：去掉识别态的「处理中…」——卡片标题已是「语音识别中」+ 正文「识别中…」，
信息重复；只保留取消态的「松开取消发送」（有防误触价值，不能删）。

改动：3 个 wxml 各一行（write / archive / detail）：
  old: <text class="voice-modal-tip" wx:if="{{voiceCanceling || transcribing}}">{{voiceCanceling ? '松开取消发送' : '处理中…'}}</text>
  new: <text class="voice-modal-tip" wx:if="{{voiceCanceling}}">松开取消发送</text>

签名 Arnkernel
用法: python patch_transcribing_tip.py --check | --write | --restore
"""
import sys, os, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))

# guard 必须直接抄 new 里的原句（不转述）——幂等判据
OLD_LINE = (
    '<text class="voice-modal-tip" '
    'wx:if="{{voiceCanceling || transcribing}}">'
    "{{voiceCanceling ? '松开取消发送' : '处理中…'}}</text>"
)
NEW_LINE = '<text class="voice-modal-tip" wx:if="{{voiceCanceling}}">松开取消发送</text>'
GUARD = 'wx:if="{{voiceCanceling}}">松开取消发送</text>'

FILES = [
    os.path.join(ROOT, "pages", "write", "write.wxml"),
    os.path.join(ROOT, "pages", "archive", "archive.wxml"),
    os.path.join(ROOT, "pages", "detail", "detail.wxml"),
]

OPS = [(f, OLD_LINE, NEW_LINE) for f in FILES]

BACKUP_DIR = os.path.join(
    os.path.dirname(ROOT), "transcribing-tip-backup-20260923", "auto"
)


def load(path):
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text, orig_newline):
    with open(path, "w", encoding="utf-8", newline=orig_newline) as fh:
        fh.write(text)


def do_check():
    failed = 0
    for path, old, new in OPS:
        name = os.path.basename(path)
        raw = load(path)
        nl = "\r\n" if "\r\n" in raw else "\n"
        norm = raw.replace("\r\n", "\n")
        # 幂等判据：new 已在 ⇒ SKIP（不算失败）
        if GUARD in norm and old not in norm:
            print("SKIP  {} 已应用过".format(name))
            continue
        cnt = norm.count(old)
        if cnt != 1:
            print("FAIL  {} 锚点命中 {} 次 (期望 1)".format(name, cnt))
            failed += 1
        else:
            print("OK    {} 锚点唯一".format(name))
    print("CHECK_RESULT failed={}".format(failed))
    return failed


def do_write():
    # 自动备份：幂等（已存在即早退，防止二次 --write 覆盖干净备份）
    if os.path.exists(BACKUP_DIR):
        print("BACKUP exists, skip:", BACKUP_DIR)
    else:
        os.makedirs(BACKUP_DIR)
        for path in FILES:
            shutil.copy2(path, os.path.join(BACKUP_DIR, os.path.basename(path)))
        print("BACKUP_OK", BACKUP_DIR)
    applied = skipped = failed = 0
    for path, old, new in OPS:
        raw = load(path)
        nl = "\r\n" if "\r\n" in raw else "\n"
        norm = raw.replace("\r\n", "\n")
        if GUARD in norm and old not in norm:
            print("SKIP  {}".format(os.path.basename(path)))
            skipped += 1
            continue
        cnt = norm.count(old)
        if cnt != 1:
            print("FAIL  {} 锚点命中 {} 次，不动盘".format(os.path.basename(path), cnt))
            failed += 1
            continue
        norm = norm.replace(old, new)
        save(path, norm.replace("\n", nl), nl if nl == "\r\n" else "")
        # 写盘后立即回读复核（Edit 报成功 ≠ 落盘）
        verify = load(path).replace("\r\n", "\n")
        if GUARD in verify and old not in verify:
            print("APPLY {} ✓（回读确认）".format(os.path.basename(path)))
            applied += 1
        else:
            print("FAIL  {} 写盘后回读不符".format(os.path.basename(path)))
            failed += 1
    print("WRITE_RESULT applied={} skipped={} failed={}".format(applied, skipped, failed))
    return failed


def do_restore():
    if not os.path.exists(BACKUP_DIR):
        print("NO_BACKUP", BACKUP_DIR)
        return 1
    for path in FILES:
        src = os.path.join(BACKUP_DIR, os.path.basename(path))
        shutil.copy2(src, path)
        print("RESTORED", os.path.basename(path))
    print("RESTORE_OK")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode == "--check":
        sys.exit(1 if do_check() else 0)
    elif mode == "--write":
        sys.exit(1 if do_write() else 0)
    elif mode == "--restore":
        sys.exit(do_restore())
    else:
        print("usage: --check | --write | --restore")
        sys.exit(2)
