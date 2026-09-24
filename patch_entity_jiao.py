# -*- coding: utf-8 -*-
"""[entity-jiao v1] 「叫」义治理（2026-09-24 用户侧 bug 第五轮）：
「妈妈就给我姐夫打电话，叫我姐夫把我带出去去」弹备案「姐夫打电话」——SEP_RE 把逗号剥掉后，
下一分句开头的「叫」被当成紧随定义引导词。用户指令：
①叫前面有标点符号不应该弹；②「叫」是喊/说义不是「是」义，只有「叫」的是人名/地名/
建筑名/设施名时才弹。
op1: LEAD_AFTER 注释更新（分句边界口径）
op2: 新增 JIAO_STOP_RE / JIAO_SEP_RE
op3: isExplainedNoun 后向定义判定加 jiaoBlocked（仅限裸「叫」；是/就是等维持现状）
op4: test_entity_features.js 新增第 21 节 jb-1~7
op5: optimizeDiary prompt 增补反例（本地闸门已拦，部署不急）
幂等判据：applied = guard 特征串已存在。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = [
    # op1 注释
    (
        "utils/entityClean.js",
        "// 定义句式的引导词：名词之后紧跟（允许中间有标点/空白）",
        "// 定义句式的引导词：名词之后紧跟（空白可跳过；隔句读标点 = 下一分句，对「叫」见 [entity-jiao v1]）",
        "// 定义句式的引导词：名词之后紧跟（空白可跳过；隔句读标点 = 下一分句，对「叫」见 [entity-jiao v1]）",
        "ec 注释口径",
    ),
    # op2 正则
    (
        "utils/entityClean.js",
        "const REPORTING_LEAD_RE = /(说|讲|写|画|描述|告诉)(的|我|你|他|她|它|们|这|那)?是$/",
        "const REPORTING_LEAD_RE = /(说|讲|写|画|描述|告诉)(的|我|你|他|她|它|们|这|那)?是$/\n"
        "// [entity-jiao v1] 「叫」后紧跟动态助词/人称代词 → 喊/使令义，不是命名（2026-09-24 用户指令：\n"
        "// 「叫」的意思不是「是」，是喊和说；只有「叫」的是人名/地名/建筑名/设施名才弹）。\n"
        "// 注意 after 以命中的引导词开头，故锚点含「叫」字头\n"
        "const JIAO_STOP_RE = /^叫(了|着|过|住|[我你他她它咱])/\n"
        "// [entity-jiao v1] 「叫」与名词之间的句读标点：叫属于下一分句（用户指令：叫前面有标点不弹）\n"
        "const JIAO_SEP_RE = /[，,、；;：:]/",
        "JIAO_STOP_RE",
        "ec 正则",
    ),
    # op3 判定
    (
        "utils/entityClean.js",
        "      let leadHit = false\n"
        "      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {\n"
        "        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) { leadHit = true; break }\n"
        "      }\n"
        "      if (leadHit && !reporting) {",
        "      let leadHit = null\n"
        "      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {\n"
        "        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) { leadHit = LEAD_AFTER_SORTED[i]; break }\n"
        "      }\n"
        "      // [entity-jiao v1] 「叫」是喊/说义不是「是」义（2026-09-24 用户指令）：①叫与名词之间\n"
        "      // 隔句读标点 → 叫属于下一分句；②叫后紧跟动态助词/人称代词（叫我/叫了/叫住）→ 使令转述。\n"
        "      // 两者都只跳过此出现位置；「叫」+人名/地名/建筑/设施名仍可弹（如「我姐夫叫王磊」）\n"
        "      const jiaoBlocked = leadHit === '叫' &&\n"
        "        (JIAO_SEP_RE.test(text.slice(idx + n.length).match(SEP_RE)[0]) || JIAO_STOP_RE.test(after))\n"
        "      if (leadHit && !reporting && !jiaoBlocked) {",
        "jiaoBlocked",
        "ec 判定",
    ),
    # op4 测试
    (
        "tools/test_entity_features.js",
        "check('am-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)",
        "check('am-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)\n"
        "\n"
        "/* ===== 21. 「叫」义治理：分句边界 + 使令豁免 [entity-jiao v1]（2026-09-24 用户侧 bug 第五轮：\n"
        "   「妈妈就给我姐夫打电话，叫我姐夫把我带出去去」弹「姐夫打电话」——逗号后的「叫」被当成\n"
        "   紧随定义。用户指令：①叫前面有标点不弹 ②「叫」是喊/说不是「是」，只有「叫」的是\n"
        "   人名/地名/建筑名/设施名才弹） ===== */\n"
        "check('jb-1 隔逗号的「叫」不判定义（姐夫打电话）', entityClean.isExplainedNoun('姐夫打电话', '妈妈就给我姐夫打电话，叫我姐夫把我带出去去。', '叫我姐夫把我带出去'), false)\n"
        "check('jb-2 叫+人称代词是使令（王磊叫我…）', entityClean.isExplainedNoun('王磊', '王磊叫我明天早点去集合。', '叫我明天早点去集合'), false)\n"
        "check('jb-3 叫+动态助词是喊叫（叫住了我）', entityClean.isExplainedNoun('王磊', '王磊叫住了我，说有急事。', '叫住了我'), false)\n"
        "check('jb-4 名字介绍「母亲叫王喜兰」不回归（前向引导）', entityClean.isExplainedNoun('王喜兰', '我母亲叫王喜兰，是个热心肠的人。', '是个热心肠的人'), true)\n"
        "check('jb-5 无标点紧随「是」不回归', entityClean.isExplainedNoun('披萨', '披萨是意大利传来的美食。'), true)\n"
        "check('jb-6 隔逗号的「是」维持可弹（边界规则只限「叫」，不扩大打击面）', entityClean.isExplainedNoun('李雷', '今天路上遇到李雷，是个热心人。', '是个热心人'), true)\n"
        "check('jb-7 「叫」+人名仍可弹（姐夫叫王磊）', entityClean.isExplainedNoun('姐夫', '我姐夫叫王磊，是个热心肠的人。', '是个热心肠的人'), true)",
        "jb-1 隔逗号的「叫」",
        "测试第21节",
    ),
    # op5 云函数 prompt
    (
        "cloudfunctions/optimizeDiary/index.js",
        "'- 反例：日记写\"俺们这嘎达到处都是积雪\" → 不提取，\"俺们这嘎达\"是方言人称代词\"俺们\"与口语方位拼片\"这嘎达\"拼出来的碎片、不是名词；方言代词（俺/俺们/咱）及\"这嘎达/那嘎达\"类口语拼片一律不提取；',",
        "'- 反例：日记写\"俺们这嘎达到处都是积雪\" → 不提取，\"俺们这嘎达\"是方言人称代词\"俺们\"与口语方位拼片\"这嘎达\"拼出来的碎片、不是名词；方言代词（俺/俺们/咱）及\"这嘎达/那嘎达\"类口语拼片一律不提取；',\n"
        "    '- 反例：日记写\"妈妈就给我姐夫打电话，叫我姐夫把我带出去去\" → 不提取，\"姐夫打电话\"是主谓短语（人+动作）不是名词；\"叫\"是喊/让的意思不是\"是\"，且\"叫\"前面隔着逗号、属于下一个分句，绝不能把逗号后的\"叫我…\"当成对前面词语的解释；',",
        "姐夫打电话",
        "prompt 反例",
    ),
]


def load(p):
    with io.open(p, "r", encoding="utf-8", newline="") as f:
        return f.read()


def save(p, t, nl):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(t.replace("\n", nl))


def main(mode):
    fails = 0
    for rel, old, new, guard, desc in OPS:
        p = BASE + "\\" + rel.replace("/", "\\")
        raw = load(p)
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        if guard in text:
            print("%-12s SKIP(已应用)" % desc)
            continue
        cnt = text.count(old)
        if cnt != 1:
            print("%-12s FAIL 锚点命中 %d 次" % (desc, cnt))
            fails += 1
            continue
        if mode == "--check":
            print("%-12s OK(可写)" % desc)
        elif mode == "--write":
            save(p, text.replace(old, new, 1), nl)
            print("%-12s APPLIED" % desc)
        elif mode == "--restore":
            if new in text and text.count(new) == 1:
                save(p, text.replace(new, old, 1), nl)
                print("%-12s RESTORED" % desc)
            else:
                print("%-12s FAIL 恢复锚点异常（删除型请用备份目录）" % desc)
                fails += 1
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
