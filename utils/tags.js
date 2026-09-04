/**
 * 本地标签提取引擎
 * 根据日记内容自动生成关键词标签（最多5个）
 * 策略：主题词典匹配（优先）→ 双字词频补充 → 去重截断
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

/**
 * 从内容中提取标签
 * @param {string} content - 日记正文
 * @param {number} max - 最多标签数（默认5）
 * @returns {string[]}
 */
function extractTags(content, max) {
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

  // 2. 不足时用双字词频补充（滑窗统计，过滤停用词）
  //    仅采用重复出现≥2次的词，避免切碎的无意义碎片词
  if (tags.length < max) {
    const freq = {}
    for (let i = 0; i < text.length - 1; i++) {
      const w2 = text.substr(i, 2)
      if (!/^[\u4e00-\u9fa5]{2}$/.test(w2)) continue
      if (STOP_WORDS.has(w2)) continue
      freq[w2] = (freq[w2] || 0) + 1
    }
    const sorted = Object.keys(freq)
      .filter(w => freq[w] >= 2)
      .sort((a, b) => freq[b] - freq[a])
    for (const word of sorted) {
      if (tags.length >= max) break
      if (seen.has(word)) continue
      tags.push(word)
      seen.add(word)
    }
  }

  return tags.slice(0, max)
}

module.exports = {
  extractTags,
  STOP_WORDS
}
