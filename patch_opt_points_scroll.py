# -*- coding: utf-8 -*-
"""
[opt-points-scroll v2] AI优化「要点框」安卓半行裁切修复第二步（2026-09-24）

第一步（234rpx 静态行栅格预算）在安卓真机仍露半行：静态预算依赖
「每行真实渲染高度 == 46rpx」的假设，安卓 WebView 字体度量/取整会让
实际行高偏离预算。第二步改为运行时实测，不再赌任何静态数值：

- wxml：要点卡片内加「探针节点」（继承要点正文同款字体/行高，绝对定位不可见）；
  要点遍历挪进无内边距的内层滚动区 .opt-points-scroll，
  其高度上限走内联 style 绑定实测 px（optPointsScrollH）
- wxss：外层卡片不再裁切（只留 position:relative 作探针定位基准）；
  内层滚动区 overflow-y:auto + 184rpx 静态兜底（仅测量未完成的首帧）
- write.js：measureOptPoints() 渲染后实测探针一行高度 × 4（Math.floor）
  写入 optPointsScrollH；四个要点展示入口（主润色 / 统一兜底 /
  素材补全 / 补全失败兜底）setData 回调统一挂测量

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\opt-points-scroll-backup-20260924'

OPS = [
    # ---- pages/write/write.wxml ----
    ('pages/write/write.wxml',
     r'''        <view class="opt-points-title">优化要点</view>
        <view class="opt-point" wx:for="{{optimizeChanges}}" wx:key="*this">• {{item}}</view>''',
     r'''        <view class="opt-points-title">优化要点</view>
        <view class="opt-point opt-point-probe" aria-hidden="true">行</view>
        <view class="opt-points-scroll" style="{{optPointsScrollH ? 'max-height:' + optPointsScrollH + 'px' : ''}}">
          <view class="opt-point" wx:for="{{optimizeChanges}}" wx:key="*this">• {{item}}</view>
        </view>''',
     'class="opt-point opt-point-probe"'),
    # ---- pages/write/write.wxss ----
    ('pages/write/write.wxss',
     r'''  flex-shrink: 0;
  /* 要点条目多时内部滚动，避免挤压下方文本框；
     高度钉在行栅格上（标题 36 + 间距 14 + 正文恰好 4 行 × 46 = 234），
     行高全部显式 rpx ⇒ 任何机型都整行裁切，不会露出半行（Android 半行裁切修复） */
  max-height: 234rpx;
  overflow-y: auto;
}''',
     r'''  flex-shrink: 0;
  position: relative;
}

/* 要点滚动区：这一层没有内边距 ⇒ 裁切口径不受盒模型影响；
   实际上限由 JS 渲染后实测一行真实高度 × 4 以 px 内联写入（见 measureOptPoints），
   机型行高差异被实测值自动吸收；下方静态值仅作测量未完成首帧的兜底 */
.opt-point-probe {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  pointer-events: none;
}

.opt-points-scroll {
  overflow-y: auto;
  max-height: 184rpx;
}''',
     '.opt-point-probe {'),
    # ---- pages/write/write.js：data ----
    ('pages/write/write.js',
     r'''    optimizedContent: '',
    optimizeChanges: [],
    showOriginal: false,''',
     r'''    optimizedContent: '',
    optimizeChanges: [],
    optPointsScrollH: 0,   // [opt-points-scroll v2] 要点滚动区实测高度（px = 一行实测高 × 4）
    showOriginal: false,''',
     '    optPointsScrollH: 0,'),
    # ---- pages/write/write.js：实测方法 ----
    ('pages/write/write.js',
     r'''  onOptimizedInput(e) {''',
     r'''  // [opt-points-scroll v2] 要点框半行裁切修复：不同机型的真实行高与静态 rpx 预算
  // 有偏差（Android 字体度量/取整差异），改为渲染后用探针节点实测一行高度，
  // 把滚动区上限以 px 钉在恰好 4 行（探针继承要点正文同款字体与行高）
  measureOptPoints() {
    const query = wx.createSelectorQuery().in(this)
    query.select('.opt-point-probe').boundingClientRect()
    query.exec((res) => {
      const rect = res && res[0]
      if (!rect || !(rect.height > 0)) return
      const h = Math.floor(rect.height * 4)
      if (h > 0 && h !== this.data.optPointsScrollH) {
        this.setData({ optPointsScrollH: h })
      }
    })
  },

  onOptimizedInput(e) {''',
     'measureOptPoints() {'),
    # ---- write.js：四个展示入口挂测量回调 ----
    ('pages/write/write.js',
     r'''          .concat(opts.extraNotes || []),
        showOriginal: false
      })''',
     r'''          .concat(opts.extraNotes || []),
        showOriginal: false
      }, () => this.measureOptPoints())''',
     '.concat(opts.extraNotes || []),\n        showOriginal: false\n      }, () => this.measureOptPoints())'),
    ('pages/write/write.js',
     r'''      optimizeChanges: (this._localEditNotes || []).concat(opts.notes || []),
      showOriginal: false
    })''',
     r'''      optimizeChanges: (this._localEditNotes || []).concat(opts.notes || []),
      showOriginal: false
    }, () => this.measureOptPoints())''',
     'concat(opts.notes || []),\n      showOriginal: false\n    }, () => this.measureOptPoints())'),
    ('pages/write/write.js',
     r'''        optimizeChanges: notes.concat(note ? [note] : []),
        showOriginal: false
      })''',
     r'''        optimizeChanges: notes.concat(note ? [note] : []),
        showOriginal: false
      }, () => this.measureOptPoints())''',
     'notes.concat(note ? [note] : []),\n        showOriginal: false\n      }, () => this.measureOptPoints())'),
    ('pages/write/write.js',
     r'''            optimizeChanges: notes.concat([note + '；已展示现有文字，可直接编辑']),
            showOriginal: false
          })''',
     r'''            optimizeChanges: notes.concat([note + '；已展示现有文字，可直接编辑']),
            showOriginal: false
          }, () => this.measureOptPoints())''',
     "已展示现有文字，可直接编辑']),\n            showOriginal: false\n          }, () => this.measureOptPoints())"),
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
            # guard 优先：追加型 op 的锚点在写入后依然存在（锚点行未被替换），
            # 若先判锚点会恒 APPLIED ⇒ 二次 --write 重复注入（坑 #6 变体）。
            # guard 均取 new 独有串，命中即已应用；--restore 模式不适用（盘上必有 guard）。
            if mode != '--restore' and guard and gcnt > 0:
                print('%-30s op%d SKIP(幂等)' % (rel, i))
            elif cnt == 1:
                new_text = new_text.replace(a, b, 1)
                print('%-30s op%d APPLIED' % (rel, i))
            elif guard and gcnt > 0:
                print('%-30s op%d SKIP(幂等)' % (rel, i))
            else:
                print('%-30s op%d FAIL 锚点命中 %d 次' % (rel, i, cnt))
                ok_all = False
        if mode in ('--write', '--restore') and new_text != text:
            out = new_text.replace('\n', nl)
            open(os.path.join(ROOT, rel), 'wb').write(out.encode('utf-8'))
    print('==== %s: %s ====' % (mode, 'OK' if ok_all else 'HAS FAIL'))
    sys.exit(0 if ok_all else 1)


if __name__ == '__main__':
    main()
