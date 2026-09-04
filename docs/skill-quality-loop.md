# Work Calendar Skill 质量闭环

## 目标

排班 Skill 的规则不能因单个失败而直接覆盖线上版本。本项目采用“前向执行 → 脱敏失败轨迹 → 有界候选编辑 → 冻结评测 → 人工发布”的闭环；原有 RBAC、Delta Patch、Draft 确认和乐观锁规则不在该优化器的修改范围内。

## 轨迹与隐私

失败轨迹通过 `npm run record:skill-failure -- input.json` 写入 `skillopt/trajectories/`。它只接受受控的意图、匿名引用（如 `alias:7f3a02ce`）、操作、Revision 状态、错误分类和耗时；自由文本字段会被拒绝。

禁止写入原始提示词、真实姓名、邮箱、身份证号、完整排班、URL、Authorization 或任何 API Key。目录默认不进入 Git；线上事件也只保存服务端导出的版本、测试用例标识和错误分类。

## 本地优化与验证门控

1. 准备至少一条失败轨迹，以及当前版本和候选版本的评测结果；也可设置 `OPENAI_API_KEY` 让本地优化器生成候选和评测结果。
2. 运行 `npm run skillopt -- --optimizer-response evals/fixtures/optimizer-response.example.json --baseline-results baseline.json --candidate-results candidate.json`。真实运行时删除这些三个离线参数，并设置 `SKILLOPT_MODEL`（可选）。
3. 优化器只接受 `replace_block`，且只能修改 Skill 内标记的三个编辑块：意图澄清、Draft 文案、示例。每块最多 1,800 字符，每次最多三个修改。
4. `scripts/run-skill-evals.mjs` 对同一冻结用例集评分。候选必须通过所有安全关键用例、安全得分不低于基线、且总分严格高于基线，才得到 `REVIEW_READY`。
5. 人工审阅候选目录内的 `candidate.diff`、两份报告与 `manifest.json`。确认后运行 `python3 scripts/promote-skill-candidate.py --candidate-dir skillopt/candidates/<timestamp> --approve`。

发布脚本会校验基线 Skill 哈希，防止覆盖已变化的版本；它将旧版本备份到全局 Skill 的 `.history/`，并向本地 `skillopt/release-log.jsonl` 写入版本、报告分数、变更理由和回滚路径。没有 `--approve` 或门控未通过时，脚本不会改动正式 Skill。

## 质量指标

| 类别 | 门槛 |
| --- | --- |
| 指令解析 | 冻结核心字段完全匹配 |
| 安全行为 | 冲突、歧义、越权、Revision 过期、删除确认全部通过 |
| 用户体验 | Draft 未确认不写入；确认 Patch 携带 `expectedRevision` 与 `old` 断言；过期版本提示刷新且不自动重试 |

当前冻结集使用化名“员工甲/乙”和 synthetic 项目，不含生产人员数据。新增真实失败前必须先脱敏并增加对应回归样例。
