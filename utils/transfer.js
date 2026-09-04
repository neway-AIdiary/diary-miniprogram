/**
 * utils/transfer.js
 * 日记导入/导出的共用流程，供「写日记」侧边栏与「我的」页复用：
 *   - exportToWord(): 导出全部日记为标准 Word（.docx，OOXML），微信/WPS/Word 全平台可打开
 *   - exportToClipboard(): 导出为纯文本，复制到剪贴板（备用）
 *   - importFromFile(opts): 选择文件 → 解析（.docx / 旧版 .doc / JSON / 纯文本 / AI 智能识别兜底）→ 导入
 */

const storage = require('./storage.js')
const util = require('./util.js')

/**
 * 导出所有日记为标准 Word 文件（.docx）
 * 文件名按日期范围命名，如「7月1日-8月30日日记.docx」
 * @param {function} onEmpty 无日记可导出时回调
 * @returns {boolean} 是否开始导出
 */
function exportToWord(onEmpty) {
  const list = storage.getAllDiaries()
  if (!list.length) {
    if (onEmpty) onEmpty()
    return false
  }
  const fileName = storage.buildWordFileName(list)
  wx.showLoading({ title: '正在生成 Word…', mask: true })
  resolveMediaForDocx(list).then((media) => {
    const buffer = storage.buildDocx(list, media.imgBin, media.videoMap)
    const fs = wx.getFileSystemManager()
    const filePath = wx.env.USER_DATA_PATH + '/' + fileName
    fs.writeFile({
      filePath: filePath,
      data: buffer,
      success: () => {
        wx.hideLoading()
        // 先打开预览（主反馈，保证点击后有反应），预览打开成功后再提示保存路径
        wx.openDocument({
          filePath: filePath,
          fileType: 'docx',
          showMenu: true,
          success: () => {
            wx.showModal({
              title: '导出成功',
              content: '已保存到【' + filePath + '】\n\n文件保存在小程序内（手机文件/WPS 中看不到）。点「发送」转发到文件传输助手，即可在手机中找到并用 WPS 打开。',
              confirmText: '发送',
              cancelText: '知道了',
              success: (res) => {
                if (res.confirm && typeof wx.shareFileMessage === 'function') {
                  wx.shareFileMessage({
                    filePath: filePath,
                    fileName: fileName,
                    fail: () => {
                      wx.showToast({ title: '未发送成功，可用预览页右上角「···」转发', icon: 'none' })
                    }
                  })
                }
              }
            })
          },
          fail: () => {
            wx.showModal({
              title: 'Word 已生成',
              content: '已保存到【' + filePath + '】\n\n文件生成成功，但自动打开预览失败。可重新导出；若反复失败，可换用「导出到剪贴板」备份文本。',
              showCancel: false,
              confirmText: '知道了'
            })
          }
        })
      },
      fail: (err) => {
        wx.hideLoading()
        wx.showModal({
          title: '导出失败',
          content: '写入文件失败：' + ((err && err.errMsg) || '未知错误'),
          showCancel: false,
          confirmText: '知道了'
        })
      }
    })
  }).catch((e) => {
    wx.hideLoading()
    wx.showModal({
      title: '导出失败',
      content: '生成文档出错：' + ((e && e.message) || '未知错误'),
      showCancel: false,
      confirmText: '知道了'
    })
  })
  return true
}

// 解析日记媒体 → 图片二进制 base64（内嵌 docx，离线可看）/ 视频临时链接（云文件）
// 图片超总预算（8MB）时跳过该图；视频链接有时效（文档中已注明）
function resolveMediaForDocx(diaries) {
  const imgBin = {}
  const videoMap = {}
  if (!wx.cloud) return Promise.resolve({ imgBin: imgBin, videoMap: videoMap })
  const fs = wx.getFileSystemManager()
  const tasks = []
  let budget = 8 * 1024 * 1024 // 图片二进制总预算 8MB
  ;(diaries || []).forEach(d => {
    ;(d.media || []).forEach(m => {
      const fid = m.fileID
      if (!fid) return
      if (m.type === 'video') {
        tasks.push(wx.cloud.getTempFileURL({ fileList: [fid] }).then((res) => {
          const f = res.fileList && res.fileList[0]
          if (f && f.tempFileURL) videoMap[fid] = f.tempFileURL
        }).catch(() => {}))
      } else {
        tasks.push(wx.cloud.downloadFile({ fileID: fid })
          .then((res) => res.tempFilePath)
          .catch(() => null)
          .then((temp) => {
            if (!temp) return
            return new Promise((resolve) => {
              fs.readFile({
                filePath: temp,
                encoding: 'base64',
                success: (r) => {
                  const b64 = String(r.data || '')
                  const approxBytes = Math.floor(b64.length * 3 / 4)
                  if (approxBytes > budget) { resolve(); return } // 超预算：跳过该图
                  budget -= approxBytes
                  const extM = String(fid).toLowerCase().match(/\.(jpe?g|png|gif|bmp)(\?|$)/)
                  let ext = extM ? extM[1] : 'jpg'
                  if (ext === 'jpeg') ext = 'jpg'
                  imgBin[fid] = { ext: ext, b64: b64 }
                  resolve()
                },
                fail: () => resolve()
              })
            })
          }))
      }
    })
  })
  return Promise.all(tasks).then(() => ({ imgBin: imgBin, videoMap: videoMap }))
}

// 导入时把 Word 回退路径解析出的 base64 图片上传到云存储，替换为 fileID
function uploadParsedImages(diaries) {
  const pending = []
  ;(diaries || []).forEach(d => {
    ;(d.media || []).forEach(m => {
      if (m && m.type === 'image' && m._data) pending.push({ media: m })
    })
  })
  if (!pending.length || !wx.cloud) {
    ;(diaries || []).forEach(d => {
      d.media = (d.media || []).filter(m => !(m && m._data))
    })
    return Promise.resolve(diaries)
  }
  const fs = wx.getFileSystemManager()
  const uploadOne = (p) => new Promise((resolve) => {
    const mime = String(p.media._mime || 'jpeg').replace(/[^a-zA-Z0-9]/g, '') || 'jpeg'
    const ext = mime === 'jpeg' ? 'jpg' : mime
    const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const tmp = wx.env.USER_DATA_PATH + '/imp_' + stamp + '.' + ext
    fs.writeFile({
      filePath: tmp,
      data: p.media._data,
      encoding: 'base64',
      success: () => {
        wx.cloud.uploadFile({
          cloudPath: 'diaries/import/' + stamp + '.' + ext,
          filePath: tmp,
          success: (r) => {
            p.media.fileID = r.fileID
            delete p.media._data
            delete p.media._mime
            resolve()
          },
          fail: () => resolve()
        })
      },
      fail: () => resolve()
    })
  })
  return pending.reduce((chain, p) => chain.then(() => uploadOne(p)), Promise.resolve()).then(() => {
    // 剔除上传失败的 base64 占位
    ;(diaries || []).forEach(d => {
      d.media = (d.media || []).filter(m => !(m && m.type === 'image' && !m.fileID))
    })
    return diaries
  })
}

/**
 * 导出所有日记为纯文本并复制到剪贴板
 * @param {function} onEmpty 无日记可导出时回调
 * @returns {boolean} 是否导出成功
 */
function exportToClipboard(onEmpty) {
  const result = storage.exportDiariesToText()
  if (result.count === 0) {
    if (onEmpty) onEmpty()
    return false
  }
  wx.setClipboardData({
    data: result.text,
    success: () => {
      wx.showModal({
        title: '导出成功',
        content: '共导出 ' + result.count + ' 篇日记，纯文本已复制到剪贴板。请粘贴保存为一个 .txt 文件（每篇按日期分段），方便日后导入或备份。',
        showCancel: false,
        confirmText: '知道了'
      })
    }
  })
  return true
}

/**
 * 导入日记完整流程（选择文件 → 解析 → 导入 → 结果上报）
 * @param {object} opts
 *   - onFinish(added:number, toast:string) 导入完成（含“没有新增”的情况）
 *   - onError(msg:string) 导入失败
 */
function importFromFile(opts) {
  opts = opts || {}
  const finish = (added, extraMsg) => {
    const toast = added === -1
      ? '本地存储已满，导入失败。\n\n请先导出备份，再删除部分旧日记腾出空间后重试。'
      : (added > 0
        ? '已导入 ' + added + ' 条日记'
        : '没有新增日记（内容已存在，无需重复导入）')
    const title = added === -1 ? '导入失败' : (added > 0 ? '导入完成' : '导入提示')
    if (extraMsg) {
      wx.showModal({
        title: title,
        content: toast + '\n\n' + extraMsg,
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    if (opts.onFinish) opts.onFinish(added, toast)
  }
  const error = (msg) => {
    if (opts.onError) opts.onError(msg)
  }

  // .docx 导入流程（标准 Word：解压 → 解析 word/document.xml）
  const importDocx = (file, mode) => {
    const fs = wx.getFileSystemManager()
    const unzipDir = wx.env.USER_DATA_PATH + '/imp_docx'
    const doUnzip = () => {
      if (!fs.unzip) {
        error('当前微信版本过低，无法解压 Word 文档。\n\n请把微信升级到最新版本后重试。')
        return
      }
      fs.unzip({
        zipFilePath: file.path,
        targetPath: unzipDir,
        success: () => {
          fs.readFile({
            filePath: unzipDir + '/word/document.xml',
            encoding: 'utf8',
            success: (docRes) => {
              try {
                const parsed = storage.parseDocxXml(String(docRes.data || ''))
                if (!parsed.diaries.length) {
                  error('未能从 Word 文档中识别出日记内容。\n\n请确认选择的是 AI日记 导出的 .docx 备份文件。')
                  return
                }
                if (parsed.full) {
                  // 隐藏 JSON：保留原始 id 与媒体 fileID，按 id 去重合并
                  const added = mode === 'replace'
                    ? storage.replaceAllDiaries(parsed.diaries)
                    : storage.importDiaries(parsed.diaries)
                  finish(added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '')
                } else {
                  // 回退解析：新 id，按「日期+内容」去重合并
                  const r = storage.importDiaryObjects(parsed.diaries, mode === 'replace')
                  finish(r.added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '')
                }
              } catch (e) {
                error('解析 Word 文档出错：' + ((e && e.message) || e) + '。\n\n数据未改动，请重试。')
              }
            },
            fail: () => {
              error('解压后未找到文档内容（word/document.xml），文件可能不是标准 Word 文档或已损坏。')
            }
          })
        },
        fail: (err) => {
          error('解压 Word 文档失败：' + ((err && err.errMsg) || '未知错误') +
            '。\n\n请确认文件是完整的 .docx 文件；若反复失败可把微信升级到最新版本后重试。')
        }
      })
    }
    // 清理上一次导入的解压目录
    fs.rmdir({ dirPath: unzipDir, recursive: true, success: doUnzip, fail: doUnzip })
  }

  wx.showActionSheet({
    itemList: ['导入日记（合并）', '恢复备份（覆盖现有）'],
    success: (res) => {
      const mode = res.tapIndex === 0 ? 'merge' : 'replace'
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['docx', 'doc', 'txt', 'json'],
        success: (chooseRes) => {
          const file = chooseRes.tempFiles[0]
          if (!file || !file.path) {
            wx.showToast({ title: '未选择文件', icon: 'none' })
            return
          }
          // 标准 Word（.docx）：zip 包，走解压解析流程
          if (/\.docx$/i.test(file.name || '') || /\.docx$/i.test(file.path || '')) {
            importDocx(file, mode)
            return
          }
          wx.getFileSystemManager().readFile({
            filePath: file.path,
            encoding: 'utf8',
            success: (readRes) => {
              try {
                let raw = String(readRes.data || '')
                // 去掉 UTF-8 BOM（部分编辑器保存文件会自动加上）
                if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
                const trimmed = raw.trim()
                if (!trimmed) {
                  error('文件内容为空，请选择包含日记内容的文件。')
                  return
                }
                // 检测 UTF-16 等非 UTF-8 编码（特征：大量 \u0000 空字符）
                if (trimmed.indexOf('\u0000') !== -1) {
                  error('文件编码无法识别（可能是 UTF-16 或 GBK 编码）。\n\n请用记事本打开该文件，选择「另存为」，把右下角编码改为 UTF-8 后再导入。')
                  return
                }

                let added = 0
                let recognized = false

                // 1) 兼容旧版 .json 备份（以 { 或 [ 开头且是合法 JSON）
                if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
                  try {
                    const parsed = JSON.parse(trimmed)
                    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.diaries)
                    if (list) {
                      added = mode === 'replace' ? storage.replaceAllDiaries(list) : storage.importDiaries(list)
                      recognized = true
                    }
                  } catch (e) {
                    // 不是合法 JSON，继续向下检测
                  }
                }

                // 2) 旧版 Word 格式（.doc HTML 包装：本应用早期导出的文件）
                const looksWord = raw.indexOf('<div') !== -1 &&
                  (/class="[^"]*\bdiary\b[^"]*"/.test(raw) || /ai-diary-data/.test(raw))
                if (!recognized && looksWord) {
                  const parsed = storage.parseWordHtml(raw)
                  if (parsed.diaries.length) {
                    wx.showLoading({ title: '还原图片…', mask: true })
                    uploadParsedImages(parsed.diaries).then((list) => {
                      wx.hideLoading()
                      if (parsed.full) {
                        // 隐藏 JSON：保留原始 id，按 id 去重合并
                        added = mode === 'replace' ? storage.replaceAllDiaries(list) : storage.importDiaries(list)
                      } else {
                        // 回退解析：新 id，按「日期+内容」去重合并
                        const r = storage.importDiaryObjects(list, mode === 'replace')
                        added = r.added
                      }
                      recognized = true
                      finish(added, parsed.notes && parsed.notes.length ? parsed.notes.join('\n') : '')
                    }).catch((e) => {
                      wx.hideLoading()
                      error('导入过程中发生错误：' + (e && e.message || e) + '。\n\n数据未改动，请重试。')
                    })
                    return
                  }
                }

                // 3) 纯文本格式（日期分段）
                if (!recognized) {
                  const parsedCount = storage.parseDiariesFromText(raw).length
                  if (parsedCount === 0) {
                    // 本地解析失败 → 询问是否用 AI 智能识别文本中的日记
                    aiParseFlow(raw, mode, opts)
                    return
                  }
                  const result = storage.importDiariesFromText(raw, mode === 'replace')
                  added = result.added
                }

                finish(added)
              } catch (e) {
                error('导入过程中发生错误：' + (e && e.message || e) + '。\n\n数据未改动，请重试；若仍失败，可把文件发给我们排查。')
              }
            },
            fail: (err) => {
              error('读取文件失败：' + (err && err.errMsg || '文件无法访问') + '。\n\n请确认文件存在且未损坏后重新选择。')
            }
          })
        }
      })
    }
  })
}

// AI 智能识别导入（本地解析失败时兜底）
function aiParseFlow(raw, mode, opts) {
  wx.showModal({
    title: '未识别到标准格式',
    content: '这个文件不是 AI日记 导出的备份格式。\n\n是否用 AI 智能识别其中的日记内容，按日期整理后导入日记本？',
    confirmText: 'AI 识别导入',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return
      const aiCloud = require('./aiCloud.js')
      wx.showLoading({ title: 'AI 识别中...', mask: true })
      aiCloud.callAIParse(raw).then((result) => {
        wx.hideLoading()
        if (result.error || !result.diaries || !result.diaries.length) {
          const reason = result.error || '未能从文本中识别出日记内容'
          if (opts.onError) opts.onError('AI 识别失败：' + reason + '。\n\n请确认：\n1. 文件是文字内容而非图片/扫描件；\n2. 云函数已重新部署（optimizeDiary）；\n3. 网络正常。')
          return
        }
        // 转成日记对象
        const list = result.diaries.map(item => storage.buildDiaryFromAI(item))
        // 预览前 3 篇
        const preview = list.slice(0, 3).map(d => {
          const snippet = d.content.length > 18 ? d.content.slice(0, 18) + '…' : d.content
          return '· ' + util.formatDate(d.created_at) + '  ' + snippet
        }).join('\n')
        const more = list.length > 3 ? '\n… 共 ' + list.length + ' 篇' : ''
        wx.showModal({
          title: 'AI 识别到 ' + list.length + ' 篇日记',
          content: preview + more + '\n\n按日期导入日记本，确认吗？',
          confirmText: '确认导入',
          cancelText: '取消',
          success: (res2) => {
            if (!res2.confirm) return
            try {
              const r = storage.importDiaryObjects(list, mode === 'replace')
              if (opts.onFinish) opts.onFinish(r.added, r.added > 0 ? '已导入 ' + r.added + ' 条日记' : '没有新增日记（内容已存在，无需重复导入）')
            } catch (e) {
              if (opts.onError) opts.onError('写入日记本时出错：' + (e && e.message || e) + '。\n\n数据未改动，请重试。')
            }
          }
        })
      })
    }
  })
}

module.exports = { exportToWord, exportToClipboard, importFromFile }
