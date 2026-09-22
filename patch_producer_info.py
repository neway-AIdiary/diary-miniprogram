# -*- coding: utf-8 -*-
"""
[producer-info v1] 关于页新增「出品方 北京伟帆科技中心」

口径（沿用本项目「唯一来源」约定）：
  · 主体名称只写在 utils/appInfo.js（PRODUCER），页面不写死；
  · about.js data 暴露 producer + 新增 copyProducer（整行可点，便于逐字复制）；
  · about.wxml 新增一行（图标 / 标签 / 值 / 复制），放在信息卡**首行** ——
    与「备案/许可证编号」相邻，主体信息集中；行结构与既有三行完全一致，不加新样式；
  · 图标取既有字体子集里的 ri-archive-line（子集共 34 枚，无 building/honour 字形）。

用法: --check / --write / --restore-src
"""
import sys, os, shutil

ROOT = r"C:\Users\ThinkPad\WorkBuddy\2026-09-07-10-38-35\diary-miniprogram-work"
BACKUP = r"C:\Users\ThinkPad\WorkBuddy\producer-info-backup-20260922"
REL_FILES = [
    "utils/appInfo.js",
    "pages/about/about.js",
    "pages/about/about.wxml",
    "tools/test_about_info.js",
]

OPS = {
    "utils/appInfo.js": [
        dict(
            tag="appinfo-head",
            old=""" * 关于页需要展示的「应用名 / 版本号 / 简介 / 备案号 / 联系方式」统一放这里，""",
            new=""" * 关于页需要展示的「应用名 / 版本号 / 简介 / 出品方 / 备案号 / 联系方式」统一放这里，""",
            sig="简介 / 出品方 / 备案号",
        ),
        dict(
            tag="appinfo-const",
            old="""/* 联系方式 */
const WECHAT_ID = 'baguanshanren'

module.exports = {
  APP_NAME,
  APP_SLOGAN,
  APP_VERSION,
  APP_INTRO,
  ICP_NO,
  ICP_SITE,
  WECHAT_ID
}""",
            new="""/* 出品方（主体名称）：[producer-info v1] 关于页展示，行内可点击复制 */
const PRODUCER = '北京伟帆科技中心'

/* 联系方式 */
const WECHAT_ID = 'baguanshanren'

module.exports = {
  APP_NAME,
  APP_SLOGAN,
  APP_VERSION,
  APP_INTRO,
  ICP_NO,
  ICP_SITE,
  PRODUCER,
  WECHAT_ID
}""",
            sig="const PRODUCER = '北京伟帆科技中心'",
        ),
    ],
    "pages/about/about.js": [
        dict(
            tag="aboutjs-head",
            old=""" * 关于页：应用名 + 版本号 + 简介 + 备案号 + 联系方式""",
            new=""" * 关于页：应用名 + 版本号 + 简介 + 出品方 + 备案号 + 联系方式""",
            sig="简介 + 出品方 + 备案号",
        ),
        dict(
            tag="aboutjs-data",
            old="""    icpNo: appInfo.ICP_NO,
    wechatId: appInfo.WECHAT_ID,""",
            new="""    icpNo: appInfo.ICP_NO,
    producer: appInfo.PRODUCER,
    wechatId: appInfo.WECHAT_ID,""",
            sig="    producer: appInfo.PRODUCER,",
        ),
        dict(
            tag="aboutjs-copy",
            old="""  // 微信号：直接复制，免得用户手抄
  copyWechat() {""",
            new="""  // 出品方：主体名称需逐字准确（报备 / 开票常要填），整行可点即复制
  copyProducer() {
    this.copy(appInfo.PRODUCER, '出品方已复制')
  },

  // 微信号：直接复制，免得用户手抄
  copyWechat() {""",
            sig="  copyProducer() {",
        ),
    ],
    "pages/about/about.wxml": [
        dict(
            tag="wxml-head",
            old="""<!-- 关于页：应用名 / 版本号 / 简介 / 备案号 / 联系方式（点击整行即复制） -->""",
            new="""<!-- 关于页：应用名 / 版本号 / 简介 / 出品方 / 备案号 / 联系方式（点击整行即复制） -->""",
            sig="简介 / 出品方 / 备案号",
        ),
        dict(
            tag="wxml-row",
            old="""    <view class="menu-card about-card">
      <view class="menu-item" bindtap="copyIcp">""",
            new="""    <view class="menu-card about-card">
      <view class="menu-item" bindtap="copyProducer">
        <text class="menu-icon ri ri-archive-line"></text>
        <view class="about-item-main">
          <text class="about-item-label">出品方</text>
          <text class="about-item-value">{{producer}}</text>
        </view>
        <text class="about-copy">复制</text>
      </view>
      <view class="menu-item" bindtap="copyIcp">""",
            sig="bindtap=\"copyProducer\"",
        ),
    ],
    "tools/test_about_info.js": [
        dict(
            tag="test-const",
            old="""ok('WECHAT_ID 非空且无空格', /^\\S{4,}$/.test(info.WECHAT_ID), String(info.WECHAT_ID))""",
            new="""ok('WECHAT_ID 非空且无空格', /^\\S{4,}$/.test(info.WECHAT_ID), String(info.WECHAT_ID))
ok('PRODUCER 非空（出品方主体名称）', typeof info.PRODUCER === 'string' && info.PRODUCER.length >= 4,
  String(info.PRODUCER))""",
            sig="PRODUCER 非空（出品方主体名称）",
        ),
        dict(
            tag="test-about-js",
            old="""ok('about.js 未硬编码备案号（只从 appInfo 取）', aboutJs.indexOf('京ICP备') === -1)""",
            new="""ok('about.js 未硬编码备案号（只从 appInfo 取）', aboutJs.indexOf('京ICP备') === -1)
ok('about.js 未硬编码出品方名称（只从 appInfo 取）',
  aboutJs.indexOf(info.PRODUCER) === -1, '出品方名称漏进了页面代码')
ok('about.js data 暴露 producer', aboutJs.indexOf('producer: appInfo.PRODUCER,') !== -1)""",
            sig="about.js 未硬编码出品方名称",
        ),
        dict(
            tag="test-wxml",
            old="""// ---------- 6. APP_NAME 字面量泄漏护栏 ----------""",
            new="""// [producer-info v1] 出品方行：绑 {{producer}} + 整行点击复制 + 图标在子集内 + 标签文案
ok('about.wxml 出品方行绑 {{producer}} 并整行可点复制',
  aboutWxml.indexOf('bindtap="copyProducer"') !== -1 && aboutWxml.indexOf('{{producer}}') !== -1)
ok('about.wxml 出品方行沿用既有行结构（menu-item + about-copy 复用，无新样式）',
  /<view class="menu-item" bindtap="copyProducer">[\\s\\S]{0,400}?<text class="about-copy">复制<\\/text>/.test(aboutWxml))
ok('about.wxml 出品方行的标签文案是「出品方」',
  aboutWxml.indexOf('<text class="about-item-label">出品方</text>') !== -1)
ok('出品方行排在信息卡首行（主体信息先于备案号）',
  aboutWxml.indexOf('copyProducer') !== -1 &&
  aboutWxml.indexOf('copyProducer') < aboutWxml.indexOf('copyIcp'))

// ---------- 6. APP_NAME 字面量泄漏护栏 ----------""",
            sig="about.wxml 出品方行绑 {{producer}}",
        ),
    ],
}


def load(rel):
    raw = open(os.path.join(ROOT, rel), "rb").read().decode("utf-8")
    return raw, raw.replace("\r\n", "\n")


def save(rel, raw, text):
    nl = "\r\n" if "\r\n" in raw else "\n"
    out = text.replace("\n", nl) if nl == "\r\n" else text
    open(os.path.join(ROOT, rel), "wb").write(out.encode("utf-8"))


def backup():
    if os.path.isdir(BACKUP):
        return
    for rel in REL_FILES:
        dst = os.path.join(BACKUP, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel.replace("/", os.sep)), dst)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    do_write = mode == "--write"
    bad = 0
    for rel, ops in OPS.items():
        raw, text = load(rel)
        if mode == "--restore-src":
            src = os.path.join(BACKUP, rel.replace("/", os.sep))
            shutil.copy2(src, os.path.join(ROOT, rel.replace("/", os.sep)))
            print("[RESTORED] " + rel)
            continue
        st = ""
        for op in ops:
            if op["sig"] in text:
                st = "SKIP"
            elif op["old"] in text:
                if do_write:
                    if text.count(op["old"]) != 1:
                        st = "ERR(锚点不唯一)"
                    else:
                        text = text.replace(op["old"], op["new"])
                        st = "OK"
                else:
                    st = "PENDING"
            else:
                st = "ERR(锚点0命中)"
            print("[%s] %s %s -> %s" % (mode, rel, op["tag"], st))
            if st.startswith("ERR"):
                bad += 1
        if do_write and not st.startswith("ERR"):
            backup()
            save(rel, raw, text)
    print("RESULT: " + ("FAIL x%d" % bad if bad else "ALL OK"))


main()
