# -*- coding: utf-8 -*-
"""
[entity-gate3-v1] 频率短语「每年/每次」+ 常用活动词「军训」+ 闸门否决日志（2026-09-24 晚，第三轮）

用户清缓存重编译后弹窗仍出「军训/我们这嗨达/每年一次见他」（母亲总 OK）。实测：
- 「我们这嗨达」当前代码必拦（含「我们」）——仍弹 ⇒ 手机端代码版本仍旧，急需验证手段
- 「每年一次见他」真漏洞：「每年」不在 DATE_WORDS、DATE_PAT_RE 只认「数字+年」拦不住
- 「军训」若解释恰为原文片段则合理通过（真名词），按用户「常用词不备案」原则进泛称表

修法：
- entityClean.js：DATE_WORDS 增「每年/每次」（子串拦「每年一次见他」）；NON_NOUN_WORDS 增「军训」
- write.js：备案过滤处加 [entity-gate] 否决日志（真机控制台可见 ⇒ 一眼核对代码版本）
- cloudfunctions/optimizeDiary/index.js：反例（需重新部署）
- test_entity_features.js：ex-3/4 载体换「披萨」（军训进表后不再兜底放行）+ 第 19 节 yb-1~8

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-gate3-backup-20260924'

DW_OLD = "'平日', '平时', '白天', '深夜', '半夜', '傍晚', '午后', '清早', '早晨', '凌晨']"
DW_NEW = "'平日', '平时', '白天', '深夜', '半夜', '傍晚', '午后', '清早', '早晨', '凌晨', '每年', '每次']"

JUN_OLD = "'打扫卫生', '布置',"
JUN_NEW = "'打扫卫生', '军训', '布置',"

GATE_OLD = """      const all = result.entities
        .filter(e => e.name && e.description && e.name.length >= 2 && e.name.length <= 6 && e.description.length >= 4)
        .filter(e => entityClean.isExplainedNoun(e.name, content, e.explanation || ''))"""
GATE_NEW = """      // [entity-gate3-v1] 否决日志：被闸门拦下的词条打到控制台，真机核对代码版本用
      const GATE_VER = 'gate-20260924c'
      const all = result.entities
        .filter(e => e.name && e.description && e.name.length >= 2 && e.name.length <= 6 && e.description.length >= 4)
        .filter(e => {
          const gateOk = entityClean.isExplainedNoun(e.name, content, e.explanation || '')
          if (!gateOk) console.log('[entity-gate ' + GATE_VER + '] 闸门已否决:', e.name)
          return gateOk
        })"""

CLOUD_OLD = """    '- 反例：日记写"他通常是晚上跑步""母亲总是起得很早" → 不提取，"通常"是频率副词、"母亲总"是"名词+总"的拼接碎片、都不是名词；"X总是Y""X通常是Y"不是定义句；',"""
CLOUD_NEW = CLOUD_OLD + """
    '- 反例：日记写"每年一次见他是我们家的习惯" → 不提取，"每年一次见他"是频率短语、不是名词；"军训/上课/开会"等日常活动常用词即使后面跟着解释也不要提取；',"""

EX3_OLD = "check('ex-3 空解释不据此否决（旧数据兜底）', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。', ''), true)"
EX3_NEW = "check('ex-3 空解释不据此否决（旧数据兜底）', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。', ''), true)"
EX4_OLD = "check('ex-4 旧两参签名行为不回归', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。'), true)"
EX4_NEW = "check('ex-4 旧两参签名行为不回归', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。'), true)"

TEST_OLD = """check('fq-8 变体拼接「比赛总」拒绝', entityClean.isNonNounWord('比赛总'), true)

  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')"""
TEST_NEW = """check('fq-8 变体拼接「比赛总」拒绝', entityClean.isNonNounWord('比赛总'), true)

/* ===== 19. 频率短语「每年/每次」+ 常用活动词 [entity-gate3-v1]（2026-09-24 用户侧 bug
   第三轮：「每年一次见他是我们家的习惯」弹「每年一次见他」；军训解释在原文时仍弹） ===== */
check('yb-1 频率短语「每年一次见他」不备案', entityClean.isExplainedNoun('每年一次见他', '每年一次见他是我们家的习惯。', '是我们家的习惯'), false)
check('yb-2 热词同口径：「每年一次见他」拒绝', entityClean.isNonNounWord('每年一次见他'), true)
check('yb-3 变体「每次聚会」拒绝', entityClean.isNonNounWord('每次聚会'), true)
check('yb-4 常用活动词「军训」不备案', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。'), false)
check('yb-5 热词同口径：「军训」拒绝', entityClean.isNonNounWord('军训'), true)
check('yb-6 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('yb-7 旧两参真定义不回归（新载体）', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。'), true)
check('yb-8 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)

  console.log('\\n===== 结果: pass', pass, 'fail', fail, '=====')"""

OPS = [
    ('utils/entityClean.js', DW_OLD, DW_NEW, "'每年', '每次']"),
    ('utils/entityClean.js', JUN_OLD, JUN_NEW, "'打扫卫生', '军训',"),
    ('pages/write/write.js', GATE_OLD, GATE_NEW, "GATE_VER = 'gate-20260924c'"),
    ('cloudfunctions/optimizeDiary/index.js', CLOUD_OLD, CLOUD_NEW, '"每年一次见他"是频率短语'),
    ('tools/test_entity_features.js', EX3_OLD, EX3_NEW, "isExplainedNoun('披萨', '披萨是意大利传来的美食。', '')"),
    ('tools/test_entity_features.js', EX4_OLD, EX4_NEW, "isExplainedNoun('披萨', '披萨是意大利传来的美食。')"),
    ('tools/test_entity_features.js', TEST_OLD, TEST_NEW, 'yb-1 频率短语「每年一次见他」不备案'),
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
