# -*- coding: utf-8 -*-
"""
[entity-generic v1] 常识级常用词不备案（2026-09-24 用户指令）

用户案例：弹窗「黄河」「论证」（「论证事迹」为拼接碎片）——都是常用词，不应提醒备案。

改动（3 个文件）：
  1. utils/entityClean.js
     - NON_NOUN_WORDS 整词加「黄河」（常识级地名；整词匹配保住「黄河大桥」类组合专名）
     - 新建 GENERIC_SUBS = ['论证', '事迹']（常用泛称/抽象词，子串拦「论证事迹」类拼接）
     - isExplainedNoun / isNonNounWord 两路口径同步加 GENERIC_SUBS 检查
  2. tools/test_entity_features.js  第 22 节 lg-1~6
  3. cloudfunctions/optimizeDiary/index.js  prompt 追加反例（行插入，不急部署）

用法：--check / --write / --restore
"""
import io
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
BAKDIR = os.path.join(BASE, "_autobak_entity_generic")

# ============ utils/entityClean.js ============

EC_OPS = [
    (
        "ec-1 NON_NOUN_WORDS 整词加「黄河」",
        "  '公司', '学校', '单位', '朋友', '同事', '同学', '孩子', '家里', '工作', '生活', '状态', '心情', '感觉', '计划', '安排',",
        "  '公司', '学校', '单位', '朋友', '同事', '同学', '孩子', '家里', '工作', '生活', '状态', '心情', '感觉', '计划', '安排',\n"
        "  // [entity-famous v1] 常识级专名不备案（2026-09-24 用户指令：「黄河」是常用词不用提醒备案）。\n"
        "  // 必须整词匹配——保住「黄河大桥/黄河公园」类组合专名；同族扩展（长江/长城等）等个案出现再加\n"
        "  '黄河',",
    ),
    (
        "ec-2 新建 GENERIC_SUBS 常量",
        "const NARR_WORDS = ['说', '讲', '写', '画', '描述', '告诉']",
        "const NARR_WORDS = ['说', '讲', '写', '画', '描述', '告诉']\n"
        "// [entity-generic v1] 常用泛称/抽象词成分（2026-09-24 用户指令：「黄河」「论证」是常用词，\n"
        "// 不提醒备案）。「论证/事迹」走子串拦「论证事迹」类拼接碎片；「黄河」是常识级地名、\n"
        "// 走 NON_NOUN_WORDS 整词（见 [entity-famous v1]）。两词不会出现在真专名中，符合收词纪律\n"
        "const GENERIC_SUBS = ['论证', '事迹']",
    ),
    (
        "ec-3 isExplainedNoun 加 GENERIC_SUBS 检查",
        "  for (let i = 0; i < NARR_WORDS.length; i++) {\n"
        "    if (n.indexOf(NARR_WORDS[i]) !== -1) return false\n"
        "  }",
        "  for (let i = 0; i < NARR_WORDS.length; i++) {\n"
        "    if (n.indexOf(NARR_WORDS[i]) !== -1) return false\n"
        "  }\n"
        "  // [entity-generic v1] 常用泛称/抽象词成分（论证/论证事迹/事迹）→ 不是专名本体\n"
        "  for (let i = 0; i < GENERIC_SUBS.length; i++) {\n"
        "    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return false\n"
        "  }",
    ),
    (
        "ec-4 isNonNounWord 同口径加 GENERIC_SUBS 检查",
        "  for (let i = 0; i < NARR_WORDS.length; i++) {\n"
        "    if (n.indexOf(NARR_WORDS[i]) !== -1) return true\n"
        "  }",
        "  for (let i = 0; i < NARR_WORDS.length; i++) {\n"
        "    if (n.indexOf(NARR_WORDS[i]) !== -1) return true\n"
        "  }\n"
        "  // [entity-generic v1] 人名热词同口径：常用泛称/抽象词（论证/事迹）不是名字本体\n"
        "  for (let i = 0; i < GENERIC_SUBS.length; i++) {\n"
        "    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return true\n"
        "  }",
    ),
]

# ============ tools/test_entity_features.js ============

T_ANCHOR = (
    "check('jb-7 「叫」+人名仍可弹（姐夫叫王磊）', entityClean.isExplainedNoun('姐夫', '我姐夫叫王磊，是个热心肠的人。', '是个热心肠的人'), true)"
)
T_NEW = T_ANCHOR + "\n" + "\n" + \
    "  // ===== [entity-generic v1] 第 22 节：常识级常用词不备案（lg-1~6）=====\n" + \
    "  check('lg-1 用户案例：黄河是常识级地名不备案', entityClean.isExplainedNoun('黄河', '黄河是中国的母亲河。', '中国的母亲河'), false)\n" + \
    "  check('lg-2 论证是常用抽象词', entityClean.isNonNounWord('论证'), true)\n" + \
    "  check('lg-3 「论证事迹」拼接碎片不备案', entityClean.isNonNounWord('论证事迹'), true)\n" + \
    "  check('lg-4 事迹是泛称', entityClean.isNonNounWord('事迹'), true)\n" + \
    "  check('lg-5 护栏：黄河大桥不被整词表误伤', entityClean.isNonNounWord('黄河大桥'), false)\n" + \
    "  check('lg-6 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)"

TEST_OPS = [
    ("ts-1 测试第 22 节 lg-1~6", T_ANCHOR, T_NEW),
]

# ============ cloudfunctions/optimizeDiary/index.js ============
# 行插入模式：避免手抄含全角引号的长行做锚点

CF_MARKER = "妈妈就给我姐夫打电话"
CF_NEW_LINE = (
    "    '- 反例：日记写\"黄河是中国的母亲河\" → 不提取，\"黄河\"是常识级地理名词（人尽皆知，不需要备案提醒）；"
    "\"论证\"是常用抽象词、\"论证事迹\"是泛称拼接碎片，这类常用词/泛称一律不提取；',"
)

FILE_OPS = {
    "utils/entityClean.js": EC_OPS,
    "tools/test_entity_features.js": TEST_OPS,
}
LINE_INSERTS = {
    "cloudfunctions/optimizeDiary/index.js": ("cf-1 prompt 追加常用词反例", CF_MARKER, CF_NEW_LINE),
}


def rel_path(p):
    return os.path.join(BASE, p.replace("/", os.sep))


def load(p):
    with io.open(p, "rb") as f:
        return f.read().decode("utf-8")


def save(p, raw):
    with io.open(p, "wb") as f:
        f.write(raw.encode("utf-8"))


def plan():
    """返回 {rel: (raw, nl, [(name, kind, ok, payload)])}；kind: block|line"""
    result = {}
    for rel, ops in FILE_OPS.items():
        p = rel_path(rel)
        raw = load(p)
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        items = []
        for name, a, n in ops:
            ca = text.count(a)
            cn = text.count(n)
            ok = (ca == 1) or (ca == 0 and cn == 1)
            items.append((name, "block", ok, (a, n)))
        result[rel] = (raw, nl, items)
    for rel, (name, marker, newline) in LINE_INSERTS.items():
        p = rel_path(rel)
        raw = load(p)
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        hits = text.count(newline)
        cnt = sum(1 for l in text.split("\n") if marker in l)
        ok = (cnt == 1) or (hits == 1 and cnt <= 1)
        result[rel] = (raw, nl, [(name, "line", ok, (marker, newline))])
    return result


def main(mode):
    if mode == "--restore":
        okall = True
        for rel in list(FILE_OPS) + list(LINE_INSERTS):
            bak = os.path.join(BAKDIR, rel.replace("/", "_"))
            if os.path.exists(bak):
                shutil.copyfile(bak, rel_path(rel))
                print("RESTORE", rel)
            else:
                print("RESTORE MISS", rel)
                okall = False
        sys.exit(0 if okall else 1)

    data = plan()
    okall = True
    for rel, (raw, nl, items) in data.items():
        for name, kind, ok, payload in items:
            if not ok:
                okall = False
                print("%-44s FAIL" % name)
            else:
                print("%-44s OK" % name)

    if mode == "--check":
        print("CHECK %s" % ("OK" if okall else "FAIL"))
        sys.exit(0 if okall else 1)

    if mode == "--write":
        if not okall:
            print("WRITE ABORT")
            sys.exit(1)
        for rel, (raw, nl, items) in data.items():
            bak = os.path.join(BAKDIR, rel.replace("/", "_"))
            if not os.path.exists(bak):
                os.makedirs(os.path.dirname(bak), exist_ok=True)
                shutil.copyfile(rel_path(rel), bak)
            text = raw.replace("\r\n", "\n")
            for name, kind, ok, payload in items:
                if kind == "block":
                    a, n = payload
                    # [补丁坑 6 防复发] new 以 old 为前缀时（ts-1），二次 --write 会重复注入；
                    # 替换前必须确认 new 尚不存在
                    if text.count(a) == 1 and text.count(n) == 0:
                        text = text.replace(a, n, 1)
                else:
                    marker, newline = payload
                    lines = text.split("\n")
                    if newline not in text:
                        for i, l in enumerate(lines):
                            if marker in l:
                                lines.insert(i + 1, newline)
                                break
                    text = "\n".join(lines)
            save(rel_path(rel), text.replace("\n", nl))
            print("WRITE", rel)
        return

    print("用法: --check | --write | --restore")
    sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
