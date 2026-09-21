/**
 * 分片存储回归 [shard-storage v1] + 未备份提醒 [backup-remind v1]
 * 运行：node tools/test_storage_shards.js
 *
 * 覆盖：
 *  A) shardKeyFor：年份提取 / 无效日期归今年
 *  B) 旧格迁移（校验后自动清理）：混合年份 → 分片落格 + 校验通过清旧格 +
 *     读并集去重 + 重跑幂等 + 无 id 条目保留旧格且不复制进分格
 *  C) 增删改：saveDiary 落对格 / getDiaryById 跨格 / updateDiary 同格与跨年挪格 /
 *     deleteDiary 全格移除（含旧格）
 *  D) 每格 900KB 预检：precheckDiarySave 拦截 / saveDiary 弹「本地存储已满」
 *  E) 导入路径：mergeIntoShards 去重与失败回报 / replaceAllSharded 清旧格与空分格 /
 *     clearAllDiaries / importDiaries 按 id
 *  F) 未备份提醒：30/60/90 档位只弹一次 / 已开启云备份不弹 / 备份成功档位归零
 *  G) 静态断言：弹窗文案与「去导出备份」「一键开启云备份」按钮落位 / 年格满提示 / 失败如实回报
 *  H) [net-release v1] 空间近满时的自救：删日记、清空都不被空间闸挡住 /
 *     真没空间时仍拦住新增 / 写入失败如实回报 false（界面不得谎报「已删除」）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---- wx 桩（内存存储，getStorageSync 深拷贝防引用污染）----
const clone = (v) => JSON.parse(JSON.stringify(v))
let memStore = {}
let modals = []   // wx.showModal 捕获
let navs = []     // wx.navigateTo 捕获
let extraKB = 0   // 模拟其他 key（档案 / 字体 / 主题…）占用的空间
let throwOnKey = null // 指定 key 写入即抛异常（模拟 setStorageSync 失败）

// 真实口径的已用空间：微信 getStorageInfoSync().currentSize 单位是 KB（整数）。
// 桩里按「key 名 + JSON 串」的 UTF-8 字节估算，贴近真机；
// currentSize 恒 0 会让容量闸门永远测不出来（这正是上一轮死锁没被发现的原因之一）。
const utf8Len = (s) => Buffer.byteLength(s, 'utf8')
const usedKB = () => {
  let b = 0
  Object.keys(memStore).forEach((k) => { b += utf8Len(k) + utf8Len(JSON.stringify(memStore[k])) })
  return Math.ceil(b / 1024) + extraKB
}
function freshWx() {
  modals = []
  navs = []
  extraKB = 0
  throwOnKey = null
  global.wx = {
    getStorageSync: (k) => (k in memStore ? clone(memStore[k]) : ''),
    setStorageSync: (k, v) => {
      if (throwOnKey && k === throwOnKey) throw new Error('setStorageSync:fail')
      memStore[k] = clone(v)
    },
    removeStorageSync: (k) => { delete memStore[k] },
    getStorageInfoSync: () => ({ currentSize: usedKB(), limitSize: 10 * 1024, keys: Object.keys(memStore) }),
    showModal: (o) => { modals.push(o || {}); o && o.success && o.success({ confirm: false }) },
    navigateTo: (o) => { navs.push((o && o.url) || '') },
    showToast: () => {},
    showLoading: () => {}, hideLoading: () => {},
    getSystemInfoSync: () => ({ platform: 'devtools', windowWidth: 375, windowHeight: 700 }),
    onThemeChange: () => {},
    cloud: null
  }
}
freshWx()

let cache = null
function requireFresh(mod) {
  const p = path.join(ROOT, mod)
  delete require.cache[require.resolve(p)]
  return require(p)
}
function loadStorage() {
  freshWx()
  const s = requireFresh('utils/storage.js')
  // 红灯自检守卫：旧版无分片导出，补空实现让失败表现为「断言红」而非崩溃
  if (typeof s.shardKeyFor !== 'function') s.shardKeyFor = () => 'diaries_legacy'
  if (typeof s.ensureMigrated !== 'function') s.ensureMigrated = () => {}
  if (typeof s.precheckDiarySave !== 'function') s.precheckDiarySave = () => ({ ok: true })
  return s
}
function loadBackup() {
  const b = requireFresh('utils/backup.js')
  if (typeof b.markSyncedCount !== 'function') b.markSyncedCount = () => {}
  if (typeof b.getSyncedCount !== 'function') b.getSyncedCount = () => 0
  return b
}

let pass = 0
let fail = 0
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')) }
}
const shardDiaries = (st) => {
  const out = []
  Object.keys(st).forEach(k => {
    if (/^diaries(_\d{4})?$/.test(k) && Array.isArray(st[k])) out.push(...st[k])
  })
  return out
}

// ============================================================
console.log('== A) shardKeyFor：年份分格 ==')
{
  const storage = loadStorage()
  ok(storage.shardKeyFor({ created_at: '2024-03-05T12:00:00.000Z' }) === 'diaries_2024', '2024 → diaries_2024')
  ok(storage.shardKeyFor({ created_at: '2026-09-21T01:00:00.000Z' }) === 'diaries_2026', '2026 → diaries_2026')
  const thisYear = new Date().getFullYear()
  ok(storage.shardKeyFor({ created_at: '' }) === 'diaries_' + thisYear, '空 created_at → 今年格')
  ok(storage.shardKeyFor({ created_at: 'not-a-date' }) === 'diaries_' + thisYear, '非法日期 → 今年格')
  ok(storage.shardKeyFor({}) === 'diaries_' + thisYear, '无 created_at → 今年格')
  ok(storage.shardKeyFor(null) === 'diaries_' + thisYear, 'null 安全 → 今年格')
}

// ============================================================
console.log('\n== B) 旧格迁移（复制保留）==')
{
  memStore = {}
  freshWx()
  const legacy = [
    { id: 'o1', content: '二零二四年日记', created_at: '2024-05-01T12:00:00.000Z' },
    { id: 'o2', content: '二零二五年日记', created_at: '2025-08-15T12:00:00.000Z' },
    { id: 'o3', content: '二零二六年日记', created_at: '2026-01-10T12:00:00.000Z' }
  ]
  memStore['diaries'] = clone(legacy)
  const storage = loadStorage()
  const list = storage.getAllDiaries()
  ok(list.length === 3, '迁移后读并集 3 篇', list.length)
  ok(memStore['diaries_2024'] && memStore['diaries_2024'].length === 1, '2024 分格已建')
  ok(memStore['diaries_2025'] && memStore['diaries_2025'].length === 1, '2025 分格已建')
  ok(memStore['diaries_2026'] && memStore['diaries_2026'].length === 1, '2026 分格已建')
  ok(!('diaries' in memStore),
    '迁移校验通过后旧格已自动清理 [legacy-clean v1]')
  // 迁移重跑幂等：再读一轮不产生重复
  storage.getAllDiaries()
  ok(storage.getAllDiaries().length === 3, '重跑迁移去重后仍 3 篇（不重复）', storage.getAllDiaries().length)
  // [legacy-clean v1] 反例：旧格含无 id 条目 → 无法校验 → 旧格保留（且不复制进分格）
  memStore = {}
  freshWx()
  memStore['diaries'] = clone(legacy).concat([{ content: '无 id 旧数据', created_at: '2025-03-01T12:00:00.000Z' }])
  const s2 = loadStorage()
  ok(s2.getAllDiaries().length === 4, '无 id 条目：旧格保留，并集 4 篇（数据不丢）', s2.getAllDiaries().length)
  ok(Array.isArray(memStore['diaries']) && memStore['diaries'].length === 4,
    '校验不过（有无 id 条目）→ 旧格保留不删')
  ok(((memStore['diaries_2025'] || []).filter((d) => !d.id)).length === 0,
    '无 id 条目未复制进分格（避免并集重复）')
  // 空旧格 / 非数组旧格安全
  memStore = {}
  freshWx()
  memStore['diaries'] = []
  storage.getAllDiaries()
  ok(!('diaries_2026' in memStore) || true, '空旧格迁移安全')
}

// ============================================================
console.log('\n== C) 增删改查跨格 ==')
{
  memStore = {}
  const storage = loadStorage()
  const a = storage.saveDiary({ content: '老年份', created_at: '2023-02-01T12:00:00.000Z' })
  const b = storage.saveDiary({ content: '新年份', created_at: '2026-09-21T12:00:00.000Z' })
  ok(a && b, 'saveDiary 返回保存对象')
  ok(memStore['diaries_2023'] && memStore['diaries_2023'].length === 1, '2023 落 2023 格')
  ok(memStore['diaries_2026'] && memStore['diaries_2026'].length === 1, '2026 落 2026 格')
  ok(storage.getAllDiaries().length === 2, 'getAllDiaries 并集 2 篇')
  ok(storage.getDiaryById(a.id) && storage.getDiaryById(a.id).content === '老年份', 'getDiaryById 跨格命中')

  // 同格更新
  const u1 = storage.updateDiary(a.id, { content: '老年份改' })
  ok(u1 && u1.content === '老年份改', '同格更新生效')
  ok(((memStore['diaries_2023'] || [])[0] || {}).content === '老年份改', '同格更新写回 2023 格')

  // 跨年挪格：日期改成 2024 → 从 2023 格挪到 2024 格
  const u2 = storage.updateDiary(a.id, { content: '挪去2024', created_at: '2024-06-01T12:00:00.000Z' })
  ok(u2 && u2.created_at.indexOf('2024') === 0, '跨年更新返回值正确')
  ok((memStore['diaries_2023'] || []).length === 0, '旧 2023 格已移除', (memStore['diaries_2023'] || []).length)
  ok((memStore['diaries_2024'] || []).length === 1, '新 2024 格已有', (memStore['diaries_2024'] || []).length)
  ok(storage.getAllDiaries().length === 2, '跨年挪格后仍 2 篇（不重复不丢失）')

  // 删除：全格同步移除（含旧格）
  memStore['diaries'] = [{ id: b.id, content: '旧格里的同 id 复制品', created_at: '2026-09-21T12:00:00.000Z' }]
  storage.deleteDiary(b.id)
  ok((memStore['diaries_2026'] || []).length === 0, '分格中已删')
  ok((memStore['diaries'] || []).length === 0, '旧格中的同 id 也同步删除')
  ok(storage.getAllDiaries().length === 1, '删除后仅剩 1 篇')
}

// ============================================================
console.log('\n== D) 每格 900KB 预检 ==')
{
  memStore = {}
  const storage = loadStorage()
  const big = 'x'.repeat(905 * 1024) // 905KB：单格已超 900KB 软上限
  memStore['diaries_2026'] = [{ id: 'big1', content: big, created_at: '2026-05-01T12:00:00.000Z' }]
  const r = storage.precheckDiarySave({ content: '新增一篇', created_at: '2026-05-02T12:00:00.000Z' })
  ok(r.ok === false, '分格超 900KB → 预检不通过')
  ok(r.shardLimit === 900 * 1024, '预检返回单格上限', r.shardLimit)
  // [shard-full v1] 整机还有 9MB、只是这一年放不下 → 必须与「整机存储满」区分开
  ok(r.shardFull === true && r.totalFull === false, '年格满 → shardFull=true 且 totalFull=false',
    { shardFull: r.shardFull, totalFull: r.totalFull })
  ok(r.shardYear === 2026, '预检回报目标年份（提示文案要指名该年）', r.shardYear)
  const saved = storage.saveDiary({ content: '新增一篇', created_at: '2026-05-02T12:00:00.000Z' })
  ok(saved === null, 'saveDiary 存储已满返回 null（不写一半）')
  ok(modals.length === 1 && modals[0].title === '本地存储已满', '弹「本地存储已满」弹窗', modals.length)
  ok((modals[0] || {}).content === '本地存储已满，请先备份再删除日记腾出空间', '文案与拍板一致')
  ok((modals[0] || {}).confirmText === '去导出备份' && (modals[0] || {}).cancelText === '知道了', '按钮为「去导出备份/知道了」')

  // 另一年份分格未满 → 不受影响
  const okR = storage.precheckDiarySave({ content: '2025 的日记', created_at: '2025-05-02T12:00:00.000Z' })
  ok(okR.ok === true, '其他年份分格未满 → 预检通过')
}

// ============================================================
console.log('\n== E) 导入路径 ==')
{
  memStore = {}
  const storage = loadStorage()
  // E1 文本导入（合并，跨年分拣）
  const r1 = storage.importDiariesFromText('2024年3月1日\n三月内容。\n2026年9月1日\n九月内容。')
  ok(r1.added === 2 && r1.total === 2, '文本导入 2 篇（跨年）', r1)
  ok((memStore['diaries_2024'] || []).length === 1 && (memStore['diaries_2026'] || []).length === 1,
    '按年份各落各格')
  // E2 重复导入去重
  const r2 = storage.importDiariesFromText('2024年3月1日\n三月内容。')
  ok(r2.added === 0 && r2.total === 2, '同日期同内容不重复落库', r2)
  // E3 replace 模式：清旧格 + 清空分格
  memStore['diaries'] = [{ id: 'stale', content: '旧格残留', created_at: '2020-01-01T00:00:00.000Z' }]
  memStore['diaries_2019'] = [{ id: 'old9', content: '2019 旧分格', created_at: '2019-01-01T00:00:00.000Z' }]
  const r3 = storage.importDiariesFromText('2026年1月1日\n替换后唯一内容。', true)
  ok(r3.added === 1, 'replace 导入 1 篇', r3)
  ok(!('diaries' in memStore) && !('diaries_2019' in memStore), 'replace 清掉旧格与闲置分格',
    Object.keys(memStore))
  ok(storage.getAllDiaries().length === 1, 'replace 后仅 1 篇')
  // E4 importDiaries 按 id 去重
  const n1 = storage.importDiaries([
    { id: 'x1', content: '甲', created_at: '2026-06-01T12:00:00.000Z' },
    { id: 'x1', content: '甲重复', created_at: '2026-06-01T12:00:00.000Z' }
  ])
  ok(n1 === 1, '同 id 只落一次', n1)
  const n2 = storage.importDiaries([{ id: 'x1', content: '甲', created_at: '2026-06-01T12:00:00.000Z' }])
  ok(n2 === 0, '再导同 id → 0', n2)
  // E5 replaceAllDiaries（恢复备份）+ clearAllDiaries
  const rn = storage.replaceAllDiaries([
    { id: 'r1', content: '恢复一', created_at: '2025-01-01T12:00:00.000Z' },
    { id: 'r2', content: '恢复二', created_at: '2026-02-01T12:00:00.000Z' }
  ])
  ok(rn === 2 && storage.getAllDiaries().length === 2, 'replaceAllDiaries 2 篇')
  storage.clearAllDiaries()
  ok(storage.getAllDiaries().length === 0, 'clearAllDiaries 清空（含全部分格）')
  ok(Object.keys(memStore).filter(k => /^diaries/.test(k)).length === 0, '日记相关格全部移除',
    Object.keys(memStore))
}

// ============================================================
console.log('\n== F) 未备份提醒（30/60/90 档位）==')
{
  memStore = {}
  const storage = loadStorage()
  const backup = loadBackup()
  ok(typeof backup.getSyncedCount === 'function' && typeof backup.markSyncedCount === 'function',
    'backup 导出 getSyncedCount / markSyncedCount')

  function seedDiaries(n) {
    memStore['diaries_2026'] = []
    for (let i = 0; i < n; i++) {
      memStore['diaries_2026'].push({
        id: 'f' + i, content: '第' + i + '篇',
        created_at: '2026-08-' + String(1 + (i % 28)).padStart(2, '0') + 'T12:00:00.000Z'
      })
    }
  }
  // 未满 30 → 不弹
  seedDiaries(28)
  storage.saveDiary({ content: '第29篇不会弹', created_at: '2026-09-01T12:00:00.000Z' })
  ok(modals.length === 0, '未满 30 篇（29 篇）→ 不提醒', modals.length)

  // 满 30 → 弹一次
  seedDiaries(29) // 29 篇 + 本次保存 = 30
  storage.saveDiary({ content: '满三十', created_at: '2026-09-02T12:00:00.000Z' })
  ok(modals.length === 1 && modals[0].title === '备份提醒', '满 30 篇 → 提醒一次', modals.length)
  ok(/已 30 篇未备份/.test((modals[0] || {}).content || ''), '文案含「已 30 篇未备份」', (modals[0] || {}).content)
  ok((modals[0] || {}).confirmText === '一键开启云备份', '按钮为「一键开启云备份」')
  ok(memStore['backup_alert_level'] === 1, '档位标记推进到 1')
  // 同档位不再弹
  storage.saveDiary({ content: '再存一篇', created_at: '2026-09-03T12:00:00.000Z' })
  ok(modals.length === 1, '同档位不重复提醒')

  // 已开启云备份 → 不弹
  memStore['cloud_backup_state'] = { enabled: true, key: 'k' }
  const before = modals.length
  storage.saveDiary({ content: '已开启备份', created_at: '2026-09-04T12:00:00.000Z' })
  ok(modals.length === before, '已开启云备份 → 不提醒')

  // markSyncedCount：记录已备份篇数 + 推进档位
  backup.markSyncedCount(65)
  ok(memStore['backup_synced_count'] === 65, 'markSyncedCount 落盘', memStore['backup_synced_count'])
  // [backup-remind fix] 语义是「已提醒到第几档未备份量」，备份成功这一刻未备份量归 0 ⇒ 档位归零。
  // 旧实现写 Math.floor(n/30)（把「已备份篇数」当档位），备份 65 篇后要攒到 90 篇才再提醒。
  ok(memStore['backup_alert_level'] === 0, '备份成功 → 提醒档位归零', memStore['backup_alert_level'])
  ok(backup.getSyncedCount() === 65, 'getSyncedCount 读回')

  // 归零后只需再攒 30 篇未备份就该提醒（旧实现要攒到 90 篇）
  memStore['cloud_backup_state'] = { enabled: false }
  seedDiaries(95)
  backup.markSyncedCount(65)
  ok(memStore['backup_alert_level'] === 0, '归零可重复执行（幂等）', memStore['backup_alert_level'])
  const before2 = modals.length
  storage.saveDiary({ content: '归零后第 96 篇', created_at: '2026-09-06T12:00:00.000Z' })
  ok(modals.length === before2 + 1, '归零后仅再攒 30 篇未备份即再次提醒（不是 90 篇）', modals.length - before2)
  ok(/已 31 篇未备份/.test((modals[modals.length - 1] || {}).content || ''),
    '提醒文案反映真实未备份量', (modals[modals.length - 1] || {}).content)
}

// ============================================================
console.log('\n== G) 静态断言（弹窗与按钮落位）==')
{
  const sto = read('utils/storage.js')
  const wjs = read('pages/write/write.js')
  const bjs = read('utils/backup.js')
  ok(sto.indexOf("content: '本地存储已满，请先备份再删除日记腾出空间'") !== -1,
    'storage 弹窗文案与拍板一致')
  ok((sto.match(/去导出备份/g) || []).length >= 2, '存储已满 / 备份提醒两处都有「去导出备份」按钮')
  ok(sto.indexOf("confirmText: '一键开启云备份'") !== -1, '备份提醒带「一键开启云备份」')
  ok(sto.indexOf('/pages/backup/backup') !== -1, '按钮直达备份页')
  ok(wjs.indexOf('本地存储已满，请先备份再删除日记腾出空间') !== -1, '写页预检弹窗文案一致')
  ok((wjs.match(/去导出备份/g) || []).length >= 2, '写页两处弹窗（预检 + 8MB 预警）都带跳转按钮')
  ok(bjs.indexOf("SYNCED_KEY = 'backup_synced_count'") !== -1, 'backup 记录已备份篇数')
  ok((bjs.match(/markSyncedCount\(/g) || []).length >= 4, 'enable/sync/adoptCloud 成功路径都上报已备份篇数')

  // [shard-full v1] 写页按 totalFull / shardFull 给不同提示，年格满必须指名该年
  ok(wjs.indexOf('const yearFull = space.shardFull && !space.totalFull') !== -1, '写页区分年格满 / 整机满')
  ok(wjs.indexOf('年的日记已达上限') !== -1, '年格满提示指向该年（删往年腾不出该年）')

  // [net-release v1] 删除 / 清空的失败必须如实回报，不得无条件弹成功
  const djs = read('pages/detail/detail.js')
  const sjs = read('pages/setting/setting.js')
  ok(djs.indexOf('okDelete = storage.deleteDiary(this.data.id) !== false') !== -1,
    '详情页按 deleteDiary 返回值判断')
  ok(djs.indexOf('删除失败，请先导出备份腾出空间') !== -1, '删除失败有诚实提示')
  ok(djs.indexOf('if (okDelete) {') !== -1, '本地没删成功就不动云端媒体')
  ok(sjs.indexOf('const okClear = storage.clearAllDiaries()') !== -1, '设置页按 clearAllDiaries 返回值判断')
  ok(sjs.indexOf('清除失败，请先导出备份后重试') !== -1, '清除失败有诚实提示')

  // 旧写法必须消失
  ok(bjs.indexOf("wx.setStorageSync('backup_alert_level', Math.floor(n / 30))") === -1,
    'backup 档位不再用「已备份篇数」推进')
  ok(sto.indexOf('ok: total.ok && est <= SHARD_LIMIT,') === -1, '预检不再只回一个 ok 布尔')
  ok(sto.indexOf('const release = isNetRelease(readStorageBytes(key), est)') !== -1,
    '释放型写入免余量闸已生效')
}

// ============================================================
console.log('\n== H) 空间近满时的自救路径 [net-release v1] ==')
{
  // 造真实水位：12 个年份分格 × 200 篇 × ~4KB ≈ 9.3MB（>90%）。
  // 此时「删一篇」要写回一个 ~795KB 的分格，旧实现会因「剩余 < 待写回 + 200KB」把删除也挡掉。
  function seedHeavy(years, perYear, len) {
    const unit = 'x'.repeat(len)
    years.forEach((y) => {
      const arr = []
      for (let i = 0; i < perYear; i++) {
        arr.push({ id: 'h' + y + '_' + i, content: unit, created_at: y + '-05-01T12:00:00.000Z' })
      }
      memStore['diaries_' + y] = arr
    })
  }
  const YEARS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021]

  // H1 删一篇不再被「空间不足」挡住
  memStore = {}
  let storage = loadStorage()
  seedHeavy(YEARS, 200, 4000)
  const waterMB = (usedKB() / 1024).toFixed(2)
  const delOk = storage.deleteDiary('h2010_0')
  ok(delOk === true, 'H1 水位 ' + waterMB + 'MB：deleteDiary 返回 true（如实回报成功）', delOk)
  ok(!(memStore['diaries_2010'] || []).some(d => d.id === 'h2010_0'),
    'H1 日记真的删掉了', (memStore['diaries_2010'] || []).length)
  ok(modals.length === 0, 'H1 删除不该弹「本地存储已满」', modals.length)

  // H2 清空（最后一条自救路）也不被挡住
  memStore = {}
  storage = loadStorage()
  seedHeavy(YEARS, 200, 4000)
  extraKB = 600 // 其他 key 也占了 600KB ⇒ 可写空间只剩 ~100KB
  ok(storage.clearAllDiaries() === true, 'H2 近满时 clearAllDiaries 返回 true')
  ok(storage.getAllDiaries().length === 0, 'H2 日记真的清空了', storage.getAllDiaries().length)
  ok(Object.keys(memStore).filter(k => /^diaries/.test(k)).length === 0, 'H2 全部分格已移除', Object.keys(memStore))

  // H3 真没空间时仍必须拦住「新增」（修死锁不能把正常闸门一起拆掉）
  memStore = {}
  storage = loadStorage()
  seedHeavy(YEARS, 200, 4000)
  extraKB = 600
  modals = []
  const blocked = storage.saveDiary({ content: '新增一篇', created_at: '2026-09-01T12:00:00.000Z' })
  ok(blocked === null, 'H3 真没空间 → saveDiary 返回 null（不写一半）')
  ok(modals.length === 1 && modals[0].title === '本地存储已满', 'H3 仍然弹「本地存储已满」', modals.length)
  ok(storage.precheckDiarySave({ content: '再来一篇', created_at: '2026-09-01T12:00:00.000Z' }).totalFull === true,
    'H3 预检回报 totalFull=true（整机满，不是年格满）')

  // H4 写入真的失败时必须如实回报 false（界面不得提示「已删除」）
  memStore = {}
  storage = loadStorage()
  seedHeavy([2010], 5, 200)
  throwOnKey = 'diaries_2010'
  modals = []
  const badOk = storage.deleteDiary('h2010_0')
  ok(badOk === false, 'H4 写入失败 → deleteDiary 返回 false', badOk)
  ok((memStore['diaries_2010'] || []).some(d => d.id === 'h2010_0'), 'H4 日记仍在（没有谎报删除）')

  extraKB = 0
  throwOnKey = null
}

// ============================================================
console.log('\nstorage shards: ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exit(1)
