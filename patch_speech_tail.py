# -*- coding: utf-8 -*-
"""
[ai-usage v2] speechToText 收尾提速：清理 ‖ 记账 并行 + 有界等待（2026-09-24）

背景现象：iOS（整段链路）录音超过约 30 秒时，客户端弹「云函数调用失败，详情见控制台日志」。
根因排查（两步实锤，非本脚本改动范围）：
  ① 该提示出自 utils/voice.js 的 `cloud.callFunction:fail` 普通分支 ⇒ 调用层失败，不是火山返回错误；
  ② 控制台里 speechToText 的「执行超时」只有 **3 秒**（默认/历史配置）——火山极速识别处理 30 秒音频
     约 2~3 秒，刚好卡在边界上 ⇒ 用户遂行「≤30 秒 OK、>30 秒必挂」。
     ⇒ 用户已在控制台把超时改成 20 秒（配置改动，立即生效，不需重新部署）。

本脚本做的是「顺手提速」这一半（用户 2026-09-24 拍板执行）：
  A. 新增 flushTail()：把识别成功后剩下的两件杂事——清理云存储临时文件、写 ai_usage 记账——
     ① **并行发起**（旧版是「先删文件、再记账」串行两跳，白等一次往返）；
     ② 给二者总等待设上限 TAIL_WAIT_MS=1000ms（**注意：不能改成 fire-and-forget**——
        云函数返回后运行时会冻结，未完成的写入会丢；而 test_ai_usage 的 st-2/st-3/st-4
        锁的正是「返回前记账已落库」。故用「Promise.all + 超时闸」而不是「不 await」）；
     ③ 超时闸定时器在 finally 里清掉，不留悬挂定时器拖住事件循环。
  B. 成功路径 / 错误路径的收尾统一改走 flushTail（错误路径同样清理 + 记 ok:false）。
  C. 测试 tools/test_ai_usage.js 补 st-6 / st-7 两条行为断言 + 桩的挂起开关：
     · st-6（并行性）：让 deleteFile 挂住不返回，断言 `add` **已经发出**——旧版串行 ⇒ 永不发出 ⇒ 红；
     · st-7（有界性）：让 deleteFile 与 add **双双挂住**，断言 main 仍在等待上限内返回
       （旧版会一直挂住 ⇒ 客户端等到函数超时 ⇒ 正是用户遇到的故障形态）。

⚠️ 未动：识别主链路（downloadFile / recognizeFlash）、早退路径、返回值契约、ai_usage 字段。

用法：--check / --write / --restore（全回滚）/ --restore-src（只回滚源码，留新测试做红灯自检）
"""
import sys, os, shutil

WORK = os.path.dirname(os.path.abspath(__file__))
BK = r'C:\Users\ThinkPad\WorkBuddy\speech-speedup-backup-20260924'

SRC = r'cloudfunctions\speechToText\index.js'
TEST = r'tools\test_ai_usage.js'

# ===== A. 云函数：新增 flushTail（并行 + 有界等待）=================================
A_OLD = "exports.main = async (event) => {\n  const { fileID, format, hotwords } = event\n"
A_NEW = """// ===== [ai-usage v2] 收尾加速：清理临时文件 ‖ 记账，并行发起 + 有界等待 =====
// 识别成功后只剩两件杂事，彼此不依赖 ⇒ 并行发起只等一次往返（旧版「先删文件、再记账」白等一跳）。
// 更要紧的是给它们设等待上限：云库/云存储抖动时先返回识别结果，别让收尾把整次识别拖到函数执行超时
// （iOS 长录音「云函数调用失败」的成因之一就是收尾被计入执行时长）。
// ⚠️ 不能改成 fire-and-forget：云函数返回后运行时会冻结，未完成的写入会丢；
//    且 test_ai_usage 的 st-2/st-3/st-4 锁的就是「返回前记账已落库」。
//    故用 Promise.all + 超时闸：正常情况（各约 100ms 往返）在上限内完成，行为与串行时期一致。
const TAIL_WAIT_MS = 1000

async function flushTail(fileID, usageFields) {
  const cleanup = (async () => {
    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
  })()
  const accounting = logAiUsage(usageFields)
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn('[ai-usage] speechToText 收尾等待超时(>' + TAIL_WAIT_MS + 'ms)，先返回识别结果')
      resolve()
    }, TAIL_WAIT_MS)
  })
  try {
    await Promise.race([Promise.all([cleanup, accounting]), guard])
  } finally {
    if (timer) { clearTimeout(timer); timer = null }
  }
}

exports.main = async (event) => {
  const { fileID, format, hotwords } = event
"""
A_GUARD = "async function flushTail(fileID, usageFields) {"

# ===== B. 云函数：成功路径收尾 ===================================================
B_OLD = ("    // 3. 清理临时文件\n"
         "    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}\n"
         "    // [ai-usage v1] 记账：成功也记（阻塞 await，防云函数提前冻结丢记录）\n"
         "    await logAiUsage({ ok: true, audioBytes: fileRes.fileContent.length, costMs: Date.now() - startedAt })\n"
         "    return { text }\n")
B_NEW = ("    // 3) [ai-usage v2] 收尾：清理临时文件 ‖ 记账，并行 + 有界等待（见 flushTail）\n"
         "    await flushTail(fileID, { ok: true, audioBytes: fileRes.fileContent.length, costMs: Date.now() - startedAt })\n"
         "    return { text }\n")
B_GUARD = "await flushTail(fileID, { ok: true,"

# ===== C. 云函数：错误路径收尾 ===================================================
C_OLD = ("  } catch (err) {\n"
         "    // 出错也清理临时文件\n"
         "    try { await cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}\n"
         "    // [ai-usage v1] 记账：失败也记（算失败率，不阻塞错误返回）\n"
         "    await logAiUsage({ ok: false, error: String((err && err.message) || 'asr error').slice(0, 120), costMs: Date.now() - startedAt })\n"
         "    return { error: err.message || '语音识别失败' }\n"
         "  }\n")
C_NEW = ("  } catch (err) {\n"
         "    // [ai-usage v2] 出错也收尾：清理临时文件 ‖ 记账（并行 + 有界等待）\n"
         "    await flushTail(fileID, { ok: false, error: String((err && err.message) || 'asr error').slice(0, 120), costMs: Date.now() - startedAt })\n"
         "    return { error: err.message || '语音识别失败' }\n"
         "  }\n")
C_GUARD = "await flushTail(fileID, { ok: false,"

# ===== D. 测试：state 增观测/挂起开关 ============================================
D_OLD = ("const state = {\n"
         "  records: [],        // 所有 add 写入 {collection, data}\n"
         "  failAdd: false,     // 令 add 抛错（模拟云库故障）\n")
D_NEW = ("const state = {\n"
         "  records: [],        // 所有 add 写入 {collection, data}\n"
         "  calls: [],          // [st-6/st-7] 收尾调用观测：'deleteFile' / 'add' 的发起顺序\n"
         "  deferDelete: false, // [st-6/st-7] 让 deleteFile 挂住不返回（模拟云存储抖动）\n"
         "  deferAdd: false,    // [st-7] 让 ai_usage 写入挂住不返回（模拟云库抖动）\n"
         "  releaseDelete: null,\n"
         "  releaseAdd: null,\n"
         "  failAdd: false,     // 令 add 抛错（模拟云库故障）\n")
D_GUARD = "calls: [],          // [st-6/st-7]"

# ===== E. 测试：ai_usage add 桩支持挂起 ==========================================
E_OLD = ("          add: async function (op) {\n"
         "            if (state.failAdd) throw new Error('mock add fail')\n")
E_NEW = ("          add: async function (op) {\n"
         "            if (name === 'ai_usage') state.calls.push('add')\n"
         "            if (state.failAdd) throw new Error('mock add fail')\n"
         "            if (state.deferAdd) {\n"
         "              return new Promise(function (res) { state.releaseAdd = res })\n"
         "            }\n")
E_GUARD = "if (state.deferAdd) {"

# ===== F. 测试：deleteFile 桩支持挂起 ============================================
F_OLD = "  deleteFile: async function () { return {} }\n}\n\n// ===== 桩：https ====="
F_NEW = ("  deleteFile: async function () {\n"
         "    state.calls.push('deleteFile')\n"
         "    if (state.deferDelete) {\n"
         "      return new Promise(function (res) { state.releaseDelete = res })\n"
         "    }\n"
         "    return {}\n"
         "  }\n"
         "}\n\n// ===== 桩：https =====")
F_GUARD = "if (state.deferDelete) {"

# ===== G. 测试：wait 工具 ========================================================
G_OLD = "function resetHttp() {\n"
G_NEW = "function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }\n\nfunction resetHttp() {\n"
G_GUARD = "function wait(ms) { return new Promise"

# ===== H. 测试：st-6 / st-7 =====================================================
H_OLD = ("  state.failAdd = false\n"
         "  state.downloadFile = null\n"
         "\n"
         "  // ================= D. getAiStats 聚合 =================\n")
H_NEW = """  state.failAdd = false
  state.downloadFile = null

  // ===== [ai-usage v2] 收尾提速：清理 ‖ 记账 并行 + 有界等待 =====
  // st-6（并行性）：deleteFile 挂住不返回时，「记账已发出」——旧版串行 await ⇒ add 永不发出 ⇒ 红
  resetHttp()
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '并行收尾' } }
  state.downloadFile = function () { return { fileContent: Buffer.from('xx') } }
  state.calls = []
  state.deferDelete = true
  const p6 = asrFn.main({ fileID: 'cloud://f6', format: 'wav' })
  await wait(60)
  check('st-6 清理挂起时记账已并行发起（不再串行等清理）',
    state.calls.indexOf('deleteFile') >= 0 && state.calls.indexOf('add') >= 0, state.calls.slice())
  state.deferDelete = false
  if (state.releaseDelete) state.releaseDelete()
  const r6 = await p6
  eq('st-6 并行收尾后业务返回不变', r6.text, '并行收尾')

  // st-7（有界性）：清理与记账双双挂住时，仍须在等待上限内返回识别结果
  //（旧版会一直挂住 ⇒ 客户端等到函数执行超时 ⇒ 正是 iOS 长录音「云函数调用失败」的形态）
  resetHttp()
  state.httpHeaders = { 'x-api-status-code': '20000000' }
  state.httpBody = { result: { text: '限时兜底' } }
  state.calls = []
  state.deferDelete = true
  state.deferAdd = true
  const t7 = Date.now()
  const r7 = await Promise.race([
    asrFn.main({ fileID: 'cloud://f7', format: 'wav' }),
    wait(2500).then(function () { return 'TIMEOUT' })
  ])
  const cost7 = Date.now() - t7
  check('st-7 收尾双双挂起时仍限时返回（不被拖到函数超时）',
    r7 !== 'TIMEOUT' && r7.text === '限时兜底', { cost: cost7, ret: r7 })
  check('st-7 收尾等待上限约 1s', r7 !== 'TIMEOUT' && cost7 >= 900 && cost7 < 2200, cost7)
  state.deferDelete = false
  state.deferAdd = false
  state.releaseDelete = null
  state.releaseAdd = null
  state.downloadFile = null

  // ================= D. getAiStats 聚合 =================
"""
H_GUARD = "st-6 清理挂起时记账已并行发起"

OPS = [
    (SRC, A_OLD, A_NEW, A_GUARD, 1),
    (SRC, B_OLD, B_NEW, B_GUARD, 1),
    (SRC, C_OLD, C_NEW, C_GUARD, 1),
    (TEST, D_OLD, D_NEW, D_GUARD, 1),
    (TEST, E_OLD, E_NEW, E_GUARD, 1),
    (TEST, F_OLD, F_NEW, F_GUARD, 1),
    (TEST, G_OLD, G_NEW, G_GUARD, 1),
    (TEST, H_OLD, H_NEW, H_GUARD, 1),
]

ALL_RELS = sorted(set(o[0] for o in OPS))
SRC_RELS = [r for r in ALL_RELS if not r.startswith('tools')]


def load(rel):
    raw = open(os.path.join(WORK, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return (raw.replace('\r\n', '\n'), crlf)


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(WORK, rel), 'wb').write(text.encode('utf-8'))


def backup():
    """幂等备份：目标已存在即早退，绝不覆盖干净备份"""
    made = 0
    for rel in ALL_RELS:
        dst = os.path.join(BK, rel)
        if os.path.exists(dst):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(WORK, rel), dst)
        made += 1
    print('backup: %s (%d files%s)' % (BK, made, '' if made else ', 已存在即跳过'))


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else '--check').lstrip('-')
    if mode not in ('check', 'write', 'restore', 'restore-src'):
        print('usage: patch_speech_tail.py --check|--write|--restore|--restore-src')
        return 2
    if mode in ('restore', 'restore-src'):
        rels = ALL_RELS if mode == 'restore' else SRC_RELS
        for rel in rels:
            src = os.path.join(BK, rel)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(WORK, rel))
                print('RESTORED', rel)
        return 0

    if mode == 'write':
        backup()

    ok_all = True
    for rel, old, new, guard, expect in OPS:
        text, crlf = load(rel)
        c_old = text.count(old)
        c_new = text.count(guard)
        if c_new >= expect:
            print('SKIP(applied)  %-34s guard=%d' % (rel, c_new))
        elif c_old == expect:
            if mode == 'write':
                save(rel, text.replace(old, new), crlf)
            print('OK             %-34s old=%d' % (rel, c_old))
        else:
            ok_all = False
            print('FAIL           %-34s old=%d guard=%d (expect old=%d)' % (rel, c_old, c_new, expect))
    return 0 if ok_all else 1


if __name__ == '__main__':
    sys.exit(main())
