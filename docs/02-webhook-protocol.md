# 游戏 → XToys Webhook 通信协议（精简版）

游戏侧只描述**逻辑身体部位**与**期望效果**。游戏代码里**不得出现** XToys 设备名、通道名、Job 名或设备型号。

本文件是旧 "protocol v1" 的精简版：保留传输封装、字段语义、命令集合；
砍掉自适应重复触发、状态容量上限、逻辑 generation、诊断标签等过度设计内容（见 §7）。

---

## 1. 传输封装

Webhook POST 到 `https://webhook.xtoys.app/<Webhook ID>`，`Content-Type: application/json`。

外层是**固定**的：

```json
{
  "action": "xtoys_game_bridge",
  "payload": "<内层协议对象的 JSON 字符串>"
}
```

- `action` 是 XToys Webhook 的固定路由名，**不能**替换成游戏事件名。
- 真实协议对象必须 `JSON.stringify` 后放进 `payload` **字符串**里。
- XToys 侧 Trigger 用 `payload = {trigger-payload}` 取出该字符串，再交给 JS 解析。

---

## 2. 内层公共字段

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `protocolVersion` | number | 固定 `1` |
| `command` | string | `play` / `update` / `stop` / `set_baseline` / `stop_all`（`test` 见 §5） |
| `source` | string | 必填、非空、稳定标识；建议 ≤ 64 字符。**不得含控制字符** |
| `eventId` | string | `play`/`update` 必填；`stop` 可选；建议 ≤ 64 字符。**不得含控制字符** |
| `sequence` | number | 同一 `source + eventId` 的版本号，必须**严格递增**；`set_baseline` 也必填；**`test` 不需要** |
| `targets` | array | 效果目标，见 §3 |

**身份模型**：`source + eventId` 标识一个有限事件。不同 `source` 可用相同 `eventId` 而互不影响。
同身份只有 `sequence` 严格更大才替换整个事件；重复或更小的序号被忽略。

> `source` / `eventId` **禁止控制字符**（U+0000–U+001F 与 U+007F）。接收端用 `\u0000`
> 作为内部键的分隔符，若 ID 本身含控制字符，两个逻辑上不同的事件会撞成同一个键。
>
> 事件**到期后其序号栅栏仍保留一段时间**（接收端保留 10 分钟）：webhook 重试/重复投递
> 带旧 `sequence` 时必须被拒绝，否则一次重复投递就变成一次重复刺激。

**基线**按 `source` 单独保存，是**完整快照**：新的 `set_baseline` 替换旧快照，遗漏的部位被清除。
`stop_all` 清除所有来源的当前状态，但**每个 source 的基线序号栅栏要保留** —— 停机后同一 source 的下一条
`set_baseline` 仍必须用更大的 `sequence`。Bridge 重启后要么持久化序号，要么换新的 `source`。

---

## 3. targets 字段

| 字段 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `part` | string，必填 | 逻辑部位，见 §4 |
| `estimIntensity` | number，可选，夹 0–100 | **estim（E-Stim）通道**强度目标值。缺失则不驱动 estim 音量 |
| `vibrateIntensity` | number，可选，夹 0–100 | **vibrate（振动）通道**强度目标值。缺失则不驱动 vibrate 音量 |
| `frequency` | number，可选，夹 0–100 | 仅 estim 通道的频率；**`vibrate` 永不消费频率**。缺失 = 保持设备当前频率（见 §3.1） |
| `rotateSpeed` | number，可选，夹 0–100 | 旋转槽速度，**不从任何强度字段推导** |
| `rotateDirection` | `clockwise` / `counterclockwise` | `rotateSpeed > 0` 时必填；**只能由游戏显式发送** |
| `durationMs` | number | 有限事件总时长；`play`/`update` 必须有正值 |
| `rampUpMs` | number，默认 0 | 数值升高时的渐入时间 |
| `rampDownMs` | number，默认 0 | 数值降低 / 停止 / 到期时的渐出时间 |
| `priority` | number，默认 0 | 仲裁第一级。**竞争只发生在同一部位内部**（基线 vs 有限事件、或两个重叠事件），因为一个 Block 专属一个部位、不同部位永不竞争。它让游戏侧能表达"数值更小但更重要"，而不必靠抬高数值抢输出。见 `docs/03-protocol-mapping.md` §5 |

所有数值必须是有限数。协议**不控制**设备最大强度与最大旋转速度 —— 那始终是用户在 XToys 设备设置里的选择。

> ⚠️ **`intensity` 这个字段已废除（2026-10-05）。** 早期版本用一个 `intensity` 同时驱动
> estim 与 vibrate 两条通道。为了让**同一部位同时使用 E-Stim 与振动**的双模设备能被分别控制，
> 改为两个显式字段：`estimIntensity` / `vibrateIntensity`。**不再有兼容的 `intensity` 别名**
> —— 发 `intensity` 会被当成"没有驱动指标"而整体拒绝（这是有意的：静默忽略会让游戏侧
> 以为生效了）。

**一个部位在一个 `targets` 数组里只出现一次。** 该部位的所有指标合并在同一条 target 里；
同一部位重复出现是非法写法，整体拒绝。各指标**各自独立判断**，没有主次或门控关系：

| 指标 | 驱动什么 | 该部位没有对应 Block 时 |
| --- | --- | --- |
| `estimIntensity` | 该部位的 estim 输出 | 忽略并留痕 |
| `vibrateIntensity` | 该部位的 vibrate 输出 | 忽略并留痕 |
| `frequency` | 该部位的 estim 输出（频率维度） | 忽略并留痕 |
| `rotateSpeed` + `rotateDirection` | 该部位的 rotate 输出 | 忽略并留痕 |

- **纯 rotate 的 target 合法**（游戏侧的"只走某几种方式"开关会产生它）。
- `rotateSpeed > 0` 必须给 `rotateDirection`；`rotateSpeed == 0` 表示停止旋转，方向可省。
- 一条 target 若**连一个驱动指标都没有**（`estimIntensity` / `vibrateIntensity` /
  `frequency` / `rotateSpeed` 全缺，含只带 `rotateDirection` 的情况）→ 整体拒绝。

### 3.1 `frequency` 的语义（含真机实测的刻度说明）

- **缺省 = 保持设备当前频率**，不是置零。见 `docs/03-protocol-mapping.md` §4.5。
- `frequency` 是**百分比（0–100）**，映射到设备自身的频率范围。
  ✅ **真机实测（2026-10-05）**：XToys 的默认频率范围是 **10–100**，所以
  `frequency: 30` 在设备上落在 `10 + 30% × 90 ≈ 37` —— 读数 37 是**正确**的，
  不是偏差。**写 0 会落在范围下限 10（最低频），而不是"关闭频率"。**

完整规则（忽略、拒绝、留痕的边界）见 **`docs/03-protocol-mapping.md`** §6.2 / §6.5。

---

## 4. 逻辑部位（叶子）

`mouth`、`breast`、`nipple`、`armpit`、`clitoris`、`vulva`、`vagina`、`urethra`、`anus`、`butt`、`penis`、`prostate`

> 部位名一律用**全称**（`clitoris` / `anus`，不用 `clit` / `anal`）。
> Block 名、Channel ID、变量名、Job 名沿用同一部位名，两边必须完全一致，
> 否则游戏侧发的部位名会被判为未知部位而整体拒绝。见 `docs/03-protocol-mapping.md` §2.1 / §2.3。

**`part` 是协议里唯一的执行定位键。** 协议不包含通道名、设备名、逻辑执行器 id、slot 或权重 ——
"哪个部位对应哪几个 Block"是接收端的配置，见 **`docs/03-protocol-mapping.md`**。

**虚拟组本阶段不做**（原列表：`genitals`、`lower_body`、`double_hole`、`whole_body`、`mixed`）。
原因：一个 Block 专属一个部位，而"组"会落到多个部位的 Block 上、自身没有专属 Block，语义冲突。
游戏侧能区分时直接发叶子部位；区分不了时由游戏侧自己选叶子部位或发多个 target。
详见 `docs/03-protocol-mapping.md` §6.3。

---

## 5. 命令与示例

### `play` — 创建有限事件

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"play\",\"source\":\"my-game\",\"eventId\":\"hit-0001\",\"sequence\":1,\"targets\":[{\"part\":\"clitoris\",\"estimIntensity\":65,\"vibrateIntensity\":30,\"frequency\":40,\"durationMs\":900,\"rampUpMs\":120,\"rampDownMs\":180,\"priority\":10}]}"
}
```

### `update` — 用更高序号替换整个目标集（也是唯一的换向方式）

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"update\",\"source\":\"my-game\",\"eventId\":\"drill-7\",\"sequence\":2,\"targets\":[{\"part\":\"vagina\",\"rotateSpeed\":60,\"rotateDirection\":\"counterclockwise\",\"durationMs\":1500,\"rampUpMs\":100,\"rampDownMs\":200}]}"
}
```

旋转**不会自动反向**。要换向必须显式发新的 `rotateDirection`。

### `stop` — 停止部分或全部

- 只给 `eventId`：移除该来源的这个完整事件。
- `eventId` + `targets`：只移除该事件里列出的部位。
- 只给非空 `targets`：移除该来源所有事件中的这些部位。

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"stop\",\"source\":\"my-game\",\"eventId\":\"hit-0001\",\"targets\":[{\"part\":\"vagina\"}]}"
}
```

### `set_baseline` — 替换该来源的基线快照

用于持续状态（异常状态、拘束阶段、持续发情等）。

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"set_baseline\",\"source\":\"my-game\",\"sequence\":5,\"targets\":[{\"part\":\"clitoris\",\"estimIntensity\":25,\"frequency\":20,\"rampUpMs\":500,\"rampDownMs\":500}]}"
}
```

清空该来源基线（空快照，不影响有限事件）：

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"set_baseline\",\"source\":\"my-game\",\"sequence\":6,\"targets\":[]}"
}
```

### `stop_all` — 紧急全停

立即清除所有来源的基线与有限事件，并把每个已启用槽写为零。优先于普通仲裁。

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"stop_all\",\"source\":\"my-game\"}"
}
```

### `test`（可选）— 只校验不驱动硬件

不需要 `sequence`（它不改变任何状态，没有"新旧"可言）：

```json
{
  "action": "xtoys_game_bridge",
  "payload": "{\"protocolVersion\":1,\"command\":\"test\",\"source\":\"my-game\",\"targets\":[{\"part\":\"clitoris\",\"estimIntensity\":50}]}"
}
```

### 空 `targets` 的区分

| 命令 | `targets: []` |
| --- | --- |
| `set_baseline` | **合法** —— 清空该来源的基线快照 |
| `play` / `update` | **拒绝**（`missing_targets`）—— 没有目标就没有正 `durationMs` |
| `stop` | **拒绝**（`missing_stop_selector`）—— 空选择器什么都没指 |

---

## 6. 错误与限制（建议保留的最小集）

返回 `{ "ok": false, "code": "..." }`。建议保留的错误码：

`invalid_payload`、`invalid_json`、`unsupported_protocol_version`、`unsupported_command`、
`missing_source`、`missing_event_id`、`invalid_sequence`、`invalid_duration`、
`invalid_targets`、`missing_targets`、`missing_stop_selector`、`unknown_part`、
`invalid_number`、`invalid_rotate_direction`、`state_capacity_exceeded`、`invalid_config`

建议限制（**数值大小可自行重定，重点是必须有界**）：

- `payload` 字符串 ≤ 16 KiB（旧值 32 KiB）
- `targets` ≤ 16 条（旧值 32）
- `source`/`eventId` ≤ 64 字符（旧值 128）
- 同时有效事件数 ≤ 64（旧值 128）
- 时长与各 ramp 字段 ≤ 600000 ms

容量超限时**整体拒绝**，不部分写入；停止、到期清理、`stop_all` 不受容量门限制。

---

## 7. 已砍掉的过度设计（不要再加回来，除非有实测需求）

| 被砍内容 | 为什么砍 |
| --- | --- |
| `targets[].retrigger`（7 字段自适应 fall/rise/texture + EMA 节奏） | 复杂度和状态量最大的一块；同强度连击的体感问题应先用更简单的手段试（例如游戏侧直接发带间隔的 `play`） |
| `pulse` + `pulseOnMs`/`pulseOffMs` | 游戏侧自己按节奏发事件即可，接收端不需要内置脉冲状态机 |
| `states` 诊断标签、`blend`、`baselineBlend` 三态混合 | 诊断字段不参与输出；`boost` 的非线性混音公式对触觉不直观，建议只用 `max` 或简单裁剪加法 |
| 逻辑 generation 作为协议/存储概念 | 只是接收端排序用的内部计数器，不应出现在协议或变量里 |
| 32/128/256 之类大容量上限 | 16 槽模板配 64 事件已远超实际需要；上限越小越容易验证 |
| 虚拟组 5 套固定权重 | 需要时再按游戏实际部位补，不要预置一整套 |
