# -*- coding: utf-8 -*-
"""
[entity-particle-v1] 疑问/揣测语气收尾不备案（2026-09-24，用户指令）

用户指令：句子以「吧」「吗」收尾的不要提醒备案——「王磊是我的朋友吧？」是揣测/
疑问，不是在解释名词（即便中间有「是」）。

改动：
- utils/entityClean.js：isExplainedNoun 的出现位置级否决块追加第三条——
  同句以「吧/吗」收尾 → 不判定义（与 compare-veto 同块，跳过该出现位置）
- cloudfunctions/optimizeDiary/index.js：补充硬性要求三扩写（吧/吗 语气句不提取；
  治本，需重新部署）
- tools/test_entity_features.js：第 11 节追加 cp-9/10/11

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\entity-particle-backup-20260924'

OPS = [
    # ---- utils/entityClean.js：出现位置级否决块追加 ----
    ('utils/entityClean.js',
     r'''        if (!isCompare && sent.charAt(sent.length - 1) === '的' && !PRON_DE_RE.test(sent)) isCompare = true''',
     r'''        if (!isCompare && sent.charAt(sent.length - 1) === '的' && !PRON_DE_RE.test(sent)) isCompare = true
        // [entity-particle-v1] 疑问/揣测语气（吧/吗）收尾 → 是问句或揣测，不是解释名词（2026-09-24 用户指令）
        if (!isCompare && (sent.charAt(sent.length - 1) === '吧' || sent.charAt(sent.length - 1) === '吗')) isCompare = true''',
     'entity-particle-v1'),
    # ---- cloudfunctions/optimizeDiary/index.js：硬性要求三扩写 ----
    ('cloudfunctions/optimizeDiary/index.js',
     r'''    '补充硬性要求三：「名词 + 是……(不)一样的/不同的」是比较或强调句式，不是定义句，一律不提取；只有整句在说明"该名词是什么/是谁"时才算被解释；',''',
     r'''    '补充硬性要求三：「名词 + 是……(不)一样的/不同的」是比较或强调句式，不是定义句，一律不提取；以"吧/吗"等疑问、揣测语气收尾的也不是定义句，不要提取；只有整句在说明"该名词是什么/是谁"时才算被解释；',''',
     '以"吧/吗"等疑问'),
    # ---- tools/test_entity_features.js：cp-9/10/11 ----
    ('tools/test_entity_features.js',
     r'''check('cp-8 通篇比较句不备案', entityClean.isExplainedNoun('智商', '智商是完全不一样的。能力是完全不一样的。'), false)''',
     r'''check('cp-8 通篇比较句不备案', entityClean.isExplainedNoun('智商', '智商是完全不一样的。能力是完全不一样的。'), false)
check('cp-9 揣测句「是我的朋友吧」不备案', entityClean.isExplainedNoun('王磊', '王磊是我的朋友吧。'), false)
check('cp-10 疑问句「是坏人吗」不备案', entityClean.isExplainedNoun('张总', '张总是坏人吗？'), false)
check('cp-11 吧/吗之外的真定义不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)''',
     'cp-9 揣测句'),
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
