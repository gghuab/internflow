# Use a shared decision protocol with domain-specific policies

Status: accepted

InternFlow 中会改变事实解释、用户可见内容或外部状态的判断，统一输出可审计的 `DecisionAssessment`。协议只统一 policy identity、结果、理由、证据、置信度和版本；分数、指标、权重、门槛与降级策略仍由各领域拥有，且分数不得跨 policy 比较。

## Considered Options

- 建立一个全项目万能总分：拒绝，因为不同决策的风险、输入和刻度不可比较，会制造虚假精确度。
- 保持各模块完全独立：拒绝，因为无法统一审计、历史回放和 Web 解释。
- 共享评价协议、保留领域策略：采用，在可审计性与实现复杂度之间最平衡。

## Consequences

- Gate、领域 Assessment 和 Safety Constraint 必须明确区分；高分不能覆盖失败 Gate，安全上限不能冒充内容价值判断。
- 每个策略独立维护 `policyVersion` 和黄金夹具，策略升级产生新的不可变审计产物。
- 不引入规则引擎、动态 YAML 权重、机器学习或通用人工覆盖系统。
