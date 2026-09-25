# -*- coding: utf-8 -*-
"""
[entity-advprefix2 v1] 副词前缀横展 + 动词「知道」（2026-09-25 用户侧 bug）

用户案例：日记原文「终于知道是微信小程序的开发平台登录出了问题。」
弹出备案「终于知道」，解释「微信小程序的开发平台登录出了问题」。
根因（同族第三回：但总 / 原来我妈只 / 终于知道）：
  ① 云函数 AI 把副词「终于」+动词「知道」的拼片当名词抽出；
  ② 客户端机械校验放行：
     - NON_NOUN_WORDS 收了「终于」但只整词匹配，拦不住「终于+动词」拼接；
     - 动词表收了「明白/理解/记得/忘记」漏了「知道」；
     - ADVERB_PREFIX 只有「原来/原本/本来」，没有「终于」；
     - 「终于知道」后紧跟「是微信小程序…」凑成定义句形状，整句非比较/非疑问 → 通过。

收紧修法（用户指令「收紧一下备案提醒」）：
  A. utils/entityClean.js：ADVERB_PREFIX 横展——高频语气/情态/时间副词
     （终于/居然/竟然/明明/其实/似乎/好像/难道/毕竟/简直/根本/当然/几乎/突然/忽然）
     从「整词拦截」升级为「前缀拦截」，X 开头的拼片一律否决；
     「果然」可入真专名（果然山）不收，仍走整词匹配；
  B. utils/entityClean.js：动词表补「知道」（本体兜底 + 热词链路 isNonNounWord 同表生效）；
  C. utils/aiCloud.js + cloudfunctions/optimizeDiary/index.js：NAME_BLOCK_WORDS
     两处同步补「知道」「终于」（子串匹配，云端路径同堵）；
  D. cloudfunctions/optimizeDiary/index.js：extractEntities prompt 补反例（治本位）；
  E. tools/test_entity_features.js：补 zy-1~7。

⚠️ optimizeDiary 本就在待部署清单，本次 prompt 改动顺路一并部署。
用法：--check / --write / --restore（全回滚）/ --restore-src（只回滚源码，留新测试做红灯自检）
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\entity-advprefix-backup-20260925'

F_CLEAN = r'utils\entityClean.js'
F_AICLOUD = r'utils\aiCloud.js'
F_CLOUD = r'cloudfunctions\optimizeDiary\index.js'
F_TEST = r'tools\test_entity_features.js'

# ===== A. entityClean.ADVERB_PREFIX 横展 =========================================
A_OLD = "const ADVERB_PREFIX = ['原来', '原本', '本来']"
A_NEW = ("// [entity-advprefix2-v1] 副词前缀横展（2026-09-25 用户指令「收紧备案提醒」：「终于知道是微信\n"
         "// 小程序的开发平台登录出了问题」弹备案「终于知道」——副词与后文动词拼成碎片，整词表只拦\n"
         "// 「终于」本体拦不住拼接）。语气/情态/时间副词开头的串几乎必然是句子碎片，一律前缀否决；\n"
         "// 「果然」可入真专名（果然山）不收，仍走整词匹配。漏拦方向是少弹提醒，绝不误备案\n"
         "const ADVERB_PREFIX = ['原来', '原本', '本来', '终于', '居然', '竟然', '明明', '其实', '似乎', '好像', '难道', '毕竟', '简直', '根本', '当然', '几乎', '突然', '忽然']")
A_GUARD = "const ADVERB_PREFIX = ['原来', '原本', '本来', '终于', '居然', '竟然', '明明', '其实', '似乎', '好像', '难道', '毕竟', '简直', '根本', '当然', '几乎', '突然', '忽然']"

# ===== B. entityClean 动词表补「知道」============================================
B_OLD = "'回答', '提问', '讨论', '商量', '以为',"
B_NEW = "'回答', '提问', '讨论', '商量', '以为', '知道',"
B_GUARD = "'回答', '提问', '讨论', '商量', '以为', '知道',"

# ===== C1. aiCloud.NAME_BLOCK_WORDS 补「知道」「终于」=============================
C_OLD = "'那家', '什么', '怎么', '以为']"
C_NEW = "'那家', '什么', '怎么', '以为', '知道', '终于']"
C_GUARD = "'那家', '什么', '怎么', '以为', '知道', '终于']"

# ===== C2. optimizeDiary.NAME_BLOCK_WORDS 同步（与 aiCloud 同一份，勿分叉）=======
D_OLD = C_OLD
D_NEW = C_NEW
D_GUARD = C_GUARD

# ===== C3. optimizeDiary prompt 补反例 ===========================================
E_OLD = ("不是名词；\"我以为是…\"是主谓句、不是对\"以为\"的定义；',\n"
         "    '- 反例：日记写\"妹妹吵架时")
E_NEW = ("不是名词；\"我以为是…\"是主谓句、不是对\"以为\"的定义；',\n"
         "    '- 反例：日记写\"终于知道是微信小程序的开发平台登录出了问题\" → 不提取，\"终于知道\"是副词\"终于\"和动词\"知道\"拼出的句子碎片、不是名词；副词（终于/居然/竟然/明明/其实等）开头的字串一律不提取；',\n"
         "    '- 反例：日记写\"妹妹吵架时")
E_GUARD = '日记写"终于知道是微信小程序的开发平台登录出了问题" → 不提取'

# ===== E. 测试补 zy-1~7 ==========================================================
F_OLD = ("  check('yw-4 护栏：含「以为」的字串不受整词表误伤（以为斋）', entityClean.isNonNounWord('以为斋'), false)\n"
         "  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')")
F_NEW = ("  check('yw-4 护栏：含「以为」的字串不受整词表误伤（以为斋）', entityClean.isNonNounWord('以为斋'), false)\n"
         "\n"
         "  // ===== [entity-advprefix2-v1] 第 28 节：副词前缀横展（2026-09-25 用户指令「收紧备案提醒」：\n"
         "  // 「终于知道是微信小程序的开发平台登录出了问题。」弹备案「终于知道」——副词+动词拼片不是名词） =====\n"
         "  check('zy-1 用户案例：副词+动词「终于知道」不备案', entityClean.isExplainedNoun('终于知道', '终于知道是微信小程序的开发平台登录出了问题。', '微信小程序的开发平台登录出了问题'), false)\n"
         "  check('zy-2 副词前缀「终于开学」碎片不备案（前缀规则独立于动词表生效）', entityClean.isExplainedNoun('终于开学', '拖了两个月，终于开学是他的坚持。', '是他的坚持'), false)\n"
         "  check('zy-3 同族「竟然熬夜」碎片不备案', entityClean.isExplainedNoun('竟然熬夜', '竟然熬夜是他的常态。', '是他的常态'), false)\n"
         "  check('zy-4 动词「知道」本体不备案', entityClean.isExplainedNoun('知道', '知道是他的苦心。', '是他的苦心'), false)\n"
         "  check('zy-5 知道本体按动词表否决（热词链路同口径）', entityClean.isNonNounWord('知道'), true)\n"
         "  check('zy-6 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)\n"
         "  check('zy-7 护栏：果然山不受前缀横展误伤', entityClean.isExplainedNoun('果然山', '果然山是我们村后的大山。'), true)\n"
         "  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')")
F_GUARD = "zy-1 用户案例：副词+动词「终于知道」不备案"

OPS = [
    (F_CLEAN, A_OLD, A_NEW, A_GUARD, 1),
    (F_CLEAN, B_OLD, B_NEW, B_GUARD, 1),
    (F_AICLOUD, C_OLD, C_NEW, C_GUARD, 1),
    (F_CLOUD, D_OLD, D_NEW, D_GUARD, 1),
    (F_CLOUD, E_OLD, E_NEW, E_GUARD, 1),
    (F_TEST, F_OLD, F_NEW, F_GUARD, 1),
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
        print('usage: patch_entity_advprefix.py --check|--write|--restore|--restore-src')
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
