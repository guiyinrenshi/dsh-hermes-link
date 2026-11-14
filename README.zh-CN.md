# dsh-hermes-link

> **这是兼容性 fork。** 上游
> [`@tianbuyu-wwx/dsh-hermes-link`](https://github.com/Tianbuyu-wwx/dsh-hermes-link)
> 0.6.11 面向 dsh 0.1.5-rc.2，在 dsh 0.2.x 上派单/导入/followup 均不可用。本 fork
> （npm 包名 **`dsh-hermes-link`**）修复了 0.2.x 兼容、合并了跨机器能力并补齐部署文档。
> 变更清单见 [FORK-NOTES.md](FORK-NOTES.md)。

[![npm 版本](https://img.shields.io/npm/v/dsh-hermes-link)](https://www.npmjs.com/package/dsh-hermes-link)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue)](https://github.com/dsh-market/awesome-dsh-plugin)

> 当前版本：v0.8.6
> **Hermes Agent** 与 **DeepSeek Harness (DSH)** 的双向桥接：Hermes 通过 `POST /mcp/collab` JSON-RPC 派任务（一次性或可持续），DSH 启动子 agent 执行、返回真实测量的 token，并允许你**把任意 Hermes 会话作为原生 DSH 会话继续**。

[English](README.md) | **简体中文**

---

## 目录

- [为什么需要 dsh-hermes-link](#为什么需要-dsh-hermes-link)
- [核心特性](#核心特性)
- [快速开始（安装）](#快速开始安装)
- [架构](#架构)
- [配置](#配置)
- [安全模型](#安全模型)
- [路线图](#路线图)
- [常见问题](#常见问题)
- [许可证](#许可证)
- [相关文档](#相关文档)

---

## 为什么需要 dsh-hermes-link

Hermes 是任务编排器 —— 规划工作、选择 skill、加载知识切片。DSH 是编码运行时 —— 启动子 agent、改文件、跑 shell、调用 LLM。两端各自做得很好，问题是如何让它们**成为一个系统**，而不让任何一端的关注点污染另一端。

早期我们用三个独立插件（`hermes-foundation`、`hermes-oneshot-arbitrate`、`hermes-dispatch-bridge`）实现这套互通。三个插件已归档在 `dsh-hermes` 仓库的 `archive/hermes-legacy-2026-08-22` 标签下 —— `dsh-hermes-link` 是取代它们的**单一**插件，本仓库就是它的家。

---

## 核心特性

### Agent 通信线（Hermes → DSH）

- **`POST /mcp/collab`** —— JSON-RPC 2.0 端点，Hermes 调用
  - `dispatch_task` 支持 `mode: one-shot | continuable`，可持续子 agent 跨 DSH 重启存活（SQLite 注册表）
  - `dispatch_followup` / `dispatch_interrupt` / `dispatch_list` / `dispatch_get` / `get_dispatch`
  - **`dispatch_probe`** —— 零成本工具名校验（基于 `ctx.tools.view().restrictableNames`），避免 Hermes 烧一次 LLM 轮次才发现 skill 名拼错
- **Bearer 鉴权**（`HERMES_LINK_TOKEN` env，未设置则放行）
- **H4 amend nonce**（v0.3.6+）：amend 文件必须命名为 `<ts>-<task_id>-<nonce>.json`，nonce 在 `dispatch_task` 响应里给
- **Consult reply_secret**（v0.3.4+）：reply 文件必须命名为 `<ticket>-<secret>.json`，secret 在 consult payload 里给
- **Persona envelope**：自动注入 SOUL（v0.3.4+），`include_project_memory: true` 显式 opt-in cwd-scoped MEMORY；encoding rules 防 CJK 乱码；sentinel 字符串原样 verbatim
- **真实测量的 token**：`ctx.tokenMeter.measure(run.localAgent)` 把 `tokens_used` 写入 dispatch-result（不再为 null）
- **`GET /mcp/collab/session-stream`（v0.6.0）** —— 已开启 mirror 的 DSH 会话新事件 SSE 流（`?session_id=<sid>`，支持 `since_seq` / `timeout_ms`）
- **`GET /mcp/collab/session-mirror/status`（v0.6.0）** —— 查询单个或全部 session mirror 状态（`?session_id=<sid>`）

### 用户视图线（DSH → Hermes）

| 工具 | 用途 |
|---|---|
| `list_hermes_sessions` | 列出 Hermes 档案 dump，配合 Hermes `state.db` 元数据（title/model/cwd） |
| `import_hermes_session` | 把 Hermes 档案转成 DSH 会话 —— **侧边栏点击即可继续** |
| `load_hermes_persona` | 把 Hermes SOUL.md + config 注入当前会话（v0.2.3 起**不再读 MEMORY.md**）|
| `load_hermes_project_memory` | cwd-scoped Hermes MEMORY.md 加载（只匹配本项目的 Hermes 会话） |
| `read_hermes_memory` | 读取 Hermes 长期记忆（`memories/MEMORY.md`）与用户画像（`memories/USER.md`），只读、单文件字节上限。0.7.0 新增，用于 Hermes 在另一台机器、cwd 不重叠的跨机器场景。 |
| `hermes_dispatch` | v0.8.0 新增。把任务**交给 Hermes** 并等它回答：启动真正的 `hermes` 子代理（带 Hermes 自己的工具/记忆/规则），用 Hermes 会话保持连续（`--in <目录> --resume latest`）。方向与 `dispatch_task` 相反。 |
| `consult_hermes` | 问 Hermes 问题（文件通道 + secret 后缀回复，v0.3.4+） |
| `mirror_session_to_hermes` | 手动 mirror 当前 DSH 会话到 Hermes（含 cookie / JWT / API key / set-cookie / session_id redact，v0.2.3+） |
| `session_mirror` | v0.6.0 opt-in 自动 mirror 开关：对当前 DSH 会话 `enable` / `disable` / `status`（默认关闭，自动脱敏） |
| `hermes_inbox` / `hermes_inbox_append` | 读写共享对话记录 `~/.dsh/hermes-inbox/session.jsonl` |
| `hermes_clear_injected` | 仅审计：报告 v0.2.0 之前自动注入主 session 的轮数，建议"开新 session" |

### 后台自动

- **启动 auto-sync** 把所有 Hermes 会话导入 DSH
- **fs-watcher** 轮询 `Hermes Home/sessions/`，新 dump 自动 sync
- **导入格式兼容**：转换器同时支持 Anthropic 风格 content block 和 OpenAI 兼容 request dump（`assistant.content` 字符串 + `assistant.tool_calls[]` + `role: 'tool'` 结果），导入 DSH 时会保留 Hermes 的 AI 回复与工具调用记录
- **heartbeat**（60s）、**usage**（每任务）、**memory-suggest** 持续写入
- **amend watcher**（H4 nonce-bound）把 Hermes 的中途 amend 投递给运行中的可持续子 agent
- **session mirror** 为 v0.6.0 逐会话 opt-in：调用 `session_mirror action=enable` 后，新事件会脱敏写入 `Hermes Home/inbox/dsh/session-mirror/<sid>.jsonl`；Hermes 也可订阅 `GET /mcp/collab/session-stream?session_id=<sid>` 实时 SSE
- **Hermes Home 自动探测**：`HERMES_HOME` env → Windows `%LOCALAPPDATA%\hermes` → POSIX `~/.local/share/hermes`

### 把任务交给 Hermes（`hermes_dispatch`，v0.8.0）

桥现在是双向对称的：`dispatch_task` 是 Hermes → DSH，`hermes_dispatch` 是 DSH → Hermes：

```
hermes_dispatch(
  task        = "帮我审查这个补丁是否有 SQL 注入",
  workdir     = "/srv/project",   # 同时决定续接哪个 Hermes 会话
  resume      = "latest",         # 或会话 id/标题，或 "new"
  model       = "", provider = "", reasoning = "", toolset = "",
  timeout_ms  = 600000
)
```

它会启动一个**真正的 `hermes` 子代理**（注册为 dsh 的外部子代理 provider），
在子代理里跑 Hermes 的一次性模式（`hermes -z`），因此保留 Hermes 自己的工具、记忆、
规则与 `AGENTS.md`。连续性由 Hermes 自己的会话存储负责：同样的 `workdir` + `resume: "latest"`
就会接着上一次对话。

CLI 不在 `PATH` 时用 `config.hermesBin`（cordis patch）或 `HERMES_BIN` 指定，
否则会依次探测 `~/.local/bin/hermes`、`/usr/local/bin/hermes` 与 `PATH`。

### 安全边界

| 风险 | 缓解 | 自版本 |
|---|---|---|
| 跨项目上下文污染（Hermes 把 A 项目对话注进 DSH 的 B 项目 session） | 主 session 自动注入关闭；MEMORY 不广播；project-memory 只按 cwd 匹配 | v0.2.1 + v0.3.4 + v0.2.3 |
| 攻击者写 `amend/*` 劫持运行中的子 agent | nonce-bound 文件名 | v0.3.4 |
| 攻击者写 `consult-reply/*` 冒充 Hermes | secret-bound 文件名 | v0.3.4 |
| 派出的子 agent 拿到全 Hermes MEMORY（含所有项目笔记） | foundation 只含 SOUL；MEMORY 按 dispatch 显式 opt-in | v0.3.4 |
| Hermes state.db 被下毒指向 `C:\Windows\System32` | `isSafeCwd()` 拒 17 项系统目录 + null byte + >1024 字符 | v0.2.3 |
| Mirror 文件名 >200 字符触发 `ENAMETOOLONG` 静默失败 | sha1(12 hex) 截断 + head 拼接保唯一 | v0.2.3 |
| Mirror 泄露 cookie / set-cookie / session_id | redact regex 列表扩到 10+ 种 | v0.2.3 |
| 导入的会话 resume 不可用（`turn:0` 事件流过不了 DSH 校验） | turn 包络改从 1 起；损坏 artifact 自动删除重建 | v0.2.4 |

详见 [docs/security-model.md](docs/security-model.md)。

---

## 快速开始（安装）

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-hermes-link
# 需要固定版本时
dsh plugin --profile web add dsh-hermes-link@0.7.0
```

`dsh plugin` 实际是在 profile 目录里转发给 pnpm，因此 pnpm 支持的写法都可以用。

### 从 GitHub Release 压缩包安装（不需要访问 npm registry）

```sh
dsh plugin --profile web add \
  https://github.com/guiyinrenshi/dsh-hermes-link/releases/download/v0.7.0/dsh-hermes-link-0.7.0.tgz
```

### 从源码 checkout 安装（开发调试）

```sh
git clone https://github.com/guiyinrenshi/dsh-hermes-link.git
cd dsh-hermes-link
dsh plugin --profile web add ./packages/dsh-hermes-link
```

### 安装之后

1. 让 DSH 能找到 Hermes Home。同机部署：在 DSH 环境里设置 `HERMES_HOME`
   （例如 `HERMES_HOME=/root/.hermes`）；也可以在 cordis patch 条目里用
   `config: { hermesHome: ... }` 指定。Hermes 在另一台机器：看
   [docs/CROSS-MACHINE.md](packages/dsh-hermes-link/docs/CROSS-MACHINE.md)。
2. 重启 `dsh`。
3. 自检：

   ```sh
   npx hermes-link-doctor      # 健康基线：8 ok, 1 warn, 0 fail
   npx hermes-link-status      # 每条通道一行
   curl -s http://127.0.0.1:<dsh 端口>/mcp/collab/health
   ```

   那条 `warn` 是“暂无会话镜像”，新装时属于正常状态。

4. 可选——安装 Hermes 侧插件（`consult_hermes` 应答、Hermes 回合结束通知 DSH）：

   ```sh
   npx hermes-link-install-hermes-plugin
   hermes plugins list | grep dsh-link        # 应为 enabled
   ```

   然后重启 Hermes gateway。

5. 可选——让 Hermes 反向往 DSH 派活：在 Hermes 主机上把本机 DSH 注册成 MCP server
   （`mcp_servers.dsh-bridge`），见
   [docs/CROSS-MACHINE.md](packages/dsh-hermes-link/docs/CROSS-MACHINE.md) §C。

### 升级与卸载

```sh
dsh plugin --profile web update dsh-hermes-link
dsh plugin --profile web remove dsh-hermes-link
```

### 关于 dsh-market

市场里那张卡片仍指向原来的 scoped 包（`@tianbuyu-wwx/dsh-hermes-link`）。在登记信息
更新之前，请用上面的命令安装本 fork。

---

## 架构

```
                Hermes（编排器）
                      │
        config.yaml mcp_servers.dsh-bridge
                      ▼
        POST /mcp/collab（JSON-RPC 2.0）
        dispatch_task / followup / interrupt / list / get
        dispatch_probe / get_dispatch
                                          ┌──────────────────────────────────────┐
                                          │ dsh-hermes-link（Cordis bundle）        │
                                          │   ├─ HTTP 路由 /mcp/collab*        │
                                          │   ├─ services/                       │
                                          │   │   ├─ importer            request-dump → DSH SessionEvent[] │
                                          │   │   ├─ watcher             fs-poll Hermes Home/sessions/ │
                                          │   │   ├─ personaLoader       SOUL / MEMORY / config        │
                                          │   │   ├─ consultClient       文件通道咨询                  │
                                          │   │   ├─ outbox              D3/D6/D7 + V4 mirror（opt-in） │
│   │   ├─ sessionMirror      V4 opt-in 自动 mirror（脱敏 + SSE）  │
                                          │   │   ├─ continuations       可持续子 agent 注册表         │
                                          │   │   ├─ amendWatcher        H4 nonce-bound 投递           │
                                          │   │   ├─ audit               D4 审计 JSONL                │
                                          │   │   └─ hermes-project-memory cwd-scoped MEMORY（opt-in）  │
                                          │   └─ tools/                          │
                                          │       list_hermes_sessions / import_hermes_session         │
                                          │       load_hermes_persona / load_hermes_project_memory       │
                                          │       consult_hermes / mirror_session_to_hermes           │
│       session_mirror（enable/disable/status）                   │
                                          │       hermes_inbox / hermes_inbox_append                  │
                                          │       hermes_clear_injected                                │
                                          └──────────────────────────────────────┘
                                          │
        DSH→Hermes 文件                  v                  Hermes→DSH 文件
        ──────────────                                       ──────────────
        dispatch-result/<task_id>.json                  amend/<ts>-<task_id>-<nonce>.json
        consult/<ts>-<uuid>.json（reply_secret）        consult-reply/<ticket>-<secret>.json
        heartbeat/{ts}.json + latest.json
        usage.jsonl
        memory-suggest/<ts>.json
        session-mirror/<sid>.jsonl（opt-in via session_mirror 或 mirror_session_to_hermes）
```

见 [docs/](docs/) 看组件细节。

---

## 配置

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `HERMES_HOME` | 自动探测（Windows `%LOCALAPPDATA%\hermes`、POSIX `~/.local/share/hermes`） | Hermes 数据根 |
| `HERMES_LINK_TOKEN` | 未设置 | 设置后所有 `/mcp/collab*`（除 `/health`）要求 `Authorization: Bearer <token>` |
| `HERMES_LINK_TRUST_LEGACY` | 未设置（`0`） | 设置为 `1` 时，旧 `<ticket>.json` consult-reply 也被接受（与 v0.3.4+ `<ticket>-<secret>.json` 并行） |

---

## 安全模型

[docs/security-model.md](docs/security-model.md) 详述每层。TL;DR —— 每个跨项目通道都是显式 opt-in；每个跨进程通道都鉴权；token 不为 null、系统路径不被允许、cookie/secret 不泄露。

漏洞私下上报：本仓库的 **GitHub Security Advisories**。详见 [SECURITY.md](SECURITY.md)。

---

## 路线图

| | 项 | 状态 |
|---|---|---|
| ✅ | L1/L2/L3 三件套 → 单一 `dsh-hermes-link` | 2026-08-20 |
| ✅ | v0.1 → v0.2：双向完整 + 可持续 + amend nonce + mirror opt-in + foundation SOUL-only | 2026-08-21 |
| ✅ | v0.2.1：关闭主 session 自动注入 + `hermes_clear_injected` 审计 | 2026-08-21 |
| ✅ | v0.3.4：S1–S4 | 2026-08-21 |
| ✅ | v0.2.3：K.1–K.5 | 2026-08-22 |
| ✅ | v0.2.4：turn 包络修复 + 损坏重建 + 工具 schema 归一化 + 开源 | 2026-08-22 |
| ✅ | v0.3.5：SSE 首条事件回放修复 + 原工作区推断/迁移 + HTTP 端到端集成测试 | 2026-08-26 |
| ✅ | v0.3.6：dispatch_task continuable HTTP 500 修复 | 2026-08-26 |
| ⏭ | 反向隧道（跨机/穿墙） | 保留 |
| ⏭ | SSE 实时流 | 保留 |
| ⏭ | 文件自动轮转（session.jsonl / mirror / usage） | 建议（Hermes 侧 cron） |

---

## 常见问题

**Q：Hermes 端需要为 v0.3.4+ 升级什么？**
需要。amend nonce 和 consult reply_secret 是破坏性变更。见 [docs/hermes-upgrade-v0.3.4.md](docs/hermes-upgrade-v0.3.4.md) 与参考实现 `scripts/hermes-gateway-demo.py`。

**Q：我导入了一个 Hermes 会话，侧边栏有，但打不开。**
那是 v0.2.4 之前的 bug（`turn:0` 事件流过不了 DSH 持久化校验）—— v0.2.4 修：turn 包络从 1 起，损坏 artifact 自动删除重建。升到 v0.2.4 即可（auto-sync 会自动愈合）。

**Q：`import_hermes_session` 在 v0.2.4 之前报 "invalid output"。**
同一问题的另一面 —— v0.2.4 在工具 output schema 里补了 `firstUserSnippet` / `model` / `attach` 声明并归一化可空字段。升到 v0.2.4。
**Q：我导入的 Hermes 会话里只有我发的消息，Hermes 的 AI 回复和 tool call 都没同步。**
这是导入转换器对 OpenAI 兼容 Hermes dump（`assistant.content` 字符串 + `assistant.tool_calls[]` + `role: 'tool'` 结果）的支持缺陷，已在当前工作树修复。需要先删除已持久化的 `hermes-*` DSH 会话，再重新执行 `import_hermes_session` 或 auto-sync，即可恢复 `assistant/message`、`tool/call`、`tool/result` 事件。

**Q：`consult_hermes` 和 Hermes 自己的 consult 区别？**
两端都到 Hermes。`consult_hermes` 是 DSH 工具，DSH 用户在 session 里调用；`dispatch_task` 是 Hermes 主动发起的 agent RPC。共享文件通道协议但走不同路由（`POST /mcp/collab/consult` vs `POST /mcp/collab`）。

**Q：为什么不保持三个插件的形式？**
v0.2.0 就是为了干掉它 —— 三件套归档在 `dsh-hermes` 的 `archive/hermes-legacy-2026-08-22` 标签下。单一插件更好维护。

---

## 许可证

MIT © 2026 Tianbuyu-wwx —— 见 [LICENSE](LICENSE)。

---

## 相关文档

- [docs/security-model.md](docs/security-model.md) —— 分层安全模型
- [docs/plugin-developer-guide.md](docs/plugin-developer-guide.md) —— Hermes 端 gateway 开发指南
- [docs/plugin-install-guide.md](docs/plugin-install-guide.md) —— 三种安装路径
- [docs/dispatch-spec.md](docs/dispatch-spec.md) —— JSON-RPC 协议
- [docs/hermes-upgrade-v0.3.4.md](docs/hermes-upgrade-v0.3.4.md) —— Hermes 端 breaking change 升级指南
- [docs/delivery-v0.6.0-20260821.md](docs/delivery-v0.6.0-20260821.md) —— 历史发布说明
- [CHANGELOG.md](CHANGELOG.md) —— 版本历史
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 开发流程
- [SECURITY.md](SECURITY.md) —— 漏洞披露策略
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) —— 社区公约