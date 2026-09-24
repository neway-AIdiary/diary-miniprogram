# -*- coding: utf-8 -*-
"""
[entity-loc-v1] 方位词/方位名词整类不备案（2026-09-24，用户指令：以下）

用户侧 bug：正文「以下是为你介绍的高中日记10000字」弹出备案「以下」。
方位词不是名词本体；用户定调：只有人名、地名、事物名称、专用名词才解释备案。

改动：
- utils/entityClean.js：NON_NOUN_WORDS 增补方位词族（以下/以上/以内/旁边/周围…23 词），
  isNonNounWord 复用同表自动同口径
- cloudfunctions/optimizeDiary/index.js：prompt 加「以下」真实反例 + 补充硬性要求七
  （只提取人名/地名/机构名/物品名/专用名词等真正的名词；需重新部署）
- tools/test_entity_features.js：新增第 14 节 6 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-loc-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：NON_NOUN_WORDS 增补方位词族 ----
    ('utils/entityClean.js',
     r"""  '公司', '学校', '单位', '朋友', '同事', '同学', '孩子', '家里', '工作', '生活', '状态', '心情', '感觉', '计划', '安排',""",
     r"""  '公司', '学校', '单位', '朋友', '同事', '同学', '孩子', '家里', '工作', '生活', '状态', '心情', '感觉', '计划', '安排',
  // [entity-loc-v1] 方位词/方位名词整类不备案（2026-09-24 用户指令：「以下是为你介绍的
  // 高中日记10000字」弹备案「以下」——只有人名/地名/事物名称/专用名词才备案）
  '以下', '以上', '以内', '以外', '之外', '中间', '当中', '上方', '下方', '前方', '后方', '左侧', '右侧', '旁边', '四周', '周围', '对面', '上边', '下边', '前边', '后边', '里边', '外边',""",
     "'以下', '以上', '以内'"),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '- 反例：日记写"可正是水的柔和善变造就了它自身的魅力""因此我们总是让一天的时间匆匆而来" → 不提取，"可正"是语气副词"可"和"正是"被截出来的碎片、"因此我们总"是连词+代词+副词拼出来的碎片，都不是名词；绝不能把语气副词、连词、代词和后文拼成名词；',""",
     r"""    '- 反例：日记写"可正是水的柔和善变造就了它自身的魅力""因此我们总是让一天的时间匆匆而来" → 不提取，"可正"是语气副词"可"和"正是"被截出来的碎片、"因此我们总"是连词+代词+副词拼出来的碎片，都不是名词；绝不能把语气副词、连词、代词和后文拼成名词；',
    '- 反例：日记写"以下是为你介绍的高中日记10000字" → 不提取，"以下"是方位词、不是名词；只有人名/地名/事物名称/专用名词才需要提取备案；',""",
     '"以下"是方位词'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求七 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '补充硬性要求六：name 绝不能是虚词拼接碎片——不得以"可/竟/倒/便"等语气副词开头，不得含"因此/但是/因为/所以/虽然/然后/我们/他们/自己"等连词、代词成分；这些碎片即使后面紧跟"是"也不是被解释的名词；',""",
     r"""    '补充硬性要求六：name 绝不能是虚词拼接碎片——不得以"可/竟/倒/便"等语气副词开头，不得含"因此/但是/因为/所以/虽然/然后/我们/他们/自己"等连词、代词成分；这些碎片即使后面紧跟"是"也不是被解释的名词；',
    '补充硬性要求七：只提取人名、地名、机构名、物品名、专用名词等真正的名词；方位词（以下/以上/以内/之外/旁边/周围等）和其他常用泛词一律不提取，即使后面紧跟"是"也不是定义；',""",
     '补充硬性要求七'),
    # ---- tools/test_entity_features.js：第 14 节 ----
    ('tools/test_entity_features.js',
     r"""check('kd-8 变体碎片「所以我们」拒绝', entityClean.isNonNounWord('所以我们'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     r"""check('kd-8 变体碎片「所以我们」拒绝', entityClean.isNonNounWord('所以我们'), true)

/* ===== 14. 方位词整类不备案 [entity-loc-v1]（2026-09-24 用户指令：
   「以下是为你介绍的高中日记10000字」弹备案「以下」——只有人名/地名/事物名/专用名词才备案） ===== */
check('lw-1 方位词「以下」不备案', entityClean.isExplainedNoun('以下', '以下是为你介绍的高中日记10000字。'), false)
check('lw-2 方位词「以上」不备案', entityClean.isExplainedNoun('以上', '以上是我的全部交代。'), false)
check('lw-3 方位词「旁边」不备案', entityClean.isExplainedNoun('旁边', '旁边是王磊的座位。'), false)
check('lw-4 热词同口径：方位词「以下」拒绝', entityClean.isNonNounWord('以下'), true)
check('lw-5 真地名「中关村」不回归', entityClean.isExplainedNoun('中关村', '中关村是我们的科技园区。'), true)
check('lw-6 真名「王磊」不回归', entityClean.isNonNounWord('王磊'), false)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     "lw-1 方位词「以下」不备案"),
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
