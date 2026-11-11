/**
 * dsh-svn —— 插件服务端入口。
 *
 * 把 /dsh-svn/* 注册到宿主的 webServer，并把请求转给 core.js；
 * 另外注册 5 个只读 Agent 工具（svn_info / svn_status / svn_log / svn_diff / svn_blame）。
 *
 * /dsh-svn/reload 会重新 import core.js，改完服务端逻辑不必重启宿主。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import * as initialCore from './core.js'
import { registerSvnTools } from './tools.js'

const CORE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'core.js')
const CORE_URL = pathToFileURL(CORE_FILE).href

let core = initialCore
let reloadedAt = null

async function reloadCore() {
  const next = await import(CORE_URL + '?t=' + Date.now())
  const required = [
    'getState', 'getStatus', 'getLog', 'getDiff', 'getBlame', 'getCat', 'getInfo',
    'addWorkingCopy', 'removeWorkingCopy', 'discover', 'browseDirectories', 'updateSettings',
    'update', 'commit', 'revert', 'addPaths', 'deletePaths', 'resolvePaths', 'cleanup',
    'sendJson', 'readJsonBody', 'readConfig', 'resolveWorkingCopy',
  ]
  for (const name of required) {
    if (typeof next[name] !== 'function') throw new Error('core.js 缺少导出：' + name)
  }
  core = next
  reloadedAt = new Date().toISOString()
  return reloadedAt
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      const message = String((err && err.message) || err)
      try {
        core.sendJson(res, 400, { ok: false, error: message })
      } catch (err2) {
        try { res.end() } catch (err3) {}
      }
    }
  }
}

async function body(req) {
  return core.readJsonBody(req)
}

const handlers = {
  async state(req, res) {
    const state = await core.getState()
    core.sendJson(res, 200, Object.assign({ ok: true }, state))
  },

  async addWc(req, res) {
    const input = await body(req)
    const info = await core.addWorkingCopy(input.path, { name: input.name })
    core.sendJson(res, 200, { ok: true, workingCopy: info })
  },

  async removeWc(req, res) {
    const input = await body(req)
    const result = await core.removeWorkingCopy(input.path)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async discover(req, res) {
    const input = await body(req)
    const roots = input.root ? [input.root] : [process.cwd()]
    const candidates = await core.discover(roots, {
      depth: input.depth,
      budgetMs: input.budgetMs,
      limit: input.limit,
    })
    core.sendJson(res, 200, { ok: true, candidates, roots })
  },

  async browse(req, res) {
    const input = await body(req)
    const result = await core.browseDirectories(input.path)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async settings(req, res) {
    const input = await body(req)
    const result = await core.updateSettings(input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async status(req, res) {
    const input = await body(req)
    const result = await core.getStatus(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async log(req, res) {
    const input = await body(req)
    const result = await core.getLog(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async diff(req, res) {
    const input = await body(req)
    const result = await core.getDiff(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async blame(req, res) {
    const input = await body(req)
    const result = await core.getBlame(input.wc, input.path, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async cat(req, res) {
    const input = await body(req)
    const result = await core.getCat(input.wc, input.path, input.revision)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async info(req, res) {
    const input = await body(req)
    const result = await core.getInfo(input.wc)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async update(req, res) {
    const input = await body(req)
    const result = await core.update(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async commit(req, res) {
    const input = await body(req)
    const result = await core.commit(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async revert(req, res) {
    const input = await body(req)
    const result = await core.revert(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async add(req, res) {
    const input = await body(req)
    const result = await core.addPaths(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async remove(req, res) {
    const input = await body(req)
    const result = await core.deletePaths(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async resolve(req, res) {
    const input = await body(req)
    const result = await core.resolvePaths(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async cleanup(req, res) {
    const input = await body(req)
    const result = await core.cleanup(input.wc, input)
    core.sendJson(res, 200, Object.assign({ ok: true }, result))
  },

  async reload(req, res) {
    const at = await reloadCore()
    core.sendJson(res, 200, { ok: true, reloadedAt: at })
  },
}

export default {
  name: 'dsh-svn',
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch (err) {}
      }
    })

    root.inject(['webServer'], (ctx) => {
      const routes = [
        ['/dsh-svn/state', handlers.state],
        ['/dsh-svn/wc/add', handlers.addWc],
        ['/dsh-svn/wc/remove', handlers.removeWc],
        ['/dsh-svn/discover', handlers.discover],
        ['/dsh-svn/browse', handlers.browse],
        ['/dsh-svn/settings', handlers.settings],
        ['/dsh-svn/status', handlers.status],
        ['/dsh-svn/log', handlers.log],
        ['/dsh-svn/diff', handlers.diff],
        ['/dsh-svn/blame', handlers.blame],
        ['/dsh-svn/cat', handlers.cat],
        ['/dsh-svn/info', handlers.info],
        ['/dsh-svn/update', handlers.update],
        ['/dsh-svn/commit', handlers.commit],
        ['/dsh-svn/revert', handlers.revert],
        ['/dsh-svn/add', handlers.add],
        ['/dsh-svn/delete', handlers.remove],
        ['/dsh-svn/resolve', handlers.resolve],
        ['/dsh-svn/cleanup', handlers.cleanup],
        ['/dsh-svn/reload', handlers.reload],
      ]
      for (const [routePath, handler] of routes) {
        try {
          disposers.push(ctx.webServer.register({
            kind: 'exact',
            path: routePath,
            handler: route(handler),
          }))
        } catch (err) {
          console.warn('[dsh-svn] 注册路由失败 ' + routePath + '：' + String((err && err.message) || err))
        }
      }
      console.log('[dsh-svn] HTTP 路由已就绪：/dsh-svn/*（POST /dsh-svn/reload 可热重载服务端逻辑）')
    })

    root.inject(['tools'], (ctx) => {
      registerSvnTools(ctx, () => core).then((result) => {
        disposers.push(result.dispose)
        if (result.count > 0) {
          console.log('[dsh-svn] 已注册 ' + result.count + ' 个 Agent 工具：svn_info / svn_status / svn_log / svn_diff / svn_blame')
        } else {
          console.warn('[dsh-svn] 没有可用的 tools 服务，Agent 工具未注册（面板功能不受影响）')
        }
      }).catch((err) => {
        console.warn('[dsh-svn] 注册 Agent 工具失败：' + String((err && err.message) || err))
      })
    })
  },
}
