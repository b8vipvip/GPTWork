# GitHub Actions 策略 v2.0

本策略同时适用于新项目与已经出现 Actions 堆积、重复运行、长时间卡死的老项目。目标不是只提供一份 YAML 模板，而是建立一套持续生效的资源治理规则。

## 1. 强制规则

### 1.1 自动 CI / Test / Smoke 必须取消同一工作流同一分支或 PR 的旧运行

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

Release / Deploy / Publish 可以使用 `cancel-in-progress: false`，但必须有独立串行组，并受仓库级 Actions Governor 的 180 分钟硬上限保护。

### 1.2 核心验证 Job 必须设置显式超时

建议：

- 单元测试 / Lint：10～20 分钟
- 编译 / 安装包验证：20～45 分钟
- Release / Deploy：可以更长，但不得无限运行

### 1.3 权限最小化

普通 CI 使用 `contents: read`。只有需要取消 Actions 的治理工作流授予 `actions: write`；只有发布 Release 的工作流才授予 `contents: write`。

### 1.4 Debug / 临时诊断工作流不得长期自动触发

临时诊断完成后必须改为 `workflow_dispatch`，并设置较短超时，避免每次 push / PR 都生成新诊断任务。

## 2. Actions Governor：仓库级强制治理

仓库必须存在 `.github/workflows/actions-governor.yml`。Governor 每 10 分钟扫描仍处于 `in_progress` 或 `queued` 的运行，并执行：

1. 普通 CI/Test/Smoke 对同一 workflow + branch + event 只保留最新一条，其余自动取消。
2. 普通工作流达到 45 分钟仍未结束时自动取消。
3. 名称包含 Release / Deploy / Publish / Store Package 的发布类工作流允许更长时间，但达到 180 分钟仍未结束时自动取消。
4. Governor 查询仓库当前真实运行状态，因此可以清理由旧版本 workflow 启动的历史异常运行。
5. Governor 自身使用 concurrency 且 Job 超时 10 分钟，防止治理任务自身形成堆积。

## 3. 老项目迁移顺序

1. 加入 Actions Governor。
2. 给主 CI / Test / Smoke 加 `concurrency + cancel-in-progress`。
3. 给核心 Job 加 `timeout-minutes`。
4. 将临时 Debug Workflow 改为手动触发。
5. 合并后由 Governor 清理策略落地之前遗留的长时间运行任务。
6. 再触发一轮新的 CI 验证策略。

## 4. 验收标准

- 同一 PR 连续 push 两次，旧 CI 自动进入 `cancelled`。
- 普通 CI 不会无限运行，仓库级硬上限 45 分钟。
- Release / Deploy 等发布类工作流最长不超过 180 分钟。
- 历史遗留的长时间 `in_progress` / `queued` 任务能被 Governor 自动取消。
- 临时诊断不再随每次 push / PR 自动运行。
- 最新一代正式 CI 最终给出明确 `success` 或 `failure`，而不是长期 `in_progress`。

## 5. 本仓库策略

GPTWork 主 CI 对同一 PR / ref 自动取消旧运行，并为 Extension、Rust、Windows Setup、Linux package 等核心 Job 设置 20～40 分钟显式超时。其它专用工作流继续保留各自业务语义，但统一受 Actions Governor 的 45 / 180 分钟仓库级资源治理约束。
