# -*- coding: utf-8 -*-
"""
[entity-freq-v1] 频率/情态副词成分 + 「名词+总」拼接碎片否决（2026-09-24，用户侧 bug 第二轮）

用户已部署云函数并重编译，弹窗仍出现「军训/我们这嗨达/通常/母亲总」。
本地实测：当前代码四条全被拦（前三条靠解释核对，「通常/母亲总」词形规则拦不住、
空解释时仍会放行）——用户端极可能在跑旧编译包。本补丁做词形双保险：
- utils/entityClean.js：FREQ_ADV_WORDS（通常/总是/经常/常常/往往/从来/偶尔/偶然/
  有时/一直/似乎/仿佛）子串否决 + 3 字以上以「总」收尾否决（张总/李总 2 字称呼保留）
- cloudfunctions/optimizeDiary/index.js：反例 + 硬性要求十一（需重新部署）
- tools/test_entity_features.js：新增第 18 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-freq-backup-20260924'

CW_OLD = "const CONNECT_WORDS = ['因此', '但是', '可是', '因为', '所以', '虽然', '然而', '不过', '然后', '于是', '而且', '并且', '或者', '如果', '既然', '尽管', '即使', '无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己', '另外']"
CW_NEW = CW_OLD + """
// [entity-freq-v1] 频率/情态副词成分（2026-09-24 用户侧 bug 第二轮：「他通常是晚上跑步」
// 弹「通常」、「母亲总是起得很早」弹「母亲总」——副词本体或「名词+副词」拼接碎片，
// 紧随的「是」凑成定义句形状）。含下列成分（子串）即否决；表内词不会出现在真专名中
const FREQ_ADV_WORDS = ['通常', '总是', '经常', '常常', '往往', '从来', '偶尔', '偶然', '有时', '一直', '似乎', '仿佛']"""

EXPL_OLD = """  // [entity-tailadv-v1] 副词收尾（每天晚上便/风雨之后便）→ 不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false"""
EXPL_NEW = """  // [entity-freq-v1] 含频率/情态副词成分（通常/母亲总）→ 拼接碎片不是名词本体
  for (let i = 0; i < FREQ_ADV_WORDS.length; i++) {
    if (n.indexOf(FREQ_ADV_WORDS[i]) !== -1) return false
  }
  // 3 字以上以「总」收尾（母亲总/我们总）→ 拼接碎片；张总/李总类 2 字称呼保留
  if (n.length >= 3 && n.charAt(n.length - 1) === '总') return false
""" + EXPL_OLD

NONNOUN_OLD = """  // [entity-tailadv-v1] 同口径：副词收尾 → 明确不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true"""
NONNOUN_NEW = """  // [entity-freq-v1] 同口径：含频率/情态副词成分 → 明确不是名词本体
  for (let i = 0; i < FREQ_ADV_WORDS.length; i++) {
    if (n.indexOf(FREQ_ADV_WORDS[i]) !== -1) return true
  }
  // 3 字以上以「总」收尾（母亲总/我们总）→ 拼接碎片；张总/李总类 2 字称呼保留
  if (n.length >= 3 && n.charAt(n.length - 1) === '总') return true
""" + NONNOUN_OLD

CLOUD_EXPL_OLD = """    '- 反例：日记写"村后是一片竹林" → 不提取，"村后"是"名词语素+方位字"的方位短语、不是名词；"村后/桌上/门前/心里"这类方位短语后面跟"是"是存在句、不是定义句；',"""
CLOUD_EXPL_NEW = CLOUD_EXPL_OLD + """
    '- 反例：日记写"他通常是晚上跑步""母亲总是起得很早" → 不提取，"通常"是频率副词、"母亲总"是"名词+总"的拼接碎片、都不是名词；"X总是Y""X通常是Y"不是定义句；',"""

CLOUD_REQ_OLD = """    '补充硬性要求十：explanation 字段必须是原文中逐字存在的片段（一般是名词后面的解释句）；原文里找不到的解释一律不要编造；泛指短语（另外一项任务/一个计划类）和副词（仅仅/单单）即使后面跟"是"也不要提取；',"""
CLOUD_REQ_NEW = CLOUD_REQ_OLD + """
    '补充硬性要求十一：绝不提取频率/情态副词及其拼接碎片——"通常/总是/经常/常常/往往/从来/偶尔/一直/似乎"这类副词、"母亲总/我们总/比赛总"这类以"总"收尾的3字以上拼接都不是名词本体，一律不提取；',"""

TEST_OLD = """check('ex-8 热词同口径：「仅仅」拒绝', entityClean.isNonNounWord('仅仅'), true)

  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')"""
TEST_NEW = """check('ex-8 热词同口径：「仅仅」拒绝', entityClean.isNonNounWord('仅仅'), true)

/* ===== 18. 频率副词成分 + 「名词+总」拼接否决 [entity-freq-v1]（2026-09-24 用户侧 bug
   第二轮：「他通常是晚上跑步」弹「通常」、「母亲总是起得很早」弹「母亲总」） ===== */
check('fq-1 副词「通常」不备案', entityClean.isExplainedNoun('通常', '他通常是晚上跑步。'), false)
check('fq-2 拼接碎片「母亲总」不备案', entityClean.isExplainedNoun('母亲总', '母亲总是起得很早。'), false)
check('fq-3 幻觉解释双保险：「通常」仍拦', entityClean.isExplainedNoun('通常', '他通常是晚上跑步。', '选择显示为该人记忆的意志'), false)
check('fq-4 热词同口径：「通常」拒绝', entityClean.isNonNounWord('通常'), true)
check('fq-5 热词同口径：「母亲总」拒绝', entityClean.isNonNounWord('母亲总'), true)
check('fq-6 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)
check('fq-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('fq-8 变体拼接「比赛总」拒绝', entityClean.isNonNounWord('比赛总'), true)

  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')"""

OPS = [
    # ---- utils/entityClean.js：FREQ_ADV_WORDS 常量 ----
    ('utils/entityClean.js', CW_OLD, CW_NEW, 'const FREQ_ADV_WORDS = ['),
    # ---- utils/entityClean.js：isExplainedNoun ----
    ('utils/entityClean.js', EXPL_OLD, EXPL_NEW,
     "if (n.length >= 3 && n.charAt(n.length - 1) === '总') return false"),
    # ---- utils/entityClean.js：isNonNounWord 同口径 ----
    ('utils/entityClean.js', NONNOUN_OLD, NONNOUN_NEW,
     "if (n.length >= 3 && n.charAt(n.length - 1) === '总') return true"),
    # ---- cloudfunctions/optimizeDiary/index.js：反例 ----
    ('cloudfunctions/optimizeDiary/index.js', CLOUD_EXPL_OLD, CLOUD_EXPL_NEW,
     '"母亲总"是"名词+总"的拼接碎片'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求十一 ----
    ('cloudfunctions/optimizeDiary/index.js', CLOUD_REQ_OLD, CLOUD_REQ_NEW,
     '补充硬性要求十一'),
    # ---- tools/test_entity_features.js：第 18 节 ----
    ('tools/test_entity_features.js', TEST_OLD, TEST_NEW,
     'fq-1 副词「通常」不备案'),
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
            print('backup exists, skip auto-backup (idempotent)')
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
                print('%-42s op%d SKIP(idempotent)' % (rel, i))
            elif cnt == 1:
                new_text = new_text.replace(a, b, 1)
                print('%-42s op%d APPLIED' % (rel, i))
            elif guard and gcnt > 0:
                print('%-42s op%d SKIP(idempotent)' % (rel, i))
            else:
                print('%-42s op%d FAIL anchor hit %d times' % (rel, i, cnt))
                ok_all = False
        if mode in ('--write', '--restore') and new_text != text:
            out = new_text.replace('\n', nl)
            open(os.path.join(ROOT, rel), 'wb').write(out.encode('utf-8'))
    print('==== %s: %s ====' % (mode, 'OK' if ok_all else 'HAS FAIL'))
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
