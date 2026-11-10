# 发布信息（GitHub / Gitee 直接复制版）

> 这是给维护者用的发布清单，不参与插件运行。创建仓库时按字段复制即可。
>
> 命名原则：仓库路径用 `dsh-svn`（与 npm 包名、DSH 插件名一致，`dsh-` 前缀利于插件市场检索）；展示名用「DSH SVN」。不建议把 `TortoiseSVN` 放进仓库名（避免商标混淆），简介里写“TortoiseSVN 风格 / inspired by”即可，并注明非官方项目。

## 1. 项目名称

| 用途 | 建议值 |
| --- | --- |
| 仓库名 / 路径 | `dsh-svn` |
| 展示名（中文） | `DSH SVN 面板` |
| 展示名（英文） | `DSH SVN` |
| npm 包名 | `dsh-svn`（已写在 `package.json`；发布前查询 npm 为未占用，上架前再确认一次） |
| 一句话 | 给 DeepSeek Harness 用的 TortoiseSVN 风格 SVN 面板 |
| 备选仓库名 | `dsh-svn-panel`、`dsh-version-control`、`deepseek-harness-svn` |

## 2. GitHub 创建字段

**Repository name**

```text
dsh-svn
```

**Description**（约 215 字符，上限 350）

```text
TortoiseSVN-style SVN panel for DeepSeek Harness (DSH): working-copy changes, commit history, revision diffs, blame, update/commit/resolve, plus 5 read-only agent tools. Windows CJK paths handled. · DSH 的 SVN 版本控制面板
```

如果希望 About 全中文：

```text
DSH 的 SVN 版本控制面板：TortoiseSVN 风格的更改 / 历史 / 差异 / blame，支持更新、提交、冲突处理，含 5 个只读 Agent 工具，已适配 Windows 中文路径。
```

**超短版（约 120 字符）**

```text
TortoiseSVN-style SVN panel for DeepSeek Harness: changes, log, diffs, blame, update/commit, 5 read-only agent tools.
```

**Topics**（16 个，逐个小写；GitHub 上限 20）

```text
dsh, dsh-plugin, deepseek-harness, deepseek, svn, subversion, tortoisesvn, version-control, vcs, blame, diff, commit-history, cordis, javascript, windows, web-ui
```

**其他选项**

| 字段 | 值 |
| --- | --- |
| Visibility | Public |
| License | MIT |
| Default branch | `main` |
| Initialize README | 不勾选（仓库里已有） |
| Add .gitignore | 不勾选（已提供） |
| Social preview | 上传 `docs/social-preview.png` |
| Website | 留空 |

## 3. Gitee 创建字段

**仓库名称**

```text
dsh-svn
```

> 想让展示名更中文，仓库名称可以填 `DSH SVN 面板`，但「仓库路径」仍建议用 `dsh-svn`，保证两个平台的 URL 与包名一致。

**仓库路径**

```text
dsh-svn
```

**项目简介（短版，推荐；≤100 字）**

```text
DeepSeek Harness 的 TortoiseSVN 风格 SVN 面板：更改、提交历史、版本差异、blame，含 5 个只读 Agent 工具。
```

**项目简介（超短版，约 35 字）**

```text
DSH 的 SVN 面板：更改、历史、差异、blame，含 5 个只读 Agent 工具。
```

**项目简介（长版，若字数限制更宽）**

```text
给 DeepSeek Harness（DSH）用的 SVN 管理插件：TortoiseSVN 风格的更改/历史/差异/blame 面板，支持多工作副本、更新/提交/冲突处理，并带 5 个只读 Agent 工具；已适配 Windows 中文路径。
```

**项目标签**（10 个）

```text
DSH, DeepSeekHarness, SVN, Subversion, TortoiseSVN, 版本控制, 差异对比, 提交历史, blame, 插件
```

**其他选项**

| 字段 | 值 |
| --- | --- |
| 是否开源 | 公开 |
| 开发语言 | JavaScript |
| 开源许可证 | MIT |
| 默认分支 | `main`（创建后到「仓库设置 → 默认分支」确认） |
| .gitignore | Node |
| README | 不勾选初始化（推送已有 README） |
| 项目封面 | 可选上传 `docs/social-preview.png` |

## 4. 首次发布 Release

**Tag**：`v0.1.0`

**Title**：`v0.1.0 · 首个可用版本`

**Release notes**（复制下面整段）

````markdown
## DSH SVN v0.1.0

DeepSeek Harness 的 TortoiseSVN 风格 SVN 面板，首个可用版本。

### 功能

- 工作副本自动发现、多副本切换，显示仓库 URL / 仓库根 / 最后提交
- 更改视图：冲突、修改、新增、删除、丢失、替换、未纳入版本控制
- 提交历史：作者 / 关键词 / 路径 / 日期过滤，分页加载更早提交
- 提交详情与单文件版本差异
- unified diff 查看器：行号、增删高亮、换行、复制
- 逐行溯源（blame），点版本号跳转该版本差异
- 更新 / 提交 / 还原 / 纳入 / 删除 / 解决冲突 / 清理
- 5 个只读 Agent 工具：`svn_info` / `svn_status` / `svn_log` / `svn_diff` / `svn_blame`
- 设置 `svn.exe` 路径、关闭自动发现
- Windows 中文路径读操作适配（全量 diff 过滤、URL 溯源、自算 unified diff）

### 安装

```bash
dsh plugin --profile desktop add link:D:\path\to\dsh-svn
```

### 已知限制

- Windows `svn.exe` 命令行不接受非 ASCII 路径参数：含中文路径的提交/还原/删除在部分场景会被拒绝并提示，请改用 TortoiseSVN；详见 README「Windows 中文路径说明」。

### 致谢

交互参考 TortoiseSVN；TortoiseSVN 是其各自权利人的商标，本项目与其无隶属关系。
````

> 注意：上面的 Release notes 用四反引号外壳包住，复制时从 `## DSH SVN v0.1.0` 开始到「致谢」结束即可；粘贴到 GitHub/Gitee 的 Release 编辑器时保留里面的 bash 代码块。

## 5. 本地初始化与推送

在 `dsh-svn` 目录执行（把 `<your-github>` / `<your-gitee>` 换成你的用户名）：

```bash
cd dsh-svn
git init
git add .
git commit -m "feat: initial dsh-svn plugin"
git branch -M main

# GitHub
git remote add origin https://github.com/<your-github>/dsh-svn.git
git push -u origin main

# Gitee（同一个本地仓库可以加第二个 remote）
git remote add gitee https://gitee.com/<your-gitee>/dsh-svn.git
git push -u gitee main
```

如果 Gitee 默认分支是 `master`，推送后到「仓库设置 → 默认分支」改成 `main`，保持两个平台一致。

## 6. 创建后的 10 分钟清单

- [ ] 两个仓库都加上 Topics / 项目标签，务必包含 `dsh-plugin`（DSH 插件市场靠这个 topic 索引）
- [ ] GitHub 上传 Social preview：`docs/social-preview.png`
- [ ] 确认 LICENSE 被识别为 MIT
- [ ] 发布 `v0.1.0` Release（两个平台都发）
- [ ] README 顶部的截图能正常显示（`docs/changes.png` 等）
- [ ] 检查 About 描述在两个平台都完整显示（Gitee 用短版）
- [ ] 如需进入 DSH 插件市场：给仓库打 `dsh-plugin` topic 后等待 dsh-plugin.org 自动索引
- [ ] 给仓库加一个简短的「非官方项目」免责声明（README 已加）

## 7. 可直接发群的宣传文案

**中文**

```text
给 DeepSeek Harness 写了个 SVN 面板：TortoiseSVN 风格的更改 / 历史 / 差异 / blame，支持更新、提交、冲突处理，还带 5 个只读 Agent 工具。已适配 Windows 中文路径。
GitHub：https://github.com/<your-github>/dsh-svn
Gitee：https://gitee.com/<your-gitee>/dsh-svn
```

**English**

```text
Built a TortoiseSVN-style SVN panel for DeepSeek Harness: working-copy changes, commit history, revision diffs, blame, update/commit/resolve, plus 5 read-only agent tools. Windows CJK paths handled.
https://github.com/<your-github>/dsh-svn
```

## 8. SEO / 检索关键词

```text
DeepSeek Harness, DSH plugin, DSH 插件, SVN client, Subversion GUI, TortoiseSVN alternative, version control, blame, diff viewer, commit history, SVN 面板, 版本控制插件, Windows SVN
```

## 9. 商标与免责声明

- 「TortoiseSVN」是 TortoiseSVN 项目的商标，本项目只是交互上参考，与其无隶属关系。
- 「DeepSeek」「DeepSeek Harness」是其各自权利人的商标；本项目是社区插件，非官方项目。
- README 与 Release notes 中已保留相应说明，发布时请勿删除。
