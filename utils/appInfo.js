/**
 * 应用信息（唯一来源）
 *
 * 关于页需要展示的「应用名 / 版本号 / 简介 / 备案号 / 联系方式」统一放这里，
 * 将来发版、改备案号、换微信号只动这一个文件。
 *
 * ⚠️ 若要把 APP_NAME 从「AI日记」改成「一灯记」，必须同步处理下面两处历史字面量，
 *    否则用户手机上已有的旧备份文件会导入失败：
 *      1. utils/storage.js —— 导入时按字面「AI日记 · 日记备份」或「导出时间：」识别文件
 *      2. 导出文件名与文档标题（utils/storage.js 内 'AI日记备份.docx' 等）
 *    正确做法是「新增新判据 + 保留旧判据」，让新旧文件都能识别。
 *    本轮（3.A）范围最小，只把「关于」页标题定为「一灯记」，其他地方一律不动。
 */
const APP_NAME = '一灯记'
const APP_VERSION = '1.0.0'

/* 关于页简介：一段话讲清「是什么 + AI 能做什么 + 数据在哪」 */
const APP_INTRO = '一灯记是一款安静的日记本。写下每一天，AI 帮你润色文字、提炼总结；数据默认只存在本机，也可开启 AES 加密的云端备份，换新手机随时恢复。'

/* 小程序备案：编号必须完整（含序列号后缀 X），点击复制后引导到工信部系统核对 */
const ICP_NO = '京ICP备2026059598号-1X'
const ICP_SITE = 'beian.miit.gov.cn'

/* 联系方式 */
const WECHAT_ID = 'baguanshanren'

module.exports = {
  APP_NAME,
  APP_VERSION,
  APP_INTRO,
  ICP_NO,
  ICP_SITE,
  WECHAT_ID
}
