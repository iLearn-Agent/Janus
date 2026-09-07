# Janus 员工招募体系初步框架计划

## 1. 目标与范围

本计划只建设员工招募体系的第一条完整主链路：

- 每个用户最多拥有 10 名处于在职状态的员工 Agent。
- `secretary_agent`（uBuddy）是固定系统角色，不占员工配额。
- HR、Department Leader 等治理角色不进入员工花名册。
- 新用户默认招募 `general_agent`，并自动拥有 uBuddy。
- 用户可以查看可招募 Agent、招募、停用和重新启用员工。
- 停用不删除 Agent 实例，也不删除会话、Memory、任务、Skill Overlay 或进化记录。
- 重新招募同一 Agent family 时恢复原 `user_agent_instance`。
- uBuddy 和任务调度只能从当前在职员工中选择执行 Agent。
- 本地和云端并发招募不能突破 10 人上限。

以下内容不进入第一阶段：

- P1-P10 表现等级计算。
- 人才市场版本发布和 Skill 章节采纳。
- 多 Memory、单一主会话和 relationship Memory。
- 集群进化与 cohort。
- 员工薪酬、组织层级和复杂审批流。

## 2. 核心设计原则

### 2.1 身份与雇佣状态分离

`user_agent_instances` 继续作为用户个人 Agent 的永久身份记录。

招募、停用和重新启用只改变实例的雇佣状态，禁止通过删除实例表达“离职”。这样可以保证：

- 同一 `(user_id, agent_family_id)` 始终对应同一个个人实例。
- 停用后历史会话仍可 Read。
- Memory、任务、个人 Skill Overlay 和进化记录继续引用同一个实例 ID。
- 重新启用不需要迁移或复制历史数据。

### 2.2 角色分类必须集中管理

新增统一角色分类策略，禁止 UI、Store、Scheduler 和 Cloud 各自判断角色：

| 类型 | 代表角色 | 是否进入花名册 | 是否占配额 | 是否可被 uBuddy 调度 |
|---|---|---:|---:|---:|
| `employee` | general、PPT 等执行 Agent | 是 | 是 | 在职时可调度 |
| `system` | secretary_agent / uBuddy | 否 | 否 | 负责调度，不作为普通员工节点 |
| `governance` | HR、Department Leader | 否 | 否 | 只参与治理流程 |
| `unavailable` | disabled、retired、未安装 Skill | 否 | 否 | 否 |

初始分类规则：

- `secretary_agent` 固定为 `system`。
- `general_agent` 作为新用户默认招募的 `employee`。
- HR 和 Department Leader 为 `governance`。
- 其他启用且可路由的 Agent 为可招募 `employee`。
- disabled、retired 或依赖 Skill 未安装的 Agent 为 `unavailable`。

### 2.3 配额只统计在职员工

配额统计条件：

```text
instance_kind = employee
AND employment_state = active
AND quota_exempt = false
```

停用后立即释放配额。正在执行的节点允许完成，但不再接受新节点；尚未开始的排队节点交由 uBuddy 重新规划。

## 3. 数据模型

### 3.1 扩展 agent_families

建议增加：

- `instance_kind`：`employee | system | governance | unavailable`。
- `recruitable`：是否可由用户主动招募。
- `default_for_new_user`：新用户是否默认招募。
- `quota_cost`：第一阶段仅允许 `0` 或 `1`。
- `classification_version`：角色分类策略版本。

### 3.2 扩展 user_agent_instances

建议增加：

- `instance_kind`：创建实例时固化角色类别。
- `employment_state`：`active | inactive | pending_cloud_confirmation | conflict`。
- `quota_exempt`：uBuddy 等系统实例为 `1`。
- `recruited_at`。
- `deactivated_at`。
- `last_state_changed_at`。
- `state_revision`：雇佣状态乐观锁版本。
- `recruitment_source`：`default | user | migration | cloud_reconcile`。
- `policy_version`。

保留现有 `status` 字段用于兼容，第一阶段将其视为派生字段：

- `employment_state = active` 时 `status = active`。
- `employment_state = inactive` 时 `status = inactive`。

后续稳定后再评估是否移除重复语义。

### 3.3 新增招募事件表

新增 `user_agent_recruitment_events`：

- `id`。
- `user_id`。
- `user_agent_instance_id`。
- `agent_family_id`。
- `event_type`：`recruited | deactivated | reactivated | rejected | reconciled`。
- `previous_state`、`next_state`。
- `quota_before`、`quota_after`。
- `command_id`：跨设备幂等键。
- `source_device_id`。
- `reason`。
- `metadata_json`。
- `created_at`。

唯一约束：

```text
(user_id, command_id)
```

该表只记录状态变化证据，不替代 `user_agent_instances` 当前状态。

## 4. 领域服务与 Store 接口

新增员工领域策略模块，建议位置：

```text
src/main/modules/identity/domain/employeePolicy.js
```

核心纯函数：

- `classifyAgentFamily(agent)`。
- `countsTowardEmployeeQuota(instance)`。
- `canRecruitAgent({ family, instance, quota })`。
- `canRouteEmployee(instance)`。
- `employeeQuotaSnapshot(instances, limit = 10)`。

新增 Store 方法：

- `listRecruitableAgentFamilies({ userId })`。
- `listEmployeeRoster({ userId, includeInactive })`。
- `getEmployeeQuota({ userId })`。
- `ensureSystemAgentInstances({ userId })`。
- `recruitUserAgent({ userId, agentFamilyId, commandId, sourceDeviceId })`。
- `deactivateUserAgent({ userId, agentInstanceId, commandId, reason })`。
- `reactivateUserAgent({ userId, agentInstanceId, commandId })`。
- `recordRecruitmentEvent(...)`。

招募操作必须在一个 `BEGIN IMMEDIATE` 事务中完成：

1. 检查幂等 command。
2. 读取当前配额。
3. 校验 family 可招募。
4. 拒绝第 11 名员工。
5. 创建新实例或恢复已有实例。
6. 确保 memory0 存在。
7. 写入招募事件。
8. 提交事务。

## 5. 新用户与旧用户迁移

### 5.1 新用户

创建或绑定新用户后：

- 创建 quota-exempt 的 `secretary_agent` 系统实例。
- 创建在职的 `general_agent` 员工实例，配额变为 `1/10`。
- 不为其他可路由 Agent 自动创建实例。

### 5.2 现有用户

遵循 7.23 计划，现有用户继承当前已创建的可路由 Agent：

- `secretary_agent` 迁移为 quota-exempt system 实例。
- HR、Leader 不创建或不进入花名册。
- 其他现有可路由实例迁移为 active employee。
- 历史实例 ID 不改变。

如果现有用户超过 10 名员工：

- 不自动停用任何现有员工。
- 标记为 `grandfathered_over_limit`。
- 禁止继续招募。
- 用户停用员工后逐步回落到 10 人以内。

迁移必须复用现有数据库备份和演练机制，并增加独立 rehearsal fixture。

## 6. 本地 Runtime、IPC 与公共接口

新增 Runtime API：

- `employeeOverview()`：返回 quota、roster、market、同步状态。
- `recruitEmployee(payload)`。
- `deactivateEmployee(payload)`。
- `reactivateEmployee(payload)`。

新增 IPC：

```text
employees:overview
employees:recruit
employees:deactivate
employees:reactivate
```

所有写操作必须：

- 从当前登录用户派生 `user_id`，不信任 renderer 传入用户 ID。
- 使用客户端生成的 `commandId` 保证重试幂等。
- 返回最新 quota、roster 和目标实例。
- 触发一次延迟云同步。

## 7. 云端并发与权威规则

第一阶段本地框架完成后，再接入云端权威招募命令。

云端需要保存与本地一致的：

- `instance_kind`。
- `employment_state`。
- `quota_exempt`。
- `state_revision`。
- 招募事件和 `command_id`。

云端招募事务：

1. 锁定该用户的员工花名册或配额记录。
2. 校验 command 幂等性。
3. 统计 active 且不豁免的员工。
4. 原子接受或拒绝招募。
5. 更新 canonical `user_agent_instance`。
6. 返回新的 roster revision。

跨设备同时争夺最后一个名额时，只允许一个命令成功。失败设备收到：

```json
{
  "status": "conflict",
  "code": "employee_quota_exceeded",
  "quota": { "used": 10, "limit": 10 }
}
```

客户端不得用普通 V3 upsert 静默覆盖云端雇佣状态；雇佣状态只能通过命令接口变化。

## 8. uBuddy、聊天和任务调度接入

统一增加 `activeEmployeeAgentsForUser(userId)`，替换直接使用全局 `org.agents.filter(routable)` 的路径。

必须接入：

- 无 @ 的本地团队候选池。
- 接收方 uBuddy 团队规划。
- 普通 Agent 聊天入口。
- Task graph planner 和节点落库。
- Agent 状态和队列统计。

规则：

- inactive Agent 历史会话只读可见。
- inactive Agent 不接受新聊天执行和新任务节点。
- 停用时正在运行的节点允许结束。
- 未开始的节点进入重新规划，不能继续绑定已停用员工。
- 重新启用后恢复原实例及其 Skill Overlay、Memory 和历史队列信息。

## 9. 员工页面初步 UI

侧栏增加“员工”入口，第一版只做两块：

### 我的员工

- 显示 `n/10`。
- 显示 Agent 名称、部门、Skill 摘要。
- 显示在职/停用、空闲/忙碌状态。
- 支持进入聊天、停用、重新启用。
- uBuddy 单独展示为“系统角色”，不出现在 n/10 列表中。

### 可招募 Agent

- 只显示 `recruitable = true` 且当前未在职的 family。
- 显示是否曾经招募过。
- 曾经招募过时按钮文案为“重新启用”。
- 达到 10 人时禁用招募按钮并显示配额说明。

第一版不展示 P 等级、市场版本、Skill diff 和进化历史。

## 10. 验收测试

### Store 与迁移

- 新用户得到 uBuddy 和 general Agent，配额为 `1/10`。
- HR、Leader 不出现在员工花名册。
- 第 10 名招募成功，第 11 名被拒绝。
- 停用后配额释放，所有历史记录仍存在。
- 重新启用返回原 `user_agent_instance_id`。
- 重复 command 不产生第二条状态变化。
- 现有用户实例 ID 在迁移后保持不变。
- 超过 10 人的旧用户进入 grandfathered 状态且不丢数据。

### 云端与跨设备

- 两设备同时招募不同 Agent 争夺最后名额，只成功一个。
- 同一 command 重试返回相同结果。
- 云端拒绝后本地回滚临时状态。
- 停用和重新启用在另一设备同步后结果一致。

### 调度

- uBuddy 只能选择 active employee。
- 停用员工不再获得新聊天或任务节点。
- 正在运行的节点可以完成，未开始节点被重新规划。
- 重新启用后可再次被调度。

### Renderer

- 正确显示 n/10、系统角色、在职和可招募列表。
- 配额满时招募按钮不可用。
- 停用前有确认提示。
- 招募、停用、恢复后无需重启即可刷新状态。

## 11. 分阶段实施顺序

### Phase A：初步框架

本轮首先完成：

1. `employeePolicy.js` 角色分类和配额纯函数。
2. Schema 字段与 recruitment events 表。
3. Store 的 roster、quota、recruit、deactivate、reactivate 方法。
4. 新用户默认实例策略。
5. 旧用户迁移和 rehearsal。
6. Store 级自动化测试。

Phase A 不修改现有调度行为，也不开放正式 UI，避免一次改变过多运行路径。

### Phase B：本地产品闭环

1. Runtime、IPC、preload 接口。
2. 员工页面初版。
3. 聊天与 Scheduler 只读取 active employee。
4. Renderer smoke 和 Fake Codex E2E。

### Phase C：云端并发闭环

1. 云端 Schema 和权威命令接口。
2. roster revision、幂等和配额事务。
3. 跨设备冲突处理。
4. SQLite cloud 与 PostgreSQL 契约测试。

### Phase D：稳定化

1. uBuddy 完整链路回归。
2. 本地/云端故障恢复测试。
3. 全量迁移演练。
4. Electron UI 验收。
5. 主仓库完整 `npm run check`。

## 12. Phase A 完成定义

满足以下条件才算初步框架完成：

- 数据库能够明确区分 employee、system 和 governance。
- 本地事务严格执行 10 人限制。
- 新用户默认只有 general employee 和 uBuddy system instance。
- 停用与恢复保持相同实例 ID。
- 旧用户迁移不丢失任何关联记录。
- Store 测试覆盖配额、幂等、停用恢复和 grandfathered 场景。
- `check.mjs`、architecture、contracts、migration rehearsal 和 `git diff --check` 通过。
