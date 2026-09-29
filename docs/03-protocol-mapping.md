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

设 `{metric} ∈ {estim, vibrate, rotate}`，`{part}` 为协议里的逻辑部位名（小写）。

| 对象 | 规范 | 例（nipple + estim） |
| --- | --- | --- |
| UI 显示名（Block 名） | `{Metric}-{part}` | `Estim-nipple` |
| Channel ID | `part-{metric}-{part}` | `part-estim-nipple` |
| 输出 Job | `xthb-output-{metric}-{part}` | `xthb-output-estim-nipple` |
| 输出变量（值） | `xthb-{metric}-{part}-value` | `xthb-estim-nipple-value` |
| 输出变量（ramp 秒） | `xthb-{metric}-{part}-ramp-seconds` | `xthb-estim-nipple-ramp-seconds` |
| 输出变量（E-Stim 频率） | `xthb-{metric}-{part}-frequency` | `xthb-estim-nipple-frequency` |

- `{Metric}` 首字母大写的三种写法固定为 `Estim` / `Vibrate` / `Rotate`；ID 里一律小写。
- Channel ID 与变量名**不使用序号**：JSON 里看到名字就知道是哪个部位，不用查表。
- `{part}` 一律用协议里的名字（`clit` 在协议里就叫什么就写什么，见 §2.3）。

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

- 键是逻辑部位；值是 `metric → Channel ID`。
- **缺的 metric 就是"这个部位没有这类执行器"**，该指标被忽略（§6.2），不报错。
- 校验规则（初始化时执行，违反则拒绝初始化）：
  1. 每个 Channel ID 只能出现在**一个** part 下（§1 第 2 条）。
  2. 每个 Channel ID 必须在 `channels` 里存在、且类型与 metric 匹配。
  3. 每个 part 名必须在协议部位白名单里。

---

## 4. 由映射决定的输出计算

```
tick:
  for each 已配置的 (part, metric, channel):
      候选 = 该 part 的基线意图  ∪  该 part 所有未到期的有限事件意图   （取该 metric 的值）
      winner = 按 §5 规则选出
      该 channel 的目标值 = winner 的值（无候选则 0）
```

关键点：

- **候选来自同一个 part**。不同 part 之间永不竞争，因此一个部位的事件不可能驱动另一个部位的输出。
- 该 channel 不需要的指标不参与（§2.2）。
- 值没变就跳过写变量、跳过启动 Job（唯一的防抖优化，`HANDOFF.md` §7.2）。

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

### 6.1 未知部位

`part` 不在协议白名单里 → **整体拒绝**该次载荷，不部分写入（沿用既有结论）。

### 6.2 指标与 Block 的对应：三条指标各自独立

**一个部位在 `targets` 里只出现一次**（§6.5），该部位的所有指标合并在同一条里。
接收端按下表把指标分派到该部位的 Block。**每条指标各自独立判断，没有主次或门控关系**：
有哪个指标就驱动对应的 Block，没有对应 Block 就忽略那一条。

| 指标 | 驱动什么 | 没有对应 Block 时 |
| --- | --- | --- |
| `intensity` | 该部位的 **estim + vibrate** Block | 忽略并留痕 |
| `frequency` | 该部位的 **estim** Block（`vibrate` 永不消费频率） | 忽略并留痕 |
| `rotateSpeed` + `rotateDirection` | 该部位的 **rotate** Block | 忽略并留痕 |

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
