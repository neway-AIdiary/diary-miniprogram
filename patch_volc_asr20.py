# -*- coding: utf-8 -*-
"""
[volc-asr20 v1] 火山流式语音识别 1.0 → 2.0 切换（2026-09-24 用户拍板：1.0/2.0 均已开通）

背景：当前用豆包流式语音识别模型 1.0（小时版 volc.bigasr.sauc.duration）。
官方已把 1.0 标为历史版本，2.0 为推荐版本（识别准确率更高，且长期有下线风险）。

为什么改动极小：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
（双向流式优化版）是 1.0/2.0 **共用端点**，服务端靠 X-Api-Resource-Id 区分版本；
请求参数（model_name='bigmodel'、enable_punc/itn/ddc、result_type、corpus.context 热词）
两版完全一致 ⇒ 协议层、帧编解码、时序、净化层全部不动。

改动（2 文件 3 处，纯配置值）：
  A. cloudfunctions/getAsrConfig/index.js —— 环境变量说明注释更新（列出 1.0/2.0 两个 id）；
  B. cloudfunctions/getAsrConfig/index.js —— 未配环境变量时的默认 resourceId 改 2.0；
  C. utils/voice.js —— 云端下发缺字段时的客户端兜底 resourceId 改 2.0。

⚠️ 生效前提（用户侧）：
  ① 云函数 getAsrConfig 必须**重新部署**；
  ② 若控制台已配环境变量 VOLC_ASR_RESOURCE_ID（值可能是 1.0），**环境变量优先于本默认值**
     ⇒ 需同步改成 volc.seedasr.sauc.duration 或删掉该变量。

用法：--check / --write / --restore（全回滚）/ --restore-src（只回滚源码，留新测试做红灯自检）
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\volc-asr20-backup-20260924'

F_CFG = r'cloudfunctions\getAsrConfig\index.js'
F_VOICE = r'utils\voice.js'

# ===== A. getAsrConfig 环境变量说明注释 ==========================================
A_OLD = ("//   可选：VOLC_ASR_RESOURCE_ID（默认 volc.bigasr.sauc.duration 小时版；\n"
         "//         并发版填 volc.bigasr.sauc.concurrent）")
A_NEW = ("//   可选：VOLC_ASR_RESOURCE_ID（默认 volc.seedasr.sauc.duration = 豆包流式语音识别模型 2.0 小时版；\n"
         "//         [volc-asr20] 1.0 小时版 volc.bigasr.sauc.duration 已属历史版本，仅作回滚备选；\n"
         "//         并发版把末尾的 duration 换成 concurrent）")
A_GUARD = "默认 volc.seedasr.sauc.duration = 豆包流式语音识别模型 2.0 小时版"

# ===== B. getAsrConfig 默认 resourceId → 2.0 =====================================
B_OLD = "resourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration'"
B_NEW = "resourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'"
B_GUARD = "process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration'"

# ===== C. voice.js 客户端兜底 resourceId → 2.0 ===================================
C_OLD = "resourceId: r.resourceId || 'volc.bigasr.sauc.duration',"
C_NEW = ("resourceId: r.resourceId || 'volc.seedasr.sauc.duration',   "
         "// [volc-asr20] 兜底=2.0 小时版（正常永远走云端下发，此处仅防配置缺失）")
C_GUARD = "r.resourceId || 'volc.seedasr.sauc.duration',"

OPS = [
    (F_CFG, A_OLD, A_NEW, A_GUARD, 1),
    (F_CFG, B_OLD, B_NEW, B_GUARD, 1),
    (F_VOICE, C_OLD, C_NEW, C_GUARD, 1),
]

ALL_RELS = sorted(set(o[0] for o in OPS))
SRC_RELS = [r for r in ALL_RELS if not r.startswith('tools')]


def load(rel):
    raw = open(os.path.join(WORK, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n'), crlf)


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(WORK, rel), 'wb').write(text.encode('utf-8'))


def backup():
    """幂等备份：目标已存在即早退，绝不覆盖干净备份"""
    made = 0
    for rel in ALL_RELS:
        dst = os.path.join(BK, rel)
        if os.path.exists(dst):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(WORK, rel), dst)
        made += 1
    print('backup: %s (%d files%s)' % (BK, made, '' if made else ', 已存在即跳过'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore', 'restore-src'):
        print('usage: patch_volc_asr20.py --check|--write|--restore|--restore-src')
        return 2
    if mode in ('restore', 'restore-src'):
        rels = ALL_RELS if mode == 'restore' else SRC_RELS
        for rel in rels:
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
        return 0

    if mode == 'write':
        backup()

    ok_all = True
    for rel, old, new, guard, expect in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if c_new >= expect:
            print('SKIP(applied)  %-40s guard=%d' % (rel, c_new))
        elif c_old == expect:
            if mode == 'write':
                save(rel, text.replace(old, new), crlf)
            print('OK             %-40s old=%d' % (rel, c_old))
        else:
            ok_all = False
            print('FAIL           %-40s old=%d guard=%d (expect old=%d)' % (rel, c_old, c_new, expect))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
