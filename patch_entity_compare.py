# -*- coding: utf-8 -*-
"""
[entity-compare-v1] 比较句/强调句否决（2026-09-24，用户拍板方案 3 全含）

用户侧 bug：原文「智商是完全不一样的」——名词后紧跟「是」落进定义句引导词，
但这是「X是……的」比较/强调句，不是在解释名词。与「积极性是完全不一样的」同族。

改动（全含 1+2+3）：
- utils/entityClean.js：①比较标记规则（同句含 不一样/不同/一样/类似/差不多 → 该出现
  位置不判定义）；②「是……的」强调句规则（同句以「的」收尾且非人称领属 → 不判定义，
  PRON_DE_RE 保住「王磊是我的大学同学」这类真定义）
- cloudfunctions/optimizeDiary/index.js：prompt 加反例「智商是完全不一样的」+ 补充硬性
  要求三（治本；改后需重新上传部署）
- tools/test_entity_features.js：新增第 11 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-compare-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：常量 ----
    ('utils/entityClean.js',
     r'''const XING_SUFFIX = '性'

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)''',
     r'''const XING_SUFFIX = '性'
// [entity-compare-v1] 比较句/强调句否决（2026-09-24 用户侧 bug：「智商是完全不一样的」——
// 名词后紧跟「是」落进定义句引导词，但这实为「X是……的」比较/强调句，不是在解释名词）。
// ① 同句含比较标记 → 不是定义句；② 同句以「的」收尾且非人称领属（保住「王磊是我的大学
// 同学」这类真定义）→ 强调句不判定义。漏拦方向：少弹提醒，绝不误备案
const COMPARE_MARKS = ['不一样', '不同', '一样', '类似', '差不多']
const PRON_DE_RE = /(我|你|他|她|它|咱)(们)?的$/

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)''',
     'const COMPARE_MARKS = ['),
    # ---- utils/entityClean.js：isExplainedNoun 出现位置级否决 ----
    ('utils/entityClean.js',
     r'''      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {
        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) return true
      }
      const before = text.slice(0, idx)''',
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
        if (!isCompare) return true
      }
      const before = text.slice(0, idx)''',
     'let leadHit = false'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 反例 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '- 反例：日记写"但总是想着自己的事情，积极性是完全不一样的" → 不提取，"但总"是转折词"但"和副词"总是"被截出来的碎片、不是名词；"积极性"是常用抽象名词——这类词即使后面紧跟"是"，也不是被解释的专名；',''',
     r'''    '- 反例：日记写"但总是想着自己的事情，积极性是完全不一样的" → 不提取，"但总"是转折词"但"和副词"总是"被截出来的碎片、不是名词；"积极性"是常用抽象名词——这类词即使后面紧跟"是"，也不是被解释的专名；',
    '- 反例：日记写"智商是完全不一样的" → 不提取，这是「X是……的」比较/强调句，只是在比较差异，不是在解释"智商"是什么；凡名词后跟"是"、整句在说不同/一样的比较句一律不提取；',''',
     '"智商是完全不一样的" → 不提取'),
    # ---- cloudfunctions/optimizeDiary/index.js：prompt 硬性要求三 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '补充硬性要求二：不要提取以"性"结尾的常用抽象名词（积极性/可能性/重要性/主动性/灵活性等）；也不要把转折词、副词和后面的文字拼接成碎片当名词（如"但总是…"绝不能截出"但总"）；',''',
     r'''    '补充硬性要求二：不要提取以"性"结尾的常用抽象名词（积极性/可能性/重要性/主动性/灵活性等）；也不要把转折词、副词和后面的文字拼接成碎片当名词（如"但总是…"绝不能截出"但总"）；',
    '补充硬性要求三：「名词 + 是……(不)一样的/不同的」是比较或强调句式，不是定义句，一律不提取；只有整句在说明"该名词是什么/是谁"时才算被解释；',''',
     '补充硬性要求三'),
    # ---- tools/test_entity_features.js：第 11 节 ----
    ('tools/test_entity_features.js',
     r'''check('fg-8 已知拦截不回归：简直/一个仍拒绝', entityClean.isNonNounWord('简直') && entityClean.isNonNounWord('一个'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')''',
     r'''check('fg-8 已知拦截不回归：简直/一个仍拒绝', entityClean.isNonNounWord('简直') && entityClean.isNonNounWord('一个'), true)

/* ===== 11. 比较句/强调句否决 [entity-compare-v1]（2026-09-24 用户侧 bug：
   「智商是完全不一样的」——名词后跟「是」但整句是比较/强调，不是定义） ===== */
check('cp-1 比较句「智商是完全不一样的」不备案', entityClean.isExplainedNoun('智商', '今天聊了很多，智商是完全不一样的。'), false)
check('cp-2 比较句「能力是不一样的」不备案', entityClean.isExplainedNoun('能力', '我们俩能力是不一样的。'), false)
check('cp-3 比较句「态度是差不多的」不备案', entityClean.isExplainedNoun('态度', '他对这件事的态度是差不多的。'), false)
check('cp-4 强调句「是华为最新款的」不备案', entityClean.isExplainedNoun('手机', '这部手机是华为最新款的。'), false)
check('cp-5 人称领属真定义「王磊是我的大学同学」仍备案', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)
check('cp-6 正例「三里屯」不受新规则影响', entityClean.isExplainedNoun('三里屯', '三里屯是我们常去的商场。'), true)
check('cp-7 同词两处：比较句跳过、定义句仍备案', entityClean.isExplainedNoun('智商', '智商是完全不一样的。医生说智商是衡量认知能力的指标。'), true)
check('cp-8 通篇比较句不备案', entityClean.isExplainedNoun('智商', '智商是完全不一样的。能力是完全不一样的。'), false)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')''',
     "cp-1 比较句「智商是完全不一样的」不备案"),
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
