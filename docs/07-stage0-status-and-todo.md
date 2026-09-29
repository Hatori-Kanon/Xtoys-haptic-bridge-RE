# 状态与待办（阶段 0 暂停中）

> 本文件取代 `docs/stage0-status-and-protocol-questions.md`（已删除），是该文件与本轮
> 协议讨论的合并结果。**恢复工作时先读本文件 + `docs/03-protocol-mapping.md`。**

最后更新：2026-09-30

---

## 1. 当前状态：阶段 0 已开始但暂停

用户要求：**先讨论清楚协议映射，讨论完成后再动代码**。本轮讨论已完成映射定论
（见 `docs/03-protocol-mapping.md`），**尚未开始按定论改代码**。

### 已确认的需求（用户亲自选定）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 可用于真机验证的设备 | **只有 E-Stim（强度+频率）与振动器**。没有旋转器。 |
| 2 | 阶段 0 交付形态 | 可导入的 Script JSON + 导入/绑定步骤 + PowerShell 测试脚本 |
| 3 | 本轮范围 | 只做阶段 0（遵守 §8「这一步通过之前不要写任何游戏侧代码」） |
| 4 | 旋转路径 | 照样按规范建好，但**标记为未真机验证** |
| 5 | Webhook ID | 留空占位符，由用户在 UI 填（符合 §3.6） |

### 由 #1 推出的后果（交付时必须如实声明）

- `HANDOFF.md` §9.1 里 **「旋转的两个方向都要验」本轮无法通过**。
- 我**不得**声称旋转路径已真机验证，只能标注「已按 §4.3 写好，未验证」。

---

## 2. 已写的代码（全部未提交，随时可弃）

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| `src/xtoys-bridge.js` | ES5 运行时：协议解析、状态、仲裁、tick、写变量 + 启动 Job、归零 | `node --check` 通过；**3 处已知缺陷未修完** |
| `tools/build-xtoys-script.mjs` | 组装可导入 Script JSON | 可运行；**需按映射定论重写 Block 生成部分** |
| `tools/test-bridge-logic.mjs` | Node + `vm` mock 宿主测试 | **测试结果已过期**（最后跑是 34 通过 / 5 失败，之后又改了运行时） |
| `examples/xtoys-minimal-3path.json` | 生成物 | **已过期**，需重新生成 |
| `examples/xthb-customFunctions.js` | `customFunctions` 独立副本 | **已过期**，需重新生成 |

尚未写：`docs/minimal-script-build.md`、`tools/Invoke-XtoysAcceptance.ps1`。

### 已知缺陷（恢复工作时先修）

1. **错误返回形状不统一。** `xthbExecute` 里 `xthbApplyPlay` / `ApplyBaseline` / `ApplyStop`
   失败时返回 `{error}`，经 `xtoysBridgeHandle` 后变成 `{ok:true}`。
   后果：`sequence` 没递增、`stop` 无选择器时**调用方会误以为成功**。
   修法：`xtoysBridgeHandle` 统一把 `{error}` 归一化为 `{ok:false, code}`。
2. **`stop` 缺少选择器校验**：应在 `xthbParseCommand` 阶段就返回 `missing_stop_selector`。
3. **显式 `null` 值**：已改为"出现即必须是有限数"（null 拒绝），但**改完没重跑测试**。
4. `init` 会置 `forceWrite`，导致初始化后第一次 tick 必推送一次全零。这是有意的
   （把零值真正推给设备），但测试里要在 `bootHost()` 后先 tick 一次再计数。
5. 恢复时先跑 `node tools/build-xtoys-script.mjs` 与 `node tools/test-bridge-logic.mjs`，
   全通过才算形成有效检查点。

---

## 3. 本轮协议讨论的产出

**映射与仲裁已定论，全部写入 `docs/03-protocol-mapping.md`**，要点：

- `part` 是协议里唯一的执行定位键；**不加 slot / 逻辑执行器标识 / 权重 / 组**。
- 映射表是接收端配置；**一个 Block 专属一个 part**，配重了直接拒绝初始化。
- Block 命名规范：UI 名 `{Metric}-{part}`、Channel ID `part-{metric}-{part}`、
  Job `xthb-output-{metric}-{part}`、变量 `xthb-{metric}-{part}-*`。
- 本阶段生成 **9 个 Block**：`nipple` / `clitoris` / `vagina` / `anus` × `estim` / `vibrate`，
  另加 **1 个旋转样板 `Rotate-nipple`**（用于验证方向 Action 顺序，真机未验证）。
- 部位名统一用全称 **`clitoris` / `anus`**（不用 `clit` / `anal`）。
- 仲裁只发生在**同一部位内部**：`priority` → 数值 → `sequence`；`priority` **保留**。
- 部位/指标没有对应 Block 时 → **忽略并留痕，不报错**（§6.2）。
- 虚拟组**不做**（与"Block 专属一个 part"冲突）。
- **rotate 可以单独出现**：游戏侧以后会有"选单部位以哪几种方式发送"的开关，
  纯 rotate 的 target 合法；该部位只有 estim/vibrate Block 时忽略那一条（§6.2.1）。
- 三条指标**各自独立**，没有主次/门控关系；`rotateSpeed: 0` 算合法指令（停旋转），方向可省。

同时更新了 `docs/02-webhook-protocol.md` §3（targets 合并规则与指标表、priority 语义）
与 §4（部位表、虚拟组不做）。

---

## 4. 仍未定的事项

**无。** 协议映射的待议项已全部定论，见 `docs/03-protocol-mapping.md` §7 的结论表。

### 4.1 架构流程图评审又定下的两条（2026-09-30）

用户在评审 `docs/04-architecture-flow.md` 时指出两处问题，已定论并写进映射文档：

1. **推送判据不能只比数值** → 改为 **数值 或 驱动者身份（`driveId` = source+eventId+sequence）**
   任一变化就推送。否则"新事件、强度恰好与当前相同"会被静默丢掉，体感上什么都没发生；
   而 ramp 是设备级动作，重跑输出 Job 才会重新走一遍 `rampTime`。
   稳定态下 `driveId` 与数值都不变，防抖依然生效。见 `docs/03-protocol-mapping.md` §4.4。
2. **删除"协议部位白名单"** → 部位名是否可用完全由接收端映射配置定义；
   未识别的部位与"合法但没配 Block"走**同一条忽略并留痕**路径，不再整体拒绝。
   解析阶段对 `part` 的唯一要求是"非空字符串"。见 `docs/03-protocol-mapping.md` §6.1。

这两条都**尚未落到代码**（当前骨架仍是白名单 + 只比数值）。

### 4.2 频率缺省语义（2026-09-30 定，用户指出）

**`frequency` 的缺省值 = XToys 上设备当前的值，即"不变动"，不是置零。**
这是三条指标里唯一不遵守"缺省即归零"的一条：`intensity`/`rotateSpeed` 描述刺激量，
缺省归零正确；而 `frequency` 是 E-Stim 的**调制设置**，`intensity=0` 时设备本就无输出，
写 0 只会改变下一次输出的手感。

连带要改的地方（都比 B6 那一格影响大）：

1. **输出 Job 的 `setFrequency` 必须变成条件动作** —— 用哨兵值区分"没有频率意图"与
   "频率 = 0"，再用 `requiredExpression` 门控。
2. **Initial Actions 不得把频率归零**（`docs/01` §7 里旧的 `setFrequency=0` 不沿用）。
3. **Final Actions 不需要 `setFrequency`** —— 归零的是音量。
4. `setMode` 同属设置项，**是否保留为固定动作待确认**。

见 `docs/03-protocol-mapping.md` §4.5。

下一步是**动代码**（用户要求讨论完成后再开工）。骨架**已提交**为可回退检查点
（`76ae08e`，按旧广播模型），远端 `origin/master` 已同步。

---

## 5. 恢复后的执行顺序（建议）

0. ~~先提交当前骨架作为检查点~~ → **已完成**：`8eebf78` … `76ae08e` 已推送 `origin/master`。
1. 修 §2 的缺陷 1–3，跑通生成 + 测试，形成有效检查点。
2. 按 `docs/03-protocol-mapping.md` 改代码，改动只落在：
   - `tools/build-xtoys-script.mjs`：按映射表生成 **9 组** channel + Job + 变量（不是 8 组）；
     `BRIDGE_CONFIG` 换成 §3 形状；命名按 §2.1；
     **输出 Job 的 `setFrequency` 改成条件动作**、Initial/Final Actions 去掉频率归零（§4.2）。
   - `src/xtoys-bridge.js`：
     - `xthbChannelMapFor()` 改查映射表；候选收集按 part 分组（`channels[metric]` → `parts[part][metric]`）；
     - **删除部位白名单**（§4.1 第 2 条）；
     - **推送判据加入 `driveId`**（§4.1 第 1 条）；
     - **频率缺省写哨兵值而非 0**（§4.2）；
     - 加"Block 专属一个 part"校验；加被忽略指标留痕；加同部位重复 target 拒绝；
     - 按 §6.2 调整指标校验（`rotateSpeed: 0` 允许无方向）。
3. 再写 `docs/minimal-script-build.md` 与 `tools/Invoke-XtoysAcceptance.ps1`。
4. 真机验收：E-Stim + 振动器可完整跑；`Rotate-nipple` 标注未验证。
5. 验收后把实测差异补进 `docs/01-xtoys-script-format.md` §8。

> ✅ 骨架已提交（`8eebf78` … `76ae08e`，`origin/master` 已同步），工作区干净。
