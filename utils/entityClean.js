/**
 * utils/entityClean.js
 * 日记正文「名词解释」清理：日记中解释了某个名词并提示备案后，
 * 正文只保留名词本身，解释部分删除。
 *   例：「我今天和王磊，他是我大学同学一起吃的饭」
 *       → 提示备案后正文变为「我今天和王磊一起吃的饭」
 *
 * 输入实体需带 explanation（解释在日记原文中的逐字片段，不含名词本身）。
 * 全程保守策略：定位不到解释原文就跳过，绝不误删正文。
 */

// 名词与解释之间允许的分隔符
const SEP_RE = /^[，,、；;：:\s]*/
// 解释的常见引导词（原文中有、AI 概括时可能漏掉）
const LEADS = ['其实是', '真的是', '他就是', '她就是', '他就是', '就是', '这是', '他是', '她是', '它是', '也是', '正是', '是']

// ===== 名词备案前的机械校验（防 AI 误报）=====
// 定义句式的引导词：名词之后紧跟（允许中间有标点/空白）
const LEAD_AFTER = [
  '其实是', '真的是', '指的是', '他就是', '她就是', '它就是', '这是', '他是', '她是', '它是',
  '也就是', '就是', '也是', '正是', '名叫', '叫做', '名为', '称为', '称作', '叫', '是'
]
// 定义句式的引导词：名词之前紧跟（如「我母亲叫王喜兰」）
const LEAD_BEFORE = ['名叫', '叫做', '名字叫', '名为', '称为', '称作', '叫']
// 助词/功能字：名词里出现即判为非名词（「的第一天」「很快」这类）
const FUNC_CHARS = ['的', '了', '着', '是', '都', '也', '还', '就', '才', '又', '再', '很', '太', '被', '把', '让', '吗', '呢', '吧', '啊', '呀', '嘛', '挺', '更', '最', '不', '没']
// 虚词/时间词/泛称词：AI 容易误当名词的高频词，一律不备案
const NON_NOUN_WORDS = [
  '分别', '一起', '一共', '一直', '主要', '其中', '大概', '可能', '然后', '后来', '开始', '继续', '最后', '首先', '其次', '同时', '另外', '而且', '但是', '因为', '所以', '虽然',
  '已经', '正在', '可以', '应该', '需要', '觉得', '认为', '希望', '准备', '打算', '决定', '真是', '真的', '确实', '很多', '不少', '一些', '这里', '那里', '这个', '那个', '他们', '我们', '你们', '自己', '别人', '明明', '其实', '好像', '似乎', '难道', '居然', '竟然', '果然',
  // [entity-adv-v1] 语气/强调/转折副词与介词（2026-09-20「简直」案例）：标识语气、加强说法、
  // 语义转折流转的虚词一律不备案。均为精确整词匹配，不会误伤含这些字的真实专名（如「果然山」）
  '简直', '实在', '根本', '完全', '毕竟', '显然', '当然', '自然', '几乎', '无非', '依然', '仍然', '突然', '忽然', '终于', '曾经', '正好', '刚好', '恰恰',
  '然而', '不过', '可是', '只是', '就是', '因此', '于是', '接着', '此外', '甚至', '尤其', '特别', '非常', '十分', '极其', '相当', '更加',
  '关于', '由于', '根据', '通过', '按照', '依照', '除了', '对于', '至于', '随着', '沿着', '朝着',
  '怎么', '怎样', '如何', '什么', '这样', '那样',
  '今天', '明天', '昨天', '上午', '中午', '下午', '晚上', '早上', '当时', '现在', '目前', '之后', '之前', '时候', '时间', '地方', '东西', '事情', '情况', '问题', '内容', '部分', '方面', '方式', '结果', '原因', '目的', '办法',
  '公司', '学校', '单位', '朋友', '同事', '同学', '孩子', '家里', '工作', '生活', '状态', '心情', '感觉', '计划', '安排',
  // [entity-vc-v1] 虚词横展（2026-09-20 用户指令）：副词/介词/连词/助词/叹词等虚词整类不备案。
  // 仅收「不含 FUNC_CHARS 功能字」的双音节词（含功能字的已被含字拦截兜住）；
  // 精确整词匹配 + 漏拦方向是「少弹提醒」，即使个别拦宽也绝不误备案、不删正文
  '渐渐', '逐渐', '逐步', '默默', '悄悄', '慢慢', '匆匆', '常常', '往往', '时常', '偶尔', '偶然', '始终', '永远', '暂时', '马上', '立刻', '顿时', '随即', '随后', '起初', '原本', '本来', '原来',
  '难怪', '反倒', '反而', '偏偏', '干脆', '幸亏', '好在', '莫非', '恐怕', '也许', '或许', '大约', '约莫', '俨然', '可惜', '未必', '从未', '毫无',
  '多么', '格外', '稍微', '稍稍', '比较', '较为', '颇为', '极为', '略微',
  '并且', '或者', '以及', '加之', '何况', '况且', '否则', '假如', '如果', '若是', '倘若', '只要', '只有', '无论', '尽管', '即使', '哪怕', '既然', '因而', '从而', '进而', '继而', '乃至', '要是', '如若', '假若',
  '自从', '经由', '凭借', '处于', '位于',
  '而已', '罢了', '之间', '左右', '为何', '何尝',
  '哎哟', '哇塞',
  // [entity-pron-v1] 代词收全（2026-09-20 用户指令）：代词是封闭类，一次收齐
  '大家', '她们', '它们', '咱们', '彼此', '对方', '本身', '他人', '各位', '哪些', '哪样', '这边', '那边', '这么', '那么',
  // [entity-verb-v1] 高频动词（开放类无法穷尽，此表拦日记场景绝大多数；治本靠云函数 prompt 约束）
  '吃饭', '睡觉', '出发', '回家', '到家', '加班', '下班', '开会', '散步', '跑步', '旅行', '出差', '见面', '聊天', '说话', '逛街', '购物', '做饭', '洗澡', '上班',
  '读书', '写字', '看书', '锻炼', '运动', '游泳', '唱歌', '跳舞', '拍照', '打扫', '休息', '生病', '感冒', '发烧', '咳嗽', '住院', '出院', '搬家', '装修', '开车',
  '坐车', '排队', '买票', '起飞', '到达', '离开', '回来', '回去', '出门', '进来', '开始', '结束', '完成', '放弃', '坚持', '努力', '奋斗', '觉得', '认为', '希望',
  '打算', '准备', '决定', '选择', '尝试', '改变', '提升', '思考', '回想', '回忆', '忘记', '记得', '明白', '理解', '同意', '拒绝', '回答', '提问', '讨论', '商量',
  '帮忙', '帮助', '照顾', '陪伴', '等待', '迟到', '请假', '出差错', '道歉', '道谢', '庆祝', '祝福', '送礼', '请客', '做饭菜', '洗碗', '洗衣', '晾晒', '收拾', '整理',
  '打扫卫生', '布置', '安装', '修理', '检查', '维修', '保养', '加油', '充电', '下载', '上传', '保存', '删除', '发送', '接收', '回复', '转发', '评论', '点赞', '关注',
  '取消', '预约', '登记', '报名', '签到', '打卡', '结算', '付款', '退款', '发货', '收货', '退换', '投诉', '咨询', '办理', '审批', '汇报', '总结', '复盘', '培训',
  '面试', '入职', '离职', '晋升', '调岗', '出差了', '接机', '送机', '接站', '接送', '聚会', '聚餐', '约会', '相亲', '婚礼', '葬礼', '扫墓', '祭祖', '拜年', '串门',
  '做客', '接待', '拜访', '参观', '考察', '调研', '采访', '演讲', '汇报了', '表演', '演出', '比赛', '竞争', '合作', '签约', '启动', '发布', '上线', '交付', '验收',
  // [entity-adj-v1] 高频形容词（日记情绪/状态/评价场景优先；开放类，同上靠 prompt 治本）
  '开心', '高兴', '快乐', '幸福', '满意', '生气', '愤怒', '难过', '伤心', '悲伤', '痛苦', '苦恼', '烦恼', '焦虑', '紧张', '担心', '害怕', '恐惧', '惊讶', '惊喜',
  '感动', '激动', '兴奋', '期待', '失望', '绝望', '孤独', '寂寞', '无聊', '疲惫', '疲劳', '辛苦', '忙碌', '清闲', '悠闲', '轻松', '压抑', '沉重', '舒服', '舒适',
  '温暖', '凉爽', '寒冷', '炎热', '潮湿', '干燥', '干净', '整洁', '整齐', '凌乱', '漂亮', '美丽', '帅气', '可爱', '丑陋', '善良', '勇敢', '坚强', '软弱', '聪明',
  '愚蠢', '认真', '马虎', '仔细', '粗心', '耐心', '急躁', '冷静', '疯狂', '安静', '吵闹', '热闹', '热情', '冷淡', '真诚', '虚伪', '诚实', '狡猾', '大方', '小气',
  '慷慨', '吝啬', '乐观', '悲观', '积极', '消极', '特殊', '普通', '平凡', '出色', '优秀', '卓越', '一般', '平常', '简单', '复杂', '容易', '困难', '艰难', '顺利',
  '曲折', '奇怪', '正常', '好吃', '难吃', '好喝', '新鲜', '陈旧', '年轻', '苍老', '健康', '虚弱', '结实', '苗条', '肥胖', '高挑', '矮小', '漫长', '短暂', '匆忙',
  '缓慢', '迅速', '模糊', '清晰', '明亮', '昏暗', '宽敞', '狭窄', '拥挤', '空旷', '遥远', '附近', '重要', '关键', '次要', '宝贵', '廉价', '珍贵', '稀有', '罕见'
]
// 部分引导词互为前缀（如「是」是「指的是」的尾字）：按长度降序匹配，避免短词抢先命中
// 允许紧邻名词左侧的功能字/动词（「和」王磊、「叫」王喜兰…）：除此之外左侧出现汉字即视为子串截取
const PRE_NOUN_CHARS = '和跟与同对的了我你他她它们咱您于在从把被让给找见问说叫带陪还有去来到就也都又再想要会能没不很太以及等是做为'
// 时间词前缀：名词以这些词开头基本是正则过度捕获（「今天杨帆」），不是完整名词
const TIME_PREFIX = ['今天', '明天', '昨天', '后天', '前天', '上午', '中午', '下午', '晚上', '早上', '凌晨', '当时', '现在', '目前']

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)
const LEAD_BEFORE_SORTED = LEAD_BEFORE.slice().sort((a, b) => b.length - a.length)
// [entity-neg-v1] 否定引导词：名词后面跟的是否定句（「明明不是这么说的」「王磊不是坏人」），绝不是定义句 → 直接否决。
// 2026-09-18 用户侧 bug：「我明明不是这么说的。」被 AI 拆出「明明不」+ 余句以「是」开头，误判为定义句弹备案
const NEG_LEADS = ['不是', '不像', '没有', '不算', '不如', '没像', '没成']
const NEG_LEADS_SORTED = NEG_LEADS.slice().sort((a, b) => b.length - a.length)
// [entity-num-v1] 数量词规则拦截（2026-09-20 用户侧 bug：「一个是阆苑仙葩」弹出备案「一个」）：
// 数量词是「数词 × 量词」的有限组合，用规则拦而不是词表枚举，可 100% 覆盖
//   ① 纯数字表达式：百分之一 / 三分之二 / 三十 / 100 / 3.5
//   ② 数词+量词：一个 / 一趟 / 十斤 / 三本 / 几位 / 30分钟 / 第一次
// 量词字符集取常用 80 个；整体锚定（^$），「三里屯/九寨沟/五台山」等含数字的专名不会命中
const NUM_EXPR_RE = /^[0-9零一二三四五六七八九十百千万亿两几点半分之]+$/
const CLS_CHARS = '个只条张本趟斤克吨米寸尺次回遍件名位群批双对副间层行种样点些顿餐步声句段块枚辆艘架台部门户家节课牌圈周滴桩起篇页道项场排班股杆管桶瓶壶杯盘碟箱包袋捆扎令撮丝缕拳圈套沓摞叠打则钟年月日号秒'
const NUM_CLS_RE = new RegExp('^[第]?[0-9零一二三四五六七八九十百千万亿两几]+[' + CLS_CHARS + ']{1,2}$')

/**
 * 判断 AI 提取的「名词 + 解释」是否为真实备案项（机械校验，不依赖模型）
 * 规则：① 名称是 2~6 字、不含助词/功能字 ② 不是虚词/泛称词、不以时间词开头
 *      ③ 名称在原文中真实出现 ④ 原文中存在定义句式（名次前后紧跟引导词）
 *      ⑤ 命中的那处出现位置、左侧边界必须干净（防「从更长专有名词里截出的子串」）
 * @param {string} name AI 提取的名词
 * @param {string} content 日记原文
 * @returns {boolean} true 才允许弹窗备案
 */
function isExplainedNoun(name, content) {
  const n = String(name || '').trim()
  const text = String(content || '')
  if (!n || n.length < 2 || n.length > 6) return false
  // 以时间词开头 → 正则过度捕获的产物（如「今天杨帆」），不是完整名词
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return false
  }
  // 含助词/功能字 → 不是名词（如「的第一天」）
  for (let i = 0; i < FUNC_CHARS.length; i++) {
    if (n.indexOf(FUNC_CHARS[i]) !== -1) return false
  }
  // [entity-num-v1] 数量词 → 不备案（一个/一趟/十斤/百分之一/第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return false
  // 虚词/泛称词 → 不备案
  if (NON_NOUN_WORDS.indexOf(n) !== -1) return false
  // 必须在原文中真实出现（防 AI 编造名词）
  let from = 0
  let idx = text.indexOf(n, from)
  if (idx === -1) return false
  // 逐处出现位置检查是否存在定义句式
  while (idx !== -1) {
    // 左侧边界干净的才作数：原文「中国考古博物馆是一家…」被截成「古博物馆」时，
    // 其前一字符「考」暴露了截取行为，直接否决，避免备案出残缺名词
    if (hasCleanLeftBoundary(text, idx)) {
      const after = text.slice(idx + n.length).replace(SEP_RE, '')
      for (let i = 0; i < NEG_LEADS_SORTED.length; i++) {
        if (after.indexOf(NEG_LEADS_SORTED[i]) === 0) return false
      }
      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {
        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) return true
      }
      const before = text.slice(0, idx)
      for (let i = 0; i < LEAD_BEFORE_SORTED.length; i++) {
        const lead = LEAD_BEFORE_SORTED[i]
        if (before.length >= lead.length && before.slice(before.length - lead.length) === lead) return true
      }
    }
    idx = text.indexOf(n, idx + n.length)
  }
  return false
}

/**
 * 名词左侧边界是否干净：前一字符不是汉字，或属于允许紧邻名词的功能字/动词
 * 用途：拦截「从更长专有名词里截出的子串」（如「中国考古博物馆」→「古博物馆」）
 * @param {string} text 原文
 * @param {number} idx 名词在原文中的起始位置
 * @returns {boolean}
 */
function hasCleanLeftBoundary(text, idx) {
  if (idx <= 0) return true
  const prev = text.charAt(idx - 1)
  if (!/[\u4e00-\u9fa5]/.test(prev)) return true
  return PRE_NOUN_CHARS.indexOf(prev) !== -1
}

/**
 * 删除单个实体的解释部分（只处理第一处出现）
 * @param {string} content 日记正文
 * @param {{name:string, explanation:string}} entity
 * @returns {{content:string, changed:boolean}}
 */
function removeOne(content, entity) {
  const name = String((entity && entity.name) || '').trim()
  const expl = String((entity && entity.explanation) || '').trim()
  if (!name || !expl) return { content: content, changed: false }

  const idx = content.indexOf(name)
  if (idx === -1) return { content: content, changed: false }
  const nameEnd = idx + name.length

  // ---- 后向：解释紧跟在名词后面（最常见）----
  const sepMatch = content.slice(nameEnd).match(SEP_RE)
  const sepLen = sepMatch ? sepMatch[0].length : 0
  const afterSep = nameEnd + sepLen

  // 候选解释片段（按优先级尝试）：
  //   1. explanation 原文逐字匹配
  //   2. 「引导词 + explanation」（AI 概括时漏掉原文引导词，如 原文「他是我大学同学」→ 概括「我的大学同学」）
  //   3. 「我的」还原成「我」再配引导词（概括时统一加了"的"，原文口语可能没有）
  //   4. explanation 去掉开头引导词（AI 把引导词也算进解释）
  const strippedDe = expl.indexOf('我的') === 0 ? '我' + expl.slice(2) : ''
  const candidates = [expl]
  for (const lead of LEADS) {
    candidates.push(lead + expl)
    if (strippedDe) candidates.push(lead + strippedDe)
  }
  if (strippedDe) candidates.push(strippedDe)

  let hit = null
  for (const cand of candidates) {
    if (cand.length < 3) continue
    if (content.startsWith(cand, afterSep)) { hit = cand; break }
  }
  if (!hit) {
    for (const lead of LEADS) {
      if (expl.startsWith(lead)) {
        const tail = expl.slice(lead.length)
        if (tail.length >= 2 && content.startsWith(tail, afterSep)) { hit = tail; break }
      }
    }
  }

  if (hit) {
    // 删除区间：从名词后（含前导分隔符）到解释结尾
    let delEnd = afterSep + hit.length
    let tail = content.slice(delEnd)
    // 解释后紧跟的顿号/逗号原本是隔开「解释」与后文的 → 解释删掉后一并删除
    // （句号/问号/叹号保留，句子边界不动）
    const t = tail.match(/^[，,、]/)
    if (t) {
      delEnd += t[0].length
      tail = content.slice(delEnd)
    }
    return { content: content.slice(0, nameEnd) + tail, changed: true }
  }

  // ---- 前向：解释在名词前面（如「我大学同学王磊今天…」）----
  const before = content.slice(0, idx)
  const sepBeforeMatch = before.match(/[，,、；;：:\s]*$/)
  const sepBeforeLen = sepBeforeMatch ? sepBeforeMatch[0].length : 0
  const explStart = idx - sepBeforeLen - expl.length
  if (explStart >= 0 && content.startsWith(expl, explStart)) {
    return { content: content.slice(0, explStart) + content.slice(idx), changed: true }
  }

  return { content: content, changed: false }
}

/**
 * 清理接缝残留：连续重复标点压成一个、行首孤立标点删除、多余空格压缩
 * 只处理清理动作可能产生的痕迹，不改动正常文本
 */
function tidy(text) {
  return text
    .replace(/[，,]{2,}/g, '，')
    .replace(/[、]{2,}/g, '、')
    .replace(/[。]{2,}/g, '。')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[，,、；;：:]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[，,、]\s*([。！？\n])/g, '$1')
    .trim()
}

/**
 * 批量清理日记正文中的解释部分
 * @param {string} content 日记正文
 * @param {Array<{name:string, explanation:string}>} entities 带原文解释片段的实体
 * @returns {{content:string, changed:boolean, removed:string[]}} removed 为成功删除解释的名词
 */
function removeExplanations(content, entities) {
  let text = String(content || '')
  const removed = []
  const list = Array.isArray(entities) ? entities : []
  for (const e of list) {
    const r = removeOne(text, e)
    if (r.changed) {
      text = r.content
      removed.push(e.name)
    }
  }
  if (removed.length === 0) return { content: content, changed: false, removed: removed }
  const cleaned = tidy(text)
  // 清理后正文为空 → 保留原内容（名词总该留下，不应删空）
  if (!cleaned) return { content: content, changed: false, removed: removed }
  return { content: cleaned, changed: cleaned !== content, removed: removed }
}

module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary }
