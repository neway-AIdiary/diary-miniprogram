/**
 * 本地标签提取引擎
 * 根据日记内容自动生成关键词标签（最多5个）
 * 策略：主题词典匹配（优先）→ 档案专名补位 → 去重截断
 *
 * [tagjunk v1 · 2026-09-18] 废弃旧版「双字滑窗词频兜底」：词频法在中文里必然产出虚词碎片 ——
 *   「是一家…那是一家」→「一家」「是一」；「比较好的 / 挺好的」→「好的」。
 *   用户报障原文：「这算什么标签呀，不要什么都提取为标签」。现改为档案专名补位（见 extraWords）。
 */

// 常见生活主题词典（按日常使用频率排列）
const TOPIC_WORDS = [
  '工作', '上班', '下班', '加班', '开会', '项目', '方案', '客户', '同事', '领导', '老板', '出差', '通勤', '汇报', '总结',
  '学习', '考试', '读书', '看书', '复习', '上课', '论文', '作业', '面试',
  '运动', '跑步', '健身', '瑜伽', '游泳', '散步', '打球', '爬山', '骑行',
  '美食', '吃饭', '火锅', '奶茶', '咖啡', '做饭', '下厨', '外卖', '聚餐',
  '旅行', '旅游', '游玩', '风景', '海边', '公园',
  '电影', '电视剧', '音乐', '唱歌', '游戏', '刷手机', '视频', '治愈',
  '朋友', '聚会', '聊天', '家人', '父母', '孩子', '对象', '宠物', '猫咪', '狗狗',
  '健康', '生病', '医院', '失眠', '睡眠', '感冒',
  '天气', '下雨', '阳光', '下雪', '降温', '台风',
  '心情', '焦虑', '开心', '难过', '感动', '遗憾',
  '购物', '逛街', '礼物',
  '坚持', '计划', '目标', '梦想', '回忆', '周末', '假期', '新年', '生日'
]

// 停用词 — 无语义的双字词
const STOP_WORDS = new Set([
  '今天', '昨天', '明天', '上午', '下午', '晚上', '早上', '中午', '凌晨',
  '时候', '一个', '一下', '一些', '这个', '那个', '什么', '怎么', '怎样',
  '我们', '你们', '他们', '她们', '自己', '别人',
  '因为', '所以', '但是', '还是', '就是', '真的', '感觉', '觉得',
  '开始', '已经', '现在', '然后', '最后', '还有', '没有', '可以',
  '可能', '应该', '这样', '那样', '有点', '有些', '起来', '出来',
  '回来', '过去', '后来', '忽然', '突然', '慢慢', '静静', '好好',
  '一起', '一直', '已经', '终于', '虽然', '如果', '其实', '不过',
  '发现', '想到', '想起', '记得', '希望', '想要', '愿意', '告诉',
  '大家', '东西', '事情', '时间', '时候', '地方', '生活', '每天'
])

// ===== 标签质量闸（tagjunk v1）=====
// 用途：① 过滤云端 AI 返回的标签；② 校验「档案专名」能否直接当标签。
// 主题词典 TOPIC_WORDS 是人肉审过的白名单，不走这道闸。
// ⚠️ 这三份常量与云函数 cloudfunctions/optimizeDiary/index.js 里的同名常量必须逐字一致
//    （回归 tools/test_tags.js 的 tj-19 会比对，防两端分叉）。
const TAG_HEAD_STOP_CHARS = '是的了着过在很都也就还又这那我你他她它们谁怎一两有没不别太挺因所但而或和跟与把被让给从向往于为以及等之其此真'
// 尾字只保留「结构助词 / 语气词」——过/就/都/也/还/很 这些一律不做尾字判据：
// 它们是正经词的合法结尾（难过、走过、就好…），拦下来属于误伤，不值得。
const TAG_TAIL_STOP_CHARS = '的了着是在呢吗吧啊呀哦嗯嘛地得'
const TAG_JUNK_WORDS = ['一家', '两家', '这家', '那家', '是一', '好的', '一个', '两个', '这个', '那个', '什么', '怎么', '我们', '你们', '他们', '她们', '自己', '时候', '东西', '事情', '感觉', '真的', '可以', '因为', '所以']

/**
 * 标签是否有意义（云端标签过滤 / 专名补位共用）
 * 拒绝：非 2~6 字、含标点空格、纯数字、停用词、碎片词、虚词开头或结尾
 * @param {string} word
 * @returns {boolean}
 */
function isMeaningfulTag(word) {
  const w = String(word || '').trim()
  if (!w) return false
  if (w.length < 2 || w.length > 6) return false
  if (!/^[A-Za-z0-9\u4e00-\u9fa5·]+$/.test(w)) return false
  if (/^[0-9]+$/.test(w)) return false
  if (STOP_WORDS.has(w)) return false
  if (TAG_JUNK_WORDS.indexOf(w) !== -1) return false
  if (TAG_HEAD_STOP_CHARS.indexOf(w.charAt(0)) !== -1) return false
  if (TAG_TAIL_STOP_CHARS.indexOf(w.charAt(w.length - 1)) !== -1) return false
  return true
}

/**
 * 从内容中提取标签
 * @param {string} content - 日记正文
 * @param {number} max - 最多标签数（默认5）
 * @param {string[]} [extraWords] - 专名补位词（档案里备案过的人名/机构名/地名）
 * @returns {string[]}
 */
function extractTags(content, max, extraWords) {
  max = max || 5
  if (!content || typeof content !== 'string') return []

  // 清洗：去掉时间戳【xx:xx】、已有#标签、标点符号和数字
  const text = content
    .replace(/【[\s\S]*?】/g, ' ')
    .replace(/[#＃][^\s#]+/g, ' ')
    .replace(/[，。！？、；：""''…·\s\d]/g, ' ')

  const tags = []
  const seen = new Set()

  // 1. 主题词典匹配
  TOPIC_WORDS.forEach(word => {
    if (tags.length >= max) return
    if (seen.has(word)) return
    if (text.indexOf(word) !== -1) {
      tags.push(word)
      seen.add(word)
    }
  })

  // 2. 不足时用「专属名词」补位（档案里备案过的人名 / 机构名 / 地名）
  //    [tagjunk v1] 不再用双字滑窗词频补位 —— 那是碎片词的产房：
  //    「是一家…那是一家」→「一家」「是一」；「比较好的 / 挺好的」→「好的」。
  //    专名比词频可靠得多：四维图新 / 北汽新能源 / 魏杰 这类才是标签该有的样子。
  if (tags.length < max && Array.isArray(extraWords)) {
    for (const raw of extraWords) {
      if (tags.length >= max) break
      const word = String(raw || '').trim()
      if (!word || seen.has(word)) continue
      if (!isMeaningfulTag(word)) continue
      if (text.indexOf(word) === -1) continue
      tags.push(word)
      seen.add(word)
    }
  }

  return tags.slice(0, max)
}

module.exports = {
  extractTags,
  isMeaningfulTag,
  STOP_WORDS,
  TAG_HEAD_STOP_CHARS,
  TAG_TAIL_STOP_CHARS,
  TAG_JUNK_WORDS
}
