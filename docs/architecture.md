# InternFlow 架构

## 一句话模型

InternFlow 先采集本地 Codex 事实，再由唯一的 Workday Workflow 生成工作语义，最后生成报告并写入目标平台：

```text
sessions/codex -> ActivitySourceBatch -> workflows/workday -> ActivityBatch
                                                       -> reports -> generator -> sinks
                                                             ^                  |
                                                             |-- core/runtime --|
```

`sessions` 与 `reports` 之间有一层可审计的工作语义模型：

```text
CaptureSnapshot + WorkEvidence -> WorkFactIndex + WorkItem -> DailyReportView / DevLogCandidate
```

`WorkItem` 负责跨会话主题、目标、状态、变更和验证闭环；两个报告投影只决定各自需要哪些工作事实。

所有会改变事实解释、报告正文或外部写入的判断，同时产生独立的 `DecisionAssessment`：

```text
领域输入 -> 领域策略 -> 结果 + DecisionAssessment[]
                              |
                              v
                   content-addressed DecisionAudit
                              |
                              v
                    本地 Web 只读审计视图
```

共享契约只统一 Gate、信号、理由、证据、置信度和策略版本，不提供跨领域总分。日报视觉、DevLog 准入、文档路由和周期归组分别拥有自己的指标与门槛；安全上限只记录为 constraint，不能替代内容价值判断。策略目录见 `docs/decision-policies.md`。

## 目录职责

```text
src/
├── sessions/codex/        # Codex Source 插件边界
│   ├── source.ts          # Source 插件入口，只产出事实批次
│   ├── capture/           # 不依赖日报格式的事实采集流水线
│   │   ├── capture.ts     # 生成唯一的每日事实快照
│   │   ├── normalize.ts   # 不同 Codex 事件格式转为标准事件
│   │   ├── lifecycle.ts   # 重复、重放、回滚和中断状态机
│   │   ├── thread-graph.ts
│   │   ├── evidence.ts
│   │   └── quality.ts
│   ├── projection/        # JSONL 事件到 Activity 的投影
│   │   ├── parse.ts       # 标准事件到 Activity 的解析
│   │   └── activity.ts    # 组装最终会话数据
│   ├── storage/           # 文件发现、流式读取和缓存持久化
│   │   ├── files.ts
│   │   ├── reader.ts
│   │   ├── cache.ts
│   │   └── source-cache.ts
│   └── support/           # JSON、时间和脱敏工具
│       ├── json.ts
│       ├── time.ts
│       └── privacy.ts
│
├── workflows/workday/     # 事实批次到日报/DevLog 输入的唯一工作流
│   ├── project.ts         # WorkItem 单轨投影
│   └── types.ts           # Captured/Projected Workday 别名
│
├── work-items/            # 事实证据到工作语义的确定性组装
│   ├── index.ts           # 工作语义层稳定公开 API
│   ├── types.ts           # 兼容导出 core/contracts/workday 的 WorkItem 契约
│   ├── assembly/          # WorkItem 组装流水线
│   │   ├── assembler.ts   # 跨会话归组、状态计算和最终组装
│   │   ├── text.ts        # 目标提取、文本清洗和事实压缩
│   │   └── traceability.ts # Evidence/sourceEvent 引用校验
│   └── policies/          # 可独立测试的确定性推断策略
│       ├── classification.ts
│       ├── identity.ts    # 跨会话稳定 subjectKey
│       ├── title.ts       # 基于任务内容生成标题
│       └── verification.ts
│
├── reports/
│   ├── daily/             # 日报视图类型、Prompt、渲染和兜底报告
│   └── dev-log/           # DevLog 候选类型、文档匹配和 Prompt
│
├── plugins/
│   ├── generators/        # 调用 Codex CLI 生成报告
│   ├── sinks/             # Markdown 和飞书写入适配器
│   └── schedulers/        # macOS launchd 适配器
│
├── core/                  # 运行基础设施，不放任务业务规则
│   ├── contracts/         # 跨层共享的稳定数据契约
│   │   ├── capture.ts     # CaptureSnapshot、Evidence 和代码片段
│   │   ├── activity.ts    # Activity 和 ActivityBatch
│   │   ├── workday.ts     # WorkItem、DailyReportView、DevLogCandidate
│   │   ├── plugins.ts     # Source、Generator、Sink 插件协议
│   │   └── run.ts         # RunContext 和 RunResult
│   ├── decision-audit.ts  # 决策校验、稳定 ID、指纹与审计产物组装
│   ├── runtime/           # 一次 Job 的执行编排
│   │   ├── runner.ts      # 只保留顶层流程和生命周期
│   │   ├── job-strategies/ # Daily/DevLog 的准备、校验、持久化和结果策略
│   │   ├── sink-pipeline.ts # Sink 检查、应用和状态推进
│   │   ├── recovery.ts    # pending 写入恢复门禁
│   │   ├── results.ts     # 通用跳过/已应用结果
│   │   └── registry.ts    # 内置插件注册表
│   ├── persistence/       # 本地状态和审计产物持久化
│   │   ├── artifacts.ts   # input、草稿和审计文件
│   │   ├── state-store.ts # 幂等状态与不可变运行产物
│   │   ├── state-lock.ts  # 跨进程状态更新锁
│   │   └── state-validation.ts # 运行产物校验与哈希
│   ├── config.ts          # YAML 配置和校验
│   ├── calendar.ts        # 日期和跳过规则
│   ├── activity-duration.ts # 无业务依赖的活动区间并集与时长上限
│   └── run-lock.ts        # 防止同一任务并发执行
│
├── web/                   # 报告预览与决策审计；非 loopback 强制鉴权并脱敏
└── cli.ts                 # 命令行入口，只负责参数和命令路由
```

## 日报执行流程

1. `core/runtime/runner.ts` 根据 job 配置选择 JobStrategy，再启动统一的恢复、生成和 Sink 生命周期；Web 与 CLI 都从这里进入。
2. `sessions/codex/storage/files.ts` 查找所有可能在目标日被追加的 JSONL，而不是只看会话创建目录。
3. `storage/reader.ts` 流式读取候选文件；`capture/normalize.ts` 为每次物理出现生成 occurrenceId、来源字节区间和语义指纹。
4. `capture/lifecycle.ts` 保留完整审计轨迹，同时标记 duplicate、replay、rolled_back 和 aborted。
5. `capture/thread-graph.ts` 递归计算多层子 Agent 的 rootSessionId，`capture/evidence.ts` 生成可追溯的 WorkEvidence。
6. `capture/quality.ts` 强制目标事件记账差额为零，`capture/capture.ts` 产出唯一 snapshotId 和 finalized 状态。
7. `sessions/codex/source.ts` 到此只返回 `ActivitySourceBatch`，不读取任务或报告规则。
8. `workflows/workday/project.ts` 只进入 WorkItem 单轨，不再存在 Activity/TaskSummary 回退路径。
9. `work-items/assembly/assembler.ts` 生成身份、分类、标题和验证状态；标题使用通用“对象 + 动作/结果”策略，验证状态只接受同链最终结果或真实交付证据。
10. 日报模型输出带 WorkItem/Evidence 引用的 JSON 草稿，本地 renderer 固定生成 Markdown 结构。
11. DevLog Generator 只能表达本地候选，标题和状态直接复用 WorkItem；section、证据、subjectKey 和内容指纹由本地补齐。
12. Markdown 或 Lark Sink 写入，`core/persistence/state-store.ts` 和 dev-log evidence ledger v2 共同防止重复。
13. Runtime 汇总本次运行的领域评价、门禁、恢复和 Sink 结果，保存为 0600、内容寻址的 DecisionAudit；报告正文不嵌入评分表。

日报和 dev-log 不再各自读取原始 JSONL。它们共享同一目标日期 `captureSnapshot.id`，区别只发生在投影层。

本地持久化同样以 snapshotId 为边界：完整 CaptureSnapshot 只保存一份，Source cache 和报告输入只保留引用或实际生成所需的结构化视图；capture audit 在同一文件系统使用硬链接，因此可读路径不变但不重复占用磁盘。

WorkItem 是可扫描的工作摘要，不是细节的唯一副本。`work-facts-YYYY-MM-DD.json` 以较小体积保留完整脱敏 Evidence；日报渲染器和后续周期报告可按 evidenceId 补充请求、决策、改动、验证、交付与错误事实，无需加载完整事件 Snapshot。

## 会话采集

运行时只有一条精准采集管线：以事件时间提取当天增量，昨日内容只作背景，合并子 Agent，并排除回滚、重放与重复事件。旧配置中的 `captureMode: precise` 是可读取但不参与分支的兼容字段；`legacy` 已退休。

## 修改问题时去哪里

| 问题 | 修改位置 |
|---|---|
| 会话漏读、重复读取 | `sessions/codex/storage/files.ts`、`projection/parse.ts` |
| 会话跨天或时长错误 | `sessions/codex/support/time.ts`、`projection/activity.ts` |
| 敏感信息没有隐藏 | `sessions/codex/support/privacy.ts` |
| 无关内容进入日报或需求记录 | `reports/daily/view.ts`、`reports/dev-log/candidates.ts`、`core/source-filter.ts` |
| 任务名称像对话标题 | `work-items/policies/title.ts` |
| Longest Task 选择错误 | `reports/daily/view.ts` |
| WorkItem 跨会话归组错误 | `work-items/assembly/assembler.ts`、`policies/identity.ts` |
| WorkItem 类型、标题或验证状态错误 | `work-items/policies/` |
| WorkItem 引用了不存在的证据 | `work-items/assembly/traceability.ts` |
| 日报内容要求需要调整 | `reports/daily/prompt.ts` |
| 日报 Markdown 结构错误 | `reports/daily/render.ts` |
| 飞书读取或写入错误 | `plugins/sinks/lark.ts` |
| 重复执行或恢复失败 | `core/runtime/recovery.ts`、`core/persistence/state-store.ts` |
| 某项内容为什么纳入、排除或画图 | `docs/decision-policies.md`、Web 决策审计、对应领域策略 |
| 决策审计无法读取或校验 | `core/decision-audit.ts`、`core/persistence/artifacts.ts` |
| 定时任务问题 | `plugins/schedulers/launchd.ts` |

## 依赖原则

- `sessions` 只负责生成 ActivitySourceBatch，不生成任务或日报。
- `workflows/workday` 是事实批次进入工作语义和报告投影的唯一入口。
- `work-items` 只定义和组装 WorkItem，不拥有日报视图或 DevLog 候选类型。
- `reports` 只生成或规范化报告内容，不直接调用飞书。
- `plugins/sinks` 只负责外部写入，不决定任务内容。
- `core/runtime/runner` 只负责执行顺序；恢复、Sink 流水线和持久化分别下沉到独立模块。
- `core/contracts` 只定义跨层数据形状，不执行读取、判断或写入。

这几个边界可以避免再次出现一个文件同时负责读取、判断、生成和写入的情况。
