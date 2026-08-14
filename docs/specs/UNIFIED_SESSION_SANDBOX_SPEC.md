# Ever 统一 Session Sandbox 技术规范

- 状态：Implemented（阶段一、二、三已落地；阶段四发布门槛 eval 见下）
- 版本：0.1
- 日期：2026-08-15
- 关联规范：[SMALL_MODEL_JUDGE_AUTHORIZATION_SPEC.md](./SMALL_MODEL_JUDGE_AUTHORIZATION_SPEC.md)、[UNIFIED_GOAL_SANDBOX_PERMISSION_SPEC.md](./UNIFIED_GOAL_SANDBOX_PERMISSION_SPEC.md)、[LONG_RUNNING_CONTROL_PLANE_SPEC.md](./LONG_RUNNING_CONTROL_PLANE_SPEC.md)、[NATIVE_LONG_TASK_AGENT_ARCHITECTURE.md](./NATIVE_LONG_TASK_AGENT_ARCHITECTURE.md)
- 目标读者：Ever 维护者、实现工程师、安全评审者

## 1. 决策摘要

Ever 只有一种执行宿主：所有 Session（普通交互、`/goal` Task、后台 Worker）都运行在同一个 sandboxed Session Execution Host 里。沙盒是进程级的 OS 机械遏制（`sandbox-exec`/`bubblewrap`），其 profile（网络白名单 + 写路径）由当前 Session 的 permission grants 推导。

Small Model Judge 只对"已被沙盒机械遏制"的低风险命令自动放行。普通 `ever` 会话从启动即进沙盒，`/goal` 无需任何特殊沙盒处理（自动继承）。`--unsafe-no-sandbox`（或新增 `--no-sandbox`）是显式逃生口。

关键机制（来自 `@anthropic-ai/sandbox-runtime`）：

- 网络是 allow-only，且由**宿主侧代理**在**请求时**读配置裁决，因此 `updateConfig()` 可以**热更新**已运行进程的网络白名单，无需重启。
- 文件系统写是 allow-only，由 seatbelt/bubblewrap profile 在 exec 时固化，扩展开需要重建 profile 并重启进程。

## 2. 背景与开源参照

Claude Code / `@anthropic-ai/sandbox-runtime`（Anthropic 工程博客《Beyond Permission Prompts》）的两层模型：

1. **OS sandbox = 机械遏制**：套住整个进程树。文件系统读 deny-only、写 allow-only；网络 allow-only，经宿主侧 HTTP/SOCKS 代理过滤。
2. **Permission = 语义授权**：push/publish/deploy 等"沙盒关不住"的动作，才需要权限系统裁决。

博客的核心结论：不再靠每条命令弹窗，而是用沙盒先把 agent 机械地关起来；关起来之后，低风险操作就能安全地自动放行（Judge），只有语义动作才问人。这正是规范里"没有 sandbox 时 Judge disabled"的原因。

Ever 之前的问题：

- 前台 Session 裸跑（无沙盒）→ `sandboxAvailable=false` → Judge 被禁用 → 每个非白名单命令都弹人工确认。
- 后台 Worker 有沙盒 → Judge 正常。
- Phase C 只把 `ever run`/`attach`/`new`/`home` 显式入口重挂沙盒；`/goal`（普通会话内的默认入口）仍然裸跑，是最大的残留缺口。

## 3. 领域模型

| 概念 | 含义 |
| --- | --- |
| **Session** | 唯一执行单元。普通交互、`/goal` Task、后台 Worker 都是 Session 的运行阶段 |
| **Session Execution Host** | 唯一进程级沙盒宿主。负责初始化 `SandboxManager`、wrap 进程、管理代理 |
| **Sandbox Profile** | `{ allowedDomains, writableRoots, allowPty }`，由 Session 的活动 grants 推导 |
| **Permission Grant** | 授权记录，归属从 task 作用域扩展到 workspace/session 作用域 |
| **Judge** | Small Model Judge，只对沙盒已机械遏制、低风险、可恢复、精确匹配的命令产生 `allow_once` |

## 4. 架构

```
ever（bare）────────┐
ever run <goal> ────┤
ever attach/home/new ┤
                    ▼
        Session Execution Host（宿主进程，常驻持有代理）
                    │ wrapWithSandbox(exec-time)
                    ▼
        sandboxed Session 进程（seatbelt/bubblewrap，进程树受控）
                    │
   ┌────────────────┼────────────────┐
   │                │                │
 普通工作        /goal 建 Task     模型请求
   │                │                │
 命令被沙盒机械遏制 自动继承沙盒    经白名单代理出网
   │                │
 Judge 对低风险可恢复命令 allow_once（不弹窗）
   │
 访问未授权域名/写路径
   │
 权限内核 ask 一次 → grant 落库
   │
 网络：宿主 updateConfig()（热更新，无需重启）
 写路径：profile 重推导 → reinitialize → checkpoint 后重启
```

要点：

1. **一个启动路径、一个沙盒**。前台与后台是同一个 Session Execution Host，`/goal` 不引入第二种沙盒处理。
2. **沙盒是进程级不变式**，`sandboxAvailable` 由 startup envelope 的 `executionEnvironment.trust === "sandboxed"` 推导，权限内核与工具执行之间无需额外协调。
3. **网络热更新**：代理在请求时读配置，宿主 `updateConfig()` 即可放行新域名，已运行的 Session 进程不用重启。
4. **写路径扩展是冷操作**：seatbelt profile 在 exec 时固化，扩展开需要 profile 重推导 → 重建沙盒 → 在 settled checkpoint 上重启，与后台 Worker 语义一致。

## 5. 具体改动

### C1：bare `ever` 也走 re-exec 沙盒

把 `foreground-sandbox.ts` 的触发点从"显式 Task 命令"扩展到"普通 Session 启动"。

- `main.ts` 在创建 runtime 前判定：若进程未 sandbox、sandbox 可用、且未传 `--unsafe-no-sandbox`/`--no-sandbox`，则 re-exec 进 `SessionExecutionHost`，通过 startup envelope 传入 `executionEnvironment`。
- 普通 Session 由此获得 `sandboxAvailable=true`，`ForegroundPermissionLifecycle` 与 `NativeLongTaskAgent` 现有的 `getWorkerStartupIfLoaded()` 推导**无需改动**。

### C2：grant 归属从 task 作用域扩展到 workspace/session 作用域

现在 `PermissionGrantRecord.taskId` 必填，普通 Session 没有 Task 可挂 grant。

- `taskId` 改为可选；`once`/`attempt`/`task` lifetime 仍要求 taskId，`workspace`/`project_policy` lifetime 以 `workspaceFingerprint` 为一级键，可无 taskId。
- 新增 `session` lifetime（本次 Session 有效，进程退出即失效），供普通会话的临时网络授权使用；`workspace` lifetime 跨 Session 复用。
- 迁移：`008_task_authorizations.sql` 之后新增 `011_permission_grant_task_optional.sql`，`task_id` 列改为可空，`workspace_fingerprint` 保持非空。

### C3：前台沙盒 profile 重推导 + 热更新

- `UnattendedSandbox` 新增 `updateAllowedDomains(domains)`：读 `SandboxManager.getConfig()`，替换 `network.allowedDomains` 后 `updateConfig()`。
- `SessionExecutionHost` 暴露 `updateProfile(profile)`：网络走 `updateAllowedDomains`（热更新），写路径走 `reinitialize`（冷操作）。
- 前台宿主进程通过一个轻量 IPC 通道（复用 worker 的 fd 3 / 或新增一条 unix socket）接收子进程的 profile 更新请求。

### C4：`/goal` 继承沙盒，无需特殊处理

bare `ever` 已 sandbox 后，`/goal` 在已 sandbox 的 Session 进程内 `DurableGoalRuntime.start()` 建 Task 并 adopt，`sandboxAvailable` 自然为 true。删除此前"前台 Task 需要重挂"的任何分支。

### C5：权限内核的 profile 扩展语义统一

- `sandbox_profile_expansion_required` 的 ask 结果（`task`/`workspace`/`session` lifetime）→ grant 落库 → 宿主 `updateProfile`。
- 网络扩展：热更新，当前 Attempt 继续执行。
- 写路径扩展：`reinitialize` + settled checkpoint 重启（与规范 §15.5 一致）。

## 6. 网络与文件系统扩展语义

| 扩展类型 | 机制 | 是否重启 | 备注 |
| --- | --- | --- | --- |
| 新域名（network） | 宿主 `updateConfig()`，代理请求时读配置 | 否 | ASRT 已支持，热更新 |
| 新写路径（filesystem write） | profile 重推导 → `reinitialize` → checkpoint 后重启 | 是 | seatbelt profile 固化于 exec |
| 读限制（denyRead） | 启动 profile 固化 | 是 | 默认 deny 敏感文件（.ssh/.aws/auth.json），不动态放开 |

## 7. 故障语义

| 故障 | 行为 |
| --- | --- |
| sandbox 不可用（平台/依赖） | 前台回退裸跑，`sandboxAvailable=false`，Judge disabled，逐条人工确认（fail-closed） |
| 前台 re-exec 失败（凭据/启动） | 回退裸跑 + stderr warning，不阻塞 Session 启动 |
| `updateConfig()` 失败 | 网络保持原白名单，命令失败并提示，不自动放行 |
| 写路径 reinitialize 失败 | 拒绝本次扩展，不进入 unsafe host 自动执行 |
| 宿主进程退出 | 子进程网络代理随之消失，命令网络失败（fail-closed，不会裸奔） |
| grant 落库失败 | 工具不执行，不自动放行 |

## 8. 非目标

- 不提供 `unrestricted` / "永远允许 Bash" 模式（`--unsafe-no-sandbox` 是显式裸跑逃生口，且裸跑时 Judge 仍 disabled）。
- 不让 Judge 代替 OS sandbox；无 sandbox 时不自动放行 process/external side effect。
- 不在一次宽泛指令里授权所有域名/路径。
- 不为普通 Session 引入第二种权限引擎或状态机；Session 仍是唯一执行内核。

## 9. 分阶段实施

### 阶段一：统一前台沙盒（已实现）

- C1：bare `ever` re-exec 沙盒（`foreground-sandbox.ts` + `main.ts`）。
- C4：`/goal` 继承（验证无需改 `/goal` 路径）。
- 默认 profile 为 `{ allowPty: true }`；startup envelope 携带完整 credential map。

### 阶段二：grant 作用域扩展（已实现）

- C2：`taskId` 可选 + `session` lifetime + `session_id` 列 + 迁移 `011_permission_grant_session_scope.sql`。
- 普通 Session 的域名授权可落库（`session`/`workspace`），`ForegroundPermissionLifecycle` 接入 grant store。

### 阶段三：热更新（已实现，前台）

- C3：`UnattendedSandbox.updateAllowedDomains` 通过 `SandboxManager.updateConfig` 热更新；前台宿主/子进程通过 fd 4 控制通道传递 `updateAllowedDomains`。
- 权限内核在 `sandbox_profile_expansion_required` 授权后同步更新运行时域名集合并发送控制请求。
- 写路径扩展（`reinitialize` + checkpoint 重启）与后台 Worker 的域扩展仍为后续项。

### 阶段四：发布门槛 eval（部分）

- 新增 `permission-eval.test.ts`：对抗语料 false allow = 0 + 良性意图自动处理率 ≥90%。
- 完整 §22 门禁（P95 延迟、成本占比、SQLite integrity、无未结算 reservation）仍需接入固定 Eval 工作负载。

## 10. 开放问题

1. **普通 Session 的默认网络起点**：是 provider 域名起步（现状），还是放宽到常见包注册源（registry.npmjs.org / pypi.org / 等）以降低装包摩擦？倾向后者可配置，但需要产品决策。
2. **宿主/子进程 IPC 形态**：复用 worker 的 fd 3 startup envelope 之外，需要一条常驻的 profile 更新通道；是复用 daemon 的 unix socket 模式，还是前台走一条新的轻量 pipe，待定。
3. **`session` lifetime 的撤销时机**：进程退出即失效是否需要持久化"上次 Session 的临时授权"供下次 `--resume` 复用，还是彻底不持久，待定。
4. **`--no-sandbox` 与 `--unsafe-no-sandbox` 的关系**：目前只有 `--unsafe-no-sandbox`（面向 unattended/daemon）；普通 Session 的裸跑逃生口是复用该旗标还是新增一个更贴切的 `--no-sandbox`，待定。
