# -*- coding: utf-8 -*-
"""
[entity-yiwei v1] 动词「以为」不备案（2026-09-24 用户侧 bug）

用户案例：日记原文「我以为是微信的框架不会差那么大。」弹出备案「以为」，
解释「微信的框架不会差那么大」。
根因：
  ① 云函数 AI 把动词「以为」（主观猜测/误判义）当名词抽出；
  ② 客户端机械校验 isExplainedNoun 五道闸全放行：
     - NON_NOUN_WORDS 动词表收了「觉得/认为」没收「以为」；
     - FUNC_CHARS 不含「以/为」；「以为」后紧跟「是微信的框架…」恰好凑成
       「名词+是」定义句形状，且整句非比较句/非疑问语气 → 通过。

修法（词表收紧 + 云函数 prompt 反例，两端同堵）：
  A. utils/entityClean.js：NON_NOUN_WORDS 动词段补「以为」（备案链路 + 人名热词
     链路 isNonNounWord 同表生效）；
  B. utils/aiCloud.js：NAME_BLOCK_WORDS 补「以为」（云端路径黑名单，子串匹配）；
  C. cloudfunctions/optimizeDiary/index.js：
     - NAME_BLOCK_WORDS 同步补「以为」（与 aiCloud 同一份，勿分叉）；
     - extractEntities prompt 补一条反例（治本位，AI 端少产脏名词）；
  D. tools/test_entity_features.js：补 yw-1~4 四条断言。

⚠️ optimizeDiary 本就在待部署清单（人名热词未上传），本次 prompt 改动顺路一并部署。
用法：--check / --write / --restore（全回滚）/ --restore-src（只回滚源码，留新测试做红灯自检）
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\entity-yiwei-backup-20260924'

F_CLEAN = r'utils\entityClean.js'
F_AICLOUD = r'utils\aiCloud.js'
F_CLOUD = r'cloudfunctions\optimizeDiary\index.js'
F_TEST = r'tools\test_entity_features.js'

# ===== A. entityClean.NON_NOUN_WORDS 动词段补「以为」===============================
A_OLD = "'提问', '讨论', '商量',\n  '帮忙',"
A_NEW = "'提问', '讨论', '商量', '以为',\n  '帮忙',"
A_GUARD = "'提问', '讨论', '商量', '以为',"

# ===== B. aiCloud.NAME_BLOCK_WORDS 补「以为」======================================
B_OLD = "'那家', '什么', '怎么']"
B_NEW = "'那家', '什么', '怎么', '以为']"
B_GUARD = "'那家', '什么', '怎么', '以为']"

# ===== C1. optimizeDiary.NAME_BLOCK_WORDS 同步 ====================================
C1_OLD = B_OLD
C1_NEW = B_NEW
C1_GUARD = B_GUARD

# ===== C2. optimizeDiary prompt 补反例 ============================================
C2_OLD = ("时间词与情态副词一律不提取；',\n"
          "    '- 反例：日记写\"妹妹吵架时")
C2_NEW = ("时间词与情态副词一律不提取；',\n"
          "    '- 反例：日记写\"我以为是微信的框架不会差那么大\" → 不提取，\"以为\"是动词（表达主观猜测/误判，如\"我以为是你没来\"），不是名词；\"我以为是…\"是主谓句、不是对\"以为\"的定义；',\n"
          "    '- 反例：日记写\"妹妹吵架时")
C2_GUARD = '日记写"我以为是微信的框架不会差那么大" → 不提取'

# ===== D. 测试补 yw-1~4 ==========================================================
D_OLD = ("check('pn-8 护栏：不含代词/副词前缀的真专名不受误伤', entityClean.isNonNounWord('明神大陆'), false)\n"
         "  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')")
D_NEW = ("check('pn-8 护栏：不含代词/副词前缀的真专名不受误伤', entityClean.isNonNounWord('明神大陆'), false)\n"
         "\n"
         "  // ===== [entity-yiwei-v1] 第 27 节：动词「以为」不备案（2026-09-24 用户侧 bug：\n"
         "  // 「我以为是微信的框架不会差那么大。」弹出备案「以为」——以为=主观猜测，动词不是名词） =====\n"
         "  check('yw-1 用户案例：动词「以为」不备案', entityClean.isExplainedNoun('以为', '我以为是微信的框架不会差那么大。', '微信的框架不会差那么大'), false)\n"
         "  check('yw-2 以为本体按动词表否决（热词链路同口径）', entityClean.isNonNounWord('以为'), true)\n"
         "  check('yw-3 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)\n"
         "  check('yw-4 护栏：含「以为」的字串不受整词表误伤（以为斋）', entityClean.isNonNounWord('以为斋'), false)\n"
         "  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')")
D_GUARD = "yw-1 用户案例：动词「以为」不备案"

OPS = [
    (F_CLEAN, A_OLD, A_NEW, A_GUARD, 1),
    (F_AICLOUD, B_OLD, B_NEW, B_GUARD, 1),
    (F_CLOUD, C1_OLD, C1_NEW, C1_GUARD, 1),
    (F_CLOUD, C2_OLD, C2_NEW, C2_GUARD, 1),
    (F_TEST, D_OLD, D_NEW, D_GUARD, 1),
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
        print('usage: patch_entity_yiwei.py --check|--write|--restore|--restore-src')
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
