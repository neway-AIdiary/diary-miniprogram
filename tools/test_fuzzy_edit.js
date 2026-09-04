/**
 * tools/test_fuzzy_edit.js
 * 指令目标词标点无关模糊匹配回归：
 * 语音识别常在目标词中间误插标点（「去掉王磊在南京」→「去掉王磊，在南京」），
 * apply 精确匹配失败时应做标点无关兜底，仍执行增/改/删。
 * 运行：node tools/test_fuzzy_edit.js
 */
const aiEdit = require('../utils/aiEdit')

let passCount = 0
let failCount = 0

function assert(name, actual, expect) {
  const ok = actual === expect
  if (ok) { passCount++ } else { failCount++ }
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | expect=' + JSON.stringify(expect) + ' actual=' + JSON.stringify(actual)))
}

// ===== 用户报障原案例：删除目标词被语音插入逗号 =====
const diary = '今天上班累了，回家补觉。为了减肥，晚上没有吃晚饭。刚出去跑了5公里，特别累。下周还要去杭州出差。杭州是一个美丽的城市，我有好多同学在里边。王磊在南京，好吧？'

let r = aiEdit.apply(diary, { type: 'remove', from: '王磊，在南京' })
assert('原案例：remove 目标带逗号仍删除「王磊在南京」', r.changed, true)
assert('原案例：正文不再含王磊', r.content.indexOf('王磊') === -1, true)
assert('原案例：句尾「好吧」保留且句号衔接', r.content.slice(-4), '。好吧？')

// detect 全链路：语音识别文本「去掉王磊，在南京」
const edit = aiEdit.detect('去掉王磊，在南京')
assert('detect 识别「去掉王磊，在南京」为 remove 指令', edit && edit.type, 'remove')
r = aiEdit.apply(diary, edit)
assert('全链路：删除成功且正文不再含王磊', r.changed && r.content.indexOf('王磊') === -1, true)

// 空格变体（语音常把逗号识别成空格）
r = aiEdit.apply(diary, { type: 'remove', from: '王磊 在南京' })
assert('remove 目标带空格仍删除', r.changed && r.content.indexOf('王磊') === -1, true)

// ===== 替换指令同理 =====
r = aiEdit.apply(diary, { type: 'replace', from: '王磊，在南京', to: '王磊在上海' })
assert('replace 目标带逗号仍替换', r.changed && r.content.indexOf('王磊在上海') !== -1, true)

// detect 全链路替换：「把杭州，改成苏州」
const e2 = aiEdit.detect('把杭州，改成苏州')
r = aiEdit.apply(diary, e2)
assert('全链路：replace 带逗号锚点仍替换', r.changed && r.content.indexOf('下周还要去苏州出差') !== -1, true)

// ===== 插入锚点同理 =====
r = aiEdit.apply(diary, { type: 'insert', at: '王磊，在南京', pos: 'before', text: '听说' })
assert('insert 锚点带逗号仍命中', r.changed && r.content.indexOf('听说王磊在南京') !== -1, true)

// ===== 不该误删：目标词确实不存在 =====
r = aiEdit.apply(diary, { type: 'remove', from: '王磊，在北京' })
assert('目标真不存在仍返回 notFound', !r.changed && r.reason, 'notFound')

r = aiEdit.apply(diary, { type: 'remove', from: '南京的王磊' })
assert('字序不同不误删', !r.changed && r.reason, 'notFound')

// ===== 精确匹配行为不回退（多出处全删）=====
const text2 = '小王来了。小王又走了。'
r = aiEdit.apply(text2, { type: 'remove', from: '小王' })
assert('精确匹配多出处全删', r.changed && r.content.indexOf('小王') === -1 && r.count, 2)

// 精确优先：目标词与正文完全一致时行为与旧版一致
r = aiEdit.apply(text2, { type: 'replace', from: '小王', to: '小李' })
assert('精确匹配替换全部', r.content, '小李来了。小李又走了。')

// 模糊匹配也是全量：正文两处被标点干扰的词
const text3 = '王磊，在南京玩。后来王磊在南京定居。'
r = aiEdit.apply(text3, { type: 'remove', from: '王磊，在南京' })
assert('模糊匹配两处干扰词全删', r.changed && r.content.indexOf('王磊') === -1, true)
assert('模糊匹配处数统计', r.count, 2)

// 删除后标点清理：「玩。后来」句号应保留、「，玩」合并正常
assert('删除后无连续标点残留', /，，|，，|。，。|。，，/.test(r.content), false)

// ===== 边界：匹配从中间开始不回吐前缀 =====
r = aiEdit.apply('ab王磊在南京', { type: 'remove', from: '王磊，在南京' })
assert('中文前缀场景删除正常', r.content, 'ab')

console.log('\n---\n通过 ' + passCount + ' / 失败 ' + failCount)
process.exit(failCount ? 1 : 0)
