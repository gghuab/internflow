# 决策评价策略目录

InternFlow 不使用跨领域“万能总分”。共享层只统一记录格式：决策类型、策略版本、结果、置信度、Gate、领域信号、理由、证据和安全约束。每个策略只解释自己的问题，分数不可跨策略比较。

## 共享约束

1. `gate` 表达事实或安全不变量，失败时不能被分数覆盖。
2. `assessment` 表达领域价值判断，可以有自己的分数、权重和门槛。
3. `constraint` 只保护资源和格式；触发裁剪不等于内容没有价值。
4. 每条评价必须包含 `policyId`、`policyVersion`、中文理由和证据引用数组。
5. 策略结果改变时升级版本，并用黄金夹具回放；禁止通过调整其他领域的分数掩盖失败。

## 策略总览

| Policy | 类型 | 所属模块 | 结果 |
|---|---|---|---|
| `capture.coverage@1.0.0` | gate | Workday | accept / degrade / reject |
| `work.identity@1.0.0` | assessment | WorkItem | new / merge |
| `work.relevance@1.0.0` | gate | WorkItem | include / exclude |
| `work.goal@1.0.0` | assessment | WorkItem | 选中的目标文本 |
| `work.kind@1.0.0` | assessment | WorkItem | feature / bugfix / refactor / research / tooling / docs / operations |
| `work.status@1.0.0` | gate | WorkItem | completed / in-progress / blocked / investigated |
| `work.title@1.0.0` | assessment | WorkItem | 选中的稳定标题 |
| `work.verification@1.0.0` | gate | WorkItem | passed / failed / unknown |
| `daily.inclusion@1.0.0` | gate | 日报 | include / exclude |
| `daily.longest@1.0.0` | assessment | 日报 | selected / tied / unavailable |
| `daily.deep-dive@1.0.0` | assessment | 日报 | include / exclude |
| `daily.takeaway@1.0.0` | assessment | 日报 | include / exclude |
| `daily.visual-need@1.0.0` | assessment | 日报 | none / inline / flowchart / sequence / state |
| `daily.visual-budget@1.0.0` | assessment | 日报 | selected / none |
| `devlog.admission@1.0.0` | assessment | DevLog | requirement / bugfix / insight / exclude |
| `devlog.deduplication@1.0.0` | assessment | DevLog | pending / already-synced |
| `devlog.routing@1.0.0` | assessment | DevLog | append / create |
| `period.day-admission@1.0.0` | gate | 周月报 | included / empty / degraded |
| `period.link@1.0.0` | assessment | 周月报 | append / create |
| `runtime.schedule@1.0.0` | gate | Runtime | run / forced / skip |
| `runtime.enabled@1.0.0` | gate | Runtime | accept / forced / reject |
| `runtime.idempotency@1.0.0` | gate | Runtime | skip |
| `runtime.recovery@1.0.0` | gate | Runtime | forced / reject |
| `runtime.reportable@1.0.0` | gate | Runtime | accept / skip |
| `runtime.remote-write@1.0.0` | gate | Runtime | accept / preview / would-block / reject |
| `runtime.sink-write@1.0.0` | gate | Runtime | applied / preview / skip / failed |
| `runtime.execution@1.0.0` | gate | Runtime | failed |

## 日报视觉策略

`daily.visual-need` 对每个进入日报的 WorkItem 独立评价：

| 信号 | 贡献方向 |
|---|---:|
| 目录拓扑复杂度 | 0～+3 |
| 时序与因果复杂度 | 0～+2 |
| 跨模块或跨系统 | 0～+2 |
| 分支、状态或多参与方交互 | 0～+3 |
| 图相对文字的压缩收益 | 0～+2 |
| 已确认事实 | 0～+1 |
| 三步以内简单线性过程 | -3 |

领域门槛：低于 3 使用纯文字，3～5 使用行内箭头，6 以上使用完整图；状态机优先状态图，多参与方调用优先时序图，其余复杂链路使用流程图。

`daily.visual-budget` 再按文件和主题重叠计算边际价值。轻微词汇重叠不降权，重叠达到 0.5 才视为冗余。完整图的 6 张上限只是资源保护，触发时必须记录 `constraints`。

## DevLog 准入与路由

### Requirement

必须存在真实改动，且领域分数至少为 6：

| 信号 | 权重 |
|---|---:|
| 明确产品、业务或用户目标 | +3 |
| 真实代码或配置交付 | +3 |
| 稳定产品模块 | +2 |
| 通过验证 | +1 |
| 分支或 commit 引用 | +1 |
| 个人工具、模型代理或本机环境 | -4 |
| 临时探索或一次性脚本 | -4 |

Bugfix 必须是 `bugfix + material change`。Insight 必须是研究工作，同时具备明确决策和通过验证。类似 `grok2api` 的个人模型工具可以进入日报，但不能进入需求开发档案。

### Routing

已有 ledger binding 时直接追加。否则沿用五个领域指标：业务目标 35%、代码范围 25%、历史 20%、交付引用 10%、时间连续性 10%。只有最佳目标得分不低于 0.75，且领先次优目标至少 0.15，才允许追加；其他情况一律在对应二级章节下新建。

## 周月报

`period.day-admission` 要求日期事实已经 finalized 且事件记账差额为 0。空日跳过，partial 软降级并保留原因。

`period.link` 使用独立的 0～100 刻度，门槛为 55。`subjectKey` 相同直接为 100；否则必须具备共享文件，或“强分支 + 主题重叠”双信号。同一天的两个工作项不能归入同组。

## 变更流程

1. 先为误判补充黄金场景。
2. 只调整负责该判断的策略。
3. 行为或门槛变化时升级该策略版本。
4. 运行针对性测试、历史回放和完整测试。
5. 在 `docs/validation/` 记录旧结果、新结果、接受理由和剩余风险。

## 格式与安全预算

代码中仍存在少量 `slice` / `max`，但它们不决定工作是否有价值：

- Daily/Period Schema 的数组和字符串上限保护模型载荷。
- Mermaid 40 行和完整图 6 张上限保护飞书转换与渲染；完整图裁剪会写入 constraint。
- Evidence、代码摘录、候选 alternatives、标题词和正文摘要的 top-N 只控制传输或展示密度，原始事实仍保存在 WorkFacts 和 DecisionAudit。
- `period.link` 保留前三个候选是审计展示预算，选组时仍评价全部合格组。

任何新的 top-N 如果会改变纳入、归类、路由或是否画图，都必须改为领域门槛或边际价值判断，不能以格式预算名义保留。
