# -*- coding: utf-8 -*-
"""[entity-amen-v1] 方言代词「俺/咱」入子串黑名单（2026-09-24 用户侧 bug 第四轮：
弹窗「俺们这嘎达」——上轮修的是「我们这嗨达」，ASR 把东北话转成「俺们」换字就漏。
CONNECT_WORDS 只有 我们/你们/他们/她们/它们/咱们，没收「俺」系）。
op1: entityClean.js 注释补充方言代词说明
op2: entityClean.js CONNECT_WORDS 增补 '俺', '咱'（单字子串，覆盖 俺们/咱们/俺这/咱这 全部变体）
op3: test_entity_features.js 新增第 20 节 am-1~7
op4: optimizeDiary/index.js prompt 增补反例（本地闸门已拦，部署不急）
幂等判据：applied = 注入后的特征串已存在。
"""
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = [
    # op1 注释（锚点 = 原注释行整行；guard = 新注释整行）
    (
        "utils/entityClean.js",
        "// 只收「几乎不可能出现在真专名里」的连词与代词；果然/简直这类可入名的词仍保持整词匹配",
        "// 只收「几乎不可能出现在真专名里」的连词与代词；果然/简直这类可入名的词仍保持整词匹配；\n"
        "// [entity-amen-v1] 方言代词「俺/咱」单字入表（2026-09-24 第四轮：「俺们这嘎达」——\n"
        "// ASR 变体换字就漏，单字子串一并覆盖 俺们/咱们/俺这/咱这 全部变体）",
        "// [entity-amen-v1] 方言代词「俺/咱」单字入表",
        "ec 注释",
    ),
    # op2 词表（锚点 = 表尾片段；guard = 新表尾片段）
    (
        "utils/entityClean.js",
        "'咱们', '自己', '另外']",
        "'咱们', '自己', '另外', '俺', '咱']",
        "'咱们', '自己', '另外', '俺', '咱']",
        "ec 词表",
    ),
    # op3 测试（锚点 = yb-8 整行；guard = am-1 标识）
    (
        "tools/test_entity_features.js",
        "check('yb-8 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)",
        "check('yb-8 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)\n"
        "\n"
        "/* ===== 20. 方言代词成分 [entity-amen-v1]（2026-09-24 用户侧 bug 第四轮：\n"
        "   「俺们这嘎达」弹备案——上轮修的「我们这嗨达」靠「我们」子串拦住，ASR 转成\n"
        "   「俺们」换字就漏；方言代词「俺/咱」单字入表，一并覆盖全部变体） ===== */\n"
        "check('am-1 方言碎片「俺们这嘎达」不备案', entityClean.isExplainedNoun('俺们这嘎达', '俺们这嘎达到处都是积雪。'), false)\n"
        "check('am-2 热词同口径：「俺们这嘎达」拒绝', entityClean.isNonNounWord('俺们这嘎达'), true)\n"
        "check('am-3 变体「俺这嘎达」拒绝', entityClean.isNonNounWord('俺这嘎达'), true)\n"
        "check('am-4 变体「咱这嘎达」拒绝', entityClean.isNonNounWord('咱这嘎达'), true)\n"
        "check('am-5 热词同口径：「俺们」拒绝', entityClean.isNonNounWord('俺们'), true)\n"
        "check('am-6 称呼「张总」不回归', entityClean.isNonNounWord('张总'), false)\n"
        "check('am-7 真定义「王磊是我的大学同学」不回归', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。'), true)",
        "am-1 方言碎片",
        "测试第20节",
    ),
    # op4 云函数 prompt 反例（锚点 = 弹窗实录反例行整行；guard = 方言特征串）
    (
        "cloudfunctions/optimizeDiary/index.js",
        "'- 反例：弹窗实录\"军训\"\"我们这嗨达\"\"另外一项任务\"\"仅仅\"四条，解释均为编造（原文里根本没有这些句子） → explanation 必须从原文逐字复制，原文里没有的解释不要编造，宁可漏掉、不可编造；',",
        "'- 反例：弹窗实录\"军训\"\"我们这嗨达\"\"另外一项任务\"\"仅仅\"四条，解释均为编造（原文里根本没有这些句子） → explanation 必须从原文逐字复制，原文里没有的解释不要编造，宁可漏掉、不可编造；',\n"
        "    '- 反例：日记写\"俺们这嘎达到处都是积雪\" → 不提取，\"俺们这嘎达\"是方言人称代词\"俺们\"与口语方位拼片\"这嘎达\"拼出来的碎片、不是名词；方言代词（俺/俺们/咱）及\"这嘎达/那嘎达\"类口语拼片一律不提取；',",
        "俺们这嘎达到处都是积雪",
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
                print("%-12s FAIL 恢复锚点异常" % desc)
                fails += 1
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
