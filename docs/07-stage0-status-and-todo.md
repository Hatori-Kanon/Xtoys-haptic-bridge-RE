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
| **真机启动** | ⚠️ **首次失败**（配置读不到 → 运行时静默），已修，**待你重新导入复测** |
| **真机验收（14 步）** | ❌ **未执行** —— 需要你在 XToys 里导入、绑定设备、跑脚本 |
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

### 1.2 仍待确认

- 这次修法**尚未经过真机复测**。重新导入后请确认日志出现
  `初始化完成：部位 4 个，Block 9 个（配置来源：…）`。
- **`updateVariable` → `getVariable` 为什么打坏 494 字符的 JSON 字符串：未知。**
  参考实现用同样的动作传了 1763 字符的配置且能导入，所以不像是单纯的长度上限。
  这个问题值得单独探针验证（见 §4 待办），但在配置走注入路之后它**不再阻塞阶段 0**。

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

## 5. 真机验收结果（**待填写**）

> 跑完 `tools/Invoke-XtoysAcceptance.ps1` 后把汇总表粘到这里。

| 步骤 | 结果 | 备注 |
| --- | --- | --- |
| 1 E-Stim 基线 | 待填写 | |
| 2 振动基线 | 待填写 | |
| 3 瞬态 + 到期回基线 | 待填写 | |
| 4 同强度重推 | 待填写 | |
| 5 frequency 显式 | 待填写 | |
| 6 frequency 缺省不变 | 待填写 | |
| 7 旋转顺时针 | **无法验证**（无旋转器） | |
| 8 旋转反向 | **无法验证**（无旋转器） | |
| 9 多部位独立 | 待填写 | |
| 10 priority 接管 | 待填写 | |
| 11 未识别部位被忽略 | 待填写 | |
| 12 重复部位被拒绝 | 待填写 | |
| 13 sequence 未递增被拒 | 待填写 | |
| 14 stop_all 归零 | 待填写 | |
| 收尾 手动停 Script | 待填写 | |

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
