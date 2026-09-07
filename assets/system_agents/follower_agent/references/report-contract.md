# follower_report_v2

模型必须返回 JSON 对象，字段为 `schemaVersion`、`kind`、`window`、`coverage`、`claims`、`suggestions` 和 `summary`。

事实 claim 必须携带 `sourceRefs`。`growth_guidance` 的每个 suggestion 必须携带来源，并使用 `category` 标记为 `insight`、`recommendation` 或 `research_direction`；可以通过 `perspective` 解释独特观点，通过 `researchQuestion` 表达值得继续研究的问题。所有延伸内容都不得展示为已安排或已执行工作。
