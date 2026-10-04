# 游戏侧插件编写指南

> **这份文档是写给"要写游戏侧桥接"的人（或另一个智能体）的。**
> 只读这一篇，就能写出一份和本项目 XToys 接收端对得上的游戏侧插件。
>
> 接收端的权威规格在 `docs/02-webhook-protocol.md` / `docs/03-protocol-mapping.md`；
> 本文是"从游戏侧出发"的落地版本，两者如有冲突**以那两份为准**。
>
> 最后更新：2026-10-05

---

## 0. 先明确分工（不要越界）

```
┌──────────────┐   逻辑意图：哪个部位、多大强度、多久     ┌────────────────────┐
│  游戏侧插件   │ ──────────────────────────────────► │  XToys Script（已完工）│
│  （你来写）   │   POST Webhook                       │  负责裁决 + 驱动物理设备 │
└──────────────┘                                      └────────────────────┘
```

| 谁负责 | 内容 |
| --- | --- |
| **游戏侧（你）** | 读游戏内部状态；翻译成**逻辑部位 + 强度**；发协议；本地冷却/去重 |
| **XToys 侧（已完成）** | 部位→Block 映射；多事件仲裁；ramp；把结果写给 E-Stim / 振动 / 旋转 |

**三条硬边界**（违反就会破坏整个设计的解耦）：

1. 🚫 **游戏侧代码里不得出现设备名、通道名、Job 名、Block 名。**
   你只发 `part`（逻辑部位），**不关心**用户接了几台设备、接到了哪个部位。
2. 🚫 **不要试图控制设备最大强度/最大旋转速度。** 那是用户在 XToys 设备设置里的选择。
   协议里也没有这样的字段。
3. 🚫 **不要在游戏侧实现"部位→设备"的映射。** 那是 XToys 侧的配置，改了不用动你。

---

## 1. 传输：Webhook 怎么发

```
POST https://webhook.xtoys.app/<Webhook ID>
Content-Type: application/json
```

Body 是**固定外层封装**：

```json
{
  "action": "xtoys_game_bridge",
  "payload": "<内层协议对象的 JSON 字符串>"
}
```

- `action` 是**固定的路由名**，永远是 `xtoys_game_bridge`。**不要**换成游戏事件名。
- `payload` 必须是**字符串**（内层对象先 `JSON.stringify` 再放进去），不是嵌套对象。

> ✅ **实测确认（2026-10-05）**：Webhook 对**会被整体拒绝的载荷也返回 HTTP 200**。
> **所以 HTTP 状态码完全不能用来判断命令是否被接受。**
> 想知道是否生效，只能看 XToys 的 Script 日志（接收端会记 `收到的命令摘要`、
> `rejected <code>`、`ignored <detail>`），或读诊断变量
> `xthb-rejected-count` / `xthb-ignored-count` / `xthb-last-error` / `xthb-last-ignored`。

> ⚠️ 顺带说明（你不需要为它做任何事，但读日志时会看到）：
> XToys 的 trigger 把外层剥掉后才交给 JS，所以接收端内部只看到内层对象。
> 接收端**两种形状都接受**，所以你按上面的封装发就对了。

---

## 2. 内层协议对象

### 2.1 字段总表

| 字段 | 类型 | 必填性 | 说明 |
| --- | --- | --- | --- |
| `protocolVersion` | number | **必填** | 固定 `1` |
| `command` | string | **必填** | `play` / `update` / `stop` / `set_baseline` / `stop_all` /（`test` 预检） |
| `source` | string | **必填** | 你的插件标识，稳定即可（如 `"repetition"`）。≤64 字符，**禁含控制字符** |
| `eventId` | string | `play`/`update` 必填 | 一次有限事件的标识。≤64 字符，**禁含控制字符** |
| `sequence` | number | 见下 | 同 `source + eventId` 的版本号，必须**严格递增**。`test` 不需要 |
| `targets` | array | 见下 | 目标列表，见 §3 |

### 2.2 六个命令

| 命令 | 作用 | 什么时候用 |
| --- | --- | --- |
| `play` | 创建/替换一个**有限事件**（有 `durationMs`，到期自动消失） | 一次攻击、一次命中、"现在这一下" |
| `update` | 用**更高 `sequence`** 替换同一 `source+eventId` 的整个目标集 | 同一个事件要**改强度**或**换旋转方向** |
| `stop` | 停某个事件 / 某些部位 | 提前结束（如被打断） |
| `set_baseline` | 替换该 `source` 的**基线快照**（持续状态，无时长） | 异常状态、拘束阶段、持续发情 |
| `stop_all` | **紧急全停**：清空所有来源的所有状态 | 战斗结束、游戏退出、玩家按了急停 |
| `test` | 只校验不驱动硬件 | 联调时确认协议格式对不对 |

### 2.3 `play` / `update` 必须带正 `durationMs`

内层对象：

```json
{
  "protocolVersion": 1,
  "command": "play",
  "source": "repetition",
  "eventId": "hit-0042",
  "sequence": 1,
  "targets": [
    { "part": "nipple", "estimIntensity": 65, "frequency": 40,
      "durationMs": 900, "rampUpMs": 120, "rampDownMs": 180, "priority": 10 }
  ]
}
```

---

## 3. `targets` 是协议的核心

### 3.1 一条 target 的字段

| 字段 | 类型 / 范围 | 说明 |
| --- | --- | --- |
| `part` | string，**必填** | **逻辑部位**。见 §4 的规范清单 |
| `estimIntensity` | number 0–100 | **E-Stim 通道**强度。不给 = 不驱动 E-Stim |
| `vibrateIntensity` | number 0–100 | **振动通道**强度。不给 = 不驱动振动 |
| `frequency` | number 0–100 | 仅 E-Stim 的频率。**不给 = 保持设备当前频率**（见 §5.3） |
| `rotateSpeed` | number 0–100 | 旋转速度。**不从任何强度推导** |
| `rotateDirection` | `clockwise` / `counterclockwise` | `rotateSpeed > 0` 时**必填** |
| `durationMs` | number ≤ 600000 | **仅 `play`/`update` 需要**，必须为正 |
| `rampUpMs` | number，默认 0 | 数值**升高**时的渐入时间（毫秒） |
| `rampDownMs` | number，默认 0 | 数值**降低 / 停止 / 到期**时的渐出时间 |
| `priority` | number，默认 0 | 同部位多事件竞争时的**第一级**判据。默认 0 可完全不发 |

### 3.2 ⭐ 三条容易搞错、且会静默出错的规则

**规则一：一个部位在一条命令的 `targets` 里只能出现一次。**

❌ 错（后面那条会静默覆盖前面那条）：

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

这是 2026-10-05 的协议改动：早期用一个 `intensity` 同时驱动两条通道，导致
"同一部位同时用 E-Stim 与振动"的双模设备无法分别控制。现在：

- 只给 `estimIntensity` → **只有 E-Stim 动，振动保持不动**
- 只给 `vibrateIntensity` → 只有振动动
- 两个都给 → 两条通道各按各的值输出

✅ 双模设备的写法（同一部位，E-Stim 强、振动弱）：

```json
"targets": [
  { "part": "nipple", "estimIntensity": 80, "vibrateIntensity": 20,
    "frequency": 55, "durationMs": 900 }
]
```

> ⚠️ **`intensity` 这个字段已废除。** 发它会被当成"没有驱动指标"而**整体拒绝** ——
> 这是有意的，静默忽略会让你以为生效了。旧代码里如果用了 `intensity`，必须改名。

**规则三：一条 target 至少要有一个"驱动指标"。**

驱动指标 = `estimIntensity` / `vibrateIntensity` / `frequency` / `rotateSpeed`（出现即算，
**含 `0`**）。`rotateDirection` 单独出现**不算**。

❌ 这样会被整体拒绝：

```json
"targets": [ { "part": "nipple", "rotateDirection": "clockwise", "durationMs": 500 } ]
```

### 3.3 数值边界（超范围与非法值）

| 情况 | 行为 |
| --- | --- |
| 数值超出 0–100 | **夹取**到 0–100（不报错） |
| 显式 `null` / 字符串 / `NaN` / 布尔 | **整体拒绝**（不猜你的意图） |
| `durationMs` 缺失或 ≤ 0（`play`/`update`） | 整体拒绝 |
| `rotateSpeed > 0` 但没给方向 | 整体拒绝 |
| 一条 target 的驱动指标一个都没有 | 整体拒绝 |

**"整体拒绝"= 整条命令都不生效**，不会部分应用。

---

## 4. ⭐ `part` 用什么名字（最容易静默失效的地方）

### 4.1 规范部位清单

收件端**没有部位白名单**，部件名是否生效完全由**用户的 XToys 配置表**决定。所以：

**你只能发下面这些规范名，并且要先确认用户在 XToys 侧配置了它们。**

```
mouth  breast  nipple  armpit  clitoris  vulva  vagina
urethra  anus  butt  penis  prostate
```

> ⚠️ **一律用全称**：是 `clitoris` 不是 `clit`，是 `anus` 不是 `anal`。
> Block 名、Channel ID、变量名也沿用同一部位名（如 `Estim-nipple`、`part-estim-nipple`）。

### 4.2 当前接收端实际配置了哪 4 个部位（2026-10-05）

```
nipple     → E-Stim + 振动 + 旋转（旋转是样板，未接设备）
clitoris   → E-Stim + 振动
vagina     → E-Stim + 振动
anus       → E-Stim + 振动
```

**发这 4 个之外的部位 → 被静默忽略**（只在日志留一条 `ignored`）。
设备不会有任何反应，而 HTTP 仍然返回 200。

### 4.3 ❌ 已知会踩的坑：`docs/05` 里的旧键名不能用

`docs/05-game-event-mappings.md` 是**游戏内部状态**的实测记录，里面出现的一些"建议部位键"
**不是协议名**，直接发会被忽略：

| 游戏映射文档里的旧键 | 问题 | 应该发什么 |
| --- | --- | --- |
| `generic_ep` | 不是协议名 | `whole_body` 不在叶子清单里 → 需用户在配置里加，或**改发具体叶子**（如 `nipple`） |
| `chest` | 不是协议名 | `breast` |
| `lower` | 不是协议名 | `vagina` 或 `clitoris`（看具体部位） |
| `abuse` | 不是协议名 | 无对应，需用户在配置里加或改发叶子 |
| `clit_penis` | 不是协议名 | `clitoris`（或 `penis`） |
| `futanari` | 不是协议名 | 无对应，需用户决定 |
| `whole_body` | **虚拟组已废弃**（一个 Block 专属一个部位，组会落到多个部位，语义冲突） | 改发多个具体叶子 target |

> **结论：写插件的第一步是产出一张 游戏内部状态 → 规范部位名 的映射表，并和用户确认
> 接收端配置了哪些部位。** 不要照 `docs/05` 的"建议部位键"直接发。

### 4.4 部位合法但这个部位没有对应通道时

例：用户只给 `vagina` 配了振动、没有 E-Stim，而你发了 `vagina.estimIntensity`。

→ **该指标被忽略**（日志留痕），**不报错**。这是正常情况（用户没接那类设备）。

**所以：不要期待"没反应就是出错"** —— 先查 XToys 日志里有没有 `ignored`，
或读 `xthb-ignored-count` / `xthb-last-ignored`。

---

## 5. 状态语义（搞错会造成"设备莫名停住/莫名一直动"）

### 5.1 有限事件 vs 基线

| | 有限事件（`play`/`update`） | 基线（`set_baseline`） |
| --- | --- | --- |
| 生命周期 | 有 `durationMs`，**到期自动消失** | 一直持续，直到被新快照替换或 `stop` |
| 用途 | 一次攻击 / 命中 | 持续状态：拘束、异常状态、发情 |
| 到期后 | 回落到基线（若有），否则归零 | — |

**典型组合**：拘束阶段用 `set_baseline` 给一个低强度底噪，攻击用 `play` 叠加上去。

### 5.2 ⭐ 基线是**完整快照**，漏写的通道会被清除

`set_baseline` 替换该 `source` 的**整份**快照。**快照里没写的部位会被清除**，
**而且粒度一直到通道**：某部位只写了 `estimIntensity`、没写 `vibrateIntensity`，
那么**该部位的振动基线会被清除（振动停止）** —— 不是"保持不变"。

> ✅ 真机实测（2026-10-05）：用 `vibrateIntensity:25` 建立振动基线后，后续只带
> `estimIntensity` 的 `play` 事件**不影响**它（事件不带 vibrate 值就不参与振动仲裁）；
> 但只要发一条**新的 `set_baseline`** 而里面没写振动，振动基线就被清掉。

**所以：发持续状态时，必须把该部位所有需要持续的通道一起写进同一条快照。**

```json
{
  "protocolVersion": 1, "command": "set_baseline", "source": "repetition", "sequence": 7,
  "targets": [
    { "part": "nipple", "estimIntensity": 20, "vibrateIntensity": 20, "frequency": 30 }
  ]
}
```

清空该来源基线（空快照，不影响有限事件）：

```json
{ "protocolVersion": 1, "command": "set_baseline", "source": "repetition", "sequence": 8, "targets": [] }
```

### 5.3 `frequency` 缺省 ≠ 0

**不给 `frequency` = 保持设备当前频率**，不是置零。因为频率是 E-Stim 的**调制设置**而非
刺激量，"强度 0 时把频率写 0"没有意义，只会改变下一次输出的手感。

- 要改频率：显式给 `frequency`
- 不想动频率：**别写这个字段**（不要写 `"frequency": 0`，那会被当成"要求频率 0"）

> ✅ 真机实测：`frequency` 是**百分比（0–100）**，映射到设备自身范围。
> XToys 默认频率范围 **10–100**，所以 `frequency: 30` 在设备上落在 `10 + 30%×90 ≈ 37`。
> **读数与发送值不一致是正常的。** 写 `0` 会落在下限 10（最低频），不代表关闭。

### 5.4 `sequence` 必须严格递增（否则命令被静默丢弃）

同一 `source + eventId` 只有**严格更大的 `sequence`** 才生效：

```js
// 每个事件自己维护一个递增计数
const seq = (seqMap[eventId] = (seqMap[eventId] || 0) + 1);
```

- 用**相同或更小**的 `sequence` 会被拒（`invalid_sequence`）—— 这是防止重复投递变成重复刺激。
- **事件到期后，它的序号栅栏还会保留 10 分钟**（防止 webhook 重试造成重复刺激）。
  所以同一个 `eventId` **不要"重置"回小序号**，让它一直递增。
- 想换新事件，直接换 `eventId`（各自独立计数）。

### 5.5 ⚠️ 基线序号也有栅栏，且**跨 `stop_all` 保留**

- `set_baseline` 的 `sequence` 也必须比该 `source` 上一次的**严格更大**。
- **`stop_all` 会清状态，但不清这个栅栏** —— 之后同一 `source` 的 `set_baseline`
  **仍必须用更大的序号**。

**所以插件必须持久化"我已经用到第几号"**，否则战斗结束（`stop_all`）后再开一场，
用回小序号会被拒，表现为"基线发不出去"。

- 简单做法：`source` 里带**会话标识**（如 `"repetition-s3"`），重开就换 source。
- 或者：把序号存进存档/配置，重启后继续递增。

### 5.6 旋转不会自动反向

要换向必须**显式发新的 `rotateDirection`**（用 `update` 带更高 `sequence`）。
只发速度不会反向。

---

## 6. 三条必须实现的游戏侧逻辑

这三条**不是协议要求的**，但不做会明显影响体感（都是旧实现实测踩出来的）。

### 6.1 命中冷却（去抖）

游戏开关/字段会出现**同一帧内抖动或连续变化**，每个变化都发一次会造成连环命中。

- 参考值：**单部位重复命中冷却 120 ms**
- 做法：记录每个部位上次发送时间，未超过冷却则跳过

### 6.2 批量合并（攻击极密时必须有）

密攻击的游戏（如 Unity 那款）逐条 POST 会打爆 Webhook。

- 参考值：**200 ms 窗口**，窗口内同部位保留**最新值**，窗口结束时发一次
- 高潮去重：**1000 ms** 窗口
- 成功日志按 **5 s 聚合**，否则日志刷屏

### 6.3 高潮锁

高潮计数器上升时触发。不做锁会一次高潮发很多条。

- 参考值：**8 秒锁窗口**
- 更可靠的做法：用游戏里的"高潮经验"计数器是否**上升**来判定，而不是自己从 EP 存量推断

---

## 7. 代码骨架（可直接改用）

### 7.1 通用发送器（JavaScript / RPG Maker 插件可直接用）

```js
// ── 配置（真实 Webhook ID 不要提交进版本库）──
var WEBHOOK_ID = '';              // 运行时由用户填
var SOURCE     = 'my-game';       // 稳定标识

// 基线序号栅栏：必须持久化，跨 stop_all 保留
var baselineSeq = 0;
// 每个 eventId 自己的序号
var eventSeq = {};

function postCommand(inner) {
  var body = JSON.stringify({
    action: 'xtoys_game_bridge',
    payload: JSON.stringify(inner)      // ← 内层必须是【字符串】
  });
  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://webhook.xtoys.app/' + WEBHOOK_ID, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(body);
  // ⚠️ 不要用返回值判断成功 —— HTTP 200 不代表命令被接受
}

// 有限事件（一次命中）
function sendHit(part, estim, vibrate, durationMs, opts) {
  opts = opts || {};
  var eid = opts.eventId || (part + '-' + Date.now());
  eventSeq[eid] = (eventSeq[eid] || 0) + 1;
  var t = { part: part, durationMs: durationMs,
            rampUpMs: opts.rampUpMs || 0, rampDownMs: opts.rampDownMs || 0 };
  if (estim   != null) t.estimIntensity   = estim;
  if (vibrate != null) t.vibrateIntensity = vibrate;
  if (opts.frequency != null) t.frequency = opts.frequency;   // 不给就保持当前频率
  if (opts.priority  != null) t.priority  = opts.priority;

  postCommand({ protocolVersion: 1, command: 'play', source: SOURCE,
                eventId: eid, sequence: eventSeq[eid], targets: [t] });
}

// 持续状态（基线快照）—— 该部位【所有】需要持续的通道都要写进来
function setBaseline(targets) {
  baselineSeq += 1;                 // 必须严格递增，且要持久化
  postCommand({ protocolVersion: 1, command: 'set_baseline', source: SOURCE,
                sequence: baselineSeq, targets: targets });
}

// 紧急全停
function stopAll() {
  postCommand({ protocolVersion: 1, command: 'stop_all', source: SOURCE });
}
```

### 7.2 C#（BepInEx 插件）要点

- 用 `HttpClient` + `StringContent(json, Encoding.UTF8, "application/json")`
- **不要**在游戏主线程同步等待响应 —— 用 fire-and-forget 或后台任务
- 批量窗口用主循环 tick 或定时器驱动

### 7.3 Lua（UE4SS Mod）要点

- 确认 mod 环境有 HTTP 能力；没有就写文件由外部程序转发
- **不要读会崩原生代码的字段**（见 `docs/05` §4.4）

---

## 8. ✅ 交付前必须核对的清单

```
[ ] 外层 action 固定为 "xtoys_game_bridge"，payload 是 JSON 【字符串】
[ ] 每条命令都带 protocolVersion: 1 和 source
[ ] play/update 都带 eventId、sequence（严格递增）、正的 durationMs
[ ] 一个 targets 数组里没有重复的 part（同部位指标已合并成一条）
[ ] 强度字段用的是 estimIntensity / vibrateIntensity，没有旧的 intensity
[ ] part 用的都是规范全称（clitoris 不是 clit），且已在用户配置里存在
[ ] play/update 覆盖或 stop（提前结束）都有地方触发；战斗结束/退出会发 stop_all
[ ] 基线序号已持久化（或 source 带会话标识），跨 stop_all 不会用回小序号
[ ] 同一 eventId 的 sequence 单调递增，不会重置
[ ] 不给 frequency 时【根本不写】这个字段（不是写 0）
[ ] 有命中冷却；密攻击游戏有批量窗口；有高潮锁
[ ] 代码里没有设备名/通道名/Job 名/Block 名
[ ] 真实 Webhook ID 没有硬编码进提交的文件
```

---

## 9. 联调与排错

### 9.1 先用 `test` 命令验格式（不驱动硬件）

```json
{ "protocolVersion": 1, "command": "test", "source": "my-game",
  "targets": [ { "part": "nipple", "estimIntensity": 50 } ] }
```

返回 `{"ok":true,"code":"validated"}` 说明格式没问题。
（`test` 不需要 `sequence`。）

### 9.2 出问题时**只能看 XToys 日志**

HTTP 永远 200，所以：

| 日志/变量 | 含义 |
| --- | --- |
| `收到 command=… source=… parts=…` | 命令到了，格式被解析 |
| `rejected <code>` | 被拒绝，`code` 见下 |
| `ignored 部位 X 未在映射配置里` | **部位名不在用户配置里** → 改部位名，或让用户在 XToys 侧加 |
| `ignored X 没有 Y 对应的 Block` | 部位合法，但用户没接那类设备 → 正常 |
| `xthb-ignored-count` | 被忽略的累计计数 |
| `xthb-last-error` / `xthb-rejected-count` | 最近一次错误 / 拒绝计数 |

常见 `code`：

| code | 原因 |
| --- | --- |
| `invalid_payload` | 外层 `action` 不对，或 `payload` 不是字符串 |
| `invalid_json` | JSON 解析失败 |
| `unsupported_protocol_version` | `protocolVersion` 不是 1 |
| `unsupported_command` | `command` 拼错 |
| `missing_source` / `missing_event_id` | 缺字段，或含控制字符 |
| `invalid_sequence` | 序号没严格递增（**最常见**） |
| `invalid_duration` | `durationMs` 缺失或非正 |
| `invalid_targets` | 重复部位 / 未知字段值 / 驱动指标一个都没有 |
| `missing_targets` | 缺 `targets`，或 `play`/`update` 给了空数组 |
| `missing_stop_selector` | `stop` 没给选择器 |

### 9.3 接收端已经验过什么（你不必重验）

真机 14 步已通过（除旋转，用户暂无设备）。其中与你直接相关的：

- `frequency` 缺省保持不变 ✅
- `priority` 作为第一级判据 ✅
- 序号不递增被拒绝 ✅
- 未识别部位被忽略而不是整体拒绝 ✅
- 重复部位被拒绝 ✅
- `stop_all` 归零 ✅
- 同强度新事件会重新驱动 ✅

---

## 10. 一页速记

```
POST https://webhook.xtoys.app/<ID>
{"action":"xtoys_game_bridge","payload":"<内层JSON字符串>"}

内层：{protocolVersion:1, command, source, eventId, sequence, targets:[...]}
  play/update  → 有限事件（要 durationMs>0，eventId+递增 sequence）
  set_baseline → 持续状态（完整快照！漏写的通道会被清除；序号跨 stop_all 保留）
  stop         → 提前结束
  stop_all     → 紧急全停

target: {part, estimIntensity?, vibrateIntensity?, frequency?,
         rotateSpeed?, rotateDirection?, durationMs?, rampUpMs?, rampDownMs?, priority?}

三条最容易错：
  1. 一个部位在 targets 里只能出现一次（指标合并成一条）
  2. estimIntensity / vibrateIntensity 是独立通道，互不推导；别用旧的 intensity
  3. part 必须是规范全称且在用户配置里；否则【静默忽略】，HTTP 还是 200

记住：HTTP 200 ≠ 生效。只信 XToys 日志。
```
