/**
 * SVN 命令行执行层。
 *
 * 只做三件事：找到 svn.exe、以「工作副本为 cwd + 相对路径」执行命令、
 * 把失败整理成用户看得懂的错误。业务语义都在 core.js。
 *
 * 为什么坚持 cwd + 相对路径：svn 对 `svn diff <wc> -- <相对路径>` 的解析
 * 是相对当前目录的，不是相对 <wc>；把 cwd 设成工作副本根、路径一律相对，
 * 既避免这个坑，也避免把任意绝对路径交给命令行。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseXml } from './xml.js'

const MAX_BUFFER = 64 * 1024 * 1024
let cachedExe = null

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch (err) {
    return false
  }
}

/** 解析 svn.exe 位置：显式配置 > 环境变量 > TortoiseSVN 默认安装 > PATH。 */
export function findSvnExe(configured) {
  if (configured && isFile(configured)) return configured
  if (cachedExe) return cachedExe
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const candidates = [
    process.env.DSH_SVN_PATH,
    path.join(programFiles, 'TortoiseSVN', 'bin', 'svn.exe'),
    path.join(programFilesX86, 'TortoiseSVN', 'bin', 'svn.exe'),
    path.join(programFiles, 'Subversion', 'bin', 'svn.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) {
      cachedExe = candidate
      return candidate
    }
  }
  cachedExe = 'svn'
  return cachedExe
}

export function resetSvnExeCache() {
  cachedExe = null
}

function toText(value) {
  if (value == null) return ''
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return String(value)
}

function tidyError(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*svn:\s*(warning:\s*)?/i, '').replace(/^svn:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('；')
}

function makeError(args, code, raw, cause) {
  const detail = tidyError(raw)
  const error = new Error(detail || `SVN 命令执行失败（退出码 ${code}）`)
  error.code = code
  error.svnArgs = args
  error.stderr = raw
  if (cause) error.cause = cause
  return error
}

/**
 * 执行一条 svn 命令。
 * @param {string[]} args 参数数组（不经 shell，天然免疫注入）
 * @param {{cwd?:string, timeout?:number, exe?:string}} options
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export async function runSvn(args, options = {}) {
  const exe = findSvnExe(options.exe)
  const timeout = options.timeout || 30000
  const cwd = options.cwd
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      {
        cwd,
        timeout,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'buffer',
        env: Object.assign({}, process.env, { SVN_EDITOR: '', SVN_MERGE: '' }),
      },
      (error, stdout, stderr) => {
        const out = toText(stdout)
        const errText = toText(stderr)
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: errText })
          return
        }
        if (error.code === 'ENOENT') {
          reject(new Error('找不到 svn.exe：请安装 TortoiseSVN / Subversion，或设置环境变量 DSH_SVN_PATH 指向 svn.exe'))
          return
        }
        if (error.killed) {
          reject(new Error(`SVN 命令超时（${Math.round(timeout / 1000)} 秒）：svn ${args[0] || ''}`))
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        // `svn diff` 在发现差异时部分平台返回 1，stderr 为空即视为成功。
        if (args[0] === 'diff' && code === 1 && !errText.trim()) {
          resolve({ code: 1, stdout: out, stderr: errText })
          return
        }
        reject(makeError(args, code, errText || out, error))
      },
    )
  })
}

/** 执行 svn --xml 子命令并解析成树。 */
export async function runSvnXml(args, options = {}) {
  const result = await runSvn(args.concat(['--xml', '--non-interactive']), options)
  return parseXml(result.stdout)
}
