# -*- coding: utf-8 -*-
# [entity-time-adv-v1] 时间词「如今/至今」+ 情态副词「充其量/顶多/至多」（2026-09-24 用户指令：
# 「到了如今，这是她的思想」弹「如今」、「充其量是舆论的玩偶」弹「充其量」——均非常用名词）。
# 铁律：锚点 count==1；write 判据 = count(anchor)==1 && count(new)==0；mode 先 lstrip('-')。
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"

OPS = []

# op1: DATE_WORDS 追加 如今/至今
D_ANCHOR = "'每年', '每次']"
D_NEW = "'每年', '每次', '如今', '至今']"
OPS.append(("ec DATE_WORDS +如今/至今", BASE + "\\utils\\entityClean.js", "block", (D_ANCHOR, D_NEW)))

# op2: FREQ_ADV_WORDS 追加 充其量/顶多/至多
F_ANCHOR = "'似乎', '仿佛']"
F_NEW = "'似乎', '仿佛', '充其量', '顶多', '至多']"
OPS.append(("ec FREQ_ADV +充其量等", BASE + "\\utils\\entityClean.js", "block", (F_ANCHOR, F_NEW)))

# op3: 测试套件第 25 节
T_ANCHOR = "check('zl-5 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)"
T_NEW = T_ANCHOR + "\n" + "\n" + \
    "  // ===== [entity-time-adv-v1] 第 25 节：时间词/情态副词不备案（rj-1~6）=====\n" + \
    "  check('rj-1 用户案例：如今是时间词不备案', entityClean.isExplainedNoun('如今', '到了如今，这是她的思想。', '她的思想'), false)\n" + \
    "  check('rj-2 用户案例：充其量是情态副词不备案', entityClean.isExplainedNoun('充其量', '她充其量是舆论的玩偶。', '是舆论的玩偶'), false)\n" + \
    "  check('rj-3 如今本体按时间词否决', entityClean.isNonNounWord('如今'), true)\n" + \
    "  check('rj-4 至今同族变体', entityClean.isNonNounWord('至今'), true)\n" + \
    "  check('rj-5 充其量本体按副词否决', entityClean.isNonNounWord('充其量'), true)\n" + \
    "  check('rj-6 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)"
OPS.append(("test 第 25 节 rj-1~6", BASE + "\\tools\\test_entity_features.js", "block", (T_ANCHOR, T_NEW)))

# op4: 云函数 prompt 反例（追加在怎料却反例之后）
P_ANCHOR = "'- 反例：日记写\"怎料却是个爹不亲、娘不爱的主\" → 不提取，\"怎料却\"是疑问副词（怎料/怎奈/岂料/岂知）开头的拼接碎片根本不是名词；疑问/揣测副词开头的字串一律不提取；',"
P_NEW = P_ANCHOR + "\n" + \
    "    '- 反例：日记写\"到了如今，这是她的思想\" → 不提取，\"如今\"是时间词（如今/至今/而今）不是名词；日记写\"充其量是舆论的玩偶\" → 不提取，\"充其量\"是揣测性情态副词（充其量/顶多/至多）；时间词与情态副词一律不提取；',"
OPS.append(("cloud 反例 如今/充其量", BASE + "\\cloudfunctions\\optimizeDiary\\index.js", "block", (P_ANCHOR, P_NEW)))


def load(p):
    raw = io.open(p, "rb").read().decode("utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw, nl


def main(mode):
    mode = (mode or "").lstrip("-")  # 坑 12：--check/--write 必须归一再分支，否则静默空转
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
