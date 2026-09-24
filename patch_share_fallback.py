# -*- coding: utf-8 -*-
"""
[share-card-fallback v1] 分享卡片品牌图探活 + 取不到时回落页面截图（2026-09-24）

背景：onShareAppMessage 一旦返回 imageUrl 但图取不到，微信不会回落页面截图，只显示破图占位。
修法：页面不再裸写 imageUrl，改走 utils/shareCard.js#build() ——
  可用 → 带 imageUrl；不可用 → 不带（微信自动截图）；未知 → promise 字段异步定夺。
- 6 个页面：补 require + onShareAppMessage 改写（title/path 原样透传）
- app.js：onLaunch 里加异步预热（失败静默、不阻塞启动）
用法：--check / --write / --restore
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\share-fallback-backup-20260924'

APPJS = r'app.js'
PAGES = {
    'index': r'pages\index\index.js',
    'write': r'pages\write\write.js',
    'backup': r'pages\backup\backup.js',
    'profile': r'pages\profile\profile.js',
    'detail': r'pages\detail\detail.js',
    'summary': r'pages\summary-result\summary-result.js',
}

REQ_OLD = "const appInfo = require('../../utils/appInfo.js')\n"
REQ_NEW = (
    "const appInfo = require('../../utils/appInfo.js')\n"
    "const shareCard = require('../../utils/shareCard.js') // [share-card-fallback v1] 品牌图探活与兜底\n"
)
GUARD_REQ = "const shareCard = require('../../utils/shareCard.js')"

# summary-result.js 的 appInfo require 行自带尾部注释，需单独锚点
REQ_S_OLD = (
    "const appInfo = require('../../utils/appInfo.js') // [share-card v1] 分享卡片品牌图引用\n"
)
REQ_S_NEW = REQ_S_OLD + GUARD_REQ + " // 分享卡片品牌图探活与兜底\n"

# ---- 品牌分享页（index / write / backup / profile）----
# title 行 + imageUrl 行 + path 行 → build({title, path})
# 注意 index 与 backup/profile 的 path 不同，逐页写全，保证锚点在该文件内唯一

OP_INDEX_OLD = (
    "  onShareAppMessage() {\n"
    "    return {\n"
    "      title: appInfo.APP_NAME + ' — 记录每一天的故事',\n"
    "      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容\n"
    "      path: '/pages/index/index'\n"
    "    }\n"
    "  }"
)
OP_INDEX_NEW = (
    "  onShareAppMessage() {\n"
    "    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图\n"
    "    return shareCard.build({\n"
    "      title: appInfo.APP_NAME + ' — 记录每一天的故事',\n"
    "      path: '/pages/index/index'\n"
    "    })\n"
    "  }"
)

OP_MAIN_OLD = (
    "  onShareAppMessage() {\n"
    "    return {\n"
    "      title: appInfo.APP_NAME + ' — 记录每一天的故事',\n"
    "      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容\n"
    "      path: '/pages/write/write'\n"
    "    }\n"
    "  }"
)
OP_MAIN_NEW = (
    "  onShareAppMessage() {\n"
    "    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图\n"
    "    return shareCard.build({\n"
    "      title: appInfo.APP_NAME + ' — 记录每一天的故事',\n"
    "      path: '/pages/write/write'\n"
    "    })\n"
    "  }"
)

# ---- 内容分享页 detail.js（title/path 动态，先算后透传）----
OP_DETAIL_OLD = (
    "  onShareAppMessage() {\n"
    "    const d = this.data.diary\n"
    "    const id = this.data.id\n"
    "    return {\n"
    "      title: d ? (util.resolveDiaryTitle(d) || '我的日记') : '我的' + appInfo.APP_NAME,\n"
    "      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容\n"
    "      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'\n"
    "    }\n"
    "  }"
)
OP_DETAIL_NEW = (
    "  onShareAppMessage() {\n"
    "    const d = this.data.diary\n"
    "    const id = this.data.id\n"
    "    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图\n"
    "    return shareCard.build({\n"
    "      title: d ? (util.resolveDiaryTitle(d) || '我的日记') : '我的' + appInfo.APP_NAME,\n"
    "      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'\n"
    "    })\n"
    "  }"
)

# ---- 总结结果页 summary-result.js（先落库拿 id）----
OP_SUMMARY_OLD = (
    "  onShareAppMessage() {\n"
    "    const id = this.ensureDiarySaved()\n"
    "    return {\n"
    "      title: this.data.title || '我的 AI 总结',\n"
    "      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容\n"
    "      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'\n"
    "    }\n"
    "  }"
)
OP_SUMMARY_NEW = (
    "  onShareAppMessage() {\n"
    "    const id = this.ensureDiarySaved()\n"
    "    // [share-card-fallback v1] 品牌图探活：取不到时自动回落「当前页面截图」，不再显示破图\n"
    "    return shareCard.build({\n"
    "      title: this.data.title || '我的 AI 总结',\n"
    "      path: id ? '/pages/detail/detail?id=' + encodeURIComponent(id) + '&share=1' : '/pages/write/write'\n"
    "    })\n"
    "  }"
)

# ---- app.js：启动预热 ----
OP_APP_OLD = (
    "    // 日记字体：若用户选了托管字体（宋/楷），启动时按需预载（非托管字体此处为零开销）\n"
    "    require('./utils/fontSetting.js').ensureLoaded()"
)
OP_APP_NEW = (
    "    // 日记字体：若用户选了托管字体（宋/楷），启动时按需预载（非托管字体此处为零开销）\n"
    "    require('./utils/fontSetting.js').ensureLoaded()\n"
    "\n"
    "    // 分享卡片品牌图探活 [share-card-fallback v1]：启动后异步确认云图可达，\n"
    "    // 不可达时各页分享自动回落「当前页面截图」（详见 utils/shareCard.js）\n"
    "    require('./utils/shareCard.js').warmup()"
)

GUARD_CALL = 'return shareCard.build({'
GUARD_APP = "require('./utils/shareCard.js').warmup()"

OPS = [
    # (rel, old, new, guard)——guard 必须逐字取自 new 且在该文件中独有
    (PAGES['index'], REQ_OLD, REQ_NEW, GUARD_REQ),
    (PAGES['write'], REQ_OLD, REQ_NEW, GUARD_REQ),
    (PAGES['backup'], REQ_OLD, REQ_NEW, GUARD_REQ),
    (PAGES['profile'], REQ_OLD, REQ_NEW, GUARD_REQ),
    (PAGES['detail'], REQ_OLD, REQ_NEW, GUARD_REQ),
    (PAGES['summary'], REQ_S_OLD, REQ_S_NEW, GUARD_REQ),
    (PAGES['index'], OP_INDEX_OLD, OP_INDEX_NEW, GUARD_CALL),
    (PAGES['write'], OP_MAIN_OLD, OP_MAIN_NEW, GUARD_CALL),
    (PAGES['backup'], OP_MAIN_OLD, OP_MAIN_NEW, GUARD_CALL),
    (PAGES['profile'], OP_MAIN_OLD, OP_MAIN_NEW, GUARD_CALL),
    (PAGES['detail'], OP_DETAIL_OLD, OP_DETAIL_NEW, GUARD_CALL),
    (PAGES['summary'], OP_SUMMARY_OLD, OP_SUMMARY_NEW, GUARD_CALL),
    (APPJS, OP_APP_OLD, OP_APP_NEW, GUARD_APP),
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
    for rel in sorted(set(r for r, _, _, _ in OPS)):
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
        print('usage: patch_share_fallback.py --check|--write|--restore')
        return 2
    if mode == 'restore':
        n = 0
        for rel in sorted(set(r for r, _, _, _ in OPS)):
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
                n += 1
        return 0

    if mode == 'write':
        backup()

    ok_all = True
    for rel, old, new, guard in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if mode == 'check':
            if c_new >= 1:
                print('SKIP(applied?) %-42s guard=%d' % (rel, c_new))
            elif c_old == 1:
                print('OK             %-42s old=1 guard=0' % rel)
            else:
                ok_all = False
                print('FAIL           %-42s old=%d guard=%d' % (rel, c_old, c_new))
        else:
            if c_new >= 1:
                print('SKIP   %s (already applied)' % rel)
            elif c_old == 1:
                save(rel, text.replace(old, new), crlf)
                print('WROTE  %s' % rel)
            else:
                ok_all = False
                print('FAIL   %s old=%d guard=%d' % (rel, c_old, c_new))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
