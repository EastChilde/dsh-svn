/**
 * 重建本地 SVN fixture：一个仓库 + 两个工作副本，覆盖
 * 冲突 / 新增 / 删除 / 丢失 / 未纳入版本控制 五种状态。
 *
 * 用 Node 的 execFile 传参（Windows 下走 CreateProcessW），提交信息则走
 * -F + --encoding UTF-8 —— 这也是插件本身采用的调用方式。
 *
 * 运行：node test/setup-fixture.mjs
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = path.join(here, '..', 'fixtures')
const repo = path.join(base, 'repo')
const wc = path.join(base, 'wc')
const wc2 = path.join(base, 'wc2')
const svn = process.env.DSH_SVN_PATH || 'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe'
const svnadmin = process.env.DSH_SVN_ADMIN || path.join(path.dirname(svn), 'svnadmin.exe')
const url = 'file:///' + repo.replace(/\\/g, '/').replace(/^\//, '')

function run(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`命令失败：${exe} ${args.join(' ')}\n${stderr || stdout || error.message}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

const svnRun = (args, cwd) => run(svn, args, cwd)
const write = (file, content) => fs.writeFileSync(file, content, 'utf8')

/** 提交信息用 -F 文件传，避免 Windows 命令行 ANSI 编码把中文存坏。 */
async function commit(message, user, cwd = wc, targets = []) {
  const file = path.join(base, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`)
  write(file, message + '\n')
  try {
    await svnRun(['commit', '-F', file, '--encoding', 'UTF-8', '--username', user].concat(targets), cwd)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

async function main() {
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(base, { recursive: true })
  await run(svnadmin, ['create', repo])

  await svnRun(['mkdir', `${url}/trunk`, `${url}/branches`, `${url}/tags`, '-m', 'init', '--username', 'alice'])
  await svnRun(['checkout', `${url}/trunk`, wc, '--username', 'alice'])

  write(path.join(wc, 'README.md'), '# DSH SVN 插件测试仓库\n\n这是第一版说明。\n')
  write(path.join(wc, 'src.txt'), 'line1\nline2\nline3\n')
  await svnRun(['add', 'README.md', 'src.txt'], wc)
  await commit('添加 README 与源码文件', 'alice')

  write(path.join(wc, 'src.txt'), 'line1\nline2 changed\nline3\n')
  await commit('调整第二行文案', 'bob')

  write(path.join(wc, 'README.md'), '# DSH SVN 插件测试仓库\n\n这是第一版说明。\n\n第二版补充：用于验证提交历史与差异。\n')
  await commit('补充 README 说明', 'alice')

  write(path.join(wc, 'notes.txt'), '备注一\n备注二\n')
  await svnRun(['add', 'notes.txt'], wc)
  await commit('添加备注文件', 'alice')

  write(path.join(wc, 'legacy.txt'), '这行以后会从磁盘上删掉，用来演示「丢失」状态。\n')
  await svnRun(['add', 'legacy.txt'], wc)
  await commit('添加待删除的旧文件', 'alice')

  // 本地：删除一个已纳入版本控制的文件、新增一个、留下未纳入版本控制的文件
  await svnRun(['delete', 'notes.txt'], wc)
  write(path.join(wc, 'added.txt'), '这个文件会被 svn add，等待提交。\n')
  await svnRun(['add', 'added.txt'], wc)
  write(path.join(wc, 'new-file.txt'), '未纳入版本控制的新文件\n第二行\n')

  // 冲突：wc2 先提交同一行的另一处修改，wc 再 update
  await svnRun(['checkout', `${url}/trunk`, wc2, '--username', 'bob'])
  await svnRun(['update'], wc2)
  write(path.join(wc2, 'src.txt'), 'line1\nline2 remote conflict edit\nline3\n')
  await commit('远程再次修改第二行（用于制造冲突）', 'carol', wc2)

  write(path.join(wc, 'src.txt'), 'line1\nline2 local conflict edit\nline3\n')
  await svnRun(['update', '--accept', 'postpone'], wc)
  // update 会把丢失的文件补回来，所以最后再从磁盘删掉，制造「缺失」状态
  fs.rmSync(path.join(wc, 'legacy.txt'))

  const status = await svnRun(['status'], wc)
  console.log(status.stdout)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
