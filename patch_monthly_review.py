# -*- coding: utf-8 -*-
"""
[monthly-review v1] + [footer-center v1] 幂等补丁（2026-09-23 用户拍板，两处需求一次收）

需求 1 [monthly-review v1]：
  - 快捷模板「月度复盘」整句改「近两月日记的整体回顾」
  - 点 chip 生成时固定用「上月 1 日 ~ 今天」区间（近两月），不看顶部胶囊
  - 近两月无日记 → 提示「近两月没有日记记录，无法分析」
  - 整句填入路径 / 用户手动改输入框后 → 恢复顶部胶囊口径（其他逻辑不变）
需求 2 [footer-center v1]：
  - 空态羽毛提示在「最后一条模板 ↔ 底栏」之间垂直居中（content-inner 撑满 + result-area flex 居中）
  - 文案「您」→「你」

用法（必须在工程根跑）:
  python patch_monthly_review.py --check
  python patch_monthly_review.py --write
  python patch_monthly_review.py --restore
"""
import sys, os, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\summary-review-backup-20260923"

# ---------------------------------------------------------------
# op = (old, new, guard)。guard = 幂等判据（new 注入后的特征串，且不得是任何前序 op 注入文本的子串）
# ---------------------------------------------------------------
OPS = {
    "pages/summary/summary.js": [
        # op1 文件头注释：记下月度复盘特例
        (
            "// [v1.2] 不联动时间范围：点 chip 只填需求 + 生成，范围完全由顶部胶囊决定（原「拍板 2」撤销）",
            "// [v1.2] 不联动时间范围：点 chip 只填需求 + 生成，范围完全由顶部胶囊决定（原「拍板 2」撤销）\n"
            "// [monthly-review v1] 例外：「月度复盘」chip 点击即按「本月 + 上月」生成（固定近两月，不看顶部胶囊）；\n"
            "//   近两月无日记 → 提示「近两月没有日记记录，无法分析」。整句填入路径不触发该区间；\n"
            "//   用户手动改过输入框后标志失效（恢复由胶囊决定）。见 onQuickGenerate / onGenerate 的 review 分支",
            "// [monthly-review v1] 例外：",
        ),
        # op2 整句文案
        (
            "  { chip: '月度复盘', label: '本月日记的整体回顾' },",
            "  { chip: '月度复盘', label: '近两月日记的整体回顾' },",
            "'近两月日记的整体回顾'",
        ),
        # op3 手动改输入 → 清标志
        (
            "  onPromptInput(e) {\n"
            "    this.setData({ prompt: e.detail.value })\n"
            "  },",
            "  onPromptInput(e) {\n"
            "    // [monthly-review v1] 手动改过需求 → 近两月固定区间失效（恢复由顶部胶囊决定）\n"
            "    this._reviewRange = false\n"
            "    this.setData({ prompt: e.detail.value })\n"
            "  },",
            "// [monthly-review v1] 手动改过需求",
        ),
        # op4 整句填入 → 清标志
        (
            "  onShortcut(e) {\n"
            "    const fill = e.currentTarget.dataset.fill\n"
            "    this.setData({ prompt: fill })",
            "  onShortcut(e) {\n"
            "    const fill = e.currentTarget.dataset.fill\n"
            "    this._reviewRange = false // [monthly-review v1] 整句填入只填需求，不触发近两月固定区间\n"
            "    this.setData({ prompt: fill })",
            "// [monthly-review v1] 整句填入只填需求",
        ),
        # op5 点 chip → 置标志（仅月度复盘为真）
        (
            "    if (ds.label) this.setData({ prompt: ds.label })\n"
            "    this.onGenerate()",
            "    // [monthly-review v1] 「月度复盘」chip：本次生成固定用近两月区间（上月 1 日 ~ 今天），\n"
            "    // 不看顶部胶囊；其余 chip 照旧只管需求\n"
            "    this._reviewRange = (ds.chip === '月度复盘')\n"
            "    if (ds.label) this.setData({ prompt: ds.label })\n"
            "    this.onGenerate()",
            "this._reviewRange = (ds.chip === '月度复盘')",
        ),
        # op6 onGenerate：防抖块后插入生效区间计算
        (
            "    // 3 秒防抖\n"
            "    if (this._cooling) {\n"
            "      wx.showToast({ title: '操作太快，请稍候', icon: 'none' })\n"
            "      return\n"
            "    }",
            "    // 3 秒防抖\n"
            "    if (this._cooling) {\n"
            "      wx.showToast({ title: '操作太快，请稍候', icon: 'none' })\n"
            "      return\n"
            "    }\n"
            "\n"
            "    // [monthly-review v1] 生效区间：默认跟随顶部胶囊；「月度复盘」chip 强制近两月\n"
            "    // （上月 1 日 00:00 ~ 今天 23:59，与 custom 档同口径）。只影响本次生成的区间，胶囊状态不动\n"
            "    const review = this._reviewRange === true\n"
            "    let effRange = rs.range\n"
            "    let effStart = rs.customStart\n"
            "    let effEnd = rs.customEnd\n"
            "    if (review) {\n"
            "      const now = new Date()\n"
            "      const pad = (x) => (x < 10 ? '0' + x : '' + x)\n"
            "      const lmFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1)\n"
            "      effRange = 'custom'\n"
            "      effStart = lmFirst.getFullYear() + '-' + pad(lmFirst.getMonth() + 1) + '-01'\n"
            "      effEnd = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())\n"
            "    }",
            "const review = this._reviewRange === true",
        ),
        # op7 过滤用生效区间
        (
            "    const filtered = dateRange.filterByRange(sourceList, rs.range, rs.customStart, rs.customEnd) // [range-toolbar v1]",
            "    const filtered = dateRange.filterByRange(sourceList, effRange, effStart, effEnd) // [range-toolbar v1]",
            "filterByRange(sourceList, effRange, effStart, effEnd)",
        ),
        # op8 第一处空日记提示（近两月口径专属文案）
        (
            "    if (!filtered.length) {\n"
            "      this.setData({ error: '所选时间段暂无日记，请更换时间范围或去写日记', hasResult: false, result: '' })\n"
            "      return\n"
            "    }",
            "    if (!filtered.length) {\n"
            "      // [monthly-review v1] 近两月固定区间下无日记：按用户口径提示，不引导去换时间范围\n"
            "      this.setData({ error: review ? '近两月没有日记记录，无法分析' : '所选时间段暂无日记，请更换时间范围或去写日记', hasResult: false, result: '' })\n"
            "      return\n"
            "    }",
            "review ? '近两月没有日记记录，无法分析' : '所选时间段暂无日记，请更换时间范围或去写日记'",
        ),
        # op9 第二处空日记提示（发送量截断兜底；guard 带尾随上下文与 op8 区分）
        (
            "    if (!diaries.length) {\n"
            "      this.setData({ error: '所选时间段暂无日记', hasResult: false, result: '' })\n"
            "      return\n"
            "    }",
            "    if (!diaries.length) {\n"
            "      this.setData({ error: review ? '近两月没有日记记录，无法分析' : '所选时间段暂无日记', hasResult: false, result: '' })\n"
            "      return\n"
            "    }",
            "review ? '近两月没有日记记录，无法分析' : '所选时间段暂无日记', hasResult: false",
        ),
        # op10 云函数入参起止日期用生效区间
        (
            "    const rangeDate = dateRange.rangeDateKeys(rs.range, rs.customStart, rs.customEnd) // [range-toolbar v1]",
            "    const rangeDate = dateRange.rangeDateKeys(effRange, effStart, effEnd) // [range-toolbar v1]",
            "rangeDateKeys(effRange, effStart, effEnd)",
        ),
        # op11 结果页范围文案用生效区间
        (
            "          rangeText: dateRange.rangeText(rs.range, rs.customStart, rs.customEnd), // [range-toolbar v1]",
            "          rangeText: dateRange.rangeText(effRange, effStart, effEnd), // [range-toolbar v1]",
            "rangeText(effRange, effStart, effEnd)",
        ),
        # op12 onReset 清标志
        (
            "  onReset() {\n"
            "    this.setData({",
            "  onReset() {\n"
            "    this._reviewRange = false // [monthly-review v1] 重置清标志\n"
            "    this.setData({",
            "// [monthly-review v1] 重置清标志",
        ),
    ],
    "pages/summary/summary.wxml": [
        # op13 空态文案「您」→「你」
        (
            "<view class=\"placeholder-text\">AI将根据您的指示生成总结</view>",
            "<view class=\"placeholder-text\">AI将根据你的指示生成总结</view>",
            "AI将根据你的指示生成总结",
        ),
    ],
    "pages/summary/summary.wxss": [
        # op14 content-inner 撑满滚动区高度 + 纵向 flex
        (
            ".content-inner {\n"
            "  padding: var(--sp-md) 0 var(--sp-lg);\n"
            "}",
            "/* [footer-center v1] 撑满滚动区高度并纵向 flex：结果区 flex:1 占据「最后一条模板 ↔ 底栏」\n"
            "   的剩余空间，空态羽毛提示在其中垂直居中（用户拍板 2）；内容超高时照常滚动 */\n"
            ".content-inner {\n"
            "  min-height: 100%;\n"
            "  box-sizing: border-box;\n"
            "  display: flex;\n"
            "  flex-direction: column;\n"
            "  padding: var(--sp-md) 0 var(--sp-lg);\n"
            "}",
            "/* [footer-center v1] 撑满滚动区高度",
        ),
        # op15 result-area 占满剩余高度并垂直居中
        (
            ".result-area {\n"
            "  margin-top: var(--sp-sm);\n"
            "}",
            ".result-area {\n"
            "  margin-top: var(--sp-sm);\n"
            "  /* [footer-center v1] 占满剩余高度并垂直居中（空态/加载/错误三种状态都吃这个居中） */\n"
            "  flex: 1;\n"
            "  display: flex;\n"
            "  flex-direction: column;\n"
            "  justify-content: center;\n"
            "}",
            "/* [footer-center v1] 占满剩余高度并垂直居中",
        ),
    ],
}


def load(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")
    nl = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n"), nl


def save(path, text, nl):
    data = text.replace("\n", nl).encode("utf-8")
    with open(path, "wb") as f:
        f.write(data)


def iter_ops():
    for rel, ops in OPS.items():
        for i, (old, new, guard) in enumerate(ops):
            yield rel, i + 1, old, new, guard


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode not in ("--check", "--write", "--restore"):
        print("用法: python patch_monthly_review.py --check|--write|--restore")
        return 2

    if mode == "--restore":
        if not os.path.isdir(BACKUP_DIR):
            print("RESTORE-FAIL: 备份目录不存在", BACKUP_DIR)
            return 1
        n = 0
        for rel in OPS:
            src = os.path.join(BACKUP_DIR, os.path.basename(rel))
            dst = os.path.join(ROOT, rel)
            if not os.path.exists(src):
                print("RESTORE-FAIL: 备份缺失", rel)
                return 1
            shutil.copy2(src, dst)
            n += 1
        print("RESTORE-OK:", n, "files restored from", BACKUP_DIR)
        return 0

    applied = skipped = missing = multi = guardhit = 0
    details = []
    for rel, idx, old, new, guard in iter_ops():
        path = os.path.join(ROOT, rel)
        text, nl = load(path)
        if guard in text:
            skipped += 1
            details.append("SKIP  %s#%02d（guard 命中，幂等）" % (rel, idx))
            continue
        c = text.count(old)
        if c == 0:
            missing += 1
            details.append("MISS  %s#%02d（锚点 0 命中）" % (rel, idx))
        elif c > 1:
            multi += 1
            details.append("MULTI %s#%02d（锚点 %d 命中，须唯一）" % (rel, idx, c))
        else:
            if mode == "--write":
                text = text.replace(old, new, 1)
                save(path, text, nl)
            applied += 1
            details.append("OK    %s#%02d" % (rel, idx))

    print("== patch_monthly_review %s ==" % mode)
    for d in details:
        print(d)
    print("applied=%d skipped=%d miss=%d multi=%d" % (applied, skipped, missing, multi))
    if mode == "--check":
        ok = (missing == 0 and multi == 0)
        print("CHECK:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    ok = (missing == 0 and multi == 0)
    print("WRITE:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
