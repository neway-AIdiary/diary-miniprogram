# -*- coding: utf-8 -*-
"""
[entity-expl-v1] 解释原文核对 + 泛指短语补漏（2026-09-24，用户侧 bug：四连弹）

用户侧 bug：弹窗一次弹 4 条——「军训/我们这嗨达/另外一项任务/仅仅」，
解释全是 AI 编造（原文里根本没有「培新任意识」「集体与集体VR超越」这些句子）。

结构级修法：
- utils/entityClean.js 新增 explanationInText：AI 返回的 explanation 必须能在原文中
  逐字定位（复用 removeOne 的候选容错），定位不到 = 幻觉解释 → 整条否决。
  isExplainedNoun 加可选第三参，write.js 闸门传 e.explanation
- CONNECT_WORDS 增「另外」（子串，拦「另外一项任务」）；NON_NOUN_WORDS 增「仅仅/单单」
- cloudfunctions/optimizeDiary/index.js：弹窗实录反例 + 硬性要求十（需重新部署）
- tools/test_entity_features.js：新增第 17 节 8 条断言

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-expl-backup-20260924'

REPORT_LEAD_OLD = r"const REPORTING_LEAD_RE = /(说|讲|写|画|描述|告诉)(的|我|你|他|她|它|们|这|那)?是$/"
REPORT_LEAD_NEW = REPORT_LEAD_OLD + """
// [entity-expl-v1] 解释原文核对（2026-09-24 用户侧 bug：弹窗「军训/我们这嗨达/另外一项任务/
// 仅仅」四条的解释全是 AI 编造，原文里根本没有）。模块契约本要求 explanation 为原文逐字
// 片段——违约即按幻觉处理，整条否决。复用 removeOne 的候选容错（引导词补全 / 去「我的」），
// 旧数据无 explanation 时不据此否决。漏拦方向：少弹提醒，绝不误备案
function explanationInText(explanation, text) {
  const expl = String(explanation || '').trim()
  if (!expl) return true
  const strippedDe = expl.indexOf('我的') === 0 ? '我' + expl.slice(2) : ''
  const cands = [expl]
  for (let i = 0; i < LEADS.length; i++) {
    cands.push(LEADS[i] + expl)
    if (strippedDe) cands.push(LEADS[i] + strippedDe)
  }
  if (strippedDe) cands.push(strippedDe)
  for (let i = 0; i < LEADS.length; i++) {
    if (expl.indexOf(LEADS[i]) === 0) {
      const tail = expl.slice(LEADS[i].length)
      if (tail.length >= 2) cands.push(tail)
    }
  }
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].length < 3) continue
    if (text.indexOf(cands[i]) !== -1) return true
  }
  return false
}"""

SIG_OLD = "function isExplainedNoun(name, content) {"
SIG_NEW = "function isExplainedNoun(name, content, explanation) {"

VETO_OLD = r"""  const text = String(content || '')
  if (!n || n.length < 2 || n.length > 6) return false"""
VETO_NEW = VETO_OLD + """
  // [entity-expl-v1] 解释原文核对：explanation 定位不到原文 = AI 幻觉 → 整条否决
  if (!explanationInText(explanation, text)) return false"""

CONNECT_OLD = "'无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己']"
CONNECT_NEW = "'无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己', '另外']"

NONNOUN_OLD = "  '而已', '罢了', '之间', '左右', '为何', '何尝',"
NONNOUN_NEW = "  '而已', '罢了', '之间', '左右', '为何', '何尝', '仅仅', '单单',"

EXPORT_OLD = "module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary, isNonNounWord }"
EXPORT_NEW = "module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary, isNonNounWord, explanationInText }"

WRITE_OLD = ".filter(e => entityClean.isExplainedNoun(e.name, content))"
WRITE_NEW = ".filter(e => entityClean.isExplainedNoun(e.name, content, e.explanation || ''))"

CLOUD_FANLI_OLD = r"""    '- 反例：日记写"村后是一片竹林" → 不提取，"村后"是"名词语素+方位字"的方位短语、不是名词；"村后/桌上/门前/心里"这类方位短语后面跟"是"是存在句、不是定义句；',"""
CLOUD_FANLI_NEW = CLOUD_FANLI_OLD + """
    '- 反例：弹窗实录"军训""我们这嗨达""另外一项任务""仅仅"四条，解释均为编造（原文里根本没有这些句子） → explanation 必须从原文逐字复制，原文里没有的解释不要编造，宁可漏掉、不可编造；',"""

CLOUD_REQ_OLD = r"""    '补充硬性要求九：「名词语素+方位字」构成的方位短语（村后/桌上/门前/屋里/心里等）不是名词，一律不提取；它们后面跟"是"是存在句（某处有什么），不是定义句；',"""
CLOUD_REQ_NEW = CLOUD_REQ_OLD + """
    '补充硬性要求十：explanation 字段必须是原文中逐字存在的片段（一般是名词后面的解释句）；原文里找不到的解释一律不要编造；泛指短语（另外一项任务/一个计划类）和副词（仅仅/单单）即使后面跟"是"也不要提取；',"""

TEST_OLD = r"""check('fw-6 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')"""
TEST_NEW = r"""check('fw-6 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)

/* ===== 17. 解释原文核对 + 泛指短语补漏 [entity-expl-v1]（2026-09-24 用户侧 bug：
   弹窗「军训/我们这嗨达/另外一项任务/仅仅」四条解释均为 AI 编造） ===== */
check('ex-1 幻觉解释「军训」整条否决', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。', '培新任意识的开始'), false)
check('ex-2 真解释「王磊」不受误伤', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)
check('ex-3 空解释不据此否决（旧数据兜底）', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。', ''), true)
check('ex-4 旧两参签名行为不回归', entityClean.isExplainedNoun('军训', '军训是磨炼意志的开始。'), true)
check('ex-5 副词「仅仅」不备案', entityClean.isExplainedNoun('仅仅', '仅仅是开始。'), false)
check('ex-6 泛指短语「另外一项任务」不备案', entityClean.isExplainedNoun('另外一项任务', '另外一项任务是写总结。'), false)
check('ex-7 热词同口径：「另外一项任务」拒绝', entityClean.isNonNounWord('另外一项任务'), true)
check('ex-8 热词同口径：「仅仅」拒绝', entityClean.isNonNounWord('仅仅'), true)

  console.log('\n===== 结果: pass', pass, 'fail', fail, '=====')"""

OPS = [
    # ---- utils/entityClean.js ----
    ('utils/entityClean.js', REPORT_LEAD_OLD, REPORT_LEAD_NEW, 'function explanationInText(explanation, text)'),
    ('utils/entityClean.js', SIG_OLD, SIG_NEW, 'function isExplainedNoun(name, content, explanation)'),
    ('utils/entityClean.js', VETO_OLD, VETO_NEW, 'if (!explanationInText(explanation, text)) return false'),
    ('utils/entityClean.js', CONNECT_OLD, CONNECT_NEW, "'咱们', '自己', '另外']"),
    ('utils/entityClean.js', NONNOUN_OLD, NONNOUN_NEW, "'何尝', '仅仅', '单单',"),
    ('utils/entityClean.js', EXPORT_OLD, EXPORT_NEW, 'isNonNounWord, explanationInText }'),
    # ---- pages/write/write.js：闸门传入 explanation ----
    ('pages/write/write.js', WRITE_OLD, WRITE_NEW, 'isExplainedNoun(e.name, content, e.explanation'),
    # ---- cloudfunctions/optimizeDiary/index.js：反例 + 硬性要求十 ----
    ('cloudfunctions/optimizeDiary/index.js', CLOUD_FANLI_OLD, CLOUD_FANLI_NEW, '弹窗实录'),
    ('cloudfunctions/optimizeDiary/index.js', CLOUD_REQ_OLD, CLOUD_REQ_NEW, '补充硬性要求十'),
    # ---- tools/test_entity_features.js：第 17 节 ----
    ('tools/test_entity_features.js', TEST_OLD, TEST_NEW, 'ex-1 幻觉解释「军训」整条否决'),
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
