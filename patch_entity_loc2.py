# -*- coding: utf-8 -*-
"""
[entity-loc2-v1] 方位字收尾的方位短语否决（2026-09-24，用户侧 bug：村后）

用户侧 bug：正文「村后是一片竹林」弹出备案「村后」——「名词语素+方位字」构成方位短语，
不是名词本体；「村后是…」是存在句（某处有什么），不是定义句。

结构级修法（延续 tailadv 的尾字黑名单思路）：
- utils/entityClean.js：TAIL_LOC_CHARS（后/前/上/下/左/右/内/外/旁/侧/底）：
  名词以这些方位字**收尾** → 否决。汉中/汕头/阿里类真专名尾字（中/头/里）刻意不在表内，
  不受误伤
- cloudfunctions/optimizeDiary/index.js：prompt 反例「村后」+ 硬性要求九（需重新部署）
- tools/test_entity_features.js：新增第 16 节 6 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-loc2-backup-20260924'

TAIL_OLD = "const TAIL_ADV_CHARS = ['便', '即', '竟', '倒', '亦', '皆', '均', '先', '已', '早', '曾']"
TAIL_NEW = TAIL_OLD + """
// [entity-loc2-v1] 方位字收尾的方位短语（2026-09-24 用户侧 bug：「村后是一片竹林」弹备案
// 「村后」——「名词语素+方位字」是方位短语不是名词本体）。这些字收尾的 2~6 字串几乎
// 不可能是真专名（汉中/汕头/阿里类尾字 中/头/里 不在表内，不受误伤）
const TAIL_LOC_CHARS = ['后', '前', '上', '下', '左', '右', '内', '外', '旁', '侧', '底']"""

OPS = [
    # ---- utils/entityClean.js：TAIL_LOC_CHARS 常量 ----
    ('utils/entityClean.js', TAIL_OLD, TAIL_NEW, 'const TAIL_LOC_CHARS = ['),
    # ---- utils/entityClean.js：isExplainedNoun ----
    ('utils/entityClean.js',
     r"""  // [entity-tailadv-v1] 副词收尾（每天晚上便/风雨之后便）→ 不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false""",
     r"""  // [entity-tailadv-v1] 副词收尾（每天晚上便/风雨之后便）→ 不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false
  // [entity-loc2-v1] 方位字收尾（村后/桌上/门前）→ 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false""",
     'if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false'),
    # ---- utils/entityClean.js：isNonNounWord 同口径 ----
    ('utils/entityClean.js',
     r"""  // [entity-tailadv-v1] 同口径：副词收尾 → 明确不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true""",
     r"""  // [entity-tailadv-v1] 同口径：副词收尾 → 明确不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true
  // [entity-loc2-v1] 同口径：方位字收尾 → 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true""",
     'if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '- 反例：日记写"每天晚上便是我最放松的时刻""风雨之后便是彩虹" → 不提取，"每天晚上便""风雨之后便"是时间短语和副词"便"拼出来的碎片、不是名词；"X便是Y"是副词加判断词、不是定义句；',""",
     r"""    '- 反例：日记写"每天晚上便是我最放松的时刻""风雨之后便是彩虹" → 不提取，"每天晚上便""风雨之后便"是时间短语和副词"便"拼出来的碎片、不是名词；"X便是Y"是副词加判断词、不是定义句；',
    '- 反例：日记写"村后是一片竹林" → 不提取，"村后"是"名词语素+方位字"的方位短语、不是名词；"村后/桌上/门前/心里"这类方位短语后面跟"是"是存在句、不是定义句；',""",
     '"村后"是"名词语素+方位字"'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求九 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '补充硬性要求八：不得把时间短语（每天晚上/风雨之后/比赛结束等）与"便/即/竟/倒"等副词拼成名词；"X便是/X即是/X竟是"这类副词+判断词组合不是对名词的定义，一律不提取；',""",
     r"""    '补充硬性要求八：不得把时间短语（每天晚上/风雨之后/比赛结束等）与"便/即/竟/倒"等副词拼成名词；"X便是/X即是/X竟是"这类副词+判断词组合不是对名词的定义，一律不提取；',
    '补充硬性要求九：「名词语素+方位字」构成的方位短语（村后/桌上/门前/屋里/心里等）不是名词，一律不提取；它们后面跟"是"是存在句（某处有什么），不是定义句；',""",
     '补充硬性要求九'),
    # ---- tools/test_entity_features.js：第 16 节 ----
    ('tools/test_entity_features.js',
     r"""check('bd-8 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     r"""check('bd-8 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 16. 方位字收尾否决 [entity-loc2-v1]（2026-09-24 用户侧 bug：
   「村后是一片竹林」弹备案「村后」——方位短语不是名词，后跟「是」是存在句） ===== */
check('fw-1 方位短语「村后」不备案', entityClean.isExplainedNoun('村后', '村后是一片竹林。'), false)
check('fw-2 方位短语「桌上」不备案', entityClean.isExplainedNoun('桌上', '桌上是一杯温水。'), false)
check('fw-3 热词同口径：「村后」拒绝', entityClean.isNonNounWord('村后'), true)
check('fw-4 变体方位短语「门前」拒绝', entityClean.isNonNounWord('门前'), true)
check('fw-5 真地名「汉中」不受尾字误伤', entityClean.isNonNounWord('汉中'), false)
check('fw-6 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     'fw-1 方位短语「村后」不备案'),
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    return raw.replace('\r\n', '\n'), nl


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    files = sorted(set(op[0] for op in OPS))
    if mode == '--write':
        if os.path.isdir(BACKUP):
            print('backup exists, skip auto-backup (幂等)')
        else:
            os.makedirs(BACKUP)
            for rel in files:
                src = os.path.join(ROOT, rel)
                dst = os.path.join(BACKUP, rel.replace('/', '_'))
                open(dst, 'wb').write(open(src, 'rb').read())
            print('auto-backup -> ' + BACKUP)
    ok_all = True
    for rel in files:
        text, nl = load(rel)
        ops = [op for op in OPS if op[0] == rel]
        new_text = text
        for i, (rel_, old, new, guard) in enumerate(ops):
            a, b = (old, new) if mode != '--restore' else (new, old)
            cnt = new_text.count(a)
            gcnt = new_text.count(guard) if guard else 0
            if mode != '--restore' and guard and gcnt > 0:
                print('%-42s op%d SKIP(幂等)' % (rel, i))
            elif cnt == 1:
                new_text = new_text.replace(a, b, 1)
                print('%-42s op%d APPLIED' % (rel, i))
            elif guard and gcnt > 0:
                print('%-42s op%d SKIP(幂等)' % (rel, i))
            else:
                print('%-42s op%d FAIL 锚点命中 %d 次' % (rel, i, cnt))
                ok_all = False
        if mode in ('--write', '--restore') and new_text != text:
            out = new_text.replace('\n', nl)
            open(os.path.join(ROOT, rel), 'wb').write(out.encode('utf-8'))
    print('==== %s: %s ====' % (mode, 'OK' if ok_all else 'HAS FAIL'))
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
