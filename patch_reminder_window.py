# -*- coding: utf-8 -*-
"""
[reminder-window v1] 闹钟提醒触发器从每分钟改为每 5 分钟
背景：reminderTask 定时触发器每分钟一次（1440 次/天 ≈ 4.3 万次/月），其中 >99% 是
「查询查空即返回」的空跑，是云函数调用次数的固定大头。个人版套餐 20 万次/月额度。

⚠️ 不能只改触发器：旧查询是 time == 当前分钟的精确匹配，触发器改稀疏后
   用户设的非整 5 分钟档提醒（如 21:03）将永远匹配不到。
   故同时把查询改为「过去 REMINDER_WINDOW_MIN=10 分钟」窗口匹配（_.in）：
   ① 非 5 倍数分钟档的提醒也能命中；
   ② 发送失败后 10 分钟窗口内下次触发可重试（旧实现的「下一分钟再尝试」注释
     实际无效——下一分钟查询条件已变成新分钟，永远匹配不回去，本次顺手修复）。
   幂等仍由 lastSentCycle 保证（发过/已写即标记周期），窗口内不重复推送。

ops:
  A. config.json   触发器 0 * * * * * * → 0 */5 * * * * *
  B. index.js      引入 db.command + 窗口常量/函数
  C. index.js      查询改为窗口 in 匹配
  D. index.js      失败重试注释同步

用法：
  python patch_reminder_window.py --check        # 校验锚点与幂等
  python patch_reminder_window.py --write        # 备份 + 应用
  python patch_reminder_window.py --restore-src  # 从备份还原源码
"""
import os
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = r'C:\Users\ThinkPad\WorkBuddy\reminder-window-backup-20260925'

REL_CFG = 'cloudfunctions/reminderTask/config.json'
REL_JS = 'cloudfunctions/reminderTask/index.js'

CFG_OLD = '"config": "0 * * * * * *"'
CFG_NEW = '"config": "0 */5 * * * * *"   /* [reminder-window v1] 每分钟 → 每 5 分钟 */'
CFG_GUARD = '0 */5 * * * * *'

JS_CMD_OLD = 'const db = cloud.database()\n'
JS_CMD_NEW = 'const db = cloud.database()\nconst _ = db.command\n'
JS_CMD_GUARD = 'const _ = db.command'

JS_FN_OLD = """// 微信云函数运行在 UTC+0，统一按北京时间计算
function getBeijingParts() {"""
JS_FN_NEW = """// [reminder-window v1] 触发器每 5 分钟一次（config.json "0 */5 * * * * *"）；
// 查询由「time == 当前分钟」改为「过去 REMINDER_WINDOW_MIN 分钟」窗口匹配（_.in）：
//   ① 非整 5 分钟档设置的提醒（如 21:03）也能命中；
//   ② 发送失败后窗口内（10 分钟 > 触发间隔 5 分钟）下次触发仍命中可重试
//     （旧实现「下一分钟再尝试」的注释实际无效：下一分钟查询条件已是新分钟，
//      同一提醒永远匹配不回去——本次顺手修复）。
// 幂等仍由 lastSentCycle 保证：发过/已写即标记当天/当周周期，窗口内不会重复推送。
// ⚠️ REMINDER_WINDOW_MIN 必须 ≥ 触发间隔 × 2（当前 5×2）；改触发器频率时须同步调整。
const REMINDER_WINDOW_MIN = 10

// 生成覆盖 [nowMs-(n-1) 分钟, nowMs] 的窗口分钟串（升序），统一按北京时间计算；
// 跨小时/跨天由时间算术自然正确（如北京 00:00 时窗口含 "23:51"~"00:00"）。
function minuteWindow(nowMs, n) {
  const list = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(nowMs + 8 * 3600 * 1000 - i * 60000)
    list.push(pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()))
  }
  return list
}

// 微信云函数运行在 UTC+0，统一按北京时间计算
function getBeijingParts() {"""
JS_FN_GUARD = '[reminder-window v1]'

JS_Q_OLD = """  // 拉所有当前分钟匹配且 enabled 的提醒（按 _id 倒序保证最新生效；单次拉 100 条够个人量级）
  const remindersRes = await db.collection('reminders').where({
    enabled: true,
    time: timeStr
  }).limit(100).get()"""
JS_Q_NEW = """  // 拉所有 time 落在过去 REMINDER_WINDOW_MIN 分钟内且 enabled 的提醒（按 _id 倒序保证最新生效；单次拉 100 条够个人量级）
  // [reminder-window v1] 原为「time == 当前分钟」精确匹配；触发器改稀疏后须窗口匹配才能覆盖任意分钟档
  const remindersRes = await db.collection('reminders').where({
    enabled: true,
    time: _.in(minuteWindow(Date.now(), REMINDER_WINDOW_MIN))
  }).limit(100).get()"""
JS_Q_GUARD = '_.in(minuteWindow(Date.now(), REMINDER_WINDOW_MIN))'

JS_RETRY_OLD = '      // 不更新 lastSentCycle，下一分钟再尝试'
JS_RETRY_NEW = '      // 不更新 lastSentCycle；窗口匹配下下次触发仍命中，10 分钟内自动重试'
JS_RETRY_GUARD = '窗口匹配下下次触发仍命中，10 分钟内自动重试'

# (rel_path, [ (op_name, old, new, guard) ])
OPS = [
    (REL_CFG, [('A.config 触发器 5 分钟', CFG_OLD, CFG_NEW, CFG_GUARD)]),
    (REL_JS, [
        ('B.js 引入 db.command', JS_CMD_OLD, JS_CMD_NEW, JS_CMD_GUARD),
        ('C.js 窗口常量与函数', JS_FN_OLD, JS_FN_NEW, JS_FN_GUARD),
        ('D.js 查询改窗口匹配', JS_Q_OLD, JS_Q_NEW, JS_Q_GUARD),
        ('E.js 失败重试注释', JS_RETRY_OLD, JS_RETRY_NEW, JS_RETRY_GUARD),
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

    # 逐文件应用（每文件只 load 一次；同文件串行替换）
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
