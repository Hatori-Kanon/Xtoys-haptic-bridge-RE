# XToys 接收端问题报告（来自游戏侧联调）

日期：2026-10-07
提出方：游戏侧桥接（`Game-plugin-for-Xtoys/repetition-bridge`）
接收端版本：`Xtoys-haptic-bridge`（`src/xtoys-bridge.js`，1920 行）
证据：真机控制台日志 `xtoys.app-1791314455751.log`（305 KB / 3253 行）

> 说明：本报告的**全部结论都基于该日志 + 接收端源码**，未做任何修改。
> 三个问题按严重程度排列；**问题 1 是阻塞性的**。

---

## 结论速览

| # | 问题 | 严重度 | 归属 |
| --- | --- | --- | --- |
| **1** | **过期事件占用容量名额 → 连续使用必然耗尽 64 上限** | 🔴 阻塞 | 接收端（容量统计口径） |
| **2** | tick 里 `Cannot read property 'finishAtMs' of undefined` | 🟠 高 | 接收端（数组过滤/删除时序） |
| **3** | `did not finish running in allotted time` 告警 235 次 | 🟡 中 | 双方（解释器负载），但接收端可优化 |

接收端**做得好的部分**（请保留）：协议解析、`ignored`/`rejected` 分类日志、
初始化自检、Final Actions 归零时序 —— 本次联调全程 **0 条 `ignored`**，说明四个部位
与两条通道的映射配置、以及忽略语义都完全正确。

---

## 问题 1（🔴 阻塞）：过期事件占用容量，导致连续攻击必然失败

### 现象

游戏侧连续点 4 次"攻击纹理"（每次 35 条命令），结果：

| 次序 | 结果 |
| --- | --- |
| 第 1 次 | ✅ 35/35 全部接受 |
| 第 2 次 | ⚠️ 只接受 29，**从第 12 个脉冲起被拒 6 条** |
| 第 3 次 | ❌ 只接受 11，**从第 0 个就被拒 24 条** |
| 第 4 次 | ❌ **全部被拒**（日志里连"收到"都没有） |

日志统计：`收到 111 条`、`rejected 45 条`（**全部是 `state_capacity_exceeded`**）。

被拒命令的 `eventId` 精确对应：`a2` 从 `p12/f12` 起被拒，`a3` 从 `f0/p0` 起被拒。

### 根因（源码级）

```js
// L94-96
var XTHB_MAX_EVENTS = 64;
var XTHB_EXPIRED_EVENT_KEEP_MS = 600000;   // 10 分钟

// L785-787  ← 问题在这里
if (!existing && xthbCountOwn(xthbEvents) >= XTHB_MAX_EVENTS) {
  return { ok: false, code: "state_capacity_exceeded" };
}
```

`xthbCountOwn(xthbEvents)` 数的是**容器里所有条目**，而按 L1487-1499 的设计，
事件到期后**不会被删除**，要再等 `XTHB_EXPIRED_EVENT_KEEP_MS`（10 分钟）才删：

```js
// L1491-1498
if (xthbEvents[key].finishAtMs <= nowMs) {
  if (xthbEvents[key].expiredAtMs < 0) xthbEvents[key].expiredAtMs = nowMs;
  if (nowMs - xthbEvents[key].expiredAtMs > XTHB_EXPIRED_EVENT_KEEP_MS) {
    delete xthbEvents[key];
  }
}
```

**于是容量被"只剩序号栅栏作用、已不再产生任何输出"的死事件长期占满。**

本次实测：游戏侧一次攻击纹理 = **34 个独立 `eventId`**
（1 握力 + 17 强度脉冲 + 17 频率波纹），每个 `durationMs` 仅 250–700 ms，
但**每个都要占用一个 10 分钟名额**：

```
第 1 次攻击后：占用 34 / 64        （余量 30）
第 2 次攻击：34 + 30 = 64 封顶 → 后 6 条被拒
第 3 次攻击：占用已 63 → 只进 1 条
第 4 次攻击：占用已 64 → 全拒
```

行为特征：**越用越死**。被拒的命令不写入状态，占用停在 64，
之后每次新事件都被拒，直到 10 分钟保留期把最早的清掉。用户感受是
"玩着玩着设备就完全没反应了"，而 HTTP 永远 200，无从察觉。

### 这与设计意图的冲突

代码注释（L1484-1485）说明保留过期事件是**有意**的：

> 重试/重复投递的 webhook 若带旧 sequence 必须被拒，否则一次重复投递就会变成重复刺激

这个意图是对的，但**"保留栅栏"不应该等于"占用容量"**：
栅栏只需要在**收到同 `source + eventId` 的新命令时**做比较，
而 `xthbEvents` 里的旧条目已经在履行这个职责 —— 没有必要同时占着"活跃事件"的名额。

### 建议修法（三选一，推荐 A）

**A. 容量统计改用"仍在驱动输出的事件数"（最小改动、语义最准）**

代码里**已经有现成函数**（L1536-1548），目前只用于诊断变量：

```js
/* 仍在驱动输出的有限事件数（不含仅作序号栅栏保留的过期事件）。 */
function xthbCountLiveEvents(nowMs) { ... }
```

把 L785 改成用"活跃数"做闸门：

```js
- if (!existing && xthbCountOwn(xthbEvents) >= XTHB_MAX_EVENTS) {
+ if (!existing && xthbCountLiveEvents(xthbNowMs()) >= XTHB_MAX_EVENTS) {
```

顺序栅栏语义**完全不受影响**（旧 eventId 条目仍在 `xthbEvents` 里参与
`sequence <= existing.sequence` 判定），但容量不再被死事件吃掉。

**B. 缩短保留期** `XTHB_EXPIRED_EVENT_KEEP_MS`：600000 → 120000（或更短）。
缓解但不根治 —— 仍会随会话时长线性堆积。可与 A 并用。

**C. 容量超限时"先清过期、再判容量"**：在 `xthbApplyPlay` 前主动做一次
过期清理，使闸门看到的是清理后的数。也可与 A 并用。

### 请一并考虑

- `xthb-active-events` 诊断变量（L1518）已经存在，但它用的是
  `xthbCountLiveEvents`，而闸门用的是 `xthbCountOwn` —— **两个口径不一致**，
  这会让诊断变量看起来"远没满"，而实际已经被拒。建议统一。
- 建议在 `state_capacity_exceeded` 的日志里带上数字，例如
  `rejected state_capacity_exceeded (live=12, retained=52, max=64)`，
  否则无法从日志区分"真的事件风暴"与"栅栏堆积"。
- 建议在 docs 里明确写一句：**"容量按活跃事件计，过期栅栏不占容量"**，
  否则游戏侧无法预估自己一次能发多少个事件。

---

## 问题 2（🟠 高）：tick 抛 `TypeError: Cannot read property 'finishAtMs' of undefined`

### 现象

日志 L3086（**停止 Script 的收尾阶段**，之后紧跟 Final Actions 归零与 `Socket closed`）：

```
TypeError: Cannot read property 'finishAtMs' of undefined
    (匿名) @ 54ba7a69-....js:2
    runCustomCode @ 890897c3-....js:7
    ...
    at Array.filter (<anonymous>)
    at M.runCustomFunction @ 890897c3-....js:7
    at M.calcAt @ 890897c3-....js:7
```

关键线索：调用栈里有 **`Array.filter`**，说明抛出点在某个
`xs.filter(function (e) { ... e.finishAtMs ... })` 里，且**被遍历的元素本身是 `undefined`**。

### 可疑代码位置（按可能性排序）

**① L870-877（`stop` 的处理，空壳事件清理）—— 最可疑**

```js
for (key in xthbEvents) {
  if (!xthbHasOwn(xthbEvents, key)) continue;
  event = xthbEvents[key];
  if (event.source === source && xthbCountOwn(event.parts) === 0) {
    delete xthbEvents[key];
  }
}
```

两点隐患：

- 这轮循环**复用了 L830/855 已用过的变量 `key`**（没有重新声明），
  在 `for...in` 中改写外层/同函数作用域的 `key` 会影响外层逻辑；
- 遍历中 `delete xthbEvents[key]`（**边遍历边删**），
  在某些 JS 解释器下会跳过或重复元素。

**② 与 L1409 / L1845 / L1902 的 `xthbEvents = {}` 交互**

三处会把整个容器**替换成新对象**。若此刻 `customFunctions` 是常驻实例，
而 tick 或过滤器仍持有**旧对象的引用**（或某处缓存的 `key` 列表），
就会出现"引用到的条目是 undefined"。

**③ 未受保护的读取**

L1491 `xthbEvents[key].finishAtMs` 有 `xthbHasOwn` 守卫；
L1543 同一个守卫。**但只要有一个入口往容器里塞了"部分构造"的条目
（只有 `{source, eventId}`，没有 `finishAtMs`），
这些守卫都拦不住** —— `xthbHasOwn` 只判断键存在，不判断值完整。

### 建议修法

1. **所有读取加完整性守卫**（防御性，成本极低）：

```js
var e = xthbEvents[key];
if (!e || typeof e.finishAtMs !== "number") { delete xthbEvents[key]; continue; }
```

2. **`stop` 的空壳清理改成先收集再删**，并**换一个独立的循环变量**：

```js
var dead = [];
for (var k in xthbEvents) {
  if (!xthbHasOwn(xthbEvents, k)) continue;
  var ev = xthbEvents[k];
  if (!ev || !ev.parts) { dead.push(k); continue; }
  if (ev.source === source && xthbCountOwn(ev.parts) === 0) dead.push(k);
}
for (var i = 0; i < dead.length; i++) delete xthbEvents[dead[i]];
```

3. **`xthbEvents = {}` 改为清空而非替换**，避免悬垂引用：

```js
function xthbClearEvents() {
  for (var k in xthbEvents) if (xthbHasOwn(xthbEvents, k)) delete xthbEvents[k];
}
```

4. **把 tick 的入口整体包 try/catch**（`docs/07` 的 F1 已有同类要求），
   保证一次异常不会让调度 Job 从此失效 —— 本次日志显示异常后仍有 26 次 tick，
   但**不能因此假设总是能恢复**。

---

## 问题 3（🟡 中）：`JavaScript did not finish running in allotted time` 出现 235 次

### 现象

- 首次出现：L1098（第 1 次攻击的**第二个**事件）
- 末次出现：L3059 —— **贯穿整个测试过程**
- 同期 `received 111` 条命令

### 判断

按 `docs/01` 的说法该告警**不影响功能**，但 235 次说明协议处理路径
在 JS-Interpreter 里的单次执行预算已经被顶满。触发条件大概：
每个 POST 要解析 JSON + 校验 + 写事件 + 写诊断变量 + 打日志。

**这一条是双方共同责任**（游戏侧已计划把一次攻击的事件数从 34 降下来），
但接收端仍有优化空间：

- `xthbWriteDiagnostics`（L1520-1524）每次 tick 调 5 次 `xthbSetDiag`，
  虽然内部有"值没变就跳过"的缓存，但**判断本身仍要跑**；
- `xthbLog` 的摘要生成（L1550+ 注释提到从"打印原文"改为"打印关键字段"）
  已经是正确方向，可继续减少每次 tick 的字符串构造；
- 建议给"日志级别"加一个开关，真机联调时可关掉逐条 `收到 …` 日志
  （本次 3253 行日志里绝大多数是 Job/Action 轨迹，对定位帮助有限）。

---

## 附：本次联调的对账数据（供回归验证）

| 指标 | 数值 |
| --- | --- |
| 日志行数 | 3253 |
| `收到` | 111（`play` 109 + `test` 1 + `stop_all` 1） |
| `rejected` | 45（**全部 `state_capacity_exceeded`**） |
| `ignored` | **0** ✅（说明四部位 + estim/vibrate 两条通道配置正确） |
| 初始化 | `部位 4 个，Block 9 个（配置来源：object/139字符）` ✅ |
| Coyote `Set Intensity` | 72 次（其中 0% 22 次） |
| Opossum `Set Intensity` | 72 次（其中 0% 22 次） |
| `Set Frequency` | 50 次 |
| `did not finish` 告警 | 235 次 |
| `finishAtMs` TypeError | 1 次（收尾阶段） |

游戏侧一次攻击纹理的事件构成（用于核对容量预算）：

```
rpt-<part>-a<N>-grip      1 个（durationMs 6500）
rpt-<part>-a<N>-p<0..16> 17 个（durationMs 250/700）
rpt-<part>-a<N>-f<0..16> 17 个（durationMs 250，只负责把频率推上去）
                          ─────
                          35 条命令 / 34 个新 eventId / 6.5 秒
```

---

## 修好之后的验收建议

1. **连续发 5 次攻击纹理（每次 34 个事件），全程 `rejected` 应为 0。**
   这是问题 1 的直接验收条件。
2. 发完之后看 `xthb-active-events`：30 秒后应回落接近 0
   （而不是停在 64 左右）。
3. 反复"启动 → stop_all → 再发"多轮，不应出现 `finishAtMs` TypeError。
4. 连续发 5 次攻击后，`did not finish` 告警次数应明显下降
   （游戏侧会同步把事件数从 34 降到 ~18，两边一起降）。
