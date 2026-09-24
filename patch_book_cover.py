# -*- coding: utf-8 -*-
# [book-cover v1] 进入日记本：封面沿左侧装订线翻开露出内页（2026-09-24 用户指令：
# 「打开日记本做翻页的切换，用翻页的形式，效果像打开一本书，模拟打开纸质日记本」；
# 用户拍板：路径 A（页内入场动画）+ 封面直接翻开露出内页 + 只做进入那一下）。
# 铁律：锚点 count==1；write 判据 = count(anchor)==1 && count(new)==0；mode 先 lstrip('-')（坑 12）。
import sys, io

BASE = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
IDX_WXML = BASE + "\\pages\\index\\index.wxml"
IDX_WXSS = BASE + "\\pages\\index\\index.wxss"
IDX_JS = BASE + "\\pages\\index\\index.js"
WRITE_JS = BASE + "\\pages\\write\\write.js"

# ---------------- op1: index.wxml 封面节点（作为 .page 首个子节点，首帧就位） ----------------
W_ANCHOR = (
    '<view class="page {{themeClass}}" style="{{fontStyle}}">\n'
    '  <!-- 工具行：日期范围胶囊（左）+ 导出/导入（右）[range-toolbar v1] -->'
)
W_NEW = (
    '<view class="page {{themeClass}}" style="{{fontStyle}}">\n'
    '  <!-- [book-cover v1] 进入日记本：封面沿左侧装订线翻开、露出内页（仅入场动画；open=book 入口才播） -->\n'
    '  <view\n'
    '    wx:if="{{showBookCover}}"\n'
    '    class="book-cover"\n'
    '    catchtap="onBookCoverBlock"\n'
    '    catchtouchmove="onBookCoverBlock"\n'
    '    bindanimationend="onBookCoverEnd"\n'
    '  >\n'
    '    <view class="book-cover-spine"></view>\n'
    '    <view class="book-cover-face">\n'
    '      <text class="book-cover-title">{{appName}}</text>\n'
    '      <view class="book-cover-rule"></view>\n'
    '      <text class="book-cover-slogan">{{appSlogan}}</text>\n'
    '    </view>\n'
    '  </view>\n'
    '\n'
    '  <!-- 工具行：日期范围胶囊（左）+ 导出/导入（右）[range-toolbar v1] -->'
)

# ---------------- op2: index.wxss 追加封面样式（append 型） ----------------
CSS_NEW = """

/* ===== [book-cover v1] 进入日记本：封面沿左侧装订线翻开露出内页（仅入场动画，进页后移除） =====
   材质说明：书封是「实体」，**不随 --brand 令牌翻明暗**——浅色下 --brand 系本就是深棕、
   深色下会被提亮成浅棕，若跟随则「米白字压浅棕」对比崩掉。故此处显式定色，并给出
   .theme-dark 档（深色下封面更深、字仍为米白），保证两档主题下都是「深封 + 浅字」。
   回归防护见 tools/test_book_cover.js 的 C 组。 */
.book-cover {
  --bc-face-1: #6E6455;
  --bc-face-2: #453F35;
  --bc-ink: #F7F2E9;
  --bc-ink-2: rgba(247, 242, 233, 0.66);
  --bc-rule: rgba(247, 242, 233, 0.26);
  --bc-spine: rgba(0, 0, 0, 0.20);
  --bc-shadow: rgba(69, 63, 53, 0.42);
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1500;
  transform-origin: left center;
  -webkit-backface-visibility: hidden;
  backface-visibility: hidden;
  background: linear-gradient(160deg, var(--bc-face-1) 0%, var(--bc-face-2) 100%);
  box-shadow: 30rpx 0 70rpx var(--bc-shadow);
  animation: book-open-cover 720ms cubic-bezier(0.44, 0.02, 0.2, 1) forwards;
  display: flex;
  align-items: center;
  justify-content: center;
}

.theme-dark .book-cover {
  --bc-face-1: #35302A;
  --bc-face-2: #221E1A;
  --bc-ink: #F2ECE2;
  --bc-ink-2: rgba(242, 236, 226, 0.62);
  --bc-rule: rgba(242, 236, 226, 0.22);
  --bc-spine: rgba(0, 0, 0, 0.45);
  --bc-shadow: rgba(0, 0, 0, 0.55);
}

/* 书脊：左侧一条压暗带，读作「装订侧」 */
.book-cover-spine {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 26rpx;
  background: var(--bc-spine);
}

.book-cover-face {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-left: 26rpx;
}

.book-cover-title {
  font-family: var(--font-display);
  font-size: 60rpx;
  letter-spacing: 12rpx;
  color: var(--bc-ink);
}

.book-cover-rule {
  width: 96rpx;
  height: 2rpx;
  background: var(--bc-rule);
  margin: 30rpx 0;
}

.book-cover-slogan {
  font-size: 24rpx;
  letter-spacing: 6rpx;
  color: var(--bc-ink-2);
}

@keyframes book-open-cover {
  0% { transform: perspective(1600rpx) rotateY(0deg); }
  100% { transform: perspective(1600rpx) rotateY(-180deg); }
}
"""

# ---------------- op3: index.js 时长常量 ----------------
J_ANCHOR = "const tagFit = require('../../utils/tagFit.js') // [tag-fit v1] 列表标签两行自适应"
J_NEW = (
    J_ANCHOR + "\n"
    "// [book-cover v1] 封面翻开动画时长（ms）：与 index.wxss 的 book-open-cover 对应，\n"
    "// 略大于动画时长，防止动画事件缺失时提前揭开封面留下残影\n"
    "const BOOK_COVER_MS = 760"
)

# ---------------- op4: index.js data 字段 ----------------
D_ANCHOR = "    sortOrder: 'desc'\n  },"
D_NEW = (
    "    sortOrder: 'desc',\n"
    "    // [book-cover v1] 进入日记本：封面翻开露出内页（仅入场动画；open=book 入口才播）\n"
    "    showBookCover: false,\n"
    "    // [book-cover v1] 封面品牌文字（来源 utils/appInfo.js，不硬编码）\n"
    "    appName: appInfo.APP_NAME,\n"
    "    appSlogan: appInfo.APP_SLOGAN\n"
    "  },"
)

# ---------------- op5: index.js onLoad 块（含 onUnload 与封面两个方法） ----------------
L_ANCHOR = "  onLoad() {\n    this.loadData()\n  },"
L_NEW = (
    "  // [book-cover v1] 进入日记本：封面翻开露出内页（只有「打开日记本」主动入口才播）\n"
    "  onLoad(options) {\n"
    "    this.loadData()\n"
    "    // 入口口径：仅 write 页的 ?open=book 触发；reLaunch 回来（删日记/总结完/清空数据）不播翻书动画\n"
    "    if (options && options.open === 'book') {\n"
    "      this.setData({ showBookCover: true })\n"
    "      // animationend 为主、定时器兜底：万一动画事件没来，也不会永久挡住列表\n"
    "      this._bookCoverTimer = setTimeout(() => {\n"
    "        this.setData({ showBookCover: false })\n"
    "      }, BOOK_COVER_MS)\n"
    "    }\n"
    "  },\n"
    "\n"
    "  onUnload() {\n"
    "    // [book-cover v1] 页面销毁清掉兜底定时器，避免回调打到已销毁实例\n"
    "    if (this._bookCoverTimer) {\n"
    "      clearTimeout(this._bookCoverTimer)\n"
    "      this._bookCoverTimer = null\n"
    "    }\n"
    "  },\n"
    "\n"
    "  // [book-cover v1] 翻开动画期间遮罩吞掉点击/滑动（防止误触列表）\n"
    "  onBookCoverBlock() {},\n"
    "\n"
    "  // [book-cover v1] 动画结束即移除封面（不依赖定时器）\n"
    "  onBookCoverEnd() {\n"
    "    if (this._bookCoverTimer) {\n"
    "      clearTimeout(this._bookCoverTimer)\n"
    "      this._bookCoverTimer = null\n"
    "    }\n"
    "    if (this.data.showBookCover) this.setData({ showBookCover: false })\n"
    "  },"
)

# ---------------- op6: write.js 入口带参 ----------------
X_ANCHOR = "wx.navigateTo({ url: '/pages/index/index' })"
X_NEW = "wx.navigateTo({ url: '/pages/index/index?open=book' })"

OPS = [
    ("wxml 封面节点（首帧就位）", IDX_WXML, "block", (W_ANCHOR, W_NEW)),
    ("wxss 封面样式+关键帧", IDX_WXSS, "append", ("book-open-cover", "book-cover {", CSS_NEW)),
    ("js BOOK_COVER_MS 常量", IDX_JS, "block", (J_ANCHOR, J_NEW)),
    ("js data 封面字段", IDX_JS, "block", (D_ANCHOR, D_NEW)),
    ("js onLoad/onUnload+方法", IDX_JS, "block", (L_ANCHOR, L_NEW)),
    ("write 入口 ?open=book", WRITE_JS, "block", (X_ANCHOR, X_NEW)),
]

GUARD = "book-cover v1"


def load(p):
    raw = io.open(p, "rb").read().decode("utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw, nl


def apply_op(text, kind, payload):
    """返回 (新文本, 状态)。状态：OK / SKIP / FAIL"""
    if kind == "block":
        a, n = payload
        ca, cn = text.count(a), text.count(n)
        if cn > 0:
            return text, (a, "SKIP(已应用)", True)
        if ca != 1:
            return text, (a, "FAIL(锚点 %d 次)" % ca, False)
        return text.replace(a, n, 1), (a, "APPLIED", True)
    else:  # append：guard 不存在才追加
        g1, g2, body = payload
        if g1 in text and g2 in text:
            return text, (g1, "SKIP(已应用)", True)
        return text.rstrip() + body, (g1, "APPLIED", True)


def main(mode):
    mode = (mode or "").lstrip("-")
    items = []
    all_ok = True
    for name, path, kind, payload in OPS:
        raw, nl = load(path)
        text = raw.replace("\r\n", "\n")
        if mode == "check":
            if kind == "block":
                a, n = payload
                ca, cn = text.count(a), text.count(n)
                if cn > 0:
                    items.append((name, "SKIP(已应用)", True))
                elif ca == 1:
                    items.append((name, "OK", True))
                else:
                    items.append((name, "FAIL(锚点 %d 次)" % ca, False))
                    all_ok = False
            else:
                g1, g2, _ = payload
                if g1 in text and g2 in text:
                    items.append((name, "SKIP(已应用)", True))
                else:
                    items.append((name, "OK", True))
        elif mode == "write":
            new_text, (tag, st, ok) = apply_op(text, kind, payload)
            if ok and st != "SKIP(已应用)":
                io.open(path, "wb").write(new_text.replace("\n", nl).encode("utf-8"))
            items.append((name, st, ok))
            if not ok:
                all_ok = False
    for name, st, ok in items:
        print("%-26s %s" % (name, st))
    print("MODE=%s ALL=%s" % (mode, "OK" if all_ok else "FAIL"))
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "check")
