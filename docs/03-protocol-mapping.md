# 协议映射：part → Block（已定论）

> **本文件是「逻辑部位如何变成物理输出」的权威定义。**
> 2026-09-30 讨论定论。`HANDOFF.md` §5、`docs/02-webhook-protocol.md`、`docs/01-xtoys-script-format.md`
> 里的相关段落都指向本文件；有冲突时以本文件为准。
>
> 本文只覆盖**映射与仲裁**。传输封装、命令集合、字段类型仍以 `docs/02-webhook-protocol.md` 为准。

---

## 1. 核心结论

**游戏侧只报告"哪个部位受到了多大刺激"。接收端自己决定这意味着一组什么样的输出。**

`part` 是协议里**唯一的**执行定位键。协议**不包含**任何执行器标识：没有通道名、没有设备名、
没有"逻辑执行器 id"、没有 slot、没有权重、没有组。游戏侧既不知道也不需要知道你接了几台设备。

由此推出三条：

1. **映射表纯粹是接收端配置。** 它是"逻辑部位"与"物理输出槽"之间唯一的知识点，
   完全住在 XToys 侧。换设备、换接线、加执行器，都只改这张表（满足 `HANDOFF.md` §1.2）。
2. **一个 Block 专属一个 part。** Block 不跨 part 共享。接收端配置校验里有硬规则：
   同一个 Block 被配置给两个 part 时**直接拒绝初始化**（这是配置错误，早失败，
   不要让它变成难以察觉的体感问题）。
3. **每个 part 的 Block 集合互不重叠**，所以不存在"两个部位抢同一个物理输出"这件事。
   仲裁只发生在**同一部位内部**（见 §5）。

### 为什么不需要"逻辑执行器 / slot"

讨论过程中曾考虑在 `targets` 里加一个逻辑执行器标识（例如 `slot: "estim-a"`），
用来区分"同一部位的不同执行器"（两条 E-Stim 分别接左、右乳头）。**这个设计被否决**，因为：

- 它要求游戏侧表达比 `part` 表更细的粒度，等于**替游戏侧做部位拆分**，越界且增加协议面。
- 左右乳头在**游戏侧**本来就可以是两个不同的部位标识。游戏侧加一个部位名，
  接收端就少一层概念 —— 分工更干净。
- 因此：**区分粒度在游戏侧解决，接收端不做二次拆分。**

---

## 2. Block 建立规范

Block 是 XToys UI 上的输出槽，也是用户绑定物理设备/子通道的地方。**规则是固定的，加部位加指标照抄。**

### 2.1 命名

设 `{metric} ∈ {estim, vibrate, rotate}`（**变量名与 Channel ID 用通道类型词**，
即 `estim` / `vibrator` / `rotator`；`{part}` 为协议里的逻辑部位名，小写）。

| 对象 | 规范 | 例（nipple + estim / vibrate） |
| --- | --- | --- |
| UI 显示名（Block 名） | `{Metric}-{part}` | `Estim-nipple`、`Vibrate-nipple` |
| Channel ID | `part-{频道类型}-{part}` | `part-estim-nipple`、`part-vibrator-nipple` |
| 输出 Job | `xthb-output-{metric}-{part}` | `xthb-output-estim-nipple` |
| 输出音量变量 | `xthb-{频道类型}-{part}-volume` | `xthb-vibrator-nipple-volume` |
| 输出 ramp 变量 | `xthb-{频道类型}-{part}-ramp-seconds` | `xthb-vibrator-nipple-ramp-seconds` |
| E-Stim 频率变量 | `xthb-estim-{part}-frequency` | `xthb-estim-nipple-frequency` |
| 旋转方向变量 | `xthb-rotator-{part}-direction-code` | `xthb-rotator-nipple-direction-code` |

- `{Metric}` 首字母大写的三种写法固定为 `Estim` / `Vibrate` / `Rotate`；ID 与变量里一律小写。
- ⚠️ **注意 metric 名与通道类型词不同**：Job 名用 `vibrate` / `rotate`，
  而 Channel ID 与变量名用 `vibrator` / `rotator`。这个不一致真实踩过坑：
  生成器与运行时各按一种理解拼名字，结果输出 Job 去读**永远没人写**的变量，
  单元测试还全绿。现在命名规则只有一个真源 `tools/xtoys-naming.mjs`，
  并由 `tools/check-script-contract.mjs` 动态验证"被引用的变量确实有人写"。
- Channel ID 与变量名**不使用序号**：JSON 里看到名字就知道是哪个部位，不用查表。

### 2.2 能表达什么

按此规范，一个 Block 的能力是**由它的 metric 唯一决定**的：

| metric | Channel type | 消费的指标 | 忽略的指标 |
| --- | --- | --- | --- |
| `estim` | `part-estim` | `intensity`、`frequency` | `rotateSpeed` |
| `vibrate` | `part-vibrator` | `intensity` | `frequency`、`rotateSpeed` |
| `rotate` | `part-rotator` | `rotateSpeed`（+ 方向） | `intensity`、`frequency` |

指标与能力对齐规则（这是既有结论，这里只是确认它足够表达全部意图）：

- **强度槽只读 `intensity`，旋转槽只读 `rotateSpeed`，两者互不推导。**
- Block 收到自己不消费的指标时**忽略**它，不报错（游戏侧合法地描述了意图，
  只是这个部位没有那类执行器）。忽略必须留痕，见 §6.2。

### 2.3 本阶段的部位与指标范围

部位名统一用 **`clitoris` / `anus`**（全称），不用 `clit` / `anal`。
理由：协议表里其余 10 个都是解剖名词（`mouth` / `breast` / `vulva` / `vagina` / `urethra` /
`butt` / `penis` / `prostate`），用缩写会开一个需要逐事判断的先例。
**Block 名、Channel ID、变量名、Job 名一律沿用同一部位名**，命令里看到名字就知道是哪个部位。

第一阶段生成下面 **9 个 Block**（4 个部位 × estim + vibrate，另加 1 个旋转样板）：

| 部位 | Block |
| --- | --- |
| `nipple` | `Estim-nipple`、`Vibrate-nipple`、**`Rotate-nipple`（样板）** |
| `clitoris` | `Estim-clitoris`、`Vibrate-clitoris` |
| `vagina` | `Estim-vagina`、`Vibrate-vagina` |
| `anus` | `Estim-anus`、`Vibrate-anus` |

- **`Rotate-nipple` 是唯一的旋转样板**，用来验证 §4.3 的方向 Action 顺序（两个方向 Action
  必须排在速度 Action 之前）。其余部位不生成 rotate。用户当前没有旋转设备，
  所以**这个样板在真机上的行为无法验证**，交付时必须标注「未验证」。
- **本阶段不生成**上述 4 个部位之外任何部位的 Block。用户当前只接了 1 个 E-Stim + 1 个振动器，
  只建当前实际需要的那几个（`HANDOFF.md` §7.1「不要一上来做 16 槽」）。
- 增加部位或指标 = 改一处映射配置 → 重新生成 JSON → 在 XToys 里重新导入并绑定新 Block（§3）。

### 2.4 旋转不是"另一个部位"（用户确认的用法）

用户的说明：**rotate 设备持有率低，游戏侧一般只发 `estim` 与 `vibe` 事件；
游戏侧插件还能提供"启用/关闭 rotate 事件"、甚至"选单部位以哪几种方式发送"的开关。**
后一种开关会让**纯 rotate 的 target 单独出现**，所以接收端必须接受它（见 §6.2.1）。

这条把旋转的定位说清楚了，接收端据此设计：

- **`rotateSpeed` 通常随某个部位的刺激事件一起带上来**：游戏侧发一个 `nipple` target，
  同时带 `intensity` 与 `rotateSpeed`，于是 `Estim-nipple`/`Vibrate-nipple` 消费强度、
  `Rotate-nipple` 消费速度。这落在 §6.2「每条指标各自独立判断」的规则上，不需要额外机制。
- **纯旋转的 target 也完全合法**（只带 `rotateSpeed` + `rotateDirection`）：
  该部位有 rotate Block 就正常驱动；只有 estim/vibrate Block 就忽略那一条指标（§6.2.1）。
- **"启用/关闭 rotate" 是游戏侧的事，不是协议字段。** 接收端不做开关：
  某个部位没配 rotate Block 时，带上来的 `rotateSpeed` 自然被忽略（§6.2）。
  这同时满足 `HANDOFF.md` §1.2「换设备只改 XToys 侧配置」。
- **`rotateSpeed: 0` 算合法指令**，表示"停止该部位的旋转"，此时方向可以省略。

---

## 3. 接收端映射表

映射表是生成 Script 时的配置，形如：

```json
{
  "parts": {
    "nipple":   { "estim": "part-estim-nipple",     "vibrate": "part-vibrator-nipple",     "rotate": "part-rotator-nipple" },
    "clitoris": { "estim": "part-estim-clitoris",   "vibrate": "part-vibrator-clitoris" },
    "vagina":   { "vibrate": "part-vibrator-vagina" },
    "anus":     { "vibrate": "part-vibrator-anus" }
  }
}
```

（这是本阶段的实际形状：9 个 Block，只有 `nipple` 带 rotate 样板。）

- 键是逻辑部位；值是 `metric → Channel ID`。**这张表就是部位名的合法性来源**（§6.1）。
- **缺的 metric 就是"这个部位没有这类执行器"**，该指标被忽略（§6.2），不报错。
- 校验规则（初始化时执行，违反则拒绝初始化）：
  1. 每个 Channel ID 只能出现在**一个** part 下（§1 第 2 条）。
  2. 每个 Channel ID 必须在 `channels` 里存在、且类型与 metric 匹配。
  3. part 名必须是非空字符串。**没有白名单**——表里有的名字就是合法的（§6.1）。

---

## 4. 由映射决定的输出计算（B6 的完整算法）

对每个已配置的 `(part, metric, channel)` 各做一次，分三步：**收集候选 → 仲裁 → 算输出**。

### 4.1 收集候选

```
候选 = []
该 part 的基线意图（若有） → 加入，sequence = 该 source 的基线序号
该 part 所有【未到期】事件的意图 → 逐一加入，sequence = 该事件的 sequence

过滤 1：只保留带了这个 metric 的意图
        （字段存在且 xthbIsFiniteNumber 为真；因此 intensity=0 也是合法候选）
过滤 2：该 part 在这个 metric 下必须配了 Block，否则该指标被忽略并留痕（§6.2）
```

### 4.2 仲裁

三级比较，见 §5：`priority` → 数值 → `sequence`。

### 4.3 算输出

winner 决定该 Block 的**全部**字段：

| 字段 | 算法 |
| --- | --- |
| `value` | winner 的该 metric 值（解析时已夹到 0–100）；**无候选 → 0** |
| `frequency` | 只对 estim Block：由**带 `frequency` 的最高优先意图**决定；**没有任何意图带 `frequency` → 哨兵值（不驱动、保持设备当前频率）**，见 §4.5 |
| `direction` | 只对 rotate Block：`clockwise`→`1`，`counterclockwise`→`-1`；无候选 → `0` |
| `rampSeconds` | `value <= 0` 用 `intent.rampDownMs`，否则用 `intent.rampUpMs`；`/ 1000`；负值视为 `0` |

三个必须遵守的细节：

- **音量与频率各自仲裁，但用同一套三级规则。** 音量 winner 带 `frequency` 时，
  频率自然就是它的值（同一个意图会在两个维度都胜出）；音量 winner **没提**频率时，
  频率由"带频率的最高优先意图"补上 —— 这不是矛盾，而是因为
  **"没提频率" 是"没有意见"，不是"要求不动"**。
  早期实现把频率完全绑定在音量 winner 上，后果是"只发频率"的意图被一个更强的
  音量意图压掉、频率根本不生效（`ok:true` 却什么都没发生）。
- **`frequency` 不能被当作音量**：一个只带 `frequency` 的意图不能让该部位的音量归零。
  此时音量变量根本不写（保持当前输出），只更新频率。
- **ramp 是设备级动作，不是 JS 算的曲线。** JS 只算出"这次写值该用多少秒渐变"，
  真正执行渐变的是 XToys 的 `setVolume.rampTime`。所以 §4.4 必须把 `rampSeconds`
  也算进推送条件。

### 4.3.1 每个 target 的 `durationMs` 各自生效

`durationMs` 定义在 **target** 上（`docs/02` §3），所以到期必须**按部位**判定：
一个事件里 `nipple` 写 200ms、`clitoris` 写 5000ms 时，`nipple` 必须在 200ms 后
就停止参与仲裁。早期实现把整个事件按 `max(durationMs)` 过期，会让 200ms 的一击
持续输出 5 秒 —— 这是**超出游戏要求的刺激时长**，属于必须修的缺陷。

### 4.5 缺省频率 = 保持设备当前值（唯一"缺省 ≠ 0"的指标）

**用户明确的规则：`frequency` 的缺省值应该是 XToys 上当前的值，也就是"不变动"，而不是置零。**

这是三条指标里**唯一**不遵守"缺省即归零"的一条，原因是语义不同：

- `intensity` / `rotateSpeed` 描述"这个执行器现在该出多大力"。缺省 → 没有驱动者 →
  写 **0**（停这个执行器）是对的。
- `frequency` 在 E-Stim 上是**调制方式**，不是刺激量。`intensity = 0` 时设备本来就无输出，
  此时把频率写 0 毫无意义，反而会改变下一次输出的手感/音色。

因此规则是：

| 情况 | 行为 |
| --- | --- |
| winner 的意图**带** `frequency`（含显式 `0`） | 写该值 → 输出 Job 发 `setFrequency` |
| winner 的意图**没有** `frequency` 字段 | **不发 `setFrequency`**，设备频率保持原样 |
| 该部位没有 estim Block | 忽略该指标（§6.2） |

**结构性后果**：输出 Job 里 `setFrequency` 这条 Action **不能无条件存在**，
必须由"本次是否有频率意图"控制。实现上需要一个哨兵值把"没有频率"与"频率 = 0"
区分开（例如频率变量写 `""` 表示不驱动），再用 `requiredExpression` 门控那条 Action。

**连带影响（都要改）**：

1. **Initial Actions 不得把频率归零** —— 启动时保持设备当前频率，只是音量归零。
   这与"启动时把所有已绑定 Block 归零"的安全要求不冲突：归零的是**音量**。
2. **Final Actions 不需要 `setFrequency`** —— 音频停止只需 `setVolume = 0`；
   频率是设置项，不是输出，停 Script 时没有理由动它。
3. **`setMode` 同属"设置项"**（不是当前输出值），只在真的需要时发，
   不作为每次归零的一部分。**待确认**：是否保留为固定动作。

### 4.4 推送条件：值 **或** 驱动者身份变化就要推

**不能只比数值。** 只比数值会让"新事件、强度恰好与当前相同"被静默丢掉 ——
调用方拿到 `{ok:true}`，但体感上什么都没发生（违反 `HANDOFF.md` §3.4 的同类问题）。
但也不能每次都推，那会取消防抖（100 ms tick × 每秒 10 次会刷爆设备）。

正确判据是 **值 + 当前驱动者身份**：

```
每个 Block 记住上次写下的：
  value, frequency, rampSeconds        ← 数值
  driveId = source + "\0" + eventId + "\0" + sequence
            （无候选 / 归零时 driveId = ""）   ← 驱动者身份

推送条件（满足任一）：
  value 变了 | rampSeconds 变了 | frequency 变了 | driveId 变了
```

行为对照：

| 情形 | value | driveId | 结果 |
| --- | --- | --- | --- |
| 稳定输出中，连续多次 tick 无事发生 | 不变 | 不变 | **跳过**（防抖生效，不碰硬件） |
| 基线 20 持续中，来了 `intensity=20` 的 `play` | 不变 | **变** | **推送**，输出 Job 重跑，`rampTime` = 该事件的 `rampUpMs` |
| 该事件到期，回落到基线 | 不变 | **变** | **推送**，重跑一次（升/降各按自己的 ramp） |
| 高优先级事件压过基线（值不同） | 变 | 变 | 推送 |

边界（明确写下来，避免以后重新争论）：

- `driveId` 用 `source + eventId + sequence`。同一 `eventId` 只有更大 `sequence` 才能替换
  （协议 §2），所以游戏侧的"连续同强度攻击"表现为**递增 sequence 的新事件**，
  每次都会换 `driveId` → 每次都走一遍 ramp。这正是连击类游戏需要的。
- **同一个事件自身不会重触发** —— 它只有一个 `rampUp`。要在事件存活期内再抖一次，
  是**游戏侧发新事件**的事（`HANDOFF.md` §7.3：体感问题优先在游戏侧用更简单的方式解决，
  旧实现的自适应 retrigger 已因此被砍）。
- 输出 Job 的 `setVolume` 只带**一个** `rampTime`：按本次写值的走向选 `rampUpMs` 或
  `rampDownMs`，所以升与降各用各自的值，但同一次写入里只有一个数。
- 该 channel 不需要的指标不参与（§2.2）。
- **候选来自同一个 part**：不同 part 之间永不竞争，一个部位的事件不可能驱动另一个部位的输出。

---

## 5. 同一部位内部的仲裁（保留 `priority`）

竞争**只发生在同一部位内部**：基线 vs 有限事件、或两个重叠的有限事件。
规则（三级，与既有实现一致）：

1. `priority` 大者胜（默认 0）
2. 相同则数值大者胜
3. 再相同则 `sequence` 大者胜（更近的意图更贴合当前局面）

有限事件到期后**回落到基线**（不是归零）；总候选为空时归零。

### `priority` 为什么保留

它让游戏侧能表达**"这个效果比那个更重要"，而不必靠抬高数值来抢通道**。
数值是有体感含义的 —— 用抬数值来争抢会真的改变设备输出强度，污染体感。
典型用不上但它唯一能表达的场面：「数值更小但更重要」，例如基线拘束 30、
高潮事件只有 20，没有 `priority` 时高潮会被基线的 30 静默压掉。

代价几乎为零（接收端的比较本来就是三级判断），所以保留。默认 0，不发就等于没有它。

---

## 6. 边界情形

### 6.1 无法识别的部位 → 忽略并留痕

**没有"协议部位白名单"这回事。** 一个部位名是否可用，完全由**接收端映射配置**决定：
映射表里有这个 part 就按表驱动，没有就**忽略并留痕，不报错、不整体拒绝**。

理由（用户指出）：白名单是多余的 —— 既然"映射表里没有这个部位"和"白名单里没有这个部位"
处理上毫无区别，就不该存在两套判断。**部位名的合法性由配置定义。**

因此解析阶段对 `part` 的唯一要求是：**非空字符串**。其余判定全部推到映射查找：

| 情况 | 处理 |
| --- | --- |
| `part` 不是非空字符串 | 整体拒绝（`invalid_targets`）—— 字段本身畸形 |
| `part` 是字符串，但不在映射配置里 | **忽略并留痕**（与 §6.2 同一条路径） |
| `part` 合法，但该 metric 没有对应 Block | **忽略并留痕**（§6.2） |

**唯一仍然整体拒绝的是同一个 `targets` 数组里同部位重复**（§6.5）——
那是数组本身的语法问题（会造成静默覆盖），不是"部位名合不合法"的问题。

### 6.2 指标与 Block 的对应：三条指标各自独立

**一个部位在 `targets` 里只出现一次**（§6.5），该部位的所有指标合并在同一条里。
接收端按下表把指标分派到该部位的 Block。**每条指标各自独立判断，没有主次或门控关系**：
有哪个指标就驱动对应的 Block，没有对应 Block 就忽略那一条。

| 指标 | 驱动什么 | 没有对应 Block 时 |
| --- | --- | --- |
| `intensity` | 该部位的 **estim + vibrate** Block | 忽略并留痕 |
| `frequency` | 该部位的 **estim** Block（`vibrate` 永不消费频率） | 忽略并留痕 |
| `rotateSpeed` + `rotateDirection` | 该部位的 **rotate** Block | 忽略并留痕 |

**`intensity` 与 `frequency` 是 estim Block 上的两个独立维度**，不是"主指标 + 附加项"：

- 只带 `intensity`：改音量，频率保持设备当前值。
- 只带 `frequency`：**只改频率，音量变量根本不写**（不能把正在输出的强度拽到 0）。
- 两个都带：音量与频率取同一个意图（它在两个维度都胜出）。

**什么算"可驱动指标"**（用于判断一条 target 是不是空的）：

- `intensity` 出现即算（含 `0`）
- `frequency` 出现即算（含 `0`）
- `rotateSpeed` 出现即算（**含 `0`**）
- `rotateDirection` **单独**出现不算

**一条 target 的驱动指标一个都没有** → 畸形输入，**整体拒绝**。
唯一的现实例子是一条只带 `rotateDirection` 的 target；这等同于"什么也没说"，
留着它只会让人误以为已经生效。

**方向约束**（`webhook-protocol.md` §3 既有规则，这里只明确 `0` 的情形）：

- `rotateSpeed > 0` → **必须**给 `rotateDirection`，否则拒绝（`invalid_rotate_direction`）。
- `rotateSpeed == 0` → 方向**可以省略**，视为"停止该部位的旋转"。

### 6.2.1 rotate 可以单独出现（用户确认）

用户的说明：之后游戏侧可能会加"选择单部位以哪几种方式发送"的开关，
那时就会出现**只有 rotate 的情况**；如果 XToys 侧该部位只有 rotate Block、
没有 estim/vibrate Block，直接忽略掉那两条即可。

因此**不设"`intensity` 是唯一驱动入口"这类规则**。纯旋转 target
（只带 `rotateSpeed` + `rotateDirection`）是**完全合法**的：

- 该部位有 rotate Block → 正常驱动旋转。
- 该部位只有 estim / vibrate Block → 忽略并留痕（游戏侧开了 rotate、但这个部署没接旋转器，
  属于正常情况，见 §6.2 的"没有对应 Block"一列）。

这也修正了本文档早先版本里"rotate 必须与 intensity 同在"的说法 —— 那条已作废。

### 6.2.2 忽略的留痕

被忽略的部位/指标必须留痕：累计计数 + 最近一次被忽略的 `part`/指标，写进诊断变量并在日志里记一条。
否则游戏侧发错部位名时会表现为"什么都没发生"，无法定位。
计数与日志措辞遵守 `HANDOFF.md` §3.4：只能说"XToys 调用未抛异常"，不得声称设备状态。

### 6.3 虚拟组

`docs/02-webhook-protocol.md` §4 的虚拟组（`genitals`、`lower_body`、`double_hole`、
`whole_body`、`mixed`）与 §1「一个 Block 专属一个 part」**直接冲突**：组会落到多个部位的
Block 上，而"组"本身没有专属 Block。

**决定：本阶段不做虚拟组。** 游戏侧能区分时直接发叶子部位；区分不了时，
游戏侧自己选一个叶子部位（或发多个 target）来近似。
`HANDOFF.md` §12 原本就写"默认先不做"，这里把它确定为不做，并说明冲突原因。

### 6.4 `stop` 的选择器

因为 part 与 Block 是 1:1 对应且互不共享，`stop` 里只给 `targets`（不给 `eventId`）
就是明确的："移除该来源所有事件中这些部位的目标"。不存在语义歧义，**保留**三种形式：

- 只给 `eventId`：移除整个事件
- `eventId` + `targets`：只移除该事件里列出的部位
- 只给 `targets`：移除该来源所有事件中的这些部位

三种都不匹配任何东西时返回 `missing_stop_selector`（拒绝，不是静默成功）。

### 6.5 一个部位在 `targets` 里只出现一次

**正确写法是"一个部位一条 target"，该部位的所有指标合并在同一条里：**

```json
"targets": [
  { "part": "vagina", "intensity": 40, "rotateSpeed": 60, "rotateDirection": "clockwise", "durationMs": 900 }
]
```

**同一部位在一个 `targets` 数组里出现两次是非法写法，整体拒绝**（`invalid_targets`）。

用户的明确表述：

> 「不应该出现这种写法，在逻辑设计的语法里就应该避免这种情况。就算同一个设备
> estim/vibe/rotate 同时工作也应该合并为一条。」

理由：`targets` 在接收端被整理成"部位 → 意图"的表，重复的部位会**静默覆盖**前一条
（丢数据、没有任何迹象）。而这个写法本身没有存在理由 —— estim / vibrate / rotate
同时工作时合并为一条即可。**在语法层面禁止它，比让引擎去猜测意图安全得多。**

### 6.6 每个 target 的 `durationMs` 独立到期

见 §4.3.1。同一事件里不同部位可以有不同的存活时长；短的到期后即停止参与仲裁，
不会被同一事件里更长的部位拖着继续输出。

### 6.7 空 `targets` 的区分

| 命令 | `targets: []` 的含义 |
| --- | --- |
| `set_baseline` | **合法**：清空该来源的基线快照（`docs/02` §5） |
| `play` / `update` | **拒绝**：没有任何目标就没有正 `durationMs`，属于畸形输入；不能让它变成一个"accepted 但什么也不做"的命令 |
| `stop` | **拒绝**（`missing_stop_selector`）：空选择器什么都没指 |

---

## 7. 讨论状态：映射与仲裁已全部定论

本文件覆盖的**全部**待议项都已定，没有遗留分歧：

| 待议项 | 结论 |
| --- | --- |
| 映射住在哪一侧 | 纯接收端配置；协议不含任何执行器标识（§1） |
| 要不要逻辑执行器 / slot | 不要。`part` 是唯一的执行定位键（§1） |
| 一个 part 对应几条通道 | 一组**专属** Block，Block 不跨 part 共享（§1、§3） |
| Block 建立规范 | `{Metric}-{part}` / `part-{metric}-{part}` 等，见 §2.1 |
| 部位命名 | 全称 `clitoris` / `anus`（§2.3） |
| 旋转路径 | 只生成 `Rotate-nipple` 样板，真机未验证（§2.3） |
| rotate 的定位 | 随刺激事件带上的指标；**纯 rotate 的 target 合法**（§2.4、§6.2.1） |
| 指标不匹配 | 每条指标各自独立，忽略并留痕，不报错（§6.2） |
| target 是否为空 | 驱动指标（`intensity` / `frequency` / `rotateSpeed`，含 `0`）一个都没有才拒绝（§6.2） |
| 虚拟组 | 不做（§6.3、`webhook-protocol.md` §4） |
| 同部位重复 target | 非法写法，整体拒绝（§6.5） |
| 仲裁粒度 | 通道独占，只在同一部位内部竞争（§5） |
| `priority` | 保留（§5） |

### 动代码时的改动范围

1. `tools/build-xtoys-script.mjs`：改成按 §3 映射表生成 **9 组** channel + Job + 变量；
   `BRIDGE_CONFIG` 换成 §3 的形状；命名按 §2.1。
2. `src/xtoys-bridge.js`：`xthbChannelMapFor()` 改为查映射表；候选收集按 part 分组；
   增加"Block 专属一个 part"的配置校验（§3 校验规则）；增加被忽略部位/指标的留痕（§6.2.1）；
   增加同部位重复 target 拒绝（§6.5）与 §6.2 的四条门控规则。
3. 修掉旧的 3 处已知缺陷（错误形状归一化、`missing_stop_selector`、显式 `null`），
   详见 `docs/07-stage0-status-and-todo.md` §2。
