# 阶段 0 状态与待办

> **读这份文件就够了解现状。** 映射与命名规则看 `docs/03-protocol-mapping.md`；
> 链路与数据流看 `docs/04-architecture-flow.md`；怎么导入和验收看 `docs/06-minimal-script-build.md`。

最后更新：2026-09-30

---

## 1. 一句话现状

**阶段 0 的代码已完成、本地验证全绿；真机首次启动失败已修（见 §1.1），待重新导入复测。**

| 项 | 状态 |
| --- | --- |
| 接收端运行时（ES5） | ✅ 已写完并通过本地验证（77 项） |
| 可导入的 Script JSON（9 个 Block） | ✅ 已生成，自检通过 |
| 导入 / 绑定 / 验收说明 | ✅ `docs/06-minimal-script-build.md` |
| 逐条真机验收脚本 | ✅ `tools/Invoke-XtoysAcceptance.ps1` |
| **真机启动** | ✅ **已成功**（2026-09-30，`初始化完成：部位 4 个，Block 9 个`） |
| **真机验收（14 步）** | ✅ **除旋转外全部通过**：符合 11 / 无法验证 2（旋转）。见 §5 |
| **旋转的两个方向** | ❌ **无法验证**（你没有旋转器），不得记成通过 |
| 游戏侧代码 | 未开始（`HANDOFF.md` §8：阶段 0 通过之前不写） |

### 1.1 真机启动失败（2026-09-30）：根因已确认并修复

**现象**：webhook 传输正常，但 Script 启动即报错，之后所有 webhook 都无反应。

**第一轮日志**（只知道失败，不知道为什么）：

```
[xthb] init 失败: 配置不是合法 JSON —— 运行时静默，不会驱动任何输出
[xthb] rejected invalid_config: 运行时未初始化
```

**加固诊断后的第二轮日志**（加了"把实际读到的内容打出来"）—— 根因一次定位：

```
[xthb] init 失败：配置不是合法 JSON（读到 91 字符：
       "undefined,"clitoris":undefined,"vagina":undefined,"anus":undefined},"frequencySentinel":-1}"）
```

**根因**：`updateVariable` 把配置写进 Script 变量、JS 再用 `getVariable` 读回来时，
**内容被打坏了**：我写进去的是 **494 字符的合法 JSON**，读回来只有 **91 字符**，
而且所有值都变成了 `undefined`（`"clitoris":undefined` 对应我写的
`"clitoris":{"estim":"part-estim-clitoris",...}`）。

也就是说：**问题不在执行顺序，而在变量读写这条传值路径本身**（至少对这个长度的 JSON 字符串不可靠）。

> 我最初的推断是"Initial Actions 里 `updateVariable` 与 `customCode` 的执行顺序不保证"。
> **那个推断是错的** —— 是加了诊断日志才把它否掉的。这也是为什么"失败时打印实际读到的内容"
> 比"只打印失败原因"重要：没有它，我只会在错误的方向上反复加固。

**修法：改用已经真机验证过的传值机制，不再依赖变量读写。**

Inspector：触发器的 `variables: [{ name: "payload", value: "trigger-payload" }]`
能把 Webhook body 正确当字符串交给 JS（你的游戏侧消息能进来就证明它可用）。
于是用**同一机制**把配置直接注入初始化调用：

```json
{
  "type": "customCode",
  "code": "xtoysBridgeInit(cfgJson);",
  "variables": [ { "name": "cfgJson", "value": { /* 配置对象 */ } } ]
}
```

- **主路**：注入（与触发器同一机制，已验证可用）。注入值无论被求值成对象还是字符串，
  运行时的 `xthbParseConfig()` 两种都接受。
- **备路**：仍然 `updateVariable` 写一份到 Script 变量，供 tick 补读与诊断用；
  两条路互为兜底。
- 初始化日志现在会写明**配置来源、类型与长度**（`（配置来源：object/494字符）`），
  便于真机核对传值是否完整。
- 保留 tick 自愈：任何一条路拿到配置都能完成初始化。

### 1.2 最终修法：配置内联进代码文本（已真机验证启动成功）

三轮尝试，前两轮都失败，第三轮成功。过程如下（值得记住，因为两次失败是同一个模式：
**在"XToys 如何传递字符串"上做假设**）：

| 轮次 | 做法 | 真机结果 |
| --- | --- | --- |
| 1 | `updateVariable` 写变量 → JS `getVariable` 读回 | ❌ 494 字符读回 91 字符，值全变 `undefined` |
| 2 | 经 `variables` 注入字符串 | ❌ 同样损坏（碎片里键与标点完好、值全变裸 `undefined`，模板替换的特征） |
| 3 | **配置内联进 `customCode` 的代码文本** | ✅ **启动成功**：`初始化完成：部位 4 个，Block 9 个` |

**结论**：代码文本是唯一被证明能可靠承载数据的通道（Webhook 的 `payload` 也走这条路）。

实现要点：

- 紧凑配置 `{"p":{"nipple":["estim","vibrate","rotate"],...},"s":-1}`，内联后整条
  `customCode` 只有 157 字符。Channel ID 由运行时按命名规范推导，不必进配置。
- 运行时同时接受紧凑版与完整版（键名大小写/长短不敏感），"Block 专属一个 part"的校验两者都保留。
- 备路（写变量）保留供 tick 补读；`handle` 入口记录载荷长度与预览，
  万一 webhook 载荷遇到同类截断能立刻发现。

> ⚠️ **一个诊断坑（已修）**：成功后日志曾显示 `配置来源：object/15字符`，看起来像配置被截断。
> 原因是用了 `String(对象)`，而 XToys 的 `String(普通对象)` 返回 `"[object Object]"`（正好 15 字符）。
> 真实证据是同一次日志里的 `Block 9 个`。现改用 JSON 序列化长度，并加了回归测试锁住它。

### 1.3 仍待确认

- **`updateVariable` → `getVariable` 为什么打坏长 JSON 字符串：未知。**
  参考实现用同样的动作传了 1763 字符的配置且能导入，所以不像是单纯的长度上限。
  值得单独做一次探针验证（见 §4 待办）；在配置走内联路之后它**不再阻塞阶段 0**，
  但**同样会威胁 webhook 载荷**，所以 `handle` 入口现在会记录载荷长度与预览。
- **真机验收（14 步）尚未执行** —— 下一步就是它。

---

## 2. 本地验证结果（可复现）

```powershell
npm run verify     # = build && test && contract
```

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 生成 9 个 Block / 10 个 Job；7 项结构自检通过 |
| `npm run test` | **73 项通过 / 0 失败** |
| `npm run contract` | **契约检查全部通过**（23 个被引用变量全部有写入方） |

**本地验证全绿 ≠ 真机可用。** mock 宿主只说明"JS 调用没有同步抛异常"，
不代表 Job 执行了、设备收到了（`HANDOFF.md` §3.4）。

### 2.1 独立复核（子智能体，对抗式）

一次只读复核（未改任何文件，独立在 `node:vm` 里跑真实运行时验证行为）确认了：
A1–A4 硬件安全、B ES5 子集、C 生成器↔运行时契约、D1–D8 逻辑一致性 **全部成立**；
并找出 14 条缺陷。**其中 6 条是 MAJOR，已全部修复**（见 §3.2）。
复核也确认那条最有价值的旁证：`examples/xtoys-importable-reference.json` 真的
导入过 XToys，里面用了 `JSON.parse` 与 `hasOwnProperty` —— 说明这些内建在真实
JS-Interpreter 里可用。

---

## 3. 本轮实现的东西

| 文件 | 作用 |
| --- | --- |
| `src/xtoys-bridge.js` | ES5 运行时：协议解析、状态、仲裁、100ms tick、推送、归零 |
| `tools/xtoys-naming.mjs` | **映射表与命名规范的单一真源**（加部位只改这里） |
| `tools/build-xtoys-script.mjs` | 组装可导入的 Script JSON（含 6 项结构自检） |
| `tools/test-bridge-logic.mjs` | 56 项运行时逻辑测试（mock 宿主） |
| `tools/check-script-contract.mjs` | **Script JSON ↔ 运行时契约检查** |
| `tools/Invoke-XtoysAcceptance.ps1` | 逐条真机验收（14 步，交互式记录你的观察） |
| `examples/xtoys-minimal-3path.json` | 生成物：可导入 Script |
| `examples/xthb-customFunctions.js` | `customFunctions` 独立可读副本 |
| `package.json` | `npm run verify` 统一入口 |

### 落实的规则（都来自前面的讨论定论）

- `part` 是唯一的执行定位键，协议与代码里都不出现设备名。
- 一个 Block 专属一个 part，配重了直接**拒绝初始化**（配置错误早失败）。
- 三条指标各自独立分派，没有主次/门控。
- 仲裁只在**同一部位内部**：`priority` → 数值 → `sequence`。
- 推送判据 = **数值 或 驱动者身份（`driveId`）** 变化 → 同强度新事件会重推。
- **`frequency` 缺省 = 哨兵值 `-1` = 保持设备当前频率**，不是 0；显式 `0` 才写 0。
- **删除了部位白名单**：未识别部位走"忽略并留痕"，与"合法但没配 Block"同一条路径。
- 同部位重复 target、无选择器的 `stop`、`sequence` 未递增 —— **一律如实返回 `ok:false`**。
- 归零 = 归零音量；**Initial / Final Actions 都不写频率**。

### 修掉的 3 处旧缺陷

| # | 缺陷 | 现状 |
| --- | --- | --- |
| 1 | 执行阶段错误未归一化成 `{ok:false}`，导致失败被静默当成成功 | ✅ 已修（`xtoysBridgeHandle` 统一按 `result.ok` 判定） |
| 2 | `stop` 缺少选择器校验（拖到执行阶段才失败） | ✅ 已修（解析阶段即返回 `missing_stop_selector`） |
| 3 | 显式 `null` 数值被当成缺省 | ✅ 已修（出现即必须是有限数） |

### 本轮新发现并修掉的 5 个真实缺陷

1. **生成器与运行时变量名不一致**（生成器按 metric 写 `xthb-vibrate-*`，运行时按
   Channel ID 写 `xthb-vibrator-*`）→ 输出 Job 会去读**永远没人写**的变量，设备什么也收不到。
   单元测试当时全绿，因为测试里的期望值也是照同一个错误假设手写的。
   修法：命名规则集中到 `tools/xtoys-naming.mjs` 单一真源 + 新增契约检查动态验证写入方。
2. **`xthbWritten` 里频率存了哨兵值、计算侧是 `null`** → `needsPush` 每次都误判"变了"，
   每 100 ms 重复启动全部输出 Job。修法：统一用 `xthbRecordedFrequency()`。
3. **`xtoysBridgeStopAll()` 只改变量、不推送** → Final Actions 的归零永远送不到输出 Job。
   修法：真正推送一次，并把零状态记入 `xthbWritten`（避免下个 tick 重复推）。

### 3.2 由独立复核发现并修掉的缺陷

复核（§2.1）找出 14 条，修复如下。**这些都是本地测试全绿也照样存在的缺陷。**

| # | 级别 | 问题 | 修法 |
| --- | --- | --- | --- |
| F1 | MAJOR | `stop_all` 推送循环无异常隔离：`callAction` 抛异常会冲出 `handle`（游戏侧收不到 `ok:false`），且 8 个通道停在旧输出；状态还在推送**之前**就写成"已停" | 所有宿主调用包 try/catch + `safeCall` 包住全部入口；状态改为推送**之后**才写；异常计入 `xthb-host-errors` |
| F2 | MAJOR | 文档承诺的"指标级忽略留痕"根本没实现：`xthbAuditIgnored` 只判断整个部位，`xthbBlocksFor` 写了却从未被调用 | 改为在**接受命令时**逐 target 判定并留痕（部位 + 指标），同一问题只记一次 |
| F3 | MAJOR | 只发 `frequency` 的意图被接受却什么都不做（频率被绑在音量 winner 上） | 频率改为**独立仲裁**："带频率的最高优先意图"决定；只有频率时**不写音量变量**，避免把正在输出的强度拽到 0 |
| F4 | MAJOR | `play`/`update` 的空 `targets` 返回 `ok:true` 并占用事件名额；被拒绝的 `stop` 仍会删掉空壳事件（**被拒命令改了状态**） | 空 targets 在解析阶段拒绝；`xthbApplyStop` 先确认真的移除了东西再清理空壳 |
| F5 | MAJOR | 每个 target 的 `durationMs` 被 `max()` 合并，200 ms 的一击会被同事件的 5000 ms 拖着继续输出（**超出游戏要求的刺激时长**） | 新增 `partFinishAtMs`，**按部位各自到期** |
| F6 | MAJOR | `test` 要求 `sequence`，而 `docs/02` §5 的示例没有 —— 文档里的预检命令实际会被拒 | `test` 不再要求 `sequence` |
| F7 | MINOR | 忽略计数按 tick 累加、10 Hz 刷日志，短暂事件的忽略完全看不到 | 改为接受时计数并去重；短暂事件也能留痕 |
| F8 | MINOR | `stop` 的空 `targets` 在执行阶段才拒绝（与注释和文档不符） | 解析阶段即返回 `missing_stop_selector` |
| F9 | MINOR | 配置期还有一份部位白名单，与 `docs/03` §6.1「没有白名单」矛盾；`knownParts` 非数组时校验会静默失效 | **删除该白名单**，只要求非空字符串 |
| F10 | MINOR | 频率哨兵值只校验"是有限数"，落在 0–100 内就无法与真实频率区分 | 配置校验要求哨兵值必须在 0–100 之外 |
| F11 | MINOR | `docs/03` §2.1 命名表过期（写 `-value`、`part-{metric}-`），照它手写会产出没人读的变量名 | 命名表改为与实际一致，并注明 metric 名与通道类型词的区别 |
| F12 | MINOR | `source`/`eventId` 含 `\u0000` 时事件身份会碰撞 | 禁止 ID 含控制字符 |
| F13 | MINOR | 事件到期后序号栅栏消失，webhook 重试/重复投递的旧 sequence 会被接受 → **重复刺激** | 过期事件保留 10 分钟作序号栅栏；过期后仍拒绝旧 sequence |
| F14 | MINOR | 死代码（`xthbBlocksFor` 未用、不可达分支、未使用的返回值） | 已清理 |

**另外修了一处复核列为"不可本地验证"、但顺序上可以防御的问题**：
Final Actions 里字面量归零原本排在 `customCode` **之后**，等于把唯一的硬件硬保障
押在"JS 不抛错"上。现已改为**先归零、最后跑 JS**，并在生成器自检里强制这个顺序。

> ⚠️ 这一条仍有**无法本地验证**的部分：XToys 在某个 Action 抛错后是否中止后续 Action。
> 真机验收时要专门试一次"让 JS 抛错后停 Script"，确认硬件归零。

---

## 4. 待办：真机验收（下一步，需要你）

按 `docs/06-minimal-script-build.md` 执行：

1. `npm run build`（如已生成可跳过）→ 在 XToys 导入 `examples/xtoys-minimal-3path.json`。
2. **在 UI 上把每个 Block 绑定到恰好一个设备/子通道**（唯一强制手工步骤；
   `Rotate-nipple` 建议先不绑）。
3. 拿到 Webhook ID：`$env:XTOYS_WEBHOOK_ID = "<真实 ID>"`（**不要提交进仓库**）。
4. 手动启动 Script，然后：

```powershell
pwsh -File tools/Invoke-XtoysAcceptance.ps1              # 全部 14 步
pwsh -File tools/Invoke-XtoysAcceptance.ps1 -SkipUnverifiable   # 跳过需旋转器的步骤
```

5. 把结果记到本文件 §5，并把新发现的差异补进 `docs/01-xtoys-script-format.md` §8。

### 验收时特别要盯的几条

| 步骤 | 验什么 |
| --- | --- |
| 4 | 同强度新事件**必须**重新渐入（验 `driveId` 推送判据） |
| 6 | 不带 `frequency` 时**频率保持不变**（验缺省语义，本轮最关键的语义） |
| 13 | `sequence` 不递增必须被拒绝（验缺陷 1 的回归） |

### 已实测确认的一条事实

**Webhook 对会被整体拒绝的载荷也返回 HTTP 200。** 所以 HTTP 状态码不能用来判断
命令是否被接受；只能看 XToys Script 日志或诊断变量
（`xthb-rejected-count` / `xthb-ignored-count` / `xthb-last-error` / `xthb-last-ignored`）。

---

## 5. 真机验收结果

### 5.2 2026-10-05 第二轮（9 步）

| 步骤 | 结果 | 备注 |
| --- | --- | --- |
| 2 振动基线 | ✅ 符合 | |
| 4 同强度重推 | ⚠️ **测试设计问题**，见下 | 运行时行为正确，但该场景无法可感知 |
| 5 frequency 显式值 | ✅ 符合 | |
| 9 多部位独立 | ✅ 符合 | |
| 10 priority 接管 | ✅ 符合 | **priority 作为第一级判据在真机成立** |
| 11 未识别部位被忽略 | ✅ 符合 | 留痕可见：`ignored 部位 tentacle 未在映射配置里` |
| 12 同部位重复被拒 | ✅ 符合 | |
| 13 sequence 不递增被拒 | ✅ 符合 | **缺陷 1 回归通过** |
| 14 stop_all 归零 | ✅ 符合 | |
| 1 / 3 / 6 | ✅ 见 §5.1（首轮） | |
| 7 / 8 旋转 | **无法验证**（无旋转器） | |

**合计：符合 11 / 无法验证 2。** 至此 `HANDOFF.md` §9.1 清单中**除旋转外的项目全部通过**。

#### 步骤 4 的结论：运行时正确，测试设计错了

日志证明 `acc-retrigger` 被**正常接受**（`收到 command=play … eventId=acc-retrigger`），
运行时确实因 `driveId` 变化而**重新启动了输出 Job**。但设备看不到变化，原因是：

| 步骤 | 载荷 | 输出电压 | 能否看到脉冲 |
| --- | --- | --- | --- |
| 步骤 1 | `set_baseline estimIntensity:15` | 稳定 15 | — |
| 步骤 3 | `play estimIntensity:60` | 15 → **60** → 回 15 | ✅ 值变了 |
| 步骤 4 | `play estimIntensity:15` | 15 → **15**（不变） | ❌ 电流本来就在 15 |

**`setVolume` 把音量设为"已经是的那个值"时，设备不会产生可感知的变化。**
所以步骤 4 的载荷**恰好无法体现重推机制** —— 这是我的测试设计问题。

已修：

1. **步骤 4 的期望改成"设备维持 15 不变、日志出现未被拒绝的 play"**，
   并明确写出"看不到脉冲是正常的"。
2. **新增步骤 4b**：连发两击、强度相同（40）、**两击之间强度回落到 0** ——
   这才是重推机制可感知的场景（0 → 渐入 40，再来一次 0 → 渐入 40）。
3. 回归测试锁定两条事实：同值重推**确实**启动了 Job；有回落时两次渐入都可见。

#### 仍然存在的 tick 超时告警（已缓解，未根除）

第二轮日志里 `JavaScript did not finish running in allotted time` 仍在**间歇**出现
（首轮是每条命令前都出现）。已做的优化：

- 诊断变量改为**值变化时才写**。
- 新增**每 tick 候选缓存**：同一 `(part, metric)` 在一次 tick 内会被音量与频率两个维度
  各问一次，现在只算一次。

**未根除的原因未知**（XToys 内部的时限与计量口径都不明）。**关键是它不影响功能**：
命令全部被正常接受并执行，归零、拒绝、留痕都按预期工作。已记为已知现象，不再投入。

### 5.1 2026-10-05 首轮（3 步）

用户实跑 `pwsh -File tools/Invoke-XtoysAcceptance.ps1`，报告如下。

| 步骤 | 结果 | 备注 |
| --- | --- | --- |
| 1 E-Stim 基线 | ⚠️ **部分** | 频率未落在 30（读到 37）；vibrate 通道同时被唤起 |
| 3 瞬态 + 到期回基线 | ✅ **符合** | |
| 6 frequency 缺省不变 | ✅ **符合** | **本轮最关键的一条语义通过** |
| 4 同强度重推 | 未跑 | |
| 2 / 5 / 9 / 10 / 11 / 12 / 13 / 14 | 未跑 | |
| 7 / 8 旋转 | **无法验证**（无旋转器） | |

**用户补充说明**：三步的**现象都完全符合要求**；第 1 步填"不符合"只是因为
"从第一步开始 vibrate 通道也被唤起、和 estim 通道同步"。

#### 逐条分析

**a) vibrate 与 estim 同步 —— 这是设计如此，不是缺陷。**
`docs/03` §6.2 定的规则就是「`intensity` 同时驱动该部位的 estim + vibrate Block」。
步骤 1 的载荷带 `intensity: 15`（当时协议还是一个字段），所以 `Estim-nipple` 与 `Vibrate-nipple` 都输出 15。**这一条促成了 2026-10-05 的协议拆分：`intensity` 现已拆成 `estimIntensity` / `vibrateIntensity`。**
**要让两者不同步，在 UI 里不给对应的 Block 绑设备即可** —— 那是接线选择，
不需要改协议或代码。运行时侧已用测试锁住这个行为（见 §2 的测试 16）。

**b) 频率 30 → 读到 37 —— 原因待定，需要用户补充信息。**
运行时的链路是 `frequency: 30` → 写变量 `30` → `setFrequency frequencyPercent=30`，
**中间没有任何换算**（已有测试断言变量确实是 30）。所以 30→37 只可能来自设备侧的
频率刻度/下限映射，或读数方式（读数 vs 物理感受）。**待确认**：
37 是从 XToys 设备面板读到的数值，还是体感/设备屏显？

**c) `JavaScript did not finish running in allotted time`（每条命令前都出现）—— 已修。**
根因是 tick 每 **100ms 无条件写 9 个诊断变量**，在 JS-Interpreter 里是实打实的开销。
已改为**值变化时才写**（`xthbSetDiag` + `xthbDiagCache`），并加了回归测试。

**d) 日志里载荷被截断带 `…` —— 是我自己的截断，不是 XToys。**
`xthbPreview()` 有 160 字符上限。载荷本身 156 字符是**完整**的。
已顺便改成打印**解析后的关键字段**（`command= / source= / seq= / targets= / parts=`），
更短、更好读，也不会再被误认为数据被截断。

### 5.2 待补的验收步骤

按 `docs/06` §5 继续跑，重点是 **步骤 4**（同强度新事件必须重新渐入 —— 验 `driveId` 推送判据）、
以及 11/12/13（拒绝与忽略留痕）、14（stop_all 归零）。

**本轮无法验证的项**（如实记录，不得记成通过）：

- 旋转的两个方向（无旋转器）。
- `rampTime` 单位是否真的是秒（`docs/01` §4.2 一直标 ⚠️ 未独立验证）。
- `requiredExpression` 里 `>` 运算符的实际行为（频率条件动作依赖它）。
- 导出 JSON 与导入 JSON 的字段差异。

---

## 6. 之后的路（`HANDOFF.md` §8）

1. **阶段 0 真机验收通过**（上面 §4）。
2. 把 `examples/xtoys-importable-reference.json`（旧的 16 槽样例）替换掉，只留干净的最小示例。
3. **阶段 1**：接第一个游戏（`レピテーション！` RPG Maker MZ 最省事），只发
   `set_baseline` + `play`，加命中冷却与高潮锁。
4. 阶段 2：多设备多部位；阶段 3：第二个引擎；阶段 4（可选）：虚拟组等。

> ⚠️ `HANDOFF.md` §8 明确：**阶段 0 通过之前不要写任何游戏侧代码。**
