# -*- coding: utf-8 -*-
"""
[voice-scroll v1] 智能总结页录音弹窗：识别文本更新时自动滚到底部
用户反馈：说话多了，弹窗不滚动显示后边几行的内容（scroll-view 无自动滚动机制）。

ops:
  A. summary.wxml  弹窗 scroll-view 绑定 scroll-top="{{voiceScrollTop}}"
  B. summary.js    data 增加 voiceScrollTop: 0
  C. summary.js    onStateChange 的 setData 加回调：量 .voice-text 与 .voice-text-scroll
                   高度差，差值变大才 setData（内容单调变长 => 差值单调增 => 每出新行滚一次）

用法：
  python patch_summary_voicescroll.py --check        # 校验锚点与幂等
  python patch_summary_voicescroll.py --write        # 备份 + 应用
  python patch_summary_voicescroll.py --restore-src  # 从备份还原源码
"""
import os
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\summary-voicescroll-backup-20260924'

REL_WXML = 'pages/summary/summary.wxml'
REL_JS = 'pages/summary/summary.js'

WXML_OLD = '<scroll-view class="voice-text-scroll" scroll-y enhanced show-scrollbar="{{false}}">'
WXML_NEW = '<scroll-view class="voice-text-scroll" scroll-y enhanced show-scrollbar="{{false}}" scroll-top="{{voiceScrollTop}}">'
WXML_GUARD = 'scroll-top="{{voiceScrollTop}}"'

JS_DATA_OLD = "    liveText: ''\n  },"
JS_DATA_NEW = "    liveText: '',\n    voiceScrollTop: 0\n  },"
JS_DATA_GUARD = 'voiceScrollTop: 0'

JS_CB_OLD = "        liveText: s.liveText || ''\n      })\n    })"
JS_CB_NEW = (
    "        liveText: s.liveText || ''\n"
    "      }, () => {\n"
    "        // [voice-scroll v1] 说话多了自动滚到底：文本高于视口时把 scroll-top 推到底部\n"
    "        //（内容单调变长 => 高度差单调增 => 每出新行都会触发一次滚动；文本未变则不 setData）\n"
    "        if (!s.liveText || !wx.createSelectorQuery) return\n"
    "        const q = wx.createSelectorQuery()\n"
    "        q.select('.voice-text').boundingClientRect()\n"
    "        q.select('.voice-text-scroll').boundingClientRect()\n"
    "        q.exec((res) => {\n"
    "          const txt = res && res[0]\n"
    "          const box = res && res[1]\n"
    "          if (!txt || !box || txt.height <= box.height) return\n"
    "          const top = Math.ceil(txt.height - box.height)\n"
    "          if (top > (this.data.voiceScrollTop || 0)) this.setData({ voiceScrollTop: top })\n"
    "        })\n"
    "      })\n"
    "    })"
)
JS_CB_GUARD = '[voice-scroll v1]'

# (rel_path, [ (op_name, old, new, guard) ])
OPS = [
    (REL_WXML, [('A.wxml scroll-top 绑定', WXML_OLD, WXML_NEW, WXML_GUARD)]),
    (REL_JS, [
        ('B.js data 声明', JS_DATA_OLD, JS_DATA_NEW, JS_DATA_GUARD),
        ('C.js 更新回调推底', JS_CB_OLD, JS_CB_NEW, JS_CB_GUARD),
    ]),
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return raw, (raw.replace('\r\n', '\n') if crlf else raw), crlf


def save(rel, text_lf, crlf):
    data = text_lf.replace('\n', '\r\n') if crlf else text_lf
    open(os.path.join(ROOT, rel), 'wb').write(data.encode('utf-8'))


def iter_ops(only=None):
    for rel, ops in OPS:
        for op in ops:
            if only is None or op[0] == only:
                yield rel, op


def do_check():
    ok = True
    for rel, (name, old, new, guard) in iter_ops():
        _, t, _ = load(rel)
        n_old = t.count(old)
        n_guard = t.count(guard)
        if n_guard >= 1 and n_old == 0:
            print('SKIP {}（guard 已存在，判定已应用）'.format(name))
        elif n_old == 1:
            print('OK   {}（锚点命中 1 次）'.format(name))
        elif n_old == 0:
            print('FAIL {}：锚点 0 命中且 guard 不存在'.format(name))
            ok = False
        else:
            print('FAIL {}：锚点命中 {} 次（应唯一）'.format(name, n_old))
            ok = False
    print('CHECK {}'.format('PASS' if ok else 'FAIL'))
    return 0 if ok else 1


def do_write():
    # 备份（幂等：已存在即早退，防二次 --write 覆盖干净备份）
    if os.path.isdir(BACKUP):
        print('BACKUP 已存在，跳过：' + BACKUP)
    else:
        os.makedirs(BACKUP)
        for rel, _ops in OPS:
            dst = os.path.join(BACKUP, rel.replace('/', os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(ROOT, rel), dst)
        print('BACKUP 完成：' + BACKUP)

    # 逐文件应用（每文件只 load 一次；op 顺序应用，同一文件串行）
    for rel, ops in OPS:
        raw, t, crlf = load(rel)
        for name, old, new, guard in ops:
            n_old = t.count(old)
            n_guard = t.count(guard)
            if n_guard >= 1 and n_old == 0:
                print('SKIP {}（已应用）'.format(name))
                continue
            if n_old != 1:
                print('ABORT {}：锚点命中 {} 次'.format(name, n_old))
                return 1
            t = t.replace(old, new)
            print('APPLY {} ok'.format(name))
        save(rel, t, crlf)
        # 落盘后立即重读复核
        _, t2, _ = load(rel)
        for name, old, new, guard in ops:
            if t2.count(guard) < 1:
                print('VERIFY FAIL {}：guard 未落盘'.format(name))
                return 1
        print('VERIFY {} 落盘确认'.format(rel))
    print('WRITE PASS')
    return 0


def do_restore():
    if not os.path.isdir(BACKUP):
        print('备份不存在，无法还原：' + BACKUP)
        return 1
    for rel, _ops in OPS:
        src = os.path.join(BACKUP, rel.replace('/', os.sep))
        shutil.copy2(src, os.path.join(ROOT, rel))
        print('RESTORE ' + rel)
    print('RESTORE PASS')
    return 0


def main():
    if '--write' in sys.argv:
        return do_write()
    if '--restore-src' in sys.argv:
        return do_restore()
    return do_check()


if __name__ == '__main__':
    sys.exit(main())
