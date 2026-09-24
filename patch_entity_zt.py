# -*- coding: utf-8 -*-
"""
[entity-sumword/whether/tailpron v1] 备案误报第六轮修复（2026-09-24 用户指令）

三个案例三个洞：
  1.「总而言之」——总结连词，NON_NOUN_WORDS 整词收（总之/综上所述/由此可见一并收）
  2.「明神大陆是否…」——「是否」开头的疑问句不是定义句，NEG_LEADS 并入「是否」
  3.「娶她」——动词+人称代词不是名词，收尾字扩展人称代词（她/它/他/你/我/们）

改动（3 个文件）：
  1. utils/entityClean.js   4 op
  2. tools/test_entity_features.js  第 23 节 zt-1~6（追加型，防坑 6）
  3. cloudfunctions/optimizeDiary/index.js  prompt 追加反例（行插入，不急部署）

用法：--check / --write / --restore
"""
import io
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
BAKDIR = os.path.join(BASE, "_autobak_entity_zt")

EC_OPS = [
    (
        "ec-1 NON_NOUN_WORDS 收总结连词",
        "  '黄河',",
        "  '黄河',\n"
        "  // [entity-sumword v1] 总结连词（2026-09-24 用户指令：「总而言之」不提醒备案）；\n"
        "  // 含「的/是」等功能字的（简而言之/总的来说/也就是说）已被 FUNC_CHARS 拦，不重复收\n"
        "  '总而言之', '总之', '综上所述', '由此可见',",
    ),
    (
        "ec-2 NEG_LEADS 并入「是否」",
        "const NEG_LEADS = ['不是', '不像', '没有', '不算', '不如', '没像', '没成']",
        "// [entity-whether v1] 2026-09-24 用户侧 bug：「明神大陆是否再次矛头相接」弹「明神大陆」——\n"
        "// 「是否」开头的疑问/选择句不是定义句（「是」字兜底引导词误命中）。并入本表：命中即整条否决\n"
        "const NEG_LEADS = ['不是', '不像', '没有', '不算', '不如', '没像', '没成', '是否']",
    ),
    (
        "ec-3 isExplainedNoun 收尾字扩展人称代词",
        "  const tailChar = n.charAt(n.length - 1)\n"
        "  if (tailChar === '这' || tailChar === '那') return false",
        "  const tailChar = n.charAt(n.length - 1)\n"
        "  // [entity-tailpron v1] 2026-09-24 用户侧 bug：「娶她是为了羞辱她」弹「娶她」——动词+人称\n"
        "  // 代词根本不是名词。以人称代词收尾的一律否决（「马耳他」类极罕见专名宁可少弹：\n"
        "  // 项目原则 = 漏拦方向是少弹提醒，绝不误备案）\n"
        "  if (tailChar === '这' || tailChar === '那') return false\n"
        "  if ('她它你我他们'.indexOf(tailChar) !== -1) return false",
    ),
    (
        "ec-4 isNonNounWord 同口径收尾字扩展",
        "  const tailChar = n.charAt(n.length - 1)\n"
        "  if (tailChar === '这' || tailChar === '那') return true",
        "  const tailChar = n.charAt(n.length - 1)\n"
        "  if (tailChar === '这' || tailChar === '那') return true\n"
        "  // [entity-tailpron v1] 人名热词同口径：人称代词收尾（娶她/打他/陪你）不是名字本体\n"
        "  if ('她它你我他们'.indexOf(tailChar) !== -1) return true",
    ),
]

T_ANCHOR = (
    "  check('lg-6 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)"
)
T_NEW = T_ANCHOR + "\n" + "\n" + \
    "  // ===== [entity-sumword/whether/tailpron v1] 第 23 节：总结连词/是否疑问/代词收尾（zt-1~6）=====\n" + \
    "  check('zt-1 用户案例：总而言之是总结连词不备案', entityClean.isExplainedNoun('总而言之', '总而言之是一场误会，不必再提。', '是一场误会'), false)\n" + \
    "  check('zt-2 总而言之本体非名词', entityClean.isNonNounWord('总而言之'), true)\n" + \
    "  check('zt-3 用户案例：「是否」开头是疑问不是定义（明神大陆）', entityClean.isExplainedNoun('明神大陆', '明神大陆是否再次矛头相接，谁也说不准。', '是否再次矛头相接'), false)\n" + \
    "  check('zt-4 用户案例：动词+代词「娶她」不是名词', entityClean.isExplainedNoun('娶她', '我娶她是为了羞辱她。', '是为了羞辱她'), false)\n" + \
    "  check('zt-5 护栏：明神大陆本体合法（热词链路不误伤）', entityClean.isNonNounWord('明神大陆'), false)\n" + \
    "  check('zt-6 护栏：左小小不被新规则误伤', entityClean.isNonNounWord('左小小'), false)"

TEST_OPS = [
    ("ts-1 测试第 23 节 zt-1~6", T_ANCHOR, T_NEW),
]

CF_MARKER = "常识级地理名词"
CF_NEW_LINE = (
    "    '- 反例：日记写\"明神大陆是否再次矛头相接\" → 不提取，\"是否\"开头是疑问句不是定义句；"
    "日记写\"娶她是为了羞辱她\" → 不提取，\"娶她\"是动词+人称代词根本不是名词；\"总而言之\"是总结连词，"
    "这类常用词/非名词结构一律不提取；',"
)

FILE_OPS = {
    "utils/entityClean.js": EC_OPS,
    "tools/test_entity_features.js": TEST_OPS,
}
LINE_INSERTS = {
    "cloudfunctions/optimizeDiary/index.js": ("cf-1 prompt 追加三案例反例", CF_MARKER, CF_NEW_LINE),
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
    result = {}
    for rel, ops in FILE_OPS.items():
        raw = load(rel_path(rel))
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
        raw = load(rel_path(rel))
        nl = "\r\n" if "\r\n" in raw else "\n"
        text = raw.replace("\r\n", "\n")
        cnt = sum(1 for l in text.split("\n") if marker in l)
        ok = (cnt == 1) or (newline in text)
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
                print("%-46s FAIL" % name)
            else:
                print("%-46s OK" % name)

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
                    # [补丁坑 6 防复发] 追加型 op（new 含 old）：new 已存在则绝不替换
                    if text.count(a) == 1 and text.count(n) == 0:
                        text = text.replace(a, n, 1)
                else:
                    marker, newline = payload
                    if newline not in text:
                        lines = text.split("\n")
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
