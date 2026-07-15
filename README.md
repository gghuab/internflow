# InternFlow

InternFlow turns local development activity into scheduled, structured work records.

它把“读取工作记录、调用 Agent 总结、校验结构、写入记录平台、定时执行”拆成一条安全的流水线。当前 `0.1.0` 聚焦 Codex 会话、Codex CLI、Markdown、飞书文档和 macOS `launchd`。

> Status: early alpha. Existing personal automations should stay enabled until an InternFlow job has passed dry-run and a real test-document verification.

## Principles

- Agent 只生成 Markdown 或结构化 JSON，不直接持有飞书写入能力。
- 飞书需求记录只使用追加操作，不支持删除、整篇覆盖或块替换。
- Prompt 和文档正文通过 stdin 传递，不进入进程参数列表。
- Token、Cookie 和密码不写入配置；飞书鉴权委托给 `lark-cli`。
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
internflow job list
internflow job show daily-report

internflow job add daily-report --name team-daily --time 23:30
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
```

## Configuration

```yaml
version: 1
timezone: Asia/Shanghai

jobs:
  daily-report:
    enabled: true
    template: daily-report
    schedule:
      time: "23:30"
      days: [mon, tue, wed, thu, fri]
    source:
      type: codex
      # 可选：覆盖 Codex 默认目录和过滤规则
      # sessionsDir: ~/.codex/sessions
      # 默认不采集、也不向生成 Agent 发送 assistant 消息和工具输出
      # includeAssistantMessages: true
      # includeToolOutput: true
      # include: ["project-name"]
      # exclude: ["日报维护"]
    generator:
      type: codex
      model: null # null 表示使用 Codex 自身默认模型
    sinks:
      - type: markdown
        directory: ~/.local/share/internflow/reports
        filename: "{date}.md"
      - type: lark
        document: https://example.larkoffice.com/docx/your-token
        mode: append

  dev-log:
    enabled: true
    template: dev-log
    schedule:
      time: "23:45"
      days: [mon, tue, wed, thu, fri]
    source:
      type: codex
    generator:
      type: codex
      model: null
    sinks:
      - type: markdown
        directory: ~/.local/share/internflow/dev-log
        filename: "{date}.operations.json"
      - type: lark
        document: https://example.larkoffice.com/docx/your-token
        mode: section-append
```

An enabled `dev-log` job must have exactly one `section-append` Lark sink. The target document currently expects these long-lived level-two sections:

- `一、需求开发记录`
- `二、联调问题与 Bug Fix 汇总`
- `三、个人沉淀`

InternFlow gives the Agent temporary references such as `h1` and `h2`, then maps them back to verified Lark Block IDs locally. The Agent never controls a raw Block ID.

`section-append` 在生成前后各读取一次文档结构，并校验标题的 Block ID、文本与所属章节。结构发生变化时会在首次写入前停止；写入只使用 `append` 或 `block_insert_after`，不会整篇覆写。

`internflow doctor --online` 会验证飞书登录状态和目标文档读取权限，但不会通过试写修改生产文档。

会话内容在进入生成 Agent 前会执行 best-effort 脱敏，覆盖常见 Token、密码、私钥、Cookie 和 URL 凭证。此机制不能替代专门的 DLP 或密钥扫描器，也无法保证识别所有自定义凭证格式；`assistantMessages` 和工具输出默认不采集、不发送，只有显式设置 `includeAssistantMessages: true` 或 `includeToolOutput: true` 才会启用。

## Runtime data

```text
~/.config/internflow/config.yaml       # user configuration, 0600
~/.local/state/internflow/state.json   # idempotency ledger
~/.local/state/internflow/runs/        # generated artifacts and dry-run previews
~/.local/state/internflow/logs/        # scheduler logs
~/.local/share/internflow/             # configured Markdown outputs
~/Library/LaunchAgents/dev.internflow.job.*.plist
```

None of these files belongs in the Git repository.

## Architecture

```text
Source            Generator          Validator        Sink             Scheduler
Codex sessions -> Codex CLI output -> local schema -> Markdown/Lark <- launchd
```

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
