/**
 * [summary-shortcut v1] 测试：智能总结页快捷模板 → 六条「前几字按钮，点击即生成」
 * 运行：node tools/test_summary_shortcuts.js
 *
 * 用户拍板（2026-09-22）：1 推荐（口径 = 输入框所见即所得，prompt 就是整句原文）
 *                       2 **已撤销**（原「月度复盘顺带切本月」真机实测胶囊无变化，用户决定不要）
 *                       3 同意（去掉行首图标）
 *   [v1.2] 点 chip 不联动任何时间范围：范围只由顶部胶囊决定
 *   [v1.3] 说明行 + 两条确认 toast（用户拍板：1.A 文案 / 2.加两条 / 3.要标题）：
 *     说明行 = 左「快捷模板」标题 + 右「点左侧直接生成 · 点右侧填入输入框」
 *     toast = 点整句「已填入输入框，可修改后生成」/ 点 chip「正在按「xx」生成」
 *     关键约束：chip 的 toast **只在真进入生成态时**弹 —— onGenerate 会因
 *       无日记 / 防抖 / 自定义范围未选完 / 云开发不可用而早退，那时抢着说「正在生成」
 *       就是谎报，还会把它自己的提示顶掉（B20/B21 盯这条）
 * 用户给定六条（逐字，2026-09-22 二次修订后的现行版本）：
 *   月度复盘 - 本月日记的整体回顾 / 心迹追踪 - 分析情绪与心态变化
 *   强身规划 - 对比运动记录拟定健身方案 / 学途建言 - 总结学习情况给出提升建议
 *   大事速览 - 简要提取里程碑事件 / 年度剪影 - 生成一份年度简短回顾
 *   （二次修订只换第 3、4 条文案，chip 仍为 4 字 ⇒ 胶囊自适应宽度、样式无关；
 *     原两条文案的备份见 总结快捷模板2-backup-20260922）
 *
 * 覆盖断言：
 *   A 组：静态（六条文案逐字 / 数据表已无 range 字段 · wxml 已无 data-range / 旧 icon·fill 清零 /
 *        wxml chip 分层 catchtap+bindtap / wxss chip 样式与旧图标规则 /
 *        [v1.3] 说明行结构·文案逐字·避讳词·样式令牌）
 *   B 组：智能总结页行为（点 chip 即生成且 prompt=整句 / **不联动时间范围** /
 *        点整句只填入不生成 / 生成中点 chip 有反馈不重复发 /
 *        [v1.3] 两条确认 toast + 早退时不谎报）
 *   C 组：零回归（onGenerate 守卫、防抖、组件 selectOption/reset 契约；setRange 已移除）
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const base = path.resolve(__dirname, '..')
const SJS = path.join(base, 'pages', 'summary', 'summary.js')
const SWXML = path.join(base, 'pages', 'summary', 'summary.wxml')
const SWXSS = path.join(base, 'pages', 'summary', 'summary.wxss')
const RPJS = path.join(base, 'components', 'range-picker', 'range-picker.js')
const dateRange = require(path.join(base, 'utils', 'dateRange.js'))

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++ } else {
    fail++
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
const read = (p) => fs.readFileSync(p, 'utf8')

function clearCache() {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(base) === 0) delete require.cache[k] })
}

// 用户给定的六条（chip = 前几字按钮，label = 进入输入框的整句）
const EXPECT = [
  ['月度复盘', '本月日记的整体回顾'],
  ['心迹追踪', '分析情绪与心态变化'],
  ['强身规划', '对比运动记录拟定健身方案'],
  ['学途建言', '总结学习情况给出提升建议'],
  ['大事速览', '简要提取里程碑事件'],
  ['年度剪影', '生成一份年度简短回顾']
]

// ============================================================
// 智能总结页加载器（vm + wx 桩）
// ============================================================
const DIARY = {
  id: 'd1', title: '七月的尾巴', content: '今天自驾返回北京，全程十一个小时。',
  created_at: new Date().toISOString(), mood: 'happy', tags: []
}

function loadSummaryPage(opts) {
  opts = opts || {}
  clearCache()
  const store = opts.store || {}
  const sink = { toasts: [], nav: [], emitted: [], req: null, calls: 0 }
  const picker = { calls: [] }
  const box = { page: null }
  // 组件桩：**保留 setRange 记录器当反向探针** —— [v1.2] 之后页面不该再调用它。
  // 一旦被调（picker.calls 非空）说明联动被误恢复，B4/B6/B8b/B11/B16 会立刻红。
  picker.setRange = function (k) {
    picker.calls.push(k)
    if (box.page && typeof box.page.onRangeChange === 'function') {
      box.page.onRangeChange({ detail: { range: k, customStart: '', customEnd: '' } })
    }
    return true
  }

  const globalData = { needRefresh: false, summaryResult: null }
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v },
    removeStorageSync: (k) => { delete store[k] },
    getStorageInfoSync: () => ({ currentSize: 1, limitSize: 10240, keys: Object.keys(store) }),
    showToast: (o) => { sink.toasts.push((o && o.title) || '') },
    getWindowInfo: () => ({ safeArea: { bottom: 700 }, screenHeight: 700, windowWidth: 375 }),
    getSystemInfoSync: () => ({ safeArea: { bottom: 700 }, screenHeight: 700 }),
    navigateTo: (o) => {
      sink.nav.push(o || {})
      if (o && o.success) {
        o.success({ eventChannel: { emit: (n, p) => sink.emitted.push({ name: n, payload: p }) } })
      }
    },
    cloud: {
      callFunction: (o) => {
        sink.req = o
        sink.calls++
        return Promise.resolve({ result: opts.cloudResult || { success: true, summaryText: '正文', diaryCount: 1 } })
      }
    }
  }
  global.getApp = () => ({ globalData })

  let pageObj = null
  global.Page = (o) => { pageObj = o }

  const overrides = Object.assign({
    'voice.js': { onStateChange: () => () => {}, start: () => {}, stop: () => {}, warmup: () => {} },
    'fontSetting.js': { buildStyle: () => '' },
    'theme.js': { applyTo: () => {} },
    'lock.js': { guard: () => false },
    'storage.js': { getAllDiaries: () => (opts.diaries || [DIARY]) }
  }, opts.overrides || {})
  const dir = path.join(base, 'pages', 'summary')
  const fakeRequire = (p) => {
    for (const k of Object.keys(overrides)) {
      if (p.indexOf(k) >= 0) return overrides[k]
    }
    return require(path.resolve(dir, p))
  }

  try {
    const src = read(SJS)
    const wrapper = vm.runInThisContext(
      '(function(require,module,exports,getApp,Page){' + src + '\n})', { filename: 'summary.js' })
    wrapper(fakeRequire, { exports: {} }, {}, global.getApp, global.Page)
  } catch (e) {
    return { page: null, sink, picker, globalData, loadError: String(e && e.message) }
  }
  if (!pageObj) return { page: null, sink, picker, globalData, loadError: 'Page 未注册' }

  const page = Object.create(pageObj)
  page.data = JSON.parse(JSON.stringify(pageObj.data))
  page.setData = function (d) { Object.assign(this.data, d) }
  page.selectComponent = (sel) => (String(sel).indexOf('rangePicker') >= 0 ? picker : null)
  box.page = page
  return { page, sink, picker, globalData, loadError: null }
}

// [v1.2] chip 只带 label（源码已不挂 data-range）；[v1.3] 追加 chip —— 生成确认 toast 要报出条目名。
// 真机 dataset 里没有 range 时，页面就更不该去动时间范围
const tapChip = (page, chip) => {
  const item = EXPECT.find((e) => e[0] === chip)
  page.onQuickGenerate({ currentTarget: { dataset: { label: item[1], chip: item[0] } } })
}

const tick = (n) => new Promise((r) => setTimeout(r, n || 5))

// ============================================================
// 组件加载器（range-picker）
// ============================================================
function loadPicker() {
  let compOptions = null
  const sandbox = { console: console, Component: (o) => { compOptions = o } }
  sandbox.require = (p) => require(path.join(base, 'components', 'range-picker', p))
  sandbox.module = { exports: {} }
  sandbox.exports = sandbox.module.exports
  sandbox.__filename = RPJS
  sandbox.__dirname = path.join(base, 'components', 'range-picker')
  vm.createContext(sandbox)
  try {
    vm.runInContext(read(RPJS), sandbox, { filename: 'range-picker.js' })
  } catch (e) {
    return { methods: null, loadError: String(e && e.message) }
  }
  if (!compOptions || !compOptions.methods) return { methods: null, loadError: 'Component 未注册' }
  return { methods: compOptions.methods, data: compOptions.data, loadError: null }
}

function makeComp(methods, data, diaryDetail) {
  const emits = []
  const c = Object.assign({}, methods)
  c.properties = { diaryDetail: !!diaryDetail }
  c.data = JSON.parse(JSON.stringify(data))
  c.setData = function (d) { Object.assign(this.data, d) }
  c.triggerEvent = (n, e) => { emits.push({ name: n, detail: e }) }
  c._emits = emits
  return c
}

// ============================================================
async function main() {
  // ----------------------------------------------------------
  console.log('== A) 静态：六条文案逐字 / 分层结构 / 样式 ==')
  {
    const src = read(SJS)
    const wxml = read(SWXML)
    const wxss = read(SWXSS)

    let hit = 0
    EXPECT.forEach((e) => {
      if (src.indexOf("chip: '" + e[0] + "', label: '" + e[1] + "'") !== -1) hit++
    })
    ok(hit === 6, 'A1 六条 chip+label 逐字齐备（顺序内联在源码里）', hit)

    const idxs = EXPECT.map((e) => src.indexOf("chip: '" + e[0] + "'"))
    ok(idxs.every((i) => i >= 0) && idxs.every((v, i) => i === 0 || v > idxs[i - 1]),
      'A2 六条顺序 = 用户给定顺序（月度复盘→…→年度剪影）', idxs)

    // [v1.2] 原「拍板 2」撤销：数据表不再有 range 字段，页面也无联动实现
    ok(src.indexOf("chip: '月度复盘', label: '本月日记的整体回顾' }") !== -1,
      'A3 月度复盘与其余五条同形（无 range 附属，不再特殊）')
    ok(src.indexOf(', range:') === -1 && src.indexOf('_setRange') === -1 && src.indexOf('data-range') === -1,
      'A4 range 联动残留清零（数据表字段 / 页面方法 / dataset 三处都无）')
    ok(src.indexOf("icon: 'ri-") === -1 && src.indexOf("fill: '") === -1,
      'A5 旧 icon / fill 字段清零（拍板 3：去掉行首图标）')

    // wxml：chip 按钮（catchtap 阻断冒泡）+ 整句（bindtap 只填入）
    ok(wxml.indexOf('catchtap="onQuickGenerate"') !== -1,
      'A6 chip 用 catchtap（阻断冒泡 → 不会顺带触发整行 onShortcut）')
    ok(wxml.indexOf('catchtap="onQuickGenerate" data-label="{{item.label}}" data-chip="{{item.chip}}">{{item.chip}}') !== -1 &&
       wxml.indexOf('data-range=') === -1,
      'A7 chip 携带 label + chip（v1.3 加 chip 供确认 toast 报出条目名）；data-range 已摘除（v1.2）')
    ok(wxml.indexOf('bindtap="onShortcut"') !== -1 && wxml.indexOf('data-fill="{{item.label}}"') !== -1,
      'A8 行内其余区域 → onShortcut，填入的也是整句（不再是 item.fill）')
    ok(wxml.indexOf('class="ri {{item.icon}}"') === -1 && wxml.indexOf('{{item.fill}}') === -1,
      'A9 行首图标节点与 item.fill 引用已删')
    ok(wxml.indexOf('wx:key="chip"') !== -1, 'A10 列表 key 改 chip（每行按钮名唯一）')

    ok(wxss.indexOf('.shortcut-chip {') !== -1 && wxss.indexOf('white-space: nowrap') !== -1,
      'A11 chip 样式存在且不换行（4 字胶囊）')
    ok(wxss.indexOf('--brand-deep') !== -1 && wxss.indexOf('--brand-tint-08') !== -1,
      'A12 chip 走主题令牌（暗色主题同样可读）')
    ok(wxss.indexOf('.shortcut .ri {') === -1,
      'A13 已无引用的图标规则清除（不留死代码）')
    ok(wxss.indexOf('.shortcut-busy .shortcut-chip') !== -1,
      'A14 生成中 chip 压暗样式存在')

    const rp = read(RPJS)
    ok(rp.indexOf('setRange') === -1 && rp.indexOf('selectOption(e) {') !== -1 &&
       rp.indexOf('    reset() {') !== -1,
      'A15 range-picker 已无 setRange（随 v1.2 一并移除），selectOption / reset 原样保留')

    // 二次修订：被换掉的两条 chip 名不得在源码留残影
    // （只扫「源码」，本测试文件自身为保留修订痕迹而写明旧名，不参与该断言）
    ok(src.indexOf('标签归集') === -1 && src.indexOf('成长对照') === -1,
      'A16 被替换的两条旧 chip 名在源码中清零（无残留）')

    // ---- [v1.3] 说明行：让人看出 chip 与整句是两种点击 ----
    // （右侧整句原本是灰色普通字，用户根本不会去想它能点 —— 说明行解决的就是这个）
    ok(wxml.indexOf('<view class="shortcuts-head">') !== -1 &&
       wxml.indexOf('<view class="shortcuts-title">快捷模板</view>') !== -1,
      'A17 说明行结构齐备（head 容器 + 区块标题「快捷模板」）')

    const HINT_TAG = 'class="shortcuts-hint">'
    const hi = wxml.indexOf(HINT_TAG)
    const hint = hi < 0 ? '' : wxml.slice(hi + HINT_TAG.length, wxml.indexOf('</view>', hi))
    ok(hint === '点左侧直接生成 · 点右侧填入输入框',
      'A18 提示文案逐字 = 拍板 A 的那一句', hint)
    // 避讳：本 App 里「标签」已指日记标签，「胶囊」是内部对 range-picker 的叫法，
    // 写进操作提示会让用户理解到别的东西上去（见 MEMORY-modules 该条）
    ok(hint.length > 0 && hint.indexOf('标签') === -1 && hint.indexOf('胶囊') === -1,
      'A19 提示不含避讳词（「标签」/「胶囊」）', hint)

    ok(wxss.indexOf('.shortcuts-head {') !== -1 && wxss.indexOf('.shortcuts-title {') !== -1 &&
       wxml.indexOf('<view class="shortcuts-head">') < wxml.indexOf('<view class="shortcuts">'),
      'A20 说明行样式齐备，且置于卡片列表之前（先看说明再点）')

    const hb = wxss.indexOf('.shortcuts-hint {')
    const hblock = hb < 0 ? '' : wxss.slice(hb, hb + 160)
    ok(hblock.indexOf('color: var(--ink-soft)') !== -1 && hblock.indexOf('font-size: 22rpx') !== -1,
      'A21 提示小字走 --ink-soft 令牌 + 22rpx（不硬编码色值 → 暗色主题也可读）', hblock)
  }

  // ----------------------------------------------------------
  console.log('== B) 智能总结页行为：点 chip 即生成 ==')
  {
    // 安全包装：旧版无 onQuickGenerate 时精准红，整组跳过（不让 TypeError 吃掉断言、伪装成「红得精准」）
    const ctx = loadSummaryPage()
    const hasQuick = !!ctx.page && typeof ctx.page.onQuickGenerate === 'function'
    ok(hasQuick, 'B0 智能总结页可加载且 onQuickGenerate 存在（旧版此处精准红）', ctx.loadError)

    if (hasQuick) {
      ctx.page.onLoad()

      // ---- 非月度 chip：只生成，不动范围 ----
      tapChip(ctx.page, '心迹追踪')
      await tick(10)
      ok(ctx.page.data.prompt === '分析情绪与心态变化',
        'B1 点 chip → 输入框里就是整句（口径 1：所见即所得）', ctx.page.data.prompt)
      ok(!!ctx.sink.req && ctx.sink.req.data.userPrompt === '分析情绪与心态变化',
        'B2 送给 AI 的 userPrompt 与输入框逐字一致（不加前缀包装）',
        ctx.sink.req && ctx.sink.req.data.userPrompt)
      ok(ctx.sink.req.data.startDate === '' && ctx.sink.req.data.endDate === '',
        'B3 该条不带 range → 时间范围保持「全部时间」（rangeDateKeys(all) = 空串，不是每个 chip 都切范围）',
        ctx.sink.req && [ctx.sink.req.data.startDate, ctx.sink.req.data.endDate])
      ok(ctx.picker.calls.length === 0, 'B4 未调用组件 setRange', ctx.picker.calls)
      const em = ctx.sink.emitted.length ? ctx.sink.emitted[0] : null
      ok(!!em && em.name === 'summaryResult' &&
         (em.payload || {}).prompt === '分析情绪与心态变化',
        'B5 生成成功仍走 summaryResult 事件通道（原有链路未被替换）', em && em.name)

      // ---- [v1.2] 月度复盘不再联动范围：胶囊由用户自己定，chip 只管需求 ----
      const ctx2 = loadSummaryPage()
      ctx2.page.onLoad()
      tapChip(ctx2.page, '月度复盘')
      await tick(10)
      ok(ctx2.picker.calls.length === 0,
        'B6 点「月度复盘」→ 绝不调用组件 setRange（v1.2：不自动切「本月」）', ctx2.picker.calls)
      ok(!ctx2.page._rangeState || ctx2.page._rangeState.range === 'all',
        'B7 页面范围状态保持初始「全部时间」（未被 chip 改动）', ctx2.page._rangeState)
      ok(ctx2.page.data.prompt === '本月日记的整体回顾',
        'B8 需求照常填入（不动范围，只填需求）', ctx2.page.data.prompt)
      const all = dateRange.rangeDateKeys('all', '', '')
      ok(!!ctx2.sink.req && ctx2.sink.req.data.startDate === all.start && ctx2.sink.req.data.endDate === all.end,
        'B8b 发给云函数的仍是「全部时间」区间（与顶部胶囊所见一致）',
        ctx2.sink.req && [ctx2.sink.req.data.startDate, ctx2.sink.req.data.endDate])

      // ---- 点行内整句：只填入，不生成 ----
      const ctx3 = loadSummaryPage()
      ctx3.page.onLoad()
      ctx3.page.onShortcut({ currentTarget: { dataset: { fill: '简要提取里程碑事件' } } })
      await tick(10)
      ok(ctx3.page.data.prompt === '简要提取里程碑事件', 'B9 点整句 → 填入输入框', ctx3.page.data.prompt)
      ok(ctx3.sink.req === null && ctx3.sink.calls === 0,
        'B10 点整句不发起生成（与 chip 行为分区）', ctx3.sink.calls)
      ok(ctx3.picker.calls.length === 0, 'B11 点整句不联动时间范围')

      // ---- 生成中点 chip：有反馈、不重复发、不改写已填内容 ----
      const ctx4 = loadSummaryPage()
      ctx4.page.onLoad()
      ctx4.page.setData({ loading: true, prompt: '原需求' })
      ctx4.sink.toasts.length = 0
      tapChip(ctx4.page, '大事速览')
      await tick(10)
      ok(ctx4.sink.toasts.indexOf('正在生成，请稍候') >= 0,
        'B12 生成中点 chip 给明确反馈（本项目铁律：不静默早退）', ctx4.sink.toasts)
      ok(ctx4.sink.calls === 0, 'B13 生成中不重复调用云函数')
      ok(ctx4.page.data.prompt === '原需求', 'B14 早退发生在写 prompt 之前（不留下错位的输入）', ctx4.page.data.prompt)

      // ---- 二次修订后的新条：补一条行为级覆盖（A 组只做字符串比对，不证明点得动） ----
      const ctx5 = loadSummaryPage()
      ctx5.page.onLoad()
      tapChip(ctx5.page, '强身规划')
      await tick(10)
      ok(ctx5.page.data.prompt === '对比运动记录拟定健身方案' &&
         !!ctx5.sink.req && ctx5.sink.req.data.userPrompt === '对比运动记录拟定健身方案',
        'B15 新条「强身规划」点 chip 即生成、整句逐字进输入框并原样送 AI', ctx5.page.data.prompt)
      ok(ctx5.picker.calls.length === 0, 'B16 新条不带 range → 不动时间范围', ctx5.picker.calls)

      // ---- [v1.3] 两条确认 toast：让用户知道「点对了地方」和「它去哪了」 ----
      const ctx6 = loadSummaryPage()
      ctx6.page.onLoad()
      ctx6.sink.toasts.length = 0
      ctx6.page.onShortcut({ currentTarget: { dataset: { fill: '简要提取里程碑事件' } } })
      await tick(10)
      ok(ctx6.sink.toasts.indexOf('已填入输入框，可修改后生成') >= 0,
        'B17 点整句 → toast 交代去向（否则用户不知道它去哪了、还要按什么）', ctx6.sink.toasts)
      ok(ctx6.sink.calls === 0, 'B18 该 toast 不改变「点整句不生成」的行为', ctx6.sink.calls)

      const ctx7 = loadSummaryPage()
      ctx7.page.onLoad()
      ctx7.sink.toasts.length = 0
      tapChip(ctx7.page, '心迹追踪')
      await tick(10)
      ok(ctx7.sink.toasts.indexOf('正在按「心迹追踪」生成') >= 0,
        'B19 点 chip → 确认 toast 报出点了哪一条（dataset.chip 已接上）', ctx7.sink.toasts)

      // ---- 边界（最重要的一条）：onGenerate 早退时**绝不能**弹「正在按…生成」 ----
      // 那是谎报，而且会把 onGenerate 自己的提示顶掉（toast 同时只显示一个）
      const ctx8 = loadSummaryPage({ diaries: [] })
      ctx8.page.onLoad()
      ctx8.sink.toasts.length = 0
      tapChip(ctx8.page, '心迹追踪')
      await tick(10)
      ok(ctx8.sink.toasts.every((t) => t.indexOf('正在按') < 0),
        'B20 无日记早退 → 不谎报「正在生成」（toast 只在 loading 真起来时才弹）', ctx8.sink.toasts)
      ok(String(ctx8.page.data.error).indexOf('暂无日记') >= 0,
        'B21 早退提示仍由 onGenerate 自己给出（没被我们的 toast 顶掉）', ctx8.page.data.error)
    }
  }

  // ----------------------------------------------------------
  console.log('== C) 零回归：生成守卫 / 组件契约 ==')
  {
    const ctx = loadSummaryPage()
    ctx.page.onLoad()
    ctx.page.onGenerate()
    await tick(10)
    ok(ctx.sink.toasts.indexOf('请输入或说出你的需求') >= 0 && ctx.sink.calls === 0,
      'C1 空需求仍是「提示 + 不调用」', ctx.sink.toasts)

    const src = read(SJS)
    ok(typeof ctx.page.onShortcut === 'function', 'C2 onShortcut 仍在（行内点按能力未被删）')
    ok(src.indexOf('if (this._cooling) {') !== -1 && src.indexOf("'操作太快，请稍候'") !== -1,
      'C3 3 秒防抖仍在')
    ok(src.indexOf('dateRange.filterByRange') !== -1 && src.indexOf('dateRange.rangeDateKeys') !== -1 &&
       src.indexOf('this._rangeState') !== -1,
      'C4 范围公共口径与 _rangeState 未被牵连')

    // 组件契约：[v1.2] setRange 已移除，selectOption / reset 原样
    const L = loadPicker()
    ok(!L.loadError && L.methods, 'C5 组件可加载', L.loadError)
    if (!L.loadError && L.methods) {
      ok(typeof L.methods.selectOption === 'function' && typeof L.methods.reset === 'function',
        'C6 selectOption / reset 保留（弹层选档 / 归位两个入口）')
      ok(typeof L.methods.setRange === 'undefined',
        'C7 setRange 已移除（无调用方，不留半截机制）')

      // 组件本体能力（点胶囊切档）不得因此受损：用 selectOption 走一遍
      const c = makeComp(L.methods, L.data, false) // 总结页口径：diaryDetail 默认 false
      c.selectOption({ currentTarget: { dataset: { key: 'month' } } })
      ok(c.data.range === 'month' && c.data.label === '本月',
        'C8 点胶囊切「本月」仍生效（v1.2 只摘外部联动，未动组件本体）', [c.data.range, c.data.label])
      ok(c.data.detail === '', 'C9 总结页（diaryDetail=false）非自定义档不显示说明文字', c.data.detail)
      ok(c.getRange().range === 'month', 'C10 getRange 反映新档位（HOST 侧读得到）')
      ok(c._emits.length === 1 && c._emits[0].name === 'change' && c._emits[0].detail.range === 'month',
        'C11 切档立即 emit change（页面据此更新 _rangeState）', c._emits)

      const c2 = makeComp(L.methods, L.data, true) // 日记本页口径
      c2.selectOption({ currentTarget: { dataset: { key: 'lastMonth' } } })
      ok(c2.data.detail === '上月日记', 'C12 日记本页（diaryDetail=true）说明文字跟随', c2.data.detail)

      const c3 = makeComp(L.methods, L.data, false)
      c3.selectOption({ currentTarget: { dataset: { key: 'nope' } } })
      ok(c3.data.range === 'all' && c3._emits.length === 0,
        'C13 不存在的档位：不改状态、不发事件（保持原行为）')
      c3.reset()
      ok(c3.data.range === 'all' && c3._emits.length === 1 && c3._emits[0].name === 'change',
        'C14 reset 仍归位「全部时间」并 emit change', [c3.data.range, c3._emits])
    }
  }

  console.log('\nsummary shortcut: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
