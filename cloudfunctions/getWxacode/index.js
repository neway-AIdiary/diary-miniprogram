/**
 * 云函数：getWxacode
 * 输入：{ scene }  —— 小程序码携带参数（如日记 id），最长 32 字符
 * 输出：{ fileID } —— 生成的太阳码图片已上传云存储；失败返回 { error, errMsg }
 *
 * 实现方式：openapi.wxacode.getUnlimited（数量不限的太阳码），
 * 生成的是内容为图片的 Buffer，转存到云存储后把 fileID 给前端，
 * 前端用临时链接画进分享海报右下角。
 *
 * 说明：
 *   - page 固定 pages/detail/detail（扫码直达日记详情）
 *   - checkPath: false —— 页面未发布线上版本时也允许生成（开发/体验阶段必需）
 *   - 依赖 wx-server-sdk（部署时选「云端安装依赖」）
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event) => {
  const scene = String(event.scene || 'share').slice(0, 32)
  try {
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene: scene,
      page: 'pages/detail/detail',
      width: 280,
      checkPath: false,
      envVersion: 'release' // 体验版扫码调试时可临时改为 trial
    })
    if (!res || !res.buffer) {
      return { error: 'empty_buffer', errMsg: (res && res.errMsg) || '' }
    }
    const upload = await cloud.uploadFile({
      cloudPath: 'wxacode/' + scene.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Date.now() + '.jpg',
      fileContent: res.buffer
    })
    return { fileID: upload.fileID }
  } catch (e) {
    return { error: 'wxacode_fail', errMsg: (e && (e.errMsg || e.message)) || String(e) }
  }
}
