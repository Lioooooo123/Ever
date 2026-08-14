# Durable Agent Coordination 技术规范

- 状态：Accepted
- 日期：2026-08-15
- 参考实现：Arcee NAC `6193901e0182f51da92e9d2374e7bc0d9ce92dc6`
- 相关规范：[`NATIVE_LONG_TASK_AGENT_ARCHITECTURE.md`](./NATIVE_LONG_TASK_AGENT_ARCHITECTURE.md)、[`LONG_RUNNING_CONTROL_PLANE_SPEC.md`](./LONG_RUNNING_CONTROL_PLANE_SPEC.md)

## 1. 问题

Ever 已有持久 Task、Agent、Attempt、Flow、Episode、Agent mailbox、Session mailbox 和 resident Worker，但这些能力目前沿功能入口分散：

- `/flow` 直接创建 DAG、分配 workspace 并唤醒 daemon；
- `agent_spawn`、`agent_message` 只在内部 Task run context 注册；
- 普通 Session 无法使用 Task-local Agent 协调；
- Agent 的逻辑身份、一次执行和 Session checkpoint 绑定在一起，不能安全地对同名 Agent 发起新一轮工作；
- durable Agent message 没有桥接到运行中 Session 的热 steering；
- Flow 的 `required` 只写入 delegation，结算仍按全部节点成功判断；
- Worker 必须主动调用 `agent_report` 才能产生 Episode。

具体后果是：一个研究 Agent 完成第一次工作后，如果主 Agent 要求它继续研究，Ever 要么恢复完整旧 Session，要么创建另一个无长期身份的 Agent。消息虽然已写入 SQLite，但运行中的 Agent 只能看到 pending count；而 `/flow` 提示使用 `session_message`，目标 Session 默认又没有共享 capability address。

## 2. 源码研究结论

NAC 提供了几个有价值的语义：

1. named thread 是稳定逻辑身份，每次 dispatch 创建新的 Worker Agent context；
2. 同一 thread 的成功 Episode 构成长程记忆，显式 source thread 只贡献最新成功 Episode；
3. 同一批 thread 调用可编译为临时 DAG，依赖按 wave 并发；
4. steering 先进入 durable queue，再由运行中 Agent 在下一次模型调用前领取；
5. Worker 最终响应自动写 Episode，不依赖额外工具调用。

Ever 不照搬以下限制：

- NAC Episode 是未经 schema 验证的自然语言文本；Ever 保留 typed Episode、evidence、blocker 和 acceptance result；
- NAC source Episode 直接作为 User message 注入；Ever 必须 bounded、标记 untrusted，并冻结上下文 manifest；
- NAC 没有 external-effect journal；Ever 继续以 `unknown_outcome` 阻止不确定副作用重放；
- NAC DAG 只存在于一次 tool-call batch；Ever Flow 继续持久化并可恢复。

## 3. 决策摘要

新增深模块 `DurableCoordination`。普通 Session、后台 Task Worker 和 `/flow` 共享同一个外部 Interface；Flow 只是把 DAG 批量编译成 Agent Dispatch，不拥有 Session、消息、Episode、workspace 或 daemon 生命周期。

模块公开四个动作：

```ts
interface DurableCoordination {
	submit(command: CoordinationSubmission): Promise<SubmissionReceipt>;
	send(message: CoordinationMessage): Promise<MessageReceipt>;
	inbox(request: InboxRequest): Promise<InboxPage>;
	snapshot(ref?: CoordinationRef): Promise<CoordinationSnapshot>;
}
```

调用方只需要理解四个领域对象：

- `Agent`：Task 内稳定的、有名字的逻辑工作线程；
- `Dispatch`：交给 Agent 的一次工作，拥有独立 lifecycle；
- `Episode`：一次 Dispatch 的持久、结构化结果；
- `Message`：先持久化、再尽力热投递的 Agent 间消息。

SQLite、Session checkpoint、daemon、resident Worker、lease、workspace、context manifest 和 Episode finalization 全部保持模块局部性。

## 4. 接口

### 4.1 Submit

```ts
type CoordinationSubmission =
	| {
			type: "spawn";
			name: string;
			action: string;
			role: string;
			acceptance: AcceptanceCriterion[];
			paths: string[];
			allowedTools: string[];
			workspaceMode: WorkspaceMode;
			budget: Budget;
	  }
	| {
			type: "dispatch";
			agent: string;
			action: string;
			sourceAgents?: string[];
	  }
	| {
			type: "flow";
			definition: FlowDefinition;
	  };
```

`spawn` 原子创建 stable Agent 和首个 Dispatch。重名时必须返回确定性错误并给出已有 Agent ID，不能静默复用。

`dispatch` 给现有 Agent 排队新工作。同一 Agent 的 Dispatch 串行执行；不同 Agent 可并行。

`flow` 必须先完整验证 DAG、scope、budget 和 required 语义，再在单事务内创建节点 Agent 和首个 Dispatch，不能留下半张图。

### 4.2 Send

```ts
interface CoordinationMessage {
	recipient: string;
	body: string;
	type: "message" | "steering" | "handoff";
	priority: "normal" | "high";
	artifactRefs: string[];
	dedupeKey: string;
}
```

`send` 先 durable enqueue，再调用 live-delivery Adapter。daemon 或 Worker 不可达时仍返回 queued receipt，消息不能丢失。

### 4.3 Inbox 与 Snapshot

`inbox` 负责 claim 和 acknowledge Task-local Agent messages。跨无共同 Task 的独立 Session 继续使用 capability-based `session_message`，两种信任边界不得混用。

`snapshot` 返回 stable Agent、active/queued Dispatch、Episode、message delivery state 和 Flow projection。它是观察接口，不暴露 SQL row 或 daemon process 细节。

## 5. 持久模型

### 5.1 Agent

现有 `agents` 表作为 stable identity。新增约束：

- `(task_id, name)` 唯一；
- terminal execution state 不再表示 Agent 永久不可用；
- 同一 Agent 同时最多一个 running Dispatch；
- `active_session_id` 只是当前 Dispatch 的投影，不是长期上下文身份。

### 5.2 Dispatch

新增 `agent_dispatches`：

```text
id, task_id, agent_id, sequence, action,
state, context_manifest_json, context_manifest_sha256,
session_id, episode_id, created_at, started_at, settled_at
```

状态：

```text
queued -> running -> finalizing -> completed
                         |-> completed_unaccepted
queued/running/finalizing -> failed | cancelled | unknown_outcome
```

每个 Dispatch 使用新的 Session。只有同一 Dispatch 的崩溃恢复才允许使用该 Dispatch 的 checkpoint。新的 Dispatch 禁止恢复前一 Dispatch 的完整 transcript。

`attempts` 和 `checkpoints` 必须关联 `dispatch_id`。旧数据迁移时为每个现存 Agent 创建一个 legacy Dispatch，并把现有 Attempt/checkpoint 归入该 Dispatch。

### 5.3 Context manifest

Dispatch 创建时冻结：

- 当前 action；
- 同一 Agent 最新的 bounded completed Episode；
- 每个显式 source Agent 最新的 bounded completed Episode；
- policy、workspace 和 source Episode identity/hash。

Worker 启动时只能读取冻结的 manifest，不能重新查询“最新”数据。Episode 作为 untrusted structured handoff 注入，字段内容不能提升权限或改变 system policy。

### 5.4 Episode

Episode 增加唯一 `dispatch_id`、原始最终响应 artifact reference、context/session identity。一个 Dispatch 最多一个 terminal Episode。

终局顺序：

```text
Session final result durable
-> workspace/change bundle capture
-> Episode compile
-> Episode durable commit
-> acceptance evaluation
-> Dispatch terminal CAS
-> Agent idle 或下一 queued Dispatch runnable
-> Flow projection settle
```

如果 Worker 已调用 terminal `agent_report`，compiler 复用其结构化内容；否则以最终响应生成 bounded summary，并保存原始响应 artifact。compiler 或 Episode commit 失败时 Dispatch 保持 `finalizing`，不得无 Episode 完成。

### 5.5 Message delivery

消息状态：

```text
queued -> delivered -> model_visible -> acknowledged
```

顺序不变量：

1. SQLite enqueue commit；
2. 如果存在 active Session，尝试 resident Worker steer；
3. Session 将消息写入自身 durable transcript 后标记 delivered；
4. provider projection 确实包含消息时标记 model_visible；
5. 该 turn settled 后自动 acknowledge。

第一阶段若 runtime 尚不能证明 `model_visible`，只能报告 `queued` 或 `delivered`，不得把 daemon 接受请求冒充模型已读。

## 6. Flow Adapter

Flow 节点引用 stable Agent 的首个 Dispatch。Flow 不直接创建或恢复 Session。

`required` 必须持久化到 `flow_nodes`。依赖仍是 hard dependency：任何前驱未成功完成，其下游均不得启动。

所有节点 terminal 后：

- 所有 required 节点 completed：Flow completed；
- 任一 required 节点 failed、skipped、cancelled 或 completed_unaccepted：Flow failed；
- optional 节点自身失败不直接令 Flow failed；
- optional 节点失败导致 required descendant 被 skip 时，Flow failed。

`/flow` 的工具集合固定为 `flow_define`、`flow_status`、`agent_message`、`agent_inbox`、`task_update`。不得提示用 capability-based `session_message` 代替 Task-local 通信。

## 7. 普通 Session Adapter

Coordination tools 必须始终注册，调用时才解析 actor：

1. 后台 Task Worker 从 `TaskRunContext` 取得 Task/Agent；
2. 已附着 durable Goal/Flow 的交互 Session 使用该 Task 的 main Agent；
3. 无 Task 的普通 Session 第一次显式 `agent_spawn` 时创建 session-scoped coordination Task，并持久化 Session 到 Task 的映射；普通 prompt 本身不隐式创建 Task。

后台 Agent 能否调用某个 coordination tool 仍由 Agent tool policy 决定。工具存在不等于获得权限。

## 8. 内部 Adapter

```ts
interface SessionRunnerAdapter {
	start(dispatch: PreparedDispatch): Promise<SessionHandle>;
	steer(sessionId: string, message: DurableMessage): Promise<DeliveryReceipt>;
	stop(sessionId: string): Promise<void>;
}

interface WorkspaceAdapter {
	prepare(input: WorkspacePreparation): Promise<PreparedWorkspace>;
	capture(input: WorkspaceCapture): Promise<ChangeBundle>;
}
```

- `CoordinationStoreAdapter`：生产和测试都使用 SQLite；这是 local-substitutable dependency，不扩大公共 Interface。
- `SessionRunnerAdapter`：生产使用 daemon + resident Worker，测试使用 deterministic fake。
- `WorkspaceAdapter`：生产使用 Git worktree/snapshot，测试使用临时 Git repository。
- Episode compiler 先保持确定性内部实现；只有出现第二种真实实现时再抽象 Adapter。

## 9. Workspace 语义

- `read_only_shared` Agent 可共享 canonical workspace，只产生研究 Episode；
- `isolated_worktree` 归 stable Agent，不归某个 Dispatch；后续 Dispatch 复用并重新 snapshot/hash；
- 并行可写 siblings 禁止共享同一 worktree；
- Flow 下游修改节点启动前，应按稳定 node key 顺序组合所有 accepted predecessor change bundle；冲突在 Worker 启动前产生 failure Episode。

前驱 patch 合成属于完整设计，但不是本次第一阶段完成声明的一部分；在实现前，Flow 的可写依赖链必须显式标记为 unsupported，不能让下游在错误代码基线上继续。

## 10. 崩溃与幂等

- submit、send、terminal Episode 以调用方 operation/dedupe key 幂等；
- stale Session/Attempt 的完成事件必须由 `dispatch_id` CAS 拒绝；
- daemon wake/steer 发生在事务提交后；
- Worker crash 恢复同一 Dispatch checkpoint，不创建新的 Dispatch；
- 外部副作用结果未知时 Dispatch 进入 `unknown_outcome`；
- Episode 已提交但终态未提交时，恢复过程重用同一 Episode 并完成 CAS；
- live steer 失败时消息保留 queued，恢复后重放；
- 不允许 live delivery 成功而 SQLite 中不存在消息。

## 11. 第一阶段实现范围

本规范的首个 PR 必须作为一个完整 vertical slice 交付：

1. stable Agent / fresh Dispatch / dispatch-bound checkpoint；
2. `agent_dispatch` 和 bounded retained Episode context；
3. durable-first Agent message 到 resident Worker steer 的桥接；
4.普通 Session actor resolution 和 coordination tool 注册；
5. terminal Episode 自动提交或确定性 finalizing；
6. Flow required 持久化和结算；
7. `/flow` 改为调用共享 Module 并使用 Agent messaging；
8. migrations、focused tests、daemon/Worker smoke 和 event correlation。

如果其中任一项无法在同一 PR 达到可恢复的状态，必须缩减公开入口，而不是提交会丢消息、复用错误 Session 或错误解锁 DAG 的半实现。

## 12. 验证标准

- 同名 Agent 连续两个 Dispatch 得到不同 Session ID；第二个只看到 frozen Episode context，不看到第一个完整 transcript；
- 同一 Dispatch Worker 崩溃后恢复原 checkpoint，不产生第二个 Dispatch；
- running Agent 收到消息时先有 durable row，随后 resident Session 被 steer；daemon 不可用时 row 保留 queued；
- 重复 dedupe key 不产生第二条消息、Dispatch 或 Episode；
- Worker 未调用 `agent_report` 也有 terminal Episode；
- optional Flow node 失败且没有 required descendant 时 Flow 可 completed；required node 失败或被 skip 时 Flow failed；
- 普通 Session 可使用 `agent_spawn`、`agent_dispatch`、`agent_message`、`agent_inbox`；
- 跨 Task Agent message 仍被拒绝，独立 Session messaging 仍要求 capability；
- 每条事件可关联 task、agent、dispatch，并在适用时关联 session、attempt、message、episode、flow/node；
- `npm run check`、所有修改过的 focused tests 和 faux-provider runtime smoke 通过。

## 13. 非目标

- subagent 再递归 spawn subagent；
- 跨主机 exactly-once delivery；
- 把 Session transcript 复制进 Task Store；
- 用模型摘要替代 typed Episode；
- 远端 HTTP transport；
- 自动把多个可写 Agent change bundle promotion 到 main。
