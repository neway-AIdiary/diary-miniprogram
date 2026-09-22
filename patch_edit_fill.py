# -*- coding: utf-8 -*-
"""
[edit-card-fill v1] 详情编辑页：白卡片撑满可用高度，统一「卡片底 ↔ 按钮顶」间距

背景（2026-09-22 用户上报）：
  日记详情编辑页，编辑框下边离【取消】【保存】按钮上边间距偏宽；AI 总结日记进同一编辑页
  时间距看着短一点。根因：两个入口是同一个页面（summary-result 编辑跳
  detail?edit=1），间距宽窄随内容长度漂移 —— .edit-area 是 flex: 0 1 auto
  （高度只由内容撑出），.edit-actions 是 margin-top: auto（吃掉全部剩余空间），
  于是「卡片底到按钮顶」= 屏幕剩余空白，内容越短缝越宽。

修法（用户拍板）：
  剩余空间从「卡片外面的缝隙」改给「卡片自己」——.edit-area 改 flex: 1 1 auto
  + min-height: 0（长内容时允许按 flex 收缩，滚动上限仍由内联 scrollMaxHeight 兜住），
  再给一个固定 margin-bottom: 20rpx（写日记页卡片间距同档）。
  短内容时空白移到卡片内部（字数统计下方），双入口间距恒定。

不动的：
  .edit-page 的 padding-bottom: 190rpx（按钮底部与写日记页对齐）、
  .edit-actions（margin-top: auto 无剩余空间后自然失效，保留不删）、
  textarea auto-height（min 330rpx / max 60vh）、全部 JS 逻辑。

锚点唯一性：`.edit-area {` 全文件 1 处；`flex: 0 1 auto` 全文件 1 处。
LF 文件。支持 --check / --write / --restore-src / --restore。
备份：WorkBuddy/edit-fill-backup-20260922/（已存在则早退，绝不覆盖）。
"""
import io
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = os.path.normpath(os.path.join(ROOT, '..', '..', 'edit-fill-backup-20260922'))

# (相对路径, 标签, old, new, sig)
OPS = [
    ('pages/detail/detail.wxss',
     'E1 卡片撑满可用高度 + 固定间距',
     """.edit-area {
  margin: 0 24rpx;
  padding: 0 28rpx 16rpx;
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}""",
     """.edit-area {
  margin: 0 24rpx;
  padding: 0 28rpx 16rpx;
  /* [edit-card-fill v1] 卡片撑满「标题栏 ↔ 按钮」可用高度：剩余空间给卡片自己，
     卡片底到按钮顶的间距 = 固定的 margin-bottom，不随内容长度漂移
     （普通日记 / AI 总结日记两个入口同一页面，此前缝隙 = 屏幕剩余空白，时宽时窄）。
     min-height: 0 允许长内容按 flex 收缩，滚动上限仍由内联 scrollMaxHeight 兜住 */
  flex: 1 1 auto;
  min-height: 0;
  margin-bottom: 20rpx;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}""",
     'margin-bottom: 20rpx;'),
]


def load(p):
    return io.open(p, encoding='utf-8').read()


def save(p, s):
    io.open(p, 'w', encoding='utf-8', newline='').write(s)


def do_backup():
    """只备份本批涉及的文件；已存在则早退（绝不覆盖，红灯自检依赖干净备份）"""
    if os.path.isdir(BACKUP):
        return
    for rel, _, _, _, _ in OPS:
        src = os.path.join(ROOT, rel.replace('/', os.sep))
        dst = os.path.join(BACKUP, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def iter_files():
    seen = []
    for rel, _, _, _, _ in OPS:
        if rel not in seen:
            seen.append(rel)
    return seen


def apply(ops, text):
    """逐 op 应用；锚点不唯一/缺失即抛错（宁可不动，不可错改）"""
    for rel, tag, old, new, sig in ops:
        n = text.count(old)
        if n != 1:
            raise RuntimeError('ERR_ANCHOR_%s(%d) [%s] %s' % ('DUP' if n > 1 else 'MISSING', n, rel, tag))
        text = text.replace(old, new)
    return text


def check():
    bad = 0
    by_file = {}
    for rel, tag, old, new, sig in OPS:
        by_file.setdefault(rel, []).append((tag, old, new, sig))
    for rel, items in by_file.items():
        text = load(os.path.join(ROOT, rel.replace('/', os.sep)))
        for tag, old, new, sig in items:
            already = sig in text
            hit = text.count(old)
            if already and hit == 0:
                print('SKIP [%s] %s' % (rel, tag))
            elif not already and hit == 1:
                print('OK   [%s] %s' % (rel, tag))
            else:
                bad += 1
                state = 'ALREADY(sig命中但锚点也在)' if already else ('DUP(%d)' % hit if hit > 1 else 'MISSING')
                print('ERR  [%s] %s -> %s' % (rel, tag, state))
    print('RESULT: ' + ('ALL_SKIP_IDEMPOTENT' if bad == 0 and all(
        load(os.path.join(ROOT, rel.replace('/', os.sep))).count(sig) >= 1
        for rel, _, _, _, sig in OPS) else ('OK=%d ERR=%d' % (
            sum(1 for rel, _, _, _, sig in OPS
                if sig not in load(os.path.join(ROOT, rel.replace('/', os.sep)))),
            bad))))


def write():
    do_backup()
    by_file = {}
    for rel, tag, old, new, sig in OPS:
        by_file.setdefault(rel, []).append((tag, old, new, sig))
    for rel, items in by_file.items():
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        text = load(p)
        todo = [(rel, t, o, n, g) for t, o, n, g in items if g not in text]
        if not todo:
            print('SKIP(file) %s' % rel)
            continue
        # 注意：load 只此一次，直接在内存文本上串行应用并写回
        text = apply(todo, text)
        save(p, text)
        print('WROTE %s (%d ops)' % (rel, len(todo)))


def restore_src():
    """把本批 op 反向替换回 old（用于红灯自检；备份仍是补丁前干净版）"""
    by_file = {}
    for rel, tag, old, new, sig in OPS:
        by_file.setdefault(rel, []).append((old, new, tag))
    for rel, items in by_file.items():
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        text = load(p)
        done = 0
        for old, new, tag in items:
            if text.count(new) == 1:
                text = text.replace(new, old)
                done += 1
            elif old in text:
                print('SKIP(restored) %s %s' % (rel, tag))
            else:
                print('ERR(restoring) %s %s：new 命中 %d' % (rel, tag, text.count(new)))
        save(p, text)
        print('RESTORED %s (%d ops)' % (rel, done))


def restore():
    if not os.path.isdir(BACKUP):
        print('NO BACKUP at', BACKUP)
        sys.exit(1)
    for rel in iter_files():
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        dst = os.path.join(ROOT, rel.replace('/', os.sep))
        shutil.copy2(src, dst)
        print('RESTORED-FROM-BACKUP %s' % rel)


if __name__ == '__main__':
    m = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if m == '--check':
        check()
    elif m == '--write':
        write()
    elif m == '--restore-src':
        restore_src()
    elif m == '--restore':
        restore()
    else:
        print('usage: --check | --write | --restore-src | --restore')
