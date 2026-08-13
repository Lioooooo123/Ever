# Ever V0.1 开发 Spec

状态：Approved for implementation
日期：2026-08-12
适用范围：当前 `main` 工作区中的 Ever 重构

## 1. 目标

Ever 是以 Ever Agent 为原生执行内核的持久 Coding Agent。用户只操作 Task；Session 是 Task 内部的执行检查点，不是公开的一级工作流。

V0.1 必须形成以下闭环：

```text
Reason / Plan -> Execute -> Observe -> Verify
                              |          |
                              |          +-> Done
                              +-> Repair -> 下一轮 Reason / Plan
```

Ever 继续拥有 Provider、模型、认证、流式生成、Agent Loop、工具、Session、压缩、扩展和原 TUI。Ever 只拥有 Task、Worker、lease/fencing、预算、策略、恢复、验收、验证证据和经验记录。不得增加第二套 Agent Loop、Provider 抽象或平行 Session lifecycle。

## 2. V0.1 产品不变量

1. 每次公开执行都必须创建、恢复或控制一个持久 Task。
2. `ever` 无参数时引导创建 Task，随后进入原 Ever TUI；不得创建脱离 Task 的临时 Session。
3. `--session`、`--session-id`、`--resume`、`--continue`、`--fork`、`--no-session` 和 `--export` 只允许 Ever 内部桥接，不是公开 CLI 入口。
4. Task checkpoint 只能在 settled Turn 后推进。
5. 恢复已有 checkpoint 时不得自动重放原始 goal；继续执行只能使用持久化的 continuation 决策或用户新输入。
6. Worker 交接完成的定义是：旧执行已停止、checkpoint 已落盘、lease 已释放、Worker descriptor 已退出。仅收到 abort 响应不算完成。
7. `unknown_outcome` 必须 fail closed，禁止静默重放可能已产生外部副作用的工具调用。
8. Task 完成必须通过 acceptance 与 verification gate；模型自行声称完成不构成完成。

## 3. 模块与接口

### 3.1 Task CLI 模块

接口：`handleEverCommand(args, agentDir, cwd): Promise<boolean>`。

该模块隐藏参数分类、Task 创建、Task 控制和 Ever CLI 内部桥接。调用方只需要知道返回值表示命令是否已完全处理。

行为：

- `ever`：TTY 中引导创建 Task；非 TTY 返回缺少目标错误。
- `ever <goal>`：创建前台 Task并进入 Ever TUI。
- `ever <goal> --detach --yes`：创建后台 Task并唤醒 daemon。
- `ever attach <id>`：可靠交接后恢复 checkpoint；没有 checkpoint 时才提交初始 goal。
- 公开 Session 参数：在进入 SessionManager 前拒绝。
- 所有带值选项缺值或下一项仍是 flag 时立即报错。

### 3.2 Task Run Bridge 模块

接口：`activateTaskRun(input): string[]`。

职责是将 Task 状态投影为 Ever CLI 参数，同时设置进程内 Task 上下文。它不是新的执行器。

- 新 Task：附加 durable context，并提交一次原始 goal。
- 已有 checkpoint：打开 checkpoint Session，但不提交原始 goal。
- 终态 Task：拒绝运行。

### 3.3 Worker Handoff 模块

交接接口必须等待一个可验证的退出条件，而不是依赖固定 sleep。daemon 的 stop 响应只有在 Worker 完成 runtime drain、lease 释放和 descriptor 更新后才能标记成功。超时或状态不确定时返回错误，不启动替代执行。

### 3.4 Experience 模块

Experience Record 是跨 Task 的结构化失败经验，不直接修改 Prompt、Skill 或策略。

最小字段：

- `id`、`createdAt`、`sourceTaskId`
- `failureSignature`、`contextFingerprint`
- `rootCauseCategory`
- `failedAttempts[]`
- `repairAction`
- `verificationEvidence[]`
- `status: candidate | approved | rejected`

只有通过重放 Eval 且人工批准的记录才能进入后续 Task 检索结果。原始记录不可覆盖，晋升可回滚。

## 4. 权限与安全

1. 后台 Task 的副作用工具必须运行在 sandbox，除非用户显式传入 `--unsafe-no-sandbox`。
2. 前台 Task 可以沿用 Ever 的交互式写入体验，但进入 Task 前必须有明确授权语义。
3. 所有 durable Task 的 shell 子进程默认剥离 daemon capability、Provider credential、SSH/GPG agent 等敏感环境；需要透传的变量必须进入显式 allowlist。
4. 路径授权以真实解析后的 workspace root 为准，禁止通过符号链接或相对路径逃逸。

## 5. 发布身份

Ever 对外发布面必须统一：

- CLI 与独立二进制名：`ever`
- 仓库：`Lioooooo123/Ever`
- GitHub release asset：`ever-*`
- README、安装锁、本地 release smoke、更新检查不得把用户导向 Ever 产品包

Ever workspace 包可以继续作为内部上游依赖存在；是否 fork/改名这些内部包不属于 V0.1。

## 6. 实施阶段

### Phase 1：Task-only 与可靠恢复

- 封闭公开 Session 参数。
- `ever` 无参数引导创建 Task 并复用 Ever TUI。
- checkpoint 恢复不重放 goal。
- 增加 Worker 交接屏障。
- 修复 TUI 退出 drain 回归。
- 补齐 CLI、checkpoint、attach 和 shutdown 回归测试。

验收：`npm run check`、相关定向测试、`./scripts/test.sh` 全部通过。

### Phase 2：Ever 发布面

- 统一 package metadata、install-lock、独立二进制、release assets、README、更新检查和 changelog 链接。
- 保持 Ever 内部 workspace 依赖，不批量改上游包身份。

验收：隔离目录中 Node 与 Bun 的 `ever --help`、`ever --version`、交互启动和一个真实 Prompt smoke 通过。

### Phase 3：安全默认值

- durable Task shell 环境统一清洗。
- 前台 Task 明确授权；后台 Task继续强制 sandbox。
- 增加 credential、路径逃逸和无 sandbox 的负向测试。

验收：安全测试通过，`npm audit --json` 无已知漏洞。

### Phase 4：Experience Record

- 增加 schema、SQLite 存储、失败签名生成、候选检索和人工晋升接口。
- 增加 replay Eval，验证经验能改善目标失败且不降低安全 gate。

验收：跨 Task 命中、误匹配隔离、拒绝自动晋升、回滚和 replay Eval 测试通过。

### Phase 5：文档与删除

- 以本 Spec、`EVER_PRD_V0.1.md` 和 `NATIVE_LONG_TASK_AGENT_ARCHITECTURE.md` 为事实源收敛旧文档。
- 经确认后删除无消费者的自建 Task Home、旧 attach event TUI 和过期技术规格入口。

## 7. 非目标

- 不重写 Ever Agent Loop。
- 不引入第二套 Provider、工具或 Session abstraction。
- V0.1 不开放多 subagent、schedule 或自主修改源码并发布。
- 不为未发布的数据格式盲目增加迁移；发现真实旧数据后再增加一次性、可回滚迁移。

## 8. 回滚

每个 Phase 必须独立提交。Phase 1 不改变数据库 schema；失败时可以回滚代码而不迁移数据。Phase 2 只在隔离 smoke 完成后发布。Phase 3 的权限收紧允许用户通过显式、可审计 flag 临时降级。Phase 4 使用追加表与追加记录，回滚代码不得删除 Experience 数据。
