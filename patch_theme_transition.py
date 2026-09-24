# -*- coding: utf-8 -*-
"""
[theme-transition v1] 深色模式「切页跳闪浅色一下」—— 转场底层修复

根因（分层）：
  主因  app.wxss 的 page{ background-color: var(--bg) } —— `.theme-dark` 挂在页面根节点
        (.page) 上，page 元素吃不到深色令牌，恒为浅色 #EFEBE5。页面转场那一瞬新页面
        WXML 尚未上屏，屏幕上露出的正是 page 元素这一层 ⇒ 深色用户每次先看到一整屏浅色。
        （firstPaint 只修了 WXML 首帧，修不到它底下这一层。）
  次因  summary / font-setting / setting-reminder 三个页面 json 写死了
        navigationBarBackgroundColor:"#F8F4EE"（summary 还有 backgroundColor），
        页面级静态配置进页时重新应用，冲掉 onShow 里设的深色导航栏。
  顺手  app.json 的 backgroundTextStyle 静态 dark，深色底上下拉回弹三点看不见。

ops：
  1) app.wxss                                  page 背景 → transparent（转场露「窗口底」）
  2) utils/theme.js                            applyChrome 取 mode 变量 + setBackgroundTextStyle 跟随
  3) pages/summary/summary.json                删页面级静态浅色
  4) pages/font-setting/font-setting.json      删页面级静态浅色
  5) pages/setting-reminder/setting-reminder.json 删页面级静态浅色

用法（在工程根跑）：
  python patch_theme_transition.py --check
  python patch_theme_transition.py --write
  python patch_theme_transition.py --restore
"""
import os, sys, shutil

SIG = '[theme-transition v1]'
ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BAK = r'C:\Users\ThinkPad\WorkBuddy\主题转场底层-backup-20260923'

P_APPWXSS = 'app.wxss'
P_THEME = 'utils/theme.js'
P_SUMMARY = 'pages/summary/summary.json'
P_FONT = 'pages/font-setting/font-setting.json'
P_REMIND = 'pages/setting-reminder/setting-reminder.json'


def _read(rel):
    p = os.path.join(ROOT, rel.replace('/', os.sep))
    with open(p, 'rb') as f:
        raw = f.read()
    crlf = b'\r\n' in raw
    return raw.decode('utf-8').replace('\r\n', '\n'), crlf


def _write(rel, text, crlf):
    p = os.path.join(ROOT, rel.replace('/', os.sep))
    out = text.replace('\n', '\r\n') if crlf else text
    with open(p, 'wb') as f:
        f.write(out.encode('utf-8'))


# ---------------- op 定义 ----------------
# guard：改后必成立的判据（幂等）。old 必须在文件内唯一命中。
OPS = [
    dict(
        tag='op1 app.wxss · page 背景 transparent',
        path=P_APPWXSS,
        guard=lambda t: 'background-color: transparent;' in t,
        old="""  /* ---------- 全局排版基底 ---------- */
  background-color: var(--bg);
""",
        new="""  /* ---------- 全局排版基底 ----------
     [theme-transition v1] 本行原为浅色令牌背景。注意：`.theme-dark` 挂在页面根节点
     (.page) 上，page 元素**吃不到**那套深色令牌 ⇒ 这里恒为浅色 #EFEBE5；而页面转场
     那一瞬新页面 WXML 尚未上屏，屏幕上露出的正是 page 元素这一层，深色用户因此每次
     都先看到一整屏浅色（「跳闪浅色」的主因，utils/firstPaint.js 修不到它）。
     改为 transparent 后，转场期露出的是「窗口底」——窗口底由 utils/theme.js#applyChrome
     的 wx.setBackgroundColor 全局设置且切页不重置，深色下即 #1B1916。
     正常渲染时各页 .page 根节点自带 var(--bg) 背景 + 100vh 已完整盖住本层；浅色主题下
     窗口底同样被设为 #EFEBE5，视觉零变化。回归防护见 tools/test_theme_transition.js。 */
  background-color: transparent;
""",
    ),
    dict(
        tag='op2a utils/theme.js · applyChrome 取 mode',
        path=P_THEME,
        guard=lambda t: 'const m = mode || getMode()' in t,
        old="""  const c = CHROME[mode || getMode()] || CHROME.light
""",
        new="""  const m = mode || getMode()
  const c = CHROME[m] || CHROME.light
""",
    ),
    dict(
        tag='op2b utils/theme.js · 下拉回弹三点跟随主题',
        path=P_THEME,
        guard=lambda t: 'setBackgroundTextStyle' in t,
        old="""  try {
    if (wx.setBackgroundColor) wx.setBackgroundColor({ backgroundColor: c.bg })
  } catch (e) { /* 同上 */ }
}
""",
        new="""  try {
    if (wx.setBackgroundColor) wx.setBackgroundColor({ backgroundColor: c.bg })
  } catch (e) { /* 同上 */ }
  try {
    /* [theme-transition v1] 下拉回弹的 loading 三点：静态 backgroundTextStyle 是 dark，
       深色底上几乎不可见，这里跟随主题（浅色 dark / 深色 light） */
    if (wx.setBackgroundTextStyle) {
      wx.setBackgroundTextStyle({ textStyle: m === 'dark' ? 'light' : 'dark' })
    }
  } catch (e) { /* 同上 */ }
}
""",
    ),
    dict(
        tag='op3 summary.json · 删页面级静态浅色',
        path=P_SUMMARY,
        guard=lambda t: 'navigationBarBackgroundColor' not in t,
        old="""  "navigationBarTitleText": "智能总结",
  "navigationBarBackgroundColor": "#F8F4EE",
  "navigationBarTextStyle": "black",
  "backgroundColor": "#F8F4EE"
""",
        new="""  "navigationBarTitleText": "智能总结",
  "navigationBarTextStyle": "black"
""",
    ),
    dict(
        tag='op4 font-setting.json · 删页面级静态浅色',
        path=P_FONT,
        guard=lambda t: 'navigationBarBackgroundColor' not in t,
        old="""  "navigationBarTitleText": "日记字体",
  "navigationBarBackgroundColor": "#F8F4EE"
""",
        new="""  "navigationBarTitleText": "日记字体"
""",
    ),
    dict(
        tag='op5 setting-reminder.json · 删页面级静态浅色',
        path=P_REMIND,
        guard=lambda t: 'navigationBarBackgroundColor' not in t,
        old="""  "navigationBarTitleText": "闹钟提醒",
  "navigationBarBackgroundColor": "#F8F4EE"
""",
        new="""  "navigationBarTitleText": "闹钟提醒"
""",
    ),
]


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode not in ('--check', '--write', '--restore'):
        log('[!] 未知参数 %s（--check / --write / --restore）' % mode)
        return 2

    if mode == '--restore':
        n = 0
        for op in OPS:
            s = os.path.join(BAK, op['path'].replace('/', os.sep))
            d = os.path.join(ROOT, op['path'].replace('/', os.sep))
            if os.path.isfile(s):
                shutil.copy2(s, d)
                n += 1
                log('RESTORE %s' % op['path'])
        log('[restore] 已回滚 %d 个文件' % n)
        return 0

    # ---- load 只做一次（坑 5）：全部改动在内存里做，最后统一写盘 ----
    files = {}
    for op in OPS:
        if op['path'] not in files:
            files[op['path']] = _read(op['path'])
    text = {k: v[0] for k, v in files.items()}

    errs, skips, applied = [], [], []
    for op in OPS:
        t = text[op['path']]
        if op['guard'](t):
            skips.append(op['tag'])
            continue
        n = t.count(op['old'])
        if n != 1:
            errs.append('%s → 锚点命中 %d 次（应为 1）' % (op['tag'], n))
            continue
        text[op['path']] = t.replace(op['old'], op['new'], 1)
        applied.append(op['tag'])

    for line in errs:
        log('[ERR ] %s' % line)
    for line in skips:
        log('[SKIP] %s（已改过）' % line)
    for line in applied:
        log('[OK  ] %s' % line)

    if errs:
        log('[FAIL] 锚点异常，未写盘')
        return 1

    if mode == '--check':
        log('[check] 可应用 %d 项 / 跳过 %d 项 —— 未写盘' % (len(applied), len(skips)))
        return 0

    # ---- --write：自动备份（幂等：已存在即早退） ----
    if not os.path.isdir(BAK):
        for rel, (t0, crlf0) in files.items():
            s = os.path.join(ROOT, rel.replace('/', os.sep))
            d = os.path.join(BAK, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
        log('[bak ] 已备份 %d 个文件 → %s' % (len(files), BAK))
    else:
        log('[bak ] 备份目录已存在，早退（幂等）')

    for rel, (_, crlf) in files.items():
        _write(rel, text[rel], crlf)

    # ---- 落盘复核 ----
    bad = []
    for op in OPS:
        t2 = _read(op['path'])[0]
        if not op['guard'](t2):
            bad.append(op['tag'])
    if bad:
        log('[FAIL] 写盘后复核未通过：%s' % '; '.join(bad))
        return 1
    log('[write] 落盘完成，%d 项已应用、%d 项跳过，复核全过' % (len(applied), len(skips)))
    return 0


def log(s):
    print(s)
    try:
        with open(os.path.join(ROOT, 'patch_theme_transition_out.txt'), 'a', encoding='utf-8') as f:
            f.write(s + '\n')
    except Exception:
        pass


if __name__ == '__main__':
    sys.exit(main())
