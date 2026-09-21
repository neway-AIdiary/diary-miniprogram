# -*- coding: utf-8 -*-
r"""
[import-dedup v1] 导入去重：键改「内容指纹」+ 如实上报跳过篇数（A + D）

A) 去重键 `日期|content.trim()` 逐字比对原文 ⇒ txt 的空行带一个空格（"\n \n"）、
   docx 解出来是干净空行（"\n\n"），键不等 ⇒ 同一篇被判两篇（真机实例：31 篇里 30 篇重复）。
   修法：新增 util.contentFingerprint()（只归一化 换行符 / 行首尾空白 / 纯空白行 / 多余空行，
   不动入库原文），两处 keyOf 改用它。
D) mergeIntoShards → importDiaryObjects 透出 skipped；transfer 的 finish/buildImportResult
   补 4 个参数，导入提示如实报「另有 N 篇与已有日记内容相同，已自动跳过」。

用法: --check / --write / --restore-src
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP = r"C:\Users\ThinkPad\WorkBuddy\dedup-fingerprint-backup-20260921"
REL_FILES = [
    "utils/util.js",
    "utils/storage.js",
    "utils/transfer.js",
]

OPS = {
    "utils/util.js": [
        dict(
            tag="fp-func",
            old=r"""function getDateKey(date) {
  const d = date || new Date()
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return y + '-' + m + '-' + day
}""",
            new=r"""function getDateKey(date) {
  const d = date || new Date()
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return y + '-' + m + '-' + day
}

// 导入去重用的「正文指纹」[import-dedup v1]：只消除格式差异（换行符 / 行首尾空白 /
// 纯空白行 / 多余空行），**不改动入库原文**。同一篇日记经不同格式（docx / txt / 网页复制）
// 导出后指纹一致 ⇒ 判为重复；正文真有差异（多一段、改一句）时指纹仍不同 ⇒ 照常判两篇。
function contentFingerprint(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  const lines = raw.split('\n').map((line) => {
    return line.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, '')
  })
  return lines.join('\n').replace(/\n{2,}/g, '\n\n').trim()
}""",
            sig="function contentFingerprint(text) {",
        ),
        dict(
            tag="fp-export",
            old="""  getDateKey,
  buildContentLines,""",
            new="""  getDateKey,
  contentFingerprint,
  buildContentLines,""",
            sig="  contentFingerprint,",
        ),
    ],
    "utils/storage.js": [
        dict(
            tag="mrg-skipped-count",
            old="  if (!addedItems.length) return { added: 0, total: existingList.length }",
            new="""  // [import-dedup v1] skipped = 本批被判为重复而跳过的篇数（供导入结果如实上报）
  const skipped = items.length - addedItems.length
  if (!addedItems.length) return { added: 0, total: existingList.length, skipped: skipped }""",
            sig="const skipped = items.length - addedItems.length",
        ),
        dict(
            tag="mrg-skipped-return",
            old="  return { added: added, total: total }",
            new="  return { added: added, total: total, skipped: skipped }",
            sig="total: total, skipped: skipped",
        ),
        dict(
            tag="obj-replace-skipped",
            old="""  if (replace) {
    if (!replaceAllSharded(items)) return { added: -1, total: 0 } // 存储已满 [shard-storage v1]
    scheduleCloudBackup()
    return { added: items.length, total: items.length }
  }""",
            new="""  if (replace) {
    if (!replaceAllSharded(items)) return { added: -1, total: 0, skipped: 0 } // 存储已满 [shard-storage v1]
    scheduleCloudBackup()
    return { added: items.length, total: items.length, skipped: 0 }
  }""",
            sig="return { added: items.length, total: items.length, skipped: 0 }",
        ),
        dict(
            tag="obj-key-fp",
            old=r"""  // [shard-storage v1] 分格合并：按「日期+内容」去重后逐格预检、逐格写入
  const r = mergeIntoShards(items, (d) => util.getDateKey(new Date(d.created_at)) + '|' + String(d.content || '').trim())""",
            new=r"""  // [shard-storage v1] 分格合并：按「日期+内容指纹」去重后逐格预检、逐格写入
  // [import-dedup v1] 键用 contentFingerprint：只吞格式差异（换行/空白），正文真有差异仍判两篇
  const r = mergeIntoShards(items, (d) => util.getDateKey(new Date(d.created_at)) + '|' + util.contentFingerprint(d.content))""",
            sig=r"const r = mergeIntoShards(items, (d) => util.getDateKey(new Date(d.created_at)) + '|' + util.contentFingerprint(d.content))",
        ),
        dict(
            tag="text-key-fp",
            old=r"""  // [shard-storage v1] 分格合并：按「日期+内容」去重后逐格预检、逐格写入
  return mergeIntoShards(parsed, (d) => util.getDateKey(new Date(d.created_at)) + '|' + String(d.content || '').trim())""",
            new=r"""  // [shard-storage v1] 分格合并：按「日期+内容指纹」去重后逐格预检、逐格写入
  // [import-dedup v1] 键与 importDiaryObjects 同一式（contentFingerprint），两路行为必须一致
  return mergeIntoShards(parsed, (d) => util.getDateKey(new Date(d.created_at)) + '|' + util.contentFingerprint(d.content))""",
            sig=r"return mergeIntoShards(parsed, (d) => util.getDateKey(new Date(d.created_at)) + '|' + util.contentFingerprint(d.content))",
        ),
        dict(
            tag="obj-jsdoc",
            old=" * 从日记对象数组导入（按「日期+内容」去重合并，或全部替换）— 供 AI 识别结果等场景使用",
            new=" * 从日记对象数组导入（按「日期+内容指纹」去重合并，或全部替换）— 供 AI 识别结果等场景使用",
            sig="「日期+内容指纹」去重合并，或全部替换）— 供 AI 识别",
        ),
        dict(
            tag="text-jsdoc",
            old=" * 从纯文本导入日记（按「日期+内容」去重合并，或全部替换）",
            new=" * 从纯文本导入日记（按「日期+内容指纹」去重合并，或全部替换）",
            sig="从纯文本导入日记（按「日期+内容指纹」去重合并",
        ),
    ],
    "utils/transfer.js": [
        dict(
            tag="result-sig",
            old="function buildImportResult(added, extraMsg, list) {",
            new="function buildImportResult(added, extraMsg, list, skipped) {",
            sig="function buildImportResult(added, extraMsg, list, skipped) {",
        ),
        dict(
            tag="result-skipped-line",
            old="  if (added > 0) extras.push('若日记本列表未立即显示，下拉刷新即可看到')",
            new="""  if (added > 0) extras.push('若日记本列表未立即显示，下拉刷新即可看到')
  // [import-dedup v1] 被判重复而跳过的篇数必须如实上报：只报「已导入 N 条」时，
  // 用户看到篇数变少会以为导入失败（本项目历史痛点「提示与实际不符」）
  if (skipped > 0) extras.push('另有 ' + skipped + ' 篇与已有日记内容相同，已自动跳过')""",
            sig="另有 ' + skipped + ' 篇与已有日记内容相同，已自动跳过",
        ),
        dict(
            tag="finish-sig",
            old="""  const finish = (added, extraMsg, list) => {
    if (added !== -1) markHomeRefresh()
    const r = buildImportResult(added, extraMsg, list)""",
            new="""  const finish = (added, extraMsg, list, skipped) => {
    if (added !== -1) markHomeRefresh()
    const r = buildImportResult(added, extraMsg, list, skipped)""",
            sig="const finish = (added, extraMsg, list, skipped) => {",
        ),
        dict(
            tag="skipped-decl",
            old="""                let added = 0
                let recognized = false""",
            new="""                let added = 0
                let recognized = false
                let skippedCount = 0   // [import-dedup v1] 被判重复而跳过的篇数""",
            sig="let skippedCount = 0",
        ),
        dict(
            tag="legacy-set-skipped",
            old="""                        // 回退解析：新 id，按「日期+内容」去重合并
                        const r = storage.importDiaryObjects(list, mode === 'replace')
                        added = r.added""",
            new="""                        // 回退解析：新 id，按「日期+内容指纹」去重合并
                        const r = storage.importDiaryObjects(list, mode === 'replace')
                        added = r.added
                        skippedCount = r.skipped || 0""",
            sig="skippedCount = r.skipped || 0",
        ),
        dict(
            tag="legacy-pass-skipped",
            old=r"""                      finish(added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '', list)""",
            new=r"""                      finish(added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '', list, skippedCount)""",
            sig=r"finish(added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '', list, skippedCount)",
        ),
        dict(
            tag="docx-loose-pass",
            old="                      finish(r.added, looseMsg, loose.diaries)",
            new="                      finish(r.added, looseMsg, loose.diaries, r.skipped)",
            sig="finish(r.added, looseMsg, loose.diaries, r.skipped)",
        ),
        dict(
            tag="docx-visible-pass",
            old=r"""                    finish(r.added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '', parsed.diaries)""",
            new=r"""                    finish(r.added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '', parsed.diaries, r.skipped)""",
            sig=r"finish(r.added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '', parsed.diaries, r.skipped)",
        ),
        dict(
            tag="txt-loose-pass",
            old="                        finish(result.added, looseMsg, loose.diaries)",
            new="                        finish(result.added, looseMsg, loose.diaries, result.skipped)",
            sig="finish(result.added, looseMsg, loose.diaries, result.skipped)",
        ),
        dict(
            tag="txt-pass",
            old="                    finish(result.added, '', list)",
            new="                    finish(result.added, '', list, result.skipped)",
            sig="finish(result.added, '', list, result.skipped)",
        ),
        dict(
            tag="ai-parse-pass",
            old="            finish(r.added, '', list)",
            new="            finish(r.added, '', list, r.skipped)",
            sig="finish(r.added, '', list, r.skipped)",
        ),
    ],
}


def load(rel):
    raw = open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")
    return raw, raw.replace("\r\n", "\n")


def save(rel, raw, text):
    nl = "\r\n" if "\r\n" in raw else "\n"
    out = text.replace("\n", nl) if nl == "\r\n" else text
    open(os.path.join(ROOT, rel), "wb").write(out.encode("utf-8"))


def backup():
    for rel in REL_FILES:
        dst = os.path.join(BACKUP, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            shutil.copy2(os.path.join(ROOT, rel.replace("/", os.sep)), dst)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode == "--restore-src":
        n = 0
        for rel in REL_FILES:
            src = os.path.join(BACKUP, rel.replace("/", os.sep))
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(ROOT, rel.replace("/", os.sep)))
                print("[RESTORED] " + rel)
                n += 1
        print("RESULT: restored %d files" % n)
        return
    do_write = mode == "--write"
    bad = 0
    for rel, ops in OPS.items():
        raw, text = load(rel)
        st = ""
        file_bad = 0
        for op in ops:
            if op["sig"] in text:
                st = "SKIP"
            elif op["old"] in text:
                if do_write:
                    if text.count(op["old"]) != 1:
                        st = "ERR(锚点不唯一 x%d)" % text.count(op["old"])
                    else:
                        text = text.replace(op["old"], op["new"])
                        st = "OK"
                else:
                    st = "PENDING"
            else:
                st = "ERR(锚点0命中)"
            print("[%s] %s %s -> %s" % (mode, rel, op["tag"], st))
            if st.startswith("ERR"):
                bad += 1
                file_bad += 1
        if do_write and not file_bad:
            backup()
            save(rel, raw, text)
    print("RESULT: " + ("FAIL x%d" % bad if bad else "ALL OK"))


main()
