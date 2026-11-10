/**
 * dsh-svn —— 服务端业务逻辑。
 *
 * 职责：
 *   · 工作副本登记 / 自动发现（配置落在 $DSH_HOME/dsh-svn/config.json）
 *   · 只读查询：info / status / log / diff / blame / cat
 *   · 写操作：update / commit / revert / add / delete / resolve / cleanup
 *
 * 安全边界：所有路径都先折算成「登记过的工作副本内的相对路径」，
 * 命令以工作副本为 cwd 执行，绝不把客户端传来的绝对路径直接拼进命令行。
 * 写操作按工作副本串行化，避免两个请求同时改同一个 WC。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSvn, findSvnExe, resetSvnExeCache } from './svn.js'
import { parseXml, child, children, attr, text, docRoot } from './xml.js'

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const DATA_DIR = path.join(DSH_HOME, 'dsh-svn')
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

const MAX_BODY = 2 * 1024 * 1024
const MAX_DIFF = 1800 * 1024
const MAX_TEXT = 512 * 1024
const MAX_BLAME_LINES = 5000
const MAX_PATHS = 1000

const STATUS_RANK = {
  conflicted: 0,
  incomplete: 1,
  obstructed: 2,
  missing: 3,
  modified: 4,
  replaced: 5,
  added: 6,
  deleted: 7,
  unversioned: 8,
  external: 9,
  ignored: 10,
  normal: 11,
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.pnpm-store', '.cache', '.venv', 'venv',
  '$recycle.bin', 'system volume information', 'windows', 'program files',
  'program files (x86)', 'programdata', 'appdata', 'recovery', 'msocache',
  'perflogs', 'config.msi', '$windows.~bt', '$windows.~ws', 'windows.old',
])

//#region 基础工具

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

function pathKey(p) {
  const s = String(p)
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function stripTrailing(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  return /^[A-Za-z]:$/.test(s) ? s + path.sep : s
}

/** 绝对化 + 尽量解析真实路径（存在时），去掉末尾分隔符。 */
export function normalizePath(input) {
  const raw = String(input == null ? '' : input).trim().replace(/^"(.*)"$/, '$1')
  if (!raw) throw new Error('缺少路径')
  let abs = path.resolve(raw)
  try {
    abs = fs.realpathSync.native(abs)
  } catch (err) {
    // 路径不存在时保留绝对形式即可，后续命令会给出更准确的错误
  }
  return stripTrailing(abs)
}

function samePath(a, b) {
  return pathKey(stripTrailing(normalizePath(a))) === pathKey(stripTrailing(normalizePath(b)))
}

function isInside(childPath, parentPath) {
  const rel = path.relative(pathKey(stripTrailing(parentPath)), pathKey(stripTrailing(childPath)))
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function normalizeRel(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function relFrom(root, target) {
  return normalizeRel(path.relative(root, target))
}

/** 把客户端路径折算为工作副本内相对路径；拒绝 ..、越界与绝对路径。 */
function toRel(wcRoot, input) {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) return ''
  if (path.isAbsolute(raw)) {
    if (!isInside(raw, wcRoot)) throw new Error('路径不在工作副本内：' + raw)
    return relFrom(wcRoot, normalizePath(raw))
  }
  const rel = normalizeRel(raw)
  if (rel.split('/').some((seg) => seg === '..')) throw new Error('路径不能包含 ..')
  return rel
}

function normalizePathList(wcRoot, list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const rel = toRel(wcRoot, item)
    if (rel) out.push(rel)
  }
  return Array.from(new Set(out)).slice(0, MAX_PATHS)
}

function svnTarget(rel) {
  return rel || '.'
}

function messageOf(error) {
  return String((error && error.message) || error || '未知错误')
}

function formatDate(value) {
  return String(value || '')
}

//#endregion

//#region 配置

function emptyConfig() {
  return { version: 1, workingCopies: [], svnPath: null, autoDiscover: true, seeded: false }
}

export function readConfig() {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[dsh-svn] 读取配置失败，按空配置处理：' + messageOf(err))
    }
  }
  const config = emptyConfig()
  if (!parsed || typeof parsed !== 'object') return config

  config.svnPath = typeof parsed.svnPath === 'string' && parsed.svnPath.trim() ? parsed.svnPath.trim() : null
  config.autoDiscover = parsed.autoDiscover !== false
  config.seeded = parsed.seeded === true

  const seen = new Set()
  for (const item of Array.isArray(parsed.workingCopies) ? parsed.workingCopies : []) {
    try {
      const rawPath = typeof item === 'string' ? item : item && item.path
      if (!rawPath) continue
      const abs = normalizePath(rawPath)
      const key = pathKey(abs)
      if (seen.has(key)) continue
      seen.add(key)
      config.workingCopies.push({
        path: abs,
        name: (item && typeof item.name === 'string' && item.name.trim()) || path.basename(abs) || abs,
        addedAt: (item && item.addedAt) || null,
        auto: !!(item && item.auto),
      })
    } catch (err) {
      // 单条脏数据不影响其余条目
    }
  }
  return config
}

export function writeConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  fs.renameSync(tmp, CONFIG_FILE)
}

function getRegisteredWc(key) {
  const target = normalizePath(key)
  const config = readConfig()
  const found = config.workingCopies.find((item) => samePath(item.path, target))
  if (!found) throw new Error('未登记的工作副本：' + target)
  return found
}

/** 允许传工作副本内的任意路径，向上归到最近登记的工作副本。 */
export function resolveWorkingCopy(key) {
  const target = normalizePath(key || process.cwd())
  const config = readConfig()
  const matches = config.workingCopies.filter((item) => isInside(target, item.path))
  if (!matches.length) {
    throw new Error('这个路径不在任何已登记的工作副本内：' + target + '（请先在面板里添加工作副本）')
  }
  matches.sort((a, b) => b.path.length - a.path.length)
  return { wc: matches[0], rel: relFrom(matches[0].path, target) }
}

//#endregion

//#region 信息读取

function mapInfo(wc, xml) {
  const entry = child(docRoot(xml), 'entry')
  if (!entry) throw new Error('svn info 没有返回条目：' + wc.path)
  const repo = child(entry, 'repository')
  const wcInfo = child(entry, 'wc-info')
  const commit = child(entry, 'commit')
  return {
    path: wc.path,
    name: wc.name || path.basename(wc.path),
    url: text(child(entry, 'url')),
    relativeUrl: text(child(entry, 'relative-url')),
    root: text(child(repo, 'root')),
    uuid: text(child(repo, 'uuid')),
    revision: Number(attr(entry, 'revision')) || 0,
    kind: attr(entry, 'kind', 'dir'),
    wcRoot: text(child(wcInfo, 'wcroot-abspath')) || wc.path,
    schedule: text(child(wcInfo, 'schedule')) || 'normal',
    lastChangedRev: Number(attr(commit, 'revision')) || 0,
    lastChangedAuthor: text(child(commit, 'author')),
    lastChangedDate: formatDate(text(child(commit, 'date'))),
  }
}

async function infoAt(absPath, timeout = 20000) {
  const { stdout } = await runSvn(['info', '--non-interactive', '--xml', '--', '.'], {
    cwd: absPath,
    timeout,
  })
  return mapInfo({ path: absPath, name: path.basename(absPath) }, parseXml(stdout))
}

export async function getInfo(key) {
  const wc = getRegisteredWc(key)
  if (!fs.existsSync(path.join(wc.path, '.svn'))) {
    throw new Error('这已经不是 SVN 工作副本（缺少 .svn）：' + wc.path)
  }
  const info = await infoAt(wc.path)
  info.name = wc.name
  return info
}

//#endregion

//#region 自动发现

async function readDirs(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return []
  }
}

async function discoverPaths(roots, options) {
  const started = Date.now()
  const depth = clampInt(options.depth, 3, 1, 6)
  const budgetMs = clampInt(options.budgetMs, 4000, 500, 30000)
  const limit = clampInt(options.limit, 20, 1, 100)
  const queue = []
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    try {
      queue.push({ dir: normalizePath(root), depth: 0 })
    } catch (err) {
      // 跳过不存在的根目录
    }
  }
  const seen = new Set()
  const found = []

  while (queue.length && found.length < limit && Date.now() - started < budgetMs) {
    const item = queue.shift()
    const key = pathKey(item.dir)
    if (seen.has(key)) continue
    seen.add(key)

    const entries = await readDirs(item.dir)
    if (!entries.length) continue

    if (entries.some((entry) => entry.isDirectory() && entry.name === '.svn')) {
      found.push(item.dir)
      continue
    }
    if (item.depth >= depth) continue

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (SKIP_DIRS.has(name) || entry.name.startsWith('$') || entry.name.startsWith('.')) continue
      queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 })
    }
  }
  return found
}

/**
 * 扫描目录找 SVN 工作副本（以 .svn 目录为标志），并补全仓库信息。
 * @param {string|string[]} roots
 * @param {{depth?:number, budgetMs?:number, limit?:number, includeRegistered?:boolean}} options
 */
export async function discover(roots, options = {}) {
  const candidates = await discoverPaths(roots, options)
  const config = options.includeRegistered ? emptyConfig() : readConfig()
  const known = new Set(config.workingCopies.map((item) => pathKey(item.path)))
  const results = []
  for (const dir of candidates) {
    if (known.has(pathKey(dir))) continue
    try {
      const info = await infoAt(dir, 12000)
      results.push({
        path: dir,
        name: path.basename(dir),
        url: info.url,
        revision: info.revision,
        lastChangedAuthor: info.lastChangedAuthor,
        lastChangedDate: info.lastChangedDate,
      })
    } catch (err) {
      // .svn 存在但 info 失败（损坏 / 权限），不作为候选
    }
  }
  return results
}

async function autoSeed() {
  const roots = []
  try {
    roots.push(process.cwd())
  } catch (err) {
    // ignore
  }
  roots.push(os.homedir())

  let found = []
  try {
    found = await discoverPaths(roots, { depth: 3, budgetMs: 2500, limit: 8 })
  } catch (err) {
    // ignore
  }
  if (found.length < 8) {
    const drives = []
    try {
      const cwdDrive = path.parse(process.cwd()).root
      if (cwdDrive) drives.push(cwdDrive)
    } catch (err) {}
    // Windows 上常见把项目放在 D:/E:，逐个盘符补扫；每轮限时，避免卡住
    for (const letter of 'DEFGHIJ') {
      const drive = letter + ':\\'
      if (!drives.some((item) => item.toLowerCase() === drive.toLowerCase()) && fs.existsSync(drive)) {
        drives.push(drive)
      }
    }
    for (const drive of drives) {
      if (found.length >= 8) break
      let more = []
      try {
        more = await discoverPaths([drive], { depth: 3, budgetMs: 4000, limit: 8 - found.length })
      } catch (err) {
        more = []
      }
      for (const dir of more) {
        if (!found.some((item) => pathKey(item) === pathKey(dir))) found.push(dir)
      }
    }
  }

  const config = readConfig()
  const known = new Set(config.workingCopies.map((item) => pathKey(item.path)))
  let added = 0
  for (const dir of found) {
    if (known.has(pathKey(dir))) continue
    try {
      await infoAt(dir, 12000)
    } catch (err) {
      continue
    }
    config.workingCopies.push({
      path: dir,
      name: path.basename(dir) || dir,
      addedAt: new Date().toISOString(),
      auto: true,
    })
    known.add(pathKey(dir))
    added += 1
  }
  config.seeded = true
  writeConfig(config)
  return added
}

//#endregion

//#region 只读查询

export async function getState() {
  let config = readConfig()
  let autoDiscovered = 0
  if (!config.workingCopies.length && config.autoDiscover && !config.seeded) {
    try {
      autoDiscovered = await autoSeed()
      config = readConfig()
    } catch (err) {
      console.warn('[dsh-svn] 自动发现工作副本失败：' + messageOf(err))
    }
  }

  const workingCopies = await Promise.all(
    config.workingCopies.map(async (wc) => {
      const base = { path: wc.path, name: wc.name, auto: wc.auto }
      try {
        const info = await infoAt(wc.path, 15000)
        return Object.assign(base, info, { name: wc.name, ok: true })
      } catch (err) {
        return Object.assign(base, { ok: false, error: messageOf(err) })
      }
    }),
  )

  return {
    workingCopies,
    svnPath: findSvnExe(config.svnPath),
    configFile: CONFIG_FILE,
    autoDiscovered,
    autoDiscover: config.autoDiscover,
  }
}

export async function addWorkingCopy(input, options = {}) {
  const abs = normalizePath(input)
  let stat
  try {
    stat = fs.statSync(abs)
  } catch (err) {
    throw new Error('目录不存在：' + abs)
  }
  if (!stat.isDirectory()) throw new Error('请选择一个目录：' + abs)
  if (!fs.existsSync(path.join(abs, '.svn'))) {
    throw new Error('这个目录不是 SVN 工作副本（没有 .svn 子目录）：' + abs)
  }
  const info = await infoAt(abs, 20000)

  const config = readConfig()
  const key = pathKey(abs)
  if (config.workingCopies.some((item) => pathKey(item.path) === key)) {
    throw new Error('这个工作副本已经添加过了：' + abs)
  }
  config.workingCopies.push({
    path: abs,
    name: String(options.name || path.basename(abs) || abs).trim(),
    addedAt: new Date().toISOString(),
    auto: !!options.auto,
  })
  config.seeded = true
  writeConfig(config)
  return Object.assign({ path: abs, name: path.basename(abs) }, info)
}

export async function removeWorkingCopy(input) {
  const target = normalizePath(input)
  const config = readConfig()
  const before = config.workingCopies.length
  config.workingCopies = config.workingCopies.filter((item) => !samePath(item.path, target))
  if (config.workingCopies.length === before) throw new Error('要移除的工作副本不在列表里：' + target)
  writeConfig(config)
  return { removed: target }
}

export async function updateSettings(patch) {
  const config = readConfig()
  if (patch && patch.svnPath !== undefined) {
    const value = String(patch.svnPath || '').trim()
    if (!value) {
      config.svnPath = null
    } else {
      if (!fs.existsSync(value)) throw new Error('svn 可执行文件不存在：' + value)
      config.svnPath = value
      resetSvnExeCache()
    }
  }
  if (patch && patch.autoDiscover !== undefined) config.autoDiscover = !!patch.autoDiscover
  writeConfig(config)
  return { svnPath: findSvnExe(config.svnPath), autoDiscover: config.autoDiscover }
}

function mapStatusEntry(entryNode, wcRoot) {
  const rawPath = attr(entryNode, 'path')
  const rel = path.isAbsolute(rawPath) ? relFrom(wcRoot, rawPath) : normalizeRel(rawPath)
  if (!rel) return null
  const wcStatus = child(entryNode, 'wc-status')
  const commit = wcStatus ? child(wcStatus, 'commit') : null
  const repos = child(entryNode, 'repos-status')
  return {
    path: rel,
    kind: attr(entryNode, 'kind', ''),
    item: attr(wcStatus, 'item', 'normal'),
    props: attr(wcStatus, 'props', 'none'),
    revision: Number(attr(wcStatus, 'revision')) || -1,
    copied: attr(wcStatus, 'copied', 'false') === 'true',
    treeConflicted: attr(wcStatus, 'tree-conflicted', 'false') === 'true',
    changelist: attr(wcStatus, 'changelist', ''),
    commit: commit
      ? {
          revision: Number(attr(commit, 'revision')) || 0,
          author: text(child(commit, 'author')),
          date: text(child(commit, 'date')),
        }
      : null,
    reposStatus: repos
      ? {
          item: attr(repos, 'item', 'none'),
          props: attr(repos, 'props', 'none'),
        }
      : null,
  }
}

function summarizeStatus(entries) {
  const counts = {}
  for (const name of Object.keys(STATUS_RANK)) counts[name] = 0
  let propCount = 0
  for (const entry of entries) {
    if (counts[entry.item] === undefined) counts[entry.item] = 0
    counts[entry.item] += 1
    if (entry.props === 'modified' && ['normal', 'none', 'modified'].includes(entry.item)) propCount += 1
  }
  const changed = entries.filter((entry) => !['normal', 'ignored'].includes(entry.item))
  return {
    total: changed.length,
    conflicted: counts.conflicted,
    modified: counts.modified,
    added: counts.added,
    deleted: counts.deleted,
    missing: counts.missing,
    unversioned: counts.unversioned,
    replaced: counts.replaced,
    obstructed: counts.obstructed,
    ignored: counts.ignored,
    props: propCount,
  }
}

export async function getStatus(key, options = {}) {
  const wc = getRegisteredWc(key)
  const args = ['status', '--non-interactive']
  if (options.remote) args.push('-u')
  if (options.ignored) args.push('--no-ignore')
  const rel = options.path ? toRel(wc.path, options.path) : ''
  const scoped = !!rel && isAscii(rel)
  args.push('--xml', '--', scoped ? rel : '.')

  const { stdout } = await runSvn(args, {
    cwd: wc.path,
    timeout: options.remote ? 90000 : 30000,
    exe: options.svnPath,
  })
  const xml = parseXml(stdout)
  let entries = []
  for (const targetNode of children(docRoot(xml), 'target')) {
    for (const entryNode of children(targetNode, 'entry')) {
      const entry = mapStatusEntry(entryNode, wc.path)
      if (entry) entries.push(entry)
    }
  }
  if (rel && !scoped) {
    const target = rel.toLowerCase()
    entries = entries.filter((entry) => {
      const value = entry.path.toLowerCase()
      return value === target || value.startsWith(target + '/')
    })
  }
  entries.sort((a, b) => {
    const rank = (STATUS_RANK[a.item] === undefined ? 99 : STATUS_RANK[a.item]) - (STATUS_RANK[b.item] === undefined ? 99 : STATUS_RANK[b.item])
    if (rank !== 0) return rank
    return a.path.localeCompare(b.path)
  })
  return {
    path: wc.path,
    name: wc.name,
    remote: !!options.remote,
    entries,
    summary: summarizeStatus(entries),
  }
}

function mapLogEntry(node) {
  const pathsNode = child(node, 'paths')
  return {
    revision: Number(attr(node, 'revision')) || 0,
    author: text(child(node, 'author')),
    date: text(child(node, 'date')),
    message: text(child(node, 'msg')).replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    paths: pathsNode
      ? children(pathsNode, 'path').map((item) => ({
          action: attr(item, 'action', 'M'),
          kind: attr(item, 'kind', ''),
          path: text(item),
          copyFrom: attr(item, 'copyfrom-path', ''),
          copyFromRev: Number(attr(item, 'copyfrom-rev')) || 0,
        }))
      : [],
  }
}

export async function getLog(key, options = {}) {
  const wc = getRegisteredWc(key)
  const limit = clampInt(options.limit, 100, 1, 500)
  const args = ['log', '-v', '-l', String(limit), '--non-interactive']
  const before = Number(options.beforeRev)
  if (Number.isFinite(before) && before > 1) {
    args.push('-r', `${Math.trunc(before)}:1`)
  } else {
    args.push('-r', 'HEAD:1')
  }
  let rel = ''
  if (options.path) {
    if (String(options.path).startsWith('/')) {
      const info = await getInfo(key)
      const mapped = repoPathToRel(info, options.path)
      rel = mapped === null ? '' : mapped
    } else {
      rel = toRel(wc.path, options.path)
    }
  }
  if (rel && !isAscii(rel)) {
    const info = await getInfo(key)
    args.push('--xml', fileUrlFor(info, rel))
  } else {
    args.push('--xml', '--', svnTarget(rel))
  }

  let stdout = ''
  try {
    stdout = (await runSvn(args, { cwd: wc.path, timeout: 45000, exe: options.svnPath })).stdout
  } catch (err) {
    // 用 URL 查一个还没提交的文件时，HEAD 上找不到是正常的：返回空历史
    const uncommitted = !!rel && !isAscii(rel) && /E160013|E195012|not found/i.test(messageOf(err))
    if (!uncommitted) throw err
    return {
      path: wc.path,
      entries: [],
      limit,
      hasMore: false,
      nextBefore: 0,
      filters: {
        path: rel,
        author: options.author || '',
        keyword: options.keyword || '',
        from: String(options.from || '').slice(0, 10),
        to: String(options.to || '').slice(0, 10),
      },
      note: '该路径还没有提交记录',
    }
  }
  const xml = parseXml(stdout)
  const rawEntries = children(docRoot(xml), 'logentry').map(mapLogEntry)
  let entries = rawEntries.slice()

  const author = String(options.author || '').trim().toLowerCase()
  const keyword = String(options.keyword || '').trim().toLowerCase()
  const from = String(options.from || '').slice(0, 10)
  const to = String(options.to || '').slice(0, 10)

  if (author) entries = entries.filter((entry) => String(entry.author || '').toLowerCase().includes(author))
  if (from) entries = entries.filter((entry) => String(entry.date).slice(0, 10) >= from)
  if (to) entries = entries.filter((entry) => String(entry.date).slice(0, 10) <= to)
  if (keyword) {
    entries = entries.filter((entry) => {
      if (String(entry.message || '').toLowerCase().includes(keyword)) return true
      if (String(entry.author || '').toLowerCase().includes(keyword)) return true
      return entry.paths.some((item) => String(item.path || '').toLowerCase().includes(keyword))
    })
  }

  const rawCount = rawEntries.length
  const rawRevisions = rawEntries.map((entry) => entry.revision)
  const oldest = rawRevisions.length ? Math.min.apply(null, rawRevisions) : 0
  return {
    path: wc.path,
    entries,
    limit,
    hasMore: rawCount >= limit && oldest > 1,
    nextBefore: oldest,
    filters: { path: rel || '', author: author ? options.author : '', keyword: keyword ? options.keyword : '', from, to },
  }
}

/** 把仓库绝对路径（如 /trunk/src.txt）折算成工作副本内相对路径。 */
function repoPathToRel(info, repoPath) {
  const raw = String(repoPath || '')
  if (!raw) return ''
  try {
    const urlPath = decodeURIComponent(new URL(info.url).pathname)
    const rootPath = decodeURIComponent(new URL(info.root).pathname)
    let wcRepoPath = urlPath.slice(rootPath.length)
    if (wcRepoPath.endsWith('/')) wcRepoPath = wcRepoPath.slice(0, -1)
    const target = decodeURIComponent(raw)
    if (wcRepoPath && target !== wcRepoPath && !target.startsWith(wcRepoPath + '/')) return null
    return normalizeRel(target.slice(wcRepoPath.length))
  } catch (err) {
    return null
  }
}

function isAscii(value) {
  return !/[^\x00-\x7F]/.test(String(value == null ? '' : value))
}

function hasNonAscii(list) {
  return (Array.isArray(list) ? list : []).some((item) => !isAscii(item))
}

const NON_ASCII_HINT = 'Windows 版 svn.exe 不支持在命令行传递中文等非 ASCII 路径，直接执行会改错文件。'
  + '请改用 TortoiseSVN 处理该文件，或只提交「全部更改」。'

const COMMITABLE_ITEMS = new Set(['modified', 'added', 'deleted', 'replaced'])

function coversAllPaths(selected, all) {
  if (!all.length) return false
  const set = new Set((selected || []).map((item) => item.toLowerCase()))
  return all.every((item) => set.has(item.toLowerCase()))
}

/** 工作副本内的文件 → 仓库 URL（每段百分号编码，命令行只出现 ASCII）。 */
function fileUrlFor(info, rel) {
  const url = new URL(info.url)
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = basePath + '/' + String(rel).split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return url.toString()
}

/** 读整个工作副本的 status（不带路径参数，中文路径也能安全拿到）。 */
async function readStatusEntries(wcRoot, timeout = 30000) {
  const { stdout } = await runSvn(['status', '--xml', '--no-ignore', '--non-interactive', '--', '.'], {
    cwd: wcRoot,
    timeout,
  })
  const xml = parseXml(stdout)
  const entries = []
  for (const targetNode of children(docRoot(xml), 'target')) {
    for (const entryNode of children(targetNode, 'entry')) {
      const mapped = mapStatusEntry(entryNode, wcRoot)
      if (mapped) entries.push(mapped)
    }
  }
  return entries
}

/** 从全量 diff 中截出某个路径的小节（按 Index: 头匹配）。 */
function filterDiffSections(diff, rel) {
  const target = normalizeRel(rel).toLowerCase()
  if (!target) return diff
  const sections = []
  let current = null
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('Index: ')) {
      if (current) sections.push(current)
      current = { path: normalizeRel(line.slice(7).trim()).toLowerCase(), lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(current)
  if (!sections.length) return ''
  return sections
    .filter((section) => section.path === target || section.path.endsWith('/' + target))
    .map((section) => section.lines.join('\n'))
    .join('\n')
}

/** 按行拆分（统一 LF，丢弃末尾空行带来的伪行）。 */
function splitTextLines(value) {
  const text = String(value == null ? '' : value).replace(/\r\n/g, '\n')
  if (!text) return []
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 行级 LCS → equal / delete / insert 操作序列（带公共前后缀裁剪）。 */
function buildLineOps(a, b) {
  const n = a.length
  const m = b.length
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start += 1
  let endA = n - 1
  let endB = m - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }

  const ops = []
  for (let i = 0; i < start; i += 1) ops.push({ type: 'equal', text: a[i] })

  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)
  if (midA.length * midB.length > 4000000) {
    // 超大文件不做 LCS，退化成整段替换，至少保证差异完整可读
    for (const line of midA) ops.push({ type: 'delete', text: line })
    for (const line of midB) ops.push({ type: 'insert', text: line })
  } else {
    const dp = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1))
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'equal', text: midA[i] })
        i += 1
        j += 1
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: 'delete', text: midA[i] })
        i += 1
      } else {
        ops.push({ type: 'insert', text: midB[j] })
        j += 1
      }
    }
    while (i < midA.length) {
      ops.push({ type: 'delete', text: midA[i] })
      i += 1
    }
    while (j < midB.length) {
      ops.push({ type: 'insert', text: midB[j] })
      j += 1
    }
  }

  for (let i = endA + 1; i < n; i += 1) ops.push({ type: 'equal', text: a[i] })
  return ops
}

/** 生成标准 unified diff 文本。 */
function unifiedDiffText(baseText, nextText, rel, baseRev, nextLabel) {
  const a = splitTextLines(baseText)
  const b = splitTextLines(nextText)
  const ops = buildLineOps(a, b)
  const changed = []
  ops.forEach((op, index) => { if (op.type !== 'equal') changed.push(index) })
  if (!changed.length) return ''

  const context = 3
  const ranges = []
  let start = Math.max(0, changed[0] - context)
  let end = Math.min(ops.length - 1, changed[0] + context)
  for (let k = 1; k < changed.length; k += 1) {
    const index = changed[k]
    if (index - context <= end + 1) {
      end = Math.min(ops.length - 1, index + context)
    } else {
      ranges.push([start, end])
      start = Math.max(0, index - context)
      end = Math.min(ops.length - 1, index + context)
    }
  }
  ranges.push([start, end])

  let oldNo = 1
  let newNo = 1
  const numbers = ops.map((op) => {
    const current = { oldNo, newNo }
    if (op.type !== 'insert') oldNo += 1
    if (op.type !== 'delete') newNo += 1
    return current
  })

  const out = [
    `Index: ${rel}`,
    '='.repeat(67),
    `--- ${rel}\t${baseRev ? '(revision ' + baseRev + ')' : '(nonexistent)'}`,
    `+++ ${rel}\t${nextLabel || '(working copy)'}`,
  ]
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to + 1)
    const oldCount = slice.filter((op) => op.type !== 'insert').length
    const newCount = slice.filter((op) => op.type !== 'delete').length
    const oldStart = oldCount ? numbers[from].oldNo : Math.max(0, numbers[from].oldNo - 1)
    const newStart = newCount ? numbers[from].newNo : Math.max(0, numbers[from].newNo - 1)
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of slice) out.push((op.type === 'delete' ? '-' : op.type === 'insert' ? '+' : ' ') + op.text)
  }
  return out.join('\n') + '\n'
}

/**
 * 非 ASCII 路径的「工作副本差异」：svn diff 的 Index 头会被 ACP 破坏，
 * 因此自己取 BASE（svn cat URL）与磁盘内容，在 JS 里算 unified diff。
 */
async function buildUnicodeWorkingDiff(wc, info, rel, timeout) {
  const entries = await readStatusEntries(wc.path)
  const entry = entries.find((item) => item.path.toLowerCase() === rel.toLowerCase())
  const abs = path.join(wc.path, rel)
  const exists = fs.existsSync(abs)
  const item = entry ? entry.item : ''

  if (!entry || item === 'unversioned' || item === 'ignored' || item === 'added') {
    if (!exists) return { diff: '', files: 0, synthesized: true }
    const fake = await synthesizeUnversioned(wc.path, rel)
    return fake
      ? { diff: fake.diff, files: fake.files, synthesized: true }
      : { diff: '', files: 0, synthesized: true }
  }

  const baseRev = entry.revision > 0 ? entry.revision : null
  let baseText = ''
  try {
    const args = ['cat', '--non-interactive']
    if (baseRev) args.push('-r', String(baseRev))
    args.push(fileUrlFor(info, rel))
    baseText = (await runSvn(args, { cwd: wc.path, timeout: timeout || 60000 })).stdout
  } catch (err) {
    baseText = ''
  }
  if (!baseText && (item === 'deleted' || item === 'missing')) {
    try {
      baseText = (await runSvn(['cat', '--non-interactive', fileUrlFor(info, rel)], {
        cwd: wc.path,
        timeout: timeout || 60000,
      })).stdout
    } catch (err) {
      baseText = ''
    }
  }

  const nextText = exists ? fs.readFileSync(abs, 'utf8') : ''
  if (baseText.includes('\u0000') || nextText.includes('\u0000')) {
    return {
      diff: `Index: ${rel}\n${'='.repeat(67)}\n二进制文件，无法显示文本差异。\n`,
      files: 1,
      binary: true,
    }
  }
  return { diff: unifiedDiffText(baseText, nextText, rel, baseRev), files: 1, binary: false }
}

async function synthesizeUnversioned(wcRoot, rel) {
  const abs = path.join(wcRoot, rel)
  const stat = await fsp.stat(abs).catch(() => null)
  if (!stat) return null
  const files = []
  if (stat.isDirectory()) {
    const walk = async (dir, prefix, depth) => {
      if (depth <= 0 || files.length >= 40) return
      const entries = await readDirs(dir)
      for (const entry of entries) {
        if (files.length >= 40) return
        if (entry.name === '.svn') continue
        const childRel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel, depth - 1)
        else files.push(childRel)
      }
    }
    await walk(abs, rel, 3)
  } else {
    files.push(rel)
  }

  const chunks = []
  let skipped = 0
  for (const file of files) {
    const fileAbs = path.join(wcRoot, file)
    const buffer = await fsp.readFile(fileAbs).catch(() => null)
    if (!buffer) continue
    if (buffer.includes(0)) {
      chunks.push(`Index: ${file}\n${'='.repeat(67)}\n二进制文件，无法显示文本差异。\n`)
      continue
    }
    if (buffer.length > 256 * 1024) {
      skipped += 1
      chunks.push(`Index: ${file}\n${'='.repeat(67)}\n文件超过 256 KB，已跳过内容。\n`)
      continue
    }
    let body = buffer.toString('utf8').replace(/\r\n/g, '\n')
    if (body.endsWith('\n')) body = body.slice(0, -1)
    const lines = body.split('\n')
    const header = [
      `Index: ${file}`,
      '='.repeat(67),
      `--- ${file}\t(nonexistent)`,
      `+++ ${file}\t(working copy)`,
      `@@ -0,0 +1,${lines.length} @@`,
    ]
    chunks.push(header.concat(lines.map((line) => '+' + line)).join('\n') + '\n')
  }
  return chunks.length ? { diff: chunks.join('\n'), files: files.length, skipped } : null
}

function capDiff(diff) {
  if (diff.length <= MAX_DIFF) return { diff, truncated: false }
  return {
    diff: diff.slice(0, MAX_DIFF) + `\n\n… 差异过大，已截断（完整内容 ${Math.round(diff.length / 1024)} KB）…\n`,
    truncated: true,
  }
}

/**
 * 查看差异。
 * options:
 *   revision   只看某个版本的改动（svn diff -c N）
 *   fromRev/toRev  版本区间
 *   path       限定的工作副本内路径，或以 / 开头的仓库路径
 *   repoPath   path 是否仓库路径
 */
export async function getDiff(key, options = {}) {
  const wc = getRegisteredWc(key)
  const repoInput = String(options.path || '').startsWith('/')
  const info = repoInput || options.repoPath ? await getInfo(key) : null

  let rel = ''
  let outsideWc = false
  if (options.path) {
    if (repoInput) {
      const mapped = info ? repoPathToRel(info, options.path) : null
      if (mapped === null) outsideWc = true
      else rel = mapped
    } else {
      rel = toRel(wc.path, options.path)
    }
  }

  const modeArgs = []
  let mode = 'working'
  if (options.revision !== undefined && options.revision !== null && options.revision !== '') {
    const revision = clampInt(options.revision, 0, 0, 99999999)
    if (revision > 0) {
      modeArgs.push('-c', String(revision))
      mode = 'revision'
    }
  } else if (options.fromRev && options.toRev) {
    modeArgs.push('-r', `${clampInt(options.fromRev, 0, 0, 99999999)}:${clampInt(options.toRev, 0, 0, 99999999)}`)
    mode = 'range'
  }

  const finish = (text, extra) => {
    const opts = extra || {}
    const capped = capDiff(text)
    return {
      path: wc.path,
      relPath: rel,
      mode,
      revision: mode === 'revision' ? Number(options.revision) : null,
      diff: capped.diff,
      truncated: capped.truncated,
      binary: opts.binary !== undefined ? !!opts.binary : /Cannot display: file marked as a binary type/.test(text),
      synthesized: !!opts.synthesized,
      files: opts.files || 0,
      additions: (text.match(/^\+[^+]/gm) || []).length,
      deletions: (text.match(/^-[^-]/gm) || []).length,
      empty: !text.trim(),
      outsideWc,
    }
  }

  // 非 ASCII 的工作副本差异：svn diff 的 Index 头会被 ACP 破坏，改为自己算
  if (mode === 'working' && rel && !isAscii(rel)) {
    const wcInfo = info || await getInfo(key)
    const built = await buildUnicodeWorkingDiff(wc, wcInfo, rel, 90000)
    return finish(built.diff, built)
  }

  // 非 ASCII 的版本差异：取两个版本的 URL 内容自己算 diff（URL 纯 ASCII）
  if (mode !== 'working' && rel && !isAscii(rel)) {
    const wcInfo = info || await getInfo(key)
    const fromRev = mode === 'revision'
      ? Math.max(0, Number(options.revision) - 1)
      : clampInt(options.fromRev, 0, 0, 99999999)
    const toRev = mode === 'revision'
      ? Number(options.revision)
      : clampInt(options.toRev, 0, 0, 99999999)
    const readAt = async (revision) => {
      if (!revision) return ''
      try {
        return (await runSvn(['cat', '-r', String(revision), fileUrlFor(wcInfo, rel)], {
          cwd: wc.path,
          timeout: 60000,
          exe: options.svnPath,
        })).stdout
      } catch (err) {
        return ''
      }
    }
    const baseText = await readAt(fromRev)
    const nextText = await readAt(toRev)
    const text = unifiedDiffText(baseText, nextText, rel, fromRev, '(revision ' + toRev + ')')
    return finish(text, { files: text ? 1 : 0 })
  }

  const args = ['diff', '--non-interactive'].concat(modeArgs)
  const scoped = !!rel && isAscii(rel) && !outsideWc
  args.push('--', scoped ? rel : '.')

  let output = ''
  try {
    output = (await runSvn(args, { cwd: wc.path, timeout: 90000, exe: options.svnPath })).stdout
  } catch (err) {
    // 未纳入版本控制的文件，svn diff 会报 E155010；交给下面的合成逻辑
    const notFound = /E155010|was not found/i.test(messageOf(err))
    if (!(mode === 'working' && scoped && notFound)) throw err
  }

  if (rel && !scoped) output = filterDiffSections(output, rel)

  let synthesized = false
  let files = 0
  if (mode === 'working' && rel && !output.trim()) {
    const found = (await readStatusEntries(wc.path)).find((entry) => entry.path.toLowerCase() === rel.toLowerCase())
    if (found && (found.item === 'unversioned' || found.item === 'ignored')) {
      const fake = await synthesizeUnversioned(wc.path, rel)
      if (fake) {
        output = fake.diff
        synthesized = true
        files = fake.files
      }
    }
  }

  return finish(output, { synthesized, files })
}

export async function getBlame(key, inputPath, options = {}) {
  const wc = getRegisteredWc(key)
  const rawInput = String(inputPath == null ? '' : inputPath)
  let info = null
  let rel
  if (rawInput.startsWith('/')) {
    info = await getInfo(key)
    const mapped = repoPathToRel(info, rawInput)
    if (mapped === null) throw new Error('这个路径不在当前工作副本里：' + rawInput)
    rel = mapped
  } else {
    rel = toRel(wc.path, rawInput)
  }
  if (!rel) throw new Error('请选择要溯源的文件')

  // 中文等非 ASCII 路径不能进 svn.exe 命令行：改用仓库 URL（百分号编码，纯 ASCII）
  const remote = !isAscii(rel)
  let args
  if (remote) {
    info = info || await getInfo(key)
    args = ['blame', '--non-interactive', '--xml', fileUrlFor(info, rel)]
  } else {
    args = ['blame', '--non-interactive', '--xml', '--', rel]
  }

  let stdout = ''
  try {
    stdout = (await runSvn(args, { cwd: wc.path, timeout: 90000, exe: options.svnPath })).stdout
  } catch (err) {
    if (remote && /E160013|E195012|not found/i.test(messageOf(err))) {
      throw new Error('这个文件还没有提交过，暂时无法按仓库版本逐行溯源。')
    }
    throw err
  }
  const xml = parseXml(stdout)
  const target = child(docRoot(xml), 'target')
  const all = children(target, 'entry').map((node) => {
    const commit = child(node, 'commit')
    return {
      line: Number(attr(node, 'line-number')) || 0,
      revision: commit ? Number(attr(commit, 'revision')) || 0 : 0,
      author: commit ? text(child(commit, 'author')) : '',
      date: commit ? text(child(commit, 'date')) : '',
      text: '',
    }
  })

  // svn blame --xml 只有元数据、没有行文本：从磁盘（本地）或 URL（远程）取内容补齐
  let content = ''
  try {
    if (remote) {
      content = (await runSvn(['cat', '--non-interactive', fileUrlFor(info, rel)], {
        cwd: wc.path,
        timeout: 60000,
      })).stdout
    } else {
      content = fs.readFileSync(path.join(wc.path, rel), 'utf8')
    }
  } catch (err) {
    content = ''
  }
  const textLines = splitTextLines(content)
  for (const line of all) {
    const value = textLines[line.line - 1]
    line.text = value === undefined ? '' : value
  }
  if (!all.length) {
    let size = 0
    try {
      size = fs.statSync(path.join(wc.path, rel)).size
    } catch (err) {}
    if (size > 0) {
      throw new Error('无法逐行溯源：该文件可能被标记为二进制（svn:mime-type），或它还没有提交过。')
    }
  }
  return {
    path: wc.path,
    relPath: rel,
    remote,
    lines: all.slice(0, MAX_BLAME_LINES),
    total: all.length,
    truncated: all.length > MAX_BLAME_LINES,
  }
}

export async function getCat(key, inputPath, revision) {
  const wc = getRegisteredWc(key)
  const rawInput = String(inputPath == null ? '' : inputPath)
  let info = null
  let rel
  if (rawInput.startsWith('/')) {
    info = await getInfo(key)
    const mapped = repoPathToRel(info, rawInput)
    if (mapped === null) throw new Error('这个路径不在当前工作副本里：' + rawInput)
    rel = mapped
  } else {
    rel = toRel(wc.path, rawInput)
  }
  if (!rel) throw new Error('请选择文件')

  const remote = !isAscii(rel)
  const args = ['cat', '--non-interactive']
  if (revision) args.push('-r', String(clampInt(revision, 0, 0, 99999999)))
  if (remote) {
    info = info || await getInfo(key)
    args.push(fileUrlFor(info, rel))
  } else {
    args.push('--', rel)
  }

  const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 45000 })
  const binary = stdout.includes('\u0000')
  return {
    path: wc.path,
    relPath: rel,
    remote,
    binary,
    content: binary ? '' : stdout.slice(0, MAX_TEXT),
    truncated: stdout.length > MAX_TEXT,
  }
}

//#endregion

//#region 写操作

const locks = new Map()

function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(key, next.catch(() => {}))
  return next
}

function countConflicts(output) {
  const textValue = String(output || '')
  const match = /Summary of conflicts:[\s\S]*?Text conflicts:\s*(\d+)/i.exec(textValue)
  if (match) return Number(match[1])
  return textValue.split(/\r?\n/).filter((line) => /^\s*C\s{2,}/.test(line)).length
}

export function update(key, options = {}) {
  const wc = getRegisteredWc(key)
  return withLock(wc.path, async () => {
    const args = ['update', '--accept', 'postpone', '--non-interactive']
    const revision = Number(options.revision)
    if (Number.isFinite(revision) && revision > 0) args.push('-r', String(Math.trunc(revision)))
    const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 240000, exe: options.svnPath })
    const match = /(?:Updated to|At) revision (\d+)/i.exec(stdout)
    return {
      output: stdout.trim(),
      revision: match ? Number(match[1]) : null,
      conflicts: countConflicts(stdout),
    }
  })
}

export function commit(key, options = {}) {
  const wc = getRegisteredWc(key)
  const message = String(options.message == null ? '' : options.message).trim()
  if (!message) throw new Error('提交信息不能为空')
  if (message.length > 20000) throw new Error('提交信息过长（上限 20000 字）')
  const paths = normalizePathList(wc.path, options.paths)
  if (!paths.length) throw new Error('请先勾选要提交的文件')

  return withLock(wc.path, async () => {
    let targets = paths
    if (hasNonAscii(paths)) {
      const entries = await readStatusEntries(wc.path)
      const all = entries.filter((entry) => COMMITABLE_ITEMS.has(entry.item)).map((entry) => entry.path)
      if (!coversAllPaths(paths, all)) {
        throw new Error(NON_ASCII_HINT + '（当前只勾选了一部分文件）')
      }
      // 勾选覆盖了全部可提交项时，提交整个工作副本，效果等价且不需要路径参数
      targets = []
    }

    // 提交信息走文件而不是 -m：Windows 下 svn.exe 按 ANSI 解释命令行参数，
    // 直接传中文会存成乱码；-F + --encoding UTF-8 在各平台都稳定。
    const messageFile = path.join(
      os.tmpdir(),
      `dsh-svn-commit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    )
    fs.writeFileSync(messageFile, message.endsWith('\n') ? message : message + '\n', 'utf8')
    try {
      const args = ['commit', '-F', messageFile, '--encoding', 'UTF-8', '--non-interactive']
      if (targets.length) args.push('--', ...targets)
      const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 300000, exe: options.svnPath })
      const match = /Committed revision (\d+)/i.exec(stdout)
      return { output: stdout.trim(), revision: match ? Number(match[1]) : null, paths }
    } finally {
      try { fs.unlinkSync(messageFile) } catch (err) {}
    }
  })
}

export function revert(key, options = {}) {
  const wc = getRegisteredWc(key)
  const paths = normalizePathList(wc.path, options.paths)
  if (!paths.length) throw new Error('请先勾选要还原的文件')
  if (hasNonAscii(paths)) throw new Error(NON_ASCII_HINT + '（还原操作请改用 TortoiseSVN）')
  return withLock(wc.path, async () => {
    const args = ['revert', '-R', '--non-interactive', '--'].concat(paths)
    const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 120000, exe: options.svnPath })
    return { output: stdout.trim(), paths }
  })
}

export function addPaths(key, options = {}) {
  const wc = getRegisteredWc(key)
  const paths = normalizePathList(wc.path, options.paths)
  if (!paths.length) throw new Error('请先勾选要纳入版本控制的文件')
  return withLock(wc.path, async () => {
    let targets = paths
    if (hasNonAscii(paths)) {
      const entries = await readStatusEntries(wc.path)
      const all = entries.filter((entry) => entry.item === 'unversioned').map((entry) => entry.path)
      const ignored = entries.filter((entry) => entry.item === 'ignored')
      if (ignored.length) {
        throw new Error('工作副本里有被忽略的文件，Windows 命令行无法安全地只添加选中项；请用 TortoiseSVN 逐个纳入。')
      }
      if (!coversAllPaths(paths, all)) {
        throw new Error(NON_ASCII_HINT + '（当前只勾选了一部分未纳入文件）')
      }
      targets = []
    }
    const args = targets.length
      ? ['add', '--parents', '--non-interactive', '--'].concat(targets)
      : ['add', '--force', '--depth', 'infinity', '--non-interactive', '--', '.']
    const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 120000, exe: options.svnPath })
    return { output: stdout.trim(), paths }
  })
}

export function deletePaths(key, options = {}) {
  const wc = getRegisteredWc(key)
  const paths = normalizePathList(wc.path, options.paths)
  if (!paths.length) throw new Error('请先勾选要删除的文件')
  if (hasNonAscii(paths)) throw new Error(NON_ASCII_HINT + '（删除操作请改用 TortoiseSVN）')
  return withLock(wc.path, async () => {
    const args = ['delete', '--force', '--non-interactive', '--'].concat(paths)
    const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 120000, exe: options.svnPath })
    return { output: stdout.trim(), paths }
  })
}

const RESOLVE_ACCEPTS = new Set(['working', 'base', 'mine-full', 'theirs-full', 'mine-conflict', 'theirs-conflict'])

export function resolvePaths(key, options = {}) {
  const wc = getRegisteredWc(key)
  const paths = normalizePathList(wc.path, options.paths)
  if (!paths.length) throw new Error('请先勾选要标记为解决的文件')
  const accept = String(options.accept || 'working')
  if (!RESOLVE_ACCEPTS.has(accept)) throw new Error('不支持的解决方式：' + accept)
  return withLock(wc.path, async () => {
    let targets = paths
    if (hasNonAscii(paths)) {
      const entries = await readStatusEntries(wc.path)
      const all = entries.filter((entry) => entry.item === 'conflicted' || entry.treeConflicted).map((entry) => entry.path)
      if (!coversAllPaths(paths, all)) {
        throw new Error(NON_ASCII_HINT + '（当前只勾选了一部分冲突文件）')
      }
      targets = []
    }
    const args = targets.length
      ? ['resolve', '--accept', accept, '--non-interactive', '--'].concat(targets)
      : ['resolve', '--accept', accept, '--non-interactive', '.']
    const { stdout } = await runSvn(args, { cwd: wc.path, timeout: 120000, exe: options.svnPath })
    return { output: stdout.trim(), paths, accept }
  })
}

export function cleanup(key, options = {}) {
  const wc = getRegisteredWc(key)
  return withLock(wc.path, async () => {
    const { stdout } = await runSvn(['cleanup', '--non-interactive'], {
      cwd: wc.path,
      timeout: 180000,
      exe: options.svnPath,
    })
    return { output: stdout.trim() }
  })
}

//#endregion

//#region HTTP 工具

export function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

//#endregion
