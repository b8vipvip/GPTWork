# GPTAuto for GPTWork / GPTWork 的 GPTAuto 协议

## 中文（默认）

GPTWork 内嵌 GPTAuto v0.2。GitHub 工作任务默认采用**最终目标驱动**语义，而不是按一次对话、一条 Commit、一个 PR 或一次 Actions run 判断完成。

### GPTWork 如何使用

当用户要求 GPTWork 执行 GitHub 工程任务时，宿主应自动执行：

    用户目标
      ↓
    GOAL
      ↓
    PLAN：生成任务专属 Definition of Done + Dynamic Gates
      ↓
    EXECUTE：只执行当前目标真正需要的 Gate
      ↓
    VERIFY：逐项记录 DoD 证据
      ↓
    DONE

可选 Gate：INSPECT、IMPLEMENT、COMMIT、PR、PR_CI、MERGE、MAIN_CI、RELEASE、DEPLOY、RUNTIME_VERIFY。

因此：
- “修改代码并提交”可以在 Commit + 验证后结束。
- “修复 Actions 直到 CI 全绿”不强制 Merge/Release。
- “合并到 main”需要 Merge 证据，但不自动发布版本。
- “发布正式版”才选择发布所需的 PR/CI/Merge/main CI/Release Gate。

### 用户是否需要额外告诉 ChatGPT

**不需要每次额外说明。** 在 GPTWork 仓库/工作模式识别到本协议后，GitHub 工程任务应默认按 GPTAuto 执行。

用户只需要描述最终目标，例如：

    @GitHub 修复当前 Actions 失败，直到 CI 全绿。
    @GitHub 完成这个功能并合并到 main。
    @GitHub 修复问题并发布 v0.6.0 正式版。

只有用户明确要求改变终态时才需要补充，例如“只提交不要合并”“先开 PR 不要发布”“不要等待 CI”。

### 宿主集成约定

GPTAuto 的内置 GoalPlanner 是安全的参考/CLI 启发式规划器。GPTWork 的 ChatGPT/Work 推理层应优先根据完整自然语言意图、仓库规则、风险和上下文生成更准确的 gates 与 DoD，并可显式覆盖启发式结果。

异步 Actions 的 queued/requested/pending/in_progress 仅在相应 CI Gate 被当前计划选中时表示 WAITING，绝不能当作 DONE。

进入 DONE 必须同时满足：所有 required Gate 已通过/跳过；所有 DoD 条目均 passed；DoD 条目保留验收 evidence。

### BLOCKED

只有权限/凭据缺失、重大产品决策歧义、未经授权的高风险破坏操作、修复预算耗尽或不可修复的平台条件，才应把控制权交还用户。

---

## English

GPTWork embeds GPTAuto v0.2. GitHub engineering tasks are goal-bound by default: completion is determined by the requested final outcome, not by a chat turn, commit, PR, or Actions run.

The host derives a task-specific Definition of Done and selects only the required dynamic gates, then verifies evidence before DONE.

Users do **not** need to mention GPTAuto on every request. A normal final-goal instruction is enough. Extra wording is only needed when the user wants to override the terminal outcome, such as “commit only”, “open a PR but do not merge”, or “do not wait for CI”.

GPTWork's reasoning layer should use the built-in GoalPlanner as a conservative fallback and may explicitly provide a more accurate gate/DoD plan based on full natural-language intent, repository policy, risk, and context.
