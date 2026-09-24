# -*- coding: utf-8 -*-
"""
[share-card v1] 分享卡片统一品牌图（2026-09-24 用户拍板：图 A2「呀，被你看到了」+ 云存储 fileID 方案）
- utils/appInfo.js：新增 SHARE_CARD_FILEID（品牌唯一来源，与 APP_NAME 同处管理）
- 6 个带 onShareAppMessage 的页面统一加 imageUrl（含 detail/summary-result 内容分享页，
  避免「自动截图把用户日记内容带进卡片」的隐私问题）
- fileID 预填 `cloud://<env>.<bucket>/media/share-card.png`，用户需在云开发控制台
  上传图片到 media/share-card.png（权限「所有用户可读」）
用法：--check / --write / --restore
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\share-card-backup-20260924'

APPINFO = r'utils\appInfo.js'
PAGES = {
    'index': r'pages\index\index.js',
    'write': r'pages\write\write.js',
    'backup': r'pages\backup\backup.js',
    'profile': r'pages\profile\profile.js',
    'detail': r'pages\detail\detail.js',
    'summary': r'pages\summary-result\summary-result.js',
}

FID = "cloud://aidiary-d6grgxkct50c30f45.6169-aidiary-d6grgxkct50c30f45-1468488197/media/share-card.png"

# ---- op1: appInfo.js 常量 ----
OP1_OLD = (
"/* 联系方式 */\n"
"const WECHAT_ID = 'baguanshanren'"
)
OP1_NEW = (
"/* 联系方式 */\n"
"const WECHAT_ID = 'baguanshanren'\n"
"\n"
"/* [share-card v1] 分享卡片品牌图（云存储文件 ID）：各页 onShareAppMessage 统一引用。\n"
" * 图片位于云存储 media/share-card.png（5:4，1000x800）；换图只改这一行。\n"
" * ⚠️ 若控制台实际 fileID 与此处不一致，以控制台复制为准替换。 */\n"
"const SHARE_CARD_FILEID = '" + FID + "'"
)

# ---- op2: appInfo.js exports ----
OP2_OLD = (
"module.exports = {\n"
"  APP_NAME,\n"
"  APP_SLOGAN,\n"
"  APP_VERSION,\n"
"  APP_INTRO,\n"
"  ICP_NO,\n"
"  ICP_SITE,\n"
"  PRODUCER,\n"
"  WECHAT_ID\n"
"}"
)
OP2_NEW = (
"module.exports = {\n"
"  APP_NAME,\n"
"  APP_SLOGAN,\n"
"  APP_VERSION,\n"
"  APP_INTRO,\n"
"  ICP_NO,\n"
"  ICP_SITE,\n"
"  PRODUCER,\n"
"  WECHAT_ID,\n"
"  SHARE_CARD_FILEID\n"
"}"
)

# ---- op3~6: 品牌分享页（index/write/backup/profile 同款 title 行） ----
TITLE_OLD = (
"      title: appInfo.APP_NAME + ' — 记录每一天的故事',"
)
TITLE_NEW = (
"      title: appInfo.APP_NAME + ' — 记录每一天的故事',\n"
"      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容"
)

# ---- op7: detail.js（内容分享页） ----
OP7_OLD = (
"      title: d ? (util.resolveDiaryTitle(d) || '我的日记') : '我的' + appInfo.APP_NAME,"
)
OP7_NEW = (
"      title: d ? (util.resolveDiaryTitle(d) || '我的日记') : '我的' + appInfo.APP_NAME,\n"
"      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容"
)

# ---- op8: summary-result.js（内容分享页；文件未引 appInfo，需补 require） ----
OP8_OLD = (
"const lock = require('../../utils/lock.js')"
)
OP8_NEW = (
"const lock = require('../../utils/lock.js')\n"
"const appInfo = require('../../utils/appInfo.js') // [share-card v1] 分享卡片品牌图引用"
)

OP9_OLD = (
"      title: this.data.title || '我的 AI 总结',"
)
OP9_NEW = (
"      title: this.data.title || '我的 AI 总结',\n"
"      imageUrl: appInfo.SHARE_CARD_FILEID, // [share-card v1] 品牌图，避免自动截图带出日记内容"
)

GUARD = 'imageUrl: appInfo.SHARE_CARD_FILEID'

OPS = [
    # (rel, old, new, guard)——guard 必须逐字取自 new 且在该文件中独有
    (APPINFO, OP1_OLD, OP1_NEW, "const SHARE_CARD_FILEID = '"),
    (APPINFO, OP2_OLD, OP2_NEW, "  SHARE_CARD_FILEID\n}"),
    (PAGES['index'], TITLE_OLD, TITLE_NEW, GUARD),
    (PAGES['write'], TITLE_OLD, TITLE_NEW, GUARD),
    (PAGES['backup'], TITLE_OLD, TITLE_NEW, GUARD),
    (PAGES['profile'], TITLE_OLD, TITLE_NEW, GUARD),
    (PAGES['detail'], OP7_OLD, OP7_NEW, GUARD),
    (PAGES['summary'], OP8_OLD, OP8_NEW, "// [share-card v1] 分享卡片品牌图引用"),
    (PAGES['summary'], OP9_OLD, OP9_NEW, GUARD),
]


def load(rel):
    raw = open(os.path.join(WORK, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n'), crlf)


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(WORK, rel), 'wb').write(text.encode('utf-8'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore'):
        print('usage: patch_share_card.py --check|--write|--restore')
        return 2
    if mode == 'restore':
        n = 0
        for rel in set(r for r, _, _ in OPS):
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
                n += 1
        return 0

    ok_all = True
    for rel, old, new, guard in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        # 应用后 old 行仍在（new 以 old 为前缀），guard 出现即视为已应用
        if mode == 'check':
            if c_new >= 1:
                print('SKIP(applied?) %-40s guard=%d' % (rel, c_new))
            elif c_old == 1:
                print('OK             %-40s old=1 guard=0' % rel)
            else:
                ok_all = False
                print('FAIL           %-40s old=%d guard=%d' % (rel, c_old, c_new))
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
