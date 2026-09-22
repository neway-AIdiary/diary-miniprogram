# -*- coding: utf-8 -*-
"""
[poster-weather-text v1] 海报天气行去掉图标（2026-09-22 真机：安卓 + iPhone，用户拍板 2）

现场
----
* 安卓保存海报 → 天气图标与「晴 26° · 北京市」之间空一个很宽的格；
* iPhone 保存海报 → 图标与文字之间多一个**方框占位符**。
用户要求：不要空格、不要占位符。拍板方案 2：**海报天气行只画文字**。

根因（同一条链路的两个端）
--------------------------
绘制链路：share-sheet.js#drawPoster 把 `weatherLine(d)` 的**整串**一次 fillText，
字体 `400 25px sans-serif`（canvas 绘制，不走 wxml/令牌）。

* iOS 方框：天气图标全是 U+2600 系「基字符 + 变体选择符 U+FE0F」
  （☀️=U+2600+FE0F、☁️、🌧️、❄️、🌤️、⛈️…）。FE0F 在 iOS canvas 的 sans-serif
  字体回退链里没有字形 ⇒ 被画成 notdef 方框，即「☀□」里那个 □。
  **旁证**：心情 emoji（😊😐😌…）全是单个星面码位、不带 FE0F —— 同一张海报、同一画法，
  双端都正常。差异只在有无 FE0F。
* 安卓宽格：emoji 被当全宽字符（advance ≈ 1em），代码又在图标与文字之间显式加了一个空格
  ⇒ 25px 字号下视觉空隙约 1.5 字。

为什么要「去图标」而不是「剥 FE0F」
----------------------------------
剥 FE0F 只治 iOS 那半个（安卓的宽格仍在，因为 emoji 本身就是全宽）；
而 canvas 里的 emoji 渲染跨端不可控是结构性问题 —— 换成任何天气类型都可能再撞。
海报是**对外分享物**，口径必须是「双端逐像素一致」，所以天气行只留文字。

改法
----
* 新增纯函数 `weatherTextOnly(d)`：只取 weatherText，并**防御性**剥掉 emoji 与变体选择符
  （万一云端/旧数据把图标并进 weatherText，也在海报上消失），折叠空白、去首尾。
* `buildPosterModel().weather` 改用它；`weatherLine(d)` **原样保留**给「复制文字版」
  （wxml/输入框里 emoji 渲染正常，那边不该跟着变）。
* 海报里心情 pill 不动（emoji 无 FE0F、双端正常，且它带底色胶囊，去掉反而破坏版式）。

配套
----
* `tools/test_share.js` 那条第 5 组断言（海报天气原为 '☀️ 晴 28° · 深圳'）按新口径更新；
  「复制文字版」那条（仍含 '☀️ 晴 28° · 深圳'）**保持不动** —— 它是这次改动的回归网。
* 无云函数改动；纯客户端逻辑。

用法：--check（只验锚点与幂等） | --write（落盘，含幂等备份） | --restore-src | --restore
"""
import io
import os
import sys
import shutil

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\poster-weather-backup-20260922'

CRLF = chr(13) + chr(10)
LF = chr(10)

SH = 'utils/share.js'
TS = 'tools/test_share.js'

OPS = []


def op(rel, tag, old, new, sig):
    OPS.append((rel, {'tag': tag, 'old': old, 'new': new, 'sig': sig}))


# ============================================================
# utils/share.js
# ============================================================

# ---- S1 新增 weatherTextOnly（插在 weatherLine 之前）----
op(SH, 'S1 新增 weatherTextOnly（海报专用·不带图标）',
   r"""// 天气一行（icon + 文本），无则空串
function weatherLine(d) {""",
   r"""// [poster-weather-text v1] 海报天气文本（**不带图标**，2026-09-22 真机双端拍板 2）
// 为什么：海报是 canvas 绘制，天气图标全是 U+2600 系「基字符 + 变体选择符 U+FE0F」——
//   iOS canvas 的 sans-serif 回退链没有 FE0F 字形，把它画成 notdef 方框（☀□）；
//   安卓把 emoji 当全宽字符，再叠加代码里那个显式空格 ⇒ 视觉空隙约 1.5 字。
//   两个端的根都是「emoji 进 canvas」，剥 FE0F 只治一半 ⇒ 干脆不画图标。
//   心情 emoji 不受影响：全是单个星面码位、不带 FE0F，双端正常，故 pill 不动。
// 口径：只有海报走这里；「复制文字版」仍走 weatherLine（输入框里 emoji 渲染正常）。
// 防御：万一云端或旧数据把图标并进 weatherText，这里连 emoji 与变体选择符一起剥掉，
//   保证海报**永不出方格、永不留多余空格**（幂等、空值安全）。
function weatherTextOnly(d) {
  if (!d) return ''
  return String(d.weatherText == null ? '' : d.weatherText)
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')            // 变体选择符（方格真凶）+ 零宽连接符
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF]/g, '')    // 杂项符号 / 箭头 dingbat（emoji 基字符）
    .replace(/[\uD83C-\uD83E][\uDC00-\uDFFF]/g, '')  // 星面 emoji（U+1F000–1FBFF）；区间刻意收窄在
                                                     // emoji 块内，别误伤 CJK 扩展区生僻字（如 𠮷 U+20BB7）
    .replace(/\s+/g, ' ')
    .trim()
}

// 天气一行（icon + 文本），无则空串
function weatherLine(d) {""",
   'function weatherTextOnly(d) {')

# ---- S2 buildPosterModel 的 weather 字段改用它 ----
op(SH, 'S2 海报模型 weather 字段改用 weatherTextOnly',
   """    weather: sw.weather === false ? '' : weatherLine(d),""",
   """    // [poster-weather-text v1] 海报天气行不带图标（canvas 双端渲染口径，见 weatherTextOnly 注释）
    weather: sw.weather === false ? '' : weatherTextOnly(d),""",
   "    weather: sw.weather === false ? '' : weatherTextOnly(d),")

# ---- S3 导出 weatherTextOnly ----
op(SH, 'S3 导出 weatherTextOnly',
   """  weatherLine: weatherLine,""",
   """  weatherLine: weatherLine,
  weatherTextOnly: weatherTextOnly,""",
   """  weatherTextOnly: weatherTextOnly,""")


# ============================================================
# tools/test_share.js —— 海报天气断言按新口径更新
# （「复制：含天气」那条保持不动，它是这次改动的回归网）
# ============================================================
op(TS, 'T1 海报天气断言改为不带图标',
   """assert('海报：天气', pm.weather, '☀️ 晴 28° · 深圳')""",
   """assert('海报：天气（不带图标，canvas 双端渲染口径）', pm.weather, '晴 28° · 深圳')""",
   """assert('海报：天气（不带图标，canvas 双端渲染口径）', pm.weather, '晴 28° · 深圳')""")


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
