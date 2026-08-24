# InternFlow

InternFlow turns local development activity into scheduled, structured work records.

它把“读取工作记录、调用 Agent 总结、校验结构、写入记录平台、定时执行”拆成一条安全的流水线。当前 `0.1.0` 聚焦 Codex 会话、Codex CLI、Markdown、飞书文档和 macOS `launchd`。

> Status: early alpha. Existing personal automations should stay enabled until an InternFlow job has passed dry-run and a real test-document verification.

## Principles

- Agent 只生成 Markdown 或结构化 JSON，不直接持有飞书写入能力。
- 飞书需求记录只按本地规划更新目标小节：当前事实定点替换、历史变化追加，不允许 Agent 整篇覆盖；旧日报兼容模式会用本地历史报告重建日报文档。
- Prompt 和文档正文通过 stdin 传递，不进入进程参数列表。
- 飞书 Token、Cookie 和密码不写入配置；飞书鉴权委托给 `lark-cli`。Web 远程访问令牌可来自环境变量，或仅写入权限为 `0600` 的 InternFlow 配置。
- 正式写入按 `job + date + 稳定目标身份` 记录状态，调整 Sink 顺序不会改变幂等键。
- 写入前状态为 `pending`，成功后才变为 `applied`；不确定的部分写入会阻止自动重试，检查目标后才能显式 `--force`。
- `--dry-run` 只生成本地预览，不写远端平台，也不更新成功状态。

## Install

Requirements:

- Node.js 20+
- Codex CLI and an authenticated Codex account
- `lark-cli` only when using a Lark sink
- macOS only when using the launchd scheduler

```bash
npm install
npm run build
npm link

internflow init
internflow doctor
```

The default config is created at `~/.config/internflow/config.yaml` with mode `0600`.

## Commands

```bash
internflow init
internflow migrate legacy
internflow job list
internflow job show daily-report

internflow job add daily-report --name team-daily --time 23:30
internflow job add weekly-report --name team-weekly --time 23:40
internflow job add monthly-report --name team-monthly --time 23:50
internflow job add dev-log \
  --name requirement-log \
  --time 23:45 \
  --document https://example.larkoffice.com/docx/your-token

internflow auth lark
internflow auth lark --status
internflow doctor --online

internflow run daily-report --dry-run
internflow run daily-report --date 2026-07-15
internflow run daily-report --model your-model --dry-run

internflow schedule install daily-report
internflow schedule status daily-report
internflow schedule remove daily-report

internflow web
```

## Web security

`internflow web` 默认只监听 `127.0.0.1`，本机访问无需令牌。监听 `0.0.0.0`、`::` 或其他非 loopback 地址时会 fail closed，必须先设置至少 32 字符的令牌：

```bash
export INTERNFLOW_WEB_TOKEN="$(openssl rand -hex 32)"
internflow web --host 0.0.0.0
```

也可以将令牌写入配置，并确保文件权限为 `0600`：

```yaml
web:
  authToken: replace-with-at-least-32-random-characters
```

远程浏览器首次访问 API 时会请求令牌，并只在当前标签页会话中保存。远程 API 校验 Bearer token、Host、Origin、Content-Type、请求体大小和输入字段；生成任务仍通过 Runtime run lock，且 Web 层同时只允许一个 Codex 生成请求。

## Legacy migration

已有 `~/.codex/daily-report/config.json` 和 `dev-doc-sync/config.json` 时，可以先生成脱敏预览：

```bash
internflow migrate legacy
```

该命令默认不写文件，预览中的飞书文档地址会被隐藏。确认后才显式写入：

```bash
internflow migrate legacy --apply
```

目标配置已经存在时会拒绝覆盖；只有 `--apply --force` 才会替换。迁移会启用两个 job，保留旧脚本的执行时间、dev-log 模型、`skipDates`、本地审计路径和 `larkparser fetch --mode fast` 文档读取方式，但采集与报告统一进入新的 WorkItem 管线，不再恢复旧 TaskSummary 算法。日报继续使用旧报告目录，`history-replace` 时不会丢失历史日报。迁移命令不会安装、删除或切换任何 `launchd` 任务。

## Configuration

```yaml
version: 1
timezone: Asia/Shanghai
artifacts:
  dailyDirectory: ~/.codex/daily-report
  devLogDirectory: ~/.codex/daily-report/dev-doc-sync

# 仅远程暴露 Web 时需要；也可改用 INTERNFLOW_WEB_TOKEN
# web:
#   authToken: replace-with-at-least-32-random-characters

jobs:
  daily-report:
    enabled: true
    template: daily-report
    schedule:
      time: "23:30"
      days: [mon, tue, wed, thu, fri]
      dateOffsetDays: 0
    source:
      type: codex
      # 个人工作日截止点：到点后允许将当天快照标记为 finalized
      dayEndTime: "23:30"
      # 可选：覆盖 Codex 默认目录和过滤规则
      # 默认同时扫描 ~/.codex/sessions 与 ~/.codex/archived_sessions
      # sessionsDir: ~/.codex/sessions
      # 为兼容旧脚本，默认采集 assistant 消息和工具输出；可显式关闭
      # includeAssistantMessages: false
      # includeToolOutput: false
      # include: ["project-name"]
      # exclude: ["日报维护"]
    generator:
      type: codex
      model: gpt-5.6-sol
    sinks:
      - type: markdown
        directory: ~/.local/share/internflow/reports
        filename: "{date}.md"
        archive: true
      - type: lark
        document: https://example.larkoffice.com/docx/your-token
        identity: user
        mode: history-replace
        title: Codex 日报

  dev-log:
    enabled: true
    template: dev-log
    schedule:
      time: "23:45"
      days: [mon, tue, wed, thu, fri]
      dateOffsetDays: 0
    source:
      type: codex
      dayEndTime: "23:30"
    generator:
      type: codex
      model: null
    sinks:
      - type: markdown
        directory: ~/.local/share/internflow/dev-log
        filename: "{date}.operations.json"
      - type: lark
        document: https://example.larkoffice.com/docx/your-token
        reader: larkparser
        mode: section-append
```

An enabled `dev-log` job must have exactly one `section-append` Lark sink. The target document currently expects these long-lived level-two sections (the previous names remain readable for compatibility):

- `一、开发总览`
- `二、需求开发记录`
- `三、问题与修复记录`
- `四、工程经验沉淀`

InternFlow gives the Agent temporary references such as `h1` and `h2`, then maps them back to verified Lark Block IDs locally. The Agent never controls a raw Block ID.

`section-append` 使用 `larkparser fetch --mode fast` 读取正文，再读取飞书 outline。本地代码先为每条事实生成受限写入计划：新条目使用确定性 REQ / ISSUE 编号创建，当前事实使用块级替换，历史变化只追加到「变更记录」。需求内修复会根据稳定主题绑定、业务目标和代码范围回到对应 REQ；没有可信需求归属时才创建 ISSUE。生成结果必须覆盖所有必写目标并匹配本地标题前缀，未关闭的旧待办由本地代码保留；写入前还会校验 Block ID、标题和所属章节，结构变化时停止。含图片、画板、引用等资源块的小节会拒绝自动替换，避免数据丢失。

`internflow doctor --online` 会验证飞书登录状态和目标文档读取权限，但不会通过试写修改生产文档。

会话内容在进入生成 Agent 前会执行 best-effort 脱敏，覆盖常见 Token、密码、私钥、Cookie 和 URL 凭证。此机制不能替代专门的 DLP 或密钥扫描器，也无法保证识别所有自定义凭证格式。为保持旧脚本统计与生成效果，`assistantMessages` 和工具输出默认采集；可分别显式设为 `false`。

会话采集现在只有一条精准管线：按每条事件的本地日期提取当天增量，识别“旧会话今天继续”、回滚、终止、上下文压缩、重放、重复消息和子 Agent 工具轨迹。旧配置中显式存在的 `captureMode: precise` 仍可读取，但不再参与运行时分支；`captureMode: legacy` 会被配置校验拒绝。

生成结果会携带 `captureSummary`。`coverage` 为 `partial` 或 `low` 时，报告必须说明原因，不能把上下文压缩或截断后的记录描述成完整事实。

事实快照会构造 `WorkItem` 工作语义层：同一仓库的非默认需求分支作为跨会话、跨日期的稳定主题；默认分支仍按文件范围和请求目标隔离，避免串组。验证命令先失败后成功时以最终结果为准。日报使用高召回 `DailyReportView`，需求开发记录使用高精度 `DevLogCandidate`，两者引用同一组 evidenceId，但筛选规则互不混用。

日报模型只生成结构化草稿，固定 section 和表格由本地代码渲染。需求开发记录的 section、subjectKey、evidenceIds 和 contentFingerprint 也由本地代码确定；没有可追溯 patch excerpt 时，不要求模型补造代码片段。

采集层还会生成独立的 `captureSnapshot`：每条目标日期事件都有 occurrenceId、语义指纹、生命周期状态、原文件字节区间和哈希。`CaptureQuality` 强制事件记账差额为零；需求开发记录只有在快照 `finalized: true` 且质量为 `high` 时才允许远端写入。日报和 dev-log 共享同一个 snapshotId，再分别执行自己的筛选投影。

完整 Snapshot 在本机只保存一份；Source cache、日报输入和 dev-log 输入通过 snapshotId 引用它，capture audit 使用硬链接保留可直接查看的路径，不会再复制整份事件账本。

WorkItem 用于组织任务主题、状态和时长；完整脱敏工作事实另存为紧凑的 `work-facts-YYYY-MM-DD.json`。日报会确定性展示改动范围、结果、决策、交付、最终验证、阻塞和事实覆盖，模型不能省略已纳入的 WorkItem。

周报按周一至目标日、月报按当月 1 日至目标日读取逐日紧凑工件，不拼接日报正文，也不会同时加载整周或整月 Snapshot。每一天必须同时满足 `finalized: true`、`coverage: high` 和 snapshotId 一致；缺失或旧版本工件才会逐日串行补采。跨日只在同仓库且分支、文件或主题证据足够强时关联，不确定的工作保持分组，所有逐日 WorkItem 和 evidenceId 都会保留。月报默认由 launchd 在工作日触发，但 Runner 只在当月最后一个未跳过工作日真正执行。

本机工作习惯以 `23:30` 为当天截止点：日报默认 `23:30` 运行，需求记录默认 `23:45` 运行，均处理当天数据。此时 `finalizationBasis` 为 `configured-cutoff`，表示“按配置认定工作日结束”，而不是声称自然日已经结束。若截止后仍有同日事件写入，下一次读取会让热缓存失效并重新记账；跨过午夜宽限期后则以 `calendar-day` finalized。

## Runtime data

```text
~/.config/internflow/config.yaml       # user configuration, 0600
~/.local/state/internflow/state.json   # idempotency ledger
~/.local/state/internflow/runs/        # generated artifacts and dry-run previews
~/.local/state/internflow/artifacts/   # default input/draft/audit artifacts
~/.local/state/internflow/captures/    # finalized capture snapshot and hot source cache
~/.local/state/internflow/dev-log-evidence.json # cross-day evidence deduplication ledger
~/.local/state/internflow/logs/        # scheduler logs
~/.local/share/internflow/             # configured Markdown outputs
~/Library/LaunchAgents/dev.internflow.job.*.plist
```

None of these files belongs in the Git repository.

旧配置迁移后，input、AI 草稿、dev-log 快照、operations 和 result 会继续写回 `~/.codex/daily-report/`，保持原有路径与 JSON 格式。

## Architecture

```text
Sessions       Tasks                  Reports          Outputs          Scheduler
Codex JSONL -> filter/group/longest -> Codex prompt -> Markdown/Lark <- launchd
```

代码按 `sessions`、`tasks`、`reports` 和外部适配器分区；`core/runtime/runner.ts` 只负责串联执行，幂等与恢复下沉到 `core/persistence` 和独立 runtime 策略。具体目录职责、数据流和问题定位表见 [docs/architecture.md](docs/architecture.md)。

`v0.1` uses a single package and an internal plugin registry. The public boundaries already separate Source, Generator and Sink, but npm-loadable third-party plugins will only be added after a second real implementation proves the contract.

## Development

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

## License

MIT
