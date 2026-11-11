/**
 * dsh-svn 服务端冒烟测试：直接调用 core.js，对 fixtures 里的本地仓库做读写。
 * 运行：node test/smoke.mjs
 *
 * 使用独立的 DSH_HOME（fixtures/home），不碰真实配置。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'fixtures')
const home = path.join(fixtures, 'home')
const wc = path.join(fixtures, 'wc')
const wc2 = path.join(fixtures, 'wc2')

fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home

const core = await import('../lib/core.js')
const { parseXml, child, text } = await import('../lib/xml.js')

let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log('  ✓ ' + name)
    })
    .catch((err) => {
      console.error('  ✗ ' + name)
      throw err
    })
}

console.log('XML 解析')
await check('实体、多行属性、CDATA', () => {
  const doc = parseXml('<a x="1"><b y="2">a &amp; b &#65;</b><c><![CDATA[<raw>]]></c></a>')
  assert.equal(doc.children[0].attrs.x, '1')
  assert.equal(text(child(doc.children[0], 'b')), 'a & b A')
  assert.equal(text(child(doc.children[0], 'c')), '<raw>')
})

console.log('工作副本管理')
await check('登记工作副本并读取 info', async () => {
  const info = await core.addWorkingCopy(wc)
  assert.equal(info.path, wc)
  assert.match(info.url, /\/trunk$/)
  assert.ok(info.revision >= 7)
  const state = await core.getState()
  assert.equal(state.workingCopies.length, 1)
  assert.equal(state.workingCopies[0].ok, true)
})

await check('重复登记会被拒绝', async () => {
  await assert.rejects(() => core.addWorkingCopy(wc), /已经添加过/)
})

await check('非工作副本目录会被拒绝', async () => {
  await assert.rejects(() => core.addWorkingCopy(fixtures), /不是 SVN 工作副本/)
})

console.log('目录浏览')
await check('列出目录并标记工作副本', async () => {
  const rootsView = await core.browseDirectories('')
  assert.ok(rootsView.roots.length >= 1)
  const view = await core.browseDirectories(fixtures)
  assert.ok(view.entries.some((entry) => entry.name === 'wc' && entry.isWc))
  assert.ok(view.entries.every((entry) => entry.name !== '.svn'))
  const inside = await core.browseDirectories(wc)
  assert.equal(inside.isWc, true)
  assert.ok(inside.parent)
})

await check('浏览不存在的目录会报错', async () => {
  await assert.rejects(() => core.browseDirectories(path.join(fixtures, 'no-such-dir')), /目录不存在/)
})

console.log('状态')
const status = await core.getStatus(wc)
await check('冲突 / 新增 / 删除 / 未纳入 都被识别', () => {
  assert.equal(status.summary.conflicted, 1)
  assert.equal(status.summary.added, 1)
  assert.equal(status.summary.deleted, 1)
  assert.ok(status.summary.unversioned >= 1)
  const conflicted = status.entries.find((entry) => entry.path === 'src.txt')
  assert.equal(conflicted.item, 'conflicted')
  const added = status.entries.find((entry) => entry.path === 'added.txt')
  assert.equal(added.item, 'added')
})

await check('冲突排在最前面', () => {
  assert.equal(status.entries[0].item, 'conflicted')
})

console.log('历史')
const log = await core.getLog(wc, { limit: 20 })
await check('提交历史与作者、中文提交信息', () => {
  assert.ok(log.entries.length >= 5)
  assert.equal(log.entries[0].revision, 7)
  assert.equal(log.entries[0].author, 'carol')
  assert.match(log.entries[0].message, /冲突/)
  assert.ok(log.entries[0].paths.some((item) => item.path === '/trunk/src.txt'))
})

await check('关键字与作者过滤', async () => {
  const filtered = await core.getLog(wc, { limit: 20, keyword: 'README' })
  assert.ok(filtered.entries.length >= 1)
  assert.ok(filtered.entries.every((entry) => /README/.test(entry.message) || entry.paths.some((item) => /README/.test(item.path))))
  const byAuthor = await core.getLog(wc, { limit: 20, author: 'bob' })
  assert.ok(byAuthor.entries.every((entry) => entry.author === 'bob'))
})

await check('按路径限定历史', async () => {
  const scoped = await core.getLog(wc, { limit: 20, path: 'src.txt' })
  assert.ok(scoped.entries.length >= 3)
  assert.ok(scoped.entries.every((entry) => entry.paths.some((item) => item.path === '/trunk/src.txt')))
})

console.log('差异')
await check('版本差异（-c 7）', async () => {
  const diff = await core.getDiff(wc, { revision: 7 })
  assert.equal(diff.mode, 'revision')
  assert.match(diff.diff, /remote conflict edit/)
  assert.ok(diff.additions >= 1 && diff.deletions >= 1)
})

await check('本地差异包含冲突标记', async () => {
  const diff = await core.getDiff(wc, { path: 'src.txt' })
  assert.equal(diff.mode, 'working')
  assert.match(diff.diff, /<<<<<<< \.mine/)
  assert.match(diff.diff, /line2 local conflict edit/)
})

await check('未纳入版本控制的文件合成 diff', async () => {
  const diff = await core.getDiff(wc, { path: 'new-file.txt' })
  assert.equal(diff.synthesized, true)
  assert.match(diff.diff, /\+未纳入版本控制的新文件/)
})

await check('已版本控制且无改动的文件不合成 diff', async () => {
  const diff = await core.getDiff(wc, { path: 'README.md' })
  assert.equal(diff.empty, true)
  assert.equal(diff.synthesized, false)
})

console.log('溯源与其他')
await check('blame 返回逐行版本', async () => {
  const blame = await core.getBlame(wc, 'src.txt')
  assert.ok(blame.lines.length >= 3)
  assert.ok(blame.lines.some((line) => line.revision > 0))
})

await check('cat 读取指定版本内容', async () => {
  const history = await core.getLog(wc, { limit: 20 })
  const target = history.entries.find((entry) => /调整第二行/.test(entry.message))
  assert.ok(target, '历史里应能找到「调整第二行文案」')
  const cat = await core.getCat(wc, 'src.txt', target.revision)
  assert.match(cat.content, /line2 changed/)
  assert.equal(cat.binary, false)
})

await check('越界路径被拒绝', async () => {
  await assert.rejects(() => core.getDiff(wc, { path: '../outside.txt' }), /不能包含 \.\./)
})

console.log('写操作')
await check('update 到当前版本', async () => {
  const result = await core.update(wc)
  assert.ok(result.revision >= 7)
})

await check('新增文件并提交', async () => {
  fs.writeFileSync(path.join(wc, 'commit-test.txt'), '来自冒烟测试\n第二行\n', 'utf8')
  await core.addPaths(wc, { paths: ['commit-test.txt'] })
  const result = await core.commit(wc, { paths: ['commit-test.txt'], message: '冒烟测试：新增提交文件' })
  assert.ok(result.revision > 7)
  const fresh = await core.getLog(wc, { limit: 1 })
  assert.equal(fresh.entries[0].revision, result.revision)
  assert.match(fresh.entries[0].message, /冒烟测试/)
})

await check('还原本地修改', async () => {
  fs.writeFileSync(path.join(wc, 'src.txt'), '被改坏的内容\n', 'utf8')
  const before = await core.getStatus(wc, { path: 'src.txt' })
  assert.ok(before.entries.some((entry) => entry.item === 'modified' || entry.item === 'conflicted'))
  await core.revert(wc, { paths: ['src.txt'] })
  const after = await core.getStatus(wc, { path: 'src.txt' })
  assert.equal(after.entries.length, 0)
})

await check('自动发现能找到 wc2', async () => {
  const found = await core.discover([fixtures], { depth: 2, budgetMs: 5000 })
  assert.ok(found.some((item) => item.path.toLowerCase() === wc2.toLowerCase()))
})

await check('移除工作副本只影响配置', async () => {
  const result = await core.removeWorkingCopy(wc)
  assert.equal(result.removed, wc)
  assert.ok(fs.existsSync(path.join(wc, '.svn')))
  const state = await core.getState()
  assert.equal(state.workingCopies.length, 0)
})

console.log(`\n全部通过：${passed} 项`)
