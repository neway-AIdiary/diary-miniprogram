/**
 * tools/test_archive_append.js
 * 「档案追加不覆盖」穷举回归：覆盖用户反馈过的全部真实场景 + 语音/手写变体
 */
const archiveEdit = require('../utils/archiveEdit.js')
let pass = 0
let fail = 0

function run(desc, archives, text, check) {
  const edit = archiveEdit.detectEdit(text, archives)
  let out = archives
  let note = ''
  if (edit) {
    const res = archiveEdit.applyEdit(archives, edit)
    out = res.archives
    note = res.msg
    if (!res.changed) note = '[no-change] ' + note
  } else {
    note = '[null → AI建档兜底 saveArchives(追加)]'
  }
  const target = out.find(a => a.name === '王新伟') || out[out.length - 1]
  let ok = false
  let detail = ''
  try {
    const r = check(target, out, edit, note)
    ok = r === true || r === undefined
    detail = typeof r === 'string' ? r : ''
  } catch (e) {
    detail = e.message
  }
  if (ok) { pass++ } else { fail++ }
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + desc)
  if (!ok) console.log('      输入: "' + text + '" → ' + JSON.stringify(target) + ' | ' + note + (detail ? ' | ' + detail : ''))
}

// ============ 场景库 ============
// 用户基准案例：已存在「王新伟：本人」
const base = [{ id: 'a1', name: '王新伟', description: '本人' }]

// 1. 用户原始需求案例（消息9）
run('手写带逗号：王新伟，一个乐观的男人', JSON.parse(JSON.stringify(base)), '王新伟，一个乐观的男人',
  (t) => t.description === '本人，一个乐观的男人' || 'got=' + t.description)

// 2. 语音变体：ASR 常吞逗号
run('语音无逗号：王新伟一个乐观的男人', JSON.parse(JSON.stringify(base)), '王新伟一个乐观的男人',
  (t) => t.description === '本人，一个乐观的男人' || 'got=' + t.description)

// 3. 语音带句号
run('语音带句号：王新伟，一个乐观的男人。', JSON.parse(JSON.stringify(base)), '王新伟，一个乐观的男人。',
  (t) => t.description === '本人，一个乐观的男人。' || 'got=' + t.description)

// 4. 带动词前缀
run('动词前缀：添加王新伟，住在北京', JSON.parse(JSON.stringify(base)), '添加王新伟，住在北京',
  (t) => t.description === '本人，住在北京' || 'got=' + t.description)

// 5. 冒号格式
run('冒号格式：王新伟：住在北京', JSON.parse(JSON.stringify(base)), '王新伟：住在北京',
  (t) => t.description === '本人，住在北京' || 'got=' + t.description)

// 6. 连续两次追加（旧描述末尾已有内容）
run('二次追加：已有"本人，一个乐观的男人"再加 30岁', [{ id: 'a1', name: '王新伟', description: '本人，一个乐观的男人' }], '王新伟，30岁',
  (t) => t.description === '本人，一个乐观的男人，30岁' || 'got=' + t.description)

// 7. 重复内容不追加
run('去重：重复说明不追加', [{ id: 'a1', name: '王新伟', description: '本人，一个乐观的男人' }], '王新伟，一个乐观的男人',
  (t) => t.description === '本人，一个乐观的男人' || 'got=' + t.description)

// 8. 旧描述末尾有句号
run('末尾句号直接接', [{ id: 'a1', name: '王新伟', description: '本人。' }], '王新伟，30岁',
  (t) => t.description === '本人。30岁' || 'got=' + t.description)

// 9. 语音前后空格
run('前后空格： 王新伟 ， 30岁 ', JSON.parse(JSON.stringify(base)), ' 王新伟 ， 30岁 ',
  (t) => t.description === '本人，30岁' || 'got=' + t.description)

// 10. 半角逗号
run('半角逗号：王新伟,30岁', JSON.parse(JSON.stringify(base)), '王新伟,30岁',
  (t) => t.description === '本人，30岁' || 'got=' + t.description)

// 11. AI 建档兜底（detectEdit null → saveArchives 追加链路已实证）：不覆盖旧条目即可
run('AI兜底：识别错别字「王新卫」→ 走建档兜底，原条目不动', JSON.parse(JSON.stringify(base)), '王新卫，一个乐观的男人',
  (t, list, edit) => (edit ? '[不应命中本地编辑] edit=' + edit.type : true))

// 12. 意图式句子（无分隔符）：按用户最新规则「不管如何都只追加、不覆盖」
run('意图式：王新伟是我大学同学（统一追加语义）', [{ id: 'a1', name: '王新伟', description: '是我高中同学，住北京' }], '王新伟是我大学同学',
  (t) => t.description === '是我高中同学，住北京，我的大学同学' || 'got=' + t.description)

// 13. 关键覆盖嫌疑：updateDesc 无分隔符 + 旧描述首字与新说明首字相同
run('嫌疑A：旧"一个乐观的男人" 无逗号再说"一个乐观开朗的男人"', [{ id: 'a1', name: '王新伟', description: '一个乐观的男人' }], '王新伟一个乐观开朗的男人',
  (t, list, edit, note) => (t.description.indexOf('一个乐观的男人') !== -1 ? true : '[疑似覆盖] got=' + t.description + ' edit=' + (edit && edit.type)))

// 14. 嫌疑B：aiEdit 误判说明为指令
run('嫌疑B：说明含"改成"字样', [{ id: 'a1', name: '王新伟', description: '本人' }], '王新伟，同事说他想把工作改成自由职业',
  (t, list, edit, note) => (t.description.indexOf('本人') !== -1 ? true : '[疑似覆盖] got=' + t.description + ' edit=' + JSON.stringify(edit && edit.type)))

// 15. 嫌疑C：动词前缀剥离后说明里带"添加"
run('嫌疑C：说明本身含添加动作', JSON.parse(JSON.stringify(base)), '记录一下王新伟，爱好是周末爬山',
  (t) => t.description === '本人，爱好是周末爬山' || 'got=' + t.description)

// 16. 名称带空格的档案（AI 建档历史产物）与 saveArchives nameMap 未 trim 的错位
run('嫌疑D：档案名带尾空格时语音输入仍命中', [{ id: 'a1', name: '王新伟 ', description: '本人' }], '王新伟，30岁',
  (t, list, edit) => (edit ? (list[0].description === '本人，30岁' || 'edit=' + edit.type + ' got=' + list[0].description) : '[null→建档兜底] 档案名未trim导致漏匹配，需修 nameMap'))

console.log('\n==== ' + pass + ' pass / ' + fail + ' fail ====')
process.exit(fail ? 1 : 0)
