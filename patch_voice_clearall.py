# -*- coding: utf-8 -*-
"""
[voice-clearall-v1] 语音「清空全部」指令（2026-09-24 用户需求，方案已拍板）

需求：录音识别文本包含「删除/删掉/去掉/清空 + 所有内容/所有文字」等 → 清空输入框。
拍板方案：规则化匹配（正则覆盖一族，不逐条枚举）+ 命中直接清空 + 5 秒撤销条兜底
（不弹确认打断语音流）。

- utils/aiEdit.js：新增 matchClearAll —— 清空动词 × 全量范围词 × 对象词 的两条正则；
  对象词必填（「删除了所有错别字」不触发）、句边界/逗号不可跨越
- pages/write/write.js：processInput 语音路径最前挂 tryClearAll（命中即吞掉指令文本、
  清空正文）；tryClearAll / onClearAllUndo 撤销逻辑；onUnload 清理定时器
- pages/write/write.wxml：撤销条（浮在底部固定区上方，不挤压布局）
- pages/write/write.wxss：撤销条样式（主题令牌，深浅色自适应）
- tools/test_clear_all.js：新套件（本补丁只负责源码，测试另行写入）

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\clearall-patch-backup-20260924'

AIEDIT_OLD = "module.exports = { detect, apply, splitCommands, extractEmbedded, scopeText }"
AIEDIT_NEW = """// ===== [voice-clearall-v1] 语音「清空全部」指令识别（2026-09-24 用户需求）=====
// 口述「删除所有内容/删掉所有文字/清空所有内容/全部删除」等 → 清空输入框。
// 规则化覆盖一族（清空动词 × 全量范围词 × 对象词），不逐条枚举：
//   A) 动词在前：删除/删掉/去掉/清除/清空 + 短间隔 + 所有/全部 + 短间隔 + 内容/文字/东西
//      （对象词必填——「删除了所有错别字」这类叙述不带这三个对象词，不触发）
//   B) 范围在前：所有/全部 + 极短间隔 + 删除/删掉/去掉/清除/清空/删了
// 句边界（。！？!?）与逗号不可跨越——「删除了。所有内容都很好」不触发；
// 极少数叙述误命中（如「所有人都删除了」）由清空后的 5 秒撤销条兜底
const CLEAR_ALL_STOP = '[^。！？!?\\\\n，,、；;：:]'
const CLEAR_ALL_VERBS = '(?:删除|删掉|去掉|清除|清空|删了)'
const CLEAR_ALL_PAT_A = new RegExp(CLEAR_ALL_VERBS + CLEAR_ALL_STOP + '{0,4}(?:所有|全部)' + CLEAR_ALL_STOP + '{0,6}(?:内容|文字|东西)')
const CLEAR_ALL_PAT_B = new RegExp('(?:所有|全部)' + CLEAR_ALL_STOP + '{0,2}' + CLEAR_ALL_VERBS)

function matchClearAll(text) {
  const t = String(text || '')
  if (!t) return false
  return CLEAR_ALL_PAT_A.test(t) || CLEAR_ALL_PAT_B.test(t)
}

module.exports = { detect, apply, splitCommands, extractEmbedded, scopeText, matchClearAll }"""

HOOK_OLD = """    // 兼容路径：非语音调用按纯内容追加（当前仅语音路径会调用本函数）
    if (!fromVoice) {
      this._setContent(this.appendText(trimmed))
      return
    }"""
HOOK_NEW = HOOK_OLD + """

    // [voice-clearall-v1] 语音清空全部指令：命中 → 清空输入框（旧内容进撤销条，5 秒）
    if (this.tryClearAll(trimmed)) return"""

METHODS_OLD = """  /**
   * 核心处理（语音输入入口；底栏已无键盘快捷输入，文字均在正文编辑框直接输入）："""
METHODS_NEW = """  // ===== [voice-clearall-v1] 语音「清空全部」指令（2026-09-24 用户需求）=====
  // 命中清空规则 → 清空输入框全部内容；毁灭性操作，旧正文存撤销条 5 秒内可一键恢复。
  // 指令文本本身不写入正文（其余处理全部跳过）；正文本就为空时只吞掉指令不弹撤销条
  tryClearAll(text) {
    if (!aiEdit.matchClearAll(text)) return false
    const prev = this.data.content || ''
    if (prev) {
      this._clearAllUndo = prev
      if (this._clearAllTimer) clearTimeout(this._clearAllTimer)
      this.setData({ clearAllUndo: true })
      this._clearAllTimer = setTimeout(() => {
        this._clearAllUndo = ''
        this.setData({ clearAllUndo: false })
      }, 5000)
    }
    this._setContent('')
    return true
  },

  // 撤销条点击：恢复清空前的正文
  onClearAllUndo() {
    if (this._clearAllTimer) {
      clearTimeout(this._clearAllTimer)
      this._clearAllTimer = null
    }
    const prev = this._clearAllUndo || ''
    this._clearAllUndo = ''
    this.setData({ clearAllUndo: false })
    if (prev) {
      this._setContent(prev)
      wx.showToast({ title: '已恢复原内容', icon: 'none', duration: 1500 })
    }
  },

  /**
   * 核心处理（语音输入入口；底栏已无键盘快捷输入，文字均在正文编辑框直接输入）："""

UNLOAD_OLD = """  onUnload() {
    this.saveDraft()"""
UNLOAD_NEW = """  onUnload() {
    this.saveDraft()
    // [voice-clearall-v1] 清空撤销条定时器随页面销毁清理
    if (this._clearAllTimer) clearTimeout(this._clearAllTimer)"""

WXML_OLD = """    <!-- ===== 底部输入栏（微信同款）===== -->
    <view class="input-bar-wrap">"""
WXML_NEW = WXML_OLD + """
      <!-- [voice-clearall-v1] 语音清空全部后的撤销条：5 秒内点击可恢复，超时自动消失 -->
      <view class="clear-undo-bar" wx:if="{{clearAllUndo}}" bindtap="onClearAllUndo">
        <text class="clear-undo-text">已清空全部内容</text>
        <text class="clear-undo-btn">撤销</text>
      </view>"""

WXSS_OLD = """.input-bar-wrap {
  flex-shrink: 0;
  z-index: 20;
}"""
WXSS_NEW = WXSS_OLD + """

/* [voice-clearall-v1] 撤销条：绝对定位浮在底部固定区上方，不挤压任何布局 */
.clear-undo-bar {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 20rpx;
  display: flex;
  align-items: center;
  padding: 14rpx 28rpx;
  background: var(--surface-frost);
  border: 1rpx solid var(--line);
  border-radius: 40rpx;
  box-shadow: 0 4rpx 16rpx var(--brand-tint-25);
}

.clear-undo-text {
  font-size: 26rpx;
  color: var(--ink-mid);
}

.clear-undo-btn {
  margin-left: 20rpx;
  font-size: 26rpx;
  font-weight: 600;
  color: var(--brand);
}"""

OPS = [
    ('utils/aiEdit.js', AIEDIT_OLD, AIEDIT_NEW, 'function matchClearAll('),
    ('pages/write/write.js', HOOK_OLD, HOOK_NEW, 'this.tryClearAll(trimmed)'),
    ('pages/write/write.js', METHODS_OLD, METHODS_NEW, 'tryClearAll(text) {'),
    ('pages/write/write.js', UNLOAD_OLD, UNLOAD_NEW, "this.saveDraft()\n    if (this._clearAllTimer) clearTimeout(this._clearAllTimer)"),
    ('pages/write/write.wxml', WXML_OLD, WXML_NEW, 'class="clear-undo-bar"'),
    ('pages/write/write.wxss', WXSS_OLD, WXSS_NEW, '.clear-undo-bar {'),
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    return raw.replace('\r\n', '\n'), nl


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    files = sorted(set(op[0] for op in OPS))
    if mode == '--write':
        if os.path.isdir(BACKUP):
            print('backup exists, skip auto-backup (幂等)')
        else:
            os.makedirs(BACKUP)
            for rel in files:
                src = os.path.join(ROOT, rel)
                dst = os.path.join(BACKUP, rel.replace('/', '_'))
                open(dst, 'wb').write(open(src, 'rb').read())
            print('auto-backup -> ' + BACKUP)
    ok_all = True
    for rel in files:
        text, nl = load(rel)
        ops = [op for op in OPS if op[0] == rel]
        new_text = text
        for i, (rel_, old, new, guard) in enumerate(ops):
            a, b = (old, new) if mode != '--restore' else (new, old)
            cnt = new_text.count(a)
            gcnt = new_text.count(guard) if guard else 0
            if mode != '--restore' and guard and gcnt > 0:
                print('%-42s op%d SKIP(幂等)' % (rel, i))
            elif cnt == 1:
                new_text = new_text.replace(a, b, 1)
                print('%-42s op%d APPLIED' % (rel, i))
            elif guard and gcnt > 0:
                print('%-42s op%d SKIP(幂等)' % (rel, i))
            else:
                print('%-42s op%d FAIL 锚点命中 %d 次' % (rel, i, cnt))
                ok_all = False
        if mode in ('--write', '--restore') and new_text != text:
            out = new_text.replace('\n', nl)
            open(os.path.join(ROOT, rel), 'wb').write(out.encode('utf-8'))
    print('==== %s: %s ====' % (mode, 'OK' if ok_all else 'HAS FAIL'))
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
