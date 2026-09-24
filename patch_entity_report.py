# -*- coding: utf-8 -*-
"""
[entity-report-v1] 叙述碎片假名词 + 转述引导否决（2026-09-24，用户侧 bug）

用户侧 bug：「妈妈说这是豆子在呼吸」弹出了备案提醒「妈妈说这」。
- 「妈妈说这」= AI 把言说动词「说」+ 代词「这」和主语拼成 4 字假名词，机械闸门
  词表拦不住（说/这 不在功能字表），且假名词后面紧跟「是豆子在呼吸」被当成定义句
- 用户两点指令：①「妈妈说这」不是名词；②「说的是/告诉我是/写的是/画的是/
  描述的是」这类转述句式，「是」后面跟的是说话内容，不是定义，一律不提醒

改动：
- utils/entityClean.js：
  ① NARR_WORDS（说/讲/写/画/描述/告诉）+ 这/那 收尾 → 名词本体否决
    （isExplainedNoun 与 isNonNounWord 同口径，人名热词链路一起受益）
  ② REPORTING_LEAD_RE：名词左侧是转述引导（说…是/告诉我是/说这是…）→ 该出现
    位置整体跳过，定义句式与叫类引导都不再判
- cloudfunctions/optimizeDiary/index.js：prompt 加反例「妈妈说这是豆子在呼吸」+
  补充硬性要求四（治本；需重新上传部署）
- tools/test_entity_features.js：第 11 节追加 cp-12~17

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-report-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：常量 ----
    ('utils/entityClean.js',
     r'''const PRON_DE_RE = /(我|你|他|她|它|咱)(们)?的$/

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)''',
     r'''const PRON_DE_RE = /(我|你|他|她|它|咱)(们)?的$/
// [entity-report-v1] 言说/叙述动词 + 代词拼出的「假名词」（2026-09-24 用户侧 bug：
// 「妈妈说这是豆子在呼吸」被 AI 抽出名词「妈妈说这」——动词+代词的叙述碎片不是名词本体）
const NARR_WORDS = ['说', '讲', '写', '画', '描述', '告诉']
// 「X说的是/告诉我是/写的是/画的是/描述的是/说这是」：紧随的「是」属于转述引导，
// 后面跟的是说话内容不是定义句
const REPORTING_LEAD_RE = /(说|讲|写|画|描述|告诉)(的|我|你|他|她|它|们|这|那)?是$/

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)''',
     'const REPORTING_LEAD_RE ='),
    # ---- utils/entityClean.js：isExplainedNoun 前置否决 ----
    ('utils/entityClean.js',
     r'''  // [entity-xing-v1] 「X性」抽象属性词（积极性/可能性…）→ 整类不备案
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return false
  // 虚词/泛称词 → 不备案''',
     r'''  // [entity-xing-v1] 「X性」抽象属性词（积极性/可能性…）→ 整类不备案
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return false
  // [entity-report-v1] 假名词否决：含言说动词（说/讲/写/画/描述/告诉）或以「这/那」收尾
  // → 「妈妈说这」这类叙述碎片不是名词本体（2026-09-24 用户侧 bug）
  for (let i = 0; i < NARR_WORDS.length; i++) {
    if (n.indexOf(NARR_WORDS[i]) !== -1) return false
  }
  const tailChar = n.charAt(n.length - 1)
  if (tailChar === '这' || tailChar === '那') return false
  // 虚词/泛称词 → 不备案''',
     '假名词否决'),
    # ---- utils/entityClean.js：isNonNounWord（人名热词同口径） ----
    ('utils/entityClean.js',
     r'''  // [entity-frag-v1] 连词开头碎片 / [entity-xing-v1]「X性」抽象词 → 明确不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return true
  // 虚词 / 代词 / 高频动词 / 高频形容词表''',
     r'''  // [entity-frag-v1] 连词开头碎片 / [entity-xing-v1]「X性」抽象词 → 明确不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return true
  // [entity-report-v1] 人名热词同口径：叙述碎片（妈妈说这）不是名字本体
  for (let i = 0; i < NARR_WORDS.length; i++) {
    if (n.indexOf(NARR_WORDS[i]) !== -1) return true
  }
  const tailChar = n.charAt(n.length - 1)
  if (tailChar === '这' || tailChar === '那') return true
  // 虚词 / 代词 / 高频动词 / 高频形容词表''',
     '人名热词同口径：叙述碎片'),
    # ---- utils/entityClean.js：出现位置级转述引导否决 ----
    ('utils/entityClean.js',
     r'''      let leadHit = false
      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {
        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) { leadHit = true; break }
      }
      if (leadHit) {
        // [entity-compare-v1] 名词后接「是」还要看整句性质：比较句/强调句不判定义，
        // 只跳过此出现位置继续找下一处（另一处若是真定义仍可备案）
        const sentM = text.slice(idx).match(/^[\s\S]*?[。！？!?\n]/)
        const sent = (sentM ? sentM[0] : text.slice(idx)).replace(/[。！？!?\n]+$/, '')
        let isCompare = false
        for (let i = 0; i < COMPARE_MARKS.length; i++) {
          if (sent.indexOf(COMPARE_MARKS[i]) !== -1) { isCompare = true; break }
        }
        if (!isCompare && sent.charAt(sent.length - 1) === '的' && !PRON_DE_RE.test(sent)) isCompare = true
        // [entity-particle-v1] 疑问/揣测语气（吧/吗）收尾 → 是问句或揣测，不是解释名词（2026-09-24 用户指令）
        if (!isCompare && (sent.charAt(sent.length - 1) === '吧' || sent.charAt(sent.length - 1) === '吗')) isCompare = true
        if (!isCompare) return true
      }
      const before = text.slice(0, idx)
      for (let i = 0; i < LEAD_BEFORE_SORTED.length; i++) {
        const lead = LEAD_BEFORE_SORTED[i]
        if (before.length >= lead.length && before.slice(before.length - lead.length) === lead) return true
      }''',
     r'''      // [entity-report-v1] 转述引导（说的是/告诉我是/写的是/画的是/描述的是/说这是…）：
      // 引导词后面的「是」属于转述，名词后面的内容是说话内容不是定义 → 此出现位置整体跳过
      const before = text.slice(0, idx)
      const reporting = REPORTING_LEAD_RE.test(before)
      let leadHit = false
      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {
        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) { leadHit = true; break }
      }
      if (leadHit && !reporting) {
        // [entity-compare-v1] 名词后接「是」还要看整句性质：比较句/强调句不判定义，
        // 只跳过此出现位置继续找下一处（另一处若是真定义仍可备案）
        const sentM = text.slice(idx).match(/^[\s\S]*?[。！？!?\n]/)
        const sent = (sentM ? sentM[0] : text.slice(idx)).replace(/[。！？!?\n]+$/, '')
        let isCompare = false
        for (let i = 0; i < COMPARE_MARKS.length; i++) {
          if (sent.indexOf(COMPARE_MARKS[i]) !== -1) { isCompare = true; break }
        }
        if (!isCompare && sent.charAt(sent.length - 1) === '的' && !PRON_DE_RE.test(sent)) isCompare = true
        // [entity-particle-v1] 疑问/揣测语气（吧/吗）收尾 → 是问句或揣测，不是解释名词（2026-09-24 用户指令）
        if (!isCompare && (sent.charAt(sent.length - 1) === '吧' || sent.charAt(sent.length - 1) === '吗')) isCompare = true
        if (!isCompare) return true
      }
      if (!reporting) {
        for (let i = 0; i < LEAD_BEFORE_SORTED.length; i++) {
          const lead = LEAD_BEFORE_SORTED[i]
          if (before.length >= lead.length && before.slice(before.length - lead.length) === lead) return true
        }
      }''',
     'REPORTING_LEAD_RE.test(before)'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '- 反例：日记写"智商是完全不一样的" → 不提取，这是「X是……的」比较/强调句，只是在比较差异，不是在解释"智商"是什么；凡名词后跟"是"、整句在说不同/一样的比较句一律不提取；',''',
     r'''    '- 反例：日记写"智商是完全不一样的" → 不提取，这是「X是……的」比较/强调句，只是在比较差异，不是在解释"智商"是什么；凡名词后跟"是"、整句在说不同/一样的比较句一律不提取；',
    '- 反例：日记写"妈妈说这是豆子在呼吸" → 不提取，"妈妈说这"是言说动词"说"和代词"这"拼出来的叙述碎片、根本不是名词；"豆子"也只是被提到、没有解释它是什么；',''',
     '"妈妈说这是豆子在呼吸" → 不提取'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 硬性要求四 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '补充硬性要求三：「名词 + 是……(不)一样的/不同的」是比较或强调句式，不是定义句，一律不提取；以"吧/吗"等疑问、揣测语气收尾的也不是定义句，不要提取；只有整句在说明"该名词是什么/是谁"时才算被解释；',''',
     r'''    '补充硬性要求三：「名词 + 是……(不)一样的/不同的」是比较或强调句式，不是定义句，一律不提取；以"吧/吗"等疑问、揣测语气收尾的也不是定义句，不要提取；只有整句在说明"该名词是什么/是谁"时才算被解释；',
    '补充硬性要求四：「说的是/告诉我是/写的是/画的是/描述的是」等转述句式，后面跟的是说话内容、不是对名词的定义，一律不提取；name 本体绝不能含"说/讲/写/画/描述/告诉"等动词或以"这/那"结尾；',''',
     '补充硬性要求四'),
    # ---- tools/test_entity_features.js：cp-12~17 ----
    ('tools/test_entity_features.js',
     r'''check('cp-11 吧/吗之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)''',
     r'''check('cp-11 吧/吗之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('cp-12 假名词「妈妈说这」不备案', entityClean.isExplainedNoun('妈妈说这', '妈妈说这是豆子在呼吸'), false)
check('cp-13 假名词同口径：热词链路拒绝', entityClean.isNonNounWord('妈妈说这'), true)
check('cp-14 真名词「豆子」在转述句中不备案', entityClean.isExplainedNoun('豆子', '妈妈说这是豆子在呼吸'), false)
check('cp-15 转述引导「说的是」不备案', entityClean.isExplainedNoun('豆子', '妈妈说的是豆子在呼吸。'), false)
check('cp-16 转述引导「告诉我是」不备案', entityClean.isExplainedNoun('三块钱', '老师告诉我是三块钱。'), false)
check('cp-17 转述之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)''',
     'cp-12 假名词'),
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
