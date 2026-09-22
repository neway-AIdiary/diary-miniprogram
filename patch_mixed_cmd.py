# -*- coding: utf-8 -*-
"""
[mixed-sentence v1] 口语引导语 + 句尾指令（2026-09-22 真机：iPhone）

现场
----
用户语音输入「把志伟改成「杨志伟」」，第一句「今天我来到志伟的办公室」里的「志伟」没被替换，
指令句还留在正文里（点【AI优化】后原样带回）。

根因（探针实锤，用线上那份 utils/aiEdit.js 跑的）
------------------------------------------------
   输入              判定
   把志伟改成杨志伟               → replace 指令，正常识别
   今天…彩蛋。把志伟改成杨志伟。   → 指令被单独执行（前边有句号断开）
   你看，你看，我接着说，把志伟改成杨志伟。 → **判为叙述，0 条指令**（真机现场形状）
机制：splitSentences 只按 。！？\\n 切句、**不切逗号**；detect 要求**整句就是纯指令**。
ASR 把指令用逗号黏在前文后边 ⇒ 整句带前缀去匹配 ⇒ 认不出 ⇒ 按叙述追加进正文。
点【AI优化】时 extractEmbedded 用同一套切句与整句判定 ⇒ 也认不出（第二条链路一起失效）。

iPhone 的角色：iOS 无流式，整段走录音文件识别（speechToText 回退链路），一次性整块交付；
「把」字前是逗号还是句号完全由云端 ASR 决定（接着前文一口气说下来时多半给逗号）。

修法（用户拍板 1：口语引导语剥离）
--------------------------------
整句不是指令时，按句内断点（逗号/顿号/冒号/分号/省略号/空白）取**最后一段**再试一次。

两道保守闸（关键，否则会从「不执行」变成「乱执行/丢字」）
-------------------------------------------------------
① 只切**最后一个**断点、前缀必须非空 —— 只有「引导语 + 句尾指令」这一种形状命中。
   不逐段试：否则叙述里随便一个「把X删掉」都可能被拆出来当指令执行。
② **干跑闸**：给定的正文里必须真能找到目标（apply 会改动）才认，否则整句原样留作叙述。
   这条保证任何误判的代价都只是「指令没执行」，**绝不会凭空吞掉用户说的话**。

配套
----
* 前缀归叙述（「我接着说，」是用户自己写的内容，不能跟着指令一起消失）；结尾标点顺带去掉。
* splitCommands 新增第 3 参 content：**不传就不做**（没正文可干跑时不冒险执行）⇒ 旧调用行为逐字不变。
* extractEmbedded 内部本来就有正文（narrative），干跑成功才提交；失败则整句按叙述保留（信息零丢失）。
* 顺带修掉一个错误解析：`我接着说：把志伟改成杨志伟。`（冒号）原先会把 from 解析成
  「我接着说：把志伟」——现在冒号也是断点，尾段剥离后 from = 志伟。
* 无云函数改动；纯客户端逻辑。

用法：--check（只验锚点与幂等） | --write（落盘，含幂等备份） | --restore-src | --restore
"""
import io
import os
import sys
import shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\mixed-cmd-backup-20260922'

CRLF = chr(13) + chr(10)
LF = chr(10)

AE = 'utils/aiEdit.js'
WJ = 'pages/write/write.js'
DT = 'pages/detail/detail.js'

OPS = []


def op(rel, tag, old, new, sig):
    OPS.append((rel, {'tag': tag, 'old': old, 'new': new, 'sig': sig}))


# ============================================================
# utils/aiEdit.js
# ============================================================

# ---- A1 新增 splitTailSeg + detectTailCommand ----
op(AE, 'A1 句尾指令剥离（两道闸）',
   r"""// ===== 按句拆分：支持一段输入/正文中混合多条指令 =====""",
   r"""// ===== 口语引导语剥离（2026-09-22 真机：iPhone 语音「…我接着说，把志伟改成杨志伟。」）=====
// 现场：ASR 把指令句用**逗号**黏在前文后边，而 splitSentences 只认 。！？\n ⇒ 整句带前缀
// 去做指令匹配 ⇒ 判为叙述 ⇒ 指令不执行、还留在正文里（优化时 extractEmbedded 同判，一起失效）。
// 做法：整句不是指令时，按句内断点（逗号/顿号/冒号/分号/省略号/空白）取**最后一段**再试一次。
// 两道保守闸：
//   ① 只切**最后一个**断点 —— 只有「引导语 + 句尾指令」这一种形状命中；
//      不逐段试，否则叙述里随便一个「把X删掉」都可能被拆出来当指令执行。
//   ② 干跑闸：给出的正文里必须真能找到目标（apply 会改动）才认，否则整句原样留作叙述 ——
//      保证任何误判的代价都只是「指令没执行」，**绝不会凭空吞掉用户说的话**。
// 前缀归叙述（「我接着说，」是用户自己写的内容，不能跟着指令一起消失）。
const TAIL_BOUNDARY_RE = /[，,、：:；;…\s]+/g

/* 取句子最后一个句内断点 → {lead, tail}；尾段必须非空，否则 null */
function splitTailSeg(sentence) {
  const s = String(sentence == null ? '' : sentence)
  let start = -1
  let end = -1
  let m
  TAIL_BOUNDARY_RE.lastIndex = 0
  while ((m = TAIL_BOUNDARY_RE.exec(s)) !== null) {
    // 断点后边还得有内容；断点本身可以在句首（「，把志伟改成杨志伟。」⇒ 前缀为空）
    if (m.index + m[0].length < s.length) {
      start = m.index
      end = m.index + m[0].length
    }
  }
  if (start < 0) return null
  const tail = s.slice(end).trim()
  if (!tail) return null
  // 前缀允许为空（整句以断点开头，如「，把志伟改成杨志伟。」）：那就只执行指令、不追加前缀
  const lead = s.slice(0, start).replace(/[，,、：:；;…\s]+$/, '')
  return { lead: lead, tail: tail }
}

/**
 * [mixed-sentence v1] 句尾指令识别：整句不是指令时的兜底（两道闸见上方注释）。
 * @param {string} sentence 单句（含句末标点）
 * @param {object} [opts] 透传给 detect（语音输入用 {loose:true}）
 * @param {string} [content] 当前正文；**不传就整体不做**（没正文可干跑时不冒险执行）
 * @returns {{edit:Object, lead:string}|null} lead = 该留下的引导语（已去掉结尾标点）
 */
function detectTailCommand(sentence, opts, content) {
  if (content === undefined || content === null) return null
  const seg = splitTailSeg(sentence)
  if (!seg) return null
  const edit = detectSentence(seg.tail, opts)
  if (!edit) return null
  if (!apply(String(content), edit).changed) return null
  return { edit: edit, lead: seg.lead }
}

// ===== 按句拆分：支持一段输入/正文中混合多条指令 =====""",
   'function detectTailCommand(sentence, opts, content) {')

# ---- A2 splitCommands 接住句尾指令（第 3 参 content）----
op(AE, 'A2 splitCommands 三参 + 句尾分支',
   """ * @param {{loose?:boolean}} [opts] 透传给 detect：语音输入用宽松识别
 * @returns {{commands:Array, narrative:string}}
 */
function splitCommands(text, opts) {
  const commands = []
  let narrative = ''
  for (const s of splitSentences(text)) {
    const edit = detectSentence(s, opts)
    if (edit) commands.push(edit)
    else narrative += s
  }
  return { commands: commands, narrative: narrative.trim() }
}""",
   """ * @param {{loose?:boolean}} [opts] 透传给 detect：语音输入用宽松识别
 * @param {string} [content] 当前正文：给了才能做「句尾指令剥离」的干跑校验
 *   （不给 ⇒ 该能力关闭，行为与旧版逐字相同）
 * @returns {{commands:Array, narrative:string}}
 */
function splitCommands(text, opts, content) {
  const commands = []
  let narrative = ''
  for (const s of splitSentences(text)) {
    const edit = detectSentence(s, opts)
    if (edit) {
      commands.push(edit)
      continue
    }
    // [mixed-sentence v1] 整句不是指令时，试剥「口语引导语」：
    // 「你看，你看，我接着说，把志伟改成杨志伟。」→ 执行替换 + 前缀留作叙述
    const tail = detectTailCommand(s, opts, content)
    if (tail) {
      commands.push(tail.edit)
      narrative += tail.lead
      continue
    }
    narrative += s
  }
  return { commands: commands, narrative: narrative.trim() }
}""",
   'function splitCommands(text, opts, content) {')

# ---- A3 extractEmbedded 同样接住句尾指令 ----
op(AE, 'A3 extractEmbedded 接住句尾指令',
   """  for (const s of splitSentences(content)) {
    const edit = detectSentence(s)
    if (!edit) { narrative += s; continue }
    const res = apply(narrative, edit)
    if (res.changed) {
      narrative = res.content
      applied.push({ edit: edit, result: res })""",
   """  for (const s of splitSentences(content)) {
    let edit = detectSentence(s)
    let lead = ''
    if (!edit) {
      // [mixed-sentence v1] 口语引导语 + 句尾指令（「…我接着说，把志伟改成杨志伟。」）：
      // 干跑成功才认（认了才吃这句），否则整句按叙述保留 —— 绝不因误判丢字。
      const tail = detectTailCommand(s, undefined, narrative)
      if (tail) { edit = tail.edit; lead = tail.lead }
    }
    if (!edit) { narrative += s; continue }
    const res = apply(narrative, edit)
    if (res.changed) {
      // 引导语留下（用户自己写的内容），只吃掉指令尾段
      narrative = res.content + lead
      applied.push({ edit: edit, result: res })""",
   "      const tail = detectTailCommand(s, undefined, narrative)")


# ---- A4 裸替换指令：目标词/新词不许含句内断点（防「我接着说：把志伟」被整段当目标）----
op(AE, 'A4 裸替换目标词排除句内断点',
   r"""const BARE_REPLACE_PATTERNS = [
  /^([^，,、。！!？?\s改换该]{2,8}?)(?:更改为|修改为|更正为|替换为|替换成|更换成|更改成|换成|变成|改为|改成|调整为|调整成|变更为)([^，,、。！!？?\s]{1,20})[。！!？?]?$/
]""",
   r"""const BARE_REPLACE_PATTERNS = [
  // [mixed-sentence v1] 目标词与新词都不许含句内断点（：:；;…）——
  // 否则「我接着说：把志伟改成杨志伟」会把「我接着说：把志伟」整个当成目标词：
  // 正文里根本找不到 ⇒ 既没执行替换，这句又当指令被吃掉（用户说的话凭空消失）。
  // 断点交给句尾剥离（detectTailCommand）负责切开。
  /^([^，,、。！!？?\s：:；;…改换该]{2,8}?)(?:更改为|修改为|更正为|替换为|替换成|更换成|更改成|换成|变成|改为|改成|调整为|调整成|变更为)([^，,、。！!？?\s：:；;…]{1,20})[。！!？?]?$/
]""",
   '/^([^，,、。！!？?\\s：:；;…改换该]{2,8}?)(?:更改为|修改为|更正为|替换为|替换成|更换成|更改成|换成|变成|改为|改成|调整为|调整成|变更为)')


# ============================================================
# pages/write/write.js / pages/detail/detail.js
# ============================================================

# ---- W1 写日记页：把当前正文传给 splitCommands（干跑校验用）----
op(WJ, 'W1 写页传出正文',
   """    const parsed = aiEdit.splitCommands(trimmed, loose)
    if (parsed.commands.length > 0) {""",
   """    // [mixed-sentence v1] 传出当前正文：句尾指令要用它做「干跑」校验
    // （「你看，你看，我接着说，把志伟改成杨志伟。」这类引导语 + 指令混合句）
    const parsed = aiEdit.splitCommands(trimmed, loose, this.data.content)
    if (parsed.commands.length > 0) {""",
   '    const parsed = aiEdit.splitCommands(trimmed, loose, this.data.content)')

# ---- D1 详情页：同上（两个入口必须一致，否则详情页说话还是旧的）----
op(DT, 'D1 详情页传出正文',
   """    const parsed = aiEdit.splitCommands(trimmed, loose)
    if (parsed.commands.length > 0) {""",
   """    // [mixed-sentence v1] 传出当前正文：句尾指令要用它做「干跑」校验（与写日记页同口径）
    const parsed = aiEdit.splitCommands(trimmed, loose, this.data.content)
    if (parsed.commands.length > 0) {""",
   '    const parsed = aiEdit.splitCommands(trimmed, loose, this.data.content)')


# ============================================================
# 框架
# ============================================================


def load(rel):
    p = os.path.join(ROOT, rel)
    with io.open(p, 'rb') as f:
        raw = f.read().decode('utf-8')
    crlf = CRLF in raw
    text = raw.replace(CRLF, LF)
    return raw, text, crlf


def save(rel, text, crlf):
    p = os.path.join(ROOT, rel)
    out = text.replace(LF, CRLF) if crlf else text
    with io.open(p, 'wb') as f:
        f.write(out.encode('utf-8'))


def do_backup(rel):
    src = os.path.join(ROOT, rel)
    dst = os.path.join(BACKUP, rel.replace('/', os.sep))
    d = os.path.dirname(dst)
    if not os.path.isdir(d):
        os.makedirs(d)
    # [幂等备份] 已存在就不覆盖：多次 --write 必须保留**最早**（补丁前）的版本，
    # 否则红灯自检会跑一个「新老混血体」（9-22 实锤）。
    if os.path.isfile(dst):
        return
    if os.path.isfile(src):
        shutil.copy2(src, dst)


def run(mode):
    do_write = (mode == '--write')
    counts = {'OK': 0, 'SKIP': 0, 'PENDING': 0, 'ERR': 0}
    cache = {}

    for rel, o in OPS:
        if rel not in cache:
            raw, text, crlf = load(rel)
            cache[rel] = {'text': text, 'crlf': crlf, 'dirty': False}
        ent = cache[rel]
        text = ent['text']
        sig = o['sig']
        old = o['old']
        if sig in text:
            st = 'SKIP'
        else:
            n = text.count(old)
            if n == 1:
                ent['text'] = text.replace(old, o['new'], 1)
                ent['dirty'] = True
                st = 'OK'
            elif n == 0:
                st = 'ERR_ANCHOR_MISSING'
            else:
                st = 'ERR_ANCHOR_DUP(%d)' % n
        key = 'ERR' if st.startswith('ERR') else st
        counts[key] += 1
        print('[%s] %s -> %s' % (mode, rel + ' :: ' + o['tag'], st))

    if do_write:
        for rel, ent in cache.items():
            if ent['dirty']:
                do_backup(rel)
                save(rel, ent['text'], ent['crlf'])
                print('[write] %s 已落盘（已备份到 %s）' % (rel, BACKUP))

    print('RESULT: OK=%d SKIP=%d PENDING=%d ERR=%d' % (
        counts['OK'], counts['SKIP'], counts['PENDING'], counts['ERR']))
    return 1 if counts['ERR'] else 0


def restore(include_new):
    files = sorted(set([rel for rel, _ in OPS]))
    for rel in files:
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        if not os.path.isfile(src):
            print('[restore] 缺备份 %s' % rel)
            continue
        dst = os.path.join(ROOT, rel)
        shutil.copy2(src, dst)
        print('[restore] %s' % rel)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--check':
        sys.exit(run('--check'))
    elif mode == '--write':
        sys.exit(run('--write'))
    elif mode == '--restore-src':
        restore(False)
    elif mode == '--restore':
        restore(True)
    else:
        print('用法: --check | --write | --restore-src | --restore')
