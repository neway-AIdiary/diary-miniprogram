# -*- coding: utf-8 -*-
"""
[voice-card-bg v1] 语音识别中卡片背景从 10% 半透明改为实心
用户反馈：iOS 语音识别时，「语音识别中」弹框有时是透明的。
根因：.voice-card-processing 背景 = var(--brand-tint-08)，深色主题下为
rgba(156,142,123,0.10)——10% 不透明度叠在页面与底部操作栏上近乎全透明。
修法：背景换成 var(--brand-soft)（两主题各为实心：浅 #EDE7DE / 深 #2E2A23），
保留 2rpx 描边区分状态；summary 页浮层本就是实心 var(--surface)，不在范围内。

ops（三页同款规则，逐文件替换）:
  A. pages/write/write.wxss
  B. pages/detail/detail.wxss
  C. pages/archive/archive.wxss

用法：
  python patch_voice_card_bg.py --check        # 校验锚点与幂等
  python patch_voice_card_bg.py --write        # 备份 + 应用
  python patch_voice_card_bg.py --restore-src  # 从备份还原源码
"""
import os
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\voice-card-bg-backup-20260924'

OLD = """.voice-card-processing {
  background: var(--brand-tint-08);
  border: 2rpx solid var(--brand-shadow-20);
}"""
NEW = """.voice-card-processing {
  /* [voice-card-bg v1] tint-08 只有 10% 不透明度，深色下叠底栏近乎透明；换实心档 */
  background: var(--brand-soft);
  border: 2rpx solid var(--brand-shadow-20);
}"""
GUARD = '[voice-card-bg v1]'

# (rel_path, [ (op_name, old, new, guard) ])
OPS = [
    ('pages/write/write.wxss', [('A.write processing 实心底', OLD, NEW, GUARD)]),
    ('pages/detail/detail.wxss', [('B.detail processing 实心底', OLD, NEW, GUARD)]),
    ('pages/archive/archive.wxss', [('C.archive processing 实心底', OLD, NEW, GUARD)]),
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return raw, (raw.replace('\r\n', '\n') if crlf else raw), crlf


def save(rel, text_lf, crlf):
    data = text_lf.replace('\n', '\r\n') if crlf else text_lf
    open(os.path.join(ROOT, rel), 'wb').write(data.encode('utf-8'))


def iter_ops(only=None):
    for rel, ops in OPS:
        for op in ops:
            if only is None or op[0] == only:
                yield rel, op


def do_check():
    ok = True
    for rel, (name, old, new, guard) in iter_ops():
        _, t, _ = load(rel)
        n_old = t.count(old)
        n_guard = t.count(guard)
        if n_guard >= 1 and n_old == 0:
            print('SKIP {}（guard 已存在，判定已应用）'.format(name))
        elif n_old == 1:
            print('OK   {}（锚点命中 1 次）'.format(name))
        elif n_old == 0:
            print('FAIL {}：锚点 0 命中且 guard 不存在'.format(name))
            ok = False
        else:
            print('FAIL {}：锚点命中 {} 次（应唯一）'.format(name, n_old))
            ok = False
    print('CHECK {}'.format('PASS' if ok else 'FAIL'))
    return 0 if ok else 1


def do_write():
    # 备份（幂等：已存在即早退，防二次 --write 覆盖干净备份）
    if os.path.isdir(BACKUP):
        print('BACKUP 已存在，跳过：' + BACKUP)
    else:
        os.makedirs(BACKUP)
        for rel, _ops in OPS:
            dst = os.path.join(BACKUP, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(ROOT, rel), dst)
        print('BACKUP 完成：' + BACKUP)

    # 逐文件应用（每文件只 load 一次）
    for rel, ops in OPS:
        raw, t, crlf = load(rel)
        for name, old, new, guard in ops:
            n_old = t.count(old)
            n_guard = t.count(guard)
            if n_guard >= 1 and n_old == 0:
                print('SKIP {}（已应用）'.format(name))
                continue
            if n_old != 1:
                print('ABORT {}：锚点命中 {} 次'.format(name, n_old))
                return 1
            t = t.replace(old, new)
            print('APPLY {} ok'.format(name))
        save(rel, t, crlf)
        # 落盘后立即重读复核
        _, t2, _ = load(rel)
        for name, old, new, guard in ops:
            if t2.count(guard) < 1:
                print('VERIFY FAIL {}：guard 未落盘'.format(name))
                return 1
        print('VERIFY {} 落盘确认'.format(rel))
    print('WRITE PASS')
    return 0


def do_restore():
    if not os.path.isdir(BACKUP):
        print('备份不存在，无法还原：' + BACKUP)
        return 1
    for rel, _ops in OPS:
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        shutil.copy2(src, os.path.join(ROOT, rel))
        print('RESTORE ' + rel)
    print('RESTORE PASS')
    return 0


def main():
    if '--write' in sys.argv:
        return do_write()
    if '--restore-src' in sys.argv:
        return do_restore()
    return do_check()


if __name__ == '__main__':
    sys.exit(main())
