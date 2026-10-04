# 游戏侧桥接插件编写指南

> **本文是自包含的。** 只读这一篇，就能写出一份能和 XToys 接收端对得上的游戏侧插件。
>
> 适用对象：要为某个游戏写"把游戏事件转发给 XToys"桥接的人或智能体。
> 不需要了解 XToys 脚本内部实现，也不需要读本项目的其它文件。

---

## 0. 系统是什么、边界在哪

```
┌──────────────────┐   逻辑意图：哪个部位、多大强度、多久    ┌─────────────────────┐
│  游戏侧桥接（你写）│ ───────────────────────────────────► │  XToys Script（已有） │
│  读游戏内部状态    │   POST Webhook                        │  裁决 + 驱动物理设备   │
└──────────────────┘                                       └─────────────────────┘
```

**接收端（XToys 侧）是怎么工作的**，理解这一点你才知道边界在哪：

- XToys Script 里有一组**输出槽**，每个槽对应一个物理执行器或它的一个子通道
  （例如"某部位的 E-Stim"、"某部位的振动"、"某部位的旋转"）。
- **用户**在 XToys 界面上把这些槽绑定到自己的实际设备。**你既不知道也不需要知道**
  用户接了几台设备、每个槽绑到了什么。
- 你发出的每条命令说的是："**某个逻辑部位**现在应该有**多大强度**"。
  接收端查一张**映射表**（用户配置的），决定这个部位的这一路强度写到哪个槽。
- 接收端每 **100 ms** 计算一次每个槽当前该输出多少，然后把结果写给设备。
  所以**你不需要自己控制发送节奏**——密集事件天然会在接收端被合并。

**三条硬边界**（越界就会破坏整个设计的解耦）：

1. 🚫 **代码里不得出现设备名、通道名、输出槽名。** 你只发**逻辑部位**。
2. 🚫 **不得试图控制设备的最大强度 / 最大旋转速度。** 那是用户在 XToys 设备设置里的
   选择；协议里也没有这样的字段。
3. 🚫 **不要自己实现"部位 → 设备"的映射。** 那是接收端的配置，用户改配置时不需要动你。

**你负责的只有三件事**：读游戏状态 → 翻译成逻辑部位+强度 → 按协议发出去。

---

## 1. 传输：怎么发

```
POST https://webhook.xtoys.app/<Webhook ID>
Content-Type: application/json
```

`<Webhook ID>` 由用户在 XToys 里生成并提供给你（**不要把它硬编码进提交的文件**；
用运行时配置或用户输入）。

Body 是**固定外层封装**：

```json
{
  "action": "xtoys_game_bridge",
  "payload": "<内层协议对象的 JSON 字符串>"
}
```

- `action` 是**固定的路由名**，永远是 `xtoys_game_bridge`。**不要**换成游戏事件名。
- `payload` 必须是**字符串**：先把内层对象 `JSON.stringify`，再作为字符串放进 `payload`。
  **不要**把内层对象直接嵌进去。

### 1.1 ⚠️ HTTP 200 不代表命令生效

**实测确认：接收端对会被整体拒绝的载荷也返回 HTTP 200。**

所以：

- **不要**用 HTTP 状态码或响应体判断成功。
- 想知道命令是否被接受，只能看 **XToys 的 Script 日志**（见 §8）。
- 因此请不要设计"发送失败就重试"的逻辑 —— 你无法从返回值区分"成功"和"被拒绝"。
  重复投递反而可能造成重复刺激（接收端会用序号挡掉一部分，见 §5.4）。

---

## 2. 内层协议对象

### 2.1 字段总表

| 字段 | 类型 | 必填性 | 说明 |
| --- | --- | --- | --- |
| `protocolVersion` | number | **必填** | 固定为 `1` |
| `command` | string | **必填** | 见 §2.2 |
| `source` | string | **必填** | 你的插件标识。≥1 字符，≤64 字符，**禁含控制字符**。同一插件用同一个值即可 |
| `eventId` | string | `play`/`update` 必填 | 一次有限事件的标识，≤64 字符，**禁含控制字符** |
| `sequence` | number | 见 §2.2 / §5.4 | 同 `source + eventId` 的版本号，必须**严格递增** |
| `targets` | array | 视命令 | 目标列表，见 §3 |

### 2.2 六个命令

| 命令 | 作用 | 什么时候用 |
| --- | --- | --- |
| `play` | 创建/替换一个**有限事件**（必须带正 `durationMs`，到期自动消失） | 一次攻击、一次命中、"现在这一下" |
| `update` | 用**更高的 `sequence`** 替换同一 `source+eventId` 的**整个** target 集 | 同一事件要改强度、或换旋转方向 |
| `stop` | 提前结束某个事件 / 某些部位 | 攻击被打断、状态提前解除 |
| `set_baseline` | 替换该 `source` 的**基线快照**（持续状态，没有时长） | 异常状态、拘束阶段、持续发情 |
| `stop_all` | **紧急全停**：清空所有来源的所有状态 | 战斗结束、退出游戏、玩家急停 |
| `test` | 只校验格式，**不驱动任何硬件** | 联调时确认协议写对没有 |

各命令对 `eventId` / `sequence` / `targets` 的要求：

| 命令 | `eventId` | `sequence` | `targets` |
| --- | --- | --- | --- |
| `play` / `update` | **必填** | **必填**（严格递增） | **必填且非空** |
| `set_baseline` | 不用（给了也忽略） | **必填**（同样严格递增，见 §5.5） | 必填；**可以是空数组**（= 清空基线） |
| `stop` | 可选 | 不用 | 可选；至少要给 `eventId` 或 `targets` 之一 |
| `stop_all` | 不用 | 不用 | 不用 |
| `test` | 不用 | **不用** | 必填 |

### 2.3 三个命令的例子

**一次命中（`play`）**：

```json
{
  "protocolVersion": 1,
  "command": "play",
  "source": "my-game",
  "eventId": "hit-0042",
  "sequence": 1,
  "targets": [
    { "part": "nipple", "estimIntensity": 65, "frequency": 40,
      "durationMs": 900, "rampUpMs": 120, "rampDownMs": 180, "priority": 10 }
  ]
}
```

**持续状态（`set_baseline`）**：

```json
{
  "protocolVersion": 1,
  "command": "set_baseline",
  "source": "my-game",
  "sequence": 7,
  "targets": [
    { "part": "nipple", "estimIntensity": 20, "vibrateIntensity": 20, "frequency": 30 }
  ]
}
```

**紧急全停（`stop_all`）**：

```json
{ "protocolVersion": 1, "command": "stop_all", "source": "my-game" }
```

---

## 3. `targets`：协议的核心

### 3.1 一条 target 的完整字段

| 字段 | 类型 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `part` | string | **必填** | **逻辑部位**，见 §4 |
| `estimIntensity` | number 0–100 | 缺失 | **E-Stim 那一路**的强度。缺失 = 不驱动 E-Stim |
| `vibrateIntensity` | number 0–100 | 缺失 | **振动那一路**的强度。缺失 = 不驱动振动 |
| `frequency` | number 0–100 | 缺失 | 仅 E-Stim 的频率。**缺失 = 保持设备当前频率**（见 §5.3） |
| `rotateSpeed` | number 0–100 | 缺失 | 旋转速度。**不从任何强度推导** |
| `rotateDirection` | `clockwise` / `counterclockwise` | 缺失 | `rotateSpeed > 0` 时**必填** |
| `durationMs` | number ≥ 1，≤ 600000 | 缺失 | **仅 `play`/`update` 需要**，必须为正 |
| `rampUpMs` | number ≥ 0，≤ 600000 | `0` | 数值**升高**时的渐入时间（毫秒） |
| `rampDownMs` | number ≥ 0，≤ 600000 | `0` | 数值**降低 / 停止 / 到期**时的渐出时间 |
| `priority` | number | `0` | 同部位多来源竞争时的**第一级**判据，见 §5.6 |

**所有数值必须是有限数。** 你没有、也不应该有办法设置设备的最大强度或最大旋转速度。

### 3.2 ⭐ 三条最容易错、且会静默出错的规则

**规则一：一个部位在一条命令的 `targets` 里只能出现一次。**

❌ 错（第二条会覆盖第一条，静默丢数据）：

```json
"targets": [
  { "part": "nipple", "estimIntensity": 40, "durationMs": 900 },
  { "part": "nipple", "rotateSpeed": 60, "rotateDirection": "clockwise", "durationMs": 900 }
]
```

✅ 对（同一部位的所有指标**合并成一条**）：

```json
"targets": [
  { "part": "nipple", "estimIntensity": 40, "rotateSpeed": 60,
    "rotateDirection": "clockwise", "durationMs": 900 }
]
```

> 重复部位会被**整体拒绝**（`invalid_targets`），不会部分生效。

**规则二：`estimIntensity` 与 `vibrateIntensity` 是两条独立通道，互不推导。**

- 只给 `estimIntensity` → **只有 E-Stim 动，振动完全不动**
- 只给 `vibrateIntensity` → 只有振动动
- 两个都给 → 两条通道各按各的值输出

这一条是**有意设计**的：让"同一部位同时使用 E-Stim 与振动"的设备能被分别控制。

✅ 双模设备写法（同一部位：E-Stim 强、振动弱）：

```json
"targets": [
  { "part": "nipple", "estimIntensity": 80, "vibrateIntensity": 20,
    "frequency": 55, "durationMs": 900 }
]
```

> ⚠️ **没有 `intensity` 这个字段。** 早期版本用一个 `intensity` 同时驱动两条通道，
> **已废除**。发 `intensity` 会被当成"没有驱动指标"而**整体拒绝** ——
> 这是有意的，静默忽略会让你以为生效了。

**规则三：一条 target 至少要有一个"驱动指标"。**

驱动指标 = `estimIntensity` / `vibrateIntensity` / `frequency` / `rotateSpeed`
（**出现即算，含 `0`**）。`rotateDirection` 单独出现**不算**。

❌ 会被整体拒绝（等同于"什么也没说"）：

```json
"targets": [ { "part": "nipple", "rotateDirection": "clockwise", "durationMs": 500 } ]
```

### 3.3 数值非法或超范围时的行为

| 情况 | 行为 |
| --- | --- |
| 数值超出 0–100 | **夹取**到边界（不报错） |
| 显式 `null` / 字符串 / `NaN` / 布尔值 | **整体拒绝**（不猜你的意图） |
| `play`/`update` 缺 `durationMs` 或 ≤ 0 | 整体拒绝 |
| `rotateSpeed > 0` 但没给方向 | 整体拒绝 |
| 一条 target 一个驱动指标都没有 | 整体拒绝 |
| `source` / `eventId` 含控制字符（U+0000–U+001F、U+007F） | 整体拒绝 |
| 一条命令的 `targets` 超过 16 条 | 整体拒绝 |
| `payload` 字符串超过 16384 字符 | 整体拒绝 |

> **"整体拒绝" = 整条命令都不生效**，不会部分应用。
> 接收端的设计原则是：宁可什么都不做，也不做一半让你以为成功了。

---

## 4. ⭐ `part` 该写什么（最容易静默失效的地方）

### 4.1 部位名是**可扩展的**，但有命名规范

**部位名不是固定的一份硬编码清单。** 它是"逻辑部位"的标识，可以按需要增加 ——
只要游戏里有某个部位需要单独驱动，就可以为它增加一个部位名。

**约定（请严格遵守，否则接收端侧扩不了）：**

1. **一律使用解剖学英文全称，小写。**
   例如 `clitoris`（不是 `clit`）、`anus`（不是 `anal`）、`breast`（不是 `chest`）。
2. **多个词用下划线连接**，例如 `left_nipple`、`inner_thigh`。
3. **只表示"哪个部位"，不表示"什么动作/什么设备"。**
   ❌ 不要 `estim_nipple`、`vibrate_mode2`、`hit_left` —— 那是设备或事件的概念，
   不是部位。部位名应当与"用什么设备、什么事件"完全无关。
4. 名称一经使用就**不要改**（接收端配置与游戏侧必须完全一致）。

### 4.2 已定义的标准部位名

下面这批已经定义好、可直接使用（**符合上面的规范**）：

```
mouth    breast   nipple   armpit   clitoris   vulva
vagina   urethra  anus     butt     penis      prostate
```

⚠️ **要用其中的名字时，一律用全称**：`clitoris` 不是 `clit`，`anus` 不是 `anal`。

**游戏里有别的部位需要单独驱动？** → 按 §4.1 的规范起一个名字，然后：

> **和接收端维护者确认这个名字，并让它在接收端配置里加上对应的输出槽。**
> 接收端加一个部位 = 改配置 + 重新导入 Script + 在界面上绑定新槽。
> **游戏侧只需要使用约定好的那个名字**，不需要知道加了几个槽。

### 4.3 为什么这可能是"没反应"的头号原因

**接收端没有部位白名单**，一个部位名是否生效**完全取决于它在接收端配置里存不存在**。

- 你发了一个**配置里没有**的部位 → **该部位被静默忽略**：
  设备毫无反应，HTTP 仍然返回 200，你那边看不出任何异常。
- 你发了一个**配置里有、但用户没接那类设备**的部位 → 同样忽略
  （例：该部位只配了振动，你发了 `estimIntensity`）。

**所以写插件的第一步不是写代码，是产出一张表：**

> **游戏内部状态 → 逻辑部位名（§4.2 里的标准名，或按 §4.1 新约定的名字）**

然后**和接收端维护者确认哪些部位已配置、每个部位有哪些通道**。

### 4.4 当前接收端的默认配置（供参考）

默认一份配置里包含 4 个部位：

| 部位 | 可用通道 |
| --- | --- |
| `nipple` | E-Stim + 振动 + 旋转（旋转是语法样板，通常未接设备） |
| `clitoris` | E-Stim + 振动 |
| `vagina` | E-Stim + 振动 |
| `anus` | E-Stim + 振动 |

**这 4 个之外的名字会被忽略。** 需要更多部位时，让用户在接收端配置里加
（加完要重新导入 Script 并在界面上绑定新槽），你这边只需用规范名。

### 4.5 ⚠️ 不要用"虚拟组"或游戏内部键名

有两类名字**看着合理但会被忽略**：

1. **虚拟组**（`genitals`、`whole_body`、`lower_body`、`double_hole` 等）——
   本协议**不支持**。因为一个输出槽只归属一个部位，"组"会同时落到多个部位，语义冲突。
   → 要影响多个部位就**发多条 target**。
2. **某个游戏探针文档里记录的内部键名**（例如 `generic_ep`、`chest`、`lower`、
   `abuse`、`clit_penis`、`futanari`）—— 那些是**游戏内部状态的记录**，**不是协议名**。
   → 必须翻译成 §4.2 的标准部位名（`chest` → `breast`，`lower` → `vagina`/`clitoris` 等）。

### 4.6 怎么判断是不是被忽略了

看 XToys 日志（§8）：

- `ignored 部位 X 未在映射配置里` → **部位名不在用户配置里**，改名字或让用户加配置
- `ignored X 没有 Y 对应的 Block` → 部位合法，但用户没接那类设备（正常）

---

## 5. 状态语义（搞错会造成"设备莫名停住 / 莫名一直动"）

### 5.1 有限事件 vs 基线

| | 有限事件（`play` / `update`） | 基线（`set_baseline`） |
| --- | --- | --- |
| 生命周期 | 有 `durationMs`，**到期自动消失** | 一直持续，直到被新快照替换或 `stop` |
| 用途 | 一次攻击 / 命中 | 持续状态：拘束、异常状态、发情 |
| 到期后 | **回落到基线**（若该部位有基线），否则归零 | — |

**典型组合**：用 `set_baseline` 给一个持续底噪，攻击用 `play` 叠加在上面。
到期后自动回到基线 —— 你不需要手动"恢复"。

### 5.2 ⭐ 基线是**完整快照**，漏写的通道会被清除

`set_baseline` 替换该 `source` 的**整份**快照。**快照里没写的部位会被清除**，
**而且粒度一直到通道**：

> 某部位只写了 `estimIntensity`、**没写** `vibrateIntensity`
> → **该部位的振动基线被清除（振动停止）**。

这**不是**"保持不变"，是"你没提，所以取消"。

✅ 正确做法 —— 发持续状态时，**把该部位所有需要持续的通道都写进同一条快照**：

```json
"targets": [
  { "part": "nipple", "estimIntensity": 20, "vibrateIntensity": 20, "frequency": 30 }
]
```

> 对比：`play`/`update`（有限事件）**不**影响基线。一个只带 `estimIntensity` 的命中事件
> 不会碰该部位的振动基线。

清空该来源的全部基线（不影响有限事件）：

```json
{ "protocolVersion": 1, "command": "set_baseline", "source": "my-game",
  "sequence": 8, "targets": [] }
```

### 5.3 `frequency` 缺省 ≠ 0

**不给 `frequency` = 保持设备当前频率**，不是置零。

原因：频率是 E-Stim 的**调制设置**，不是刺激量。"强度 0 时把频率写 0"没有意义，
只会改变下一次输出的手感。

| 你想做的 | 怎么写 |
| --- | --- |
| 改频率 | 显式给 `frequency` |
| **不要动频率** | **根本不写这个字段**（不要写 `"frequency": 0`） |
| 把频率设为最低 | 显式 `frequency: 0` |

⚠️ **`frequency` 是百分比（0–100），不是绝对频率。** 它映射到设备自身的频率范围。
例如 XToys 默认频率范围是 **10–100**，那么 `frequency: 30` 在设备上落在
`10 + 30% × 90 ≈ 37` —— **读数与发送值不一致是正常的**，不是偏差。
`frequency: 0` 会落在范围下限 10（最低频），**不代表"关闭频率"**。

### 5.4 `sequence` 必须严格递增（否则命令被静默丢弃）

同一 `source + eventId`，只有**严格更大的 `sequence`** 才生效。相同或更小的会被拒绝
（`invalid_sequence`）—— 这是为了防止"重复投递变成重复刺激"。

简单做法：每个 `eventId` 自己维护一个递增计数。

```js
const seq = (seqMap[eventId] = (seqMap[eventId] || 0) + 1);
```

- 想开始一个"新事件"，**换一个 `eventId`**（各自独立计数）。
- **不要把同一个 `eventId` 的计数重置回小值。**
- 事件到期后，它的序号栅栏**还会保留 10 分钟**（继续挡重复投递），
  所以重开同一个 `eventId` 也必须用更大的序号。

### 5.5 ⚠️ 基线序号也有栅栏，而且**跨 `stop_all` 保留**

`set_baseline` 的 `sequence` 同样必须比该 `source` 上一次的**严格更大**。

**`stop_all` 会清掉所有状态，但不会清这个栅栏** —— 之后同一 `source` 的
`set_baseline` **仍然必须用更大的序号**。

**所以你的插件必须持久化"我已经用到第几号"。** 否则：战斗结束发了 `stop_all`，
再开一场时用回小序号 → **基线发不出去**（被静默拒绝），表现是"状态怎么都不生效"。

两种做法：

| 做法 | 说明 |
| --- | --- |
| `source` 带会话标识 | 如 `"my-game-s3"`，每次重开游戏换一个 `source`。简单，推荐 |
| 持久化序号 | 把序号存进存档或配置文件，重启后继续递增 |

### 5.6 `priority`：让"数值更小但更重要"的事件生效

竞争**只发生在同一个部位内部**（不同部位永不互相影响）。判定顺序：

1. **`priority` 大者胜**（这里的字段）
2. 相同则**数值大者**胜
3. 再相同则**序号大者**胜

**为什么需要它**：数值是有体感含义的。如果只靠"把数值抬高"来抢输出，
那会真的改变设备强度、污染手感。用 `priority` 可以表达"这个更重要"，而不动数值。

典型用法：高潮事件 `priority: 10`，即使它的强度数值比当前基线**更小**，
也能盖过基线。

默认 `0`，不需要就完全不写。

### 5.7 旋转不会自动反向

要换方向必须**显式发新的 `rotateDirection`**（用 `update` 带更高 `sequence`）。
只改速度不会反向。

---

## 6. 代码骨架（可直接改用）

### 6.1 JavaScript（RPG Maker 插件、网页环境可直接用）

```js
// ── 配置 ──
// ⚠️ 真实 Webhook ID 不要硬编码进提交的文件，让用户填
var WEBHOOK_ID = '';
var SOURCE     = 'my-game';       // 稳定标识；重开一局可换成 'my-game-s2' 等

// 基线序号：必须持久化（跨 stop_all 保留），见 §5.5
var baselineSeq = 0;
// 每个 eventId 自己的序号
var eventSeq = {};

function postCommand(inner) {
  var body = JSON.stringify({
    action: 'xtoys_game_bridge',
    payload: JSON.stringify(inner)        // ← 内层必须是【字符串】
  });
  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://webhook.xtoys.app/' + WEBHOOK_ID, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(body);
  // ⚠️ 不要用返回值判断是否生效：HTTP 200 也可能被拒绝，见 §1.1
}

// 有限事件（一次命中）
function sendHit(part, opts) {
  opts = opts || {};
  var eid = opts.eventId || (part + '-' + Date.now());
  eventSeq[eid] = (eventSeq[eid] || 0) + 1;

  var t = {
    part: part,
    durationMs: opts.durationMs || 900,
    rampUpMs:   opts.rampUpMs   || 0,
    rampDownMs: opts.rampDownMs || 0
  };
  // 只写你真正想驱动的通道（不写 = 不驱动那条通道）
  if (opts.estim   != null) t.estimIntensity   = opts.estim;
  if (opts.vibrate != null) t.vibrateIntensity = opts.vibrate;
  if (opts.rotateSpeed != null) {
    t.rotateSpeed = opts.rotateSpeed;
    t.rotateDirection = opts.rotateDirection || 'clockwise';  // >0 时必填
  }
  // frequency：想改才写；不写 = 保持设备当前频率
  if (opts.frequency != null) t.frequency = opts.frequency;
  if (opts.priority  != null) t.priority  = opts.priority;

  postCommand({
    protocolVersion: 1, command: 'play', source: SOURCE,
    eventId: eid, sequence: eventSeq[eid], targets: [t]
  });
}

// 持续状态（基线快照）
// ⚠️ targets 必须包含该部位【所有】需要持续的通道，漏写的会被清除
function setBaseline(targets) {
  baselineSeq += 1;
  postCommand({
    protocolVersion: 1, command: 'set_baseline', source: SOURCE,
    sequence: baselineSeq, targets: targets
  });
}

// 清空基线
function clearBaseline() { setBaseline([]); }

// 提前结束某个事件
function stopEvent(eventId) {
  postCommand({ protocolVersion: 1, command: 'stop', source: SOURCE, eventId: eventId });
}

// 紧急全停：战斗结束 / 退出游戏时一定要发
function stopAll() {
  postCommand({ protocolVersion: 1, command: 'stop_all', source: SOURCE });
}

// ── 用法示例 ──
// 拘束阶段：持续低强度底噪（两条通道都写，避免被当成"取消"）
setBaseline([{ part: 'nipple', estimIntensity: 15, vibrateIntensity: 15, frequency: 30 }]);
// 一次命中：叠加，到期自动回落到基线
sendHit('nipple', { estim: 60, frequency: 40, durationMs: 900, rampUpMs: 120, rampDownMs: 180 });
// 高潮：数值更小但更重要
sendHit('nipple', { estim: 15, durationMs: 3000, priority: 10 });
// 战斗结束
stopAll();
```

### 6.2 C#（BepInEx 插件）要点

- 用 `HttpClient` + `StringContent(json, Encoding.UTF8, "application/json")`
- **不要在游戏主线程同步等待响应**（而且响应也没有信息量，见 §1.1）；
  用 fire-and-forget 或后台任务
- 序号与基线序号要持久化（§5.4 / §5.5）

### 6.3 Lua（UE4SS 等）要点

- 先确认 mod 环境有 HTTP 能力；没有就写文件、由外部程序转发
- 序号管理同样要持久化

---

## 7. ✅ 交付前必须核对的清单

```
[ ] 外层 action 固定为 "xtoys_game_bridge"，payload 是 JSON 【字符串】
[ ] 每条命令都带 protocolVersion: 1 和 source
[ ] play/update 都带 eventId、sequence（严格递增）、正的 durationMs
[ ] 一个 targets 数组里没有重复的 part（同部位指标已合并成一条）
[ ] 强度字段用的是 estimIntensity / vibrateIntensity，没有旧的 intensity
[ ] part 用的都是 §4.1 的规范全称（clitoris 不是 clit），且已和用户确认配置里有
[ ] 没有使用虚拟组（genitals / whole_body 等）或游戏内部键名
[ ] set_baseline 的快照里写全了该部位【所有】需要持续的通道
[ ] 不给 frequency 时【根本不写】这个字段（不是写 0）
[ ] 同一 eventId 的 sequence 单调递增，不会重置
[ ] 基线序号已持久化（或 source 带会话标识），跨 stop_all 不会用回小序号
[ ] 战斗结束 / 退出游戏 / 玩家急停 都会发 stop_all
[ ] 代码里没有设备名 / 通道名 / 输出槽名
[ ] 真实 Webhook ID 没有硬编码进提交的文件
[ ] 体感相关逻辑（去抖 / 批量 / 优先级策略）已在真机上按本游戏的实际节奏定过
```

> 最后一条是**留给你的判断**，本指南不规定具体做法。接收端是 100 ms 定时取最新意图，
> **密集事件天然会被合并**，协议对发送频率没有要求。但"发得多"不等于"体感好"：
> 冷却、批量窗口、高潮去重这类策略完全取决于游戏的事件密度与节奏，必须按实际游戏定。

---

## 8. 联调与排错

### 8.1 先用 `test` 命令验格式（不驱动硬件）

```json
{
  "protocolVersion": 1, "command": "test", "source": "my-game",
  "targets": [ { "part": "nipple", "estimIntensity": 50 } ]
}
```

格式正确时接收端返回 `{"ok":true,"code":"validated"}`，且**不会驱动任何设备**。

### 8.2 出问题时只能看 XToys 的 Script 日志

HTTP 永远返回 200，所以判断只能靠日志：

| 日志内容 | 含义 |
| --- | --- |
| `收到 command=… source=… seq=… targets=… parts=…` | 命令到达且格式被解析 |
| `rejected <code>` | 命令被拒绝，`code` 见下表 |
| `ignored 部位 X 未在映射配置里` | **部位名不在用户配置里** → 改名字，或让用户在接收端加 |
| `ignored X 没有 Y 对应的 Block` | 部位合法但用户没接那类设备（正常） |

日志里也可以读这些诊断变量：`xthb-ignored-count`（被忽略计数）、
`xthb-rejected-count`（被拒绝计数）、`xthb-last-error`、`xthb-last-ignored`。

### 8.3 错误码对照表

| code | 原因 |
| --- | --- |
| `invalid_payload` | 外层 `action` 不是 `xtoys_game_bridge`；或 `payload` 不是字符串；或载荷超长 |
| `invalid_json` | JSON 解析失败（外层或 `payload`） |
| `unsupported_protocol_version` | `protocolVersion` 不是 `1` |
| `unsupported_command` | `command` 拼错或不存在 |
| `missing_source` | 缺 `source`，或为空、超 64 字符、含控制字符 |
| `missing_event_id` | 缺 `eventId`，或为空、超 64 字符、含控制字符 |
| `invalid_sequence` | 序号非有限数、为负，或**没有严格大于上次**（最常见） |
| `invalid_duration` | `play`/`update` 的 `durationMs` 缺失或非正 |
| `invalid_targets` | 同部位重复；`part` 不是字符串；数值非法；驱动指标一个都没有 |
| `missing_targets` | 缺 `targets`；或 `play`/`update` 给了空数组 |
| `missing_stop_selector` | `stop` 既没给 `eventId` 也没给有效的 `targets` |
| `invalid_config` | **接收端没初始化成功**（不是你的问题，让用户重启 Script） |
| `state_capacity_exceeded` | 同时有效的有限事件超过 64 个（说明事件没有正常到期/停止） |

### 8.4 接收端已经验证过的行为（你不必重验）

以下都已在真机上验证：`frequency` 缺省保持不变；`priority` 作为第一级判据生效；
序号不递增被拒绝；未识别部位被忽略而不是整体拒绝；同部位重复被拒绝；
`stop_all` 全通道归零；同强度新事件会重新驱动；强度两条通道互不牵连。

---

## 9. 一页速记

```
POST https://webhook.xtoys.app/<Webhook ID>
{"action":"xtoys_game_bridge","payload":"<内层JSON字符串>"}

内层：{protocolVersion:1, command, source, eventId, sequence, targets:[...]}
  play/update  → 有限事件（要 durationMs>0，eventId + 递增 sequence，targets 非空）
  set_baseline → 持续状态（完整快照！漏写的通道会被清除；序号跨 stop_all 保留）
  stop         → 提前结束（给 eventId 或 targets）
  stop_all     → 紧急全停
  test         → 只校验不驱动（不需要 sequence）

target: {part, estimIntensity?, vibrateIntensity?, frequency?, rotateSpeed?,
         rotateDirection?, durationMs?, rampUpMs?, rampDownMs?, priority?}

part 用解剖学英文全称（小写，多词用下划线），已定义的有：
  mouth breast nipple armpit clitoris vulva vagina urethra anus butt penis prostate
  → 需要新部位就按同一规范起名，并和接收端维护者约定（§4.1）
  （名字不在接收端配置里 → 静默忽略，HTTP 还是 200）

三条最容易错：
  1. 一个部位在 targets 里只能出现一次（同部位的指标合并成一条）
  2. estimIntensity / vibrateIntensity 是独立通道，互不推导；没有 intensity 字段
  3. part 必须用规范全称、且在接收端配置里；否则【静默忽略】

两条反直觉但很重要：
  · set_baseline 是完整快照 —— 漏写某条通道 = 清掉那条通道的基线
  · frequency 不写 = 保持设备当前频率（不是 0；写 0 是"最低频"）

记住：HTTP 200 ≠ 生效。只信 XToys 日志。
```
