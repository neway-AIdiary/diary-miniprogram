/**
 * 应用信息（唯一来源）
 *
 * 关于页需要展示的「应用名 / 版本号 / 简介 / 出品方 / 备案号 / 联系方式」统一放这里，
 * 将来发版、改备案号、换微信号只动这一个文件。
 *
 * [brand-rename v1] 2026-09-20 全站改名完成（旧名「AI日记」→「一灯记」）：
 *   导航标题 / 侧栏标题 / 分享卡片 / 海报品牌行 / 关于文案 / 页面页脚 /
 *   导出物标题与文件名（utils/storage.js）均已改走本文件的 APP_NAME。
 *   ⚠️ 唯一**必须保留旧字面量**的地方：utils/storage.js 的导入判据 ——
 *   仍按「AI日记 · 日记备份」（老文件）或「导出时间：」识别，删掉会让用户旧备份再也导入不进。
 */
const APP_NAME = '一灯记'
const APP_VERSION = '1.0.0'

/* 关于页简介：一段话讲清「是什么 + AI 能做什么 + 数据在哪」 */
const APP_INTRO = '这里是你人生中静谧的一隅，一方不受打扰的空间。记录你每一天的生活，AI 帮你润色文字、提炼总结；数据默认只存在本机，也可开启 AES 加密的云端备份，换新手机随时恢复。'

/* 小程序备案：编号必须完整（含序列号后缀 X），点击复制后引导到工信部系统核对 */
const ICP_NO = '京ICP备2026059598号-1X'
const ICP_SITE = 'beian.miit.gov.cn'

/* 主页标语（写日记页顶栏 = 品牌名 + 标语）：[nav-slogan v1] */
const APP_SLOGAN = '让AI照亮此间'

/* 出品方（主体名称）：[producer-info v1] 关于页展示，行内可点击复制 */
const PRODUCER = '北京伟帆科技中心'

/* 联系方式 */
const WECHAT_ID = 'baguanshanren'

/* [share-card v1] 分享卡片品牌图（云存储文件 ID）：各页 onShareAppMessage 统一引用。
 * 图片位于云存储 media/share-card.png（5:4，1000x800）；换图只改这一行。
 * ⚠️ 若控制台实际 fileID 与此处不一致，以控制台复制为准替换。 */
const SHARE_CARD_FILEID = 'cloud://aidiary-d6grgxkct50c30f45.6169-aidiary-d6grgxkct50c30f45-1468488197/media/share-card.png'

module.exports = {
  APP_NAME,
  APP_SLOGAN,
  APP_VERSION,
  APP_INTRO,
  ICP_NO,
  ICP_SITE,
  PRODUCER,
  WECHAT_ID,
  SHARE_CARD_FILEID
}
