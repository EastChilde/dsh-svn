/**
 * dsh-svn —— 浏览器端。
 *
 * 走 DSH 官方客户端插件约定：宿主用 window.__ModuleLoader__.load({ id, factory })
 * 加载本文件，工厂返回 { name, inject, apply }，apply 里往 UI 槽位注册组件。
 * 只依赖 react（宿主提供）；面板是纯 DOM，不用 JSX、不需要构建步骤。
 *
 * 入口：
 *   · sidebar.right.pane.tab       右侧栏「SVN」标签页（概览）
 *   · sidebar.right.pane.tab.title 标签标题
 *   · conversation.session.header.utilities  会话头部按钮，点开全屏面板
 *   · settings.section             设置里的「SVN 版本控制」整页
 *
 * 全屏面板用 #svn 也能直接打开（方便截图/深链）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-svn',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const KEY = 'dsh-svn'
    const API = '/dsh-svn'
    const CSS_ID = 'dsh-svn-style'
    const WC_STORAGE = 'dsh-svn:wc'
    const COMMIT_ITEMS = { modified: 1, added: 1, deleted: 1, replaced: 1 }

    const STATUS_META = {
      conflicted: { letter: 'C', label: '冲突', color: '#e5484d', bg: 'rgba(229,72,77,.16)' },
      modified: { letter: 'M', label: '修改', color: '#c98421', bg: 'rgba(217,144,42,.16)' },
      added: { letter: 'A', label: '新增', color: '#2f9e68', bg: 'rgba(48,164,108,.16)' },
      deleted: { letter: 'D', label: '删除', color: '#e5484d', bg: 'rgba(229,72,77,.14)' },
      missing: { letter: '!', label: '丢失', color: '#e5484d', bg: 'rgba(229,72,77,.14)' },
      unversioned: { letter: '?', label: '未纳入', color: '#8b93a7', bg: 'rgba(139,147,167,.16)' },
      replaced: { letter: 'R', label: '替换', color: '#8e4ec6', bg: 'rgba(142,78,198,.16)' },
      obstructed: { letter: '~', label: '阻塞', color: '#e5484d', bg: 'rgba(229,72,77,.14)' },
      incomplete: { letter: '!', label: '不完整', color: '#e5484d', bg: 'rgba(229,72,77,.14)' },
      external: { letter: 'X', label: '外部', color: '#8b93a7', bg: 'rgba(139,147,167,.16)' },
      ignored: { letter: 'I', label: '忽略', color: '#8b93a7', bg: 'rgba(139,147,167,.14)' },
      normal: { letter: ' ', label: '正常', color: '#8b93a7', bg: 'rgba(139,147,167,.14)' },
    }

    //#region 样式
    const CSS = `
.svn-root { font: inherit; color: CanvasText; --svn-accent: #4d6bfe; --svn-line: rgba(127,127,127,.22); --svn-soft: rgba(127,127,127,.08); --svn-hover: rgba(127,127,127,.13); --svn-muted: rgba(127,127,127,.95); }
.svn-root *, .svn-root *::before, .svn-root *::after { box-sizing: border-box; }
.svn-root button { font: inherit; color: inherit; }
.svn-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(8,10,16,.42); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 18px; }
.svn-shell { width: min(1240px,96vw); height: min(840px,92vh); background: Canvas; color: CanvasText; border: 1px solid var(--svn-line); border-radius: 14px; box-shadow: 0 30px 90px rgba(0,0,0,.42); display: flex; flex-direction: column; overflow: hidden; position: relative; }
.svn-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--svn-line); flex: none; }
.svn-logo { width: 32px; height: 32px; border-radius: 9px; background: linear-gradient(135deg,#4d6bfe,#7a5cf0); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 12px; letter-spacing: .04em; flex: none; box-shadow: 0 3px 10px rgba(77,107,254,.35); }
.svn-headmain { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.svn-title { font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.svn-sub { font-size: 11.5px; color: var(--svn-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; }
.svn-revpill { font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: rgba(77,107,254,.13); color: var(--svn-accent); border: 1px solid rgba(77,107,254,.25); }
.svn-head-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.svn-busy { font-size: 11.5px; color: var(--svn-muted); display: inline-flex; align-items: center; gap: 6px; margin-right: 4px; }
.svn-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(127,127,127,.3); border-top-color: var(--svn-accent); display: inline-block; animation: svnspin .8s linear infinite; }
@keyframes svnspin { to { transform: rotate(360deg); } }
.svn-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--svn-line); background: transparent; cursor: pointer; font-size: 12px; white-space: nowrap; transition: background .12s, border-color .12s; }
.svn-btn:hover:not(:disabled) { background: var(--svn-hover); }
.svn-btn:disabled { opacity: .45; cursor: default; }
.svn-btn.primary { background: var(--svn-accent); border-color: var(--svn-accent); color: #fff; font-weight: 600; }
.svn-btn.primary:hover:not(:disabled) { background: #3f5bea; }
.svn-btn.danger { color: #e5484d; border-color: rgba(229,72,77,.4); }
.svn-btn.danger:hover:not(:disabled) { background: rgba(229,72,77,.12); }
.svn-btn.small { padding: 3px 8px; font-size: 11.5px; border-radius: 6px; }
.svn-icon { width: 28px; height: 28px; border-radius: 7px; border: none; background: transparent; cursor: pointer; display: grid; place-items: center; font-size: 16px; color: var(--svn-muted); }
.svn-icon:hover { background: var(--svn-hover); color: inherit; }
.svn-body { flex: 1; display: flex; min-height: 0; }
.svn-side { width: 236px; flex: none; border-right: 1px solid var(--svn-line); overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 12px; }
.svn-side-title { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--svn-muted); font-weight: 650; display: flex; align-items: center; justify-content: space-between; }
.svn-wc { display: flex; flex-direction: column; gap: 2px; padding: 7px 8px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; background: none; text-align: left; width: 100%; }
.svn-wc:hover { background: var(--svn-hover); }
.svn-wc.on { border-color: rgba(77,107,254,.45); background: rgba(77,107,254,.09); }
.svn-wc-name { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.svn-wc-path { font-size: 10.5px; color: var(--svn-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.svn-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #2f9e68; }
.svn-dot.bad { background: #e5484d; }
.svn-kv { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; }
.svn-kv-row { display: flex; gap: 6px; min-width: 0; }
.svn-kv-k { color: var(--svn-muted); flex: none; width: 58px; }
.svn-kv-v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svn-side-empty { font-size: 11.5px; color: var(--svn-muted); line-height: 1.6; }
.svn-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.svn-tabs { display: flex; align-items: center; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--svn-line); flex: none; height: 38px; }
.svn-tab { height: 100%; padding: 0 10px; border: none; background: none; cursor: pointer; color: var(--svn-muted); font-size: 12.5px; border-bottom: 2px solid transparent; display: inline-flex; align-items: center; gap: 6px; }
.svn-tab:hover { color: inherit; }
.svn-tab.on { color: var(--svn-accent); border-bottom-color: var(--svn-accent); font-weight: 600; }
.svn-tab .svn-count { font-size: 10.5px; padding: 0 5px; border-radius: 999px; background: var(--svn-soft); color: var(--svn-muted); }
.svn-tab.on .svn-count { background: rgba(77,107,254,.15); color: var(--svn-accent); }
.svn-tabsep { flex: 1; }
.svn-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.svn-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--svn-soft); flex-wrap: wrap; flex: none; }
.svn-input { border: 1px solid var(--svn-line); border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 4px 8px; min-width: 0; }
.svn-input:focus { outline: 1px solid var(--svn-accent); outline-offset: -1px; border-color: var(--svn-accent); }
.svn-input.grow { flex: 1; }
.svn-input.sm { width: 92px; }
.svn-input.md { width: 128px; }
.svn-chip { border: 1px solid var(--svn-line); background: transparent; border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer; color: var(--svn-muted); display: inline-flex; align-items: center; gap: 4px; }
.svn-chip:hover { background: var(--svn-hover); }
.svn-chip.on { border-color: var(--svn-accent); color: var(--svn-accent); background: rgba(77,107,254,.1); }
.svn-chip b { font-weight: 650; font-variant-numeric: tabular-nums; }
.svn-chips { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--svn-soft); flex: none; }
.svn-list { flex: 1; overflow: auto; min-height: 0; }
.svn-row { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--svn-soft); cursor: pointer; min-width: 0; }
.svn-row:hover { background: var(--svn-hover); }
.svn-row.sel { background: rgba(77,107,254,.08); }
.svn-row.conflict { background: rgba(229,72,77,.06); }
.svn-row input[type=checkbox] { width: 13px; height: 13px; accent-color: var(--svn-accent); flex: none; cursor: pointer; }
.svn-badge { width: 20px; height: 20px; border-radius: 5px; display: grid; place-items: center; font-size: 11px; font-weight: 700; flex: none; font-family: ui-monospace, Consolas, monospace; }
.svn-path { flex: 1; min-width: 0; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svn-path .svn-dir { color: var(--svn-muted); }
.svn-prop { font-size: 9px; font-weight: 700; color: #8e4ec6; border: 1px solid rgba(142,78,198,.4); border-radius: 3px; padding: 0 3px; margin-left: 5px; vertical-align: 1px; }
.svn-tag { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: rgba(229,72,77,.16); color: #e5484d; flex: none; }
.svn-footer { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-top: 1px solid var(--svn-line); flex-wrap: wrap; flex: none; background: var(--svn-soft); }
.svn-footer-gap { flex: 1; }
.svn-muted { color: var(--svn-muted); font-size: 11.5px; }
.svn-history { display: flex; flex: 1; min-height: 0; }
.svn-log { width: 55%; border-right: 1px solid var(--svn-line); display: flex; flex-direction: column; min-width: 0; }
.svn-log-list { flex: 1; overflow: auto; min-height: 0; }
.svn-logrow { display: flex; gap: 9px; padding: 8px 12px; border-bottom: 1px solid var(--svn-soft); cursor: pointer; align-items: flex-start; }
.svn-logrow:hover { background: var(--svn-hover); }
.svn-logrow.sel { background: rgba(77,107,254,.09); }
.svn-rev { font-family: ui-monospace, Consolas, monospace; font-size: 11px; font-weight: 700; color: var(--svn-accent); background: rgba(77,107,254,.1); border-radius: 5px; padding: 2px 5px; flex: none; margin-top: 1px; }
.svn-logmain { min-width: 0; flex: 1; }
.svn-logmsg { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svn-logmeta { font-size: 10.5px; color: var(--svn-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svn-logmore { padding: 8px 12px; border-top: 1px solid var(--svn-soft); }
.svn-detail { flex: 1; overflow: auto; padding: 14px 16px; min-width: 0; }
.svn-detail-empty { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--svn-muted); font-size: 12px; text-align: center; line-height: 1.7; }
.svn-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.svn-detail-author { font-size: 12px; font-weight: 600; }
.svn-detail-date { font-size: 11px; color: var(--svn-muted); }
.svn-msg { font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; background: var(--svn-soft); border: 1px solid var(--svn-soft); border-radius: 9px; padding: 9px 11px; margin: 0 0 12px; max-height: 220px; overflow: auto; }
.svn-section { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--svn-muted); font-weight: 650; margin: 10px 0 6px; display: flex; align-items: center; gap: 6px; }
.svn-pathlist { display: flex; flex-direction: column; border: 1px solid var(--svn-soft); border-radius: 9px; overflow: hidden; }
.svn-pathrow { display: flex; align-items: center; gap: 7px; padding: 5px 8px; cursor: pointer; border-bottom: 1px solid var(--svn-soft); min-width: 0; }
.svn-pathrow:last-child { border-bottom: none; }
.svn-pathrow:hover { background: var(--svn-hover); }
.svn-pathrow .svn-path { font-size: 11.5px; }
.svn-action { width: 17px; height: 17px; border-radius: 4px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; font-family: ui-monospace, Consolas, monospace; flex: none; }
.svn-diff { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.svn-diff-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--svn-soft); flex: none; flex-wrap: wrap; }
.svn-diff-title { font-size: 12.5px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.svn-stat { font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
.svn-stat.add { color: #2f9e68; }
.svn-stat.del { color: #e5484d; }
.svn-diff-body { flex: 1; overflow: auto; min-height: 0; background: rgba(127,127,127,.025); }
.svn-diff-body table { border-collapse: collapse; width: 100%; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; line-height: 1.55; }
.svn-dline { display: flex; min-width: max-content; }
.svn-dno { width: 44px; flex: none; text-align: right; padding-right: 9px; color: var(--svn-muted); opacity: .55; user-select: none; font-size: 10.5px; }
.svn-dtext { white-space: pre; padding-right: 28px; flex: 1; }
.svn-diff-body.wrap .svn-dtext { white-space: pre-wrap; word-break: break-word; }
.svn-dline.add { background: rgba(46,160,67,.14); }
.svn-dline.add .svn-dtext { color: #1f7a4d; }
.svn-dline.del { background: rgba(248,81,73,.12); }
.svn-dline.del .svn-dtext { color: #b3383c; }
.svn-dline.hunk { background: rgba(77,107,254,.1); }
.svn-dline.hunk .svn-dtext { color: #4d6bfe; font-weight: 600; }
.svn-dline.meta .svn-dtext { color: var(--svn-muted); }
.svn-dline.meta { background: var(--svn-soft); }
.svn-blame { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.svn-blame-body { flex: 1; overflow: auto; min-height: 0; }
.svn-blame-row { display: flex; gap: 8px; padding: 1px 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.6; }
.svn-blame-row:hover { background: var(--svn-hover); }
.svn-blame-no { width: 40px; text-align: right; color: var(--svn-muted); opacity: .6; flex: none; }
.svn-blame-rev { width: 46px; text-align: right; color: var(--svn-accent); flex: none; cursor: pointer; }
.svn-blame-author { width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--svn-muted); flex: none; }
.svn-blame-text { white-space: pre; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.svn-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--svn-muted); font-size: 12.5px; padding: 30px; text-align: center; }
.svn-empty-icon { font-size: 30px; opacity: .5; }
.svn-errorbox { margin: 10px 12px; padding: 8px 10px; border-radius: 8px; background: rgba(229,72,77,.1); border: 1px solid rgba(229,72,77,.28); color: #c53b3f; font-size: 12px; display: flex; align-items: center; gap: 8px; }
.svn-errorbox .svn-btn { margin-left: auto; }
.svn-loading { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--svn-muted); font-size: 12px; }
.svn-toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 20; max-width: 82%; padding: 7px 14px; border-radius: 999px; font-size: 12px; background: rgba(24,26,32,.94); color: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svn-toast.err { background: rgba(190,50,55,.96); }
.svn-toast.warn { background: rgba(168,112,20,.97); }
.svn-modal-back { position: fixed; inset: 0; z-index: 10001; background: rgba(8,10,16,.45); display: flex; align-items: center; justify-content: center; padding: 20px; }
.svn-modal { background: Canvas; color: CanvasText; border: 1px solid var(--svn-line); border-radius: 12px; box-shadow: 0 24px 70px rgba(0,0,0,.4); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; max-width: 94vw; }
.svn-modal-head { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--svn-line); flex: none; }
.svn-modal-title { font-size: 13px; font-weight: 650; }
.svn-modal-head .svn-icon { margin-left: auto; }
.svn-modal-body { padding: 14px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.svn-modal-foot { padding: 10px 14px; border-top: 1px solid var(--svn-line); display: flex; justify-content: flex-end; gap: 8px; flex: none; }
.svn-textarea { width: 100%; min-height: 110px; resize: vertical; border: 1px solid var(--svn-line); border-radius: 9px; background: transparent; color: inherit; font: inherit; font-size: 12.5px; line-height: 1.6; padding: 8px 10px; }
.svn-textarea:focus { outline: 1px solid var(--svn-accent); outline-offset: -1px; }
.svn-commit-list { max-height: 200px; overflow: auto; border: 1px solid var(--svn-soft); border-radius: 9px; }
.svn-commit-item { display: flex; align-items: center; gap: 7px; padding: 4px 8px; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; border-bottom: 1px solid var(--svn-soft); }
.svn-commit-item:last-child { border-bottom: none; }
.svn-hint { font-size: 11px; color: var(--svn-muted); line-height: 1.55; }
.svn-choice { display: flex; gap: 8px; align-items: flex-start; padding: 7px 9px; border: 1px solid var(--svn-line); border-radius: 8px; cursor: pointer; }
.svn-choice:hover { background: var(--svn-hover); }
.svn-choice.on { border-color: var(--svn-accent); background: rgba(77,107,254,.08); }
.svn-choice input { margin-top: 2px; accent-color: var(--svn-accent); }
.svn-choice div { display: flex; flex-direction: column; gap: 1px; }
.svn-choice b { font-size: 12px; font-weight: 600; }
.svn-choice span { font-size: 11px; color: var(--svn-muted); }
.svn-candidate { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--svn-soft); border-radius: 8px; }
.svn-candidate .svn-path { font-size: 11px; }
.svn-picker { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.svn-picker-path { display: flex; gap: 6px; align-items: center; }
.svn-picker-roots { display: flex; gap: 5px; flex-wrap: wrap; }
.svn-picker-list { border: 1px solid var(--svn-line); border-radius: 9px; max-height: 42vh; overflow: auto; background: rgba(127,127,127,.03); }
.svn-picker-row { display: flex; align-items: center; gap: 7px; padding: 6px 9px; border-bottom: 1px solid var(--svn-soft); cursor: pointer; min-width: 0; }
.svn-picker-row:last-child { border-bottom: none; }
.svn-picker-row:hover { background: var(--svn-hover); }
.svn-picker-icon { color: var(--svn-muted); font-size: 11px; width: 12px; flex: none; }
.svn-picker-row .svn-path { flex: 0 1 auto; font-size: 12px; color: CanvasText; }
.svn-picker-wc { font-size: 9.5px; padding: 0 5px; border-radius: 4px; background: rgba(48,164,108,.16); color: #2f9e68; flex: none; font-weight: 600; margin-left: 2px; }
.svn-picker-spacer { flex: 1; }
.svn-picker-empty { padding: 24px 10px; text-align: center; color: var(--svn-muted); font-size: 12px; }
.svn-hbtn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--svn-line); background: transparent; cursor: pointer; font-size: 11.5px; color: inherit; }
.svn-hbtn:hover { background: var(--svn-hover); }
.svn-hbtn-dot { width: 6px; height: 6px; border-radius: 50%; background: #4d6bfe; }
.svn-tabtitle { display: inline-flex; align-items: center; gap: 5px; }
.svn-tabtitle i { width: 6px; height: 6px; border-radius: 50%; background: #4d6bfe; }
.svn-pane { padding: 10px 12px 16px; display: flex; flex-direction: column; gap: 9px; min-height: 100%; }
.svn-pane-head { display: flex; align-items: center; gap: 7px; }
.svn-pane-title { font-size: 13px; font-weight: 650; display: flex; align-items: center; gap: 6px; }
.svn-pane-actions { margin-left: auto; display: flex; gap: 2px; }
.svn-pane-wc { width: 100%; border: 1px solid var(--svn-line); border-radius: 7px; background: transparent; color: inherit; font-size: 11.5px; padding: 4px 6px; }
.svn-pane-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.svn-pane-file { display: flex; align-items: center; gap: 6px; padding: 3px 2px; cursor: pointer; border-radius: 5px; min-width: 0; }
.svn-pane-file:hover { background: var(--svn-hover); }
.svn-pane-file .svn-path { font-size: 11px; }
.svn-pane-logrow { display: flex; gap: 6px; align-items: baseline; padding: 2px 2px; cursor: pointer; border-radius: 5px; min-width: 0; }
.svn-pane-logrow:hover { background: var(--svn-hover); }
.svn-pane-logmsg { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.svn-pane-logmeta { font-size: 10px; color: var(--svn-muted); flex: none; }
.svn-pane-empty { font-size: 11.5px; color: var(--svn-muted); line-height: 1.65; }
@media (max-width: 860px) { .svn-side { display: none; } .svn-log { width: 100%; } .svn-detail { display: none; } }
`
    //#endregion

    //#region 工具函数

    function injectCss() {
      if (document.getElementById(CSS_ID)) return
      const style = document.createElement('style')
      style.id = CSS_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(path, body) {
      let response
      try {
        response = await fetch(API + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      } catch (err) {
        throw new Error('无法连接 SVN 插件服务，请确认插件已加载（' + String((err && err.message) || err) + '）')
      }
      let data = null
      try {
        data = await response.json()
      } catch (err) {
        throw new Error('SVN 插件服务返回了非 JSON 响应（HTTP ' + response.status + '）')
      }
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || '请求失败（HTTP ' + response.status + '）')
      }
      return data
    }

    function readStorage(key) {
      try { return window.localStorage.getItem(key) || '' } catch (err) { return '' }
    }

    function writeStorage(key, value) {
      try { window.localStorage.setItem(key, value) } catch (err) {}
    }

    function metaOf(item) {
      return STATUS_META[item] || { letter: '?', label: item || '未知', color: '#8b93a7', bg: 'rgba(139,147,167,.16)' }
    }

    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    function fmtDate(iso, withTime) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16).replace('T', ' ')
      const head = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
      return withTime === false ? head : head + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function firstLine(message, max) {
      const line = String(message || '').split(/\r?\n/)[0].trim()
      const limit = max || 200
      return line.length > limit ? line.slice(0, limit) + '…' : line
    }

    function splitPath(rel) {
      const value = String(rel || '').replace(/\\/g, '/')
      const index = value.lastIndexOf('/')
      if (index < 0) return ['', value]
      return [value.slice(0, index + 1), value.slice(index + 1)]
    }

    function copyText(value) {
      const text = String(value || '')
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      }
      return Promise.resolve(fallbackCopy(text))
    }

    function fallbackCopy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      } catch (err) {}
    }

    function parseDiff(text) {
      const lines = []
      let oldNo = 0
      let newNo = 0
      for (const raw of String(text || '').split(/\r?\n/)) {
        if (raw.startsWith('@@')) {
          const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
          if (match) {
            oldNo = Number(match[1]) || 0
            newNo = Number(match[2]) || 0
          }
          lines.push({ type: 'hunk', text: raw })
          continue
        }
        if (raw.startsWith('+++') || raw.startsWith('---')) {
          lines.push({ type: 'meta', text: raw })
          continue
        }
        if (/^(Index:|={5,}|Property changes on:|Added:|Modified:|Deleted:|## )/.test(raw)) {
          lines.push({ type: 'meta', text: raw })
          continue
        }
        if (raw.startsWith('+')) {
          lines.push({ type: 'add', text: raw, newNo })
          newNo += 1
          continue
        }
        if (raw.startsWith('-')) {
          lines.push({ type: 'del', text: raw, oldNo })
          oldNo += 1
          continue
        }
        if (raw.startsWith(' ')) {
          lines.push({ type: 'ctx', text: raw, oldNo, newNo })
          oldNo += 1
          newNo += 1
          continue
        }
        lines.push({ type: 'meta', text: raw })
      }
      return lines
    }

    function actionMeta(action) {
      if (action === 'A') return { bg: 'rgba(48,164,108,.16)', color: '#2f9e68' }
      if (action === 'D') return { bg: 'rgba(229,72,77,.14)', color: '#e5484d' }
      if (action === 'R') return { bg: 'rgba(142,78,198,.16)', color: '#8e4ec6' }
      return { bg: 'rgba(217,144,42,.16)', color: '#c98421' }
    }

    function hasNonAscii(value) {
      return /[^\x00-\x7F]/.test(String(value == null ? '' : value))
    }

    function isHashSvn() {
      try {
        return String(window.location.hash || '').replace(/^#/, '').split(/[/?]/)[0] === 'svn'
      } catch (err) {
        return false
      }
    }

    //#endregion

    //#region 小组件

    function Spinner() {
      return h('span', { className: 'svn-spin' })
    }

    function StatusBadge(props) {
      const meta = metaOf(props.item)
      return h('span', {
        className: 'svn-badge',
        style: { background: meta.bg, color: meta.color },
        title: meta.label,
      }, meta.letter)
    }

    function Empty(props) {
      return h('div', { className: 'svn-empty' },
        h('div', { className: 'svn-empty-icon' }, props.icon || '⌗'),
        h('div', null, props.title),
        props.hint ? h('div', { style: { fontSize: 11.5, opacity: .8 } }, props.hint) : null,
        props.action || null,
      )
    }

    function Modal(props) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopImmediatePropagation()
            props.onClose()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [props.onClose])

      return h('div', {
        className: 'svn-root svn-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() },
      }, h('div', { className: 'svn-modal', style: { width: props.width || 460 } },
        h('div', { className: 'svn-modal-head' },
          h('div', { className: 'svn-modal-title' }, props.title),
          h('button', { type: 'button', className: 'svn-icon', title: '关闭', onClick: props.onClose }, '×'),
        ),
        h('div', { className: 'svn-modal-body' }, props.children),
        props.footer ? h('div', { className: 'svn-modal-foot' }, props.footer) : null,
      ))
    }

    function ConfirmDialog(props) {
      const [working, setWorking] = useState(false)
      const [error, setError] = useState('')

      async function confirm() {
        setWorking(true)
        setError('')
        try {
          const ok = props.onOk ? await props.onOk() : true
          if (ok !== false) props.onClose()
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setWorking(false)
        }
      }

      return h(Modal, {
        title: props.title,
        width: 460,
        onClose: working ? () => {} : props.onClose,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'svn-btn', onClick: props.onClose, disabled: working }, '取消'),
          h('button', {
            type: 'button',
            className: 'svn-btn ' + (props.danger ? 'danger' : 'primary'),
            onClick: confirm,
            disabled: working,
          }, working ? '处理中…' : (props.okLabel || '确定')),
        ),
      },
        h('div', { style: { fontSize: 12.5, lineHeight: 1.75 } }, props.body),
        props.detail ? h('pre', { className: 'svn-msg', style: { margin: 0, maxHeight: 160, fontSize: 11.5 } }, props.detail) : null,
        error ? h('div', { className: 'svn-errorbox', style: { margin: 0 } }, error) : null,
      )
    }

    //#endregion

    // 组件实现（继续保持在一个 factory 里，便于宿主加载）
    //#region 主面板

    function SvnApp(props) {
      const [stateData, setStateData] = useState(null)
      const [stateLoading, setStateLoading] = useState(true)
      const [stateError, setStateError] = useState('')
      const [wc, setWcState] = useState(() => readStorage(WC_STORAGE))
      const [status, setStatus] = useState(null)
      const [statusLoading, setStatusLoading] = useState(false)
      const [statusError, setStatusError] = useState('')
      const [log, setLog] = useState(null)
      const [logLoading, setLogLoading] = useState(false)
      const [logError, setLogError] = useState('')
      const [filters, setFilters] = useState({ author: '', keyword: '', path: '', from: '', to: '' })
      const [filterDraft, setFilterDraft] = useState({ author: '', keyword: '', path: '', from: '', to: '' })
      const [tab, setTab] = useState(() => {
        try {
          const match = /^#svn\/([a-z]+)/.exec(window.location.hash || '')
          if (match && (match[1] === 'changes' || match[1] === 'history')) return match[1]
        } catch (err) {}
        return 'changes'
      })
      const [returnTab, setReturnTab] = useState('changes')
      const [detail, setDetail] = useState(null)
      const [selected, setSelected] = useState({})
      const [itemFilter, setItemFilter] = useState('all')
      const [pathFilter, setPathFilter] = useState('')
      const [remote, setRemote] = useState(false)
      const [diff, setDiff] = useState(null)
      const [blame, setBlame] = useState(null)
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [commitOpen, setCommitOpen] = useState(false)
      const [commitPaths, setCommitPaths] = useState([])
      const [commitMessage, setCommitMessage] = useState('')
      const [resolveOpen, setResolveOpen] = useState(false)
      const [addOpen, setAddOpen] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)

      const toastTimer = useRef(null)
      const statusSeq = useRef(0)
      const logSeq = useRef(0)
      const initialDone = useRef(false)

      function notify(message, kind) {
        setToast({ message: String(message), kind: kind || 'ok' })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 4200)
      }

      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

      const setWc = useCallback((value) => {
        setWcState(value)
        writeStorage(WC_STORAGE, value)
      }, [])

      const workingCopies = (stateData && stateData.workingCopies) || []
      const current = workingCopies.find((item) => item.path === wc) || workingCopies[0] || null
      const currentPath = current ? current.path : ''

      useEffect(() => {
        if (current && current.path !== wc) setWc(current.path)
      }, [current, wc, setWc])

      const loadState = useCallback(async (silent) => {
        if (!silent) setStateLoading(true)
        try {
          const data = await api('/state')
          setStateData(data)
          setStateError('')
          return data
        } catch (err) {
          setStateError(String((err && err.message) || err))
          return null
        } finally {
          if (!silent) setStateLoading(false)
        }
      }, [])

      useEffect(() => {
        loadState().then((data) => {
          if (data && data.autoDiscovered) notify('已自动发现 ' + data.autoDiscovered + ' 个工作副本', 'ok')
        })
      }, [loadState])

      const loadStatus = useCallback(async (options) => {
        if (!currentPath) return
        const seq = statusSeq.current + 1
        statusSeq.current = seq
        setStatusLoading(true)
        setStatusError('')
        try {
          const data = await api('/status', { wc: currentPath, remote: !!(options && options.remote) })
          if (seq !== statusSeq.current) return
          setStatus(data)
          setSelected((prev) => {
            const next = {}
            for (const entry of data.entries) if (prev[entry.path]) next[entry.path] = true
            return next
          })
        } catch (err) {
          if (seq === statusSeq.current) setStatusError(String((err && err.message) || err))
        } finally {
          if (seq === statusSeq.current) setStatusLoading(false)
        }
      }, [currentPath])

      const loadLog = useCallback(async (options) => {
        if (!currentPath) return
        const opts = options || {}
        const useFilters = opts.filters || filters
        const seq = logSeq.current + 1
        logSeq.current = seq
        setLogLoading(true)
        setLogError('')
        try {
          const data = await api('/log', {
            wc: currentPath,
            limit: 100,
            beforeRev: opts.beforeRev,
            author: useFilters.author,
            keyword: useFilters.keyword,
            path: useFilters.path,
            from: useFilters.from,
            to: useFilters.to,
          })
          if (seq !== logSeq.current) return
          setLog((prev) => {
            if (opts.append && prev) return Object.assign({}, data, { entries: prev.entries.concat(data.entries) })
            return data
          })
          if (opts.filters) setFilters(opts.filters)
        } catch (err) {
          if (seq === logSeq.current) setLogError(String((err && err.message) || err))
        } finally {
          if (seq === logSeq.current) setLogLoading(false)
        }
      }, [currentPath, filters])

      useEffect(() => {
        setStatus(null)
        setLog(null)
        setDetail(null)
        setDiff(null)
        setBlame(null)
        setSelected({})
        setTab((prev) => (prev === 'diff' || prev === 'blame' ? 'changes' : prev))
        setStatusError('')
        setLogError('')
        if (currentPath) {
          loadStatus({ remote: remote })
          loadLog({ filters: filters })
        }
      }, [currentPath])

      async function perform(label, fn) {
        setBusy(label)
        try {
          return await fn()
        } catch (err) {
          notify(String((err && err.message) || err), 'err')
          return null
        } finally {
          setBusy('')
        }
      }

      async function refreshAll() {
        await loadState(true)
        await Promise.all([loadStatus({ remote: remote }), loadLog({ filters: filters })])
      }

      function openDiff(options) {
        const opts = options || {}
        setReturnTab(tab === 'diff' || tab === 'blame' ? returnTab : tab)
        setTab('diff')
        setDiff({ loading: true, title: opts.title || '差异', data: null, error: '' })
        api('/diff', Object.assign({ wc: currentPath }, opts.body || {}))
          .then((data) => setDiff({ loading: false, title: opts.title || '差异', data: data, error: '' }))
          .catch((err) => setDiff({ loading: false, title: opts.title || '差异', data: null, error: String((err && err.message) || err) }))
      }

      function openBlame(pathValue, label) {
        setReturnTab(tab === 'diff' || tab === 'blame' ? returnTab : tab)
        setTab('blame')
        setBlame({ loading: true, path: pathValue, label: label || pathValue, data: null, error: '' })
        api('/blame', { wc: currentPath, path: pathValue })
          .then((data) => setBlame({ loading: false, path: pathValue, label: label || pathValue, data: data, error: '' }))
          .catch((err) => setBlame({ loading: false, path: pathValue, label: label || pathValue, data: null, error: String((err && err.message) || err) }))
      }

      useEffect(() => {
        if (initialDone.current || !currentPath) return
        const initial = props.initial
        if (!initial) return
        initialDone.current = true
        if (initial.entry) {
          setDetail(initial.entry)
          setTab('history')
        }
        if (initial.diffPath) {
          openDiff({ title: initial.diffPath, body: { path: initial.diffPath } })
        }
      }, [currentPath])

      const entries = (status && status.entries) || []
      const selectedEntries = entries.filter((entry) => selected[entry.path])
      const selectedPaths = selectedEntries.map((entry) => entry.path)
      const committable = entries.filter((entry) => COMMIT_ITEMS[entry.item])
      const selectedCommittable = selectedEntries.filter((entry) => COMMIT_ITEMS[entry.item])

      function togglePath(value) {
        setSelected((prev) => {
          const next = Object.assign({}, prev)
          if (next[value]) delete next[value]
          else next[value] = true
          return next
        })
      }

      function selectAll() {
        const next = {}
        for (const entry of entries) if (entry.item !== 'ignored' && entry.item !== 'normal') next[entry.path] = true
        setSelected(next)
      }

      function invertSelection() {
        setSelected((prev) => {
          const next = {}
          for (const entry of entries) {
            if (entry.item === 'ignored' || entry.item === 'normal') continue
            if (!prev[entry.path]) next[entry.path] = true
          }
          return next
        })
      }

      function openCommitDialog() {
        let paths = selectedCommittable.map((entry) => entry.path)
        if (!paths.length) paths = committable.map((entry) => entry.path)
        if (!paths.length) {
          notify('没有可提交的更改（未纳入版本控制的文件需要先「纳入」）', 'warn')
          return
        }
        setCommitPaths(paths)
        setCommitMessage('')
        setCommitOpen(true)
      }

      async function submitCommit() {
        const message = commitMessage.trim()
        if (!message) {
          notify('提交信息不能为空', 'err')
          return
        }
        const result = await perform('正在提交…', () => api('/commit', { wc: currentPath, paths: commitPaths, message: message }))
        if (!result) return
        notify('已提交 r' + result.revision + '（' + commitPaths.length + ' 个文件）', 'ok')
        setCommitOpen(false)
        setCommitMessage('')
        setSelected({})
        await refreshAll()
      }

      function askUpdate() {
        setConfirm({
          title: '更新工作副本',
          body: '将从仓库拉取「' + current.name + '」的最新内容。本地未提交的修改会保留，冲突的文件会被标记出来。',
          okLabel: '开始更新',
          onOk: async () => {
            const result = await perform('正在更新…', () => api('/update', { wc: currentPath }))
            if (!result) return false
            notify(result.conflicts
              ? '更新完成：r' + result.revision + '，发现 ' + result.conflicts + ' 个冲突'
              : '更新完成：r' + result.revision, result.conflicts ? 'warn' : 'ok')
            setSelected({})
            await refreshAll()
            return true
          },
        })
      }

      function askRevert() {
        const paths = selectedEntries.filter((entry) => entry.item !== 'unversioned').map((entry) => entry.path)
        if (!paths.length) {
          notify('先勾选要还原的文件', 'warn')
          return
        }
        setConfirm({
          title: '还原修改',
          body: '将丢弃这 ' + paths.length + ' 个文件里未提交的本地修改，此操作不可撤销。',
          detail: paths.slice(0, 6).join('\n') + (paths.length > 6 ? '\n…' : ''),
          okLabel: '还原',
          danger: true,
          onOk: async () => {
            const result = await perform('正在还原…', () => api('/revert', { wc: currentPath, paths: paths }))
            if (!result) return false
            notify('已还原 ' + paths.length + ' 个文件')
            setSelected({})
            await refreshAll()
            return true
          },
        })
      }

      function askDelete() {
        const paths = selectedEntries.filter((entry) => entry.item !== 'unversioned').map((entry) => entry.path)
        if (!paths.length) {
          notify('先勾选要删除的文件', 'warn')
          return
        }
        setConfirm({
          title: '从版本库删除',
          body: '将 svn delete 这 ' + paths.length + ' 个文件/目录；提交后才会真正从仓库删除。',
          detail: paths.slice(0, 6).join('\n') + (paths.length > 6 ? '\n…' : ''),
          okLabel: '删除',
          danger: true,
          onOk: async () => {
            const result = await perform('正在删除…', () => api('/delete', { wc: currentPath, paths: paths }))
            if (!result) return false
            notify('已标记删除 ' + paths.length + ' 项')
            await refreshAll()
            return true
          },
        })
      }

      function askAdd() {
        const paths = selectedEntries.filter((entry) => entry.item === 'unversioned').map((entry) => entry.path)
        if (!paths.length) {
          notify('先勾选未纳入版本控制的文件', 'warn')
          return
        }
        setConfirm({
          title: '纳入版本控制',
          body: '将把这 ' + paths.length + ' 个文件 svn add，之后即可提交。',
          detail: paths.slice(0, 6).join('\n') + (paths.length > 6 ? '\n…' : ''),
          okLabel: '纳入',
          onOk: async () => {
            const result = await perform('正在纳入…', () => api('/add', { wc: currentPath, paths: paths }))
            if (!result) return false
            notify('已纳入 ' + paths.length + ' 个文件')
            await refreshAll()
            return true
          },
        })
      }

      function askResolve() {
        const paths = selectedEntries.filter((entry) => entry.item === 'conflicted' || entry.treeConflicted).map((entry) => entry.path)
        if (!paths.length) {
          notify('先勾选有冲突的文件', 'warn')
          return
        }
        setResolveOpen(true)
      }

      async function doResolve(accept) {
        const paths = selectedEntries.filter((entry) => entry.item === 'conflicted' || entry.treeConflicted).map((entry) => entry.path)
        const result = await perform('正在标记解决…', () => api('/resolve', { wc: currentPath, paths: paths, accept: accept }))
        if (!result) return
        notify('已标记 ' + paths.length + ' 个文件为解决（' + accept + '）')
        setResolveOpen(false)
        setSelected({})
        await refreshAll()
      }

      function askCleanup() {
        setConfirm({
          title: '清理工作副本',
          body: '执行 svn cleanup，清理锁和未完成的事务。工作副本被锁住或中断过操作时使用。',
          okLabel: '清理',
          onOk: async () => {
            const result = await perform('正在清理…', () => api('/cleanup', { wc: currentPath }))
            if (!result) return false
            notify('清理完成')
            return true
          },
        })
      }

      function applyFilters() {
        loadLog({ filters: filterDraft })
      }

      function resetFilters() {
        const empty = { author: '', keyword: '', path: '', from: '', to: '' }
        setFilterDraft(empty)
        loadLog({ filters: empty })
      }

      const tabButton = (name, label, count) => h('button', {
        type: 'button',
        className: 'svn-tab' + (tab === name ? ' on' : ''),
        onClick: () => setTab(name),
      }, label, count ? h('span', { className: 'svn-count' }, count) : null)

      const total = status && status.summary ? status.summary.total : 0

      return h('div', { className: 'svn-root svn-shell', onMouseDown: (event) => event.stopPropagation() },
        h('div', { className: 'svn-head' },
          h('div', { className: 'svn-logo' }, 'SVN'),
          h('div', { className: 'svn-headmain' },
            h('div', { className: 'svn-title' },
              '版本控制',
              current ? h('span', { className: 'svn-revpill', title: '当前版本' }, 'r' + current.revision) : null,
              current && current.remote ? h('span', { className: 'svn-revpill' }, 'remote') : null,
            ),
            h('div', { className: 'svn-sub', title: current ? current.path : '' },
              current ? current.name + ' · ' + current.path : '选择一个工作副本'),
          ),
          h('div', { className: 'svn-head-actions' },
            busy ? h('span', { className: 'svn-busy' }, h(Spinner), busy) : null,
            h('button', { type: 'button', className: 'svn-icon', title: '刷新', onClick: refreshAll, disabled: !!busy }, '⟳'),
            h('button', { type: 'button', className: 'svn-btn', onClick: askUpdate, disabled: !!busy || !current || current.ok === false }, '↓ 更新'),
            h('button', { type: 'button', className: 'svn-btn primary', onClick: openCommitDialog, disabled: !!busy || !current || current.ok === false }, '✓ 提交'),
            h('button', { type: 'button', className: 'svn-icon', title: '关闭', onClick: props.onClose }, '×'),
          ),
        ),

        h('div', { className: 'svn-body' },
          h(SvnSidebar, {
            state: stateData,
            current: current,
            loading: stateLoading,
            error: stateError,
            busy: busy,
            onSelect: setWc,
            onAdd: () => setAddOpen(true),
            onSettings: () => setSettingsOpen(true),
            onCleanup: askCleanup,
            onRetry: () => loadState(false),
          }),

          h('div', { className: 'svn-main' },
            h('div', { className: 'svn-tabs' },
              tabButton('changes', '更改', total || ''),
              tabButton('history', '历史', log && log.entries ? log.entries.length : ''),
              tab === 'diff' ? h('span', { className: 'svn-tab on' }, '差异') : null,
              tab === 'blame' ? h('span', { className: 'svn-tab on' }, '溯源') : null,
              h('div', { className: 'svn-tabsep' }),
              status ? h('span', { className: 'svn-muted' }, remote ? '已对比服务器' : '本地状态') : null,
            ),

            tab === 'changes' ? h(ChangesView, {
              status: status,
              loading: statusLoading,
              error: statusError,
              selected: selected,
              toggle: togglePath,
              selectAll: selectAll,
              invert: invertSelection,
              itemFilter: itemFilter,
              setItemFilter: setItemFilter,
              pathFilter: pathFilter,
              setPathFilter: setPathFilter,
              remote: remote,
              onRemote: () => {
                const next = !remote
                setRemote(next)
                loadStatus({ remote: next })
              },
              onRowDiff: (entry) => openDiff({ title: entry.path, body: { path: entry.path } }),
              onBlame: (entry) => openBlame(entry.path, entry.path),
              onCommit: openCommitDialog,
              onRevert: askRevert,
              onAdd: askAdd,
              onDelete: askDelete,
              onResolve: askResolve,
              onRetry: () => loadStatus({ remote: remote }),
              busy: busy,
            }) : null,

            tab === 'history' ? h(HistoryView, {
              log: log,
              loading: logLoading,
              error: logError,
              filters: filterDraft,
              setFilters: setFilterDraft,
              onApply: applyFilters,
              onReset: resetFilters,
              onLoadMore: () => log && loadLog({ append: true, beforeRev: log.nextBefore, filters: filters }),
              detail: detail,
              onSelectDetail: setDetail,
              onRevisionDiff: (entry) => openDiff({ title: 'r' + entry.revision + ' 的改动', body: { revision: entry.revision } }),
              onPathDiff: (entry, item) => openDiff({
                title: 'r' + entry.revision + ' · ' + item.path,
                body: { revision: entry.revision, path: item.path },
              }),
              onPathBlame: (entry, item) => openBlame(item.path, 'r' + entry.revision + ' · ' + item.path),
              onBlameLatest: (entry, item) => openBlame(item.path, item.path + ' @ r' + entry.revision),
              onRetry: () => loadLog({ filters: filters }),
            }) : null,

            tab === 'diff' ? h(DiffView, {
              diff: diff,
              onBack: () => setTab(returnTab),
              onClose: props.onClose,
              onBlame: () => {
                if (diff && diff.data && diff.data.relPath) openBlame(diff.data.relPath, diff.data.relPath)
              },
            }) : null,

            tab === 'blame' ? h(BlameView, {
              blame: blame,
              onBack: () => setTab(returnTab),
              onRevisionDiff: (revision) => openDiff({ title: 'r' + revision + ' 的改动', body: { revision: revision } }),
            }) : null,
          ),
        ),

        toast ? h('div', { className: 'svn-toast' + (toast.kind === 'err' ? ' err' : toast.kind === 'warn' ? ' warn' : '') }, toast.message) : null,

        confirm ? h(ConfirmDialog, {
          title: confirm.title,
          body: confirm.body,
          detail: confirm.detail,
          danger: confirm.danger,
          busy: busy,
          onOk: confirm.onOk,
          onClose: () => setConfirm(null),
        }) : null,

        commitOpen ? h(CommitDialog, {
          paths: commitPaths,
          entries: entries,
          message: commitMessage,
          setMessage: setCommitMessage,
          busy: busy,
          onClose: () => { if (!busy) setCommitOpen(false) },
          onSubmit: submitCommit,
        }) : null,

        resolveOpen ? h(ResolveDialog, {
          count: selectedEntries.filter((entry) => entry.item === 'conflicted' || entry.treeConflicted).length,
          busy: busy,
          onClose: () => { if (!busy) setResolveOpen(false) },
          onConfirm: doResolve,
        }) : null,

        addOpen ? h(AddWcDialog, {
          onClose: () => setAddOpen(false),
          onAdded: async (pathValue) => {
            setAddOpen(false)
            await loadState(true)
            setWc(pathValue)
            notify('已添加工作副本：' + pathValue)
          },
        }) : null,

        settingsOpen ? h(SettingsDialog, {
          currentSvnPath: stateData ? stateData.svnPath : '',
          autoDiscover: stateData ? stateData.autoDiscover !== false : true,
          onClose: () => setSettingsOpen(false),
          onSaved: async () => {
            setSettingsOpen(false)
            await loadState(true)
            notify('设置已保存')
          },
        }) : null,
      )
    }

    //#endregion

    //#region 侧栏

    function SvnSidebar(props) {
      const state = props.state
      const current = props.current
      const copies = (state && state.workingCopies) || []

      return h('div', { className: 'svn-side' },
        h('div', null,
          h('div', { className: 'svn-side-title' }, '工作副本',
            h('button', { type: 'button', className: 'svn-icon', style: { width: 22, height: 22, fontSize: 14 }, title: '添加工作副本', onClick: props.onAdd }, '+'),
          ),
          props.loading ? h('div', { className: 'svn-loading', style: { flex: 'none', padding: 12 } }, h(Spinner), '加载中…') : null,
          props.error ? h('div', { className: 'svn-errorbox', style: { margin: '8px 0' } },
            h('span', null, props.error),
            h('button', { type: 'button', className: 'svn-btn small', onClick: props.onRetry }, '重试'),
          ) : null,
          !props.loading && !copies.length ? h('div', { className: 'svn-side-empty' },
            '还没有登记工作副本。添加一个包含 .svn 的目录，或让插件自动扫描。',
            h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', className: 'svn-btn small', onClick: props.onAdd }, '+ 添加工作副本')),
          ) : null,
          copies.map((item) => h('button', {
            key: item.path,
            type: 'button',
            className: 'svn-wc' + (current && current.path === item.path ? ' on' : ''),
            onClick: () => props.onSelect(item.path),
            title: item.path,
          },
            h('div', { className: 'svn-wc-name' },
              h('span', { className: 'svn-dot' + (item.ok === false ? ' bad' : '') }),
              item.name || item.path,
              item.revision ? h('span', { className: 'svn-revpill' }, 'r' + item.revision) : null,
            ),
            h('div', { className: 'svn-wc-path' }, item.ok === false ? (item.error || '不可用') : item.path),
          )),
        ),

        current && current.ok !== false ? h('div', null,
          h('div', { className: 'svn-side-title' }, '仓库'),
          h('div', { className: 'svn-kv' },
            h('div', { className: 'svn-kv-row' }, h('span', { className: 'svn-kv-k' }, 'URL'), h('span', { className: 'svn-kv-v', title: current.url }, current.url || '-')),
            h('div', { className: 'svn-kv-row' }, h('span', { className: 'svn-kv-k' }, '仓库根'), h('span', { className: 'svn-kv-v', title: current.root }, current.root || '-')),
            h('div', { className: 'svn-kv-row' }, h('span', { className: 'svn-kv-k' }, '最后修改'), h('span', { className: 'svn-kv-v' }, 'r' + current.lastChangedRev + ' · ' + (current.lastChangedAuthor || '-'))),
            h('div', { className: 'svn-kv-row' }, h('span', { className: 'svn-kv-k' }, '时间'), h('span', { className: 'svn-kv-v' }, fmtDate(current.lastChangedDate))),
          ),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'svn-btn small', onClick: props.onCleanup, disabled: !!props.busy }, '清理锁'),
            h('button', { type: 'button', className: 'svn-btn small', onClick: props.onSettings }, '设置'),
          ),
        ) : null,

        h('div', { style: { marginTop: 'auto' } },
          h('div', { className: 'svn-side-title' }, 'svn.exe'),
          h('div', { className: 'svn-hint', style: { wordBreak: 'break-all' } }, state && state.svnPath ? state.svnPath : '-'),
          h('div', { className: 'svn-hint', style: { marginTop: 6 } }, 'Agent 工具：svn_status / svn_log / svn_diff / svn_blame'),
        ),
      )
    }

    //#endregion

    //#region 更改视图

    function ChangesView(props) {
      const status = props.status
      const entries = (status && status.entries) || []
      const summary = (status && status.summary) || {}
      const keyword = props.pathFilter.trim().toLowerCase()
      const visible = entries.filter((entry) => {
        if (props.itemFilter !== 'all' && entry.item !== props.itemFilter) return false
        if (keyword && !entry.path.toLowerCase().includes(keyword)) return false
        return true
      })
      const selectedCount = entries.filter((entry) => props.selected[entry.path]).length
      const hasUnicodeSelection = entries.some((entry) => props.selected[entry.path] && hasNonAscii(entry.path))
      const chips = [
        ['conflicted', '冲突'], ['modified', '修改'], ['added', '新增'],
        ['deleted', '删除'], ['missing', '丢失'], ['unversioned', '未纳入'],
      ]

      return h('div', { className: 'svn-view' },
        h('div', { className: 'svn-chips' },
          h('button', {
            type: 'button', className: 'svn-chip' + (props.itemFilter === 'all' ? ' on' : ''),
            onClick: () => props.setItemFilter('all'),
          }, '全部 ', h('b', null, summary.total || 0)),
          chips.filter(([key]) => summary[key]).map(([key, label]) => h('button', {
            key: key,
            type: 'button',
            className: 'svn-chip' + (props.itemFilter === key ? ' on' : ''),
            onClick: () => props.setItemFilter(props.itemFilter === key ? 'all' : key),
          }, label, ' ', h('b', null, summary[key]))),
          summary.props ? h('span', { className: 'svn-muted', title: '属性被修改的文件数' }, '· 属性 ' + summary.props) : null,
        ),

        h('div', { className: 'svn-toolbar' },
          h('input', {
            className: 'svn-input grow',
            placeholder: '过滤路径…',
            value: props.pathFilter,
            onChange: (event) => props.setPathFilter(event.target.value),
          }),
          h('button', {
            type: 'button',
            className: 'svn-btn small' + (props.remote ? ' primary' : ''),
            onClick: props.onRemote,
            disabled: props.loading,
            title: 'svn status -u：对比服务器上的新版本',
          }, props.remote ? '✓ 已对比服务器' : '对比服务器'),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onRetry, disabled: props.loading }, '刷新'),
        ),

        props.error ? h('div', { className: 'svn-errorbox' },
          h('span', null, props.error),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onRetry }, '重试'),
        ) : null,

        h('div', { className: 'svn-list' },
          props.loading && !status ? h('div', { className: 'svn-loading' }, h(Spinner), '读取工作副本状态…') : null,
          !props.loading && status && visible.length === 0 ? h(Empty, {
            icon: '✓',
            title: entries.length ? '没有符合筛选条件的文件' : '工作副本没有本地更改',
            hint: entries.length ? '试试切换上方的状态筛选或清空过滤。' : '可以点右上角「更新」拉取最新版本。',
          }) : null,
          visible.map((entry) => {
            const meta = metaOf(entry.item)
            const parts = splitPath(entry.path)
            return h('div', {
              key: entry.path,
              className: 'svn-row' + (props.selected[entry.path] ? ' sel' : '') + (entry.item === 'conflicted' ? ' conflict' : ''),
              onClick: () => props.onRowDiff(entry),
              title: entry.path + (entry.commit ? '\n最后提交：r' + entry.commit.revision + ' ' + (entry.commit.author || '') : ''),
            },
              h('input', {
                type: 'checkbox',
                checked: !!props.selected[entry.path],
                onClick: (event) => event.stopPropagation(),
                onChange: () => props.toggle(entry.path),
              }),
              h(StatusBadge, { item: entry.item }),
              h('span', { className: 'svn-path' },
                parts[0] ? h('span', { className: 'svn-dir' }, parts[0]) : null,
                parts[1],
                entry.props === 'modified' ? h('span', { className: 'svn-prop', title: '属性有修改' }, 'P') : null,
              ),
              entry.treeConflicted ? h('span', { className: 'svn-tag' }, '树冲突') : null,
              entry.copied ? h('span', { className: 'svn-tag', style: { background: 'rgba(48,164,108,.16)', color: '#2f9e68' } }, '复制') : null,
              h('button', {
                type: 'button',
                className: 'svn-icon',
                style: { width: 22, height: 22, fontSize: 11 },
                title: '逐行溯源（blame）',
                onClick: (event) => { event.stopPropagation(); props.onBlame(entry) },
              }, '溯'),
            )
          }),
          props.loading && status ? h('div', { className: 'svn-loading', style: { flex: 'none', padding: 10 } }, h(Spinner), '刷新中…') : null,
        ),

        h('div', { className: 'svn-footer' },
          h('span', { className: 'svn-muted' }, '已选 ' + selectedCount + ' / ' + entries.length),
          hasUnicodeSelection ? h('span', {
            className: 'svn-tag',
            title: 'Windows 版 svn.exe 命令行不支持非 ASCII 路径：提交时请勾选全部更改，或改用 TortoiseSVN',
          }, '含中文路径') : null,
          h('div', { className: 'svn-footer-gap' }),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.selectAll }, '全选'),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.invert }, '反选'),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onAdd, disabled: !!props.busy }, '纳入'),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onResolve, disabled: !!props.busy }, '解决冲突'),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onRevert, disabled: !!props.busy }, '还原'),
          h('button', { type: 'button', className: 'svn-btn small danger', onClick: props.onDelete, disabled: !!props.busy }, '删除'),
          h('button', { type: 'button', className: 'svn-btn primary', onClick: props.onCommit, disabled: !!props.busy || !(summary.total || 0) }, '提交所选'),
        ),
      )
    }

    //#endregion

    //#region 历史视图

    function HistoryView(props) {
      const log = props.log
      const entries = (log && log.entries) || []
      const detail = props.detail
      const filters = props.filters || {}

      return h('div', { className: 'svn-view' },
        h('div', { className: 'svn-toolbar' },
          h('input', {
            className: 'svn-input sm',
            placeholder: '作者',
            value: filters.author || '',
            onChange: (event) => props.setFilters(Object.assign({}, filters, { author: event.target.value })),
          }),
          h('input', {
            className: 'svn-input grow',
            placeholder: '关键词（提交信息 / 路径）',
            value: filters.keyword || '',
            onChange: (event) => props.setFilters(Object.assign({}, filters, { keyword: event.target.value })),
            onKeyDown: (event) => { if (event.key === 'Enter') props.onApply() },
          }),
          h('input', {
            className: 'svn-input md',
            placeholder: '限定路径',
            value: filters.path || '',
            onChange: (event) => props.setFilters(Object.assign({}, filters, { path: event.target.value })),
            onKeyDown: (event) => { if (event.key === 'Enter') props.onApply() },
          }),
          h('input', {
            className: 'svn-input sm',
            type: 'date',
            title: '起始日期',
            value: filters.from || '',
            onChange: (event) => props.setFilters(Object.assign({}, filters, { from: event.target.value })),
          }),
          h('input', {
            className: 'svn-input sm',
            type: 'date',
            title: '结束日期',
            value: filters.to || '',
            onChange: (event) => props.setFilters(Object.assign({}, filters, { to: event.target.value })),
          }),
          h('button', { type: 'button', className: 'svn-btn small primary', onClick: props.onApply, disabled: props.loading }, '查询'),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onReset, disabled: props.loading }, '重置'),
        ),

        props.error ? h('div', { className: 'svn-errorbox' },
          h('span', null, props.error),
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onRetry }, '重试'),
        ) : null,

        h('div', { className: 'svn-history' },
          h('div', { className: 'svn-log' },
            h('div', { className: 'svn-log-list' },
              props.loading && !log ? h('div', { className: 'svn-loading' }, h(Spinner), '读取提交历史…') : null,
              !props.loading && log && entries.length === 0 ? h(Empty, {
                icon: '⌗',
                title: '没有匹配的提交记录',
                hint: '试试放宽作者 / 关键词 / 日期，或清空「限定路径」。',
              }) : null,
              entries.map((entry) => h('div', {
                key: entry.revision,
                className: 'svn-logrow' + (detail && detail.revision === entry.revision ? ' sel' : ''),
                onClick: () => props.onSelectDetail(entry),
              },
                h('span', { className: 'svn-rev' }, 'r' + entry.revision),
                h('div', { className: 'svn-logmain' },
                  h('div', { className: 'svn-logmsg' }, firstLine(entry.message) || '(无提交信息)'),
                  h('div', { className: 'svn-logmeta' },
                    (entry.author || '(无作者)') + ' · ' + fmtDate(entry.date)
                    + (entry.paths && entry.paths.length ? ' · ' + entry.paths.length + ' 个文件' : ''),
                  ),
                ),
              )),
              log && log.hasMore ? h('div', { className: 'svn-logmore' },
                h('button', { type: 'button', className: 'svn-btn small', onClick: props.onLoadMore, disabled: props.loading },
                  props.loading ? '加载中…' : '加载更早的提交'),
              ) : null,
            ),
          ),
          h('div', { className: 'svn-detail' },
            detail ? h(CommitDetail, {
              entry: detail,
              onRevisionDiff: props.onRevisionDiff,
              onPathDiff: props.onPathDiff,
              onPathBlame: props.onPathBlame,
              onBlameLatest: props.onBlameLatest,
            }) : h('div', { className: 'svn-detail-empty' },
              h('div', null, '选择左侧的一条提交记录', h('br'), '查看提交信息、改动文件与版本差异'),
            ),
          ),
        ),
      )
    }

    function CommitDetail(props) {
      const entry = props.entry
      return h('div', null,
        h('div', { className: 'svn-detail-head' },
          h('span', { className: 'svn-rev' }, 'r' + entry.revision),
          h('span', { className: 'svn-detail-author' }, entry.author || '(无作者)'),
          h('span', { className: 'svn-detail-date' }, fmtDate(entry.date)),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 5 } },
            h('button', {
              type: 'button', className: 'svn-btn small', title: '复制版本号',
              onClick: () => copyText(String(entry.revision)),
            }, '复制版本'),
            h('button', { type: 'button', className: 'svn-btn small primary', onClick: () => props.onRevisionDiff(entry) }, '查看此版本差异'),
          ),
        ),
        h('pre', { className: 'svn-msg' }, entry.message || '(无提交信息)'),
        h('div', { className: 'svn-section' }, '改动文件 ' + (entry.paths ? entry.paths.length : 0)),
        entry.paths && entry.paths.length ? h('div', { className: 'svn-pathlist' },
          entry.paths.map((item, index) => {
            const action = actionMeta(item.action)
            return h('div', {
              key: index + ':' + item.path,
              className: 'svn-pathrow',
              onClick: () => props.onPathDiff(entry, item),
              title: '查看该文件在此版本中的差异',
            },
              h('span', { className: 'svn-action', style: { background: action.bg, color: action.color } }, item.action),
              h('span', { className: 'svn-path' }, item.path),
              item.copyFrom ? h('span', { className: 'svn-tag', title: '复制自 ' + item.copyFrom + '@' + item.copyFromRev }, 'copy') : null,
              h('button', {
                type: 'button', className: 'svn-icon', style: { width: 22, height: 22, fontSize: 10 },
                title: '查看该版本中此文件的逐行溯源',
                onClick: (event) => { event.stopPropagation(); props.onPathBlame(entry, item) },
              }, '溯'),
            )
          }),
        ) : h('div', { className: 'svn-hint' }, '这个版本没有记录改动路径。'),
        h('div', { className: 'svn-hint', style: { marginTop: 12 } }, '提示：点文件看该版本中的差异；「溯」按该版本溯源。'),
      )
    }

    //#endregion

    //#region 差异 / 溯源

    function DiffView(props) {
      const state = props.diff
      const [wrap, setWrap] = useState(false)
      if (!state) return null

      if (state.loading) {
        return h('div', { className: 'svn-view' },
          h('div', { className: 'svn-diff-head' },
            h('span', { className: 'svn-diff-title' }, state.title),
            h('button', { type: 'button', className: 'svn-btn small', onClick: props.onBack }, '← 返回'),
          ),
          h('div', { className: 'svn-loading' }, h(Spinner), '计算差异…'),
        )
      }

      if (state.error) {
        return h('div', { className: 'svn-view' },
          h('div', { className: 'svn-diff-head' },
            h('span', { className: 'svn-diff-title' }, state.title),
            h('button', { type: 'button', className: 'svn-btn small', onClick: props.onBack }, '← 返回'),
          ),
          h('div', { className: 'svn-errorbox' }, h('span', null, state.error)),
        )
      }

      const data = state.data || {}
      const lines = parseDiff(data.diff || '')
      const shown = lines.slice(0, 4000)

      return h('div', { className: 'svn-view svn-diff' },
        h('div', { className: 'svn-diff-head' },
          h('button', { type: 'button', className: 'svn-btn small', onClick: props.onBack }, '← 返回'),
          h('span', { className: 'svn-diff-title', title: state.title }, state.title),
          data.relPath ? h('span', { className: 'svn-muted' }, data.relPath) : null,
          h('span', { className: 'svn-stat add' }, '+' + (data.additions || 0)),
          h('span', { className: 'svn-stat del' }, '-' + (data.deletions || 0)),
          data.truncated ? h('span', { className: 'svn-tag' }, '已截断') : null,
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 5 } },
            data.relPath ? h('button', { type: 'button', className: 'svn-btn small', onClick: props.onBlame, title: '查看当前工作副本版本的逐行溯源' }, '溯源') : null,
            h('button', { type: 'button', className: 'svn-btn small', onClick: () => copyText(data.diff || '') }, '复制差异'),
            h('button', { type: 'button', className: 'svn-btn small' + (wrap ? ' primary' : ''), onClick: () => setWrap(!wrap) }, '换行'),
          ),
        ),
        data.binary ? h('div', { className: 'svn-hint', style: { padding: '8px 12px' } }, '文件被标记为二进制，文本差异无法显示。') : null,
        data.outsideWc ? h('div', { className: 'svn-hint', style: { padding: '8px 12px' } }, '该路径不在当前工作副本内，显示的是整个版本的差异。') : null,
        data.synthesized ? h('div', { className: 'svn-hint', style: { padding: '8px 12px' } }, '该文件未纳入版本控制，下面按「新增」展示工作副本内容。') : null,
        data.empty ? h(Empty, { icon: '≡', title: '没有差异', hint: '工作副本与版本库在这一范围里内容一致。' }) : h('div', { className: 'svn-diff-body' + (wrap ? ' wrap' : '') },
          shown.map((line, index) => h('div', { key: index, className: 'svn-dline ' + line.type },
            h('span', { className: 'svn-dno' }, line.oldNo === undefined ? '' : line.oldNo),
            h('span', { className: 'svn-dno' }, line.newNo === undefined ? '' : line.newNo),
            h('span', { className: 'svn-dtext' }, line.text === '' ? ' ' : line.text),
          )),
          lines.length > shown.length ? h('div', { className: 'svn-hint', style: { padding: '8px 12px' } },
            '差异共 ' + lines.length + ' 行，仅显示前 ' + shown.length + ' 行；完整内容可复制。',
          ) : null,
        ),
      )
    }

    function BlameView(props) {
      const state = props.blame
      if (!state) return null

      const header = (right) => h('div', { className: 'svn-diff-head' },
        h('button', { type: 'button', className: 'svn-btn small', onClick: props.onBack }, '← 返回'),
        h('span', { className: 'svn-diff-title' }, 'blame · ' + state.label),
        right || null,
      )

      if (state.loading) {
        return h('div', { className: 'svn-view' }, header(), h('div', { className: 'svn-loading' }, h(Spinner), '逐行溯源…'))
      }
      if (state.error) {
        return h('div', { className: 'svn-view' }, header(), h('div', { className: 'svn-errorbox' }, h('span', null, state.error)))
      }

      const data = state.data || {}
      const lines = (data.lines || []).slice(0, 3000)
      return h('div', { className: 'svn-view svn-blame' },
        header(h(React.Fragment, null,
          data.remote ? h('span', { className: 'svn-tag', title: '该文件按仓库版本溯源，不含本地未提交的改动' }, '仓库版本') : null,
          h('span', { className: 'svn-muted' }, data.total + ' 行'),
        )),
        h('div', { className: 'svn-blame-body' },
          lines.map((line) => h('div', { key: line.line, className: 'svn-blame-row' },
            h('span', { className: 'svn-blame-no' }, line.line),
            h('span', {
              className: 'svn-blame-rev',
              title: line.revision ? '查看 r' + line.revision + ' 的差异' : '本地未提交的改动',
              onClick: () => { if (line.revision && props.onRevisionDiff) props.onRevisionDiff(line.revision) },
            }, line.revision ? 'r' + line.revision : '-'),
            h('span', { className: 'svn-blame-author', title: line.author || '' }, line.author || '-'),
            h('span', { className: 'svn-blame-text' }, line.text === '' ? ' ' : line.text),
          )),
          (data.lines || []).length > lines.length ? h('div', { className: 'svn-hint', style: { padding: 8 } },
            '共 ' + data.total + ' 行，仅显示前 ' + lines.length + ' 行。',
          ) : null,
        ),
      )
    }

    //#endregion

    //#region 提交 / 解决 / 添加 / 设置

    function CommitDialog(props) {
      const entryMap = {}
      for (const entry of props.entries) entryMap[entry.path] = entry
      return h(Modal, {
        title: '提交 ' + props.paths.length + ' 个文件',
        width: 640,
        onClose: props.onClose,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'svn-btn', onClick: props.onClose, disabled: !!props.busy }, '取消'),
          h('button', {
            type: 'button',
            className: 'svn-btn primary',
            onClick: props.onSubmit,
            disabled: !!props.busy || !props.message.trim(),
          }, props.busy || '提交'),
        ),
      },
        h('div', { className: 'svn-commit-list' },
          props.paths.map((pathValue) => {
            const entry = entryMap[pathValue]
            const meta = metaOf(entry ? entry.item : 'modified')
            return h('div', { key: pathValue, className: 'svn-commit-item' },
              h('span', { className: 'svn-badge', style: { width: 16, height: 16, fontSize: 9.5, background: meta.bg, color: meta.color } }, meta.letter),
              h('span', { className: 'svn-path' }, pathValue),
            )
          }),
        ),
        h('textarea', {
          className: 'svn-textarea',
          placeholder: '提交信息（必填）…  Ctrl+Enter 提交',
          value: props.message,
          autoFocus: true,
          onChange: (event) => props.setMessage(event.target.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') props.onSubmit()
          },
        }),
        h('div', { className: 'svn-hint' }, '提交信息以 UTF-8 写入仓库；提交失败时工作副本保持原样。'),
        props.paths.some(hasNonAscii) ? h('div', { className: 'svn-hint' },
          '含中文路径：受 Windows svn.exe 命令行限制，提交时需要覆盖全部更改；只选一部分会被服务端拒绝并提示。',
        ) : null,
      )
    }

    function ResolveDialog(props) {
      const [accept, setAccept] = useState('working')
      const options = [
        ['working', '保留当前工作副本内容', '把冲突标记为已解决，文件内容保持现状（通常已手工改好）。'],
        ['mine-full', '全部采用我的版本', '用本地版本覆盖，丢弃仓库带来的改动。'],
        ['theirs-full', '全部采用仓库版本', '用仓库版本覆盖，丢弃本地改动。'],
        ['base', '采用 BASE 版本', '回到最近一次更新后的原始内容。'],
      ]
      return h(Modal, {
        title: '解决冲突（' + props.count + ' 个文件）',
        width: 500,
        onClose: props.onClose,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'svn-btn', onClick: props.onClose, disabled: !!props.busy }, '取消'),
          h('button', { type: 'button', className: 'svn-btn primary', onClick: () => props.onConfirm(accept), disabled: !!props.busy }, props.busy || '标记为已解决'),
        ),
      },
        options.map(([value, label, hint]) => h('label', {
          key: value,
          className: 'svn-choice' + (accept === value ? ' on' : ''),
        },
          h('input', { type: 'radio', name: 'svn-resolve', checked: accept === value, onChange: () => setAccept(value) }),
          h('div', null, h('b', null, label), h('span', null, hint)),
        )),
      )
    }

    function DirectoryPicker(props) {
      const [current, setCurrent] = useState(props.initial || '')
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [jump, setJump] = useState(props.initial || '')
      const seq = useRef(0)

      const load = useCallback(async (target) => {
        const id = seq.current + 1
        seq.current = id
        setLoading(true)
        setError('')
        try {
          const result = await api('/browse', { path: target || '' })
          if (seq.current !== id) return
          setData(result)
          setCurrent(result.current || '')
          setJump(result.current || '')
        } catch (err) {
          if (seq.current === id) setError(String((err && err.message) || err))
        } finally {
          if (seq.current === id) setLoading(false)
        }
      }, [])

      useEffect(() => { load(props.initial || '') }, [load, props.initial])

      const canPick = !!(data && data.current)
      const isWc = !!(data && data.isWc)

      return h(Modal, {
        title: '选择 SVN 工作副本目录',
        width: 720,
        onClose: props.onClose,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'svn-btn', onClick: props.onClose }, '取消'),
          h('button', {
            type: 'button',
            className: 'svn-btn primary',
            disabled: !canPick || loading || !isWc,
            title: isWc ? '' : '请进入包含 .svn 的工作副本根目录',
            onClick: () => props.onPick(data.current, true),
          }, '选择并添加'),
        ),
      },
        h('div', { className: 'svn-picker' },
          h('div', { className: 'svn-picker-path' },
            h('button', {
              type: 'button',
              className: 'svn-btn small',
              onClick: () => load(data && data.parent ? data.parent : ''),
              disabled: loading || !data || (!data.current && !data.parent),
            }, '↑ 上一级'),
            h('input', {
              className: 'svn-input grow',
              value: jump,
              placeholder: '输入路径后回车，例如 D:\\projects',
              onChange: (event) => setJump(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') load(jump.trim()) },
            }),
            h('button', { type: 'button', className: 'svn-btn small', onClick: () => load(jump.trim()), disabled: loading }, '转到'),
          ),
          data && data.roots && data.roots.length ? h('div', { className: 'svn-picker-roots' },
            data.roots.map((root) => h('button', {
              key: root.path,
              type: 'button',
              className: 'svn-chip',
              title: root.path,
              onClick: () => load(root.path),
            }, root.name)),
          ) : null,
          data && data.current
            ? h('div', { className: 'svn-hint' }, isWc
              ? '✓ 当前目录是 SVN 工作副本，可直接添加。'
              : '当前目录不是工作副本（没有 .svn）；请继续进入工作副本根目录。')
            : h('div', { className: 'svn-hint' }, '选择一个磁盘或常用目录开始；只列出文件夹，不读取文件内容。'),
          error ? h('div', { className: 'svn-errorbox', style: { margin: 0 } },
            h('span', null, error),
            h('button', { type: 'button', className: 'svn-btn small', onClick: () => load(current || '') }, '重试'),
          ) : null,
          loading ? h('div', { className: 'svn-loading', style: { flex: 'none', padding: 18 } }, h(Spinner), '读取目录…') : null,
          !loading && !error ? h('div', { className: 'svn-picker-list' },
            data && data.atRoot ? h('div', { className: 'svn-picker-empty' }, '从上方选择磁盘、用户目录或当前目录') :
            data && data.entries.length === 0 ? h('div', { className: 'svn-picker-empty' }, '这个目录下没有子目录') :
            data ? data.entries.map((entry) => h('div', {
              key: entry.path,
              className: 'svn-picker-row',
              title: entry.path,
              onClick: () => load(entry.path),
            },
              h('span', { className: 'svn-picker-icon' }, '▸'),
              h('span', { className: 'svn-path' }, entry.name),
              entry.isWc ? h('span', { className: 'svn-picker-wc' }, '.svn') : null,
              h('span', { className: 'svn-picker-spacer' }),
              entry.isWc ? h('button', {
                type: 'button',
                className: 'svn-btn small primary',
                onClick: (event) => { event.stopPropagation(); props.onPick(entry.path, true) },
              }, '选用') : null,
            )) : null,
          ) : null,
          data && data.truncated ? h('div', { className: 'svn-hint' }, '子目录过多，只显示前 800 个；可直接在上方输入路径跳转。') : null,
        ),
      )
    }

    function AddWcDialog(props) {
      const [pathInput, setPathInput] = useState('')
      const [scanRoot, setScanRoot] = useState('')
      const [candidates, setCandidates] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [pickerOpen, setPickerOpen] = useState(false)

      async function add(target) {
        setBusy('正在校验工作副本…')
        setError('')
        try {
          const data = await api('/wc/add', { path: target })
          props.onAdded(data.workingCopy.path)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      async function scan() {
        setBusy('正在扫描…')
        setError('')
        setCandidates(null)
        try {
          const data = await api('/discover', { root: scanRoot.trim() || undefined, depth: 3 })
          setCandidates(data.candidates || [])
          if (!data.candidates || !data.candidates.length) setError('没有发现新的工作副本（.svn 目录）。可以填一个更具体的目录再试。')
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      return h(Modal, {
        title: '添加工作副本',
        width: 560,
        onClose: props.onClose,
        footer: h('button', { type: 'button', className: 'svn-btn', onClick: props.onClose }, '关闭'),
      },
        h('div', { className: 'svn-hint' }, '点「浏览」逐级选择文件夹；识别到 .svn 的目录会标记为工作副本，可直接添加。也可以直接填路径或用「扫描」自动查找。'),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('input', {
            className: 'svn-input grow',
            placeholder: 'D:\\projects\\my-repo',
            value: pathInput,
            autoFocus: true,
            onChange: (event) => setPathInput(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && pathInput.trim()) add(pathInput.trim()) },
          }),
          h('button', { type: 'button', className: 'svn-btn', onClick: () => setPickerOpen(true), disabled: !!busy }, '浏览…'),
          h('button', { type: 'button', className: 'svn-btn primary', onClick: () => pathInput.trim() ? add(pathInput.trim()) : setError('请先选择目录'), disabled: !!busy }, '添加'),
        ),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 } },
          h('input', {
            className: 'svn-input grow',
            placeholder: '扫描根目录（留空 = 当前工作目录），如 D:\\projects',
            value: scanRoot,
            onChange: (event) => setScanRoot(event.target.value),
          }),
          h('button', { type: 'button', className: 'svn-btn', onClick: scan, disabled: !!busy }, '扫描'),
        ),
        busy ? h('div', { className: 'svn-hint' }, h(Spinner), ' ' + busy) : null,
        error ? h('div', { className: 'svn-errorbox', style: { margin: 0 } }, error) : null,
        candidates && candidates.length ? h('div', { className: 'svn-section' }, '发现 ' + candidates.length + ' 个工作副本') : null,
        candidates && candidates.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          candidates.map((item) => h('div', { key: item.path, className: 'svn-candidate' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { className: 'svn-path', title: item.path }, item.path),
              h('div', { className: 'svn-hint' }, (item.url || '') + ' · r' + item.revision),
            ),
            h('button', { type: 'button', className: 'svn-btn small primary', onClick: () => add(item.path), disabled: !!busy }, '添加'),
          )),
        ) : null,
        pickerOpen ? h(DirectoryPicker, {
          initial: pathInput.trim() || undefined,
          onClose: () => setPickerOpen(false),
          onPick: (selectedPath, selectedIsWc) => {
            setPathInput(selectedPath)
            setPickerOpen(false)
            if (selectedIsWc) add(selectedPath)
            else setError('所选目录不是 SVN 工作副本（没有 .svn），请继续进入工作副本根目录。')
          },
        }) : null,
      )
    }

    function SettingsDialog(props) {
      const [svnPath, setSvnPath] = useState(props.currentSvnPath || '')
      const [auto, setAuto] = useState(props.autoDiscover !== false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      async function save() {
        setBusy(true)
        setError('')
        try {
          await api('/settings', { svnPath: svnPath.trim(), autoDiscover: auto })
          props.onSaved()
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: 'SVN 设置',
        width: 520,
        onClose: props.onClose,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'svn-btn', onClick: props.onClose }, '取消'),
          h('button', { type: 'button', className: 'svn-btn primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
        ),
      },
        h('div', { className: 'svn-hint' }, 'svn.exe 留空则自动查找 TortoiseSVN 默认安装位置或 PATH。'),
        h('input', {
          className: 'svn-input',
          placeholder: 'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
          value: svnPath,
          onChange: (event) => setSvnPath(event.target.value),
        }),
        h('label', { className: 'svn-choice', style: { cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: auto, onChange: (event) => setAuto(event.target.checked) }),
          h('div', null, h('b', null, '首次打开时自动发现工作副本'), h('span', null, '扫描当前目录、用户目录与所在盘符，最多取 8 个。')),
        ),
        error ? h('div', { className: 'svn-errorbox', style: { margin: 0 } }, error) : null,
      )
    }

    //#endregion

    //#region 入口组件

    function SvnOverlay(props) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !document.querySelector('.svn-modal-back')) {
            event.stopPropagation()
            props.onClose()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [props.onClose])

      return h('div', {
        className: 'svn-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() },
      }, h(SvnApp, { initial: props.initial, onClose: props.onClose }))
    }

    function SvnHeaderButton() {
      const [open, setOpen] = useState(false)
      const [initial, setInitial] = useState(null)

      useEffect(() => {
        const check = () => { if (isHashSvn()) setOpen(true) }
        check()
        window.addEventListener('hashchange', check)
        return () => window.removeEventListener('hashchange', check)
      }, [])

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'svn-root svn-hbtn',
          title: 'SVN 版本控制（更改 / 历史 / 差异）',
          onClick: () => { setInitial(null); setOpen((value) => !value) },
        }, h('span', { className: 'svn-hbtn-dot' }), 'SVN'),
        open ? h(SvnOverlay, { initial: initial, onClose: () => setOpen(false) }) : null,
      )
    }

    function SvnTabTitle() {
      return h('span', { className: 'svn-root svn-tabtitle' }, h('i'), 'SVN')
    }

    //#endregion

    //#region 侧栏概览

    function SvnPane() {
      const [stateData, setStateData] = useState(null)
      const [stateError, setStateError] = useState('')
      const [loading, setLoading] = useState(true)
      const [wc, setWcState] = useState(() => readStorage(WC_STORAGE))
      const [status, setStatus] = useState(null)
      const [log, setLog] = useState(null)
      const [open, setOpen] = useState(false)
      const [initial, setInitial] = useState(null)
      const [busy, setBusy] = useState(false)

      const current = ((stateData && stateData.workingCopies) || []).find((item) => item.path === wc)
        || ((stateData && stateData.workingCopies) || [])[0]
        || null
      const currentPath = current ? current.path : ''

      useEffect(() => {
        let alive = true
        setLoading(true)
        api('/state').then((data) => {
          if (!alive) return
          setStateData(data)
          setStateError('')
        }).catch((err) => {
          if (alive) setStateError(String((err && err.message) || err))
        }).finally(() => {
          if (alive) setLoading(false)
        })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        if (current && current.path !== wc) {
          setWcState(current.path)
          writeStorage(WC_STORAGE, current.path)
        }
      }, [current, wc])

      useEffect(() => {
        if (!currentPath) return
        let alive = true
        setBusy(true)
        Promise.all([
          api('/status', { wc: currentPath }),
          api('/log', { wc: currentPath, limit: 5 }),
        ]).then(([statusData, logData]) => {
          if (!alive) return
          setStatus(statusData)
          setLog(logData)
        }).catch(() => {}).finally(() => {
          if (alive) setBusy(false)
        })
        return () => { alive = false }
      }, [currentPath])

      function launch(extra) {
        setInitial(extra || null)
        setOpen(true)
      }

      function selectWc(pathValue) {
        setWcState(pathValue)
        writeStorage(WC_STORAGE, pathValue)
      }

      const summary = (status && status.summary) || {}
      const entries = (status && status.entries) || []
      const recent = (log && log.entries) || []

      return h('div', { className: 'svn-root svn-pane' },
        h('div', { className: 'svn-pane-head' },
          h('div', { className: 'svn-pane-title' }, h('span', { className: 'svn-logo', style: { width: 22, height: 22, fontSize: 9, borderRadius: 6 } }, 'SVN'), '版本控制'),
          h('div', { className: 'svn-pane-actions' },
            h('button', { type: 'button', className: 'svn-icon', title: '打开完整面板', onClick: () => launch(null) }, '⤢'),
          ),
        ),

        loading ? h('div', { className: 'svn-pane-empty' }, h(Spinner), ' 加载中…') : null,
        stateError ? h('div', { className: 'svn-errorbox', style: { margin: 0 } },
          h('span', null, stateError),
          h('button', { type: 'button', className: 'svn-btn small', onClick: () => launch(null) }, '打开面板'),
        ) : null,

        !loading && !stateError && !current ? h('div', { className: 'svn-pane-empty' },
          '还没有工作副本。打开完整面板添加一个包含 .svn 的目录。',
          h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', className: 'svn-btn primary small', onClick: () => launch(null) }, '打开面板')),
        ) : null,

        current ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          (stateData.workingCopies || []).length > 1 ? h('select', {
            className: 'svn-pane-wc',
            value: currentPath,
            onChange: (event) => selectWc(event.target.value),
          }, stateData.workingCopies.map((item) => h('option', { key: item.path, value: item.path }, item.name + '  r' + (item.revision || '?')))) : null,

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h('span', { className: 'svn-dot' + (current.ok === false ? ' bad' : '') }),
            h('span', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, current.name),
            h('span', { className: 'svn-revpill', style: { marginLeft: 'auto' } }, 'r' + (current.revision || '?')),
          ),

          h('div', { className: 'svn-pane-chips' },
            [['conflicted', '冲突'], ['modified', '修改'], ['added', '新增'], ['deleted', '删除'], ['unversioned', '未纳入']]
              .filter(([key]) => summary[key])
              .map(([key, label]) => h('span', { key: key, className: 'svn-chip', style: { cursor: 'default' } }, label + ' ' + summary[key])),
            !summary.total ? h('span', { className: 'svn-muted' }, '没有本地更改') : null,
          ),

          entries.slice(0, 7).map((entry) => h('div', {
            key: entry.path,
            className: 'svn-pane-file',
            title: entry.path,
            onClick: () => launch({ diffPath: entry.path }),
          },
            h(StatusBadge, { item: entry.item }),
            h('span', { className: 'svn-path' }, entry.path),
          )),
          entries.length > 7 ? h('div', { className: 'svn-muted' }, '还有 ' + (entries.length - 7) + ' 项…') : null,

          h('div', { style: { display: 'flex', gap: 5 } },
            h('button', { type: 'button', className: 'svn-btn primary', style: { flex: 1, justifyContent: 'center' }, onClick: () => launch(null) }, '打开面板'),
            h('button', {
              type: 'button', className: 'svn-btn', title: '刷新',
              onClick: () => {
                setBusy(true)
                Promise.all([
                  api('/state'),
                  api('/status', { wc: currentPath }),
                  api('/log', { wc: currentPath, limit: 5 }),
                ]).then(([stateRes, statusRes, logRes]) => {
                  setStateData(stateRes)
                  setStatus(statusRes)
                  setLog(logRes)
                }).catch(() => {}).finally(() => setBusy(false))
              },
              disabled: busy,
            }, busy ? '…' : '⟳'),
          ),

          recent.length ? h('div', null,
            h('div', { className: 'svn-side-title', style: { marginBottom: 2 } }, '最近提交'),
            recent.map((entry) => h('div', {
              key: entry.revision,
              className: 'svn-pane-logrow',
              title: entry.message,
              onClick: () => launch({ entry: entry }),
            },
              h('span', { className: 'svn-rev' }, 'r' + entry.revision),
              h('span', { className: 'svn-pane-logmsg' }, firstLine(entry.message) || '(无提交信息)'),
              h('span', { className: 'svn-pane-logmeta' }, entry.author || ''),
            )),
          ) : null,
        ) : null,

        h('div', { className: 'svn-pane-empty', style: { marginTop: 'auto' } },
          '提交 / 更新 / 还原 / 冲突处理在完整面板里完成。',
        ),

        open ? h(SvnOverlay, { initial: initial, onClose: () => { setOpen(false); setInitial(null) } }) : null,
      )
    }

    //#endregion

    //#region 插件入口

    function apply(ctx) {
      injectCss()
      const disposers = []
      const release = () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch (err) {}
        }
      }

      try { ctx.effect(() => release) } catch (err) {}

      const register = (fn) => {
        try {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (err) {
          console.warn('[dsh-svn] 槽位注册失败：' + String((err && err.message) || err))
        }
      }

      register(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: KEY,
        inject: () => ({}),
      }, SvnPane)))

      register(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: KEY,
        inject: () => ({}),
      }, SvnTabTitle)))

      register(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: KEY + ':header',
        order: 18,
        registrant: KEY,
      }, SvnHeaderButton)))

      register(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: KEY,
        order: 80,
        label: () => 'SVN 版本控制',
        inject: () => ({}),
      }, SvnPane)))
    }

    exports.name = KEY
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
