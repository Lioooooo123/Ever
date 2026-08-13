# Ever 产品需求文档 V0.1

> 状态：Draft
>
> 版本：0.1
>
> 日期：2026-08-12
>
> 产品阶段：问题验证与单用户 MVP

## 1. 产品决策

Ever 不与 Claude Code、Codex 或其他通用 Coding Agent 竞争“谁更会写代码”。V0.1 基于 Ever 做成一个原生的可靠任务产品，专门承接用户希望交出去、不想持续盯守的本地仓库任务。

一句话定位：

> Ever 是可以放心离开的本地异步 Coding Worker。它在预算与期限内完成仓库任务，遇到中断可以恢复，最后用可验证证据交付。

品牌表达：

- 中文 Slogan：放心离开，回来验收。
- English Slogan: Leave it running. Come back to proof.
- 产品描述：`Your repo's night shift.`
- 核心交付物：Verified Change Bundle，可验证变更包。

“夜班”是用户心智，不是固定在夜间执行的技术规则。Ever 应在用户允许的截止时间内寻找更低成本的执行窗口和模型路径，而不是假设所有 Provider 都有昼夜电价。

## 2. 为什么现在做

通用 Coding Agent 已经能理解代码、修改文件、运行测试。Codex 也已提供 `/goal`，支持长时间目标、后台工作和恢复。仅仅强调“能跑很久”已不构成差异。

仍未被稳定解决的是交付可靠性：

- 终端关闭、进程崩溃或上下文压缩后，任务是否知道自己做到哪里。
- 写文件、推送、发布等操作结果不明时，是否会重复执行副作用。
- 用户离开后，Agent 是否真的完成了预先约定的验收，而不是只说“完成了”。
- 用户能否用预算和截止时间约束任务，并看见实际成本与节省来源。
- Task 能否与 Ever Session 生命周期解耦，不因 Session 中断而丢失预算、证据与审计记录。

Ever 不替代最强 Coding Agent。V0.1 先把 Ever 变成可托付的异步 Worker。

## 3. 目标用户

### 3.1 首要用户

- 资深独立开发者、开源维护者、小型团队技术负责人。
- 经常执行 30 分钟到数小时的仓库级重构、迁移、依赖升级和测试修复。
- 希望代码留在本机，并保留模型和 Provider 选择权。
- 对失败恢复、预算和可验收交付有明确要求。

### 3.2 次要用户

- Coding Agent 评测与基础设施团队。
- 需要结构化任务、预算、事件、恢复记录和验收证据来评测 Agent。

### 3.3 暂不服务

- 主要需求是短时交互式 Pair Programming 的普通用户。
- 需要跨设备云端协作、RBAC、SSO 和集中控制台的企业客户。
- 只关心单次回答价格，不关心任务完成质量和返工成本的用户。

## 4. 核心工作任务

当用户把一个较大的代码任务交给 Agent 后，他希望：

1. 关闭终端后任务仍能安全继续。
2. 崩溃后从已知边界恢复，不重复危险操作。
3. 在预算和期限内选择合适的执行路径。
4. 最终用预先声明的验收命令、变更摘要和证据完成交付。
5. Ever Session 即使中断，也不改变上层 Task、预算、验收与交付心智。

用户购买的不是 checkpoint、lease 或事件表。用户购买的是少盯守、少返工、少事故和可验收。

## 5. 产品原则

### 5.1 Task 高于 Session

Task 是持久业务实体，Session 只是 Task 的一次执行记录。Ever 不提供脱离 Task 的临时聊天入口，Session 丢失不能等于 Task 丢失。

### 5.2 完成必须由独立信号证明

模型声明完成不等于任务完成。最终状态必须由主机侧验收命令、文件证据和退出状态共同决定。

### 5.3 不确定结果不自动重放

如果某个有副作用的工具调用已经发出，但结果不明，Task 必须进入人工确认或专门恢复路径，不得直接再执行一次。

### 5.4 Ever 是原生执行底座

Ever 直接深化 Ever Agent。Ever 继续负责 Agent Loop、Provider、模型、工具、Session、compaction、Extension 和 Eval；Ever 负责持久 Task、Worker、预算、策略、恢复、验收和交付物。V0.1 不增加 `AgentBackend`、`ProviderGateway` 或第二套生命周期协议。

### 5.5 成本优化服从质量与安全

`economy` 模式可以延迟、使用低优先级服务、缓存、便宜模型或本地算力，但不得绕过验收、隐私策略和副作用保护。

### 5.6 长程执行就是产品本身

长程任务不再是可开关的 Extension。Ever 的所有执行入口都创建或操作持久 Task，不能通过配置退回普通 transient Session。用户 Extension 仍可提供工具、Prompt 和资源，但不能负责 Task 持久化、安全策略、预算或完成状态。

## 6. V0.1 价值主张

用户输入：

```bash
ever run "升级依赖并修复测试" \
  --economy \
  --deadline "tomorrow 08:00" \
  --budget 3 \
  --verify "npm run check"
```

Ever 应完成以下闭环：

1. 检查仓库、工作树、权限、沙箱、预算和验收命令。
2. 创建持久 Task，并冻结一次 Attempt 的 Ever Runtime 与成本策略。
3. 在后台执行，用户可以关闭终端。
4. 用户通过 `status` 查看进度，通过 `attach` 持续观察和转向，通过 `stop` 安全停止。
5. Worker 崩溃后从 settled checkpoint 恢复。
6. 执行预登记验收，不接受模型自报成功。
7. 生成 Verified Change Bundle。

## 7. V0.1 范围

### 7.1 P0 必须交付

#### 单一黄金路径

- 一个本地 Git 仓库。
- 一个主 Agent。
- 一个活跃 Attempt。
- 只使用 Ever Native Backend。
- 四个主要命令：`run`、`status`、`attach`、`stop`。
- `ever <goal>` 创建、启动并附着一个持久 Task。
- 不带目标的 `ever` 打开 Task 创建和管理界面。
- `--print`、JSON 和 RPC 入口也必须运行在 Task 语义内，并返回 Task ID。

#### 可靠执行

- Task 持久化到本地 SQLite。
- 启动前完成沙箱能力检查，不允许提交后静默暂停。
- 进程退出后可恢复到最后一个 settled checkpoint。
- 工具执行前持久化 intent，并等待写入成功后才允许副作用发生。
- wall time、turn 和成本预算均由主机侧强制执行。
- 对不确定副作用进入 `unknown_outcome`，禁止自动重放。

#### 可验收交付

- `--verify` 是写任务的默认要求。
- 验收命令在隔离、可审计的主机侧运行。
- EvidenceRef 必须可解引用，并与真实文件、命令结果或提交对象对应。
- 只有验收通过才能进入 `completed`。

#### 成本策略

用户只面对三种模式：

- `fast`：优先完成速度，仍受预算上限约束。
- `balanced`：在成本、质量和时延之间平衡，默认模式。
- `economy`：在截止时间允许范围内优先降低成本。

V0.1 支持 BYOK，并记录 Provider 返回的真实 usage。成本优化可以使用当前 Provider 已公开支持的低优先级处理、缓存和模型选择。顺序依赖的 Agent 工具循环不使用 Batch API；Batch 只用于可以并行的评审、分析和验收工作。

#### Verified Change Bundle

每个成功任务输出：

- 目标和约束快照。
- 变更文件和 Git diff 摘要。
- 验收命令、退出码和日志引用。
- 风险、未解决项和人工确认记录。
- Attempt、Backend 和 Runtime 快照。
- 实际成本、基准估算、缓存命中、低优先级处理和回退记录。

### 7.2 P1 验证后开发

- Ever Provider Gateway 的 BYOK 多 Provider 路由。
- 按任务类型拆分便宜模型与高质量模型的固定路由计划。
- 本地模型作为低风险分析和预处理节点。
- 成本报表、Provider 故障回退和价格快照。

### 7.3 明确不做

- 不在 V0.1 同时开发多 Agent 协作。
- 不把 Cron、事件调度和 OS Service 当作发布卖点。
- 不自动 merge、push、deploy 或发布。
- 不开发 Codex CLI 或 Claude Code CLI Backend。
- 不保留普通 transient Session 入口或 `longTasks.enabled` 功能开关。
- 不让内置 Extension 承担长程任务的正确性。
- 不在没有商业协议与计费能力前转售第三方 API。
- 不做新的基础模型。

## 8. 执行底座策略

### 8.1 原生职责

- Ever Native Runtime：负责完整 Coding Agent 循环、Provider 认证与调用、模型目录、工具执行、Session、compaction、Extension 和 Eval。
- Ever Task Runtime：负责 Task、Attempt、Worker、lease、预算、策略、恢复、Acceptance 和 Verified Change Bundle。

Ever Task Runtime 通过 Ever 原生 awaited lifecycle seam 约束执行，不在 Ever 外围转发或镜像 Agent Loop。多 Provider 自动路由属于 P1，并实现为 Ever Models 与 Provider 上的策略。

### 8.2 发布顺序

1. V0.1：深化 Ever Native Runtime，打通可靠执行闭环。
2. 后续：完善 BYOK Provider 路由、成本优化与真实 usage 账本。
3. 商业阶段：在具备商业协议的 Provider 上推出 Ever Managed Provider。

每个 Attempt 启动后固定 Ever Runtime、路由计划和能力快照。运行中不得更换运行时或越过冻结的 Provider 路径。

## 9. 成本产品与盈利方向

### 9.1 V0.1：先证明节省价值

- 用户使用自己的 API Key。
- Ever 提供预算控制、真实成本账本和节省报告。
- 不从 Token 差价中盈利。
- 目标是证明用户愿意因为“更便宜地完成同一任务”改变工作流。

### 9.2 商业化第一层：可靠执行订阅

可收费能力包括：

- 长任务恢复与安全策略。
- 高级验收模板和变更包归档。
- 成本报表、路由策略和预算自动化。
- 团队策略、共享 Runner、审计导出和支持。

收费理由是节省盯守与返工，而不是单纯封装 CLI。

### 9.3 商业化第二层：Ever Managed Provider

Ever 统一采购或接入经过商业授权的推理能力，向用户提供额度：

- 根据期限、质量、隐私和预算选择 Provider、模型与服务等级。
- 通过缓存、低优先级处理、批量工作和承诺用量降低单位成本。
- 收入来自明确的服务费、路由费或与用户共享后的节省，不依赖不透明加价。

上线前必须具备：

- Provider 商业协议允许转售或代计费。
- 价格、税务、退款、配额和余额账本。
- 隐私、数据保留、地区路由和用户授权机制。
- 滥用防护、限流、风控和毛利压力测试。
- 用户可以查看真实 usage、路由原因和 Ever 收费。

因此 Managed Provider 是明确的盈利方向，但不是 V0.1 已交付能力。

## 10. 关键用户体验

### 10.1 首次运行

目标：从安装到第一个成功 Task 少于 10 分钟。

启动前必须一次性展示：

- 将修改哪个仓库和工作树。
- 使用哪个 Backend、Provider 和模型策略。
- 最大预算、截止时间和验收命令。
- 是否允许无人值守写入。
- 缺少沙箱或验收时的明确修复方法。

### 10.2 离开期间

`status` 只显示用户需要决策的信息：当前阶段、最近证据、已花费预算、预计完成时间、是否需要人工介入。

`attach` 必须持续输出新事件并接受转向，不是一次性 JSON 快照。

### 10.3 回来验收

完成页首先回答四个问题：

1. 改了什么。
2. 验证是否通过。
3. 花了多少，节省了多少。
4. 还有什么风险需要人处理。

## 11. 成功指标

V0.1 使用 10 至 15 名目标用户和至少 30 个真实仓库任务验证。

### 11.1 产品门槛

- 首次安装到首个成功 Task 的中位数小于 10 分钟。
- 至少 60% 的任务无需人工重启即可通过预登记验收。
- 注入 Worker 崩溃后，至少 95% 回到正确 checkpoint。
- 高风险副作用重复执行次数为 0。
- 相比直接使用普通 CLI，人工盯守时间中位数下降至少 50%。
- 至少 40% 的测试用户在两周内主动运行第二个任务。

### 11.2 成本门槛

- 100% 成功任务可展示来自 Provider 的 usage 或明确标记为不可获得。
- `economy` 任务相对同 Backend 的 `balanced` 基线，中位成本下降目标为 25%。
- 成本下降不能让验收通过率相对下降超过 10 个百分点。
- 每次路由回退都必须可解释并记录。

这些是 V0.1 的 go/no-go 门槛，不是当前已达到的结果。

## 12. 发布验收

V0.1 只有同时满足以下条件才可对外称为“可放心离开”：

1. 默认写任务不会因缺少沙箱而提交后静默暂停。
2. wall time、turn 和成本预算都经过自动化测试证明可强制执行。
3. 任意写工具在 intent 持久化前都不能产生副作用。
4. crash recovery 测试证明 settled 工具不会重复执行。
5. EvidenceRef 可解引用，验收失败时不能完成 Task。
6. `attach` 能持续跟随事件并接受控制命令。
7. Verified Change Bundle 能从持久化记录重建。
8. 文案明确区分已支持 Backend、实验 Backend 和计划能力。

## 13. 主要风险与应对

### 用户并不愿意等待

应对：同时保留 `fast`、`balanced` 和 `economy`，用真实任务测试等待时间是否能换来足够成本下降。

### Ever Runtime 缺少可靠性钩子

应对：把 intent 持久化、预算和验收做成 NativeLongTaskAgent 的同步必经路径。无法证明 intent 先于副作用时，不允许无人值守高风险写入。

### 成本优化降低完成率

应对：质量底线与验收优先。成本路由只能在预授权路径中选择，失败后按预算决定是否升级模型或服务等级。

### Managed Provider 毛利不稳定

应对：先做 BYOK 成本报告验证路由价值，再谈采购和转售。所有价格表按版本保存，禁止用未核实的“夜间价格”做承诺。

### 产品范围再次膨胀

应对：在黄金路径指标达标前，不把多 Agent、调度平台和企业控制台列为 P0。

## 14. 当前事实与外部依据

- OpenAI Flex processing 以更慢响应和偶发资源不可用换取更低成本，Batch API 适合 24 小时内完成的异步批处理并提供折扣。两者都应按能力使用，不能被描述为固定夜间电价。[Flex processing](https://platform.openai.com/docs/guides/flex-processing)、[Batch API](https://platform.openai.com/docs/guides/batch)
