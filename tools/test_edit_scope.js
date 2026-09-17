/**
 * tools/test_edit_scope.js
 * 指令范围限定回归：只改第 N 处 / 最后一个 / 倒数第 N 个 / 第 N 句的 / 最后一句的
 * 运行：node tools/test_edit_scope.js
 */
const aiEdit = require('../utils/aiEdit')

let passCount = 0
let failCount = 0

function ok(name, actual, expect) {
  const pass = actual === expect
  if (pass) { passCount++ } else { failCount++ }
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name +
    (pass ? '' : ' | expect=' + JSON.stringify(expect) + ' actual=' + JSON.stringify(actual)))
}

// ===== A. detect：范围词剥离 + scope 产出 =====
let e = aiEdit.detect('把第一个40分钟替换成50分钟')
ok('A1 把第一个X替换成Y：from 剥掉范围词', e && e.from, '40分钟')
ok('A1 to 正确', e && e.to, '50分钟')
ok('A1 scope.occurrence=1', e && e.scope && e.scope.occurrence, 1)
ok('A1 保留原串供字面优先', e && e.rawFrom, '第一个40分钟')

e = aiEdit.detect('把第2处小王替换成老王')
ok('A2 第2处：from', e && e.from, '小王')
ok('A2 scope.occurrence=2', e && e.scope && e.scope.occurrence, 2)

e = aiEdit.detect('把第二次小王替换成老王')
ok('A3 第二次：from', e && e.from, '小王')
ok('A3 scope.occurrence=2', e && e.scope && e.scope.occurrence, 2)

e = aiEdit.detect('把最后一个40分钟替换成50分钟')
ok('A4 最后一个：from', e && e.from, '40分钟')
ok('A4 scope.occurrence=-1', e && e.scope && e.scope.occurrence, -1)

e = aiEdit.detect('把倒数第二个小王删掉')
ok('A5 倒数第二个删除：type', e && e.type, 'remove')
ok('A5 from', e && e.from, '小王')
ok('A5 scope.occurrence=-2', e && e.scope && e.scope.occurrence, -2)

e = aiEdit.detect('第一句的40分钟替换成50分钟')
ok('A6 第一句的：from', e && e.from, '40分钟')
ok('A6 scope.sentence=1', e && e.scope && e.scope.sentence, 1)

e = aiEdit.detect('把最后一句里的小王删掉')
ok('A7 最后一句里的：type', e && e.type, 'remove')
ok('A7 from', e && e.from, '小王')
ok('A7 scope.sentence=-1', e && e.scope && e.scope.sentence, -1)

e = aiEdit.detect('删除第一句的第二个小王')
ok('A8 句+处叠加：from', e && e.from, '小王')
ok('A8 scope.sentence=1', e && e.scope && e.scope.sentence, 1)
ok('A8 scope.occurrence=2', e && e.scope && e.scope.occurrence, 2)

e = aiEdit.detect('把第2句中的40分钟替换成50分钟')
ok('A9 第2句中的：scope.sentence=2', e && e.scope && e.scope.sentence, 2)
ok('A9 from', e && e.from, '40分钟')

// ===== B. 不该被误剥（原有行为不回退）=====
e = aiEdit.detect('把文中所有小王变成老王')
ok('B1 量词指令 scope 为空', e && e.scope === undefined, true)
ok('B1 from', e && e.from, '小王')

e = aiEdit.detect('把第一句话改成第二句话')
ok('B2「第一句话」是目标词本身（无「的/里」不剥）', e && e.from, '第一句话')

e = aiEdit.detect('把最后一句话删掉')
ok('B3 仍走按位置删句', e && e.type, 'removeSent')

e = aiEdit.detect('把杭州改成苏州')
ok('B4 普通替换 scope 为空', e && e.scope === undefined, true)

// ===== C. apply：只改指定处 =====
const T3 = '小王来了。小王又走了。小王说再见。'
let r = aiEdit.apply(T3, aiEdit.detect('把第一个小王替换成小李'))
ok('C1 只改第 1 处', r.content, '小李来了。小王又走了。小王说再见。')
ok('C1 count=1', r.count, 1)

r = aiEdit.apply(T3, aiEdit.detect('把第2处的小王替换成小李'))
ok('C2 只改第 2 处', r.content, '小王来了。小李又走了。小王说再见。')

r = aiEdit.apply(T3, aiEdit.detect('把最后一个小王替换成小李'))
ok('C3 只改最后一处', r.content, '小王来了。小王又走了。小李说再见。')

r = aiEdit.apply(T3, aiEdit.detect('把倒数第二个小王替换成小李'))
ok('C4 只改倒数第 2 处', r.content, '小王来了。小李又走了。小王说再见。')

r = aiEdit.apply(T3, aiEdit.detect('把第二个小王删掉'))
ok('C5 只删第 2 处', r.content, '小王来了。又走了。小王说再见。')

// 无范围词仍全局（回退保护）
r = aiEdit.apply(T3, aiEdit.detect('把小王替换成小李'))
ok('C6 无范围词仍全部替换', r.content, '小李来了。小李又走了。小李说再见。')
ok('C6 count=3', r.count, 3)

// ===== D. apply：句范围 =====
const S3 = '第一句有苹果。第二句也有苹果。第三句还有苹果。'
r = aiEdit.apply(S3, aiEdit.detect('把第二句的苹果替换成香蕉'))
ok('D1 只改第 2 句', r.content, '第一句有苹果。第二句也有香蕉。第三句还有苹果。')

r = aiEdit.apply(S3, aiEdit.detect('把最后一句的苹果替换成香蕉'))
ok('D2 只改最后一句', r.content, '第一句有苹果。第二句也有苹果。第三句还有香蕉。')

r = aiEdit.apply(S3, aiEdit.detect('第一句的苹果替换成香蕉'))
ok('D3 裸指令句范围', r.content, '第一句有香蕉。第二句也有苹果。第三句还有苹果。')

// 同一句里出现两次 → 句范围内全改
const S2 = '第一句有苹果和苹果。第二句有苹果。'
r = aiEdit.apply(S2, aiEdit.detect('把第一句的苹果替换成香蕉'))
ok('D4 句范围内多处全改', r.content, '第一句有香蕉和香蕉。第二句有苹果。')

// ===== E. 边界：范围越界不误改 =====
r = aiEdit.apply(T3, aiEdit.detect('把第五个小王替换成小李'))
ok('E1 第 5 处不存在 → notFound', !r.changed && r.reason, 'notFound')

r = aiEdit.apply(S3, aiEdit.detect('把第五句的苹果替换成香蕉'))
ok('E2 第 5 句不存在 → notFound', !r.changed && r.reason, 'notFound')

r = aiEdit.apply(S3, aiEdit.detect('把第二句的西瓜换成南瓜'))
ok('E3 词不存在 → notFound', !r.changed && r.reason, 'notFound')

// 目标词存在但不在指定句里 → notFound（不改别的句）
r = aiEdit.apply('第一句有苹果。第二句有香蕉。', aiEdit.detect('把第二句的苹果替换成香蕉'))
ok('E4 词在别的句里 → notFound', !r.changed && r.reason, 'notFound')

// ===== F. 字面优先：范围词与目标词连成的原串真实存在 =====
const P2 = '第一个项目已经完成。第二个项目刚开始。'
e = aiEdit.detect('把第一个项目替换成第三个项目')
ok('F1 detect：from 为「项目」+范围', e && e.from, '项目')
r = aiEdit.apply(P2, e)
ok('F2 正文有「第一个项目」字面 → 按字面替换', r.content, '第三个项目已经完成。第二个项目刚开始。')
ok('F2 usedRaw 标记', r.usedRaw, true)

// 正文无该字面 → 回落到范围语义
r = aiEdit.apply('这个项目已经完成。那个项目刚开始。', e)
ok('F3 无字面 → 按第 1 处「项目」替换', r.content, '这个第三个项目已经完成。那个项目刚开始。')

// ===== G. scopeText 文案 =====
ok('G1 第1处', aiEdit.scopeText({ occurrence: 1 }), '第1处')
ok('G2 最后一处', aiEdit.scopeText({ occurrence: -1 }), '最后一处')
ok('G3 倒数第2处', aiEdit.scopeText({ occurrence: -2 }), '倒数第2处')
ok('G4 第2句', aiEdit.scopeText({ sentence: 2 }), '第2句')
ok('G5 最后一句', aiEdit.scopeText({ sentence: -1 }), '最后一句')
ok('G6 句+处', aiEdit.scopeText({ sentence: 1, occurrence: 2 }), '第1句第2处')
ok('G7 无范围为空串', aiEdit.scopeText(null), '')
ok('G8 上一句', aiEdit.scopeText({ tail: 1 }), '上一句')
ok('G9 前两句', aiEdit.scopeText({ tail: 2 }), '前两句')
ok('G10 前边所有内容', aiEdit.scopeText({ all: 1 }), '前边所有内容')

// ===== H. 中文数字 =====
e = aiEdit.detect('把第十个小王替换成小李')
ok('H1 第十 → occurrence=10', e && e.scope && e.scope.occurrence, 10)
e = aiEdit.detect('把倒数第三个王磊删掉')
ok('H2 倒数第三 → occurrence=-3', e && e.scope && e.scope.occurrence, -3)

// ===== I. 插入指令的范围限定 =====
const I2 = '小明在A点集合。后来在A点吃饭。'
e = aiEdit.detect('在第二个A点前边加上早上')
ok('I1 插入范围：at 剥掉范围词', e && e.at, 'A点')
ok('I1 scope.occurrence=2', e && e.scope && e.scope.occurrence, 2)
let ri = aiEdit.apply(I2, e)
ok('I1 只在第 2 处前插入', ri.content, '小明在A点集合。后来在早上A点吃饭。')

ri = aiEdit.apply(I2, aiEdit.detect('在A点前边加上早上'))
ok('I2 无范围词仍插第一处（回退保护）', ri.content, '小明在早上A点集合。后来在A点吃饭。')

// ===== J. 相对范围词（2026-09-17 决策 4.A）：上一句 / 前两句 / 这两句 / 这句话 =====
// 基准 = 作用域（指令之前已累积的正文）末尾
const J1 = '早上很堵，开了40分钟才到公司。晚上又开了40分钟回家。'
e = aiEdit.detect('把上一句的40分钟替换成50分钟')
ok('J1 「上一句」→ tail=1', e && e.scope && e.scope.tail, 1)
r = aiEdit.apply(J1, e)
ok('J2 只改上一句里的 40分钟（前一处不动）', r.content, '早上很堵，开了40分钟才到公司。晚上又开了50分钟回家。')

e = aiEdit.detect('把这两句里的开心删掉')
ok('J3 「这两句」→ tail=2', e && e.from === '开心' && e.scope && e.scope.tail, 2)
r = aiEdit.apply('今天很开心。明天也要开心。后天难过。', e)
ok('J4 只在最后两句里删「开心」', r.content, '今天很开心。明天也要。后天难过。')

e = aiEdit.detect('删掉这句话')
ok('J5 「这句话」= 上一句', e && e.type === 'removeSent' && e.pos === 'last' && e.count, 1)

e = aiEdit.detect('删掉前边两句')
ok('J6 「前边两句」→ 删最后 2 句', e && e.type === 'removeSent' && e.pos === 'last' && e.count, 2)
r = aiEdit.apply(J1, e)
ok('J7 删掉前边两句', r.content, '早上很堵，')

// ===== K. 宽口径句界（2026-09-17 决策 1.B：任何标点都断句）=====
r = aiEdit.apply('早上很堵，我开车去公司，晴天。', { type: 'removeSent', pos: 'last', offset: 0, count: 1 })
ok('K1 逗号断句：三句话，删最后一句', r.content, '早上很堵，我开车去公司，')

e = aiEdit.detect('把第二句的40分钟换成50分钟')
ok('K2 「第二句」→ sentence=2', e && e.scope && e.scope.sentence, 2)
r = aiEdit.apply('我开车去公司，花了40分钟，很累。', e)
ok('K3 宽口径第 2 句命中（窄口径下不成立）', r.content, '我开车去公司，花了50分钟，很累。')

r = aiEdit.apply('今天很好。！', { type: 'removeSent', pos: 'last', offset: 0, count: 1 })
ok('K4 纯标点片段不占句位、删空不留悬空标点', r.content, '')

// ===== L. 「前边所有内容」（2026-09-17 决策 3.A：替换可用、删除被拒）=====
e = aiEdit.detect('把前边所有内容删掉')
ok('L1 整段删除被拦截', e && e.blockedReason, 'allRemove')
r = aiEdit.apply('今天很好。', e)
ok('L2 拦截后正文零改动', r.changed === false && r.reason, 'allRemove')
e = aiEdit.detect('删掉所有内容')
ok('L3 「所有内容」同样拦截', e && e.blockedReason, 'allRemove')

e = aiEdit.detect('把前边所有内容里的40分钟改成50分钟')
ok('L4 带目标词正常放行（scope.all）', e && e.from === '40分钟' && e.scope && e.scope.all, 1)

e = aiEdit.detect('把所有的开心删掉')
ok('L5 量词「所有的X」不被误当 all 范围，且「的」一并剥离', e && e.from === '开心' && !e.scope, true)
e = aiEdit.detect('把所有的花删掉')
ok('L6 剩余不足 2 字时不剥「的」（防宽泛搜索词）', e && e.from, '的花')

let emb = aiEdit.extractEmbedded('今天很好。把前边所有内容删掉。')
ok('L7 内嵌整段删除被拦截、正文零损失', emb.blocked.length === 1 && !emb.changed, true)
emb = aiEdit.extractEmbedded('早上堵了40分钟，晚上又开了40分钟。把上一句的40分钟换成50分钟。')
ok('L8 内嵌「上一句」只改前一句', emb.content, '早上堵了40分钟，晚上又开了50分钟。')

// ===== M. 数字等价（2026-09-17 决策 2.A）：阿拉伯 = 中文 =====
e = aiEdit.detect('把三十分钟改成50分钟')
r = aiEdit.apply('开车30分钟才到。', e)
ok('M1 中文数字命中正文阿拉伯数字', r.content, '开车50分钟才到。')

e = aiEdit.detect('把30分钟改成50分钟')
r = aiEdit.apply('开车三十分钟才到。', e)
ok('M2 阿拉伯数字命中正文中文数字', r.content, '开车50分钟才到。')

e = aiEdit.detect('把第3个30分钟改成50分钟')
r = aiEdit.apply('30分钟。30分钟。三十分钟。', e)
ok('M3 第 3 处命中「三十分钟」', r.content, '30分钟。30分钟。50分钟。')

e = aiEdit.detect('把第十二处的小王改成老王')
ok('M4 「第十二处」→ 12', e && e.scope && e.scope.occurrence, 12)

// M5~M7 停用保护（2026-09-17 二次决策）：单字数字恢复折算，仅同形常用词不折算
e = aiEdit.detect('把10分改成20分')
r = aiEdit.apply('今天十分开心。', e)
ok('M5 单字「十分」不再被当成 10 分', r.changed === false && r.reason, 'notFound')

e = aiEdit.detect('把十分改成二十分')
r = aiEdit.apply('今天十分开心。', e)
ok('M6 同写法「十分」仍可匹配（不折算 != 不能匹配）', r.content, '今天二十分开心。')

e = aiEdit.detect('把1起删掉')
r = aiEdit.apply('我们一起去。', e)
ok('M7 单字「一起」不被「1起」命中', r.changed === false && r.reason, 'notFound')

e = aiEdit.detect('把120元改成200元')
r = aiEdit.apply('花了一百二十元。', e)
ok('M8 2 字及以上仍跨写法等价（一百二十 = 120）', r.content, '花了200元。')

e = aiEdit.detect('把3个苹果换成5个苹果')
r = aiEdit.apply('买了三个苹果。', e)
ok('M9 单字数字跨写法命中（三个苹果 = 3个苹果）', r.content, '买了5个苹果。')

e = aiEdit.detect('把2小时改成3小时')
r = aiEdit.apply('开会两小时。', e)
ok('M10 「两小时」被指令「2小时」命中', r.content, '开会3小时。')

e = aiEdit.detect('把10个换成20个')
r = aiEdit.apply('买了十个包子。', e)
ok('M11 「十个」被指令「10个」命中', r.content, '买了20个包子。')

e = aiEdit.detect('把3个苹果换成5个苹果')
r = aiEdit.apply('3个苹果和三个苹果。', e)
ok('M12 同篇两种写法一起改', r.content, '5个苹果和5个苹果。')

e = aiEdit.detect('把千里路改成百里路')
r = aiEdit.apply('走了万里路。', e)
ok('M13 光杆「万」不折算（万里 != 千里）', r.changed === false && r.reason, 'notFound')

e = aiEdit.detect('把10分钟改成20分钟')
r = aiEdit.apply('走了十分钟。', e)
ok('M14 「十分钟」不被停用词「十分」误伤', r.content, '走了20分钟。')

e = aiEdit.detect('把30分钟改成50分钟')
r = aiEdit.apply('开了三十分钟。', e)
ok('M15 「三十分钟」同理可命中', r.content, '开了50分钟。')

e = aiEdit.detect('把1000万改成2000万')
r = aiEdit.apply('赚了一千万。', e)
ok('M16 混合写法「1000万」= 正文「一千万」', r.content, '赚了2000万。')

e = aiEdit.detect('把一千万改成两千万')
r = aiEdit.apply('赚了1000万。', e)
ok('M17 反向：中文「一千万」命中正文「1000万」', r.content, '赚了两千万。')

console.log('\n---\n通过 ' + passCount + ' / 失败 ' + failCount)
process.exit(failCount ? 1 : 0)
