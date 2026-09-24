# -*- coding: utf-8 -*-
"""
[entity-tailadv-v1] 副词收尾碎片 + 频率时间词（2026-09-24，用户侧 bug：每天晚上便 / 风雨之后便）

用户侧 bug：弹备案「每天晚上便」「风雨之后便」——AI 把时间短语与副词「便」拼成名词，
紧随的「是」构成「便是/即是」被当成定义句引导词。用户要求一次解决这一类。

结构级修法（不再逐词）：
- utils/entityClean.js：
  ① TAIL_ADV_CHARS（便/即/竟/倒/亦/皆/均/先/已/早/曾）：名词以这些副词字**收尾** → 否决。
    张总/李总类称呼（尾字「总」）与常见人名尾字（刚/正/永/常…）不在表内，不受误伤
  ② DATE_WORDS 增补频率时间词（每天/每日/天天/整天/当天/次日/翌日/日后/白天/深夜…），
    子串匹配自动覆盖「每天晚上便」
  isExplainedNoun / isNonNounWord 双口同径
- cloudfunctions/optimizeDiary/index.js：prompt 反例 + 硬性要求八（需重新部署）
- tools/test_entity_features.js：新增第 15 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-tailadv-backup-20260924'

DATE_OLD = "const DATE_WORDS = ['今天', '明天', '昨天', '今日', '明日', '昨日', '后日', '后天', '前天', '今年', '去年', '明年', '前年', '当年', '当时', '现在', '目前', '今晚', '明晚', '昨晚', '本月', '上月', '下月', '本周', '上周', '下周', '周末', '年初', '年底', '月初', '月末']"
DATE_NEW = """// [entity-tailadv-v1] 增补频率/时段时间词（2026-09-24「每天晚上便」碎片：含「每天」即否决）
const DATE_WORDS = ['今天', '明天', '昨天', '今日', '明日', '昨日', '后日', '后天', '前天', '今年', '去年', '明年', '前年', '当年', '当时', '现在', '目前', '今晚', '明晚', '昨晚', '本月', '上月', '下月', '本周', '上周', '下周', '周末', '年初', '年底', '月初', '月末', '每天', '每日', '天天', '整天', '当天', '当日', '次日', '翌日', '日后', '平日', '平时', '白天', '深夜', '半夜', '傍晚', '午后', '清早', '早晨', '凌晨']"""

CONN_OLD = "const CONNECT_WORDS = ['因此', '但是', '可是', '因为', '所以', '虽然', '然而', '不过', '然后', '于是', '而且', '并且', '或者', '如果', '既然', '尽管', '即使', '无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己']"
CONN_NEW = CONN_OLD + """
// [entity-tailadv-v1] 副词收尾的「X便/X即」碎片（2026-09-24 用户侧 bug：「每天晚上便」
// 「风雨之后便」——AI 把时间短语与副词「便」拼成名词，紧随的「是」构成「便是/即是」
// 被当成定义句）。以这些字收尾的 2~6 字串几乎必然是碎片；张总/李总类称呼（尾字「总」）
// 与常见人名尾字（刚/正/永/常…）不在表内，不受误伤
const TAIL_ADV_CHARS = ['便', '即', '竟', '倒', '亦', '皆', '均', '先', '已', '早', '曾']"""

OPS = [
    # ---- utils/entityClean.js：DATE_WORDS 增补频率时间词 ----
    ('utils/entityClean.js', DATE_OLD, DATE_NEW, "'天天', '整天'"),
    # ---- utils/entityClean.js：TAIL_ADV_CHARS 常量 ----
    ('utils/entityClean.js', CONN_OLD, CONN_NEW, "const TAIL_ADV_CHARS = ["),
    # ---- utils/entityClean.js：isExplainedNoun ----
    ('utils/entityClean.js',
     r"""  // [entity-frag2-v1] 含连词/代词成分（因此我们总）→ 拼接碎片不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return false
  }""",
     r"""  // [entity-frag2-v1] 含连词/代词成分（因此我们总）→ 拼接碎片不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return false
  }
  // [entity-tailadv-v1] 副词收尾（每天晚上便/风雨之后便）→ 不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false""",
     'if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false'),
    # ---- utils/entityClean.js：isNonNounWord 同口径 ----
    ('utils/entityClean.js',
     r"""  // [entity-frag2-v1] 同口径：含连词/代词成分 → 明确不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return true
  }""",
     r"""  // [entity-frag2-v1] 同口径：含连词/代词成分 → 明确不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return true
  }
  // [entity-tailadv-v1] 同口径：副词收尾 → 明确不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true""",
     'if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '- 反例：日记写"以下是为你介绍的高中日记10000字" → 不提取，"以下"是方位词、不是名词；只有人名/地名/事物名称/专用名词才需要提取备案；',""",
     r"""    '- 反例：日记写"以下是为你介绍的高中日记10000字" → 不提取，"以下"是方位词、不是名词；只有人名/地名/事物名称/专用名词才需要提取备案；',
    '- 反例：日记写"每天晚上便是我最放松的时刻""风雨之后便是彩虹" → 不提取，"每天晚上便""风雨之后便"是时间短语和副词"便"拼出来的碎片、不是名词；"X便是Y"是副词加判断词、不是定义句；',""",
     '"每天晚上便""风雨之后便"是时间短语'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求八 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '补充硬性要求七：只提取人名、地名、机构名、物品名、专用名词等真正的名词；方位词（以下/以上/以内/之外/旁边/周围等）和其他常用泛词一律不提取，即使后面紧跟"是"也不是定义；',""",
     r"""    '补充硬性要求七：只提取人名、地名、机构名、物品名、专用名词等真正的名词；方位词（以下/以上/以内/之外/旁边/周围等）和其他常用泛词一律不提取，即使后面紧跟"是"也不是定义；',
    '补充硬性要求八：不得把时间短语（每天晚上/风雨之后/比赛结束等）与"便/即/竟/倒"等副词拼成名词；"X便是/X即是/X竟是"这类副词+判断词组合不是对名词的定义，一律不提取；',""",
     '补充硬性要求八'),
    # ---- tools/test_entity_features.js：第 15 节 ----
    ('tools/test_entity_features.js',
     r"""check('lw-6 真名「王磊」不回归', entityClean.isNonNounWord('王磊'), false)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     r"""check('lw-6 真名「王磊」不回归', entityClean.isNonNounWord('王磊'), false)

/* ===== 15. 副词收尾碎片 + 频率时间词 [entity-tailadv-v1]（2026-09-24 用户侧 bug：
   「每天晚上便」「风雨之后便」——时间短语+副词「便」的拼接碎片） ===== */
check('bd-1 「每天晚上便」不备案', entityClean.isExplainedNoun('每天晚上便', '每天晚上便是我最放松的时刻。'), false)
check('bd-2 「风雨之后便」不备案', entityClean.isExplainedNoun('风雨之后便', '风雨之后便是彩虹出现的时刻。'), false)
check('bd-3 热词同口径：「每天晚上便」拒绝', entityClean.isNonNounWord('每天晚上便'), true)
check('bd-4 热词同口径：「风雨之后便」拒绝', entityClean.isNonNounWord('风雨之后便'), true)
check('bd-5 频率时间词「每天」不备案', entityClean.isExplainedNoun('每天', '每天是我最忙的时候。'), false)
check('bd-6 变体碎片「比赛之即」拒绝', entityClean.isNonNounWord('比赛之即'), true)
check('bd-7 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)
check('bd-8 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     'bd-1 「每天晚上便」不备案'),
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
