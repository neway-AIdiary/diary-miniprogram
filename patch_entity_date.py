# -*- coding: utf-8 -*-
"""
[entity-date-v1] 日期/时间词整类不备案（2026-09-24，用户侧 bug：晴今天）

用户侧 bug：正文带日期头「2023年10月2日 星期一 晴今天是一年一度的九月会。」，
AI 把天气字「晴」和「今天」拼成名词「晴今天」弹出备案。两个问题：
① 「晴今天」不是名词本体（词表整词匹配拦不住含「今天」的复合碎片）；
② 日期类表达（今天/昨天/明天/2023年5月/3月8日…）整类不该备案。

改动：
- utils/entityClean.js：新增 DATE_WORDS（含时间词子串即否决）+ DATE_PAT_RE
  （数字/汉字 + 年/月/日/号 日期模式否决）；isExplainedNoun 与 isNonNounWord 同口径
- cloudfunctions/optimizeDiary/index.js：prompt 加「晴今天」真实反例 + 补充硬性要求五
  （治本；改后需重新上传部署）
- tools/test_entity_features.js：新增第 12 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-date-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：常量 ----
    ('utils/entityClean.js',
     r"""const XING_SUFFIX = '性'
""",
     r"""const XING_SUFFIX = '性'
// [entity-date-v1] 日期/时间词整类不备案（2026-09-24 用户侧 bug：「晴今天」——AI 把
// 日期头天气字「晴」与「今天」拼成碎片，整词表只做精确匹配拦不住复合碎片）。
// ① 名词含时间词（子串匹配）即否决；② 数字/汉字 + 年/月/日/号 日期模式否决。
// 漏拦方向：少弹提醒，绝不误备案
const DATE_WORDS = ['今天', '明天', '昨天', '今日', '明日', '昨日', '后日', '后天', '前天', '今年', '去年', '明年', '前年', '当年', '当时', '现在', '目前', '今晚', '明晚', '昨晚', '本月', '上月', '下月', '本周', '上周', '下周', '周末', '年初', '年底', '月初', '月末']
const DATE_PAT_RE = /[0-9零〇一二三四五六七八九十]+(年|月|日|号)/
""",
     "const DATE_WORDS = ["),
    # ---- utils/entityClean.js：isExplainedNoun ----
    ('utils/entityClean.js',
     r"""  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return false
""",
     r"""  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return false
  // [entity-date-v1] 含日期/时间词或日期模式（晴今天/2023年5月/3月8日）→ 不是名词本体
  for (let i = 0; i < DATE_WORDS.length; i++) {
    if (n.indexOf(DATE_WORDS[i]) !== -1) return false
  }
  if (DATE_PAT_RE.test(n)) return false
""",
     'if (DATE_PAT_RE.test(n)) return false'),
    # ---- utils/entityClean.js：isNonNounWord 同口径 ----
    ('utils/entityClean.js',
     r"""  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return true
""",
     r"""  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return true
  // [entity-date-v1] 同口径：含日期/时间词或日期模式 → 明确不是名词本体
  for (let i = 0; i < DATE_WORDS.length; i++) {
    if (n.indexOf(DATE_WORDS[i]) !== -1) return true
  }
  if (DATE_PAT_RE.test(n)) return true
""",
     'if (DATE_PAT_RE.test(n)) return true'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '- 反例：日记写"妈妈说这是豆子在呼吸" → 不提取，"妈妈说这"是言说动词"说"和代词"这"拼出来的叙述碎片、根本不是名词；"豆子"也只是被提到、没有解释它是什么；',""",
     r"""    '- 反例：日记写"妈妈说这是豆子在呼吸" → 不提取，"妈妈说这"是言说动词"说"和代词"这"拼出来的叙述碎片、根本不是名词；"豆子"也只是被提到、没有解释它是什么；',
    '- 反例：日记正文开头是日期头"2023年10月2日 星期一 晴今天是一年一度的九月会" → 不提取，"晴今天"是天气字"晴"和时间词"今天"拼出来的碎片、不是名词；日期/时间表达（今天/昨天/明天/2023年5月/3月8日等）以及它们与其他字拼成的碎片一律不提取；',""",
     '"晴今天"是天气字'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求五 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r"""    '补充硬性要求四：「说的是/告诉我是/写的是/画的是/描述的是」等转述句式，后面跟的是说话内容、不是对名词的定义，一律不提取；name 本体绝不能含"说/讲/写/画/描述/告诉"等动词或以"这/那"结尾；',""",
     r"""    '补充硬性要求四：「说的是/告诉我是/写的是/画的是/描述的是」等转述句式，后面跟的是说话内容、不是对名词的定义，一律不提取；name 本体绝不能含"说/讲/写/画/描述/告诉"等动词或以"这/那"结尾；',
    '补充硬性要求五：绝不提取日期、时间词及其任何拼接碎片——今天/明天/昨天/今日/明日/去年/今年/前天/后天等时间词、2023年5月/3月8日/10月1日等日期表达、以及天气字或其他内容与时间词拼成的串（如"晴今天"）都不是名词本体，一律不提取；',""",
     '补充硬性要求五'),
    # ---- tools/test_entity_features.js：第 12 节 ----
    ('tools/test_entity_features.js',
     r"""check('cp-17 转述之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     r"""check('cp-17 转述之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 12. 日期/时间词整类不备案 [entity-date-v1]（2026-09-24 用户侧 bug：
   「晴今天」——天气字与时间词的拼接碎片；日期类表达整类不该备案） ===== */
check('dt-1 拼接碎片「晴今天」不备案', entityClean.isExplainedNoun('晴今天', '2023年10月2日 星期一 晴今天是一年一度的九月会。'), false)
check('dt-2 整词「今天」不备案', entityClean.isExplainedNoun('今天', '今天是我的生日。'), false)
check('dt-3 相对日期「明日」不备案', entityClean.isExplainedNoun('明日', '明日是提交的最后期限。'), false)
check('dt-4 数字日期「10月1日」不备案', entityClean.isExplainedNoun('10月1日', '10月1日是国庆节。'), false)
check('dt-5 混合日期「3月8日」不备案', entityClean.isExplainedNoun('3月8日', '3月8日是她的生日。'), false)
check('dt-6 热词同口径：含日期碎片拒绝', entityClean.isNonNounWord('晴今天'), true)
check('dt-7 含月字真名「王月红」不受日期模式误伤', entityClean.isNonNounWord('王月红'), false)
check('dt-8 真专名「五羊城」不受日期模式影响', entityClean.isExplainedNoun('五羊城', '五羊城是我们的老城区。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')""",
     "dt-1 拼接碎片「晴今天」不备案"),
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
