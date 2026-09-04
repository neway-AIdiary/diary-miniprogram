// tools/test_ai_clean.js
// AI 输出兜底清洗回归：文末心情标注行剥离
// 运行：node tools/test_ai_clean.js

const { stripMoodTail } = require('../utils/aiCloud.js')

let pass = 0, fail = 0
function assert(name, got, want) {
  if (got === want) {
    pass++
    console.log('  ok -', name)
  } else {
    fail++
    console.log('  FAIL -', name)
    console.log('    got :', JSON.stringify(got))
    console.log('    want:', JSON.stringify(want))
  }
}

console.log('[1] 文末心情行剥离')
assert('剥「今天的心情：开心」', stripMoodTail('今天去公园散步了。\n今天的心情：开心'), '今天去公园散步了。')
assert('剥「当天心情：平淡」', stripMoodTail('今天去公园散步了。\n当天心情：平淡'), '今天去公园散步了。')
assert('剥「心情：温暖」', stripMoodTail('今天去公园散步了。\n心情：温暖'), '今天去公园散步了。')
assert('剥「今天心情:开心」(半角冒号)', stripMoodTail('今天去公园散步了。\n今天心情:开心'), '今天去公园散步了。')
assert('剥多行连续心情', stripMoodTail('正文。\n心情：温暖\n今天的心情：开心'), '正文。')
assert('正文中间的心情行不剥', stripMoodTail('今天的心情：不错，去公园了。\n然后回家了。'), '今天的心情：不错，去公园了。\n然后回家了。')
assert('正文句末不以句读结尾的真实行不误剥', stripMoodTail('她说今天的心情：开心极了'), '她说今天的心情：开心极了')
assert('无心情行原样', stripMoodTail('今天去公园散步了。'), '今天去公园散步了。')
assert('心情行带句号结尾不剥（疑似正文）', stripMoodTail('今天去公园散步了。\n今天的心情：开心。'), '今天去公园散步了。\n今天的心情：开心。')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
