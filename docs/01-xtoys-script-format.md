# XToys Script JSON 语法参考

本文档记录**已经实测确认**的 XToys Script JSON 结构、Action 形状与宿主 JavaScript API。
内容来自一个真实生成并成功导入过 XToys 的 Script JSON（`examples/xtoys-importable-reference.json`）
以及生成该文件的编译器源码。凡是推断而非实测的条目都显式标注。

> 用途：重写 XToys 侧脚本时，**只依赖本文档描述的语法**，不要参考旧通用运行时的架构。

---

## 1. Script JSON 顶层结构

导入 XToys 的 Script 导出文件是一个 JSON 对象，实测包含以下顶层键：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `initialActions` | Action[] | Script **启动时**执行一次 |
| `finalActions` | Action[] | Script **停止时**执行一次（安全背板） |
| `globalTriggers` | Trigger[] | 全局触发器（Webhook 入口在这里） |
| `jobs` | object | Job 名 → Job 定义 |
| `queues` | array | 本项目的模板留空 `[]` |
| `channels` | object | 通道 ID → 通道定义（物理执行器在这里） |
| `controls` | array | 留空 `[]` |
| `controlPresets` | array | 留空 `[]` |
| `media` | object | 留空为 `{"audio":{},"voices":{},"patterns":{}}` |
| `customFunctions` | **string** | 全局 JavaScript 源码（ES5），即"全局 JavaScript 页面"的内容 |

关键点：**`customFunctions` 是一个字符串**，里面装的是整段 JS 源码，不是结构化数据。

---

## 2. channels：物理执行器

通道是"一个物理执行器或独立子通道"的抽象。实测的通道类型：

| `type` | 含义 |
| --- | --- |
| `webhook` | 入站 Webhook 入口 |
| `part-estim` | E-Stim 类执行器 |
| `part-vibrator` | 振动类执行器 |
| `part-rotator` | 旋转类执行器 |

Webhook 通道实测形状：

```json
"webhook-a": { "name": "", "type": "webhook", "outbound": false, "hideWebhookInfo": false }
```

物理通道实测形状（`name` 就是 UI 上显示的 Block 名称，也是用户绑定设备的地方）：

```json
"part-estim-a":    { "name": "Clitoris Estim",   "type": "part-estim" },
"part-vibrator-a": { "name": "Vagina Vibrator",  "type": "part-vibrator" },
"part-rotator-a":  { "name": "Clitoris Rotator", "type": "part-rotator" }
```

通道 ID 只是内部标识；**导入后必须由用户在 XToys UI 上把每个 Block 绑定到恰好一个物理设备/子通道**，JSON 不能代替这一步。

---

## 3. jobs：Job、步骤与触发器

```json
"jobs": {
  "<jobName>": {
    "steps": {
      "START": {
        "actions": [ /* Action[] */ ],
        "triggers": [ /* Trigger[]，可省略 */ ]
      }
    }
  }
}
```

### 定时器循环（调度器写法）

实测的 100 ms 自循环 Job：

```json
"xthb-scheduler": {
  "steps": {
    "START": {
      "actions": [
        { "type": "customCode", "code": "xtoysBridgeTick();", "resultVar": "result",
          "variables": [], "storeResult": false }
      ],
      "triggers": [
        { "type": "stepState", "event": "timer", "amount": "0.1",
          "actions": [ { "job": "xthb-scheduler", "step": "START",
                         "type": "updateJob", "action": "goTo" } ] }
      ]
    }
  }
}
```

- `event: "timer"` + `amount: "0.1"`：延时触发器，`amount` 单位为**秒**（0.1 = 100 ms）⚠️单位由用法推断。
- `goTo` + `step`：跳回自身步骤形成循环。**调度器不需要每个游戏事件各建一个计时器。**

### 输出 Job（一次性刷新器）

输出 Job 的作用是：被 `updateJob/start` 唤醒 → 用当前变量值写一次硬件 → 立刻停自己。

```json
"xthb-output-01": {
  "steps": {
    "START": {
      "actions": [
        { "type": "updateComponent", "action": "setVolume",
          "channel": "part-estim-a", "rampTime": "{xthb-slot-01-ramp-seconds}",
          "percentVolume": "{xthb-slot-01-value}" },
        { "type": "updateComponent", "action": "setFrequency", "format": "relative",
          "channel": "part-estim-a", "frequencyPercent": "{xthb-slot-01-frequency}" },
        { "job": "xthb-output-01", "type": "updateJob", "action": "stop" }
      ]
    }
  }
}
```

**旋转 Job 的 Action 顺序是硬要求：两个方向 Action 必须在速度 Action 之前。**

```json
"actions": [
  { "type": "updateComponent", "action": "setDirection", "channel": "part-rotator-a",
    "direction": "clockwise",        "requiredExpression": "{xthb-slot-03-direction-code} == 1" },
  { "type": "updateComponent", "action": "setDirection", "channel": "part-rotator-a",
    "direction": "counterclockwise", "requiredExpression": "{xthb-slot-03-direction-code} == -1" },
  { "type": "updateComponent", "action": "setVolume", "channel": "part-rotator-a",
    "rampTime": "{xthb-slot-03-ramp-seconds}", "percentVolume": "{xthb-slot-03-value}" },
  { "job": "xthb-output-03", "type": "updateJob", "action": "stop" }
]
```

未使用的 Job 也应保留，步骤里只放一条"停止自己"，并且**不接任何设备**。

---

## 4. Action 类型全表（实测形状）

### 4.1 `updateVariable` — 写 Script 变量

```json
{ "type": "updateVariable", "variable": "xthb-config-json", "value": "{...JSON 字符串...}" }
```

### 4.2 `updateComponent` — 操作通道/Block

| `action` | 参数 | 实测示例 |
| --- | --- | --- |
| `setVolume` | `channel`, `rampTime`, `percentVolume` | `{"action":"setVolume","channel":"part-vibrator-a","rampTime":0,"percentVolume":"0"}` |
| `setFrequency` | `channel`, `format`, `frequencyPercent` | `{"action":"setFrequency","format":"relative","channel":"part-estim-a","frequencyPercent":"0"}` |
| `setMode` | `channel`, `mode` | `{"action":"setMode","mode":"standard","channel":"part-estim-a"}` |
| `setDirection` | `channel`, `direction`, `requiredExpression` | 见上一节 |

- `percentVolume` 与 `frequencyPercent` 可写数字，也可写 `{变量名}` 占位符或表达式字符串。
- `rampTime` 为数字或表达式；变量名 `ramp-seconds` 暗示单位为秒 ⚠️未独立验证。
- `setDirection` 的 `direction` 实测取 `clockwise` / `counterclockwise`；由 `requiredExpression` 控制该 Action 是否生效。
- ✅ **实测确认（2026-10-05）：`percentVolume` / `frequencyPercent` 是百分比（0–100），
  映射到设备自身的范围。** 例：**XToys 默认频率范围 10–100**，所以 `frequencyPercent: 30`
  落在 `10 + 30% × 90 ≈ 37`。这意味着：
  - 读数与发送值不一致是**正常的**，不是偏差。
  - **`frequencyPercent: 0` 落在范围下限 10（最低频），不等于"关闭频率"。**

### 4.3 `updateJob` — 启停/跳转 Job

```json
{ "job": "xthb-output-01", "type": "updateJob", "action": "start" }
{ "job": "xthb-output-01", "type": "updateJob", "action": "stop" }
{ "job": "xthb-scheduler",  "step": "START", "type": "updateJob", "action": "goTo" }
```

实测 `action` 取值：`start`、`stop`、`goTo`（`goTo` 需配 `step`）。

### 4.4 `customCode` — 内联 JavaScript

```json
{
  "type": "customCode",
  "code": "xtoysBridgeHandle(payload);",
  "resultVar": "result",
  "variables": [ { "name": "payload", "value": "trigger-payload", "expression": null } ],
  "storeResult": false
}
```

- `variables`：把外部值映射成 JS 里可见的变量名。
- `value: "trigger-payload"` 是**魔法值**。
- `resultVar` + `storeResult`：是否把返回值写回变量。
- ⚠️ **`variables[].value` 必须是字符串**（或魔法值）。真机实测（2026-09-30）：
  放一个**对象**进去，XToys 处理 Action 时直接抛
  `TypeError: r([c...]).startsWith is not a function`（堆栈在 `M.processActions`），
  整个 Script 启动失败。XToys 内部按字符串处理这个字段。
  需要传结构化数据时**先 `JSON.stringify`**，在 JS 侧再 `JSON.parse`。
  生成器 `tools/build-xtoys-script.mjs` 有对应自检，会在构建期挡住这种写法。
- ⚠️ **`trigger-payload` 给的不是原始 webhook body，而是已剥掉外层封装的内容。**
  真机实测（2026-09-30）：Webhook body 是
  `{"action":"xtoys_game_bridge","payload":"{\"command\":\"set_baseline\",...}"}`
  （网络面板可见），但 JS 侧收到的 `payload` 变量值已经是
  `{"targets":[...],"source":"...","protocolVersion":1,"command":"set_baseline"}`
  —— 即 **trigger 的 `action` 是路由键（会被剥掉），`payload` 字段也被解了一层**。
  因此接收端**必须同时接受两种形状**：外层封装（手工 curl 测试是这个形状）
  与内层协议对象。`xtoysBridgeHandle` 现在两种都认（见 `xthbNormalizeEnvelope`）。

---

## 5. 全局 Trigger（Webhook 入口）

实测只有一个，形状如下：

```json
"globalTriggers": [
  {
    "type": "componentState",
    "action": "xtoys_game_bridge",
    "channel": "webhook-a",
    "parsedAction": "xtoys_game_bridge",
    "actions": [
      { "type": "customCode", "code": "xtoysBridgeHandle(payload);", "resultVar": "result",
        "variables": [ { "name": "payload", "value": "trigger-payload", "expression": null } ],
        "storeResult": false }
    ]
  }
]
```

要点：

- `action` 是**固定的外层路由名**，不是游戏事件名。本项目固定用 `xtoys_game_bridge`。
- 不要把协议字段在 Trigger 里拆开，也不要用 `eval` 动态执行载荷。
- 真实协议对象作为 JSON 字符串放在外层 `payload` 字段里，由 JS 侧解析。

---

## 6. 全局 JavaScript 与宿主 API（`customFunctions`）

Script 的全局 JavaScript 运行在 **XToys JS-Interpreter** 中，约束：

- **只能写 ES5**：禁止 `let` / `const` / `=>` / `class` / `async` / `await` / 模板字符串 / 解构。
- 实测可直接使用的宿主全局函数：

| API | 用途 |
| --- | --- |
| `setVariable(name, value)` | 写一个 Script 变量（写完后 UI 上的 Block/Job 可读） |
| `getVariable(name)` | 读一个 Script 变量（返回字符串） |
| `callAction(actionObject)` | 从 JS 主动执行一个 Action，如 `callAction({type:'updateJob', job:'xthb-output-01', action:'start'})` |
| `console.log(text)` | 输出到 XToys 日志（可能不存在或被禁用，必须 try/catch 包裹） |

- 写入变量再启动 Job，是"把计算结果推给硬件"的唯一实测路径。
- **同步返回 ≠ 设备确认**：`setVariable` / `callAction` 正常返回只说明 JS 调用没有同步抛异常，不证明 Job 执行了、设备收到了、ramp 完成了或方向真的换了。文档与日志措辞必须遵守这一点。
- 全局函数（如 `xtoysBridgeInit`）必须先在全局作用域声明，才能被 UI Action 调用。

---

## 7. Initial / Final Actions：硬件安全背板

**Initial Actions**（实测顺序）：

1. 对每个已配置 Block：`setVolume percentVolume=0`（`rampTime=0`）；E-Stim 再加 `setFrequency=0` 与 `setMode=standard`。
2. `updateVariable`：把配置 JSON 写入配置变量。
3. `customCode`：初始化运行时。
4. `updateJob`：**启动**调度器 Job。

**Final Actions**（**本项目采用的顺序**，与旧参考实现的顺序不同）：

1. `updateJob stop`：停止调度器 Job（不再有新的计算进来）。
2. 对每个已配置 Block：`setVolume percentVolume=0`（`rampTime=0`）—— **字面量归零，不依赖 JS**。
3. `updateJob stop`：停止全部输出 Job。
4. `customCode`：调用 JS 清理函数（包在 `safeCall` 里）。

> ⚠️ **顺序是有意这么排的（2026-09-30 修正）。** 旧参考实现把 JS 归零放在第 1 条，
> 但本节末尾又说"JS 抛错时 Final Actions 是唯一保障" —— 这自相矛盾：
> 如果某个 Action 抛错会让 XToys 中止后续 Action，那么先跑 JS 就等于把唯一的
> 硬件硬保障押在"JS 不抛错"上。所以**字面量归零必须排在 `customCode` 之前**。
> 生成器 `tools/build-xtoys-script.mjs` 里有对应自检，顺序被写错时会拒绝产出 JSON。

**这些显式 UI 归零 Action 是强制项。** JS 也会归零变量，但当 JS 抛错、运行时未初始化或 Job 刷新失败时，Final Actions 是唯一的硬件停止保障。它们只写"当前输出 = 0"，**不修改设备最大强度或最大旋转速度**。

> ⚠️ **频率与模式不属于"归零"范畴（2026-09-30 定）。**
> `frequency` 是 E-Stim 的**调制设置**，不是刺激量：`estimIntensity = 0` 时设备本来就无输出。
> 因此 **Initial / Final Actions 都不应该把频率归零** —— 音频归零只需 `setVolume = 0`。
> 频率的缺省语义是"保持设备当前值"，规则见 `docs/03-protocol-mapping.md` §4.5。
> 上面 1. 与 3. 里写的 `setFrequency=0` 属于旧参考实现的做法，本项目**不沿用**。
> `setMode` 同属设置项而非当前输出值，**是否保留为固定动作待确认**。

---

## 8. 已知 / 未知清单

✅ **已实测确认**：顶层结构、`customFunctions` 为字符串、上述四种 channel 类型、`updateVariable`/`updateComponent`/`updateJob`/`customCode` 形状、`setVolume`/`setFrequency`/`setMode`/`setDirection`、`{变量名}` 占位符、`requiredExpression`、timer + `goTo` 自循环、`trigger-payload` 魔法值、`setVariable`/`getVariable`/`callAction` 宿主 API、ES5 约束。

⚠️ **推断，需在 XToys UI 复核**：`rampTime` 单位为秒；`percentVolume`/`frequencyPercent` 为相对设备上限的 0–100 百分比；`updateJob` 是否接受除 start/stop/goTo 之外的动作；`setFrequency` 的 `format` 其他取值；Webhook 载荷大小上限。

✅ **已实测确认（2026-09-30，本地联调）**：**Webhook 端点对会被接收端整体拒绝的载荷也返回 HTTP 200。**
因此 HTTP 状态码**不能**用来判断命令是否被接受 —— 只能看 Script 日志或诊断变量。见 `docs/06` §0.1。

❌ **实测确认不可靠（2026-09-30，真机）**：**`updateVariable` 写入的长 JSON 字符串，再由 JS
`getVariable` 读回来时会损坏。** 实测写进去 494 字符的合法 JSON，读回来只有 91 字符，
且所有值变成 `undefined`。参考实现用同样动作传过 1763 字符的配置并能导入，所以不像单纯的长度
上限，**原因未查明**。规避方式：需要传给 JS 的配置走 `customCode` 的 `variables` 注入
（与触发器传 `payload` 同一机制），不要依赖"写变量再读回来"。见 `docs/07` §1.1。

❌ **未验证**：真实设备行为、JS-Interpreter 的实际执行速度与调度抖动、导出 JSON 与导入 JSON 是否存在字段差异（旧文档要求每次测试记录差异，一直是 `待填写`）。

> 任何一次真机测试后，请把发现的差异补写进本节。
