# -*- coding: utf-8 -*-
"""
patch_entity_pron2.py —— [entity-pron2/tailtime/advprefix/tailadv2 v1]
2026-09-24 用户侧 bug 第二批：句子碎片误弹备案
  案例1「妹妹吵架时是一条心的」→ 截出名词「妹妹吵架时」（时间从句，尾字「时」无规则）
  案例2「原来我妈只是一个平凡的女人」→ 截出名词「原来我妈只」（副词「原来」+代词「我」+副词「只」，
        整词表/复数代词表/尾字表全部漏过）

改动（utils/entityClean.js，备案与人名热词两条链路同口径）：
  op1 CONNECT_WORDS 增补人称代词单字 我/你/他/她/它（封闭类，同 俺/咱 先例）
  op2 TAIL_ADV_CHARS 增补 只/仅（副词收尾碎片「母亲只/母亲仅」）
  op3 新增 TAIL_TIME_CHARS = ['时']（「X时」时间从句收尾）
  op4 新增 ADVERB_PREFIX = ['原来','原本','本来']（与 TIME_PREFIX 同款前缀否决）
  op5 isExplainedNoun 接入 op4/op3 两规则
  op6 isNonNounWord  同口径接入 op4/op3 两规则
  op7 optimizeDiary prompt 追加本轮反例（待部署，与此前累积一并生效）

用法：python patch_entity_pron2.py --check | --write | --restore
铁律：锚点 count==1；guard 判幂等（guard 必须与注入文本逐字一致）；
      --write 自动备份幂等（已存在即跳过）；LF 匹配、写盘还原原换行符
"""
import sys, os, shutil, io

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
F1 = os.path.join(ROOT, 'utils', 'entityClean.js')
F2 = os.path.join(ROOT, 'cloudfunctions', 'optimizeDiary', 'index.js')
BK = r'C:\Users\ThinkPad\WorkBuddy\entity-pron2-backup-20260924'

# ---------------- ops ----------------
# 每个 op: (文件, guard, old, new)；guard 取自 new 的独特子串（逐字一致）

OP1_OLD = """const CONNECT_WORDS = ['因此', '但是', '可是', '因为', '所以', '虽然', '然而', '不过', '然后', '于是', '而且', '并且', '或者', '如果', '既然', '尽管', '即使', '无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己', '另外', '俺', '咱']"""

OP1_NEW = """// [entity-pron2-v1] 人称代词单字入表（2026-09-24 用户侧 bug：「原来我妈只是一个平凡的女人」
// 截出「原来我妈只」——代词成分表只收「我们」类复数拦不住「我妈」。人称代词是封闭类，
// 单字入子串表一并覆盖 我妈/你爸/他哥/她姐 全部变体；真专名含代词字极罕见
// （马耳他类尾字已被代词收尾规则拦），漏拦方向是少弹提醒，绝不误备案
const CONNECT_WORDS = ['因此', '但是', '可是', '因为', '所以', '虽然', '然而', '不过', '然后', '于是', '而且', '并且', '或者', '如果', '既然', '尽管', '即使', '无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己', '另外', '俺', '咱', '我', '你', '他', '她', '它']"""

OP2_OLD = """const TAIL_ADV_CHARS = ['便', '即', '竟', '倒', '亦', '皆', '均', '先', '已', '早', '曾']"""

OP2_NEW = """// [entity-tailadv2-v1] 增补「只/仅」收尾（2026-09-24 用户侧 bug：「原来我妈只」——范围副词
// 收尾的拼接碎片；就/都/也等已在 FUNC_CHARS，只/仅补齐）。真专名以只/仅收尾几乎不存在，
// 漏拦方向是少弹提醒，绝不误备案
const TAIL_ADV_CHARS = ['便', '即', '竟', '倒', '亦', '皆', '均', '先', '已', '早', '曾', '只', '仅']"""

OP3_OLD = """const TAIL_LOC_CHARS = ['后', '前', '上', '下', '左', '右', '内', '外', '旁', '侧', '底']"""

OP3_NEW = """const TAIL_LOC_CHARS = ['后', '前', '上', '下', '左', '右', '内', '外', '旁', '侧', '底']
// [entity-tailtime-v1] 「X时」收尾的时间从句碎片（2026-09-24 用户侧 bug：「妹妹吵架时是一条
// 心的」被截成名词「妹妹吵架时」——「X时」是时间状语从句不是名词本体，DATE_WORDS 只收
// 「当时/平时」等整词拦不住裸「时」）。以「时」收尾的 2~6 字串几乎不可能是真专名，
// 漏拦方向是少弹提醒，绝不误备案
const TAIL_TIME_CHARS = ['时']"""

OP4_OLD = """const TIME_PREFIX = ['今天', '明天', '昨天', '后天', '前天', '上午', '中午', '下午', '晚上', '早上', '凌晨', '当时', '现在', '目前']"""

OP4_NEW = """const TIME_PREFIX = ['今天', '明天', '昨天', '后天', '前天', '上午', '中午', '下午', '晚上', '早上', '凌晨', '当时', '现在', '目前']
// [entity-advprefix-v1] 副词前缀（2026-09-24 用户侧 bug：「原来我妈只」——副词「原来」与后文
// 拼成碎片，整词表只拦「原来」本体拦不住拼接）。与 TIME_PREFIX 同款逻辑：名词以这些词开头
// 且更长即否决；原野/本田/来福类不含此前缀不受误伤
const ADVERB_PREFIX = ['原来', '原本', '本来']"""

OP5_OLD = """  // 以时间词开头 → 正则过度捕获的产物（如「今天杨帆」），不是完整名词
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return false
  }"""

OP5_NEW = """  // 以时间词开头 → 正则过度捕获的产物（如「今天杨帆」），不是完整名词
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return false
  }
  // [entity-advprefix-v1] 副词开头碎片（原来X/原本X/本来X）→ 不是名词本体
  for (let i = 0; i < ADVERB_PREFIX.length; i++) {
    if (n.length > ADVERB_PREFIX[i].length && n.indexOf(ADVERB_PREFIX[i]) === 0) return false
  }"""

OP6_OLD = """  // [entity-loc2-v1] 方位字收尾（村后/桌上/门前）→ 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false"""

OP6_NEW = """  // [entity-loc2-v1] 方位字收尾（村后/桌上/门前）→ 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false
  // [entity-tailtime-v1] 「X时」收尾（妹妹吵架时/放学时）→ 时间从句不是名词本体
  if (TAIL_TIME_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false"""

OP7_OLD = """  // [entity-loc2-v1] 同口径：方位字收尾 → 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true"""

OP7_NEW = """  // [entity-loc2-v1] 同口径：方位字收尾 → 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true
  // [entity-tailtime-v1] 同口径：「X时」收尾 → 时间从句不是名词本体
  if (TAIL_TIME_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true"""

OP8_OLD = """  // [entity-frag-v1] 连词开头碎片 / [entity-xing-v1]「X性」抽象词 → 明确不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true"""

OP8_NEW = """  // [entity-frag-v1] 连词开头碎片 / [entity-xing-v1]「X性」抽象词 → 明确不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
  // [entity-advprefix-v1] 同口径：副词开头碎片（原来X）→ 明确不是名词本体
  for (let i = 0; i < ADVERB_PREFIX.length; i++) {
    if (n.length > ADVERB_PREFIX[i].length && n.indexOf(ADVERB_PREFIX[i]) === 0) return true
  }"""

OP9_OLD = """    '- 反例：日记写"到了如今，这是她的思想" → 不提取，"如今"是时间词（如今/至今/而今）不是名词；日记写"充其量是舆论的玩偶" → 不提取，"充其量"是揣测性情态副词（充其量/顶多/至多）；时间词与情态副词一律不提取；',"""

OP9_NEW = """    '- 反例：日记写"到了如今，这是她的思想" → 不提取，"如今"是时间词（如今/至今/而今）不是名词；日记写"充其量是舆论的玩偶" → 不提取，"充其量"是揣测性情态副词（充其量/顶多/至多）；时间词与情态副词一律不提取；',
    '- 反例：日记写"妹妹吵架时是一条心的" → 不提取，"妹妹吵架时"是时间从句（X时收尾）不是名词；日记写"原来我妈只是一个平凡的女人" → 不提取，"原来"开头的串是副词+代词拼出的句子碎片根本不是名词；时间从句与副词开头的碎片一律不提取；',"""

OPS = [
    ('op1 pron2-CONNECT_WORDS', F1, OP1_OLD, OP1_NEW, 'entity-pron2-v1'),
    ('op2 tailadv2-TAIL_ADV',   F1, OP2_OLD, OP2_NEW, 'entity-tailadv2-v1'),
    ('op3 tailtime-常量',        F1, OP3_OLD, OP3_NEW, "const TAIL_TIME_CHARS = ['时']"),
    ('op4 advprefix-常量',       F1, OP4_OLD, OP4_NEW, "const ADVERB_PREFIX = ['原来', '原本', '本来']"),
    ('op5 isExplainedNoun-advprefix', F1, OP5_OLD, OP5_NEW, '副词开头碎片（原来X/原本X/本来X）→ 不是名词本体'),
    ('op6 isExplainedNoun-tailtime',  F1, OP6_OLD, OP6_NEW, '「X时」收尾（妹妹吵架时/放学时）→ 时间从句不是名词本体'),
    ('op7 isNonNounWord-tailtime',    F1, OP7_OLD, OP7_NEW, '「X时」收尾 → 时间从句不是名词本体'),
    ('op8 isNonNounWord-advprefix',   F1, OP8_OLD, OP8_NEW, '副词开头碎片（原来X）→ 明确不是名词本体'),
    ('op9 optimizeDiary-prompt',      F2, OP9_OLD, OP9_NEW, '时间从句与副词开头的碎片一律不提取'),
]

def load(path):
    raw = io.open(path, encoding='utf-8', newline='').read()
    crlf = '\r\n' in raw
    return raw, (raw.replace('\r\n', '\n') if crlf else raw), crlf

def dump(path, text_lf, crlf):
    out = text_lf.replace('\n', '\r\n') if crlf else text_lf
    io.open(path, 'w', encoding='utf-8', newline='').write(out)

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    mode = mode.lstrip('-')   # 坑12：兼容 --check / check
    if mode not in ('check', 'write', 'restore'):
        print('usage: patch_entity_pron2.py --check|--write|--restore'); sys.exit(2)

    if mode == 'restore':
        for f in (F1, F2):
            b = os.path.join(BK, os.path.basename(f))
            if os.path.exists(b):
                shutil.copy2(b, f); print('RESTORED', f, '<-', b)
            else:
                print('NO BACKUP for', f)
        return

    if mode == 'write':
        os.makedirs(BK, exist_ok=True)
        for f in (F1, F2):
            b = os.path.join(BK, os.path.basename(f))
            if not os.path.exists(b):          # 备份幂等：已存在不覆盖（保干净备份）
                shutil.copy2(f, b); print('BACKUP', f, '->', b)
            else:
                print('BACKUP exists, skip', b)

    ok = True
    for name, f, old, new, guard in OPS:
        raw, text, crlf = load(f)
        if guard in text:
            print(name, 'SKIP (guard present)'); continue
        c = text.count(old)
        if c != 1:
            print(name, 'FAIL: anchor count =', c); ok = False; continue
        if mode == 'write':
            text = text.replace(old, new)
            dump(f, text, crlf)
            _, text2, _ = load(f)
            if guard not in text2:
                print(name, 'FAIL: 写盘复核未命中 guard'); ok = False; continue
            print(name, 'OK (written & verified)')
        else:
            print(name, 'OK (anchor unique, would apply)')
    print('====', mode, 'result:', 'ALL OK' if ok else 'HAS FAIL')
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
