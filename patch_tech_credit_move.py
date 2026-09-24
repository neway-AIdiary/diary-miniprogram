# -*- coding: utf-8 -*-
"""
[tech-credit-move v1] 技术支持说明从首页移至设置页（2026-09-24，用户指令）

用户指令：
① 去掉首页（write）底栏上方的「一灯记 由DeepSeek、火山引擎、腾讯云提供技术支持」
   文案及其前面的图标；
② 该文案放到设置页（profile）页脚最下边，文案前放羽毛笔图标。

改动：
- pages/write/write.wxml：删除 .tech-credit 区块（注释标记占位）
- pages/write/write.wxss：删除三段样式（注释标记占位）
- pages/profile/profile.wxml：footer 最下边加技术支持行（ri-quill-pen-line 羽毛笔前置，
  文案仍绑 {{appName}}，品牌不硬编码）
- pages/profile/profile.wxss：新增 .tech-credit 三段样式（居中、弱化小字）
- tools/test_about_info.js：断言改判——首页不再有该元素；设置页有文案 + 图标前置

⚠️ 注释与占位标记一律不含「tech-credit」字样（新断言以 write.wxml 无该类名为判据，坑 7）

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\tech-credit-move-backup-20260924'

OPS = [
    # ---- pages/write/write.wxml：删除说明区块 ----
    ('pages/write/write.wxml',
     r'''  <!-- 技术支持说明：固定在左下角，属背景层（z-index 低），可被正文卡片/工具行压盖；
       底部偏移 = 固定输入栏高度(114rpx) + 安全区 + 22rpx 间隙（含上移半行 12rpx），
       故写在行内用 safeAreaBottom -->
  <view class="tech-credit" style="bottom: calc(136rpx + {{safeAreaBottom}}px);">
    <image class="tech-credit-icon" src="/images/tech-support-brain.png" mode="aspectFit" />
    <text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>
  </view>''',
     r'''  <!-- 说明行已移至设置页页脚（2026-09-24） -->''',
     '说明行已移至设置页页脚'),
    # ---- pages/write/write.wxss：删除三段样式 ----
    ('pages/write/write.wxss',
     r'''/* ===== 技术支持说明（左下角背景层）=====
   固定定位在固定输入栏上方；z-index 低于正文卡片/工具行，可被其压盖；
   pointer-events: none 保证不拦截滚动与点击（纯装饰）。
   底部偏移在 wxml 行内计算（输入栏高度 + safeAreaBottom） */
.tech-credit {
  position: fixed;
  left: 24rpx;
  /* 必须低于 .content-scroll 的 z-index:1，保证正文卡片/工具行能压盖说明文字；
     0 仍高于 .page 背景，故文字正常可见 */
  z-index: 0;
  display: flex;
  align-items: center;
  gap: 8rpx;
  pointer-events: none;
}

.tech-credit-icon {
  width: 26rpx;
  height: 26rpx;
  flex-shrink: 0;
  opacity: 0.5;
}

.tech-credit-text {
  font-size: 20rpx;
  line-height: 1.2;
  color: var(--ink-faint);
  letter-spacing: 0.5rpx;
  white-space: nowrap;
}''',
     r'''/* 说明行样式已随迁设置页（2026-09-24，tech-credit-move v1） */''',
     '说明行样式已随迁设置页'),
    # ---- pages/profile/profile.wxml：页脚最下边加技术支持行 ----
    ('pages/profile/profile.wxml',
     r'''  <!-- 底部信息 -->
  <view class="footer">
    <view class="footer-text">{{appName}} v1.0</view>
    <view class="footer-sub">数据默认只存本机；开启备份后仅上传 AES 加密密文</view>
  </view>''',
     r'''  <!-- 底部信息 -->
  <view class="footer">
    <view class="footer-text">{{appName}} v1.0</view>
    <view class="footer-sub">数据默认只存本机；开启备份后仅上传 AES 加密密文</view>
    <!-- 技术支持说明（2026-09-24 自首页左下角移入）：羽毛笔图标前置 -->
    <view class="tech-credit">
      <text class="tech-credit-icon ri ri-quill-pen-line"></text>
      <text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>
    </view>
  </view>''',
     'tech-credit-icon ri ri-quill-pen-line'),
    # ---- pages/profile/profile.wxss：新增三段样式 ----
    ('pages/profile/profile.wxss',
     r'''.footer-sub {
  font-size: 22rpx;
  color: var(--ink-faint);
  margin-top: 10rpx;
}''',
     r'''.footer-sub {
  font-size: 22rpx;
  color: var(--ink-faint);
  margin-top: 10rpx;
}

/* 技术支持说明（2026-09-24 自首页左下角移入）：羽毛笔图标 + 弱化小字，页脚内居中 */
.tech-credit {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6rpx;
  margin-top: 16rpx;
}

.tech-credit-icon {
  font-size: 22rpx;
  color: var(--ink-faint);
  opacity: 0.7;
}

.tech-credit-text {
  font-size: 20rpx;
  line-height: 1.2;
  color: var(--ink-faint);
  letter-spacing: 0.5rpx;
}''',
     '页脚内居中'),
    # ---- tools/test_about_info.js：断言改判 ----
    ('tools/test_about_info.js',
     r'''ok('write.wxml 技术支持行绑定 {{appName}}（3.A 收敛，不再硬编码）',
  writeWxml.indexOf('<text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>') !== -1)''',
     r'''ok('技术支持行已移出首页（write.wxml 不再有该元素）[tech-credit-move v1]',
  writeWxml.indexOf('tech-credit') === -1)
ok('设置页页脚技术支持行绑定 {{appName}}（品牌不硬编码）[tech-credit-move v1]',
  read('pages/profile/profile.wxml').indexOf('<text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>') !== -1)
ok('设置页技术支持行羽毛笔图标前置 [tech-credit-move v1]',
  read('pages/profile/profile.wxml').indexOf('tech-credit-icon ri ri-quill-pen-line') !== -1)''',
     'tech-credit-move v1'),
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
            # guard 优先：追加型 op 的锚点在写入后依然存在（坑 #6 变体），
            # guard 均取 new 独有串，命中即已应用；--restore 模式不适用（盘上必有 guard）。
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
