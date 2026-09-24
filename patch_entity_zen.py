# -*- coding: utf-8 -*-
# [entity-frag3-v1] 疑问/揣测副词首字（怎/岂）入 FRAG_HEAD_CHARS（2026-09-24 用户指令：
# 「怎料却是个爹不亲、娘不爱的主」弹出「怎料却」——疑问副词开头的拼接碎片不是名词）。
# 铁律：锚点 count==1；write 判据 = count(anchor)==1 && count(new)==0（防坑 6 重复注入）。
import sys, io, os

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = []

# op1: entityClean.js FRAG_HEAD_CHARS 扩展
C_ANCHOR = "const FRAG_HEAD_CHARS = ['但', '却', '而', '且', '虽', '可', '竟', '倒', '便']"
C_NEW = (
    "// [entity-frag3-v1] 疑问/揣测副词首字（怎/岂）同类碎片（2026-09-24「怎料却是个爹不亲、\n"
    "// 娘不爱的主」截出「怎料却」）；「莫/何」是姓氏字不收（莫言/何雨类人名）\n"
    "const FRAG_HEAD_CHARS = ['但', '却', '而', '且', '虽', '可', '竟', '倒', '便', '怎', '岂']"
)
OPS.append(("ec FRAG_HEAD_CHARS 扩展", BASE + "\\utils\\entityClean.js", "block", (C_ANCHOR, C_NEW)))

# op2: 测试套件第 24 节
T_ANCHOR = "check('zt-6 护栏：左小小不被新规则误伤', entityClean.isNonNounWord('左小小'), false)"
T_NEW = T_ANCHOR + "\n" + "\n" + \
    "  // ===== [entity-frag3-v1] 第 24 节：疑问/揣测副词首字（怎/岂）碎片不备案（zl-1~5）=====\n" + \
    "  check('zl-1 用户案例：怎料却是疑问副词碎片不备案', entityClean.isExplainedNoun('怎料却', '怎料却是个爹不亲、娘不爱的主。', '是个爹不亲、娘不爱的主'), false)\n" + \
    "  check('zl-2 怎料却本体按首字规则否决（热词链路同口径）', entityClean.isNonNounWord('怎料却'), true)\n" + \
    "  check('zl-3 变体：怎奈开头同类碎片', entityClean.isNonNounWord('怎奈'), true)\n" + \
    "  check('zl-4 变体：岂料开头同类碎片', entityClean.isNonNounWord('岂料'), true)\n" + \
    "  check('zl-5 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)"
OPS.append(("test 第 24 节 zl-1~5", BASE + "\\tools\\test_entity_features.js", "block", (T_ANCHOR, T_NEW)))

# op3: 云函数 prompt 反例（追加在第 208 行反例之后）
P_ANCHOR = "    '- 反例：日记写\"明神大陆是否再次矛头相接\" → 不提取，\"是否\"开头是疑问句不是定义句；日记写\"娶她是为了羞辱她\" → 不提取，\"娶她\"是动词+人称代词根本不是名词；\"总而言之\"是总结连词，这类常用词/非名词结构一律不提取；',"
P_NEW = P_ANCHOR + "\n" + \
    "    '- 反例：日记写\"怎料却是个爹不亲、娘不爱的主\" → 不提取，\"怎料却\"是疑问副词（怎料/怎奈/岂料/岂知）开头的拼接碎片根本不是名词；疑问/揣测副词开头的字串一律不提取；',"
OPS.append(("cloud 反例 怎料却", BASE + "\\cloudfunctions\\optimizeDiary\\index.js", "block", (P_ANCHOR, P_NEW)))


def load(p):
    raw = io.open(p, "rb").read().decode("utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw, nl


def main(mode):
    mode = (mode or "").lstrip("-")  # 兼容 --check/--write（2026-09-24 实锤：不归一会静默空转自报 OK）
    items = []
    all_ok = True
    for name, path, kind, payload in OPS:
        raw, nl = load(path)
        text = raw.replace("\r\n", "\n")
        a, n = payload
        ca, cn = text.count(a), text.count(n)
        if mode == "check":
            if cn > 0:
                items.append((name, "SKIP(已应用)", True))
            elif ca == 1:
                items.append((name, "OK", True))
            else:
                items.append((name, "FAIL(锚点 %d 次)" % ca, False))
                all_ok = False
        elif mode == "write":
            if cn > 0:
                items.append((name, "SKIP(已应用)", True))
            elif ca == 1:
                text = text.replace(a, n, 1)
                io.open(path, "wb").write(text.replace("\n", nl).encode("utf-8"))
                items.append((name, "APPLIED", True))
            else:
                items.append((name, "FAIL(锚点 %d 次)" % ca, False))
                all_ok = False
    for name, st, ok in items:
        print("%-28s %s" % (name, st))
    print("MODE=%s ALL=%s" % (mode, "OK" if all_ok else "FAIL"))
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "check")
