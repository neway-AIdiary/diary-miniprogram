/**
 * utils/archiveEdit.js
 * 档案智能修改引擎：让底栏语音/手写输入能直接修改已录入的档案，体验与主页日记一致。
 * 支持两类修改意图：
 *   1. 指令式（复用 aiEdit 规则）：如「王磊不是高中同学，是大学同学」「把腾讯改成腾讯控股」
 *   2. 意图式（自然语言）：如已录入「王磊是我高中同学」，直接说「王磊是我大学同学」，
 *      自动识别为对「王磊」描述的修改，智能合并成「王磊是我大学同学」
 * 全部本地规则即时生效，不依赖网络/AI 服务。
 */

const aiEdit = require('./aiEdit.js')

/**
 * 在档案列表中查找包含 from 的条目（先查 name，再查 description）
 * @returns {null | {index:number, field:'name'|'description', archive:object}}
 */
function findTarget(archives, from) {
  if (!from) return null
  for (let i = 0; i < archives.length; i++) {
    if (String(archives[i].name || '').indexOf(from) !== -1) {
      return { index: i, field: 'name', archive: archives[i] }
    }
  }
  for (let i = 0; i < archives.length; i++) {
    if (String(archives[i].description || '').indexOf(from) !== -1) {
      return { index: i, field: 'description', archive: archives[i] }
    }
  }
  return null
}

/**
 * 合并新旧描述（历史遗留接口，现已统一为追加语义）：
 * 用户明确要求「不管如何都不做覆盖，只追加」（见 2026-09 反馈记录）。
 * 原先的「公共前缀尾部替换」在语音吞逗号场景（如旧"一个乐观的男人"，
 * 新说"王新伟一个乐观开朗的男人"）会把旧说明整段吞掉，表现为覆盖——已废弃。
 * 现在统一走 appendArchiveDescription：末尾标点感知追加，绝不覆盖。
 * @param {string} oldDesc
 * @param {string} newDesc
 * @returns {string|null}
 */
function mergeDescription(oldDesc, newDesc) {
  return appendArchiveDescription(oldDesc, newDesc)
}

/**
 * 档案描述追加（语音添加与手写输入添加共用同一规则）：
 * 已存在名词的解释做追加时——先看旧描述末尾是否已有逗号或句号：
 *   有 → 直接拼接（保持原标点）；
 *   无 → 先补一个中文逗号再接新说明。
 * 无论如何绝不覆盖、不拆条重排旧描述。
 * 若新说明整体已存在于旧描述中（先做忽略标点的整段包含比对，再做条目级比对）→ 返回 null（视为重复，不追加）。
 * @param {string} oldDesc 已有描述（可空）
 * @param {string} addDesc 要追加的说明（可空）
 * @returns {string|null} 追加后的描述；无需追加（新说明为空或已存在）返回 null
 */
function appendArchiveDescription(oldDesc, addDesc) {
  const o = String(oldDesc || '').trim()
  const a = String(addDesc || '').trim()
  if (!a) return null
  if (!o) return a
  // 归一化：去空白与全部中英文标点后比对，避免「整段含逗号/句号」被切条后漏判
  const norm = (s) => s.replace(/[\s，,、。.!！?？;；：:…—~～·"'“”‘’（）()【】\[\]《》<>-]/g, '')
  // 整段级去重：新说明（忽略标点差异）已整体包含于旧描述 → 不重复追加
  //   覆盖多句整段重复场景（如恢复合并时旧描述已含相同整段，此前条目级比对会漏判导致重复叠加）
  const na = norm(a)
  if (na && norm(o).indexOf(na) !== -1) return null
  // 条目级去重：新说明已是旧描述中某个逗号/句号分隔条目 → 不重复追加
  const has = o.split(/[，,、。.!！?？;；\n]/).map(s => s.trim()).filter(Boolean).indexOf(a) !== -1
  if (has) return null
  // 末尾已有逗号/句号等标点 → 直接追加；否则补中文逗号
  const needSep = !/[，,、。.!！?？;；]\s*$/.test(o)
  return o + (needSep ? '，' : '') + a
}

/**
 * 识别输入文本是否为对已有档案的修改
 * @param {string} text 底栏语音/手写输入
 * @param {Array} archives 当前档案列表
 * @returns {null | object}
 *   - null：不是修改，调用方按新增处理
 *   - {type:'cmd', cmd, target} 指令式修改（含 target 定位）
 *   - {type:'cmdNotFound', cmd} 指令未匹配到任何档案
 *   - {type:'updateDesc', archive, newDesc} 意图式：更新某档案描述
 *   - {type:'appendDesc', archive, appendText} 补充式：名称后带分隔符的说明，追加到该档案描述后
 *   - {type:'duplicate', name} 档案已存在但没给新信息
 */
function detectEdit(text, archives) {
  const t = String(text || '').trim()
  if (!t || !Array.isArray(archives) || !archives.length) return null

  // 1. 指令式：不是X是Y / 把X改成Y / 删除X / 在X前边加上Y ...
  const cmd = aiEdit.detect(t)
  if (cmd) {
    const cmdKey = cmd.type === 'insert' ? cmd.at : cmd.from
    const target = findTarget(archives, cmdKey)
    if (!target) return { type: 'cmdNotFound', cmd: cmd }
    return { type: 'cmd', cmd: cmd, target: target }
  }

  // 2. 意图式 / 补充式：文本以某个档案名开头 → 处理该档案
  //    名字长的优先匹配，避免「王」提前命中「王磊」
  //    支持动词前缀口语句（「添加王磊，公司负责人」「记录一下王新伟…」）：
  //    剥掉「添加/新增/补充/记录…」后再按名称匹配，命中已有名称 → 一律走追加语义
  const texts = [t]
  const leadM = t.match(/^(?:请|帮我|麻烦|给|为)?(?:添加|新增|补充|加上|加|记录|记下|记|录入|补录|新建)(?:一下|一条|一个)?\s*/)
  if (leadM) {
    const rest2 = t.slice(leadM[0].length).trim()
    if (rest2 && rest2 !== t) texts.push(rest2)
  }

  const sorted = archives.slice().sort((a, b) => String(b.name || '').length - String(a.name || '').length)
  for (const a of sorted) {
    const name = String(a.name || '').trim()
    if (!name || name.length < 2) continue
    // 从候选文本（原句 → 剥动词前缀句）中找第一个以该名称开头的
    let hitText = null
    for (const cand of texts) {
      if (cand.indexOf(name) === 0) { hitText = cand; break }
    }
    if (hitText === null) continue

    const restRaw = hitText.slice(name.length)
    const rest = restRaw.trim()
    if (!rest) return { type: 'duplicate', name: name }
    // 「王磊：我大学同学」带冒号：名称已存在 → 冒号后内容作为补充说明追加（逗号区隔，不覆盖）
    // （名称不存在时不会进入本分支，文本会继续走 AI 建档新增）
    if (/^[:：]/.test(rest)) {
      const body = rest.replace(/^[:：]+/, '').trim()
      if (body) return { type: 'appendDesc', archive: a, appendText: body }
      return { type: 'duplicate', name: name }
    }

    // 「名称 + 分隔符 + 说明」（如「王新伟，一个乐观的男人」）→ 说明追加到已有描述后（逗号区隔）
    // 与普通意图句（「王磊是我大学同学」）区分：带分隔符=补充说明，不带=对整段描述的更新
    // 注意用未 trim 的 restRaw 判断，否则前导空格分隔会被 trim 吞掉无法识别
    let sepRemoved = false
    let body = rest
    const sepM = restRaw.match(/^[，,、\s]+([\s\S]+)$/)
    if (sepM && sepM[1].trim()) {
      body = sepM[1].trim()
      sepRemoved = true
    }

    // body 本身是修改指令（如「王磊不是高中同学，是大学同学」）→ 优先对描述执行指令式修改
    const subCmd = aiEdit.detect(body)
    if (subCmd) {
      // 先只在该档案内找目标，命中则精确修改；否则全局找
      const subKey = subCmd.type === 'insert' ? subCmd.at : subCmd.from
      const localTarget = findTarget([a], subKey)
      if (localTarget) {
        return {
          type: 'cmd',
          cmd: subCmd,
          target: { index: archives.indexOf(a), field: localTarget.field, archive: a }
        }
      }
      const globalTarget = findTarget(archives, subKey)
      if (globalTarget) return { type: 'cmd', cmd: subCmd, target: globalTarget }
      return { type: 'cmdNotFound', cmd: subCmd }
    }

    // 带分隔符的补充说明 → 追加（不覆盖原描述）
    if (sepRemoved) {
      return { type: 'appendDesc', archive: a, appendText: body }
    }

    // 描述规范化：与备案格式「名词，我的…」保持一致
    // 「是我高中同学」→「我的高中同学」（便于与旧描述「我的大学同学」做前缀合并）
    let desc = rest
    const copula = rest.match(/^(?:其实|真的|就)?是(.+)$/)
    if (copula && copula[1].trim()) {
      const tail = copula[1].trim()
      desc = /^我的/.test(tail) ? tail : (/^我/.test(tail) ? '我的' + tail.slice(1) : '我的' + tail)
    }
    return { type: 'updateDesc', archive: a, newDesc: desc }
  }

  return null
}

/**
 * 应用修改到档案列表（返回新数组，不直接改存储）
 * @param {Array} archives
 * @param {object} edit detectEdit() 的返回值
 * @returns {{archives:Array, changed:boolean, msg:string}}
 */
function applyEdit(archives, edit) {
  // 深拷贝：避免修改调用方数组（对象引用不共享）
  const list = (Array.isArray(archives) ? archives : []).map(a => ({ ...a }))
  if (!edit) return { archives: list, changed: false, msg: '' }

  // 指令式
  if (edit.type === 'cmd') {
    const target = list[edit.target.index]
    if (!target) return { archives: list, changed: false, msg: '未找到对应档案' }
    // 插入：在 at 前面/后面加上 text（只处理第一处）
    if (edit.cmd.type === 'insert') {
      const val = String(target[edit.target.field] || '')
      const idx = val.indexOf(edit.cmd.at)
      if (idx === -1) {
        return { archives: list, changed: false, msg: '档案中没有「' + edit.cmd.at + '」' }
      }
      const insPos = edit.cmd.pos === 'before' ? idx : idx + edit.cmd.at.length
      target[edit.target.field] = val.slice(0, insPos) + edit.cmd.text + val.slice(insPos)
      target.updated_at = new Date().toISOString()
      return {
        archives: list,
        changed: true,
        msg: '已在「' + edit.cmd.at + '」' + (edit.cmd.pos === 'before' ? '前' : '后') + '加上「' + edit.cmd.text + '」'
      }
    }
    if (edit.cmd.type === 'remove') {
      let val = String(target[edit.target.field] || '').split(edit.cmd.from).join('').trim()
      // 清理删词后残留的孤立标点（如「是我高中同学，」→「是我高中同学」）
      val = val.replace(/^[，。；、]+/, '').replace(/[，。；、]+$/, '').trim()
      if (edit.target.field === 'name' && !val) {
        // 名字被删空 → 整条删除
        list.splice(edit.target.index, 1)
        return { archives: list, changed: true, msg: '已删除档案「' + target.name + '」' }
      }
      target[edit.target.field] = val
      target.updated_at = new Date().toISOString()
      return { archives: list, changed: true, msg: '已删除「' + edit.cmd.from + '」' }
    }
    // replace
    const val = String(target[edit.target.field] || '').split(edit.cmd.from).join(edit.cmd.to).trim()
    if (val === String(target[edit.target.field] || '')) {
      return { archives: list, changed: false, msg: '档案中已是「' + edit.cmd.to + '」' }
    }
    target[edit.target.field] = val
    target.updated_at = new Date().toISOString()
    return { archives: list, changed: true, msg: '已修改：「' + edit.cmd.from + '」→「' + edit.cmd.to + '」' }
  }

  // 意图式：更新描述
  if (edit.type === 'updateDesc') {
    const target = list.find(x => x.id === edit.archive.id)
    if (!target) return { archives: list, changed: false, msg: '未找到该档案' }
    const merged = mergeDescription(target.description, edit.newDesc)
    if (merged === null || merged === String(target.description || '').trim()) {
      return {
        archives: list,
        changed: false,
        msg: '「' + target.name + '」已是：' + (String(target.description || '').trim() || '（暂无描述）')
      }
    }
    target.description = merged
    target.updated_at = new Date().toISOString()
    return { archives: list, changed: true, msg: '已添加到「' + target.name + '」' }
  }

  // 补充说明：追加到已有描述末尾（末尾标点感知：有逗号/句号直接接，否则先补逗号），绝不覆盖
  if (edit.type === 'appendDesc') {
    const target = list.find(x => x.id === edit.archive.id)
    if (!target) return { archives: list, changed: false, msg: '未找到该档案' }
    const old = String(target.description || '').trim()
    const add = String(edit.appendText || '').trim()
    if (!add) return { archives: list, changed: false, msg: '没有可追加的说明' }
    const merged = appendArchiveDescription(old, add)
    if (merged === null) {
      return { archives: list, changed: false, msg: '「' + target.name + '」已包含：' + add }
    }
    if (merged === old) {
      return {
        archives: list,
        changed: false,
        msg: '「' + target.name + '」已是：' + (old || '（暂无描述）')
      }
    }
    target.description = merged
    target.updated_at = new Date().toISOString()
    return { archives: list, changed: true, msg: '已添加到「' + target.name + '」' }
  }

  // 其他提示类
  if (edit.type === 'cmdNotFound') {
    const key = edit.cmd.type === 'insert' ? edit.cmd.at : edit.cmd.from
    return { archives: list, changed: false, msg: '档案中没有「' + key + '」' }
  }
  if (edit.type === 'duplicate') {
    return { archives: list, changed: false, msg: '「' + edit.name + '」已在档案中，说说它的新信息即可更新' }
  }

  return { archives: list, changed: false, msg: '' }
}

module.exports = { detectEdit, applyEdit, mergeDescription, appendArchiveDescription }
