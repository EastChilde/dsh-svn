/**
 * dsh-svn —— Agent 工具（只读）。
 *
 * 让模型在对话里直接看 SVN 状态、历史、差异、溯源，而不用自己拼命令行：
 *   svn_info / svn_status / svn_log / svn_diff / svn_blame
 *
 * 刻意不提供 commit / update / revert 这类写操作：提交是人的决定，
 * 面板里有确认流程；模型只读，避免误提交整个工作副本。
 */

const STATUS_LETTER = {
  conflicted: 'C',
  incomplete: '!',
  obstructed: '~',
  missing: '!',
  modified: 'M',
  replaced: 'R',
  added: 'A',
  deleted: 'D',
  unversioned: '?',
  external: 'X',
  ignored: 'I',
  normal: ' ',
}

const STATUS_LABEL = {
  conflicted: '冲突',
  incomplete: '不完整',
  obstructed: '阻塞',
  missing: '丢失',
  modified: '修改',
  replaced: '替换',
  added: '新增',
  deleted: '删除',
  unversioned: '未纳入',
  external: '外部',
  ignored: '忽略',
  normal: '正常',
}

let cachedDefineTool = null

async function loadDefineTool() {
  if (cachedDefineTool) return cachedDefineTool
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') cachedDefineTool = mod.defineTool
  } catch (err) {
    console.warn('[dsh-svn] 没能加载 @deepseek-ai/dsh-tools，工具按裸定义注册：' + String((err && err.message) || err))
  }
  if (!cachedDefineTool) cachedDefineTool = (definition) => definition
  return cachedDefineTool
}

function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function fmtDate(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function firstLine(message, max = 160) {
  const line = String(message || '').split(/\r?\n/)[0].trim()
  return line.length > max ? line.slice(0, max) + '…' : line
}

function pickWorkingCopy(core, args) {
  const explicit = args && typeof args.workingCopy === 'string' ? args.workingCopy.trim() : ''
  if (explicit) return core.resolveWorkingCopy(explicit).wc.path

  try {
    return core.resolveWorkingCopy(process.cwd()).wc.path
  } catch (err) {
    // 当前目录不在工作副本里，继续用配置兜底
  }

  const config = core.readConfig()
  if (config.workingCopies.length === 1) return config.workingCopies[0].path
  if (!config.workingCopies.length) throw new Error('还没有登记任何 SVN 工作副本，请先在侧栏的 SVN 面板里添加')
  throw new Error('有多个工作副本，请用 workingCopy 参数指定：' + config.workingCopies.map((item) => item.path).join('、'))
}

function statusSummary(result) {
  const summary = result.summary || {}
  const parts = []
  for (const key of ['conflicted', 'modified', 'added', 'deleted', 'missing', 'replaced', 'unversioned']) {
    if (summary[key]) parts.push(`${STATUS_LABEL[key]} ${summary[key]}`)
  }
  const head = `${result.path}：${summary.total || 0} 项更改`
    + (parts.length ? `（${parts.join('、')}）` : '')
    + (result.remote ? '（含远程对比）' : '')
  const rows = (result.entries || [])
    .filter((entry) => entry.item !== 'ignored' && entry.item !== 'normal')
    .slice(0, 80)
    .map((entry) => `${STATUS_LETTER[entry.item] || '?'}  ${entry.path}${entry.treeConflicted ? '  [树冲突]' : ''}`)
  const more = (result.entries || []).length > 80 ? `\n… 另有 ${result.entries.length - 80} 项` : ''
  return head + (rows.length ? '\n' + rows.join('\n') : '') + more
}

function logSummary(result) {
  const entries = result.entries || []
  if (!entries.length) return `${result.path}：没有匹配的提交记录。`
  const lines = entries.map((entry) => {
    const files = entry.paths && entry.paths.length ? `  [${entry.paths.length} 个文件]` : ''
    return `r${entry.revision} · ${entry.author || '(无作者)'} · ${fmtDate(entry.date)} · ${firstLine(entry.message) || '(无提交信息)'}${files}`
  })
  return `${result.path}：${entries.length} 条提交记录`
    + (result.hasMore ? '（还有更早的记录，可用 beforeRev=' + result.nextBefore + ' 继续取）' : '')
    + '\n' + lines.join('\n')
}

function diffSummary(result) {
  const fileCount = (result.diff.match(/^Index: /gm) || []).length
  let head
  if (result.mode === 'revision') head = `r${result.revision} 的差异`
  else if (result.mode === 'range') head = `版本区间的差异`
  else head = '工作副本本地差异'
  if (result.relPath) head += `（${result.relPath}）`
  if (result.empty) return head + '：没有差异。'
  return `${head}：${fileCount} 个文件，+${result.additions} -${result.deletions}`
    + (result.binary ? '（含二进制文件）' : '')
    + (result.truncated ? '（已截断）' : '')
}

/**
 * 注册全部工具。
 * @param ctx 宿主上下文（需带 tools 服务）
 * @param getCore () => 当前 core 模块
 */
export async function registerSvnTools(ctx, getCore) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    return { count: 0, dispose: () => {} }
  }
  const defineTool = await loadDefineTool()
  const disposers = []

  const register = (definition) => {
    try {
      disposers.push(ctx.tools.register(defineTool(definition)))
    } catch (err) {
      console.warn('[dsh-svn] 注册工具失败 ' + definition.name + '：' + String((err && err.message) || err))
    }
  }

  register({
    name: 'svn_info',
    description: '查看 SVN 工作副本的仓库信息：URL、仓库根、当前版本、最后一次提交。用户问「这个项目在哪个 SVN 仓库」「现在是什么版本」时使用。',
    parameters: {
      workingCopy: { type: 'string', description: '工作副本路径；只有一个工作副本或当前目录在其中时可以省略' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string', required: true, description: '仓库信息摘要' } },
      },
      render: textRender((value) => value.summary),
    },
    execute: async (args, exec) => {
      if (exec && exec.signal) exec.signal.throwIfAborted()
      const core = getCore()
      const info = await core.getInfo(pickWorkingCopy(core, args))
      return {
        summary: [
          `路径：${info.path}`,
          `URL：${info.url}`,
          `仓库根：${info.root}`,
          `当前版本：r${info.revision}`,
          `最后修改：r${info.lastChangedRev} ${info.lastChangedAuthor || '(无作者)'} ${fmtDate(info.lastChangedDate)}`,
        ].join('\n'),
      }
    },
  })

  register({
    name: 'svn_status',
    description: [
      '查看 SVN 工作副本有哪些本地更改：修改 / 新增 / 删除 / 冲突 / 未纳入版本控制。',
      '用户问「改了什么」「有没有冲突」「哪些文件没提交」时使用。默认只读本地状态，remote=true 时额外对比服务器（较慢）。',
    ].join(''),
    parameters: {
      workingCopy: { type: 'string', description: '工作副本路径；只有一个工作副本或当前目录在其中时可以省略' },
      remote: { type: 'boolean', description: '是否同时检查服务器上的新版本（svn status -u），默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '状态摘要，每个文件一行' },
          count: { type: 'number', required: true, description: '更改项数量' },
        },
      },
      render: textRender((value) => value.summary),
    },
    execute: async (args, exec) => {
      if (exec && exec.signal) exec.signal.throwIfAborted()
      const core = getCore()
      const result = await core.getStatus(pickWorkingCopy(core, args), { remote: !!args.remote })
      return { summary: statusSummary(result), count: result.summary.total }
    },
  })

  register({
    name: 'svn_log',
    description: [
      '查看 SVN 提交历史（含作者、时间、提交信息、改动文件数）。',
      '用户问「最近谁提交了什么」「这个文件的修改历史」「查一下 xxx 相关的提交」时使用。',
      '可以用 path 限定文件/目录，用 author / keyword / from / to 过滤。',
    ].join(''),
    parameters: {
      workingCopy: { type: 'string', description: '工作副本路径；只有一个工作副本或当前目录在其中时可以省略' },
      limit: { type: 'number', description: '最多返回多少条，默认 50，上限 200' },
      path: { type: 'string', description: '只看某个文件或目录的历史（工作副本内相对路径）' },
      author: { type: 'string', description: '按作者过滤（包含匹配）' },
      keyword: { type: 'string', description: '在提交信息 / 作者 / 改动路径里搜索关键词' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
      beforeRev: { type: 'number', description: '从某个版本之前继续翻页（用上一次结果里的 nextBefore）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '提交记录，每条一行' },
          count: { type: 'number', required: true, description: '返回条数' },
        },
      },
      render: textRender((value) => value.summary),
    },
    execute: async (args, exec) => {
      if (exec && exec.signal) exec.signal.throwIfAborted()
      const core = getCore()
      const result = await core.getLog(pickWorkingCopy(core, args), {
        limit: args.limit === undefined ? 50 : Math.min(Math.max(Number(args.limit) || 50, 1), 200),
        path: args.path,
        author: args.author,
        keyword: args.keyword,
        from: args.from,
        to: args.to,
        beforeRev: args.beforeRev,
      })
      return { summary: logSummary(result), count: result.entries.length }
    },
  })

  register({
    name: 'svn_diff',
    description: [
      '查看 SVN 差异：默认看工作副本里未提交的本地改动；给 revision 看某个版本改了什么；给 fromRev/toRev 看版本区间。',
      '用户问「这次提交改了什么」「把 diff 给我看看」「这个文件哪里改了」时使用。',
      '结果过大会截断，可用 path 缩小范围。',
    ].join(''),
    parameters: {
      workingCopy: { type: 'string', description: '工作副本路径；只有一个工作副本或当前目录在其中时可以省略' },
      revision: { type: 'number', description: '只看某个版本（svn diff -c N）' },
      fromRev: { type: 'number', description: '版本区间起点（与 toRev 搭配）' },
      toRev: { type: 'number', description: '版本区间终点' },
      path: { type: 'string', description: '限定文件或目录（工作副本内相对路径；也接受 /trunk/... 形式的仓库路径）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '差异概况（文件数、增删行数）' },
          diff: { type: 'string', required: true, description: 'unified diff 文本，可能被截断' },
        },
      },
      render: textRender((value) => value.summary + (value.diff ? '\n\n' + value.diff : '')),
    },
    execute: async (args, exec) => {
      if (exec && exec.signal) exec.signal.throwIfAborted()
      const core = getCore()
      const result = await core.getDiff(pickWorkingCopy(core, args), {
        revision: args.revision,
        fromRev: args.fromRev,
        toRev: args.toRev,
        path: args.path,
      })
      const limit = 60000
      const diff = result.diff.length > limit
        ? result.diff.slice(0, limit) + '\n… diff 过长，已截断；可用 path 缩小范围 …'
        : result.diff
      return { summary: diffSummary(result), diff }
    },
  })

  register({
    name: 'svn_blame',
    description: '逐行查看文件是谁、在哪个版本改的（svn blame）。用户问「这行代码是谁写的」「这行最后一次改动」时使用。',
    parameters: {
      workingCopy: { type: 'string', description: '工作副本路径；只有一个工作副本或当前目录在其中时可以省略' },
      path: { type: 'string', required: true, description: '要溯源的文件（工作副本内相对路径）' },
      limit: { type: 'number', description: '最多返回多少行，默认 120，上限 2000' },
      startLine: { type: 'number', description: '从第几行开始，默认 1' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '每行格式：行号 | r版本 | 作者 | 内容' },
          lines: { type: 'number', required: true, description: '返回的行数' },
        },
      },
      render: textRender((value) => value.summary),
    },
    execute: async (args, exec) => {
      if (exec && exec.signal) exec.signal.throwIfAborted()
      const core = getCore()
      const result = await core.getBlame(pickWorkingCopy(core, args), args.path)
      const limit = Math.min(Math.max(Number(args.limit) || 120, 1), 2000)
      const start = Math.min(Math.max(Number(args.startLine) || 1, 1), Math.max(result.lines.length, 1))
      const slice = result.lines.slice(start - 1, start - 1 + limit)
      const rows = slice.map((line) => `${line.line} | ${line.revision ? 'r' + line.revision : '本地'} | ${line.author || '-'} | ${line.text}`)
      const header = `${result.relPath}：共 ${result.total} 行，显示第 ${start}-${start + slice.length - 1} 行`
      return { summary: rows.length ? header + '\n' + rows.join('\n') : header + '（没有内容）', lines: rows.length }
    },
  })

  return {
    count: disposers.length,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch (err) {}
      }
    },
  }
}
