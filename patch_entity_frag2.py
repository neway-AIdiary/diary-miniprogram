# -*- coding: utf-8 -*-
"""
[entity-frag2-v1] 语气副词/连词代词拼接碎片否决（2026-09-24，用户侧 bug：可正 / 因此我们总）

用户侧 bug：正文「可正是水的柔和善变造就了它自身的魅力」「因此我们总是让一天的时间
匆匆而来」分别弹出备案「可正」「因此我们总」。
- 「可正」= 语气副词「可」+「正(是)」的碎片，首字黑名单（但/却/而/且/虽）没有「可」；
- 「因此我们总」= 连词+代词+副词的复合碎片，「因此」在整词黑名单里但拦不住含它的复合串
  （与「晴今天」同一族漏洞）。

改动：
- utils/entityClean.js：FRAG_HEAD_CHARS 增补语气副词字（可/竟/倒/便）；新增 CONNECT_WORDS
  （连词/代词成分，**子串匹配**即否决——只收几乎不可能出现在真专名里的词，
  果然/简直这类可入名的词仍保持整词匹配）；isExplainedNoun 与 isNonNounWord 同口径
- cloudfunctions/optimizeDiary/index.js：prompt 加两条真实反例 + 补充硬性要求六（需重新部署）
- tools/test_entity_features.js：新增第 13 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-frag2-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：FRAG_HEAD_CHARS 增补语气副词 ----
    ('utils/entityClean.js',
     r"""const FRAG_HEAD_CHARS = ['但', '却', '而', '且', '虽']""",
     r"""// [entity-frag2-v1] 语气副词开头（可/竟/倒/便）同类碎片（2026-09-24「可正是…」截出「可正」）
const FRAG_HEAD_CHARS = ['但', '却', '而', '且', '虽', '可', '竟', '倒', '便']""",
     "语气副词开头（可/竟/倒/便）同类碎片"),
    # ---- utils/entityClean.js：CONNECT_WORDS 常量 ----
    ('utils/entityClean.js',
     r"""const DATE_PAT_RE = /[0-9零〇一二三四五六七八九十]+(年|月|日|号)/""",
     r"""const DATE_PAT_RE = /[0-9零〇一二三四五六七八九十]+(年|月|日|号)/
// [entity-frag2-v1] 连词/代词成分的复合碎片（2026-09-24 用户侧 bug：「因此我们总」——
// 连词+代词+副词拼出的碎片，整词黑名单只做精确匹配拦不住）。含下列成分（子串）即否决：
// 只收「几乎不可能出现在真专名里」的连词与代词；果然/简直这类可入名的词仍保持整词匹配
const CONNECT_WORDS = ['因此', '但是', '可是', '因为', '所以', '虽然', '然而', '不过', '然后', '于是', '而且', '并且', '或者', '如果', '既然', '尽管', '即使', '无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己']""",
     "const CONNECT_WORDS = ["),
    # ---- utils/entityClean.js：isExplainedNoun ----
    ('utils/entityClean.js',
     r"""  if (DATE_PAT_RE.test(n)) return false""",
     r"""  if (DATE_PAT_RE.test(n)) return false
  // [entity-frag2-v1] 含连词/代词成分（因此我们总）→ 拼接碎片不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return false
  }""",
     "if (n.indexOf(CONNECT_WORDS[i]) !== -1) return false"),
    # ---- utils/entityClean.js：isNonNounWord 同口径 ----
    ('utils/entityClean.js',
     r"""  if (DATE_PAT_RE.test(n)) return true""",
     r"""  if (DATE_PAT_RE.test(n)) return true
  // [entity-frag2-v1] 同口径：含连词/代词成分 → 明确不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return true
  }""",
     "if (n.indexOf(CONNECT_WORDS[i]) !== -1) return true"),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '- 反例：日记正文开头是日期头"2023年10月2日 星期一 晴今天是一年一度的九月会" → 不提取，"晴今天"是天气字"晴"和时间词"今天"拼出来的碎片、不是名词；日期/时间表达（今天/昨天/明天/2023年5月/3月8日等）以及它们与其他字拼成的碎片一律不提取；',""",
     r"""    '- 反例：日记正文开头是日期头"2023年10月2日 星期一 晴今天是一年一度的九月会" → 不提取，"晴今天"是天气字"晴"和时间词"今天"拼出来的碎片、不是名词；日期/时间表达（今天/昨天/明天/2023年5月/3月8日等）以及它们与其他字拼成的碎片一律不提取；',
    '- 反例：日记写"可正是水的柔和善变造就了它自身的魅力""因此我们总是让一天的时间匆匆而来" → 不提取，"可正"是语气副词"可"和"正是"被截出来的碎片、"因此我们总"是连词+代词+副词拼出来的碎片，都不是名词；绝不能把语气副词、连词、代词和后文拼成名词；',""",
     '"可正"是语气副词'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求六 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '补充硬性要求五：绝不提取日期、时间词及其任何拼接碎片——今天/明天/昨天/今日/明日/去年/今年/前天/后天等时间词、2023年5月/3月8日/10月1日等日期表达、以及天气字或其他内容与时间词拼成的串（如"晴今天"）都不是名词本体，一律不提取；',""",
     r"""    '补充硬性要求五：绝不提取日期、时间词及其任何拼接碎片——今天/明天/昨天/今日/明日/去年/今年/前天/后天等时间词、2023年5月/3月8日/10月1日等日期表达、以及天气字或其他内容与时间词拼成的串（如"晴今天"）都不是名词本体，一律不提取；',
    '补充硬性要求六：name 绝不能是虚词拼接碎片——不得以"可/竟/倒/便"等语气副词开头，不得含"因此/但是/因为/所以/虽然/然后/我们/他们/自己"等连词、代词成分；这些碎片即使后面紧跟"是"也不是被解释的名词；',""",
     '补充硬性要求六'),
    # ---- tools/test_entity_features.js：第 13 节 ----
    ('tools/test_entity_features.js',
     r"""check('dt-8 真专名「五羊城」不受日期模式影响', entityClean.isExplainedNoun('五羊城', '五羊城是我们的老城区。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     r"""check('dt-8 真专名「五羊城」不受日期模式影响', entityClean.isExplainedNoun('五羊城', '五羊城是我们的老城区。'), true)

/* ===== 13. 语气副词/连词代词拼接碎片否决 [entity-frag2-v1]（2026-09-24 用户侧 bug：
   「可正」「因此我们总」——语气副词开头碎片；连词+代词+副词复合碎片） ===== */
check('kd-1 语气副词碎片「可正」不备案', entityClean.isExplainedNoun('可正', '可正是水的柔和善变造就了它自身的魅力。'), false)
check('kd-2 复合碎片「因此我们总」不备案', entityClean.isExplainedNoun('因此我们总', '因此我们总是让一天的时间匆匆而来。'), false)
check('kd-3 热词同口径：「可正」拒绝', entityClean.isNonNounWord('可正'), true)
check('kd-4 热词同口径：「因此我们总」拒绝', entityClean.isNonNounWord('因此我们总'), true)
check('kd-5 真名「王磊」不受连词子串误伤', entityClean.isNonNounWord('王磊'), false)
check('kd-6 真专名「果然山」不回归', entityClean.isExplainedNoun('果然山', '果然山是我们村后的大山。'), true)
check('kd-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('kd-8 变体碎片「所以我们」拒绝', entityClean.isNonNounWord('所以我们'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     "kd-1 语气副词碎片「可正」不备案"),
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
