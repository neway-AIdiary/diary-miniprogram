# -*- coding: utf-8 -*-
"""Generate pinyinDict.js for the WeChat mini-program.

Outputs a mapping: single Chinese char -> comma-separated toneless pinyin
readings (polyphones included, deduped). Covers all GB2312-level-1/2 chars
(6763) so archived names (people/places/orgs) resolve reliably.
"""
import json
from pypinyin import pinyin, Style

entries = {}
# GB2312 level 1 + 2: 0xB0A1..0xF7FE
for hi in range(0xB0, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            ch = bytes([hi, lo]).decode('gb2312')
        except UnicodeDecodeError:
            continue
        if not ('\u4e00' <= ch <= '\u9fff'):
            continue
        readings = pinyin(ch, style=Style.NORMAL, heteronym=True)
        if not readings or not readings[0]:
            continue
        seen = []
        for r in readings[0]:
            r = r.strip()
            if r and r not in seen:
                seen.append(r)
        if seen:
            entries[ch] = ','.join(seen)

out_path = r'C:/Users/ThinkPad/WorkBuddy/2026-08-21-11-18-02/diary-miniprogram/utils/pinyinDict.js'
with open(out_path, 'w', encoding='utf-8') as f:
    f.write('// utils/pinyinDict.js\n')
    f.write('// 汉字 -> 无声调拼音映射（GB2312 一二级汉字，多音字逗号分隔）\n')
    f.write('// 由 pypinyin 生成，供语音识别结果的备案名词同音匹配使用\n')
    f.write('module.exports = ')
    f.write(json.dumps(entries, ensure_ascii=False, separators=(',', ':')))
    f.write('\n')

print('chars:', len(entries))
