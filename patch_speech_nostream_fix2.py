# -*- coding: utf-8 -*-
"""
[asr-nostream-fix2] 修 iPhone「识别超时」：音频参数按 WAV 文件头实际值下发
根因：iOS recorderManager 可能忽略 sampleRate:16000 参数（实际录出 44.1k/48k），
     nostream 请求写死 rate:16000 ⇒ 服务端按时长放大 ~2.8 倍处理 ⇒ 超过 15s 上限报「识别超时」。
     flash 接口读 wav 头所以一直没暴露。
改动（仅 cloudfunctions/speechToText/index.js）：
  A. 新增 parseWav()：解析 RIFF fmt 块实际 rate/bits/channels + 定位 data 块
  B. recognizeNostream 内按解析值构造 audio 参数 + console.log 便于云端日志诊断

用法：--check / --write / --restore-src
"""
import os
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKUP = 'speech-nostream-fix2-backup-20260924'
FILES = ['cloudfunctions/speechToText/index.js']

OLD_A = '''// WAV → 裸 PCM：解析 RIFF 头定位 data 块（兼容带 LIST 等扩展块的录制器），异常退回固定偏移
function wavToPcm(buf) {
  try {
    if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
      let off = 12
      while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4)
        const size = buf.readUInt32LE(off + 4)
        if (id === 'data') {
          const start = off + 8
          if (start + size <= buf.length) return buf.slice(start, start + size)
        }
        off += 8 + size + (size % 2)
      }
    }
  } catch (e) {}
  return buf.slice(44)
}'''

NEW_A = '''// WAV 解析：定位 data 块（兼容带 LIST 等扩展块的录制器）并读取 fmt 块实际参数。
// ⚠️ iOS 的 recorderManager 可能忽略 sampleRate 参数（实际录出的不是 16000），
//    音频参数必须按文件头实际值下发 —— 写死 16000 会让服务端把 44.1k 当 16k 处理，
//    时长被放大 ~2.8 倍 ⇒ nostream 处理超时（2026-09-24 iPhone「识别超时」的根因）。
//    flash 接口服务端自己读 wav 头，所以这个错位在 flash 时代从未暴露。
function parseWav(buf) {
  try {
    if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
      let rate = 0
      let bits = 0
      let channels = 0
      let off = 12
      while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4)
        const size = buf.readUInt32LE(off + 4)
        if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
          channels = buf.readUInt16LE(off + 10)
          rate = buf.readUInt32LE(off + 12)
          bits = buf.readUInt16LE(off + 22)
        } else if (id === 'data') {
          const start = off + 8
          if (start + size <= buf.length) {
            return { pcm: buf.slice(start, start + size), rate: rate, bits: bits, channels: channels }
          }
        }
        off += 8 + size + (size % 2)
      }
    }
  } catch (e) {}
  return null
}

function wavToPcm(buf) {
  const parsed = parseWav(buf)
  return parsed ? parsed.pcm : buf.slice(44)
}'''

OLD_B = '''    const pcm = format === 'pcm' ? audioBuffer : wavToPcm(audioBuffer)'''

NEW_B = '''    // 音频参数按文件头实际值下发（pcm 裸流来自 16k 录音恒为 16k，wav 以头为准）
    const wavInfo = format === 'pcm' ? null : parseWav(audioBuffer)
    const pcm = wavInfo ? wavInfo.pcm : audioBuffer
    const audioMeta = {
      rate: (wavInfo && wavInfo.rate) || 16000,
      bits: (wavInfo && wavInfo.bits) || 16,
      channel: (wavInfo && wavInfo.channels) || 1
    }
    console.log('[asr-nostream] pcm=%dB rate=%s bits=%s ch=%s', pcm.length, audioMeta.rate, audioMeta.bits, audioMeta.channel)'''

OLD_C = '''      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },'''

NEW_C = '''      audio: { format: 'pcm', rate: audioMeta.rate, bits: audioMeta.bits, channel: audioMeta.channel },'''

OPS = [
    {'old': OLD_A, 'new': NEW_A, 'guard': 'function parseWav(buf) {'},
    {'old': OLD_B, 'new': NEW_B, 'guard': 'const audioMeta = {'},
    {'old': OLD_C, 'new': NEW_C, 'guard': "rate: audioMeta.rate, bits: audioMeta.bits, channel: audioMeta.channel"},
]


def load(rel):
    raw = open(os.path.join(ROOT, rel), 'rb').read().decode('utf-8')
    crlf = '\r\n' in raw
    return raw.replace('\r\n', '\n'), crlf


def save(rel, text, crlf):
    if crlf:
        text = text.replace('\n', '\r\n')
    open(os.path.join(ROOT, rel), 'wb').write(text.encode('utf-8'))


def do_backup():
    dst = os.path.join(ROOT, BACKUP)
    if os.path.isdir(dst):
        return False
    os.makedirs(dst)
    for rel in FILES:
        src = os.path.join(ROOT, rel)
        d = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(src, d)
    return True


def check(verbose=True):
    ok = True
    text, _ = load(FILES[0])
    for i, op in enumerate(OPS, 1):
        if op['guard'] in text:
            status = 'SKIP(已应用)'
        elif text.count(op['old']) == 1:
            status = 'OK'
        else:
            status = 'FAIL(锚点 %d 次)' % text.count(op['old'])
            ok = False
        if verbose:
            print('op%d %s' % (i, status))
    return ok


def write():
    do_backup()
    text, crlf = load(FILES[0])  # 只 load 一次
    for i, op in enumerate(OPS, 1):
        if op['guard'] in text:
            print('op%d SKIP(已应用)' % i)
            continue
        n = text.count(op['old'])
        if n != 1:
            print('op%d FAIL(锚点 %d 次)' % (i, n))
            return 1
        text = text.replace(op['old'], op['new'], 1)
        print('op%d OK' % i)
    save(FILES[0], text, crlf)
    print('written.')
    return 0


def restore_src():
    dst = os.path.join(ROOT, BACKUP)
    if not os.path.isdir(dst):
        print('no backup dir: ' + BACKUP)
        return 1
    for rel in FILES:
        src = os.path.join(dst, rel)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(ROOT, rel))
            print('restored: ' + rel)
    return 0


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '--check'
    if mode == '--check':
        sys.exit(0 if check() else 1)
    elif mode == '--write':
        sys.exit(write())
    elif mode == '--restore-src':
        sys.exit(restore_src())
    else:
        print(__doc__)
        sys.exit(2)
