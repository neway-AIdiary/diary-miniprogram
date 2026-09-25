# -*- coding: utf-8 -*-
"""
[entity-verbobj v1] 动宾式动词不备案 —— 补丁（4 文件 7 ops）
用户指令（2026-09-25）：原文「擦肩，也是一种缘分」弹备案「擦肩」。
  要求1：擦肩这类带动词的（动宾结构词）不备案 → 新增 VERBOBJ_WORDS 子串表 +
         两端黑名单同步 + prompt 反例；
  要求2：「也是/也成为」带「也」的不备案 → 已被 FUNC_CHARS(也) 子串拦截与
         aiCloud 首字否决表(也) 双重覆盖，仅补测试锁死，不动代码。
用法（必须在工程根跑）：
  python patch_entity_verbobj.py --check        # 只验锚点与幂等判据，不改文件
  python patch_entity_verbobj.py --write        # 备份 + 落盘（备份已存在则早退，幂等）
  python patch_entity_verbobj.py --restore-src  # 从备份还原 4 个被改文件（红灯自检用）
输出同时写会话目录 patch_verbobj_out.txt（PowerShell stdout 会被吞，以 log 为准）。
"""
import os
import shutil
import sys

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\entity-verbobj-backup-20260925"
LOG_PATH = r"C:\Users\ThinkPad\WorkBuddy\2026-09-15-09-30-50\patch_verbobj_out.txt"

FILES = [
    "utils/entityClean.js",
    "utils/aiCloud.js",
    "cloudfunctions/optimizeDiary/index.js",
    "tools/test_entity_features.js",
]

VERBOBJ_TABLE = (
    "\n"
    "// [entity-verbobj-v1] 动宾式动词成分（2026-09-25 用户指令：「擦肩，也是一种缘分」\n"
    "// 弹备案「擦肩」——动宾结构词（动词+宾语语素）是动词不是名词）。含下列成分（子串）\n"
    "// 即否决，覆盖「擦肩/擦肩而过」类变体；漏拦方向是少弹提醒，绝不误备案\n"
    "const VERBOBJ_WORDS = ['擦肩']"
)

CHECK_EXPLAINED = (
    "  // [entity-verbobj-v1] 动宾式动词成分（擦肩/擦肩而过）→ 是动词不是名词本体\n"
    "  for (let i = 0; i < VERBOBJ_WORDS.length; i++) {\n"
    "    if (n.indexOf(VERBOBJ_WORDS[i]) !== -1) return false\n"
    "  }\n"
)

CHECK_NONNOUN = (
    "  // [entity-verbobj-v1] 人名热词同口径：动宾式动词成分（擦肩）不是名字本体\n"
    "  for (let i = 0; i < VERBOBJ_WORDS.length; i++) {\n"
    "    if (n.indexOf(VERBOBJ_WORDS[i]) !== -1) return true\n"
    "  }\n"
)

NEW_SECTION = (
    "\n"
    "  // ===== [entity-verbobj-v1] 第 29 节：动宾式动词不备案（2026-09-25 用户指令：\n"
    "  // 「擦肩，也是一种缘分」弹备案「擦肩」——动宾结构词是动词不是名词） =====\n"
    "  check('jo-1 用户案例：动宾式动词「擦肩」不备案', entityClean.isExplainedNoun('擦肩', '擦肩，也是一种缘分。', '一种缘分'), false)\n"
    "  check('jo-2 变体「擦肩而过」含动宾成分不备案', entityClean.isExplainedNoun('擦肩而过', '擦肩而过也是一种缘分。', '一种缘分'), false)\n"
    "  check('jo-3 擦肩本体按动宾表否决（热词链路同口径）', entityClean.isNonNounWord('擦肩'), true)\n"
    "  check('jo-4 「也是」带「也」已被功能字子串拦截不备案', entityClean.isExplainedNoun('也是缘分', '擦肩也是一种缘分。', '一种缘分'), false)\n"
    "  check('jo-5 变体「也成为」带「也」不备案', entityClean.isExplainedNoun('也成为', '这次相聚也成为他的转折点。', '他的转折点'), false)\n"
    "  check('jo-6 两端黑名单含「擦肩」（云端路径同拦）',\n"
    "    fs.readFileSync(path.join(base, 'utils/aiCloud.js'), 'utf8').indexOf(\"'擦肩'\") !== -1 &&\n"
    "    fs.readFileSync(path.join(base, 'cloudfunctions/optimizeDiary/index.js'), 'utf8').indexOf(\"'擦肩'\") !== -1, true)\n"
    "  check('jo-7 护栏：真定义不回归（王磊是我的大学同学）', entityClean.isExplainedNoun('王磊', '王磊是我的大学同学。', '我的大学同学'), true)"
)

OPS = [
    ("utils/entityClean.js", "e1 新增 VERBOBJ_WORDS 动宾词表",
     "const ADVERB_PREFIX = ['原来', '原本', '本来', '终于', '居然', '竟然', '明明', '其实', '似乎', '好像', '难道', '毕竟', '简直', '根本', '当然', '几乎', '突然', '忽然']",
     "const ADVERB_PREFIX = ['原来', '原本', '本来', '终于', '居然', '竟然', '明明', '其实', '似乎', '好像', '难道', '毕竟', '简直', '根本', '当然', '几乎', '突然', '忽然']" + VERBOBJ_TABLE),

    ("utils/entityClean.js", "e2 isExplainedNoun 同口径否决",
     "  // [entity-generic v1] 常用泛称/抽象词成分（论证/论证事迹/事迹）→ 不是专名本体\n"
     "  for (let i = 0; i < GENERIC_SUBS.length; i++) {\n"
     "    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return false\n"
     "  }",
     CHECK_EXPLAINED +
     "  // [entity-generic v1] 常用泛称/抽象词成分（论证/论证事迹/事迹）→ 不是专名本体\n"
     "  for (let i = 0; i < GENERIC_SUBS.length; i++) {\n"
     "    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return false\n"
     "  }"),

    ("utils/entityClean.js", "e3 isNonNounWord 同口径否决",
     "  // [entity-generic v1] 人名热词同口径：常用泛称/抽象词（论证/事迹）不是名字本体\n"
     "  for (let i = 0; i < GENERIC_SUBS.length; i++) {\n"
     "    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return true\n"
     "  }",
     CHECK_NONNOUN +
     "  // [entity-generic v1] 人名热词同口径：常用泛称/抽象词（论证/事迹）不是名字本体\n"
     "  for (let i = 0; i < GENERIC_SUBS.length; i++) {\n"
     "    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return true\n"
     "  }"),

    ("utils/aiCloud.js", "e4 小程序端黑名单 +擦肩",
     "const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么', '以为', '知道', '终于']",
     "const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么', '以为', '知道', '终于', '擦肩']"),

    ("cloudfunctions/optimizeDiary/index.js", "e5 云函数黑名单 +擦肩",
     "      const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么', '以为', '知道', '终于']",
     "      const NAME_BLOCK_WORDS = ['为了', '然后', '可以', '以及', '上一', '下一', '一家', '两家', '这家', '那家', '什么', '怎么', '以为', '知道', '终于', '擦肩']"),

    ("cloudfunctions/optimizeDiary/index.js", "e6 prompt 补动宾反例",
     "    '- 反例：日记写\"终于知道是微信小程序的开发平台登录出了问题\" → 不提取，\"终于知道\"是副词\"终于\"和动词\"知道\"拼出的句子碎片、不是名词；副词（终于/居然/竟然/明明/其实等）开头的字串一律不提取；',",
     "    '- 反例：日记写\"终于知道是微信小程序的开发平台登录出了问题\" → 不提取，\"终于知道\"是副词\"终于\"和动词\"知道\"拼出的句子碎片、不是名词；副词（终于/居然/竟然/明明/其实等）开头的字串一律不提取；',\n"
     "    '- 反例：日记写\"擦肩，也是一种缘分\" → 不提取，\"擦肩\"是动宾式动词（动词+宾语语素，如\"擦肩而过\"），不是名词；动宾结构词（擦肩/点头/鼓掌类）一律不提取；',"),

    ("tools/test_entity_features.js", "e7 测试补第 29 节 jo-1~7",
     "  check('zy-7 护栏：果然山不受前缀横展误伤', entityClean.isExplainedNoun('果然山', '果然山是我们村后的大山。'), true)",
     "  check('zy-7 护栏：果然山不受前缀横展误伤', entityClean.isExplainedNoun('果然山', '果然山是我们村后的大山。'), true)" + NEW_SECTION),
]

LOG_LINES = []
def log(msg):
    print(msg)
    LOG_LINES.append(msg)

def load(rel):
    raw = open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    return raw, eol, raw.replace("\r\n", "\n")

def save(rel, text_norm, eol):
    if eol == "\r\n":
        text_norm = text_norm.replace("\n", "\r\n")
    with open(os.path.join(ROOT, rel), "wb") as f:
        f.write(text_norm.encode("utf-8"))

def do_check():
    ok = True
    for rel, name, old, new in OPS:
        _, _, text = load(rel)
        ca, cn = text.count(old), text.count(new)
        status = "OK" if (ca == 1 and cn == 0) else "FAIL"
        if status == "FAIL":
            ok = False
        log("[%s] %-32s anchor=%d new=%d" % (status, name, ca, cn))
    log("CHECK " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_backup():
    if os.path.isdir(BACKUP_DIR):
        log("备份已存在，早退（幂等）: " + BACKUP_DIR)
        return
    os.makedirs(BACKUP_DIR)
    for rel in FILES:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(BACKUP_DIR, rel.replace("/", "__"))
        shutil.copy2(src, dst)
        log("backup: " + rel)

def do_write():
    do_backup()
    ok = True
    for rel, name, old, new in OPS:
        _, eol, text = load(rel)  # 只 load 一次（踩坑 5）
        ca, cn = text.count(old), text.count(new)
        if ca == 1 and cn == 0:
            save(rel, text.replace(old, new), eol)
            _, _, after = load(rel)
            # 追加型 op（old 是 new 的子串）落盘后 old 仍在，不能要求清零
            old_gone_ok = True if new.find(old) != -1 else after.count(old) == 0
            ok2 = after.count(new) == 1 and old_gone_ok
            log("[OK]  %-32s 落盘复核=%s" % (name, "OK" if ok2 else "FAIL"))
            ok = ok and ok2
        elif cn == 1:
            # 已是补丁态：追加型 op 落盘后 old 仍在（ca==1），替换型 op ca==0，统一看 new 是否在场
            log("[SKIP] %-31s 已是补丁态（幂等）" % name)
        else:
            log("[FAIL] %-32s anchor=%d new=%d —— 未写盘" % (name, ca, cn))
            ok = False
    log("WRITE " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_restore_src():
    if not os.path.isdir(BACKUP_DIR):
        log("无备份可还原: " + BACKUP_DIR)
        return False
    for rel in FILES:
        dst = os.path.join(BACKUP_DIR, rel.replace("/", "__"))
        if not os.path.isfile(dst):
            log("[FAIL] 备份缺文件: " + rel)
            return False
        shutil.copy2(dst, os.path.join(ROOT, rel))
        log("restore: " + rel)
    log("RESTORE ALL=OK")
    return True

def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "--check").lstrip("-")  # 踩坑 12：先归一再分支
    if mode == "check":
        ok = do_check()
    elif mode == "write":
        ok = do_write()
    elif mode == "restore-src":
        ok = do_restore_src()
    else:
        log("unknown mode: " + mode)
        ok = False
    try:
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(LOG_LINES))
    except Exception as e:
        print("log write failed:", e)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
