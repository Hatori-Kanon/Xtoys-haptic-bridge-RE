# XToys 触觉桥 — 交接与重启文档

> **这是本工作区的主工作文档。** 后续所有工作以本文档为入口。
> 旧工作区的计划书、评审报告、过程文档一律不再是工作依据；其中只有"实测知识"被抽取到本工作区。

最后更新：2026-09-30

---

## 0. 一页速览

**项目是什么**：把成人游戏里的战斗/状态事件，通过 Webhook 转发给 XToys，驱动连接的实体设备（E-Stim / 振动 / 旋转）。
游戏侧只描述"哪个部位、多大强度"，XToys 侧负责把逻辑部位映射到具体物理执行器。

**已完成的部分**：XToys 脚本的 JSON 语法与宿主 JS API 已摸清；游戏→XToys 的 Webhook 协议已定义并实际收发过；
三个游戏（RPG Maker MV/MZ、Unity、UE）的事件映射已实测确认。这些知识全部保留在本工作区。

**✅ 阶段 0（XToys 接收端）已完成并真机验证**（2026-10-05）：9 个 Block 的可导入 Script、
ES5 运行时、105 项本地测试 + 契约检查、真机验收 14 步（除旋转外全部通过）。
见 [docs/07-stage0-status-and-todo.md](docs/07-stage0-status-and-todo.md) 与
[docs/06-minimal-script-build.md](docs/06-minimal-script-build.md)。

**为什么当初重置**：早期实现（一套 16 槽通用运行时引擎 + 有界状态 + 自适应重触发 + 重试/重同步 + 179 项测试 + 十余份过程文档）
对一个单人自用项目而言严重过度设计，维护成本远高于收益，且**真机验证从未完成**。因此丢弃实现，保留知识，重新做了一版小的。

**下一步做什么**：见 §8 路线图 —— 阶段 0 已通过，接下来是**阶段 1：接第一个游戏**
（`レピテーション！` 最省事），只发 `set_baseline` + `play`，加命中冷却与高潮锁。

---

## 1. 项目目标

### 1.1 要解决的问题

1. 游戏本身不知道 XToys 的存在；XToys 也不知道游戏语义。
2. 不同游戏的内部数据结构完全不同（开关/变量、Unity 字段、UE 对象），逐个适配不可避免。
3. 设备数量、种类、接线方式因人而异，且会变。

→ 因此把系统切成两半：**游戏侧只输出逻辑意图**（部位 + 强度 + 时长/渐变 + 旋转），
**XToys 侧只负责把逻辑意图变成物理输出**。两边通过一个稳定的 Webhook 协议解耦。

### 1.2 成功标准

- 玩任意已适配的游戏时，设备反应与游戏事件**感知上同步**（延迟不刺眼、不丢事件、不粘住）。
- 换游戏只改游戏侧 Bridge，XToys 侧不用动。
- 加/换设备只改 XToys 侧配置，游戏侧不用动。
- 任何时候停止 XToys Script，所有输出**必定归零**。

### 1.3 明确不做的事（边界）

- **不修改设备最大强度、最大旋转速度** —— 那永远是用户在 XToys 设备设置里的选择。
- **不做游戏进程检测 / 心跳 / 自动启停 Script** —— Script 由用户手动启停（这是 XToys 的原生流程）。
- **不在游戏里写设备名、通道名、Job 名**。
- **不从设备读取状态** —— XToys 没有可靠的设备确认 API（见 §3.4）。

---

## 2. 本次重置：保留什么、丢弃什么

| 保留（已验证的知识） | 丢弃（过度设计 / 无实测收益） |
| --- | --- |
| XToys Script JSON 语法、Action 形状、宿主 JS API → `docs/01-xtoys-script-format.md` | 16 槽通用运行时引擎（8 个 ES5 模块 ~60 KB、86 KB 构建产物） |
| Webhook 协议（封装/字段/命令） → `docs/02-webhook-protocol.md` | 有界状态/容量上限（128 事件、256 目标、64 基线来源…） |
| 三个游戏的事件映射与 probe 方法论 → `docs/05-game-event-mappings.md` | 逻辑 generation、物理 generation、重试队列、重同步、reload 回滚 |
| 一份真实可导入的 Script JSON 结构样本 → `examples/xtoys-importable-reference.json` | 自适应 retrigger（7 字段 + EMA + texture/phases）、pulse 状态机 |
| 游戏侧适配器参考实现 → `reference/` | 179 项自动化测试与基准脚本 |
| 安全边界与"同步返回 ≠ 设备确认"的结论 | 十余份 spec/plan/report 过程文档 |
| 仓库卫生约定（不提交真实 Webhook ID） | 每游戏专属 Job、16 槽模板生成器 CLI |

**旧实现本身没有错，只是与需求规模不匹配。** 它最大的价值是证明了这套语法与协议可行，并且产出了真机安全的操作方式。

---

## 3. 不可协商的硬约束

### 3.1 XToys 只跑 ES5

Script 的全局 JavaScript 运行在 JS-Interpreter 中。**禁止** `let` / `const` / `=>` / `class` / `async` / `await` /
模板字符串 / 解构 / 展开。用 `var` 和函数声明写。

### 3.2 安全边界（硬件相关，最重要）

- 只写**当前输出值**（`setVolume` / `setFrequency` / `setMode` / `setDirection`）。
- **绝不**调用任何设置最大强度/最大旋转速度的接口。
- Initial Actions 与 Final Actions 必须**显式**把所有已绑定 Block 归零。
  Final Actions 是 JS 抛错、运行时未初始化、Job 刷新失败时**唯一**的硬件停止保障。
  ⚠️ **因此字面量归零必须排在 Final Actions 里的 `customCode` 之前** ——
  否则这条保障就押在"JS 不抛错"上了（2026-09-30 修正，见 `docs/01` §7）。
- 用户手动启停 Script；配置改动遵循 XToys 原生 stop → edit → start 流程。

### 3.3 生命周期

Script 是手动启停的。启动 = Initial Actions（归零 → 写配置 → 初始化 JS → 启动调度 Job）；
停止 = Final Actions（停调度 Job → **显式 UI 归零所有 Block** → 停所有输出 Job → 最后跑 JS 清理）。

### 3.4 现实边界：同步返回 ≠ 设备确认

`setVariable(...)` / `callAction(...)` 正常返回**只说明这次 JS 调用没有同步抛异常**。它**不**证明：

- Job 真的执行了；设备真的收到了；设备真的达到了目标强度/速度；ramp 真的跑完了；方向真的换了。

因此代码注释、日志、文档**一律不得**使用"设备已确认""已成功下发"之类措辞。
日志与计数器只能说"XToys 调用未抛异常"。

### 3.5 游戏侧只发逻辑意图

游戏代码里不出现设备/通道/Job 名。协议里的 `part` 是逻辑部位，不是执行器。

### 3.6 仓库卫生

- **不要提交填了真实值的 XToys Webhook ID。** 需要示例时留空或占位符。
- 游戏目录、构建产物、日志、抓包一律不进版本库。

---

## 4. XToys 平台知识（摘要）

> 完整语法、Action 全表、已验证/未验证清单见 **`docs/01-xtoys-script-format.md`**。
> **从 Webhook 进来到 Block 输出的完整链路与时序图见 `docs/04-architecture-flow.md`。**

### 4.1 心智模型

| 概念 | 是什么 |
| --- | --- |
| **Channel（通道）** | 一个物理执行器或独立子通道。类型有 `webhook` / `part-estim` / `part-vibrator` / `part-rotator`。导入后用户必须在 UI 上把它绑定到唯一设备 |
| **Script 变量** | JS 与 UI 之间的**数据总线**。JS 用 `setVariable` 写，Job 用 `{变量名}` 读 |
| **输出 Job** | **一次性刷新器**：被 `updateJob/start` 唤醒 → 用当前变量值写一次硬件 → 立即停自己 |
| **调度 Job** | 一个 100 ms 定时自循环，调 JS 的 tick 函数（用于到期、脉冲、基线恢复） |
| **Global Trigger** | Webhook 入口：外层 `action == xtoys_game_bridge` → 把 `{trigger-payload}` 交给 JS |
| **Initial/Final Actions** | 启动/停止时执行的 Action 列表，硬件安全背板 |

### 4.2 最小可用模板的结构清单

一个能跑的 Script JSON 需要（顶层键：`initialActions`, `finalActions`, `globalTriggers`, `jobs`, `queues`,
`channels`, `controls`, `controlPresets`, `media`, `customFunctions`）：

1. **channels**：1 个 `webhook` + 每个物理执行器 1 个 `part-*` 通道。
2. **jobs**：1 个调度 Job（timer 0.1 s + `goTo` 自循环）+ 每个通道 1 个输出 Job。
3. **globalTriggers**：1 个，筛 `xtoys_game_bridge`，把载荷交给处理函数。
4. **initialActions**：归零所有 Block → 写配置变量 → 初始化 JS → 启动调度 Job。
5. **finalActions**：JS 全停 → 停调度 Job → 显式归零所有 Block → 停所有输出 Job。
6. **customFunctions**：ES5 字符串，实现协议解析、状态、以及把结果写进变量的逻辑。

### 4.3 输出 Job 的两个硬要求

- **旋转 Job 里方向 Action 必须排在速度 Action 之前**（否则换向会慢一拍）。
- E-Stim 槽若要控频率，加 `setFrequency`（`format: "relative"`）；旋转槽不需要频率。

---

## 5. 通信协议（摘要）

> 完整字段表、命令示例、错误码见 **`docs/02-webhook-protocol.md`**。

传输：POST `https://webhook.xtoys.app/<Webhook ID>`，固定外层 `{"action":"xtoys_game_bridge","payload":"<内层JSON字符串>"}`。

命令：

| 命令 | 作用 |
| --- | --- |
| `play` | 创建一个有限事件（部位 + 强度 + 时长 + 渐变） |
| `update` | 用更高 `sequence` 替换同一 `source+eventId` 的整个目标集（**换向的唯一方式**） |
| `stop` | 停某个事件 / 某些部位 |
| `set_baseline` | 替换某来源的**完整**基线快照（持续状态用） |
| `stop_all` | 紧急全停（优先于一切仲裁） |

关键语义：

- `source + eventId` 是事件身份，`sequence` 必须**严格递增**才生效。
- 基线是**快照**不是叠加；`stop_all` 后同一 source 的基线序号栅栏仍保留，必须继续递增（或换 source）。
- 旋转**不会自动反向**；必须显式发新的 `rotateDirection`。
- **强度按通道分开**：estim 槽只读 `estimIntensity`，vibrate 槽只读 `vibrateIntensity`，旋转槽只读 `rotateSpeed`，三者互不推导。

---

## 6. 游戏侧知识

> 完整映射表见 **`docs/05-game-event-mappings.md`**。

| 游戏 | 引擎 | 接入方式 | 结论 |
| --- | --- | --- | --- |
| 駆錬輝晶 クォルタ アルミネス＆タンジェル EG | RPG Maker MV | 游戏内 JS 插件 | 项目起点；参考实现已存档 |
| レピテーション！ | RPG Maker MZ | 游戏内 JS 插件 | **已跑通**：开关 #83–#94 = 部位命中，#112 = 高潮，变量 #24 = 拘束 |
| ドミネートプラン | Unity | BepInEx + Harmony | 已跑通；攻击极密，**必须做 200 ms 批量合并** |
| Aruna and the Labyrinth | UE | UE4SS Lua Mod | 字段已探明；`BDValue` 是累计值，**必须用增量**；有 5 个会崩的字段禁止读 |

**probe 先行**是唯一可靠方法：先写独立探针 dump 变量/字段变化，一次只触发一个行为，只信可重复的量。探针与正式 Bridge 分离。

---

## 7. 建议的新架构（避免重蹈过度设计）

### 7.1 从 3 条输出路径起步

不要一上来做 16 槽。先做：**1 个 E-Stim + 1 个振动 + 1 个旋转**。
真的接了更多设备再扩，扩的时候也只是复制通道 + Job + 变量三条。

### 7.2 接收端最小模型

只需要三样东西：

1. **一份最新意图**：`part → {estimIntensity, vibrateIntensity, frequency, rotateSpeed, direction, ramp}`（有限事件 + 基线）。
2. **一个 100 ms tick**：算出每个通道当前应该输出的值。
3. **一次写变量 + 启动 Job**：**数值 或 驱动者身份**都没变才跳过（唯一的优化，防抖）。
   不能只比数值 —— 新事件强度恰好相同时若不重推，体感上就没有这次 ramp（见 `docs/03-protocol-mapping.md` §4.4）。

够用了。不需要 generation、不需要重试队列、不需要回滚、不需要容量上限系统。
唯一需要认真对待的是：**同一部位内部多来源竞争时选谁**（先比 priority，再比数值，再比 seq）——这一条逻辑值得写清楚并测试。

### 7.3 反面教材：旧设计踩过的坑（不要重复）

| 坑 | 教训 |
| --- | --- |
| 为"可靠性"加入 generation / 重试 / 重同步 | 设备无法观测，这些机制**不能**提升实际触觉效果，只增加状态与分支 |
| 自适应 retrigger（EMA + 7 字段 + texture 相位） | 体感问题应优先在**游戏侧**用更简单的方式解决 |
| 有界容量系统（128/256/64 上限 + 原子拒绝） | 自用场景不会触发；用它换来了大量测试与文档 |
| 每槽独立异常隔离 + 失败历史 API | try/catch 记一条日志即可 |
| 179 项自动化测试 + 基准脚本 | 测试要**能证伪**关键逻辑（竞争仲裁、归零），而不是覆盖每一个防御分支 |
| 十余份 spec/plan/report | 单人项目用一份文档 + git 提交信息足够 |
| 先做引擎后做真机验证 | **真机验证始终没做**。应该反过来：最小实现 → 真机 → 再加 |

---

## 8. 从零重做的路线图

**阶段 0：最小 XToys 侧（先做这个）**
1. 手工在 XToys 里建：1 个 webhook 通道 + 3 个 `part-*` 通道 + 1 个调度 Job + 3 个输出 Job。
2. 写一个最小的 ES5 `customFunctions`：解析协议、保存最新意图、tick 计算、写变量、启动 Job。
3. 配 Initial/Final Actions 的显式归零。
4. **用真机验证**：用 curl/PowerShell 直接 POST `set_baseline` / `play` / `stop_all`，确认强度、频率、旋转方向、到期恢复、停止归零。
5. 这一步通过之前不要写任何游戏侧代码。

**阶段 1：第一个游戏**
- 选一个已探明映射的游戏（レピテーション！最省事），写最小 Bridge，只发 `set_baseline` + `play`。
- 加命中冷却与高潮锁，防抖。

**阶段 2：多设备与多部位**
- 扩通道与输出路径；此时再考虑部位路由权重。

**阶段 3：第二个引擎的游戏**
- 复用协议，只换游戏侧探针与 Hook。

**阶段 4（可选）**
- 需要时再考虑虚拟组、脉冲、更复杂的混合。

---

## 9. 验收与工作流程

### 9.1 真机验收清单（每次改 XToys 侧都要跑）

- [ ] 导入/保存 Script 后，每个 Block 各自绑定到**恰好一个**物理执行器或子通道，无重复绑定。
- [ ] 确认设备设置里的最大强度与最大旋转速度仍是自己选的安全值（模板不得改动它）。
- [ ] 低强度分别验证 E-Stim、振动、旋转；旋转的两个方向都要验。
- [ ] 发 `set_baseline` → 确认持续输出；发 `play` → 确认瞬态叠加；等它到期 → 确认回到基线（不是归零）。
- [ ] 发反向 `update` → 确认方向立刻改变，没有中间停顿。
- [ ] 发 `stop_all`、再手动停 Script → 确认**所有**输出归零。
- [ ] 记录本次测试的 Script 修订号与设备/通道绑定；把与文档不符的地方补回 `docs/01-xtoys-script-format.md` §8。

### 9.2 探针流程（接新游戏时）

独立探针 → 一次一个行为 → 收集日志 → 只提取可重复量 → 写入 `docs/05-game-event-mappings.md` → 再写正式 Bridge。
正式 Bridge 里探针默认关闭。

### 9.3 提交约定

- 一个改动一个提交，提交信息说明"为什么"。
- 不提交：真实 Webhook ID、游戏目录、构建产物、日志、抓包。
- 改 XToys 侧脚本后，同步更新 `examples/xtoys-importable-reference.json` 或新增一个更小的示例。

---

## 10. 目录导航

```
Xtoys-haptic-bridge/
├─ HANDOFF.md                          ← 本文档，主工作文档
├─ README.md                           ← 极简导航
├─ docs/                                ← 编号 = 阅读顺序
│  ├─ 01-xtoys-script-format.md         ← XToys 脚本 JSON / Action / 宿主 JS API（核心资产）
│  ├─ 02-webhook-protocol.md            ← 游戏 → XToys 通信协议
│  ├─ 03-protocol-mapping.md            ← part → Block 映射与仲裁（**权威定义**）
│  ├─ 04-architecture-flow.md           ← Webhook → Block 输出 的完整数据流与时序图
│  ├─ 05-game-event-mappings.md         ← 各游戏事件映射 + probe 方法论
│  ├─ 06-minimal-script-build.md        ← **怎么导入 / 绑定 / 验收**（阶段 0 交付说明）
│  ├─ 07-stage0-status-and-todo.md      ← 阶段 0 状态、真机验收记录、剩余待办
│  └─ 08-game-side-integration-guide.md ← **游戏侧插件编写指南**（要写游戏侧就读它）
├─ src/xtoys-bridge.js                  ← ES5 运行时（被嵌入 Script 的 customFunctions）
├─ tools/                               ← 生成器、契约检查、逻辑测试、指南核对、真机验收脚本
├─ examples/
│  ├─ xtoys-minimal-3path.json          ← **要导入 XToys 的那一份**（9 Block / 10 Job）
│  ├─ xtoys-importable-reference.json   ← 旧版完整可导入 Script（**只作语法参考**）
│  └─ xthb-customFunctions.js           ← customFunctions 独立可读副本
└─ reference/
   ├─ rpg-maker-mv/XtoysWS.js           ← 最初的 MV 参考实现
   ├─ rpg-maker-mz/XtoysBridgeMZ.js     ← 已跑通的 MZ Bridge
   ├─ aruna-ue4ss/                      ← UE4SS Lua Bridge
   └─ dominate-plan/                    ← BepInEx Bridge + Core
```

### 关于 `examples/xtoys-importable-reference.json`

它是一个**真实生成并成功导入过 XToys** 的 16 槽模板。请**只参考它的语法形状**
（顶层结构、channels、jobs、globalTriggers、initialActions/finalActions、Action JSON）。
它内嵌的 `customFunctions` 是被本次重置**弃用**的旧运行时，不要沿用其架构。

---

## 11. 旧工作区位置与可回收资产

原仓库完整保留在：

```
E:\Harness\DSH\Xtoys-ws-plugin          （当前主检出，分支 codex/xtoysimport）
E:\Harness\DSH\Xtoys-ws-plugin\.worktrees\xtoys-import-pr4-integration   （最新提交 929bc88 的文件快照）
C:\Users\HatoriKanon\Claude\Projects\Xtoys-ws-plugin   （原始开发工作区，含 git worktree 与全部历史）
```

那里仍然有（需要时可翻，但**不要**作为新架构依据）：

- 完整通用运行时源码 `src/XToysUniversalBridge/` 与构建产物
- 模板生成器 `src/XToysTemplate/` 与 CLI
- 179 项测试、基准脚本、十余份 spec/plan/report
- 游戏探针源码（Aruna 外部内存扫描、UE4SS 探针、DominatePlan 探针）

⚠️ **陷阱**：`E:\Harness\DSH\Xtoys-ws-plugin\.worktrees\*` 下的目录虽然在本工作区里，
但它们的 `.git` 指针仍指向 C: 原仓库的元数据。**不要在那里做写操作**，只当只读快照看。

---

## 12. 待办（下一步）

> ✅ **阶段 0（XToys 接收端）已完成并真机验证**（2026-10-05）。
> - **映射与仲裁的权威定义** → `docs/03-protocol-mapping.md`
> - **现状、真机验收记录、剩余待办** → `docs/07-stage0-status-and-todo.md`
> - **怎么导入/绑定/验收** → `docs/06-minimal-script-build.md`
>
> 恢复工作时先读这三份文件。

**下一步：§8 阶段 1 —— 接第一个游戏**（游戏侧插件尚未开始）。

- [ ] **阶段 1**：接 `レピテーション！`（RPG Maker MZ，最省事），只发 `set_baseline` + `play`，
      加命中冷却与高潮锁。开工前先核对 `docs/05-game-event-mappings.md` 的映射是否仍够用
- [ ] 用最小实现替换 `examples/xtoys-importable-reference.json`，产出一个真正干净的示例
- [ ] **旋转两方向**：等有旋转器再跑步骤 7/8（当前**未验证**，不要记成通过）
- [ ] `rampTime` 单位是否真的是秒（步骤 3/4b 的渐变观感可间接判断）
- [ ] `requiredExpression` 的 `>` 语义（步骤 5/6 已间接证明可用，未单独验）
- [ ] `updateVariable` 为何打坏长 JSON 字符串（不阻塞；见 `docs/07` §1.3）
- [x] ~~按 §8 阶段 0 搭出最小 Script，并在真机上跑通首次验收~~ → 已完成（14 步 + 安全性专项）
- [x] ~~确定"同槽多事件竞争"的最终规则并写下来~~ → 已定：`priority` → 数值 → `sequence`，
      且**只在同一部位内部竞争**（`docs/03-protocol-mapping.md` §5）
- [x] ~~决定是否保留虚拟组~~ → 已定：**不做**（与"一个 Block 专属一个 part"冲突，见 §6.3）
