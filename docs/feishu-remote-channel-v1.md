# Janus 飞书远程通道第一版方案

> 文档状态：评审稿 v0.1
>
> 更新时间：2026-08-04
>
> 目标读者：项目负责人、技术评审人、客户端与后端开发者

## 1. 一句话说明

为 Janus 增加一个飞书机器人入口：当用户的电脑正在运行 Janus 任务时，用户可以在手机飞书中查看进度、追加要求、取消任务、回答 Agent 提问，并在任务完成后收到通知和结果摘要。

第一版不开发新的手机 App，也不要求部署公网业务服务器。Janus 桌面端通过飞书官方 WebSocket 长连接主动连接飞书，任务仍然在用户自己的电脑和项目目录中执行。

## 2. 背景与问题

目前 Janus 的任务主要在桌面端操作。长任务运行期间，用户离开电脑后存在几个明显问题：

- 无法方便地确认任务是否还在运行、卡在什么阶段。
- Agent 请求审批或补充信息时，用户不能及时处理。
- 用户临时想到新的要求时，不能从手机追加到原任务。
- 任务完成或失败后，用户不能及时收到通知。
- 如果为此单独开发手机 App，会增加开发、发布、审核和维护成本。

飞书已经提供成熟的消息、机器人、卡片和移动端通知能力，因此更合适的做法是让飞书成为 Janus 的一个远程交互通道，而不是重新做一套移动端。

## 3. 第一版目标

第一版需要完成以下闭环：

1. 用户在 Janus 中配置自己的飞书企业自建应用。
2. 用户通过一次性绑定码，将飞书账号绑定到当前 Janus 用户和 Workspace。
3. 用户在飞书中查看正在运行、等待输入、排队和最近完成的任务。
4. 用户订阅某个任务，持续看到经过压缩的实时进度。
5. 用户回复任务消息，向同一个 Janus Session 追加 prompt。
6. 如果当前 Codex turn 仍在运行，新 prompt 进入队列，当前轮结束后自动继续执行。
7. 用户可以取消当前任务、回答 Agent 的补充问题和处理命令审批。
8. 任务完成、失败、取消或等待用户输入时，飞书主动通知用户。
9. Janus 或网络短暂中断后，连接能够恢复，已接收的远程指令不重复、不丢失。

## 4. 第一版不做什么

为控制范围，第一版暂不包含：

- 不开发独立手机 App。
- 不上架飞书应用市场。
- 不支持一个群内多名用户共同操作同一个 Janus Workspace。
- 不支持同一个飞书应用同时控制多台 Janus 设备。
- 不支持把新 prompt 强行注入正在运行的 Codex turn。
- 不向飞书完整发送 Codex 原始协议、内部推理、隐藏 prompt 或完整 shell 日志。
- 不通过飞书浏览用户电脑中的任意目录。
- 不默认发送项目源码、环境变量或包含敏感信息的 diff。

第一版的“运行中追加要求”定义为：把要求可靠地加入同一 Session 的后续执行队列，而不是修改当前已经开始的模型请求。

## 5. 推荐产品形态

采用“用户自带飞书应用”的方式：

- 用户或用户所在企业在飞书开放平台创建企业自建应用。
- 用户在 Janus 设置页填写该应用的 App ID 和 App Secret。
- Janus 通过飞书官方 SDK 建立 WebSocket 长连接。
- 飞书消息直接进入用户电脑上的 Janus main process。
- Janus 执行结果再通过飞书开放接口发送给用户。

这种方式的优点：

- 不需要 Janus 团队维护多租户飞书服务。
- 不需要公网 IP、域名或内网穿透。
- 不需要第一版就经过飞书应用市场审核。
- 项目文件和 Agent 执行继续留在用户本机。
- 企业管理员可以自行控制机器人权限和可用范围。

代价是用户需要完成一次飞书应用配置，因此 Janus 应提供清晰的图文向导、连接测试和错误诊断。

## 6. 总体架构

```text
┌─────────────────────────────┐
│          飞书客户端          │
│  消息 / 回复 / 卡片 / 通知   │
└──────────────┬──────────────┘
               │ 飞书开放平台
               │ WebSocket + OpenAPI
┌──────────────▼──────────────┐
│       Feishu Adapter         │
│ 鉴权、消息解析、卡片、重连、限流 │
└──────────────┬──────────────┘
               │ 标准化远程事件
┌──────────────▼──────────────┐
│     Janus Remote Gateway    │
│ 绑定、权限、路由、队列、幂等、审计 │
└───────┬───────────┬─────────┘
        │           │
        │           └──────────────┐
┌───────▼─────────┐        ┌───────▼──────────┐
│ Runtime Event Hub│        │ Remote Local Store│
│ Chat/Task 事件汇总│        │ 绑定、队列、Outbox │
└───────┬─────────┘        └──────────────────┘
        │
┌───────▼────────────────────┐
│        Janus Runtime       │
│ Session / Task / Codex / DB │
└───────┬────────────────────┘
        │
┌───────▼────────────────────┐
│ 用户本机项目目录与 Codex 执行 │
└────────────────────────────┘
```

### 6.1 设计原则

- 飞书只是一个输入输出通道，不重新实现 Janus 的任务系统。
- 飞书适配器不直接启动 Codex CLI，只调用 Janus Runtime。
- renderer 和飞书共享同一个 Runtime 事件源。
- 所有远程操作都必须经过 Janus 用户、Workspace 和任务权限检查。
- 收到飞书事件后先快速确认和入队，不能阻塞等待 Codex 执行完成。
- 外发内容先经过隐私过滤和摘要处理。

## 7. 主要模块

建议新增以下模块：

```text
src/main/modules/remoteChannels/
├── application/
│   ├── remoteChannelService.js
│   ├── remoteCommandRouter.js
│   ├── remotePromptQueue.js
│   └── remoteEventPresenter.js
├── domain/
│   ├── remoteBinding.js
│   ├── remoteChannelPolicy.js
│   └── remoteCommand.js
└── infrastructure/
    ├── feishu/
    │   ├── feishuAdapter.js
    │   ├── feishuCards.js
    │   └── feishuMessageParser.js
    └── remoteChannelStore.js
```

各模块职责：

| 模块 | 职责 |
| --- | --- |
| `remoteChannelService` | 管理启动、停止、连接状态、重连和应用生命周期 |
| `remoteCommandRouter` | 把飞书消息转换为查看任务、追加要求、取消、审批等 Runtime 操作 |
| `remotePromptQueue` | 保证同一 Session 的远程 prompt 有序、幂等、可恢复 |
| `remoteEventPresenter` | 将大量底层事件压缩成适合手机阅读的任务状态 |
| `feishuAdapter` | 封装飞书官方 SDK、收发消息、卡片、附件和连接状态 |
| `remoteChannelStore` | 保存本机绑定、命令队列、消息投递和审计状态 |

## 8. Janus Runtime 改造点

### 8.1 Runtime Event Hub

当前 Chat 的实时事件主要通过调用方传入的 `onEvent` 回调发送给 renderer。为了让由桌面端发起的任务也能被飞书观察，需要增加内部事件总线。

建议统一事件结构：

```js
{
  eventId,
  runId,
  sessionId,
  taskRunId,
  userId,
  workspaceId,
  kind,
  stage,
  occurredAt,
  payload
}
```

事件消费者包括：

- Electron renderer。
- 飞书 Remote Gateway。
- 桌面系统通知。
- 后续可能增加的其他通信通道。

事件总线应发布经过结构化的运行事件，但是否允许外发由 Remote Gateway 再判断。

### 8.2 远程运行状态接口

建议增加受控 Runtime API：

```js
listRemoteVisibleRuns({ userId, workspaceId })
remoteRunStatus({ userId, workspaceId, runId })
enqueueSessionPrompt({ userId, workspaceId, sessionId, message })
cancelRemoteRun({ userId, workspaceId, runId })
resolveRemoteApproval({ userId, workspaceId, runId, approvalId, approved })
resolveRemoteUserInput({ userId, workspaceId, runId, requestId, answers })
```

这些接口不能返回 AbortController、内部 callback、系统 prompt、Memory 原文或 Codex 隐藏状态。

### 8.3 复用现有能力

Janus 当前已经具备：

- Chat 运行事件输出。
- Task 状态更新。
- 当前运行取消。
- 命令批准或拒绝。
- Agent 补充问题回答。
- Session 与消息持久化。

第一版主要工作不是重写这些能力，而是建立统一事件出口、远程权限层和可靠的后续 prompt 队列。

## 9. 飞书应用配置

用户需要在飞书开放平台完成：

1. 创建企业自建应用。
2. 开启机器人能力。
3. 获取 App ID 和 App Secret。
4. 将事件订阅方式设置为长连接。
5. 订阅 `im.message.receive_v1`。
6. 如使用卡片按钮，订阅 `card.action.trigger`。
7. 申请机器人发送消息和接收单聊消息所需的最小权限。
8. 发布应用版本并由企业管理员批准安装。
9. 在飞书中找到机器人并发起单聊。

第一版接入官方 Node SDK：

```text
@larksuiteoapi/node-sdk
```

优先使用 SDK 的 Channel 模块，它已经提供：

- WebSocket 建连和自动重连。
- 消息格式归一化。
- 消息去重、过期过滤和会话串行处理。
- 用户及群组策略。
- 文本、Markdown、卡片和附件发送。
- 流式卡片更新。
- 卡片交互事件。

权限名称和卡片长连接能力需要在实际飞书租户中做一次完整 smoke test，因为飞书开放平台文档与 SDK 新版能力可能存在更新时间差异。

## 10. 用户绑定流程

```text
Janus 设置页生成一次性绑定码
             │
             ▼
用户在飞书中发送“绑定 843921”
             │
             ▼
Janus 校验绑定码、飞书用户和当前本机账户
             │
             ▼
绑定 飞书 open_id → Janus user/workspace/device
             │
             ▼
飞书和 Janus 同时显示绑定成功
```

绑定记录至少包含：

- 飞书应用和租户标识。
- 飞书用户 `open_id`。
- 飞书单聊 `chat_id`。
- Janus `user_id`。
- Janus `workspace_id`。
- 当前 Janus `device_id`。
- 权限范围和启用状态。

绑定安全要求：

- 绑定码只保存哈希。
- 默认 5 分钟失效。
- 限制错误尝试次数。
- 使用后立即失效。
- 不允许一个飞书用户静默覆盖已有 Janus 用户绑定。
- 设置页支持立即解绑和撤销全部远程权限。

## 11. 飞书交互设计

### 11.1 基础命令

第一版尽量支持自然中文，同时保留明确命令：

| 输入 | 行为 |
| --- | --- |
| `帮助` | 显示可用操作 |
| `任务` | 查看正在运行和最近任务 |
| `状态` | 查看当前订阅任务状态 |
| `队列` | 查看当前 Session 的待执行补充要求 |
| `取消` | 取消当前订阅任务，需要二次确认 |
| `解绑` | 解除当前飞书账号绑定 |
| 回复任务消息 | 将文本追加到对应 Session |

### 11.2 任务状态卡片

```text
Janus 正在处理

任务：生成客户调研报告
状态：正在分析来源
Agent：Research Agent
耗时：04:12
最近活动：整理第 4 个来源
文件变更：2 个
补充要求队列：1 条

[追加要求] [取消任务]
[处理审批] [停止订阅]
```

卡片更新策略：

- 相同内容不重复更新。
- 普通进度最多每 1～2 秒更新一次。
- 心跳状态每 15～30 秒更新一次。
- 完成、失败、取消、等待审批和等待输入立即更新。
- 卡片更新失败时降级为普通文本。
- 不把每个 shell 输出单独发送成新消息。

### 11.3 追加要求

用户回复任务状态消息：

```text
补充一下，报告最后增加一页风险与后续建议。
```

系统根据被回复消息的 `message_id`、`root_id` 或 `thread_id` 定位目标任务和 Session。

如果当前轮正在运行：

```text
补充要求已加入队列，将在当前轮完成后继续执行。
当前队列位置：1
```

如果 Session 空闲，则立即启动下一轮。

### 11.4 审批与补充问题

理想状态使用飞书卡片按钮：

```text
Janus 请求执行命令

命令：npm install @larksuiteoapi/node-sdk
目录：当前项目目录
原因：安装飞书官方 SDK

[仅批准本次] [拒绝]
```

如果真实租户验证发现长连接不能稳定接收卡片操作，则第一版降级为一次性文字 nonce：

```text
批准 A7K2
拒绝 A7K2
```

nonce 必须短时有效、一次性使用，并绑定到飞书用户、运行 ID 和审批请求 ID。

## 12. Prompt 队列与幂等

远程指令状态机：

```text
received → validated → queued → running
                                  ├→ completed
                                  ├→ failed
                                  ├→ cancelled
                                  └→ interrupted
```

规则：

- 以飞书事件 ID 或 `message_id` 作为幂等键。
- 重复收到同一事件时返回之前的处理结果，不能重复执行 prompt。
- 同一 Session 默认严格串行。
- 当前 turn 结束后才领取下一条 prompt。
- Janus 关闭时保留 `queued` 项。
- 崩溃恢复后，不自动重跑状态不明确的 `running` 项。
- 未确认完成的 `running` 项转为 `interrupted`，由用户决定是否重试。
- “取消当前轮”和“取消并清空队列”必须是两个不同动作。

## 13. 本地数据库影响记录

第一版预计新增以下本机 SQLite 表：

| 表 | 用途 |
| --- | --- |
| `remote_channel_configs` | 保存飞书连接配置、启用状态和加密凭据 |
| `remote_channel_bindings` | 保存飞书用户与 Janus 用户、Workspace、设备的绑定 |
| `remote_commands` | 保存远程 prompt、取消、审批等命令及处理状态 |
| `remote_delivery_outbox` | 保存待发送或待更新的飞书消息，用于断线重试 |

### 13.1 兼容边界

- 仅新增本地 SQLite 表。
- 不修改现有用户、Workspace、Session、Message、Task、Memory、附件和执行记录的标识。
- 不新增云端 PostgreSQL 表。
- 不新增 Cloud Sync 实体。
- 不改变 Sync payload 语义。
- 不要求提高 Sync 协议版本。
- 远程通道数据默认只属于当前设备。

### 13.2 唯一键与冲突策略

- 飞书事件 ID 必须唯一，避免重复执行。
- `provider + tenant_key + open_id + device_id` 绑定唯一。
- 飞书消息或话题到 Janus Session 的活动映射必须唯一且可审计。
- 出现绑定冲突时拒绝新绑定并提示用户，不静默覆盖或合并。
- 解绑采用失效状态，保留必要的命令审计记录。
- 不使用可能吞掉用户数据的 `INSERT OR IGNORE`。

### 13.3 数据保全要求

迁移前后必须保持：

- 现有 Session ID、状态和主 Session 约束不变。
- 消息 ID、角色、内容和创建时间不变。
- Memory、附件、任务、模型执行和文件引用数量不减少。
- `PRAGMA integrity_check = ok`。
- `PRAGMA foreign_key_check` 无结果。
- 迁移第二次执行后库存完全一致。

新增迁移需要在数据库迁移注册表中声明，并先在 shadow copy 上预演。预演失败时不得修改活动数据库，也不得推进 Cloud Sync cursor。

### 13.4 恢复和降级

- 老版本 Janus 可以忽略新增表，不能删除这些表。
- 全新数据库或仅从云端恢复后，用户需要重新配置和绑定飞书。
- 数据库 quarantine 恢复应保留本地飞书配置，但凭据无法解密时必须停用通道并要求重新配置。
- 未投递的 outbox 和 queued 命令应随本地数据库恢复。
- 不提供破坏性降级迁移。

## 14. 凭据与隐私安全

### 14.1 App Secret

- App Secret 只在 Electron main process 中使用。
- 数据库只能保存密文。
- renderer 只能提交新 Secret，不能读取明文 Secret。
- 日志、诊断包和错误报告必须脱敏。
- 使用 Electron `safeStorage` 或系统钥匙串。
- Linux 系统密钥存储不可用时应停止启用远程通道，不能降级为明文。

### 14.2 远程消息内容

默认不向飞书发送：

- 系统 prompt 和 Agent 隐藏指令。
- Memory 原文。
- 模型内部推理内容。
- 环境变量和认证信息。
- 用户电脑绝对路径。
- 完整 shell 输出。
- 未经用户确认的源码和文件 diff。

任务状态使用概括性描述，例如“正在运行测试”“修改了 2 个文件”，详细内容需要用户在 Janus 桌面端查看。

### 14.3 远程权限

第一版远程账号默认拥有：

- 查看自己绑定 Workspace 中的任务。
- 追加 prompt。
- 取消自己可访问的任务。
- 回答 Agent 提问。
- 对明确展示的单次命令进行批准或拒绝。

第一版不允许：

- 通过飞书传入任意绝对路径。
- 切换到未绑定 Workspace。
- 操作其他 Janus 用户的任务。
- 修改全局 Codex 配置。
- 开启永久全权限或绕过所有审批。

## 15. 多设备限制

飞书长连接采用集群消费模式。同一个飞书应用如果有多个客户端同时连接，事件可能随机发送给其中一个客户端，而不是广播给所有客户端。

因此第一版规定：

- 一个飞书应用只绑定一台 Janus 主执行设备。
- 状态卡片显示当前执行设备名称。
- 第二台设备使用相同凭据时不自动启用通道。
- 用户可以在原设备解绑后迁移到新设备。

如果以后需要真正多设备，应增加云端 Relay，由服务端统一接收飞书消息并路由到正确设备。这不属于第一版范围。

## 16. 桌面生命周期

- 用户关闭窗口后，可以选择让 Janus 留在系统托盘继续运行。
- 只有用户明确启用“后台接收飞书消息”后才保持长连接。
- 系统休眠期间远程能力暂停，唤醒后自动重连并刷新任务状态。
- 网络切换后自动检查 WebSocket 状态。
- 应用退出时停止领取新命令，但保留 queued 和 outbox。
- 不遗留独立 Node 进程、watcher 或孤儿连接。
- 应用权限被撤销、Secret 失效或机器人被停用时，立即停止远程命令执行并在设置页显示原因。

## 17. 开发阶段

### 阶段 A：技术验证

- 接入飞书官方 Node SDK。
- 完成长连接建连、断线重连和退出清理。
- 接收单聊消息并发送回复。
- 验证 `im.message.receive_v1`。
- 在真实租户验证 `card.action.trigger` 是否可以通过长连接稳定接收。
- 验证 Electron 打包后的 Windows、macOS 网络连接。

预估：2～3 个工程日。

### 阶段 B：最小闭环 MVP

- 设置页配置 App ID/Secret。
- 一次性账号绑定。
- 查看任务和订阅任务。
- Runtime Event Hub。
- 状态文本或卡片更新。
- 同 Session prompt 队列。
- 取消、文字审批、Agent 问题回答。
- 基础幂等和错误提示。

预估：5～8 个工程日。

### 阶段 C：可靠性与交付

- durable outbox。
- 崩溃恢复和 interrupted 状态处理。
- 系统托盘、休眠唤醒、网络切换。
- 卡片按钮与附件。
- 隐私过滤和诊断页面。
- SQLite 历史升级、shadow preflight 和恢复验证。
- Codex 全链路 E2E。

预估：4～7 个工程日。

整体第一版预计约 2～3 周，具体取决于飞书卡片长连接验证结果和现有任务事件是否需要较大范围重构。

## 18. 验收标准

第一版达到以下条件可视为完成：

1. 用户无需公网域名即可完成飞书接入。
2. 未绑定用户无法查看或控制任何 Janus 任务。
3. 桌面端发起的任务可以在飞书中看到进度。
4. 远程追加的 prompt 在同一 Session 中按顺序执行。
5. 飞书事件重复投递不会重复执行 prompt。
6. 网络中断后能够自动重连。
7. Janus 重启后 queued prompt 和待发送通知仍然存在。
8. 命令审批不能被其他飞书用户或过期 nonce 冒用。
9. 飞书消息中不泄露系统 prompt、Memory、凭据和本地绝对路径。
10. 新数据库迁移不改变或丢失现有 Session、Message、Task、Memory、附件和执行记录。
11. Windows 和 macOS 打包版本至少完成一次真实飞书租户 smoke test。

## 19. 主要风险与应对

| 风险 | 影响 | 应对方案 |
| --- | --- | --- |
| 卡片按钮长连接能力在不同租户表现不一致 | 审批按钮不能使用 | 保留一次性文字 nonce 方案；技术验证阶段优先确认 |
| 同一应用多设备同时连接 | 消息被随机设备消费 | 第一版限制单主设备 |
| 飞书事件重复或延迟 | prompt 重复执行或顺序混乱 | 使用事件 ID 幂等、Session 串行队列和 stale 检查 |
| Janus 退出或电脑休眠 | 无法远程控制 | 托盘后台运行、唤醒重连、明确在线状态 |
| 飞书消息泄露项目隐私 | 用户数据风险 | 默认摘要、隐私过滤、最小权限、附件显式确认 |
| App Secret 明文保存 | 应用被接管 | `safeStorage`/钥匙串、main process 隔离、失败关闭 |
| 当前 turn 不支持热注入 | 用户认为追加消息立即生效 | UI 明确显示“已排队，将在当前轮后执行” |
| 数据库升级影响现有用户数据 | 升级失败或数据损坏 | 只新增本地表、shadow preflight、历史升级矩阵和库存校验 |

## 20. 建议优先确认的决策

希望评审阶段优先确认以下问题：

1. 是否接受第一版采用“用户自建飞书应用”，而不是统一 Janus 飞书应用？
2. 是否接受第一版只支持飞书单聊和单主设备？
3. 是否接受“追加 prompt”先采用当前轮结束后的串行队列，而不是热注入？
4. 第一版是否需要卡片按钮，还是文字审批即可交付？
5. 第一版是否需要发送生成文件，还是只发送结果摘要并提示回桌面查看？
6. 是否需要 Windows 和 macOS 同期支持，还是先完成一个平台的技术验证？

## 21. 推荐结论

建议批准进入技术验证阶段，采用以下最小决策组合：

- 飞书企业自建应用。
- 用户自带 App ID/Secret。
- WebSocket 长连接，不部署公网 webhook。
- 第一版只做飞书单聊。
- 一个飞书应用绑定一台主执行设备。
- 运行进度使用节流更新的状态卡片。
- 新 prompt 使用同 Session 持久化串行队列。
- 审批优先验证卡片按钮，同时保留文字 nonce 降级方案。
- 所有远程数据默认只保存在本机，不进入 Cloud Sync。

该方案能够以较小的新增基础设施成本验证远程使用需求，同时保持 Janus 的 local-first、安全边界和后续扩展空间。

## 22. 参考资料

- 飞书官方 Node SDK：<https://github.com/larksuite/node-sdk>
- OpenCode Telegram Bot：<https://github.com/grinev/opencode-telegram-bot>
- OpenCode Telegram Bot（多 Session/SSE 思路）：<https://github.com/artickc/opencode-telegram-bot>
- Discord Claude Code Bot：<https://github.com/fredchu/discord-claude-code-bot>
- OpenClaw Gateway/Channel 架构：<https://github.com/openclaw/openclaw>
- Janus 数据库演进规范：[`docs/database-evolution-policy.md`](./database-evolution-policy.md)
