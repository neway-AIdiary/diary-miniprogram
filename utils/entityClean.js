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
// 定义句式的引导词：名词之后紧跟（空白可跳过；隔句读标点 = 下一分句，对「叫」见 [entity-jiao v1]）
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
  // [entity-famous v1] 常识级专名不备案（2026-09-24 用户指令：「黄河」是常用词不用提醒备案）。
  // 必须整词匹配——保住「黄河大桥/黄河公园」类组合专名；同族扩展（长江/长城等）等个案出现再加
  '黄河',
  // [entity-sumword v1] 总结连词（2026-09-24 用户指令：「总而言之」不提醒备案）；
  // 含「的/是」等功能字的（简而言之/总的来说/也就是说）已被 FUNC_CHARS 拦，不重复收
  '总而言之', '总之', '综上所述', '由此可见',
  // [entity-loc-v1] 方位词/方位名词整类不备案（2026-09-24 用户指令：「以下是为你介绍的
  // 高中日记10000字」弹备案「以下」——只有人名/地名/事物名称/专用名词才备案）
  '以下', '以上', '以内', '以外', '之外', '中间', '当中', '上方', '下方', '前方', '后方', '左侧', '右侧', '旁边', '四周', '周围', '对面', '上边', '下边', '前边', '后边', '里边', '外边',
  // [entity-vc-v1] 虚词横展（2026-09-20 用户指令）：副词/介词/连词/助词/叹词等虚词整类不备案。
  // 仅收「不含 FUNC_CHARS 功能字」的双音节词（含功能字的已被含字拦截兜住）；
  // 精确整词匹配 + 漏拦方向是「少弹提醒」，即使个别拦宽也绝不误备案、不删正文
  '渐渐', '逐渐', '逐步', '默默', '悄悄', '慢慢', '匆匆', '常常', '往往', '时常', '偶尔', '偶然', '始终', '永远', '暂时', '马上', '立刻', '顿时', '随即', '随后', '起初', '原本', '本来', '原来',
  '难怪', '反倒', '反而', '偏偏', '干脆', '幸亏', '好在', '莫非', '恐怕', '也许', '或许', '大约', '约莫', '俨然', '可惜', '未必', '从未', '毫无',
  '多么', '格外', '稍微', '稍稍', '比较', '较为', '颇为', '极为', '略微',
  '并且', '或者', '以及', '加之', '何况', '况且', '否则', '假如', '如果', '若是', '倘若', '只要', '只有', '无论', '尽管', '即使', '哪怕', '既然', '因而', '从而', '进而', '继而', '乃至', '要是', '如若', '假若',
  '自从', '经由', '凭借', '处于', '位于',
  '而已', '罢了', '之间', '左右', '为何', '何尝', '仅仅', '单单',
  '哎哟', '哇塞',
  // [entity-pron-v1] 代词收全（2026-09-20 用户指令）：代词是封闭类，一次收齐
  '大家', '她们', '它们', '咱们', '彼此', '对方', '本身', '他人', '各位', '哪些', '哪样', '这边', '那边', '这么', '那么',
  // [entity-verb-v1] 高频动词（开放类无法穷尽，此表拦日记场景绝大多数；治本靠云函数 prompt 约束）
  '吃饭', '睡觉', '出发', '回家', '到家', '加班', '下班', '开会', '散步', '跑步', '旅行', '出差', '见面', '聊天', '说话', '逛街', '购物', '做饭', '洗澡', '上班',
  '读书', '写字', '看书', '锻炼', '运动', '游泳', '唱歌', '跳舞', '拍照', '打扫', '休息', '生病', '感冒', '发烧', '咳嗽', '住院', '出院', '搬家', '装修', '开车',
  '坐车', '排队', '买票', '起飞', '到达', '离开', '回来', '回去', '出门', '进来', '开始', '结束', '完成', '放弃', '坚持', '努力', '奋斗', '觉得', '认为', '希望',
  '打算', '准备', '决定', '选择', '尝试', '改变', '提升', '思考', '回想', '回忆', '忘记', '记得', '明白', '理解', '同意', '拒绝', '回答', '提问', '讨论', '商量', '以为', '知道',
  '帮忙', '帮助', '照顾', '陪伴', '等待', '迟到', '请假', '出差错', '道歉', '道谢', '庆祝', '祝福', '送礼', '请客', '做饭菜', '洗碗', '洗衣', '晾晒', '收拾', '整理',
  '打扫卫生', '军训', '布置', '安装', '修理', '检查', '维修', '保养', '加油', '充电', '下载', '上传', '保存', '删除', '发送', '接收', '回复', '转发', '评论', '点赞', '关注',
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
// [entity-advprefix-v1] 副词前缀（2026-09-24 用户侧 bug：「原来我妈只」——副词「原来」与后文
// 拼成碎片，整词表只拦「原来」本体拦不住拼接）。与 TIME_PREFIX 同款逻辑：名词以这些词开头
// 且更长即否决；原野/本田/来福类不含此前缀不受误伤
// [entity-advprefix2-v1] 副词前缀横展（2026-09-25 用户指令「收紧备案提醒」：「终于知道是微信
// 小程序的开发平台登录出了问题」弹备案「终于知道」——副词与后文动词拼成碎片，整词表只拦
// 「终于」本体拦不住拼接）。语气/情态/时间副词开头的串几乎必然是句子碎片，一律前缀否决；
// 「果然」可入真专名（果然山）不收，仍走整词匹配。漏拦方向是少弹提醒，绝不误备案
const ADVERB_PREFIX = ['原来', '原本', '本来', '终于', '居然', '竟然', '明明', '其实', '似乎', '好像', '难道', '毕竟', '简直', '根本', '当然', '几乎', '突然', '忽然']
// [entity-verbobj-v1] 动宾式动词成分（2026-09-25 用户指令：「擦肩，也是一种缘分」
// 弹备案「擦肩」——动宾结构词（动词+宾语语素）是动词不是名词）。含下列成分（子串）
// 即否决，覆盖「擦肩/擦肩而过」类变体；漏拦方向是少弹提醒，绝不误备案
const VERBOBJ_WORDS = ['擦肩']

// [entity-frag-v1] 转折/并列连词开头的「拼接碎片」（2026-09-24 用户侧 bug：AI 把「但总是想着…」
// 截成名词「但总」，紧随的「是」恰好落进定义句引导词 → 误弹备案）。
// 连词开头的 2~6 字串几乎必然是句式碎片，首字命中即否决；
// 极罕见专名会被拦（如「但丁」）——漏拦方向是「少弹提醒」，绝不误备案
// [entity-frag2-v1] 语气副词开头（可/竟/倒/便）同类碎片（2026-09-24「可正是…」截出「可正」）
// [entity-frag3-v1] 疑问/揣测副词首字（怎/岂）同类碎片（2026-09-24「怎料却是个爹不亲、
// 娘不爱的主」截出「怎料却」）；「莫/何」是姓氏字不收（莫言/何雨类人名）
const FRAG_HEAD_CHARS = ['但', '却', '而', '且', '虽', '可', '竟', '倒', '便', '怎', '岂']
// [entity-xing-v1] 「X性」抽象属性词整类不备案（积极性/可能性/重要性/主动性…）：
// 词典常用词，用户不会为它建档案；日记场景以「性」结尾的真实专名几乎不存在
const XING_SUFFIX = '性'
// [entity-date-v1] 日期/时间词整类不备案（2026-09-24 用户侧 bug：「晴今天」——AI 把
// 日期头天气字「晴」与「今天」拼成碎片，整词表只做精确匹配拦不住复合碎片）。
// ① 名词含时间词（子串匹配）即否决；② 数字/汉字 + 年/月/日/号 日期模式否决。
// 漏拦方向：少弹提醒，绝不误备案
// [entity-tailadv-v1] 增补频率/时段时间词（2026-09-24「每天晚上便」碎片：含「每天」即否决）
const DATE_WORDS = ['今天', '明天', '昨天', '今日', '明日', '昨日', '后日', '后天', '前天', '今年', '去年', '明年', '前年', '当年', '当时', '现在', '目前', '今晚', '明晚', '昨晚', '本月', '上月', '下月', '本周', '上周', '下周', '周末', '年初', '年底', '月初', '月末', '每天', '每日', '天天', '整天', '当天', '当日', '次日', '翌日', '日后', '平日', '平时', '白天', '深夜', '半夜', '傍晚', '午后', '清早', '早晨', '凌晨', '每年', '每次', '如今', '至今']
const DATE_PAT_RE = /[0-9零〇一二三四五六七八九十]+(年|月|日|号)/
// [entity-frag2-v1] 连词/代词成分的复合碎片（2026-09-24 用户侧 bug：「因此我们总」——
// 连词+代词+副词拼出的碎片，整词黑名单只做精确匹配拦不住）。含下列成分（子串）即否决：
// 只收「几乎不可能出现在真专名里」的连词与代词；果然/简直这类可入名的词仍保持整词匹配；
// [entity-amen-v1] 方言代词「俺/咱」单字入表（2026-09-24 第四轮：「俺们这嘎达」——
// ASR 变体换字就漏，单字子串一并覆盖 俺们/咱们/俺这/咱这 全部变体）
// [entity-pron2-v1] 人称代词单字入表（2026-09-24 用户侧 bug：「原来我妈只是一个平凡的女人」
// 截出「原来我妈只」——代词成分表只收「我们」类复数拦不住「我妈」。人称代词是封闭类，
// 单字入子串表一并覆盖 我妈/你爸/他哥/她姐 全部变体；真专名含代词字极罕见
// （马耳他类尾字已被代词收尾规则拦），漏拦方向是少弹提醒，绝不误备案
const CONNECT_WORDS = ['因此', '但是', '可是', '因为', '所以', '虽然', '然而', '不过', '然后', '于是', '而且', '并且', '或者', '如果', '既然', '尽管', '即使', '无论', '只要', '只有', '我们', '你们', '他们', '她们', '它们', '咱们', '自己', '另外', '俺', '咱', '我', '你', '他', '她', '它']
// [entity-freq-v1] 频率/情态副词成分（2026-09-24 用户侧 bug 第二轮：「他通常是晚上跑步」
// 弹「通常」、「母亲总是起得很早」弹「母亲总」——副词本体或「名词+副词」拼接碎片，
// 紧随的「是」凑成定义句形状）。含下列成分（子串）即否决；表内词不会出现在真专名中
const FREQ_ADV_WORDS = ['通常', '总是', '经常', '常常', '往往', '从来', '偶尔', '偶然', '有时', '一直', '似乎', '仿佛', '充其量', '顶多', '至多']
// [entity-tailadv-v1] 副词收尾的「X便/X即」碎片（2026-09-24 用户侧 bug：「每天晚上便」
// 「风雨之后便」——AI 把时间短语与副词「便」拼成名词，紧随的「是」构成「便是/即是」
// 被当成定义句）。以这些字收尾的 2~6 字串几乎必然是碎片；张总/李总类称呼（尾字「总」）
// 与常见人名尾字（刚/正/永/常…）不在表内，不受误伤
// [entity-tailadv2-v1] 增补「只/仅」收尾（2026-09-24 用户侧 bug：「原来我妈只」——范围副词
// 收尾的拼接碎片；就/都/也等已在 FUNC_CHARS，只/仅补齐）。真专名以只/仅收尾几乎不存在，
// 漏拦方向是少弹提醒，绝不误备案
const TAIL_ADV_CHARS = ['便', '即', '竟', '倒', '亦', '皆', '均', '先', '已', '早', '曾', '只', '仅']
// [entity-loc2-v1] 方位字收尾的方位短语（2026-09-24 用户侧 bug：「村后是一片竹林」弹备案
// 「村后」——「名词语素+方位字」是方位短语不是名词本体）。这些字收尾的 2~6 字串几乎
// 不可能是真专名（汉中/汕头/阿里类尾字 中/头/里 不在表内，不受误伤）
const TAIL_LOC_CHARS = ['后', '前', '上', '下', '左', '右', '内', '外', '旁', '侧', '底']
// [entity-tailtime-v1] 「X时」收尾的时间从句碎片（2026-09-24 用户侧 bug：「妹妹吵架时是一条
// 心的」被截成名词「妹妹吵架时」——「X时」是时间状语从句不是名词本体，DATE_WORDS 只收
// 「当时/平时」等整词拦不住裸「时」）。以「时」收尾的 2~6 字串几乎不可能是真专名，
// 漏拦方向是少弹提醒，绝不误备案
const TAIL_TIME_CHARS = ['时']
// [entity-compare-v1] 比较句/强调句否决（2026-09-24 用户侧 bug：「智商是完全不一样的」——
// 名词后紧跟「是」落进定义句引导词，但这实为「X是……的」比较/强调句，不是在解释名词）。
// ① 同句含比较标记 → 不是定义句；② 同句以「的」收尾且非人称领属（保住「王磊是我的大学
// 同学」这类真定义）→ 强调句不判定义。漏拦方向：少弹提醒，绝不误备案
const COMPARE_MARKS = ['不一样', '不同', '一样', '类似', '差不多']
const PRON_DE_RE = /(我|你|他|她|它|咱)(们)?的$/
// [entity-report-v1] 言说/叙述动词 + 代词拼出的「假名词」（2026-09-24 用户侧 bug：
// 「妈妈说这是豆子在呼吸」被 AI 抽出名词「妈妈说这」——动词+代词的叙述碎片不是名词本体）
const NARR_WORDS = ['说', '讲', '写', '画', '描述', '告诉']
// [entity-generic v1] 常用泛称/抽象词成分（2026-09-24 用户指令：「黄河」「论证」是常用词，
// 不提醒备案）。「论证/事迹」走子串拦「论证事迹」类拼接碎片；「黄河」是常识级地名、
// 走 NON_NOUN_WORDS 整词（见 [entity-famous v1]）。两词不会出现在真专名中，符合收词纪律
const GENERIC_SUBS = ['论证', '事迹']
// 「X说的是/告诉我是/写的是/画的是/描述的是/说这是」：紧随的「是」属于转述引导，
// 后面跟的是说话内容不是定义句
const REPORTING_LEAD_RE = /(说|讲|写|画|描述|告诉)(的|我|你|他|她|它|们|这|那)?是$/
// [entity-jiao v1] 「叫」后紧跟动态助词/人称代词 → 喊/使令义，不是命名（2026-09-24 用户指令：
// 「叫」的意思不是「是」，是喊和说；只有「叫」的是人名/地名/建筑名/设施名才弹）。
// 注意 after 以命中的引导词开头，故锚点含「叫」字头
const JIAO_STOP_RE = /^叫(了|着|过|住|[我你他她它咱])/
// [entity-jiao v1] 「叫」与名词之间的句读标点：叫属于下一分句（用户指令：叫前面有标点不弹）
const JIAO_SEP_RE = /[，,、；;：:]/
// [entity-expl-v1] 解释原文核对（2026-09-24 用户侧 bug：弹窗「军训/我们这嗨达/另外一项任务/
// 仅仅」四条的解释全是 AI 编造，原文里根本没有）。模块契约本要求 explanation 为原文逐字
// 片段——违约即按幻觉处理，整条否决。复用 removeOne 的候选容错（引导词补全 / 去「我的」），
// 旧数据无 explanation 时不据此否决。漏拦方向：少弹提醒，绝不误备案
function explanationInText(explanation, text) {
  const expl = String(explanation || '').trim()
  if (!expl) return true
  const strippedDe = expl.indexOf('我的') === 0 ? '我' + expl.slice(2) : ''
  const cands = [expl]
  for (let i = 0; i < LEADS.length; i++) {
    cands.push(LEADS[i] + expl)
    if (strippedDe) cands.push(LEADS[i] + strippedDe)
  }
  if (strippedDe) cands.push(strippedDe)
  for (let i = 0; i < LEADS.length; i++) {
    if (expl.indexOf(LEADS[i]) === 0) {
      const tail = expl.slice(LEADS[i].length)
      if (tail.length >= 2) cands.push(tail)
    }
  }
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].length < 3) continue
    if (text.indexOf(cands[i]) !== -1) return true
  }
  return false
}

const LEAD_AFTER_SORTED = LEAD_AFTER.slice().sort((a, b) => b.length - a.length)
const LEAD_BEFORE_SORTED = LEAD_BEFORE.slice().sort((a, b) => b.length - a.length)
// [entity-neg-v1] 否定引导词：名词后面跟的是否定句（「明明不是这么说的」「王磊不是坏人」），绝不是定义句 → 直接否决。
// 2026-09-18 用户侧 bug：「我明明不是这么说的。」被 AI 拆出「明明不」+ 余句以「是」开头，误判为定义句弹备案
// [entity-whether v1] 2026-09-24 用户侧 bug：「明神大陆是否再次矛头相接」弹「明神大陆」——
// 「是否」开头的疑问/选择句不是定义句（「是」字兜底引导词误命中）。并入本表：命中即整条否决
const NEG_LEADS = ['不是', '不像', '没有', '不算', '不如', '没像', '没成', '是否']
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
function isExplainedNoun(name, content, explanation) {
  const n = String(name || '').trim()
  const text = String(content || '')
  if (!n || n.length < 2 || n.length > 6) return false
  // [entity-expl-v1] 解释原文核对：explanation 定位不到原文 = AI 幻觉 → 整条否决
  if (!explanationInText(explanation, text)) return false
  // 以时间词开头 → 正则过度捕获的产物（如「今天杨帆」），不是完整名词
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return false
  }
  // [entity-advprefix-v1] 副词开头碎片（原来X/原本X/本来X）→ 不是名词本体
  for (let i = 0; i < ADVERB_PREFIX.length; i++) {
    if (n.length > ADVERB_PREFIX[i].length && n.indexOf(ADVERB_PREFIX[i]) === 0) return false
  }
  // 含助词/功能字 → 不是名词（如「的第一天」）
  for (let i = 0; i < FUNC_CHARS.length; i++) {
    if (n.indexOf(FUNC_CHARS[i]) !== -1) return false
  }
  // [entity-num-v1] 数量词 → 不备案（一个/一趟/十斤/百分之一/第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return false
  // [entity-frag-v1] 连词开头碎片（但总/却总…）→ 不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return false
  // [entity-xing-v1] 「X性」抽象属性词（积极性/可能性…）→ 整类不备案
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return false
  // [entity-date-v1] 含日期/时间词或日期模式（晴今天/2023年5月/3月8日）→ 不是名词本体
  for (let i = 0; i < DATE_WORDS.length; i++) {
    if (n.indexOf(DATE_WORDS[i]) !== -1) return false
  }
  if (DATE_PAT_RE.test(n)) return false
  // [entity-frag2-v1] 含连词/代词成分（因此我们总）→ 拼接碎片不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return false
  }
  // [entity-freq-v1] 含频率/情态副词成分（通常/母亲总）→ 拼接碎片不是名词本体
  for (let i = 0; i < FREQ_ADV_WORDS.length; i++) {
    if (n.indexOf(FREQ_ADV_WORDS[i]) !== -1) return false
  }
  // 3 字以上以「总」收尾（母亲总/我们总）→ 拼接碎片；张总/李总类 2 字称呼保留
  if (n.length >= 3 && n.charAt(n.length - 1) === '总') return false
  // [entity-tailadv-v1] 副词收尾（每天晚上便/风雨之后便）→ 不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false
  // [entity-loc2-v1] 方位字收尾（村后/桌上/门前）→ 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false
  // [entity-tailtime-v1] 「X时」收尾（妹妹吵架时/放学时）→ 时间从句不是名词本体
  if (TAIL_TIME_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return false
  // [entity-report-v1] 假名词否决：含言说动词（说/讲/写/画/描述/告诉）或以「这/那」收尾
  // → 「妈妈说这」这类叙述碎片不是名词本体（2026-09-24 用户侧 bug）
  for (let i = 0; i < NARR_WORDS.length; i++) {
    if (n.indexOf(NARR_WORDS[i]) !== -1) return false
  }
  // [entity-verbobj-v1] 动宾式动词成分（擦肩/擦肩而过）→ 是动词不是名词本体
  for (let i = 0; i < VERBOBJ_WORDS.length; i++) {
    if (n.indexOf(VERBOBJ_WORDS[i]) !== -1) return false
  }
  // [entity-generic v1] 常用泛称/抽象词成分（论证/论证事迹/事迹）→ 不是专名本体
  for (let i = 0; i < GENERIC_SUBS.length; i++) {
    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return false
  }
  const tailChar = n.charAt(n.length - 1)
  // [entity-tailpron v1] 2026-09-24 用户侧 bug：「娶她是为了羞辱她」弹「娶她」——动词+人称
  // 代词根本不是名词。以人称代词收尾的一律否决（「马耳他」类极罕见专名宁可少弹：
  // 项目原则 = 漏拦方向是少弹提醒，绝不误备案）
  if (tailChar === '这' || tailChar === '那') return false
  if ('她它你我他们'.indexOf(tailChar) !== -1) return false
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
      // [entity-report-v1] 转述引导（说的是/告诉我是/写的是/画的是/描述的是/说这是…）：
      // 引导词后面的「是」属于转述，名词后面的内容是说话内容不是定义 → 此出现位置整体跳过
      const before = text.slice(0, idx)
      const reporting = REPORTING_LEAD_RE.test(before)
      let leadHit = null
      for (let i = 0; i < LEAD_AFTER_SORTED.length; i++) {
        if (after.indexOf(LEAD_AFTER_SORTED[i]) === 0) { leadHit = LEAD_AFTER_SORTED[i]; break }
      }
      // [entity-jiao v1] 「叫」是喊/说义不是「是」义（2026-09-24 用户指令）：①叫与名词之间
      // 隔句读标点 → 叫属于下一分句；②叫后紧跟动态助词/人称代词（叫我/叫了/叫住）→ 使令转述。
      // 两者都只跳过此出现位置；「叫」+人名/地名/建筑/设施名仍可弹（如「我姐夫叫王磊」）
      const jiaoBlocked = leadHit === '叫' &&
        (JIAO_SEP_RE.test(text.slice(idx + n.length).match(SEP_RE)[0]) || JIAO_STOP_RE.test(after))
      if (leadHit && !reporting && !jiaoBlocked) {
        // [entity-compare-v1] 名词后接「是」还要看整句性质：比较句/强调句不判定义，
        // 只跳过此出现位置继续找下一处（另一处若是真定义仍可备案）
        const sentM = text.slice(idx).match(/^[\s\S]*?[。！？!?\n]/)
        const sent = (sentM ? sentM[0] : text.slice(idx)).replace(/[。！？!?\n]+$/, '')
        let isCompare = false
        for (let i = 0; i < COMPARE_MARKS.length; i++) {
          if (sent.indexOf(COMPARE_MARKS[i]) !== -1) { isCompare = true; break }
        }
        if (!isCompare && sent.charAt(sent.length - 1) === '的' && !PRON_DE_RE.test(sent)) isCompare = true
        // [entity-particle-v1] 疑问/揣测语气（吧/吗）收尾 → 是问句或揣测，不是解释名词（2026-09-24 用户指令）
        if (!isCompare && (sent.charAt(sent.length - 1) === '吧' || sent.charAt(sent.length - 1) === '吗')) isCompare = true
        if (!isCompare) return true
      }
      if (!reporting) {
        for (let i = 0; i < LEAD_BEFORE_SORTED.length; i++) {
          const lead = LEAD_BEFORE_SORTED[i]
          if (before.length >= lead.length && before.slice(before.length - lead.length) === lead) return true
        }
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
 * [person-hotword A'] 判断名称是否**明确不是名词本体**：虚词 / 代词 / 动词 / 形容词 /
 * 数量词 / 时间词前缀。只做「否决」不做「肯定」—— 复用本模块既有的全部词表与数量词规则，
 * 保证与备案链路同一口径（改一处两边同时变）。
 * 用途：AI 抽人名时的语义级过滤（人名比"被解释的名词"宽得多，所以这里只拦明确不是名字的）。
 * @param {string} name 待判定名称
 * @returns {boolean} true 表示应丢弃
 */
function isNonNounWord(name) {
  const n = String(name || '').trim()
  if (!n) return true
  if (n.length < 2 || n.length > 6) return true
  // 时间词前缀（「今天杨帆」这类正则过度捕获）
  for (let i = 0; i < TIME_PREFIX.length; i++) {
    if (n.length > TIME_PREFIX[i].length && n.indexOf(TIME_PREFIX[i]) === 0) return true
  }
  // 含助词/功能字
  for (let i = 0; i < FUNC_CHARS.length; i++) {
    if (n.indexOf(FUNC_CHARS[i]) !== -1) return true
  }
  // 数量词（一个 / 十斤 / 百分之一 / 第一次）
  if (NUM_EXPR_RE.test(n) || NUM_CLS_RE.test(n)) return true
  // [entity-frag-v1] 连词开头碎片 / [entity-xing-v1]「X性」抽象词 → 明确不是名词本体
  if (FRAG_HEAD_CHARS.indexOf(n.charAt(0)) !== -1) return true
  // [entity-advprefix-v1] 同口径：副词开头碎片（原来X）→ 明确不是名词本体
  for (let i = 0; i < ADVERB_PREFIX.length; i++) {
    if (n.length > ADVERB_PREFIX[i].length && n.indexOf(ADVERB_PREFIX[i]) === 0) return true
  }
  if (n.length > 1 && n.charAt(n.length - 1) === XING_SUFFIX) return true
  // [entity-date-v1] 同口径：含日期/时间词或日期模式 → 明确不是名词本体
  for (let i = 0; i < DATE_WORDS.length; i++) {
    if (n.indexOf(DATE_WORDS[i]) !== -1) return true
  }
  if (DATE_PAT_RE.test(n)) return true
  // [entity-frag2-v1] 同口径：含连词/代词成分 → 明确不是名词本体
  for (let i = 0; i < CONNECT_WORDS.length; i++) {
    if (n.indexOf(CONNECT_WORDS[i]) !== -1) return true
  }
  // [entity-freq-v1] 同口径：含频率/情态副词成分 → 明确不是名词本体
  for (let i = 0; i < FREQ_ADV_WORDS.length; i++) {
    if (n.indexOf(FREQ_ADV_WORDS[i]) !== -1) return true
  }
  // 3 字以上以「总」收尾（母亲总/我们总）→ 拼接碎片；张总/李总类 2 字称呼保留
  if (n.length >= 3 && n.charAt(n.length - 1) === '总') return true
  // [entity-tailadv-v1] 同口径：副词收尾 → 明确不是名词本体
  if (TAIL_ADV_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true
  // [entity-loc2-v1] 同口径：方位字收尾 → 方位短语不是名词本体
  if (TAIL_LOC_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true
  // [entity-tailtime-v1] 同口径：「X时」收尾 → 时间从句不是名词本体
  if (TAIL_TIME_CHARS.indexOf(n.charAt(n.length - 1)) !== -1) return true
  // [entity-report-v1] 人名热词同口径：叙述碎片（妈妈说这）不是名字本体
  for (let i = 0; i < NARR_WORDS.length; i++) {
    if (n.indexOf(NARR_WORDS[i]) !== -1) return true
  }
  // [entity-verbobj-v1] 人名热词同口径：动宾式动词成分（擦肩）不是名字本体
  for (let i = 0; i < VERBOBJ_WORDS.length; i++) {
    if (n.indexOf(VERBOBJ_WORDS[i]) !== -1) return true
  }
  // [entity-generic v1] 人名热词同口径：常用泛称/抽象词（论证/事迹）不是名字本体
  for (let i = 0; i < GENERIC_SUBS.length; i++) {
    if (n.indexOf(GENERIC_SUBS[i]) !== -1) return true
  }
  const tailChar = n.charAt(n.length - 1)
  if (tailChar === '这' || tailChar === '那') return true
  // [entity-tailpron v1] 人名热词同口径：人称代词收尾（娶她/打他/陪你）不是名字本体
  if ('她它你我他们'.indexOf(tailChar) !== -1) return true
  // 虚词 / 代词 / 高频动词 / 高频形容词表
  if (NON_NOUN_WORDS.indexOf(n) !== -1) return true
  return false
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

module.exports = { removeExplanations, removeOne, tidy, isExplainedNoun, hasCleanLeftBoundary, isNonNounWord, explanationInText }
