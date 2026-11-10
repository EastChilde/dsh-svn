/**
 * dsh-svn HTTP 冒烟测试：直接打运行中宿主的 /dsh-svn/* 接口。
 * 运行：node test/http.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const base = 'http://127.0.0.1:61382/dsh-svn'
const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'fixtures')
const wc = path.join(fixtures, 'wc')

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    console.error('  ✗ ' + name)
    throw err
  }
}

async function post(endpoint, body) {
  const response = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const data = await response.json()
  if (!response.ok || data.ok === false) throw new Error(endpoint + ' 失败：' + (data.error || response.status))
  return data
}

console.log('状态')
await check('工作副本已登记', async () => {
  const state = await post('/state')
  const found = state.workingCopies.find((item) => item.path.toLowerCase() === wc.toLowerCase())
  assert.ok(found, '未找到 fixture 工作副本')
  assert.equal(found.ok, true)
})

const status = await post('/status', { wc })
await check('冲突 / 新增 / 删除 / 缺失 / 未纳入', () => {
  assert.equal(status.summary.conflicted, 1)
  assert.equal(status.summary.added, 1)
  assert.equal(status.summary.deleted, 1)
  assert.equal(status.summary.missing, 1)
  assert.ok(status.summary.unversioned >= 1)
  assert.equal(status.entries[0].item, 'conflicted')
})

console.log('历史')
const log = await post('/log', { wc, limit: 20 })
await check('中文提交信息（UTF-8 全链路）', () => {
  assert.ok(log.entries.length >= 5)
  assert.match(log.entries[0].message, /冲突/)
  assert.equal(log.entries[0].author, 'carol')
})

await check('关键词过滤', async () => {
  const filtered = await post('/log', { wc, limit: 20, keyword: 'README' })
  assert.ok(filtered.entries.length >= 1)
})

await check('路径限定历史', async () => {
  const scoped = await post('/log', { wc, limit: 20, path: 'src.txt' })
  assert.ok(scoped.entries.length >= 3)
})

console.log('差异')
await check('版本差异', async () => {
  const diff = await post('/diff', { wc, revision: 7 })
  assert.match(diff.diff, /remote conflict edit/)
  assert.ok(diff.additions >= 1)
})

await check('本地差异包含冲突标记', async () => {
  const diff = await post('/diff', { wc, path: 'src.txt' })
  assert.match(diff.diff, /<<<<<<< \.mine/)
})

await check('未纳入版本控制的文件合成 diff', async () => {
  const diff = await post('/diff', { wc, path: 'new-file.txt' })
  assert.equal(diff.synthesized, true)
  assert.match(diff.diff, /\+未纳入版本控制的新文件/)
})

await check('仓库路径（/trunk/...）能映射到工作副本路径', async () => {
  const diff = await post('/diff', { wc, revision: 7, path: '/trunk/src.txt' })
  assert.match(diff.diff, /remote conflict edit/)
})

console.log('溯源与其他')
await check('blame', async () => {
  const blame = await post('/blame', { wc, path: 'src.txt' })
  assert.ok(blame.lines.length >= 3)
})

await check('按仓库路径 blame', async () => {
  const blame = await post('/blame', { wc, path: '/trunk/src.txt' })
  assert.ok(blame.lines.length >= 3)
})

await check('cat 指定版本', async () => {
  const cat = await post('/cat', { wc, path: 'src.txt', revision: 7 })
  assert.match(cat.content, /remote conflict edit/)
})

await check('越界路径被拒绝', async () => {
  await assert.rejects(() => post('/diff', { wc, path: '../outside.txt' }), /不能包含 \.\./)
})

console.log('写操作')
await check('纳入 + 提交 + 记录可读', async () => {
  const name = 'http-test-' + Date.now() + '.txt'
  fs.writeFileSync(path.join(wc, name), '来自 HTTP 测试\n第二行\n', 'utf8')
  await post('/add', { wc, paths: [name] })
  const result = await post('/commit', { wc, paths: [name], message: '接口测试：新增 ' + name })
  assert.ok(result.revision > 7)
  const fresh = await post('/log', { wc, limit: 3 })
  assert.equal(fresh.entries[0].revision, result.revision)
  assert.match(fresh.entries[0].message, /接口测试/)
})

await check('还原本地修改', async () => {
  fs.writeFileSync(path.join(wc, 'src.txt'), 'broken\n', 'utf8')
  await post('/revert', { wc, paths: ['src.txt'] })
  const after = await post('/status', { wc, path: 'src.txt' })
  assert.equal(after.entries.filter((item) => item.item === 'modified').length, 0)
})

console.log('真实工作副本（只读）')
let realWc = ''
await check('登记真实工作副本', async () => {
  const candidate = 'D:\\projects\\dcop'
  if (!fs.existsSync(path.join(candidate, '.svn'))) {
    console.log('    （跳过：D:\\projects\\dcop 不存在）')
    return
  }
  try {
    const result = await post('/wc/add', { path: candidate })
    realWc = result.workingCopy.path
  } catch (err) {
    if (!/已经添加过/.test(err.message)) throw err
    realWc = candidate
  }
  assert.ok(realWc)
})

if (realWc) {
  await check('读取真实仓库历史', async () => {
    const data = await post('/log', { wc: realWc, limit: 5 })
    assert.ok(data.entries.length >= 1)
    assert.ok(data.entries[0].revision > 0)
  })
  await check('真实仓库状态', async () => {
    const data = await post('/status', { wc: realWc })
    assert.equal(typeof data.summary.total, 'number')
  })
}

console.log(`\n全部通过：${passed} 项`)
