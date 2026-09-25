# -*- coding: utf-8 -*-
"""
[mood-capsule v1] detail 编辑态心情栏并入标题行 —— 补丁（3 文件 8 ops，含 v1.1 对齐/收紧 3 ops）
用户指令（2026-09-25）：编辑态（详情页 + 总结结果页编辑入口，同为本页）取消标题下方心情栏；
标题右侧贴右显示心情胶囊（与写字页同款）；标题输入区排除胶囊区域，长标题不冲突。
拍板：全库仅 detail 一处横向心情栏（write 页是胶囊+浮层形态，不算）；选项组内联展开（方案①）。
用法（必须在工程根跑）：
  python patch_mood_capsule.py --check        # 只验锚点与幂等判据，不改文件
  python patch_mood_capsule.py --write        # 备份 + 落盘（备份已存在则早退，幂等）
  python patch_mood_capsule.py --restore-src  # 从备份还原 3 个被改文件（红灯自检用，
                                              # 测试文件不在本脚本范围，不会被还原）
输出同时写会话目录 patch_moodcapsule_out.txt。
"""
import os
import shutil
import sys

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP_DIR = r"C:\Users\ThinkPad\WorkBuddy\mood-capsule-backup-20260925"
LOG_PATH = r"C:\Users\ThinkPad\WorkBuddy\2026-09-15-09-30-50\patch_moodcapsule_out.txt"

FILES = [
    "pages/detail/detail.wxml",
    "pages/detail/detail.wxss",
    "pages/detail/detail.js",
]

# wxml：标题区 + 心情栏整块 → 标题行（input + 心情胶囊）+ 保留的选项组
WXML_OLD = """        <!-- 标题区：固定在上，不随编辑区滚动 -->
        <view class="section section-title">
          <input
            class="input-field edit-title-input"
            value="{{title}}"
            bindinput="onTitleInput"
            maxlength="50"
            placeholder="标题"
            adjust-position="{{false}}"
            cursor-spacing="20"
          />
        </view>

        <!-- 心情选择：固定在上，不随编辑区滚动 -->
        <view class="section section-mood">
          <view class="mood-bar" bindtap="toggleMoodPicker" hover-class="mood-bar-hover">
            <text class="mood-label">心情</text>
            <text class="mood-value {{moodLabel ? '' : 'placeholder'}}">{{moodLabel || '可选，点击选择'}}</text>
            <text class="mood-arrow ri ri-arrow-right-s-line"></text>
          </view>
          <view class="mood-options" wx:if="{{showMoodPicker}}">
            <view
              class="mood-option {{mood === '' ? 'active' : ''}}"
              data-key="none"
              bindtap="selectMood"
            >不选</view>
            <view
              class="mood-option {{mood === item.key ? 'active' : ''}}"
              wx:for="{{moodOptions}}"
              wx:key="key"
              data-key="{{item.key}}"
              bindtap="selectMood"
            >{{item.label}}</view>
          </view>
        </view>"""

WXML_NEW = """        <!-- 标题区：固定在上，不随编辑区滚动；右侧心情胶囊与写字页同款 [mood-capsule v1] -->
        <view class="section section-title">
          <view class="title-row">
            <input
              class="input-field edit-title-input"
              value="{{title}}"
              bindinput="onTitleInput"
              maxlength="50"
              placeholder="标题"
              adjust-position="{{false}}"
              cursor-spacing="20"
            />
            <view class="mood-pill" style="color:{{moodColor || '#999999'}};background:{{moodBg || 'rgba(0,0,0,0.06)'}};" catchtap="toggleMoodPicker">
              <text>{{moodLabel ? moodLabel : '心情'}}</text>
            </view>
          </view>
          <view class="mood-options" wx:if="{{showMoodPicker}}">
            <view
              class="mood-option {{mood === '' ? 'active' : ''}}"
              data-key="none"
              bindtap="selectMood"
            >不选</view>
            <view
              class="mood-option {{mood === item.key ? 'active' : ''}}"
              wx:for="{{moodOptions}}"
              wx:key="key"
              data-key="{{item.key}}"
              bindtap="selectMood"
            >{{item.label}}</view>
          </view>
        </view>"""

# wxss：标题/心情区共用块 + 心情栏样式 → 标题区 + 标题行 + 心情胶囊（保留 mood-options/option）
WXSS_OLD = """/* 标题区 / 心情区：固定在上，底部加详情页同款分隔线，三块（标题/心情/正文）区隔 */
.section-title,
.section-mood {
  flex-shrink: 0;
  border-bottom: 1rpx solid var(--line);
  padding-bottom: 20rpx;
}

/* 心情选择：上下留白减半 */
.mood-bar {
  background: var(--surface);
  border-radius: 16rpx;
  padding: 14rpx 28rpx;
  display: flex;
  align-items: center;
}

.mood-label {
  font-size: 28rpx;
  color: var(--ink);
  font-weight: 500;
  flex-shrink: 0;
}

.mood-value {
  flex: 1;
  font-size: 28rpx;
  margin-left: 24rpx;
  color: var(--ink);
}

.mood-value.placeholder {
  color: var(--ink-soft);
}

/* 心情行右侧可点击箭头 */
.mood-arrow {
  flex-shrink: 0;
  margin-left: 8rpx;
  font-size: 36rpx;
  line-height: 1;
  color: var(--ink-faint);
}

.mood-bar-hover {
  opacity: 0.7;
}"""

WXSS_NEW = """/* 标题区：固定在上，底部加详情页同款分隔线 [mood-capsule v1] 心情栏已并入标题行 */
.section-title {
  flex-shrink: 0;
  border-bottom: 1rpx solid var(--line);
  padding-bottom: 20rpx;
}

/* 标题行：标题输入占剩余宽度（min-width:0 防长标题把胶囊挤出），心情胶囊贴右 */
.title-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.title-row .edit-title-input {
  flex: 1;
  min-width: 0;
}

/* 心情胶囊：与写字页 write.wxss .mood-pill 同款（颜色/底色由 wxml 内联提供，无心情走灰底兜底） */
.mood-pill {
  display: flex;
  align-items: center;
  gap: 6rpx;
  padding: 10rpx 22rpx;
  border: 1rpx solid var(--line);
  border-radius: 30rpx;
  font-size: 24rpx;
  font-weight: 500;
  flex-shrink: 0;
}"""

# js op1：编辑载入补 moodColor/moodBg（追加型）
JS_LOAD_NEW = """        mood: diary.mood || '',
        moodLabel: util.getMoodLabel(diary.mood),
        moodColor: diary.mood ? util.getMoodColor(diary.mood) : '',
        moodBg: diary.mood ? util.getMoodBg(diary.mood) : '',"""

# js op2：selectMood 两分支补 moodColor/moodBg
JS_SELECT_OLD = """    if (key === 'none') {
      this.setData({ mood: '', moodLabel: '', showMoodPicker: false })
      return
    }
    this.setData({
      mood: key,
      moodLabel: util.MOOD_MAP[key].label,
      showMoodPicker: false
    })"""

JS_SELECT_NEW = """    if (key === 'none') {
      this.setData({ mood: '', moodLabel: '', moodColor: '', moodBg: '', showMoodPicker: false })
      return
    }
    this.setData({
      mood: key,
      moodLabel: util.MOOD_MAP[key].label,
      moodColor: util.getMoodColor(key),
      moodBg: util.getMoodBg(key),
      showMoodPicker: false
    })"""

# js op3：fixedRpx 下调（心情栏高度并入标题行后腾出）
JS_FIXED_OLD = """    // 正文滚动区最大高度：屏幕减去顶部安全区、标题/心情/按钮/输入栏等固定占用
    const fixedRpx = 380"""

JS_FIXED_NEW = """    // 正文滚动区最大高度：屏幕减去顶部安全区、标题/按钮/输入栏等固定占用
    // [mood-capsule v1] 心情栏并入标题行，固定占用减去原心情栏高度（380 → 290）
    const fixedRpx = 290"""

OPS = [
    ("pages/detail/detail.wxml", "w1 标题行+胶囊替换心情栏", WXML_OLD, WXML_NEW),
    ("pages/detail/detail.wxss", "w2 标题行/胶囊样式", WXSS_OLD, WXSS_NEW),
    ("pages/detail/detail.js", "j1 编辑载入补色值",
     "        mood: diary.mood || '',\n        moodLabel: util.getMoodLabel(diary.mood),",
     JS_LOAD_NEW),
    ("pages/detail/detail.js", "j2 selectMood 补色值", JS_SELECT_OLD, JS_SELECT_NEW),
    ("pages/detail/detail.js", "j3 fixedRpx 380→290", JS_FIXED_OLD, JS_FIXED_NEW),
    # ---- v1.1 追加（2026-09-25 用户反馈：胶囊与标题文字上下中心对齐；标题栏下横线上移） ----
    ("pages/detail/detail.wxss", "w4 输入高度收成贴文字行",
     """/* 标题行：标题输入占剩余宽度（min-width:0 防长标题把胶囊挤出），心情胶囊贴右 */
.title-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.title-row .edit-title-input {
  flex: 1;
  min-width: 0;
}""",
     """/* 标题行：标题输入占剩余宽度（min-width:0 防长标题把胶囊挤出），心情胶囊贴右；
   输入高度收成 60rpx 贴文字行，胶囊与文字上下中心对齐 [mood-capsule v1.1] */
.title-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.title-row .edit-title-input {
  flex: 1;
  min-width: 0;
  height: 60rpx;
  padding: 0;
}"""),
    ("pages/detail/detail.wxss", "w5 标题区分隔线上移",
     """.section-title {
  flex-shrink: 0;
  border-bottom: 1rpx solid var(--line);
  padding-bottom: 20rpx;
}""",
     """.section-title {
  flex-shrink: 0;
  border-bottom: 1rpx solid var(--line);
  padding-bottom: 12rpx;
}"""),
    ("pages/detail/detail.js", "j4 fixedRpx 290→260",
     """    // 正文滚动区最大高度：屏幕减去顶部安全区、标题/按钮/输入栏等固定占用
    // [mood-capsule v1] 心情栏并入标题行，固定占用减去原心情栏高度（380 → 290）
    const fixedRpx = 290""",
     """    // 正文滚动区最大高度：屏幕减去顶部安全区、标题/按钮/输入栏等固定占用
    // [mood-capsule v1.1] 心情栏并入标题行（-90）+ 标题行收紧跟文字（-30）⇒ 380 → 260
    const fixedRpx = 260"""),
]

LOG_LINES = []
def log(msg):
    print(msg)
    LOG_LINES.append(msg)

def load(rel):
    raw = open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    return raw, eol, raw.replace("\r\n", "\n")

def save(rel, text_norm, eol):
    if eol == "\r\n":
        text_norm = text_norm.replace("\n", "\r\n")
    with open(os.path.join(ROOT, rel), "wb") as f:
        f.write(text_norm.encode("utf-8"))

def do_check():
    ok = True
    for rel, name, old, new in OPS:
        _, _, text = load(rel)
        ca, cn = text.count(old), text.count(new)
        status = "OK" if (ca == 1 and cn == 0) else "FAIL"
        if status == "FAIL":
            ok = False
        log("[%s] %-24s anchor=%d new=%d" % (status, name, ca, cn))
    log("CHECK " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_backup():
    if os.path.isdir(BACKUP_DIR):
        log("备份已存在，早退（幂等）: " + BACKUP_DIR)
        return
    os.makedirs(BACKUP_DIR)
    for rel in FILES:
        shutil.copy2(os.path.join(ROOT, rel), os.path.join(BACKUP_DIR, rel.replace("/", "__")))
        log("backup: " + rel)

def do_write():
    do_backup()
    ok = True
    for rel, name, old, new in OPS:
        _, eol, text = load(rel)  # 只 load 一次（踩坑 5）
        ca, cn = text.count(old), text.count(new)
        if ca == 1 and cn == 0:
            save(rel, text.replace(old, new), eol)
            _, _, after = load(rel)
            # 追加型 op（old 是 new 的子串）落盘后 old 仍在，不能要求清零
            old_gone_ok = True if new.find(old) != -1 else after.count(old) == 0
            ok2 = after.count(new) == 1 and old_gone_ok
            log("[OK]  %-24s 落盘复核=%s" % (name, "OK" if ok2 else "FAIL"))
            ok = ok and ok2
        elif cn == 1:
            # 已是补丁态：追加型 op 落盘后 old 仍在（ca==1），统一看 new 是否在场
            log("[SKIP] %-23s 已是补丁态（幂等）" % name)
        else:
            log("[FAIL] %-24s anchor=%d new=%d —— 未写盘" % (name, ca, cn))
            ok = False
    log("WRITE " + ("ALL=OK" if ok else "HAS=FAIL"))
    return ok

def do_restore_src():
    if not os.path.isdir(BACKUP_DIR):
        log("无备份可还原: " + BACKUP_DIR)
        return False
    for rel in FILES:
        dst = os.path.join(BACKUP_DIR, rel.replace("/", "__"))
        if not os.path.isfile(dst):
            log("[FAIL] 备份缺文件: " + rel)
            return False
        shutil.copy2(dst, os.path.join(ROOT, rel))
        log("restore: " + rel)
    log("RESTORE ALL=OK")
    return True

def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "--check").lstrip("-")  # 踩坑 12：先归一再分支
    if mode == "check":
        ok = do_check()
    elif mode == "write":
        ok = do_write()
    elif mode == "restore-src":
        ok = do_restore_src()
    else:
        log("unknown mode: " + mode)
        ok = False
    try:
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(LOG_LINES))
    except Exception as e:
        print("log write failed:", e)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
