# pi 自定义消息启动修复发布后的插件适配计划

状态：**已完成并归档（2026-10-15，pi `1.2.0`）。**

调查日期：2026-10-12。调查时本机 pi 为 `1.1.0`，GitHub 最新正式版为 `v1.1.0`；相关修复已列入 `main` 的 `Unreleased`。开始执行时必须重新确认发布状态，不预设下一个版本号。

## 目标与结论边界

升级到包含 #10267 / #5581 修复的正式版，并适配本仓库的 `before_agent_start` 处理器，使普通用户消息与自定义消息启动的运行都保持正确的 prompt 和插件行为。

已确认的上游问题：闲置时 `pi.sendMessage(..., { triggerTurn: true })` 跳过普通 prompt 准备流程；第一次工具调用后的刷新回退到基础 prompt，丢失动态 section，并可能恢复原本移除的 skills 列表。下次普通用户消息又恢复插件处理后的状态，造成额外的前缀变化。

这不是 1.1.0 独有或已证实由 1.1.0 引入的问题。上游在 0.99.x、1.0.x 就有报告，1.1.0 仍可复现；用户在 1.1 时观察到它。`pi-invisible-continue` 的 `/continue` 是本次捕获的触发入口，问题归属 pi 核心的自定义消息启动生命周期。

本计划只解决这个明确机制，不承诺消除所有 cache miss。GPT/GLM 在采样前缀稳定时的缓存波动、Kiro 链路固定比例的缓存统计是另外的现象。`models.json` 已是现行用户配置结构，不属于本次迁移范围。

## 上游依据与发版门槛

- [#10267 — Prompt text contributed in before_agent_start is dropped on runs without a user prompt, re-billing the whole prompt](https://github.com/earendil-works/pi/issues/10267)：调查时 closed / completed。
- [#5581 — Custom messages with triggerTurn bypass before_agent_start](https://github.com/earendil-works/pi/issues/5581)：调查时 closed / completed。
- [上游 CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)：调查时修复和 API 变化在 `Unreleased`。
- [正式 releases](https://github.com/earendil-works/pi/releases)。

执行前检查：

- [x] 确认某个正式 release 包含这两项变更，而不仅是 issue 已关闭（pi `1.2.0`）。
- [x] 阅读该 release/tag 的 changelog、扩展文档和实际发布包的类型声明，确认最终契约。
- [x] 记录目标版本、release URL 和修复来源；如与本计划记录的契约不同，先调整实施方案。

调查时上游预告的契约：

```ts
// 示意，实际字段以目标正式版声明为准。
BeforeAgentStartEvent =
  | { messageType: "user"; prompt: string; images?: ...; ... }
  | { messageType: "custom"; message: ...; ... };
```

闲置时由 `triggerTurn: true` 启动的 custom run 也触发 `before_agent_start`；custom 事件没有 `prompt`。处理器返回的附加消息对两种运行都生效；待交付的 `deliverAs: "nextTurn"` 消息也会随 custom run 交付。依赖用户输入的逻辑需要类型收窄，维护通用 prompt 的逻辑不能整体跳过 custom。

## 本仓库适配范围

调查时搜到三个 `before_agent_start` 注册点；实施时重新搜索，覆盖新增处理器、相关类型和测试 fixture。

| 包 / 文件 | 当前行为 | 适配要求 |
|---|---|---|
| `packages/pi-scout/src/index.ts` | 读取 `event.prompt` 做短路、路由、pending widget、`prevTurn`；skills 清理位于决策 apply 中 | 将所有运行都需要的 prompt 维护与仅用户输入触发的路由分开。详见下节。 |
| `packages/pi-scout/src/modules/skill-router.ts` | `apply()` 将 `systemPromptOptions.skills = []`，并生成注入消息 | 开启 skill-router 时，custom run 也必须保留 skills 清理效果；避免只在用户路径执行而让全量技能目录回流。 |
| `packages/pi-session-namer/src/index.ts` | 从首条用户 prompt 自动命名，含 `event.prompt` 的读取 | 在读取字段前确认 `messageType === "user"`；custom run 不命名、不消耗首次命名机会、不调用命名模型。现有 `event.prompt?.trim()` 不能替代新联合类型的收窄。 |
| `packages/pi-context-include/src/index.ts` | 从 context files 生成 `sections.context_include` | 两种 run 都执行。它不依赖用户 prompt，不能加 user-only 守卫。引用文件未变化时产出的 section 应一致。 |

### Scout 的关键设计

推荐行为：custom run 维护固定的 prompt 约束，但不将后台通知或续接标记当成新的用户需求重新进行 skill/model routing。

- 正常维护技能目录快照，使 `list_skills` 不因 run 类型失效。
- 当配置启用 skill-router 时，在 user/custom 两条路径都清空原生全量 skills section；具体如何提取辅助函数由实施时决定，保持单一规则来源。
- 仅 user 路径使用 `event.prompt`，执行 short-circuit、side-agent 路由、pending widget 和新技能消息注入。
- custom 路径不额外调用路由模型、不自动切换主模型、不重复注入 skill 描述。
- 检查 `turn_end` 的 `prevTurn.assistantSummary` 更新：custom run 的响应不应覆盖上一条用户请求的路由上下文。按 run 类型管理状态，而非只在 `before_agent_start` 加一个早退。
- 维持 scout 总开关、模块开关、模型不可用等现有语义；不要在禁用状态强制清空技能。

**反模式**：在 scout handler 顶部简单添加 `if (event.messageType !== "user") return`。这虽然避开字段错误，却会跳过必要的 skills section 清理，重新引入大 prompt。

## 相关生产者与第三方扩展核对

这些是兼容性核对范围，不默认改变其交互语义：

- `pi-subagent`：当前 availability 和后台完成通知均使用 `triggerTurn: false`，不得为了适配把它们改为自动唤醒。
- `pi-chat-room`：当前收信走 `sendUserMessage`，不是本次 custom trigger 路径；保留既有行为。
- `pi-invisible-continue`：第三方插件，确认其发布版本仍支持目标 pi；验证 idle `/continue` 及运行中排队续接。不默认改其 npm 安装源码或卸载它。
- pi 内置 MCP：核对 custom run 仍产生稳定的 `mcp_servers` section。
- 对其他已加载扩展搜索 `before_agent_start`、`event.prompt`、`event.images`。第三方适配优先使用上游正式版本；若必须本地修补，单独说明范围。

## 实施顺序

1. 确认正式修复版本和最终事件契约。
2. 核对工作区现有改动，记录版本基线。本机 pi 由用户升级，不由 agent 全局安装或重启。
3. 在项目内更新必要的 pi 框架开发依赖和 lockfile，再适配源码。调查时根 `package.json` 的 `pi-ai` / `pi-coding-agent` / `pi-tui` 仍为 `1.0.0`，不能拿旧类型当作新版本验收。只更新本次需要的依赖，不做无关全量升级。
4. 修改三个直接处理器及其必要辅助逻辑、fixture；扫一遍全仓库新类型报错。
5. 执行离线验收，完成后汇报变化及运行时验收步骤。
6. 用户升级/重载后，再做真实会话验收。不同已打开的会话需分别重载；发现问题时由用户选择回退本机版本，项目修改保留可审阅 diff。
7. 用户确认后才 commit；push、发布另需明确授权。本计划不授权自动提交或远端写入。

## 验收：以输入稳定和事件行为为准

### 离线检查

- [x] 仓库根运行 `npx tsc --noEmit`。
- [x] 复用相关包的 `node:test` 测试，命令为 `node --test <相关测试路径>`。
- [x] user 事件保持原有路由和命名行为；fixture 使用目标版的合法事件类型。
- [x] custom 事件不触发 scout/namer 的 side-model 调用、不命名、不覆盖上一条用户的路由上下文。
- [x] 在 skill-router 开启时，custom 事件依然将原生 `skills` 置空（通过 `ScoutModule.preparePrompt` / `preparePromptOptions` 前置不变量）；禁用时维持原有配置语义。
- [x] 固定文件输入下，context-include 在两种事件中产生一致 section。
- [x] 验证范围不包含 TUI 排版测试。若需要跨组件 fixture，优先复用 pi/项目现有设施，不为本计划另造大型 harness。

### 用户重载后的最小真实验收

使用一个独立测试会话：普通用户消息启动一轮并结束 → idle `/continue` → 至少一次工具调用及后续模型请求 → 再发一条普通用户消息。

检查：

- [ ] custom 启动及其工具后续请求不删除 `context_include`、`mcp_servers`，不恢复全量 skills。
- [ ] 下一条正常用户消息不再把上述 section 来回切换。
- [ ] 无 `event.prompt` 缺失导致的异常；无意外命名、额外路由调用或主模型切换。
- [ ] 覆盖新会话尚未有用户 prompt 时的 custom 首次启动（可用已有离线 SDK fixture）：基础 prompt 和通用 section 从第一次请求就存在；命名仍等待用户消息。
- [ ] 工具可正常调用；RPC 下逻辑不依赖 TUI 组件。

**缓存命中率不作为唯一通过标准。** 前缀一致时服务端仍可能 miss；验收应看 section、工具定义和已有消息前缀是否稳定。先检查 session 中的 system delta；必要时使用范围受限的临时内存采样，不恢复长期诊断插件和全量日志。

## 本次调查留下的事实

- `/continue` 触发的一组实际 prompt 长度变化：22,546 → 112,572 → 22,546 字符；新增/移除约 93k 字符的 skills 目录，同时切换 context-include/MCP sections。
- v2 样本也存在 GPT/GLM 前缀与参数稳定、缓存读取骤降后恢复的情况；不纳入本修复的成功承诺。
- Kiro 链路大量响应的缓存统计精确为输入的 90%；配置的 `cacheControlFormat: "anthropic"` 解释断点标记迁移，但不等于 pi 本地按 90% 计算。
- 临时诊断目录 `~/.pi/agent/extensions/cache-diagnostics/` 已按用户要求删除。旧进程若未重载可能重建输出；不要依赖这些文件作为计划执行的前置材料，也不要自动重建或清理它们。
- 正常 session JSONL 保留。必要时按会话 ID `01a12f34-19e4-752c-8fb0-ccef21dec3ab` 查找 2026-10-12 09:12 / 09:43 UTC 的 system section 变化；上游 issue 已提供独立复现，不依赖这份本地会话。

## 完成条件

正式修复版已安装；相关插件完成新事件类型适配；必要离线检查通过；用户重载后确认续接不再引发 prompt section 往返变化。完成后记录实际版本和验收结果，归档本计划。

另有 [before_agent_start 并发竞态计划](../pi-before-agent-start-race.md)，涉及 scouting 期间并发提交消息，是不同问题，不能因本次修复而自动结案。
