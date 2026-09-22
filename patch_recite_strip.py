# -*- coding: utf-8 -*-
"""
[recite-strip v1] 「补充指令」不许留在正文里（2026-09-22 真机实例）

现场
----
用户在写日记页写了：
    天高云淡，望断南飞雁。不到长城非好汉，屈指行程二万。帮我把这首词补充完整。
点【AI 优化】→ 词确实补全了（很好），但「帮我把这首词补充完整。」这句指令**留在了正文里**。

根因（两处，缺一不可）
--------------------
1) 锚点断链：quoteAsk.detect 的判定链是「触发词 AND 素材锚点」。
   「补充完整」命中触发词，但锚点六路全不中：
     A 书名号 ✗ / B 池内篇名 ✗（池里没有《清平乐·六盘山》）/ C 引号句 ✗ /
     D 人名 ✗（毛泽东不在作者库）/ E 文体词 ✗（GENRE_WORDS 只收「宋词/诗词」这类，
       刻意不收光杆的「词」，防「把这段话补充完整」误触发）/ F 名句片段 ✗
   ⇒ reason='no-anchor' ⇒ **静默退回普通润色**（按设计不提示）。
2) 普通润色链路没有任何一处剥指令句：aiEdit 只管删/改/换类指令，quoteAsk.strip 只在
   素材补全通道里跑。于是指令句作为正文的一部分发给 AI，AI 把它当正文一起润色着送回，
   点【应用】后落进日记（用户看到的现场）。

修法（用户拍板 1 + 2 都做）
-------------------------
改 2：新增锚点 G「指代 + 文体」（这首词 / 那首诗 / 这一句名言）—— 让这类求助**进得了**
      素材补全通道（通道里本来就会 strip、会要出处）。白名单只收真文体，且指代必须紧邻
      文体词，「把这句话补充完整」里的「话」不在表内 ⇒ 仍走否决闸。
改 1：优化稿兜底剥指令 —— 普通润色通道在返回前，把「原正文里的指令句」在优化稿里剥掉
      （新增 quoteAsk.commandSents / stripCommands）。这条治的是**所有漏网的变体**：
      不管走没走素材通道、AI 有没有小幅改写指令句。

判定与边界
---------
* stripCommands 只认两条腿：(a) 归一化后与某条指令句完全相同（最常见：原样带回）；
  (b) 句内同时出现「指代 + 文体」与补全触发词/补全动词（覆盖「…补充完整吧」这类改写）。
  **绝不按「含触发词」宽泛删句** —— 日记里真写「明天要把计划补充完整」不该被吃掉。
* stripCommands **剥空则原样返回**：面板不能变空白（用户会以为稿子丢了）。
* 幂等、空值安全；只动优化稿，**不碰正文**（正文只在用户点【应用】时被改写）。
* 无云函数改动（G 锚点复用既有 recite 通道；target.genre='词' 云函数已支持）。

用法：--check（只验锚点与幂等） | --write（落盘，含幂等备份） | --restore-src | --restore
"""
import io
import os
import sys
import shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\recite-strip-backup-20260922'

CRLF = chr(13) + chr(10)
LF = chr(10)

Q = 'utils/quoteAsk.js'
WJ = 'pages/write/write.js'

OPS = []


def op(rel, tag, old, new, sig):
    OPS.append((rel, {'tag': tag, 'old': old, 'new': new, 'sig': sig}))


# ============================================================
# utils/quoteAsk.js
# ============================================================

# ---- Q1 新增 ANTE_PIECE_RE（锚点 G 的白名单）----
op(Q, 'Q1 ANTE_PIECE_RE 指代+文体',
   r"""// 名句相似锚点的前缀长度（归一化后比对）
const SNIPPET_PREFIX = 5""",
   r"""// [recite-anchor-v2] 指代 + 文体：用户指着自己刚写下的素材求助（「这首词 / 那首诗 / 这一句名言」）。
// 为什么需要：锚点表原本只有 A 书名号 / B 池内篇名 / C 引号句 / D 人名 / E 文体词 / F 名句片段，
// 「天高云淡，望断南飞雁。不到长城非好汉，屈指行程二万。帮我把这首词补充完整」六路全不中
// ⇒ 静默退回普通润色 ⇒ 指令句被 AI 原样带回正文（2026-09-22 真机实例）。
// 白名单只收**真文体**：指代必须紧邻文体词，「把这句话补充完整」里的「话」不在表内，仍走否决闸。
// 文体单独列成数组：正则的捕获组序号会随写法变动（`(一)?` 不参与匹配时是 undefined，踩过一次），
// 所以文体不靠组号取，改用 pickAnteGenre() 按「最长命中」从命中串里挑。
const ANTE_GENRES = ['诗', '词', '曲', '赋', '歌', '诗词', '绝句', '律诗', '名句', '名言', '台词', '典故', '判词', '古文', '骈文']
const ANTE_PIECE_RE = new RegExp('(这|那|哪)(一)?(首|阕|句|联|副)(的)?(' +
  ANTE_GENRES.slice().sort(function (a, b) { return b.length - a.length }).join('|') + ')')

/* [recite-anchor-v2] 从「指代 + 文体」的命中串里取文体（最长命中：「诗词」优先于「诗」） */
function pickAnteGenre(text) {
  let best = ''
  const s = String(text == null ? '' : text)
  ANTE_GENRES.forEach(function (w) {
    if (w.length > best.length && s.indexOf(w) >= 0) best = w
  })
  return best
}

// 名句相似锚点的前缀长度（归一化后比对）
const SNIPPET_PREFIX = 5""",
   "const ANTE_PIECE_RE = new RegExp('(这|那|哪)(一)?(首|阕|句|联|副)(的)?(' +"),

# ---- Q2 锚点 G 入表（作用域与 E 一致）----
op(Q, 'Q2 锚点 G 收集',
   """  const genreScope = hitSent ? norm(hitSent.text) : n
  for (let i = 0; i < GENRE_WORDS.length; i++) {
    const w = GENRE_WORDS[i]
    if (genreScope.indexOf(norm(w)) >= 0) {
      anchors.push({ type: 'E', value: w })
      break
    }
  }""",
   """  const genreScope = hitSent ? norm(hitSent.text) : n
  for (let i = 0; i < GENRE_WORDS.length; i++) {
    const w = GENRE_WORDS[i]
    if (genreScope.indexOf(norm(w)) >= 0) {
      anchors.push({ type: 'E', value: w })
      break
    }
  }

  // [recite-anchor-v2] G 指代 + 文体（「这首词」）：作用域与 E 一致（含触发词的那句）
  const gm = ANTE_PIECE_RE.exec(genreScope)
  const gGenre = gm ? pickAnteGenre(gm[0]) : ''
  if (gm) anchors.push({ type: 'G', value: gm[0] })""",
   '  const gm = ANTE_PIECE_RE.exec(genreScope)')

# ---- Q3 指代+文体补上 genre（类别/长度档/加载文案都要用）----
op(Q, 'Q3 target.genre 回填',
   """  if (bm) target.title = bm[1]
  if (qm) target.snippet = qm[1]""",
   """  if (bm) target.title = bm[1]
  if (qm) target.snippet = qm[1]

  // [recite-anchor-v2] 指代 + 文体 补上文体（「这首词」→ genre=词）：让类别（kind）、
  // 长度档与加载文案（「词 · 查不到出处就不补」）都对得上
  if (gGenre && !target.genre) target.genre = gGenre""",
   '  if (gGenre && !target.genre) target.genre = gGenre')

# ---- Q4 G 锚点也算「有具体指向」（否则会被判成检索类）----
op(Q, 'Q4 hasPiece 纳入 G',
   """    const hasPiece = !!(target.title || target.snippet) ||
      !!target.person || !!(target.genre && target.author) ||
      anchors.some(function (a) { return a.type === 'C' }) ||
      !!(pool && pool.by && pool.by !== 'author')""",
   """    const hasPiece = !!(target.title || target.snippet) ||
      !!target.person || !!(target.genre && target.author) ||
      anchors.some(function (a) { return a.type === 'C' }) ||
      anchors.some(function (a) { return a.type === 'G' }) ||
      !!(pool && pool.by && pool.by !== 'author')""",
   "      anchors.some(function (a) { return a.type === 'G' }) ||")

# ---- Q5 commandSents / stripCommands（优化稿兜底剥指令）----
op(Q, 'Q5 commandSents + stripCommands',
   r"""  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/* 池内条目 → 出处行文本（版本 B 的「—— 」后面那截） */""",
   r"""  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * [optimize-strip v1] 「指着内容下指令」的核心词白名单（归一化后比对）。
 * 剥掉触发词/礼貌词/补全动词后，核心落在这里 ⇒ 整句就是一条对 AI 的指令；
 * 落不到（如「明天计划」「今天牙」）⇒ 视为叙述句，绝不删。
 */
const PRONOUN_CORES = [
  '这里', '那里', '这些', '那些', '上面', '上面这段', '前面', '前面这段',
  '上文', '上文这段', '全文', '全篇', '原文', '正文', '前面的内容', '上面的内容'
]
const PRONOUN_CORE_RE = /^(这|那|哪)(一|几|两|三)?(段|首|句|篇|阕|联|副)(话|字|内容|文|文章|文字)?$/

/* 核心是不是「空的」或「只是在指内容」 */
function isPronounCore(core) {
  const s = String(core == null ? '' : core)
  if (!s) return true
  if (PRONOUN_CORES.indexOf(s) >= 0) return true
  if (ANTE_PIECE_RE.test(s)) return true
  return PRONOUN_CORE_RE.test(s)
}

/**
 * [optimize-strip v1] 找出「补全 / 检索类指令句」（**不要求命中素材锚点**）。
 *
 * 为什么需要：没有素材锚点时链路会静默退回普通润色，指令句只是正文的一部分 ——
 * AI 把它当正文一起润色着送回，用户点【应用】后指令句就落进了日记
 * （真机实例：天高云淡…帮我把这首词补充完整。→ 词补全了，指令句也留在正文里）。
 * detect() 里的 commandRanges 只在命中时才有，这里给「没命中但确实是条指令」兜底。
 *
 * 两道闸：① 句内要有补全触发词 / 检索句形 / 补全动词；② 实义核心必须是空的或只指内容。
 * 第 ② 道是关键 —— 否则「明天要把计划补充完整」「我今天补了牙」这类**叙述句**会被
 * 当成指令从优化稿里删掉（日记正文里「补充完整」并不罕见）。
 * @param {string} text 正文（原样，未剥）
 * @returns {Array<{start:number,end:number,text:string}>}
 */
function commandSents(text) {
  const out = []
  splitSentences(text).forEach(function (s) {
    const sn = norm(s.text)
    if (!sn) return
    const hasTrigger = containsAny(sn, TRIGGER_NEXT_ONE.concat(TRIGGER_NEXT_FEW, TRIGGER_FULL, TRIGGER_ANY)) !== ''
    const lookupShape = LOOKUP_RE.test(sn)
    const hasFillVerb = FILL_VERBS.some(function (v) { return sn.indexOf(v) >= 0 })
    if (!hasTrigger && !lookupShape && !hasFillVerb) return
    if (!isPronounCore(commandCore(s.text, []))) return
    out.push({ start: s.start, end: s.end, text: s.text })
  })
  return out
}

/**
 * [optimize-strip v1] 在优化稿里剥掉与原正文指令句对应的句子。
 *
 * AI 可能对指令句做小幅改写，所以判定两条腿并行：
 *   a) 归一化后与某条指令句**完全相同**（最常见的原样带回；指令句已由 commandSents 过闸）；
 *   b) 句内同时出现「指代 + 文体」（ANTE_PIECE_RE）与补全触发词 / 补全动词 —— 覆盖
 *      「帮我把这首词补充完整吧」这类改写，**不依赖** commandSents 是否认出原句。
 * 只认这两条，绝不按「含触发词」宽泛删句：日记里真写「明天要把计划补充完整」不该被吃掉。
 *
 * 幂等、空值安全；**剥空则原样返回**（否则面板变空白，用户以为稿子丢了）。
 * @param {string} text 优化稿
 * @param {Array} commands commandSents() 的结果
 * @returns {string}
 */
function stripCommands(text, commands) {
  const src = String(text == null ? '' : text)
  const cmds = (commands || []).filter(function (c) { return c && c.text })
  if (!src || !cmds.length) return src

  const kill = []
  splitSentences(src).forEach(function (s) {
    const sn = norm(s.text)
    if (!sn) return
    let hit = false
    for (let i = 0; i < cmds.length && !hit; i++) {
      if (sn === norm(cmds[i].text)) hit = true
    }
    if (!hit && ANTE_PIECE_RE.test(s.text)) {
      const strong = containsAny(sn, TRIGGER_NEXT_ONE.concat(TRIGGER_NEXT_FEW, TRIGGER_FULL)) !== ''
      const verb = FILL_VERBS.some(function (v) { return sn.indexOf(v) >= 0 })
      if (strong || verb) hit = true
    }
    if (hit) kill.push([s.start, s.end])
  })
  if (!kill.length) return src

  kill.sort(function (a, b) { return b[0] - a[0] })
  let out = src
  kill.forEach(function (r) {
    let e = r[1]
    const tail = out.slice(e)
    const m = /^[，,。.、；;：:！!？?…\s\u3000]+/.exec(tail)
    if (m) e += m[0].length
    out = out.slice(0, r[0]) + out.slice(e)
  })
  out = out.replace(/^[，,。.、；;：:！!？?…\s\u3000]+/, '')
  out = out.replace(/[，,。.、；;：:！!？?…\s\u3000]+$/, '')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  if (!out) return src
  return out
}

/* 池内条目 → 出处行文本（版本 B 的「—— 」后面那截） */""",
   'function commandSents(text) {')

# ---- Q6 导出 ----
op(Q, 'Q6 导出新接口',
   """  detect,
  strip,
  poolSource,""",
   """  detect,
  strip,
  ANTE_GENRES,
  ANTE_PIECE_RE,
  pickAnteGenre,
  commandSents,
  stripCommands,
  poolSource,""",
   '  commandSents,')


# ============================================================
# pages/write/write.js
# ============================================================

# ---- W1 记录正文里的指令句 ----
op(WJ, 'W1 记录指令句',
   """    // 加载档案供 AI 识别人名地名
    const archives = storage.getArchives().map(a => ({ name: a.name, description: a.description }))

    aiCloud.callAI(content, this.data.mood, 'optimize', archives).then(result => {""",
   """    // [optimize-strip v1] 先记下正文里的「补全指令句」：无素材锚点时链路会退回这里，
    // 指令句作为正文的一部分被 AI 原样润色着送回，最后落进正文（详见 quoteAsk.commandSents）
    const cmdSents = quoteAsk.commandSents(content)

    // 加载档案供 AI 识别人名地名
    const archives = storage.getArchives().map(a => ({ name: a.name, description: a.description }))

    aiCloud.callAI(content, this.data.mood, 'optimize', archives).then(result => {""",
   '    const cmdSents = quoteAsk.commandSents(content)')

# ---- W2 优化稿剥指令句 ----
op(WJ, 'W2 优化稿剥指令',
   """      // 优化稿再做一次备案名词匹配纠正（AI 润色时也可能写错名词）
      let optimized = result.optimized""",
   """      // 优化稿再做一次备案名词匹配纠正（AI 润色时也可能写错名词）
      let optimized = result.optimized
      // [optimize-strip v1] 指令句不写进正文：AI 常把「帮我补充…」这类句子原样带回
      const noCmd = quoteAsk.stripCommands(optimized, cmdSents)
      const cmdStripped = noCmd !== optimized
      optimized = noCmd""",
   '      const noCmd = quoteAsk.stripCommands(optimized, cmdSents)')

# ---- W3 优化要点如实说明 ----
op(WJ, 'W3 优化要点说明',
   """        optimizeChanges: (this._localEditNotes || []).concat(result.changes || []).concat(opts.extraNotes || []),""",
   """        optimizeChanges: (this._localEditNotes || [])
          .concat(cmdStripped ? ['已去掉「补充指令」这类句子，不写进正文'] : [])
          .concat(result.changes || [])
          .concat(opts.extraNotes || []),""",
   "          .concat(cmdStripped ? ['已去掉「补充指令」这类句子，不写进正文'] : [])")


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
