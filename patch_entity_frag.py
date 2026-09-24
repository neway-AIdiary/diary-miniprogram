# -*- coding: utf-8 -*-
"""
[entity-frag-v1 / entity-xing-v1] 备案提醒两类误报修复（2026-09-24，用户拍板方案 2）

用户侧 bug：原文「但总是想着自己的事情」「积极性是完全不一样的」，
弹出了「但总」「积极性」的备案提醒。
- 但总：AI 把「但总是」截成名词碎片「但总」，紧随的「是」（总是的一部分）
  恰好落进定义句引导词 → 机械校验放行。连词整词黑名单拦不住截断碎片 →
  改规则：名词首字是转折/并列连词字（但/却/而/且/虽）→ 否决
- 积极性：常用抽象名词，「X性」整类不该备案 → 名词以「性」结尾 → 否决

改动：
- utils/entityClean.js：isExplainedNoun / isNonNounWord 各加两条规则
  （isNonNounWord 同口径 → 人名热词链路一起受益）
- cloudfunctions/optimizeDiary/index.js：extractEntities prompt 加反例 +
  补充硬性要求二（治本；改后需重新上传部署）
- tools/test_entity_features.js：新增第 10 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-frag-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：常量 ----
    ('utils/entityClean.js',
     r'''const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)''',
     r'''// [entity-frag-v1] 转折/并列连词开头的「拼接碎片」（2026-09-24 用户侧 bug：AI 把「但总是想着…」
// 截成名词「但总」，紧随的「是」恰好落进定义句引导词 → 误弹备案）。
// 连词开头的 2~6 字串几乎必然是句式碎片，首字命中即否决；
// 极罕见专名会被拦（如「但丁」）——漏拦方向是「少弹提醒」，绝不误备案
const FRAG_HEAD_CHARS = ['但', '却', '而', '且', '虽']
// [entity-xing-v1] 「X性」抽象属性词整类不备案（积极性/可能性/重要性/主动性…）：
// 词典常用词，用户不会为它建档案；日记场景以「性」结尾的真实专名几乎不存在
const XING_SUFFIX = '性'

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)''',
     'const FRAG_HEAD_CHARS = ['),
    # ---- utils/entityClean.js：isExplainedNoun ----
    ('utils/entityClean.js',
     r'''  // [entity-num-v1] 数量词 → 不备案（一个/一趟/十斤/百分之一/第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return false''',
     r'''  // [entity-num-v1] 数量词 → 不备案（一个/一趟/十斤/百分之一/第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return false
  // [entity-frag-v1] 连词开头碎片（但总/却总…）→ 不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return false
  // [entity-xing-v1] 「X性」抽象属性词（积极性/可能性…）→ 整类不备案
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return false''',
     'return false\n  // [entity-frag-v1] 连词开头碎片'),
    # ---- utils/entityClean.js：isNonNounWord（人名热词同口径） ----
    ('utils/entityClean.js',
     r'''  // 数量词（一个 / 十斤 / 百分之一 / 第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return true''',
     r'''  // 数量词（一个 / 十斤 / 百分之一 / 第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return true
  // [entity-frag-v1] 连词开头碎片 / [entity-xing-v1]「X性」抽象词 → 明确不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return true''',
     'return true\n  // [entity-frag-v1] 连词开头碎片'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '- 反例：日记写"今天是四维图新入职的第一天，我没敢去的太早" → 不提取，"的第一天"带助词"的"、是短语而非名词；"四维图新"这里也只是被提到、没有解释它的含义，同样不提取；',''',
     r'''    '- 反例：日记写"今天是四维图新入职的第一天，我没敢去的太早" → 不提取，"的第一天"带助词"的"、是短语而非名词；"四维图新"这里也只是被提到、没有解释它的含义，同样不提取；',
    '- 反例：日记写"但总是想着自己的事情，积极性是完全不一样的" → 不提取，"但总"是转折词"但"和副词"总是"被截出来的碎片、不是名词；"积极性"是常用抽象名词——这类词即使后面紧跟"是"，也不是被解释的专名；',''',
     '"但总"是转折词"但"和副词"总是"被截出来的碎片'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 硬性要求 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '补充硬性要求：name 必须是原文中真实出现的专有名词本体，绝不能是"分别/一共/然后/大概/可能/都/也/还/其中/主要"这类虚词、副词、连接词；name 里不得含"的/了/是"等助词；判断"是否被解释"时，必须是「名词 + 是/叫/就是…」这种针对该名词本体的定义句式，不能把名词后面任意一段文字当成解释；',''',
     r'''    '补充硬性要求：name 必须是原文中真实出现的专有名词本体，绝不能是"分别/一共/然后/大概/可能/都/也/还/其中/主要"这类虚词、副词、连接词；name 里不得含"的/了/是"等助词；判断"是否被解释"时，必须是「名词 + 是/叫/就是…」这种针对该名词本体的定义句式，不能把名词后面任意一段文字当成解释；',
    '补充硬性要求二：不要提取以"性"结尾的常用抽象名词（积极性/可能性/重要性/主动性/灵活性等）；也不要把转折词、副词和后面的文字拼接成碎片当名词（如"但总是…"绝不能截出"但总"）；',''',
     '补充硬性要求二'),
    # ---- tools/test_entity_features.js：第 10 节 ----
    ('tools/test_entity_features.js',
     r'''check('ng-26 正例「三里屯」不受数量词规则影响', entityClean.isExplainedNoun('三里屯', '三里屯是我们常去的商场。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')''',
     r'''check('ng-26 正例「三里屯」不受数量词规则影响', entityClean.isExplainedNoun('三里屯', '三里屯是我们常去的商场。'), true)

/* ===== 10. 连词碎片与抽象属性词 [entity-frag-v1/entity-xing-v1]（2026-09-24 用户侧 bug：
   「但总是想着自己的事情」弹出备案「但总」；「积极性是完全不一样的」弹出备案「积极性」） ===== */
check('fg-1 连词碎片「但总」不备案', entityClean.isExplainedNoun('但总', '但总是想着自己的事情。'), false)
check('fg-2 抽象属性词「积极性」不备案', entityClean.isExplainedNoun('积极性', '积极性是完全不一样的。'), false)
check('fg-3 同整类「可能性」不备案', entityClean.isExplainedNoun('可能性', '可能性是有的。'), false)
check('fg-4 连词碎片「却总」同样拦截', entityClean.isExplainedNoun('却总', '却总是另一番景象。'), false)
check('fg-5 正例「张总」不受碎片规则影响', entityClean.isExplainedNoun('张总', '张总是我们部门的经理。'), true)
check('fg-6 人名热词同口径：碎片「但总」被拒', entityClean.isNonNounWord('但总'), true)
check('fg-7 人名热词同口径：「积极性」被拒', entityClean.isNonNounWord('积极性'), true)
check('fg-8 已知拦截不回归：简直/一个仍拒绝', entityClean.isNonNounWord('简直') && entityClean.isNonNounWord('一个'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')''',
     "fg-1 连词碎片「但总」不备案"),
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
            # guard 优先：追加型 op 的锚点在写入后依然存在（坑 #6 变体），
            # guard 均取 new 独有串，命中即已应用；--restore 模式不适用（盘上必有 guard）。
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
