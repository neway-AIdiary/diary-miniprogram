// tools/test_punct.js
// 语音标点规范化回归测试（标准中文断句）：
//   半角→全角；连续/混用标点折叠成一个；逗号是逗号、句号是句号；保护小数/网址
// 运行：node tools/test_punct.js

const vf = require('../utils/voiceFilter.js')

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

console.log('[1] normalizePunct 基本折叠')
assert('连续句号折叠', vf.normalizePunct('今天下雨了。。然后我去了公司'), '今天下雨了。然后我去了公司')
assert('句号后空格清理', vf.normalizePunct('今天下雨了。 然后我去了公司'), '今天下雨了。然后我去了公司')
assert('逗号句号混用取句号', vf.normalizePunct('小王，。他说他到了'), '小王。他说他到了')
assert('句号逗号混用取句号', vf.normalizePunct('小王。，他说他到了'), '小王。他说他到了')
assert('连续逗号折叠', vf.normalizePunct('小王，，他说他到了'), '小王，他说他到了')
assert('顿号保持顿号', vf.normalizePunct('苹果、香蕉、橘子'), '苹果、香蕉、橘子')
assert('全半角分号→分号', vf.normalizePunct('天气不错;后来下雨了'), '天气不错；后来下雨了')
assert('半角逗号转全角', vf.normalizePunct('你好,世界'), '你好，世界')
assert('半角问号感叹号转全角', vf.normalizePunct('真的吗!太好了?'), '真的吗！太好了？')
assert('感叹问号混用取末位', vf.normalizePunct('真的吗!?'), '真的吗？')
assert('多余感叹号折叠', vf.normalizePunct('太好了!!!'), '太好了！')
assert('半角冒号转全角', vf.normalizePunct('王新伟:本人'), '王新伟：本人')
assert('普通单句号不受影响', vf.normalizePunct('今天天气很好。'), '今天天气很好。')
assert('无标点文本原样', vf.normalizePunct('今天天气很好'), '今天天气很好')
assert('多个省略号折叠', vf.normalizePunct('然后呢……你说……'), '然后呢……你说……')

console.log('[2] 数字与网址保护')
assert('小数点位不动', vf.normalizePunct('跑了3.5公里，用了2.0小时'), '跑了3.5公里，用了2.0小时')
assert('网址点不动', vf.normalizePunct('官网是www.a.com'), '官网是www.a.com')
assert('版本号不动', vf.normalizePunct('v1.2.3版本'), 'v1.2.3版本')

console.log('[3] 通过 purify 整链生效')
assert('purify 整链（含句号折叠）', vf.purify('嗯。。今天开了会。 然后去见了客户。').text, '今天开了会。然后去见了客户。')
assert('purify 整链（混用折叠）', vf.purify('对，。对对对，。就这样，。。').text, '对。对。就这样。')
assert('purify 保留正常句读', vf.purify('我今天去了公园，天气很好。然后回家吃饭了。').text, '我今天去了公园，天气很好。然后回家吃饭了。')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
