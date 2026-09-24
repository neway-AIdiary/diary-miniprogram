# -*- coding: utf-8 -*-
"""
[setting-credit v1] 技术支持说明改放**真正的设置页**（2026-09-24，用户侧 bug 修正）

背景（上一轮改错页）：
  用户指令「把首页底栏上边的说明文案移到设置页最下边」。
  上一轮（tech-credit-move v1）把它放进了 pages/profile（= 我的页面），
  但项目里 pages/setting/setting 才是用户口中的「设置页」——
  铁证：write.js:1294 的「设置」入口 = wx.navigateTo('/pages/setting/setting')；
        tools/test_guide.js A-10 断言 '跨页目标 = 设置页' 指向 SETTING_URL = '/pages/setting/setting?guide=1'。
  故用户进设置页看不到文案，误判为「改了不生效」。

本次改动：
- pages/profile/profile.wxml：撤掉技术支持行与临时构建标记（该页恢复原样，注释占位）
- pages/profile/profile.wxss：撤掉对应样式（注释占位）
- pages/setting/setting.wxml：页脚（.page 内、guide-mask 之前）加技术支持行 + 临时构建标记
- pages/setting/setting.wxss：新增页脚样式（与我的页同款口径：20rpx / ink-faint / 字距 0.5rpx）
- pages/setting/setting.js：data 注入 appName（品牌不硬编码，来源 utils/appInfo.js）
- pages/write/write.js：弹窗处补「弹窗实体」清单日志，与既有「闸门已否决」成对，
  供真机核对代码版本（判定备案问题是否来自这份代码）
- tools/test_about_info.js：断言改判到 setting 页，并新增「我的页不再有该行」

⚠️ 注释与占位标记一律不含 tech-credit 字样（断言以 profile.wxml 无该类名为判据，坑 7）
⚠️ guard 串逐字抄自 new 文本（坑 9）

用法：--check / --write / --restore
"""
import sys, os

ROOT = r'C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work'
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\setting-credit-backup-20260924'

OPS = [
    # ---- 1. pages/profile/profile.wxml：撤掉技术支持行 + 临时标记 ----
    ('pages/profile/profile.wxml',
     r'''    <view class="footer-sub">数据默认只存本机；开启备份后仅上传 AES 加密密文</view>
    <!-- 技术支持说明（2026-09-24 自首页左下角移入）：羽毛笔图标前置 -->
    <view class="tech-credit">
      <text class="tech-credit-icon ri ri-quill-pen-line"></text>
      <text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>
    </view>
    <!-- 临时构建标记（版本排查用，定位后移除） -->
    <view class="footer-build">build 0924c</view>
  </view>''',
     r'''    <view class="footer-sub">数据默认只存本机；开启备份后仅上传 AES 加密密文</view>
    <!-- 说明行已改放设置页页脚（2026-09-24，setting-credit v1） -->
  </view>''',
     '说明行已改放设置页页脚'),
    # ---- 2. pages/profile/profile.wxss：撤掉对应样式 ----
    ('pages/profile/profile.wxss',
     r'''/* 技术支持说明（2026-09-24 自首页左下角移入）：羽毛笔图标 + 弱化小字，页脚内居中 */
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
}

/* 临时构建标记（版本排查用，定位后移除） */
.footer-build {
  margin-top: 12rpx;
  font-size: 20rpx;
  color: var(--ink-faint);
  opacity: 0.6;
}''',
     r'''/* 说明行与临时标记样式已改放设置页（2026-09-24，setting-credit v1） */''',
     '说明行与临时标记样式已改放设置页'),
    # ---- 3. pages/setting/setting.wxml：页脚加技术支持行 ----
    ('pages/setting/setting.wxml',
     r'''  <!-- 新手引导遮罩：第 5 步（主题）在本页续接（从写日记页「去设置」跨页过来）；''',
     r'''  <!-- 页脚（2026-09-24）：技术支持说明自首页左下角移入；含临时构建标记 -->
  <view class="page-foot">
    <view class="tech-credit">
      <text class="tech-credit-icon ri ri-quill-pen-line"></text>
      <text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>
    </view>
    <!-- 临时构建标记（版本排查用，定位后移除） -->
    <view class="footer-build">build 0924d</view>
  </view>

  <!-- 新手引导遮罩：第 5 步（主题）在本页续接（从写日记页「去设置」跨页过来）；''',
     'class="page-foot"'),
    # ---- 4. pages/setting/setting.wxss：新增页脚样式 ----
    ('pages/setting/setting.wxss',
     r'''/* 清除所有日记：垃圾桶图标警示红（文字与普通菜单一致） */
.menu-icon.danger {
  color: var(--danger);
}''',
     r'''/* 清除所有日记：垃圾桶图标警示红（文字与普通菜单一致） */
.menu-icon.danger {
  color: var(--danger);
}

/* ===== 页脚（2026-09-24，setting-credit v1）=====
   技术支持说明自首页左下角移入：羽毛笔图标 + 弱化小字，页脚内居中；
   与「我的」页页脚同款口径（20rpx / ink-faint / 字距 0.5rpx） */
.page-foot {
  margin-top: 48rpx;
  text-align: center;
}

.tech-credit {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6rpx;
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
}

/* 临时构建标记（版本排查用，定位后移除） */
.footer-build {
  margin-top: 12rpx;
  font-size: 20rpx;
  color: var(--ink-faint);
  opacity: 0.6;
}''',
     'setting-credit v1）====='),
    # ---- 5a. pages/setting/setting.js：引 appInfo ----
    ('pages/setting/setting.js',
     r'''const theme = require('../../utils/theme.js')''',
     r'''const theme = require('../../utils/theme.js')
const appInfo = require('../../utils/appInfo.js')''',
     "const appInfo = require('../../utils/appInfo.js')"),
    # ---- 5b. pages/setting/setting.js：data 注入 appName ----
    ('pages/setting/setting.js',
     r'''  data: {
    themeMode: 'light',''',
     r'''  data: {
    appName: appInfo.APP_NAME,
    themeMode: 'light',''',
     'appName: appInfo.APP_NAME,'),
    # ---- 6. pages/write/write.js：弹窗实体清单日志 ----
    ('pages/write/write.js',
     r'''      // 已备案的名词：不再弹窗提醒存档（避免重复打扰）
      const promptEntities = all.filter(e => !e.exists)''',
     r'''      // 已备案的名词：不再弹窗提醒存档（避免重复打扰）
      const promptEntities = all.filter(e => !e.exists)
      // [entity-gate3-v1] 弹窗清单日志：与上面「闸门已否决」成对，供真机核对代码版本
      if (promptEntities.length > 0) console.log('[entity-gate ' + GATE_VER + '] 弹窗实体:', promptEntities.map(e => e.name).join('、'))''',
     '] 弹窗实体:'),
    # ---- 7. tools/test_about_info.js：断言改判到设置页 ----
    ('tools/test_about_info.js',
     r'''ok('设置页页脚技术支持行绑定 {{appName}}（品牌不硬编码）[tech-credit-move v1]',
  read('pages/profile/profile.wxml').indexOf('<text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>') !== -1)
ok('设置页技术支持行羽毛笔图标前置 [tech-credit-move v1]',
  read('pages/profile/profile.wxml').indexOf('tech-credit-icon ri ri-quill-pen-line') !== -1)''',
     r'''ok('设置页页脚技术支持行绑定 {{appName}}（品牌不硬编码）[setting-credit v1]',
  read('pages/setting/setting.wxml').indexOf('<text class="tech-credit-text">{{appName}} 由DeepSeek、火山引擎、腾讯云提供技术支持</text>') !== -1)
ok('设置页技术支持行羽毛笔图标前置 [setting-credit v1]',
  read('pages/setting/setting.wxml').indexOf('tech-credit-icon ri ri-quill-pen-line') !== -1)
ok('我的页不再有技术支持行（唯一位于设置页）[setting-credit v1]',
  read('pages/profile/profile.wxml').indexOf('tech-credit') === -1)''',
     '我的页不再有技术支持行'),
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
