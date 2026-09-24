# -*- coding: utf-8 -*-
"""
[share-title-v2] 分享卡片标题文案：「记录每一天的故事」→「你的数字分身」（2026-09-24）

范围：
- 4 个品牌分享页 onShareAppMessage 的 title（index / write / backup / profile）
- tools/test_share_card.js 的 TITLE_KEY 静态断言同步（4 处同串）
不改：detail / summary-result 的动态标题；write.js 里分享给朋友的 content 文案。
用法：--check / --write / --restore
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\share-title-backup-20260924'

PAGES = {
    'index': r'pages\index\index.js',
    'write': r'pages\write\write.js',
    'backup': r'pages\backup\backup.js',
    'profile': r'pages\profile\profile.js',
}
TEST = r'tools\test_share_card.js'

OLD_TITLE = "title: appInfo.APP_NAME + ' — 记录每一天的故事',"
NEW_TITLE = "title: appInfo.APP_NAME + ' — 你的数字分身',"
# 测试文件 TITLE_KEY 里的断言串末尾无逗号
OLD_TKEY = "title: appInfo.APP_NAME + ' — 记录每一天的故事'"
NEW_TKEY = "title: appInfo.APP_NAME + ' — 你的数字分身'"
GUARD = "— 你的数字分身"

# (rel, old, new, guard, expect_old_count)
OPS = [
    (PAGES['index'], OLD_TITLE, NEW_TITLE, GUARD, 1),
    (PAGES['write'], OLD_TITLE, NEW_TITLE, GUARD, 1),
    (PAGES['backup'], OLD_TITLE, NEW_TITLE, GUARD, 1),
    (PAGES['profile'], OLD_TITLE, NEW_TITLE, GUARD, 1),
    (TEST, OLD_TKEY, NEW_TKEY, GUARD, 4),
]


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
    rels = sorted(set(r for r, _, _, _, _ in OPS))
    for rel in rels:
        dst = os.path.join(BK, rel)
        if os.path.exists(dst):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(WORK, rel), dst)
        made += 1
    print('backup: %s (%d files%s)' % (BK, made, '' if made else ', 已存在即跳过'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore'):
        print('usage: patch_share_title.py --check|--write|--restore')
        return 2
    if mode == 'restore':
        n = 0
        for rel in sorted(set(r for r, _, _, _, _ in OPS)):
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
                n += 1
        return 0

    if mode == 'write':
        backup()

    ok_all = True
    for rel, old, new, guard, expect in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if mode == 'check':
            if c_new >= expect:
                print('SKIP(applied?) %-42s guard=%d' % (rel, c_new))
            elif c_old == expect:
                print('OK             %-42s old=%d guard=0' % (rel, c_old))
            else:
                ok_all = False
                print('FAIL           %-42s old=%d guard=%d (expect old=%d)' % (rel, c_old, c_new, expect))
        else:
            if c_new >= expect:
                print('SKIP   %s (already applied)' % rel)
            elif c_old == expect:
                save(rel, text.replace(old, new), crlf)
                print('WROTE  %s (%d 处)' % (rel, c_old))
            else:
                ok_all = False
                print('FAIL   %s old=%d guard=%d (expect old=%d)' % (rel, c_old, c_new, expect))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
