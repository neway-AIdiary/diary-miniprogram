# -*- coding: utf-8 -*-
"""[privacy-weather-gate v1] 首启弹窗串行（定位让路隐私）+ 隐私弹窗文案两行/加粗

问题：写日记页 onLoad 里 tryShow()（异步）与 loadWeather()（立即）并发，
首启时系统定位授权弹窗抢在隐私弹窗收口前弹出，两弹叠着，用户体感差；
且 wx.getLocation 属微信隐私接口，规范口径应在用户同意后才调用。

修法：
  ① write.js 新增放行标记 _locationAllowed：loadWeather 入口闸门，标记未置位不请求定位；
     无需授权（老用户/已同意/旧基础库）在 onPrivacyChecked(false) 放行并补拉；
     点「同意并继续」在 onPrivacyClosed(带 agreed) 放行并补拉；
     点「暂不同意」本次会话不放行（下次会话同意后自然恢复）。
  ② privacy-popup.js close 事件带 { agreed } 标记（同意 true / 暂不同意 false）。
  ③ privacy-popup.wxml 文案拆两行；「只有你能看到你的日记」加粗（.pp-strong）。

用法：--check（锚点唯一性 + 幂等预检） / --write / --restore
锚点必须 count==1；guard 串必须逐字抄自 new 文本（幂等判据）。
"""
import os, sys

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BAK = r"C:\Users\ThinkPad\WorkBuddy\privacy-weather-gate-backup-20260924"

# (relpath, name, old, new, guard)
OPS = [
    # ---- pages/write/write.js ----
    ("pages/write/write.js", "W1 onLoad 放行标记初始化",
     "    this._privacyChecked = false\n",
     "    this._privacyChecked = false\n"
     "    // [privacy-weather-gate v1] 定位放行标记：隐私结论出来且「无需授权/已同意」才允许请求定位\n"
     "    this._locationAllowed = false\n",
     "this._locationAllowed = false"),

    ("pages/write/write.js", "W2 loadWeather 入口闸门",
     "  loadWeather() {\n"
     "    if (this._weatherLoading) return   // onLoad 与 onShow 紧邻触发，防重复请求\n",
     "  loadWeather() {\n"
     "    if (this._weatherLoading) return   // onLoad 与 onShow 紧邻触发，防重复请求\n"
     "    // [privacy-weather-gate v1] 定位让路隐私：wx.getLocation 是隐私接口，放行标记未置位前不请求\n"
     "    //（首启「隐私弹窗 + 定位弹窗」叠着弹的根治；放行后由 onPrivacyChecked / onPrivacyClosed 补拉）\n"
     "    if (!this._locationAllowed) return\n",
     "if (!this._locationAllowed) return"),

    ("pages/write/write.js", "W3 无需授权 → 放行并补拉",
     "    this._privacyChecked = true\n"
     "    if (needAuth) return\n"
     "    this.resumeGuide()\n",
     "    this._privacyChecked = true\n"
     "    if (needAuth) return\n"
     "    // [privacy-weather-gate v1] 无需授权（老用户/已同意/旧基础库）→ 放行并补拉定位\n"
     "    this._locationAllowed = true\n"
     "    this.loadWeather()\n"
     "    this.resumeGuide()\n",
     "    this._locationAllowed = true\n    this.loadWeather()"),

    ("pages/write/write.js", "W4 关闭回调按 agreed 放行",
     "  onPrivacyClosed() {\n"
     "    this._privacyChecked = true // 关闭必然意味着查询已有结论（防御性补齐）\n"
     "    this.resumeGuide()\n"
     "  },\n",
     "  onPrivacyClosed(e) {\n"
     "    this._privacyChecked = true // 关闭必然意味着查询已有结论（防御性补齐）\n"
     "    // [privacy-weather-gate v1] 「同意并继续」才放行定位；「暂不同意」本次会话不请求（下次同意后自然恢复）\n"
     "    if (e && e.detail && e.detail.agreed) { this._locationAllowed = true; this.loadWeather() }\n"
     "    this.resumeGuide()\n"
     "  },\n",
     "if (e && e.detail && e.detail.agreed) { this._locationAllowed = true; this.loadWeather() }"),

    # ---- components/privacy-popup/privacy-popup.js ----
    ("components/privacy-popup/privacy-popup.js", "P1 头注释补一行机制说明",
     " *   - 颜色全部走主题令牌，深浅色由页面根节点 theme-dark 覆盖令牌自动生效\n",
     " *   - 颜色全部走主题令牌，深浅色由页面根节点 theme-dark 覆盖令牌自动生效\n"
     " *   - [privacy-weather-gate v1] close 事件带 { agreed }：页面据此决定是否补拉定位\n",
     "[privacy-weather-gate v1] close 事件带 { agreed }"),

    ("components/privacy-popup/privacy-popup.js", "P2 onAgree 带 agreed:true",
     "    onAgree() {\n"
     "      this.setData({ visible: false })\n"
     "      // 通知页面「弹窗已收」：新手引导靠这个回调接上，两个弹层不叠着弹\n"
     "      this.triggerEvent('close')\n"
     "    },\n",
     "    onAgree() {\n"
     "      this.setData({ visible: false })\n"
     "      // 通知页面「弹窗已收」：新手引导靠这个回调接上，两个弹层不叠着弹。\n"
     "      // [privacy-weather-gate v1] 带 agreed 标记：页面只在「同意」后才补拉定位\n"
     "      this.triggerEvent('close', { agreed: true })\n"
     "    },\n",
     "this.triggerEvent('close', { agreed: true })"),

    ("components/privacy-popup/privacy-popup.js", "P3 onDisagree 带 agreed:false",
     "    onDisagree() {\n"
     "      this.setData({ visible: false })\n"
     "      this.triggerEvent('close')\n"
     "    },\n",
     "    onDisagree() {\n"
     "      this.setData({ visible: false })\n"
     "      // [privacy-weather-gate v1] 不同意：页面不补拉定位（下次会话同意后自然恢复）\n"
     "      this.triggerEvent('close', { agreed: false })\n"
     "    },\n",
     "this.triggerEvent('close', { agreed: false })"),

    # ---- components/privacy-popup/privacy-popup.wxml ----
    ("components/privacy-popup/privacy-popup.wxml", "X1 文案拆两行 + 加粗",
     "    <view class=\"pp-desc-soft\">我们会按政策约定保护你的日记与个人信息；不同意也可继续使用基础记录功能。</view>\n",
     "    <view class=\"pp-desc-soft\">我们会按政策约定保护你的日记与个人信息；<text class=\"pp-strong\">只有你能看到你的日记</text>。</view>\n"
     "    <view class=\"pp-desc-soft pp-desc-soft-line2\">不同意也可继续使用基础记录功能。</view>\n",
     "<text class=\"pp-strong\">只有你能看到你的日记</text>"),

    # ---- components/privacy-popup/privacy-popup.wxss ----
    ("components/privacy-popup/privacy-popup.wxss", "C1 加粗样式 + 第二行紧排",
     ".pp-btn-agree {\n"
     "  margin-top: 32rpx;\n",
     ".pp-strong {\n"
     "  font-weight: 600;\n"
     "  color: var(--ink-mid);\n"
     "}\n"
     "\n"
     ".pp-desc-soft-line2 {\n"
     "  margin-top: 4rpx;\n"
     "}\n"
     "\n"
     ".pp-btn-agree {\n"
     "  margin-top: 32rpx;\n",
     ".pp-desc-soft-line2 {"),
]


def load(rel):
    p = os.path.join(ROOT, rel)
    with open(p, "rb") as f:
        raw = f.read()
    crlf = b"\r\n" in raw
    text = raw.decode("utf-8").replace("\r\n", "\n")
    return text, crlf


def save(rel, text, crlf):
    p = os.path.join(ROOT, rel)
    data = text.replace("\n", "\r\n").encode("utf-8") if crlf else text.encode("utf-8")
    with open(p, "wb") as f:
        f.write(data)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"

    if mode == "--restore":
        for rel, name, _, _, _ in OPS:
            src = os.path.join(BAK, rel.replace("/", "__").replace("\\", "__"))
            dst = os.path.join(ROOT, rel)
            with open(src, "rb") as f:
                data = f.read()
            with open(dst, "wb") as f:
                f.write(data)
            print("RESTORED:", rel)
        return 0

    # 载入涉及的文件（内存中串行应用，一次落盘 —— 补丁只 load 一次）
    texts, crlfs = {}, {}
    for rel, name, _, _, _ in OPS:
        if rel not in texts:
            texts[rel], crlfs[rel] = load(rel)

    ok = True
    applied = skipped = 0
    for rel, name, old, new, guard in OPS:
        t = texts[rel]
        if guard in t:
            skipped += 1
            print("SKIP  %-38s %s" % (name, rel))
            continue
        n = t.count(old)
        if n != 1:
            ok = False
            print("FAIL  %-38s %s  锚点命中 %d 次（须为 1）" % (name, rel, n))
            continue
        texts[rel] = t.replace(old, new, 1)
        applied += 1
        print("OK    %-38s %s" % (name, rel))

    if mode == "--write":
        if not ok:
            print("存在 FAIL 锚点，未写盘")
            return 1
        for rel in texts:
            save(rel, texts[rel], crlfs[rel])
        print("WROTE %d file(s), applied=%d skipped=%d" % (len(texts), applied, skipped))
        return 0

    print("check: applied=%d skipped=%d, all-unique=%s" % (applied, skipped, ok))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
