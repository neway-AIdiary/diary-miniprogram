# -*- coding: utf-8 -*-
"""
[roster-filter v1] 花名册提取三层去伪 + 满 100 AI 复核（用户 2026-09-25 拍板 B/A/静默）：
1. utils/roster.js：①虚词首尾否决 ②常见词黑名单（含子串）③上下文强证据（前邻协同字/后邻言说动作字）
   + AI 复核辅助（needsAiReview / markAiReviewDone / keepOnly，满 100 触发一次）
2. utils/aiCloud.js：callAIRosterReview（失败 resolve null，静默降级）
3. pages/roster/roster.js：确认添加后 maybeAiReview() 静默链路
4. cloudfunctions/optimizeDiary/index.js：action='rosterReview'（剔除地名/物品词/「张部/王总」类带职位头衔称呼）
5. tools/test_roster.js：fixture 补强上下文 + rf-1~rf-6 新断言
用法：python patch_roster_filter.py --check / --write / --restore
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BAK = r"C:\Users\ThinkPad\WorkBuddy\roster-filter-backup-20260925"
REL = {
    "roster": r"utils\roster.js",
    "aicloud": r"utils\aiCloud.js",
    "page": r"pages\roster\roster.js",
    "cloud": r"cloudfunctions\optimizeDiary\index.js",
    "test": r"tools\test_roster.js",
}
FILES = list(REL.values())

OPS = []

# ---------- utils/roster.js ----------
OPS.append((REL["roster"], "roster-过滤表与辅助函数", """const PRON_CHARS = new Set('你我他她它咱'.split(''))""",
"""const PRON_CHARS = new Set('你我他她它咱'.split(''))

// ===== [roster-filter v1] 三层去伪（用户 2026-09-25 拍板 B 案）=====
// ① 虚词否决：候选首/尾字命中即不收（杀「任在」类「姓+虚词」碎片）
const EDGE_STOP_CHARS = '的了着是也都很就不没把被让在里上和与跟同或呢吧吗啊呀之乎者地得等又再才更最太'
// ② 常见词黑名单：以姓氏字开头但不是人名的常用词（子串命中即否决，杀「范围/罗马/宋体/朱砂/孔府/钟双打」类）
const NONNAME_WORDS = ['范围', '罗马', '宋体', '朱砂', '孔府', '双打', '马上', '方面',
  '周末', '当时', '当初', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
// ③ 上下文强证据：候选至少出现过一次「人名式上下文」——
//    前邻命中协同/称呼字（如「和王威…」），或后邻命中言说/动作字（如「王威说…」）；
//    一处都没有则视为普通词组剔除（杀「马术」类无上下文词组）
const CTX_LEFT_CHARS = '和跟与同陪带找叫请约帮教给让问邀拉'
const CTX_RIGHT_CHARS = '说问道讲喊告找带陪请帮见约来去到走回进出吃喝聊谈给让叫邀拉接送会要想'

function hitEdgeStop(w) {
  return EDGE_STOP_CHARS.indexOf(w.charAt(0)) !== -1 ||
    EDGE_STOP_CHARS.indexOf(w.charAt(w.length - 1)) !== -1
}

function hitNonnameWord(w) {
  for (let i = 0; i < NONNAME_WORDS.length; i++) {
    if (w.indexOf(NONNAME_WORDS[i]) !== -1) return true
  }
  return false
}""", [('EDGE_STOP_CHARS =', 1), ('NONNAME_WORDS =', 1)]))

OPS.append((REL["roster"], "roster-bump带强证据", """  const bump = function (store, w, dk) {
    if (!store[w]) store[w] = { name: w, count: 0, lastDate: '' }
    store[w].count++
    if (dk && dk > store[w].lastDate) store[w].lastDate = dk
  }""",
"""  const bump = function (store, w, dk, strong) {
    if (!store[w]) store[w] = { name: w, count: 0, lastDate: '', strong: false }
    store[w].count++
    if (strong) store[w].strong = true
    if (dk && dk > store[w].lastDate) store[w].lastDate = dk
  }""", []))

OPS.append((REL["roster"], "roster-滑窗记上下文", """    segs.forEach(function (seg) {
      for (let i = 0; i < seg.length - 1; i++) {
        if (!SURNAME_SET.has(seg[i])) continue
        bump(info2, seg.substr(i, 2), dk)
        if (i + 2 < seg.length) bump(info3, seg.substr(i, 3), dk)
      }
    })""",
"""    segs.forEach(function (seg) {
      for (let i = 0; i < seg.length - 1; i++) {
        if (!SURNAME_SET.has(seg[i])) continue
        // [roster-filter v1] 上下文强证据：前邻协同字 或 后邻言说/动作字（2/3 字窗共享同一证据）
        const hasCtx =
          (i > 0 && CTX_LEFT_CHARS.indexOf(seg[i - 1]) !== -1) ||
          (i + 2 < seg.length && CTX_RIGHT_CHARS.indexOf(seg[i + 2]) !== -1) ||
          (i + 3 < seg.length && CTX_RIGHT_CHARS.indexOf(seg[i + 3]) !== -1)
        bump(info2, seg.substr(i, 2), dk, hasCtx)
        if (i + 2 < seg.length) bump(info3, seg.substr(i, 3), dk, hasCtx)
      }
    })""", []))

OPS.append((REL["roster"], "roster-push三层过滤", """  const push = function (it) {
    if (existing.has(it.name) || !validName(it.name) || outNames.has(it.name)) return
    outNames.add(it.name)
    out.push({ name: it.name, count: it.count, lastDate: it.lastDate })
  }""",
"""  // [roster-filter v1] skipFilter=true 仅供 personNames 种子（AI 抽过，精度最高，沿用原直通）
  const push = function (it, skipFilter) {
    if (existing.has(it.name) || !validName(it.name) || outNames.has(it.name)) return
    if (!skipFilter) {
      if (hitEdgeStop(it.name) || hitNonnameWord(it.name)) return
      if (!it.strong) return
    }
    outNames.add(it.name)
    out.push({ name: it.name, count: it.count, lastDate: it.lastDate })
  }""", []))

OPS.append((REL["roster"], "roster-种子直通", """    if (count) push({ name: w, count: count, lastDate: lastDate })""",
"""    if (count) push({ name: w, count: count, lastDate: lastDate }, true)""", []))

OPS.append((REL["roster"], "roster-AI复核辅助与导出", """module.exports = { getList, getNames, addNames, removeName, extractCandidates, validName, MAX_ROSTER, KEY }""",
"""// ===== [roster-filter v1] 满 100 触发一次 AI 复核（拍板：optimizeDiary 加 action + 静默剔除）=====
const REVIEW_KEY = 'yidengji_roster_review_done'

/** 是否需要 AI 复核：花名册已满且本轮未复核过 */
function needsAiReview() {
  try {
    if (wx.getStorageSync(REVIEW_KEY)) return false
    return getList().length >= MAX_ROSTER
  } catch (e) {
    return false
  }
}

/** 标记本轮 AI 复核已完成（成功后才标记，失败下次确认添加时重试） */
function markAiReviewDone() {
  try {
    wx.setStorageSync(REVIEW_KEY, Date.now())
    return true
  } catch (e) {
    return false
  }
}

/** AI 复核后只保留名单内的名字（静默剔除，返回删除条数） */
function keepOnly(keptNames) {
  const kept = new Set((Array.isArray(keptNames) ? keptNames : [])
    .map(function (n) { return String(n || '').trim() })
    .filter(Boolean))
  const cur = getList()
  const next = cur.filter(function (i) { return kept.has(i.name) })
  if (next.length === cur.length) return 0
  return write(next) ? (cur.length - next.length) : 0
}

module.exports = { getList, getNames, addNames, removeName, extractCandidates, validName, MAX_ROSTER, KEY, needsAiReview, markAiReviewDone, keepOnly, REVIEW_KEY }""", []))

# ---------- utils/aiCloud.js ----------
OPS.append((REL["aicloud"], "aiCloud-callAIRosterReview", """module.exports = { callAI, callAIParse, callAIExtractMetaBatch, callAITags, callAIOrganizeArchive, callAIExtractEntities, callAIMergeDiary, autoSegmentAfterSave, stripMoodTail, cleanPersonNames }""",
"""/**
 * [roster-filter v1] 花名册 AI 复核：把名单交给 AI 甄别真名（optimizeDiary action='rosterReview'）。
 * resolve(保留名单数组)；失败 resolve(null)（调用方静默降级，绝不阻塞、绝不抛错）。
 */
function callAIRosterReview(names) {
  return new Promise(function (resolve) {
    try {
      wx.cloud.callFunction({
        name: 'optimizeDiary',
        data: { action: 'rosterReview', names: names },
        success: function (res) {
          const r = (res && res.result) || {}
          if (r.error) { resolve(null); return }
          resolve(Array.isArray(r.names) ? r.names : [])
        },
        fail: function () { resolve(null) }
      })
    } catch (e) {
      resolve(null)
    }
  })
}

module.exports = { callAI, callAIParse, callAIExtractMetaBatch, callAITags, callAIOrganizeArchive, callAIExtractEntities, callAIMergeDiary, autoSegmentAfterSave, stripMoodTail, cleanPersonNames, callAIRosterReview }""", []))

# ---------- pages/roster/roster.js ----------
OPS.append((REL["page"], "page-引入aiCloud", """const roster = require('../../utils/roster.js')""",
"""const roster = require('../../utils/roster.js')
const aiCloud = require('../../utils/aiCloud.js')""", []))

OPS.append((REL["page"], "page-确认后挂AI复核", """    const added = roster.addNames(picked)
    this.onPanelCancel()
    this.refresh()
    wx.showToast({ title: '已添加 ' + added + ' 个名字', icon: 'none' })
  },""",
"""    const added = roster.addNames(picked)
    this.onPanelCancel()
    this.refresh()
    wx.showToast({ title: '已添加 ' + added + ' 个名字', icon: 'none' })
    this.maybeAiReview()
  },

  // [roster-filter v1] 满 100 后自动触发一次 AI 复核：静默剔除 AI 判定的非人名（含「张部/王总」类带职位头衔的称呼）。
  // 失败静默降级不动名单，下次确认添加时重试；成功才标记本轮已完成，绝不重复调用。
  maybeAiReview() {
    if (!roster.needsAiReview()) return
    const that = this
    aiCloud.callAIRosterReview(roster.getNames()).then(function (kept) {
      if (!Array.isArray(kept)) return
      roster.keepOnly(kept)
      roster.markAiReviewDone()
      that.refresh()
    })
  },""", []))

# ---------- cloudfunctions/optimizeDiary/index.js ----------
OPS.append((REL["cloud"], "cloud-头部注释", """ *   action='segment'          — AI 自动划分段落（只插入换行，严禁改动任何字符）""",
""" *   action='segment'          — AI 自动划分段落（只插入换行，严禁改动任何字符）
 *   action='rosterReview'     — 花名册 AI 复核：甄别人名，剔除非人名/带职位头衔的称呼 [roster-filter v1]""", []))

OPS.append((REL["cloud"], "cloud-rosterReview系统prompt", """  if (action === 'segment') {
    return [
    '你是一位日记排版助手。""",
"""  // [roster-filter v1] 花名册 AI 复核：甄别真名，剔除地名/物品词/「张部/王总」类带职位头衔的称呼
  if (action === 'rosterReview') {
    return [
    '你是一位严谨的中文人名审核助手。用户的花名册由本地规则从日记中自动提取，其中混有非人名词语，请逐个甄别。',
    '任务：只保留「真实的中文人名」，其余全部剔除。',
    '剔除规则（宁严勿松）：',
    '1. 地名、机构名、品牌名、建筑景点（如：罗马、孔府）一律剔除；',
    '2. 普通词语、物品或专用名词（如：范围、宋体、朱砂、双打）一律剔除；',
    '3. 「姓 + 职位/头衔/称谓」的称呼（如：张部、王总、李工、刘处、赵经理、陈老师）不是完整人名，一律剔除；',
    '4. 「姓 + 虚词」的拼接碎片（如：任在、范也）一律剔除；',
    '5. 常见姓氏开头的词组若更像普通词汇而非人名，剔除；拿不准真假时，宁剔除不保留。',
    '保留规则：',
    '1. 2~4 个字的中文人名全名（如：王威、王小明、欧阳飞）保留；',
    '2. 只输出原名单中出现过的名字，逐字返回，不得改写、不得新增、不得去重后改名。',
    '',
    '请严格按以下 JSON 格式返回（不要输出任何其他文字）：',
    '{"names":["保留的人名1","保留的人名2"]}'
  ].join('\\n')
  }

  if (action === 'segment') {
    return [
    '你是一位日记排版助手。""", []))

OPS.append((REL["cloud"], "cloud-审核userPrompt", """/**
 * 调用 DeepSeek（Node 内置 https，无第三方依赖）
 */""",
"""/**
 * 构造 rosterReview（花名册 AI 复核）的 prompt [roster-filter v1]
 */
function buildRosterReviewPrompt(names) {
  return [
    '待审核名单（共 ' + names.length + ' 个）：',
    names.join('、')
  ].join('\\n')
}

/**
 * 调用 DeepSeek（Node 内置 https，无第三方依赖）
 */""", []))

OPS.append((REL["cloud"], "cloud-main分支", """  // ===== merge：AI 融合同一天的多份日记为一份 =====""",
"""  // ===== rosterReview：花名册 AI 复核（满 100 后静默剔除非人名，[roster-filter v1]）=====
  if (action === 'rosterReview') {
    const rawNames = Array.isArray(event && event.names) ? event.names : []
    const nameList = rawNames.map(n => String(n || '').trim()).filter(Boolean).slice(0, 120)
    if (!nameList.length) return { names: [] }
    if (!API_KEY) return { error: '服务端未配置 DEEPSEEK_API_KEY' }
    try {
      const r = await runPrompt(buildRosterReviewPrompt(nameList), 2000, 0.1, buildSystemPrompt('rosterReview'))
      if (r.error) return { error: r.error }
      // 只允许返回原名单的子集：AI 编造/改写的名字一律丢弃
      const src = new Set(nameList)
      const kept = ((r.parsed && Array.isArray(r.parsed.names)) ? r.parsed.names : [])
        .map(n => String(n || '').trim())
        .filter(n => n && src.has(n))
      return { names: kept, removed: nameList.length - kept.length }
    } catch (err) {
      return { error: '调用 AI 失败: ' + (err && err.message || err) }
    }
  }

  // ===== merge：AI 融合同一天的多份日记为一份 =====""", []))

# ---------- tools/test_roster.js ----------
OPS.append((REL["test"], "test-fixture补强上下文", """  { dateKey: '2026-09-18', content: '王小明也来了。李娜请喝茶。' }""",
"""  { dateKey: '2026-09-18', content: '王小明说来找我。李娜请喝茶。' }""", []))

OPS.append((REL["test"], "test-三层去伪用例", """/* ===== A4. 热词注入联动 ===== */""",
"""/* ===== A3b. [roster-filter v1] 三层去伪 + AI 复核 ===== */
// rf-1 虚词尾字否决（姓+虚词碎片）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '任在来了，任在走了，任在还说话。' }
], [], 100)
check('rf-1 虚词尾字否决（任在）', c.every(x => x.name !== '任在'))
// rf-2 黑名单否决（姓+常用词，含子串）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '周末去罗马度假。' }
], [], 100)
check('rf-2 黑名单否决（罗马）', c.every(x => x.name !== '罗马'))
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '钟双打练得不错，又夸钟双打。' }
], [], 100)
check('rf-2b 黑名单子串否决（钟双打/钟双）', c.every(x => x.name !== '钟双打' && x.name !== '钟双'))
// rf-3 无强上下文不收（2 字候选必须有至少一次人名式上下文）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '今天看了马术比赛，马术很精彩。' }
], [], 100)
check('rf-3 无强上下文剔除（马术）', c.every(x => x.name !== '马术'))
// rf-3b 前邻协同字即强证据
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '陪李娜逛街，然后回家。' }
], [], 100)
check('rf-3b 前邻「陪」即强证据（李娜）', !!c.find(x => x.name === '李娜'))
// rf-4 后邻言说字即强证据（3 字窗同享该证据，仍须 ≥2 次）
c = roster.extractCandidates([
  { dateKey: '2026-09-25', content: '王小明说到就到。王小明很守时。' }
], [], 100)
const rf4 = c.find(x => x.name === '王小明')
check('rf-4 后邻「说」即强证据（王小明×2）', !!rf4 && rf4.count === 2)
// rf-5 AI 复核：满 100 才触发、keepOnly 静默剔除、标记后不再触发
resetRoster()
check('rf-5a 未满不触发', roster.needsAiReview() === false)
const fill100 = []
for (let i = 0; fill100.length < 100; i++) {
  fill100.push({ name: SU[i % SU.length] + '甲乙丙丁戊己庚辛壬癸'[i % 10] + '子丑寅卯辰巳午未申酉戌亥'[Math.floor(i / 12) % 12] })
}
roster.addNames(fill100)
check('rf-5b 满 100 且未复核 → 触发', roster.getList().length === 100 && roster.needsAiReview() === true)
const rfCur = roster.getNames()
check('rf-5c keepOnly 静默剔除', roster.keepOnly(rfCur.slice(1)) === 1 && roster.getList().length === 99)
roster.markAiReviewDone()
check('rf-5d 标记后不再触发', roster.needsAiReview() === false)
resetRoster()
delete store[roster.REVIEW_KEY]

/* ===== A4. 热词注入联动 ===== */""", []))

OPS.append((REL["test"], "test-静态链路断言", """console.log('===== TOTAL ' + pass + ' pass, ' + fail + ' fail =====')""",
"""// [roster-filter v1] AI 复核链路静态断言
const optSrc = read('cloudfunctions/optimizeDiary/index.js')
check('rf-6a 云函数 rosterReview 分支与 prompt（含职位头衔剔除）',
  optSrc.indexOf("action === 'rosterReview'") !== -1 && optSrc.indexOf('职位/头衔/称谓') !== -1)
check('rf-6b 云函数返回名单限制为原子集',
  optSrc.indexOf('src.has(n)') !== -1)
const aiSrc = read('utils/aiCloud.js')
check('rf-6c aiCloud 导出 callAIRosterReview（失败静默）',
  aiSrc.indexOf('function callAIRosterReview') !== -1 && aiSrc.indexOf('callAIRosterReview }') !== -1)
check('rf-6d 页面接好静默复核链路',
  rJs.indexOf('maybeAiReview') !== -1 && rJs.indexOf('callAIRosterReview') !== -1 && rJs.indexOf('roster.keepOnly') !== -1)

console.log('===== TOTAL ' + pass + ' pass, ' + fail + ' fail =====')""", []))


class F:
    def __init__(self, rel):
        self.rel = rel
        self.path = os.path.join(ROOT, rel)
        with open(self.path, "rb") as f:
            raw = f.read()
        self.crlf = b"\r\n" in raw
        self.text = raw.decode("utf-8").replace("\r\n", "\n")


def main(mode):
    mode = mode.lstrip("-")
    fs = {}
    for rel in FILES:
        fs[rel] = F(rel)
    results = []

    if mode == "write":
        if not os.path.isdir(BAK):
            os.makedirs(BAK)
            for rel in FILES:
                shutil.copy2(os.path.join(ROOT, rel), os.path.join(BAK, os.path.basename(rel)))
            print("BACKUP ->", BAK)
        else:
            print("BACKUP exists, skip (idempotent) ->", BAK)

    for rel, name, a, n, rev in OPS:
        f = fs[rel]
        ca, cn = f.text.count(a), f.text.count(n)
        if mode == "check":
            ok = (ca == 1) and (cn == 0)  # 反向断言只用于写后复核
            results.append((name, "OK" if ok else "FAIL", "old=%d new=%d" % (ca, cn)))
        elif mode == "write":
            if cn >= 1:
                results.append((name, "SKIP", "already applied"))
            elif ca == 1:
                f.text = f.text.replace(a, n, 1)
                bad = [r for r in rev if f.text.count(r[0]) != r[1]]
                results.append((name, "OK" if not bad else "FAIL", "applied, rev-left=%s" % bad))
            else:
                results.append((name, "FAIL", "old=%d new=%d" % (ca, cn)))
        elif mode == "restore":
            src = os.path.join(BAK, os.path.basename(rel))
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(ROOT, rel))
                results.append((name, "RESTORED", rel))
            else:
                results.append((name, "FAIL", "no backup file: " + src))
        else:
            print("unknown mode:", mode)
            sys.exit(2)

    if mode == "write":
        for rel, f in fs.items():
            data = f.text.replace("\n", "\r\n") if f.crlf else f.text
            with open(f.path, "wb") as fh:
                fh.write(data.encode("utf-8"))

    print("=== patch_roster_filter [%s] ===" % mode)
    fails = 0
    for name, st, info in results:
        print("%-4s %-28s %s" % (st, name, info))
        if st == "FAIL":
            fails += 1
    print("TOTAL %d, FAILED %d" % (len(results), fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "--check")
