/**
 * 日记素材自动补全（utils/quoteAsk.js）回归测试（纯 Node，无需小程序环境）
 *
 * 守护 8 件事：
 *  1) **误识别反例矩阵**（≥25 条，最重要）：普通叙述、改文指令、文字实体对象一律不触发
 *  2) 触发词矩阵：全文组 / 续写组 / 单句组 / 检索组 / 兜底标记
 *  3) 素材锚点：书名号 / 池内篇名 / 引号句 / 人名库 / 文体词 / 名句片段
 *  4) 归类定级：篇名 + 检索式 → 补全优先；标记 → 强制类别
 *  5) strip：指令句必须从正文剥离（幂等：第二次点优化不会再命中）
 *  6) 池内直出：findByAnchor / findByTopic 命中 → 不经云 AI；续写要裁掉已写部分
 *  7) 输出契约：版本 B（原文 + 「—— 出处」行）、长度档、超限裁剪
 *  8) 接线护栏：write.js 判定位置 / aiCloud 降级链「绝不瞎拼」/ 云函数无出处不出
 *  9) [genre-v1] 人物与文体分离：「惜春的判词」不得被当成「作者=惜春、篇名=判词」
 *     —— 那会让模型拿同回目同人物的《虚花悟》（曲）顶替判词；云端 prompt 须区分同名系列文本
 *
 * 用法：node tools/test_quote_ask.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const qa = require(path.join(ROOT, 'utils/quoteAsk.js'))
const dq = require(path.join(ROOT, 'utils/dailyQuote.js'))

let pass = 0
let fail = 0
const lines = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    lines.push('  ✓ ' + name)
  } else {
    fail++
    lines.push('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function section(title) {
  lines.push('')
  lines.push('[' + title + ']')
}

// ============================================================
// 1. 误识别反例矩阵（最重要：必须全部不触发）
// ============================================================
section('反例矩阵：普通叙述 / 改文指令 / 文字实体（必须全部不触发）')

const NEG_CASES = [
  // —— 日记常用语（明确不收）——
  ['今天没写完，明天继续往下写', 'neg-continue'],
  ['今天有点累，明天接着往下写吧', 'neg-continue'],
  // —— 补充对象是「文字实体」——
  ['把这段话补充完整', 'neg-text-obj'],
  ['把这句话补充一下', 'neg-text-obj'],
  ['帮我补充下这一段想法', 'neg-text-obj'],
  ['帮我补充一下这一段想法', 'neg-text-obj'],
  ['这段文字帮我补充完整', 'neg-text-obj'],
  ['这段开头再补充完整一点', 'neg-text-obj'],
  ['把结尾补充完整', 'neg-text-obj'],
  ['语气再补充完整一些', 'neg-text-obj'],
  ['这段内容再补充完整些', 'neg-text-obj'],
  ['【名言】把这句话补充一下', 'neg-text-obj'],
  ['【诗文】帮我补充下这里的描述', 'neg-text-obj'],
  // —— 改文指令（交给 aiEdit）——
  ['把古文删掉再补充完整', 'neg-edit'],
  ['这段引文替换成别的再补充完整', 'neg-edit'],
  // —— 有触发词但没有任何素材锚点 ——
  ['续上后边几句', 'no-anchor'],
  ['接后面的话', 'no-anchor'],
  ['补下一句', 'no-anchor'],
  ['帮我续上后边几句', 'no-anchor'],
  ['补充一下明天要做的事', 'no-anchor'],
  ['帮我补充一下今天的支出记录', 'no-anchor'],
  // —— 普通叙述（连触发词都不该命中）——
  ['今天心情像首诗一样', 'no-trigger'],
  ['这本书里引用了很多古文', 'no-trigger'],
  ['惜春的判词我背不下来', 'no-trigger'],
  ['今天开会开到很晚，回来补充了一下会议记录，明天继续', 'no-trigger'],
  ['我今天删掉了一个旧习惯', 'no-trigger'],
  ['早上去公园跑了五公里，很累但很满足', 'no-trigger'],
  ['把上一句删掉', 'no-trigger'],
  ['把《静夜思》里的黄字改成白字', 'no-trigger'],
  ['明天要把工作计划补充完整吗', 'no-anchor']
]

let negHit = []
NEG_CASES.forEach(function (c) {
  const r = qa.detect(c[0])
  if (r.hit) negHit.push(c[0])
})
ok('反例矩阵共 ' + NEG_CASES.length + ' 条，全部不触发', negHit.length === 0, negHit.join(' / '))
ok('反例矩阵规模 ≥25', NEG_CASES.length >= 25, 'got ' + NEG_CASES.length)

// 否决原因要「指名道姓」，不能靠 no-trigger 蒙混过关（保证闸门真的有牙齿）
NEG_CASES.forEach(function (c) {
  const r = qa.detect(c[0])
  ok('反例原因准确：' + c[0].slice(0, 14) + '… → ' + c[1], r.reason === c[1], 'got ' + r.reason)
})

// ============================================================
// 2. 正例矩阵
// ============================================================
section('正例矩阵：四类素材都能触发')

const POS_CASES = [
  // 全文组
  ['把《静夜思》补充完整', 'full', 'poem'],
  ['韩愈的师说很好，补充全文', 'full', 'poem'],
  ['【诗文】把静夜思补全', 'full', 'poem'],
  ['《论语》那句补齐全文', 'full', 'quote'],
  // 续写组
  ['帮我续上后边几句，床前明月光', 'nextFew', 'poem'],
  ['李白那句静夜思后面是什么', 'nextFew', 'poem'],
  ['《长歌行》接后面句子', 'nextFew', 'poem'],
  // 单句组
  ['把《长歌行》补下一句', 'nextOne', 'poem'],
  ['《静夜思》加上后边一句', 'nextOne', 'poem'],
  // 检索组
  ['尼采说过那句关于生活的什么话来着，你帮我补充一下', 'lookup', 'quote'],
  ['有没有关于珍惜当下的名言，帮我补一句', 'lookup', 'quote'],
  ['惜春的判词是什么来着，帮我补充一下', 'full', 'poem']
]
POS_CASES.forEach(function (c) {
  const r = qa.detect(c[0])
  ok('正例触发：' + c[0].slice(0, 16) + '…', r.hit === true, r.reason)
  ok('  ↳ 范围/类别：' + c[1] + ' / ' + c[2], r.mode === c[1] && r.kind === c[2], 'got ' + r.mode + ' / ' + r.kind)
})

// ============================================================
// 3. 素材锚点与目标解析
// ============================================================
section('锚点与目标解析')

const rNietzsche = qa.detect('尼采说过那句关于生活的什么话来着，你帮我补充一下')
ok('人名锚点 D 命中 尼采', rNietzsche.anchors.some(a => a.type === 'D' && a.value === '尼采'))
ok('检索主题词解析为「生活」', rNietzsche.target.keyword === '生活', JSON.stringify(rNietzsche.target))
ok('检索类不臆造篇名（target.title 必须为空）', rNietzsche.target.title === '', 'got ' + rNietzsche.target.title)

const rXichun = qa.detect('惜春的判词是什么来着，帮我补充一下')
ok('[genre-v1] 「判词」是文体不是篇名（title 必须为空）', rXichun.target.title === '', 'got ' + rXichun.target.title)
ok('[genre-v1] 「惜春的判词」→ 人物=惜春 / 文体=判词',
  rXichun.target.person === '惜春' && rXichun.target.genre === '判词', JSON.stringify(rXichun.target))
ok('[genre-v1] 人物不算作者（author 必须为空，作者是曹雪芹）', rXichun.target.author === '', 'got ' + rXichun.target.author)
ok('文体词锚点 E 命中「判词」', rXichun.anchors.some(a => a.type === 'E' && a.value === '判词'))

const rShishuo = qa.detect('韩愈的师说很好，补充全文')
ok('「X 的 Y」解析出篇名「师说」', rShishuo.target.title === '师说', 'got ' + rShishuo.target.title)
ok('人名锚点 D 命中 韩愈', rShishuo.anchors.some(a => a.type === 'D' && a.value === '韩愈'))

const rJingYe = qa.detect('把《静夜思》补充完整')
ok('书名号锚点 A 命中', rJingYe.anchors.some(a => a.type === 'A' && a.value === '静夜思'))
ok('池内篇名锚点 B 命中', rJingYe.anchors.some(a => a.type === 'B'))

const rSnippet = qa.detect('帮我续上后边几句，床前明月光')
ok('名句片段锚点 F 命中（无篇名也能认出是哪首）', rSnippet.anchors.some(a => a.type === 'F'), JSON.stringify(rSnippet.anchors))

const rQuoteMark = qa.detect('「三人行必有我师」后面是什么')
ok('引号句锚点 C 命中', rQuoteMark.anchors.some(a => a.type === 'C'), JSON.stringify(rQuoteMark.anchors))

// —— [genre-v1] 人物 / 文体分离 ——
// 旧实现把「惜春的判词」解析成「作者=惜春、篇名=判词」，模型据此去找一部叫《判词》的
// 作品，结果拿同回目同人物的《虚花悟》（曲）顶替了真正要的判词（28 字）。
const rBaiju = qa.detect('李白的诗句帮我补充一下')
ok('[genre-v1] 「李白的诗句」→ 作者=李白 / 文体=诗句 / 人物空 / 篇名空',
  rBaiju.target.author === '李白' && rBaiju.target.genre === '诗句' &&
  rBaiju.target.person === '' && rBaiju.target.title === '', JSON.stringify(rBaiju.target))
ok('[genre-v1] 作者 + 文体 仍算「有具体指向」→ 补全类', rBaiju.mode === 'full', 'got ' + rBaiju.mode)

const rJingYe2 = qa.detect('李白的静夜思帮我补充一下')
ok('[genre-v1] 真篇名不受影响（「静夜思」仍进 title）',
  rJingYe2.target.title === '静夜思' && rJingYe2.target.genre === '', JSON.stringify(rJingYe2.target))

const rAbout = qa.detect('有没有关于珍惜当下的名言，帮我补一句')
ok('[genre-v1] 「关于 X 的 Y」里的 X 是主题不是人物',
  rAbout.target.person === '' && rAbout.target.keyword === '珍惜当下' && rAbout.target.genre === '名言',
  JSON.stringify(rAbout.target))
ok('[genre-v1] 只有文体、无具体指向 → 仍是检索类（不会被撑成「要完整内容」）',
  rAbout.mode === 'lookup', 'got ' + rAbout.mode)

const rHongLou = qa.detect('红楼梦的判词是什么来着，帮我补充一下')
ok('[genre-v1] 作品名不是人物（「红楼梦的判词」person 必须为空）',
  rHongLou.target.person === '' && rHongLou.target.genre === '判词', JSON.stringify(rHongLou.target))

const rThatPoem = qa.detect('我喜欢的那句诗词帮我补充一下')
ok('[genre-v1] 指代词不是人物（「那句诗词」person 必须为空）',
  rThatPoem.target.person === '', 'got ' + rThatPoem.target.person)

ok('[genre-v1] 范围词「全文」不是文体（genre 必须为空）',
  rShishuo.target.genre === '', 'got ' + rShishuo.target.genre)
ok('[genre-v1] CHARACTERS 必须是 AUTHORS 的子集',
  Array.isArray(qa.CHARACTERS) && qa.CHARACTERS.every(n => qa.AUTHORS.indexOf(n) >= 0))
ok('[genre-v1] 文体→类别：名言/典故/台词；其余默认古典诗文',
  (qa.GENRE_KINDS || {})['名言'] === 'quote' && (qa.GENRE_KINDS || {})['典故'] === 'allusion' &&
  (qa.GENRE_KINDS || {})['台词'] === 'line' && ((qa.GENRE_KINDS || {})['判词'] || 'poem') === 'poem')
ok('[genre-v1] 范围词不在 GENRE_REAL_WORDS（但仍在 GENRE_WORDS 里当锚点）',
  (qa.GENRE_REAL_WORDS || []).indexOf('全文') < 0 && qa.GENRE_WORDS.indexOf('全文') >= 0 &&
  (qa.GENRE_REAL_WORDS || []).indexOf('判词') >= 0)
ok('[genre-v1] isGenreWord：判词是、全文不是、师说不是',
  typeof qa.isGenreWord === 'function' && qa.isGenreWord('判词') === true &&
  qa.isGenreWord('全文') === false && qa.isGenreWord('师说') === false)

// ============================================================
// 4. 归类优先级
// ============================================================
section('归类优先级')

const rPriority = qa.detect('《静夜思》那句关于月亮的什么话来着')
ok('篇名 + 检索式 → 补全优先（不得退化成名言检索）', rPriority.mode === 'full', 'got ' + rPriority.mode)

const rMark = qa.detect('【台词】《百年孤独》那句后面是什么')
ok('兜底标记强制锁定类别为台词', rMark.kind === 'line', 'got ' + rMark.kind)
ok('标记不改变范围判定（nextFew 保持）', rMark.mode === 'nextFew', 'got ' + rMark.mode)

const rOneFirst = qa.detect('《长歌行》后面那句是什么，补充全文')
ok('单句组优先于全文组', rOneFirst.mode === 'nextOne', 'got ' + rOneFirst.mode)

// ============================================================
// 5. strip：剥离指令句（幂等）
// ============================================================
section('strip：指令句剥离与幂等')

ok('净正文保留用户自己的话',
  qa.strip('韩愈的师说很好，补充全文', qa.detect('韩愈的师说很好，补充全文')) === '韩愈的师说很好',
  JSON.stringify(qa.strip('韩愈的师说很好，补充全文', qa.detect('韩愈的师说很好，补充全文'))))

ok('整篇都是指令时净正文为空',
  qa.strip('惜春的判词是什么来着，帮我补充一下', qa.detect('惜春的判词是什么来着，帮我补充一下')) === '')

const stripMixed = qa.strip('昨天去了西湖，很漂亮。帮我续上后边几句，床前明月光', qa.detect('昨天去了西湖，很漂亮。帮我续上后边几句，床前明月光'))
ok('多句正文里只剥指令句、保留叙述', stripMixed === '昨天去了西湖，很漂亮。床前明月光', JSON.stringify(stripMixed))

// 幂等：把净正文再喂回 detect，不该再命中（否则会重复插入）
const idemCases = ['韩愈的师说很好，补充全文', '惜春的判词是什么来着，帮我补充一下', '把《静夜思》补充完整']
let idemBad = []
idemCases.forEach(function (c) {
  const r1 = qa.detect(c)
  const clean = qa.strip(c, r1)
  const r2 = qa.detect(clean)
  if (r2.hit) idemBad.push(c + ' → 二次命中 ' + r2.reason)
})
ok('幂等：剥离后的正文再优化不会二次命中', idemBad.length === 0, idemBad.join(' / '))

// ============================================================
// 6. 池内直出
// ============================================================
section('池内直出与续写裁剪')

const poolJing = dq.findByAnchor({ text: '把静夜思补充完整', title: '', author: '' })
ok('findByAnchor 能认出无书名号的池内篇名', !!(poolJing && poolJing.by === 'title' && poolJing.item.title === '静夜思'),
  JSON.stringify(poolJing && poolJing.by))

ok('池内命中时 poolItem 就绪（可本地直出，不调云）', !!rJingYe.poolItem && rJingYe.poolItem.title === '静夜思')

const blockFull = qa.poolBlock(rJingYe.poolItem, 'full', '')
ok('池内直出块 = 原文 + 「—— 出处」行',
  blockFull === '床前明月光，疑是地上霜。举头望明月，低头思故乡。\n—— 唐·李白《静夜思》',
  JSON.stringify(blockFull))

const blockNext = qa.poolBlock(rSnippet.poolItem, 'nextFew', qa.strip('帮我续上后边几句，床前明月光', rSnippet))
ok('续写要裁掉已写出的句子', blockNext.indexOf('床前明月光') !== 0 && blockNext.indexOf('疑是地上霜') === 0,
  JSON.stringify(blockNext))
ok('续写仍带出处行', blockNext.indexOf('—— 唐·李白《静夜思》') > 0, JSON.stringify(blockNext))

const blockOne = qa.poolBlock(rOneFirst.poolItem, 'nextOne', '')
ok('单句档只给紧接的一句', blockOne.indexOf('\n—— ') > 0 && blockOne.split('\n')[0] === '青青园中葵，',
  JSON.stringify(blockOne))

// 检索类：池内没有对得上的主题时**必须**走云，不能拿该作者别的句子充数
ok('尼采+生活：池内无命中 → 不直出（必须走云端检索）', rNietzsche.poolItem === null)
ok('珍惜当下：池内无此主题 → 不直出', qa.detect('有没有关于珍惜当下的名言，帮我补一句').poolItem === null)

const topicHit = dq.findByTopic('尼采', '强大')
ok('findByTopic 主题命中时能取到池内条目', topicHit.length === 1 && topicHit[0].item.text.indexOf('杀不死我的') >= 0,
  JSON.stringify(topicHit.map(t => t.item.text)))
ok('findByTopic 给了主题就必须命中主题（不返回同作者其它句）', dq.findByTopic('尼采', '生活').length === 0)

// ============================================================
// 7. 输出契约与长度档
// ============================================================
section('输出契约与长度档')

ok('长度档：单句 50 / 检索 50 / 续写 100 / 全文 300',
  qa.LEN_LIMIT.nextOne === 50 && qa.LEN_LIMIT.lookup === 50 &&
  qa.LEN_LIMIT.nextFew === 100 && qa.LEN_LIMIT.full === 300)
ok('现代作品台词一律 ≤50（版权红线）', qa.lenLimitFor('full', 'line') === 50 && qa.lenLimitFor('nextFew', 'line') === 50)
ok('lenLimitFor 按范围取档', qa.lenLimitFor('full', 'poem') === 300 && qa.lenLimitFor('nextFew', 'poem') === 100)

const over = qa.clampText('一二三四五六七八九十', 5)
ok('超限裁剪到档位并补省略号', over === '一二三四五…', JSON.stringify(over))
ok('未超限不裁剪', qa.clampText('短句', 50) === '短句')
ok('计字口径：空白不计、标点计入', qa.countPlain('一二 三四，五') === 6, 'got ' + qa.countPlain('一二 三四，五'))

const built = qa.buildOptimized('韩愈的师说很好', '古之学者必有师。\n—— 《师说》· 韩愈')
ok('优化稿拼装 = 净正文 + 空行 + 补全块',
  built === '韩愈的师说很好\n\n古之学者必有师。\n—— 《师说》· 韩愈', JSON.stringify(built))
ok('净正文为空时只给补全块', qa.buildOptimized('', '甲\n—— 乙') === '甲\n—— 乙')

ok('出处行不带「｜」（会污染正文）', qa.poolSource(dq.QUOTES[1]).indexOf('｜') < 0)
ok('诗词出处格式：朝代·作者《篇名》', qa.poolSource(poolJing.item) === '唐·李白《静夜思》')
ok('名言出处格式：作者 + 出处', qa.poolSource({ type: 'quote', author: '孔子', from: '《论语·述而》' }) === '孔子《论语·述而》')

// ============================================================
// 8. 工具函数：切句 / 归一化 / 拼音近似档
// ============================================================
section('工具函数')

ok('切句是宽口径：逗号也算句界',
  qa.splitSentences('早上很堵，我开车去公司，晴天。').length === 3,
  'got ' + qa.splitSentences('早上很堵，我开车去公司，晴天。').length)
ok('书名号内部不切句',
  qa.splitSentences('《静夜思，静夜思》后面是什么').length === 1,
  'got ' + qa.splitSentences('《静夜思，静夜思》后面是什么').length)
ok('norm 去空白与标点', qa.norm(' 甲，乙。丙 ') === '甲乙丙', JSON.stringify(qa.norm(' 甲，乙。丙 ')))
ok('同音字拼音距离为 0', qa.pyDistance(qa.toPinyin('续上后边几句'), qa.toPinyin('絮上后边几句')) === 0)

const rApprox = qa.detect('絮上后边几句，《静夜思》')
ok('拼音近似档：转写成同音字仍能识别', rApprox.hit === true && rApprox.approximate === true,
  rApprox.reason + ' approx=' + rApprox.approximate)
ok('近似档必须有强锚点（书名号/池内篇名/引号句）',
  qa.detect('絮上后边几句').hit === false, qa.detect('絮上后边几句').reason)

// 连续两次 detect 结果必须一致（正则带 g 标志会导致 lastIndex 漂移）
const twice = [qa.detect('《静夜思》补充完整').mode, qa.detect('《静夜思》补充完整').mode]
ok('重复判定结果稳定（无 lastIndex 漂移）', twice[0] === twice[1], twice.join(' vs '))

// ============================================================
// 9. 接线护栏（静态）
// ============================================================
section('接线护栏')

const writeSrc = read('pages/write/write.js')
const aiCloudSrc = read('utils/aiCloud.js')
const cfSrc = read('cloudfunctions/optimizeDiary/index.js')
const dqSrc = read('utils/dailyQuote.js')

ok('write.js 已 require quoteAsk', writeSrc.indexOf("require('../../utils/quoteAsk.js')") >= 0)
ok('write.js 判定排在「内容太短」之前',
  writeSrc.indexOf('quoteAsk.detect(content)') >= 0 &&
  writeSrc.indexOf('quoteAsk.detect(content)') < writeSrc.indexOf('content.length < 20'))
ok('write.js 判定排在 nameMatch 名词纠正之前',
  writeSrc.indexOf('quoteAsk.detect(content)') < writeSrc.indexOf('const matchInfo = nameMatch.matchArchives(content'))
ok('write.js 有 handleRecite 实现', writeSrc.indexOf('handleRecite(content, recite) {') >= 0)
ok('素材补全只进优化稿：handleRecite 里不得出现 _setContent',
  writeSrc.slice(writeSrc.indexOf('handleRecite(content, recite) {')).slice(0, 2600).indexOf('_setContent') < 0)
ok('write.js 把 payload 传给云函数（含 kind/mode/target）',
  writeSrc.indexOf("'recite',") >= 0 && writeSrc.indexOf('{ kind: recite.kind, mode: recite.mode, target: recite.target, existing: clean }') >= 0)
ok('write.js 按长度档裁剪云端返回', writeSrc.indexOf('quoteAsk.lenLimitFor(recite.mode, recite.kind)') >= 0)

ok('aiCloud 有 recite 云端分支', aiCloudSrc.indexOf("action === 'recite'") >= 0)
ok('aiCloud 的 recite 请求带 payload', aiCloudSrc.indexOf('payload: payload || null') >= 0)
ok('aiCloud 本地降级：recite 明确「不支持」而不是瞎拼',
  aiCloudSrc.indexOf("error: reason || '补全诗文需要连接 AI 服务'") >= 0 &&
  aiCloudSrc.indexOf('recited: \'\'') >= 0)
ok('aiCloud 降级区分「连不上」与「云端拒答」（offline 标志）',
  aiCloudSrc.indexOf('offline: !!offline') >= 0 &&
  aiCloudSrc.indexOf("'AI 响应超时', true") >= 0 &&
  aiCloudSrc.indexOf("(r && r.error) || '未能确认出处', false") >= 0)

ok('云函数有 recite system prompt 分支', cfSrc.indexOf("buildSystemPrompt('recite'") >= 0)
ok('云函数有 recite action 分支', cfSrc.indexOf("action === 'recite'") >= 0)
ok('云函数：无出处一律不出（拍板 3.A）',
  cfSrc.indexOf('if (!recited) return { error: note') >= 0 && cfSrc.indexOf('if (!source) return { error: note') >= 0)
ok('云函数 recite 判空已放宽：纯求助句（净正文为空）是合法请求',
  cfSrc.indexOf('if (!body && !hasTarget)') >= 0 && cfSrc.indexOf('const hasTarget = ') >= 0)
ok('云函数 prompt 写了「不创作/不续写/不意译」', cfSrc.indexOf('不创作、不续写、不仿写、不润色用户的文字') >= 0)
ok('云函数 prompt 写了现代作品台词的版权红线', cfSrc.indexOf('版权保护期内，仅提供这一句') >= 0)
ok('云函数 recite 请求带结构化上下文',
  cfSrc.indexOf('function buildRecitePrompt(content, payload)') >= 0 && cfSrc.indexOf('用户要的范围：') >= 0)

ok('dailyQuote 导出了 findByAnchor / findByTopic',
  dqSrc.indexOf('  findByAnchor,') >= 0 && dqSrc.indexOf('  findByTopic,') >= 0)
ok('dailyQuote 的日签导出未被破坏（getToday/getDetail 仍在）',
  dqSrc.indexOf('  getToday,') >= 0 && dqSrc.indexOf('  getDetail') >= 0)
ok('quoteAsk 不直接调用 wx.*（保持可单测）',
  (function () {
    const src = read('utils/quoteAsk.js')
    // 只看真实调用 wx.xxx；注释里提到「wx.*」不算
    return !/\bwx\.[a-zA-Z_]/.test(src)
  })())

// 词表防删除（有人手滑清空词表 → 反例矩阵会静默失效）
ok('否决词表非空：文字实体', qa.NEG_TEXT_OBJ.length >= 15, 'got ' + qa.NEG_TEXT_OBJ.length)
ok('否决词表非空：改文指令', qa.NEG_EDIT_WORDS.length >= 10, 'got ' + qa.NEG_EDIT_WORDS.length)
ok('否决词表非空：日记常用语', qa.NEG_CONTINUE_WORDS.indexOf('继续往下写') >= 0)
ok('人名库规模 ≥80', qa.AUTHORS.length >= 80, 'got ' + qa.AUTHORS.length)
ok('文体词含「判词」「名言」', qa.GENRE_WORDS.indexOf('判词') >= 0 && qa.GENRE_WORDS.indexOf('名言') >= 0)

// ============================================================
// 10. 用户点名的三句验收
// ============================================================
section('验收：用户点名的三句话')

const A1 = qa.detect('尼采说过那句关于生活的什么话来着，你帮我补充一下')
ok('① 尼采关于生活 → 检索类，池内无命中，走云端', A1.hit && A1.mode === 'lookup' && A1.poolItem === null,
  A1.mode + ' / pool=' + (A1.poolItem ? '有' : '无'))
ok('① 净正文为空（整句都是指令）', qa.strip('尼采说过那句关于生活的什么话来着，你帮我补充一下', A1) === '')

const A2 = qa.detect('惜春的判词是什么来着，帮我补充一下')
ok('② 惜春判词 → 补全类，文体「判词」（不是篇名），走云端',
  A2.hit && A2.mode === 'full' && A2.target.genre === '判词' &&
  A2.target.person === '惜春' && A2.target.title === '' && A2.poolItem === null,
  A2.mode + ' / ' + JSON.stringify(A2.target))

const A3 = qa.detect('韩愈的师说很好，补充全文')
ok('③ 韩愈师说 → 全文类，篇名「师说」，保留用户自己的话',
  A3.hit && A3.mode === 'full' && A3.target.title === '师说' &&
  qa.strip('韩愈的师说很好，补充全文', A3) === '韩愈的师说很好',
  A3.mode + ' / ' + A3.target.title + ' / ' + JSON.stringify(qa.strip('韩愈的师说很好，补充全文', A3)))

// ============================================================
// 11. [genre-v1] 云端接线：人物 / 文体分列 + 同名系列文本区分
// ============================================================
section('[genre-v1] 云端接线（云函数改后需重新上传部署）')

const cfGenreSrc = read('cloudfunctions/optimizeDiary/index.js')
ok('user prompt 分列「涉及人物」与「要求的文体」',
  cfGenreSrc.indexOf("lines.push('涉及人物：' + t.person)") >= 0 &&
  cfGenreSrc.indexOf("lines.push('要求的文体：' + t.genre") >= 0)
ok('user prompt 不再把人物塞进「作者/人物」同一个字段',
  cfGenreSrc.indexOf("'涉及作者/人物：'") < 0)
ok('system prompt 有同名系列区分硬约束',
  cfGenreSrc.indexOf('【同名系列文本必须区分') >= 0 &&
  cfGenreSrc.indexOf('不得用同一人物、同一回目的另一套文本顶替') >= 0)
ok('system prompt 带「判词 / 虚花悟」正反例',
  cfGenreSrc.indexOf('勘破三春景不长') >= 0 && cfGenreSrc.indexOf('虚花悟') >= 0)
ok('客户端 loading 文案优先用用户点名的文体',
  read('pages/write/write.js').indexOf('recite.target && recite.target.genre') >= 0)

// ============================================================
console.log(lines.join('\n'))
console.log('')
console.log(fail === 0
  ? 'ALL PASS  (' + pass + ' assertions)'
  : 'FAILED    ' + fail + ' / ' + (pass + fail) + ' assertions failed')
process.exit(fail === 0 ? 0 : 1)
