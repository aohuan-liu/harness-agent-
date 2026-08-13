# dsh-agent-workflow

DeepSeek Harness（DSH）多代理工程流程插件：把「拷问 → 任务书 → 能力预检 → 拆票 → 派发 → 审查 → 集成 → 归档」工程化为一套**原生工具 + 系统提示 SOP**。

host-only，无 UI，纯 JS（ESM），自带依赖，不依赖任何 symlink / junction。

## 一句话

安装后，任何新会话的 agent 会**自动**知道这套多代理流程（系统提示注入 SOP），并用 `workflow_*` 原生工具直接执行各环节——不再需要 skill 加载，也不再需要 `node script.mjs` 手动跑脚本。

## 提供什么

### 6 个原生工具

| 工具 | 作用 | 关键参数 |
| :--- | :--- | :--- |
| `workflow_new_ticket` | 生成 ticket spec 到 `.agents/tickets/<name>.md`（审计用，不派发） | name / goal / outputs / acceptance / role / depends / tier |
| `workflow_check_report` | 校验 `.agents/reports/<name>.md` 格式；审查报告额外校验首行机器可读结论 + 双轴 | name |
| `workflow_smoke_test` | 验收门禁：校验所有报告；`strict` 时要求每票有报告 + 审查结论全 PASS | strict |
| `workflow_trace` | 提取子代理 ground-truth 执行轨迹（解压 session.jsonl.zstd，交叉核对「自述 vs 真相」） | mode（list/session/latest-subagent）/ sessionId |
| `workflow_archive` | 归档 tickets+reports 到 `.agents/archive/<stage>/`，写 MANIFEST 保留依赖与结论 | stage |
| `workflow_capability_check` | 能力预检：扫描任务书所需 skill/MCP，核对本地是否齐备，出 `docs/capabilities.md` | taskbook |

### 系统提示 SOP

插件自动向每个会话注入一段 SOP，agent 无需加载任何 skill 就知道流程：

> 拷问（目标/边界/交付物/验收）→ 任务书 `docs/TASKBOOK.md` → 能力预检（缺失→市场找→需求规格→阻塞）→ 拆票 → 派发（subagent/workflow，员工 flash / 审查 pro）→ 子代理写报告（含执行轨迹）→ reviewer 双轴审查 + 机器可读结论 + 轨迹交叉核对 + 打回循环 → 集成门禁 → 归档。
> 三档：lite 直行 / standard 加审查 / heavy 完整校验。

## 完整流程（对应工具）

| 步骤 | 动作 | 工具 |
| :--- | :--- | :--- |
| 0 分级 | 小任务直行 / 复杂任务全流程 | —（主 Agent 判断） |
| 1 拷问 | 目标/边界/交付物/验收 | — |
| 2 任务书 | 写 `docs/TASKBOOK.md` | — |
| 2.5 能力预检 | 扫描所需 skill/MCP | `workflow_capability_check` |
| 3 拆票 | 生成 tickets | `workflow_new_ticket` |
| 4 派发 | flash 员工 / pro 审查 | `subagent` / `workflow` |
| 5 执行 | 子代理写报告（含执行轨迹） | — |
| 6 审查 | 双轴 + 机器可读 + 轨迹 + 打回 | `workflow_check_report` + `workflow_trace` |
| 7 集成 | 验收门禁 | `workflow_smoke_test` |
| 8 归档 | 归档 + MANIFEST | `workflow_archive` |

## 关键设计

- **模型路由**：员工角色（implementer/prepare/transcribe/redraw）→ `deepseek-v4-flash`；审查/集成 → `deepseek-v4-pro`。DSH 无 per-call 推理强度，用「模型选型」承载该语义。
- **审查纪律**：reviewer 双轴审查（Spec 轴忠于任务书 / Standards 轴遵守规范）+ 机器可读结论（首行 `审查结论: PASS/FAIL (第N轮)`）+ 失败分流（执行偏差→fix 循环；设计偏差→回主 Agent）。
- **轨迹溯源**：`workflow_trace` 读 session.jsonl.zstd（ground-truth），reviewer 交叉核对子代理「自述执行轨迹」，打回条目引用具体步骤/命令。
- **能力预检**：任务书后扫描所需 skill/MCP，缺失去市场找、找不到出需求规格、阻塞等实现。

## 用法

新项目里直接对 agent 说需求即可——agent 会自动：
1. 用 `workflow_capability_check` 预检能力
2. 用 `workflow_new_ticket` 拆票
3. 用 `subagent`/`workflow` 派发（flash 员工 + pro 审查）
4. 用 `workflow_smoke_test` 验收 + `workflow_archive` 归档

项目根由环境变量 `DSH_PROJECT_ROOT` 指定（缺省用 cwd）。

## 许可与致谢

本项目以 **MIT** 协议开源（见 LICENSE）。方法论与实现从以下项目移植/吸收，谨致谢并遵循其各自许可：

| 项目 | 许可 | 借鉴 |
| :--- | :--- | :--- |
| Auto-Project-Codex | MIT | 多代理方法论（拷问/任务书/拆票/审查/打回） |
| dsh-agent-teams | MIT | 团队协作语义 + 活动面板 |
| mattpocock/skills | MIT | 工程技能（grill/to-spec/to-tickets/handoff） |
| deepseek-vision-skill | 见其仓库 | 视觉能力（可选降级） |
| Babylon.js | Apache-2.0 | 早期 demo 的 3D 引擎 |
