# -*- coding: utf-8 -*-
"""
[hotword-recency v1] 高频词同频次内按「最近出现日期」新→旧排（2026-09-24 用户拍板方案 1）
- utils/hotwords.js#keywordFreq：签名 contents→items（含 dateKey），新增 lastDay 追踪
- utils/hotwords.js#buildBase：排序键 = 频次降序 → lastDay 新→旧
- 入选资格（≥2 次）、预算逻辑、其他来源优先级全部不变
用法：--check / --write / --restore
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\hotword-recency-backup-20260924'

REL = r'utils\hotwords.js'

# ---- op1: 头部注释补充排序说明 ----
OP1_OLD = (
"// 2. 近十天日记高频关键词补充 —— 复用 tags 引擎提取，按出现频次排序，\n"
"//    仅取出现 ≥2 次的「常说」词汇；不凑满预算"
)
OP1_NEW = (
"// 2. 近十天日记高频关键词补充 —— 复用 tags 引擎提取，按出现频次排序，\n"
"//    同频次内按「最近一次出现的日期」新→旧排 [hotword-recency v1]（越新的日记词越靠前），\n"
"//    仅取出现 ≥2 次的「常说」词汇；不凑满预算"
)

# ---- op2: buildBase 近十天段（recentContents → recentItems + 新排序键） ----
OP2_OLD = (
"    const recentContents = []\n"
"    diaries.forEach(d => {\n"
"      const dk = d && d.created_at ? util.getDateKey(new Date(d.created_at)) : ''\n"
"      if (dk && dk >= cutoff) recentContents.push(String((d && d.content) || ''))\n"
"    })\n"
"    if (recentContents.length) {\n"
"      const freq = keywordFreq(recentContents, seen)\n"
"      Object.keys(freq)\n"
"        .sort((a, b) => freq[b] - freq[a])\n"
"        .forEach(w => {\n"
"          if (push(w)) count.keyword++\n"
"        })\n"
"    }"
)
OP2_NEW = (
"    const recentItems = []\n"
"    diaries.forEach(d => {\n"
"      const dk = d && d.created_at ? util.getDateKey(new Date(d.created_at)) : ''\n"
"      if (dk && dk >= cutoff) recentItems.push({ dateKey: dk, content: String((d && d.content) || '') })\n"
"    })\n"
"    if (recentItems.length) {\n"
"      // [hotword-recency v1] 频次降序 → 同频次按「最近出现日期」新→旧（2026-09-24 用户拍板）\n"
"      const r = keywordFreq(recentItems, seen)\n"
"      Object.keys(r.freq)\n"
"        .sort((a, b) => r.freq[b] - r.freq[a] ||\n"
"          String(r.lastDay[b] || '').localeCompare(String(r.lastDay[a] || '')))\n"
"        .forEach(w => {\n"
"          if (push(w)) count.keyword++\n"
"        })\n"
"    }"
)

# ---- op3: keywordFreq 签名与计数体（加 lastDay 追踪） ----
OP3_OLD = (
" * @param {string[]} contents 近十天日记正文列表\n"
" * @param {Set<string>} alreadySet 已收录的词（档案名词），其子串跳过\n"
" * @returns {Object<string, number>} 词 → 出现次数\n"
" */\n"
"function keywordFreq(contents, alreadySet) {\n"
"  const freq2 = {}\n"
"  const freq3 = {}\n"
"\n"
"  // 按标点/空白切段，滑窗不跨标点\n"
"  contents.forEach(text => {\n"
"    const segs = text.split(/[^\\u4e00-\\u9fa5A-Za-z0-9]+/)\n"
"    segs.forEach(seg => {\n"
"      for (let i = 0; i < seg.length - 1; i++) {\n"
"        const w = seg.substr(i, 2)\n"
"        if (!/[\\u4e00-\\u9fa5]{2}/.test(w) || !/^[\\u4e00-\\u9fa5]{2}$/.test(w)) continue\n"
"        if (STOP_WORDS.has(w)) continue\n"
"        freq2[w] = (freq2[w] || 0) + 1\n"
"      }\n"
"      for (let i = 0; i < seg.length - 2; i++) {\n"
"        const w = seg.substr(i, 3)\n"
"        if (!/^[\\u4e00-\\u9fa5]{3}$/.test(w)) continue\n"
"        // 三字词内含停用双字（如「的时候」）则丢弃\n"
"        if (STOP_WORDS.has(w.substr(0, 2)) || STOP_WORDS.has(w.substr(1, 2))) continue\n"
"        freq3[w] = (freq3[w] || 0) + 1\n"
"      }\n"
"    })\n"
"  })"
)
OP3_NEW = (
" * @param {{dateKey: string, content: string}[]} items 近十天日记列表（dateKey 供同频次新旧排序）\n"
" * @param {Set<string>} alreadySet 已收录的词（档案名词），其子串跳过\n"
" * @returns {{freq: Object<string, number>, lastDay: Object<string, string>}} 词→次数 与 词→最近出现日期\n"
" */\n"
"function keywordFreq(items, alreadySet) {\n"
"  const freq2 = {}\n"
"  const freq3 = {}\n"
"  // [hotword-recency v1] 词 → 最近一次出现的 dateKey（同频次内「越新越靠前」的排序依据）\n"
"  const lastDay = {}\n"
"\n"
"  // 按标点/空白切段，滑窗不跨标点\n"
"  items.forEach(item => {\n"
"    const text = (item && item.content) || ''\n"
"    const dk = (item && item.dateKey) || ''\n"
"    const track = (w) => {\n"
"      if (dk && (!lastDay[w] || dk > lastDay[w])) lastDay[w] = dk\n"
"    }\n"
"    const segs = text.split(/[^\\u4e00-\\u9fa5A-Za-z0-9]+/)\n"
"    segs.forEach(seg => {\n"
"      for (let i = 0; i < seg.length - 1; i++) {\n"
"        const w = seg.substr(i, 2)\n"
"        if (!/[\\u4e00-\\u9fa5]{2}/.test(w) || !/^[\\u4e00-\\u9fa5]{2}$/.test(w)) continue\n"
"        if (STOP_WORDS.has(w)) continue\n"
"        freq2[w] = (freq2[w] || 0) + 1\n"
"        track(w)\n"
"      }\n"
"      for (let i = 0; i < seg.length - 2; i++) {\n"
"        const w = seg.substr(i, 3)\n"
"        if (!/^[\\u4e00-\\u9fa5]{3}$/.test(w)) continue\n"
"        // 三字词内含停用双字（如「的时候」）则丢弃\n"
"        if (STOP_WORDS.has(w.substr(0, 2)) || STOP_WORDS.has(w.substr(1, 2))) continue\n"
"        freq3[w] = (freq3[w] || 0) + 1\n"
"        track(w)\n"
"      }\n"
"    })\n"
"  })"
)

# ---- op4: keywordFreq 返回值带 lastDay ----
OP4_OLD = (
"    if (!subOfSelected) out[w] = freq2[w]\n"
"  })\n"
"  return out\n"
"}"
)
OP4_NEW = (
"    if (!subOfSelected) out[w] = freq2[w]\n"
"  })\n"
"  return { freq: out, lastDay } // [hotword-recency v1]\n"
"}"
)

OPS = [
    # (rel, old, new, guard)——guard 必须是 new 独有、且逐字取自 new 的片段（不能是 old/业务已有内容）
    (REL, OP1_OLD, OP1_NEW,
     '//    同频次内按「最近一次出现的日期」新→旧排 [hotword-recency v1]（越新的日记词越靠前），'),
    (REL, OP2_OLD, OP2_NEW,
     'const r = keywordFreq(recentItems, seen)'),
    (REL, OP3_OLD, OP3_NEW,
     '  const lastDay = {}'),
    (REL, OP4_OLD, OP4_NEW,
     '  return { freq: out, lastDay } // [hotword-recency v1]'),
]


def load(rel):
    raw = open(os.path.join(WORK, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n'), crlf)


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(WORK, rel), 'wb').write(text.encode('utf-8'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore'):
        print('usage: patch_hotword_recency.py --check|--write|--restore')
        return 2
    if mode == 'restore':
        src = os.path.join(BK, REL)
        shutil.copy2(src, os.path.join(WORK, REL))
        print('RESTORED', REL)
        return 0

    ok_all = True
    for rel, old, new, guard in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if mode == 'check':
            status = 'OK' if (c_old == 1 and c_new == 0) else ('SKIP(applied?)' if c_old == 0 and c_new >= 1 else 'FAIL')
            if status == 'FAIL':
                ok_all = False
            print('%-14s %s op old=%d guard=%d' % (status, rel, c_old, c_new))
        else:
            if c_old == 1 and c_new == 0:
                save(rel, text.replace(old, new), crlf)
                print('WROTE  %s (old->new)' % rel)
            elif c_old == 0 and c_new >= 1:
                print('SKIP   %s (already applied)' % rel)
            else:
                ok_all = False
                print('FAIL   %s old=%d guard=%d (no write)' % (rel, c_old, c_new))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
