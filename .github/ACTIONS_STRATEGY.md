# GitHub Actions 策略 v3

GPTWork 的所有 GitHub Actions 都必须遵循本策略。v3 由 **Workflow Guard、Policy Check、Actions Governor、Actions Recovery、历史异常恢复** 五层组成。

## 1. Workflow Guard

普通 CI/Test/Smoke 必须使用最小权限、同 PR/ref 自动取消旧运行，并为每个实际运行 Job 设置明确 `timeout-minutes`：

```yaml
permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

Release / Deploy / Publish / Store Package 使用独立串行 concurrency group 与 `cancel-in-progress: false`，但最长仍受 Governor 180 分钟硬上限约束。

所有可恢复 Workflow 应保留 `workflow_dispatch`，让 v3 能在修复后显式重新提交修复后的 ref。

## 2. Actions Policy Check

新增或修改 `.github/workflows/*.yml` 时自动检查：

- `permissions`；
- `concurrency`；
- 普通 Workflow `cancel-in-progress: true`；
- 发布类 `cancel-in-progress: false`；
- 每个 `runs-on` Job 的 `timeout-minutes`；
- `workflow_dispatch` 恢复入口；
- Debug/diagnostic/one-shot/tmp Workflow 不得长期自动触发。

已有老 Workflow 由 Governor 兜底，并在下一次修改时强制迁移到 v3。

## 3. Actions Governor

Governor 每 10 分钟扫描仓库当前 `in_progress` / `queued` 任务：

1. 普通同 workflow + branch + event 只保留最新一条。
2. 普通任务达到 45 分钟仍未结束时自动取消。
3. Release / Deploy / Publish / Store Package 达到 180 分钟自动取消。
4. Strategy 内部任务最长 20 分钟。
5. 真正 stale / historical 的任务取消以后，必须立即启动 Actions Recovery，而不是只做 Cancel。

如果某条运行只是已被更新 Commit 替代的 duplicate，不会恢复旧 Commit，因为最新运行本身就是重新提交。

## 4. Actions Recovery：自动修复 + 重新提交

Recovery 会：

1. 收集异常 run metadata 与日志。
2. 从当前 main 加载最新版 v3 修复逻辑，因此能处理策略上线前启动的旧任务。
3. 自动修复安全、确定性的 Workflow 缺陷：缺少 `workflow_dispatch`、权限声明、concurrency、Job timeout 等。
4. 如存在 `.github/actions-recovery.sh`，执行项目级幂等修复规则，可根据 `ACTIONS_RECOVERY_LOG` 修复已知代码/测试故障模式。
5. 有修改时自动建立 `actions-recovery/run-<run_id>` 分支并提交 Recovery PR。
6. 对普通无副作用 Workflow，自动 dispatch 修复后的 ref，完成“修复后重新提交”。
7. 没有安全修改可做时，最多 fresh-run rerun 一次，以恢复 Runner/网络/临时环境故障。
8. 重试预算耗尽后自动创建 `[Actions Recovery]` Issue，留下完整恢复线索。

### 安全边界

v3 不会假装能够凭空推断任意业务代码正确实现。自动代码修复只针对：

- 策略/Workflow 层可机械确定的问题；
- 已通过 `.github/actions-recovery.sh` 编码的项目已知故障模式。

Release/Deploy/Publish/Store Package 具有外部副作用，禁止自动盲目重放；v3 可以提交修复，但发布重试需要明确批准，防止重复发布或部署。

## 5. 历史任务标准恢复链路

```text
历史/当前卡死任务
      ↓
Actions Governor 判定 stale
      ↓
Cancel 释放 Runner
      ↓
Actions Recovery 自动取证
      ↓
Workflow/项目规则自动修复
      ↓
Recovery branch + PR
      ↓
普通任务重新 dispatch
      ↓
不可自动修复 → 一次 fresh rerun → Recovery Issue
```

因此 v3 的“清理”不再等于简单删除或取消，而是资源释放之后必须进入恢复链路。

## 6. GPTWork 默认阈值

- 主 CI Extension：20 分钟。
- Rust / Native Core / Linux package：30 分钟级。
- Windows Setup：40 分钟级。
- 普通仓库级 Governor 兜底：45 分钟。
- 发布类：180 分钟。
- Governor：10 分钟。
- Recovery：20 分钟。
- 无修改 fresh-run 自动重试：最多 1 次。

## 7. 验收标准

- 同一 PR 多次 push 时只保留最新 CI。
- 所有新/修改 Workflow 通过 Policy Check。
- 普通任务不会无限 `in_progress`。
- 历史异常 run 被取消后能看到 Recovery 接管。
- 可安全修复的 Workflow 会出现 Recovery 分支/PR。
- 修复后的普通 Workflow 会被重新提交运行。
- 无法继续自动恢复时会生成 Recovery Issue，而不是无限重跑。
