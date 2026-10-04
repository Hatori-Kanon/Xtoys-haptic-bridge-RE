# 阶段 0：最小 Script 的构建、导入与真机验收

> 步骤依据 `docs/04-architecture-flow.md`；映射与命名依据 `docs/03-protocol-mapping.md`；
> JSON 语法依据 `docs/01-xtoys-script-format.md`。验收清单来自 `HANDOFF.md` §9.1。
>
> **本阶段交付物**：`examples/xtoys-minimal-3path.json`（9 个 Block 的可导入 Script）
> + 本文档 + `tools/Invoke-XtoysAcceptance.ps1`（逐条真机验收脚本）。

---

## 0.1 一条实测发现：Webhook 对非法载荷也返回 HTTP 200

本地联调时实测：即使载荷会被接收端**整体拒绝**（例如同一 `targets` 里同部位重复），
Webhook 端点**仍然返回 HTTP 200**。

含义：**HTTP 状态码完全不能用来判断命令是否被接受。** 这也再次印证 `HANDOFF.md` §3.4 ——
同步返回不代表任何执行结果。因此：

- 验收脚本无法自动判定成败，**必须靠你观察设备**。
- 想知道某条命令是否被拒绝，只能看 XToys 的 Script 日志（接收端会记 `rejected <code>` /
  `ignored <detail>`），或读诊断变量 `xthb-rejected-count` / `xthb-ignored-count` /
  `xthb-last-error` / `xthb-last-ignored`。

### 0.2 启动后先在日志里确认初始化成功（重要）

真机首次实测（2026-09-30）启动即失败：`updateVariable` 写入 Script 变量、JS 再读回来时
内容被打坏（**494 字符的合法 JSON 读回来只剩 91 字符且值全变 `undefined`**），
于是初始化失败、运行时静默、所有 webhook 都无反应。现已改为把配置**直接注入**
初始化调用（与触发器传 `payload` 同一机制，真机已验证可用），变量那条路只作兜底。
完整根因见 `docs/07` §1.1。

**启动 Script 后，先看 XToys 日志里有没有这一行：**

```
[xthb] 初始化完成：部位 4 个，Block 9 个（配置来源：object/157字符）
```

- ✅ 有这行且 **`Block 9 个`** → 运行时正常，可以开始验收。
  **以 `Block 9 个` 为准**：它只能从完整配置派生出来。
- ⚠️ 出现 `配置在 tick 里补读成功` → 走了变量兜底路，也正常，但请把这行反馈我。
- ❌ 出现 `init 失败: 配置…` → **把这条日志原文发我**，它会打印实际读到的内容与长度。

> ⚠️ **别被长度数字误导。** 曾出现 `object/15字符` —— 那是 `String(对象)` 得到
> `"[object Object]"` 的 15 个字符，属于诊断代码的坑，不是配置被截断。
> 同一次日志里 `Block 9 个` 才是真实证据。现已改用 JSON 序列化长度。

---

## 0. 先明确三件事

| 事实 | 说明 |
| --- | --- |
| 你不用手工在 UI 里搭 | Script JSON 是 `tools/build-xtoys-script.mjs` 生成的；UI 里只需要**导入 + 绑定设备 + 配 Webhook** |
| **必须手工做的一步** | 导入后把每个 Block 绑定到物理设备/子通道 —— JSON 不能代替这一步（`docs/01` §2） |
| 旋转无法真机验证 | 你目前没有旋转器。`Rotate-nipple` 只用来验证方向 Action 语法与顺序，**真机行为未验证**，交付时不得声称已验证 |

⚠️ **`rotator` 那个通道建议先不绑定任何设备。** 它由 `nipple` 的 `rotateSpeed` 驱动；
一旦将来误发 `rotateSpeed`，未绑定的 Block 不会驱动任何东西，是安全的默认状态。

---

## 1. 生成 / 重新生成

```powershell
npm run build      # = node tools/build-xtoys-script.mjs
```

产物：

| 文件 | 用途 |
| --- | --- |
| `examples/xtoys-minimal-3path.json` | **导入 XToys 用** |
| `examples/xthb-customFunctions.js` | `customFunctions` 的独立可读副本（与 JSON 内嵌内容逐字一致） |

生成时会做自检，任一失败即**中止且不产出 JSON**：Block 专属一个 part、Channel 类型与 metric
匹配、Final Actions 归零齐全、无频率归零、旋转方向排在音量前、每个通道恰好被一个 Job 引用。

### 改动映射（加部位 / 加指标）

只改 `tools/xtoys-naming.mjs` 里的 `PARTS` 表，然后重新 `npm run build` + 重新导入：

```js
export const PARTS = {
  nipple:   { estim: true, vibrate: true, rotate: true },
  clitoris: { estim: true, vibrate: true },
  vagina:   { estim: true, vibrate: true },
  anus:     { estim: true, vibrate: true },
};
```

命名规范（Channel ID / 变量 / Job）由该文件统一派生，不需要手工同步。

---

## 2. 导入 XToys

1. 打开 XToys → Scripts → 导入/粘贴 Script JSON → 选择 `examples/xtoys-minimal-3path.json`。
2. 导入后应看到 **10 个 Job**（1 个调度 + 9 个输出）与 **10 个通道**（1 个 webhook + 9 个 Block）。
3. **不要**在 UI 里改动 Job 名、变量名或通道 ID —— 运行时按名字找它们。
4. 启动后先按 §0.2 确认日志里出现"初始化完成"。

---

## 3. 绑定设备（**唯一的强制手工步骤**）

在 UI 上把每个 Block 绑定到**恰好一个**物理设备或子通道：

| Block（UI 名） | Channel ID | 该绑什么 |
| --- | --- | --- |
| `Estim-nipple` | `part-estim-nipple` | E-Stim 设备/子通道 |
| `Vibrate-nipple` | `part-vibrator-nipple` | 振动设备/子通道 |
| `Rotate-nipple` | `part-rotator-nipple` | ⚠️ **建议不绑**（无设备） |
| `Estim-clitoris` | `part-estim-clitoris` | 可绑到与 Estim-nipple 同一台 E-Stim 的另一个子通道 |
| `Vibrate-clitoris` | `part-vibrator-clitoris` | 振动 |
| `Estim-vagina` | `part-estim-vagina` | E-Stim |
| `Vibrate-vagina` | `part-vibrator-vagina` | 振动 |
| `Estim-anus` | `part-estim-anus` | E-Stim |
| `Vibrate-anus` | `part-vibrator-anus` | 振动 |

要点：

- **一个 Block 只能绑一个**。多个 Block 可以绑到同一台设备的不同子通道；也可以一台设备只服务一个 Block。
- **绝不在设备设置里改动最大强度 / 最大旋转速度**（`HANDOFF.md` §1.3）。Script 只写当前输出值。
- 你只接了 1 个 E-Stim + 1 个振动器，所以 8 个 estim/vibrate Block 会共享这两台设备；
  实测时可以用 `set_baseline` 只驱动某一个部位来分辨是哪条路径在动。

---

## 4. 配 Webhook

1. 在 Script 里找到 `webhook-a` 通道，XToys 会给它一个 **Webhook ID / URL**。
2. Shell 里设置（**不要把真实 ID 写进仓库**，`HANDOFF.md` §3.6）：

```powershell
$env:XTOYS_WEBHOOK_ID = "<粘贴真实 ID>"
```

3. Webhook URL 形如 `https://webhook.xtoys.app/<Webhook ID>`。

---

## 5. 跑真机验收

```powershell
# 全部步骤
pwsh -File tools/Invoke-XtoysAcceptance.ps1

# 只看有哪些步骤，不发任何请求
pwsh -File tools/Invoke-XtoysAcceptance.ps1 -List

# 只跑某几步（调试时很有用）
pwsh -File tools/Invoke-XtoysAcceptance.ps1 -Steps 3,4,5

# 只跑能验的（自动跳过需要旋转器的步骤）
pwsh -File tools/Invoke-XtoysAcceptance.ps1 -SkipUnverifiable
```

脚本会**一步一条**：打印该步要观察什么 → 发一条真实 POST → 等你回答实际观察结果
（`y` 符合 / `n` 不符合 / `s` 跳过 / `q` 退出），最后给出汇总表，可直接粘进 `docs/07`。

**开始前**：在 XToys 里**手动启动 Script**（Initial Actions 会归零并启动调度 Job）。
结束时脚本会提示你手动停 Script 并确认归零。

---

## 6. 各步骤在验什么

| 步骤 | 发什么 | 应观察到 |
| --- | --- | --- |
| 1 | `set_baseline` nipple estim 15 | E-Stim 出现**低强度**持续输出（先确认安全数值！） |
| 2 | `set_baseline` nipple vibrate 25 | 振动器持续振动 |
| 3 | `play` nipple estimIntensity 60 / 900ms | 在基线上叠加一次短暂增强，**约 1 秒后回到基线**（不是归零） |
| 4 | `play` nipple 同强度再来一次 | 运行时**确实**重新驱动了一次；但因为当前强度已经是该值，**体感上可能看不出变化**（正常）——验推送判据里的 driveId |
| 4b | 连发两击、强度相同、之间回落到 0 | **两次独立、可辨的渐入脉冲** —— 这才是重推的可感知场景 |
| 5 | `play` nipple frequency 70 | E-Stim **频率**变化，强度不受影响 |
| 6 | `play` nipple 不带 frequency | 强度变化，**频率保持步骤 5 的值不变**（不是被归零）——验频率缺省语义 |
| 7 | 发 `rotateSpeed`（需旋转器） | ⚠️ **本轮无法验证**，脚本会标记为跳过 |
| 8 | 反向 `update` | 方向立刻改变，无中间停顿（需旋转器；本轮跳转） |
| 9 | 多部位独立（nipple + clitoris 各给不同强度） | 两个部位各自输出自己的值，互不影响 | 
| 10 | `stop_all` | **所有输出立刻归零** |
| 11 | 手动停 Script | 所有输出归零（Final Actions 兜底） |
| 12 | 发畸形载荷 / 未知部位 / 重复部位 | 脚本日志出现 rejected / ignored，**设备无反应** |

> 步骤 5、6 是这次重写最核心的两条语义，**必须验**：
> - 步骤 6 验的是 `docs/03` §4.5「频率缺省 = 保持设备当前值」。
> - 步骤 4 验的是 `docs/03` §4.4「值或驱动者身份变化就推送」。

---

## 7. 本轮无法验证的部分（如实记录）

| 项 | 为什么 | 状态 |
| --- | --- | --- |
| 旋转两个方向 | 没有旋转器 | **未验证**（`Rotate-nipple` 只验证了 Action 语法与顺序） |
| `rampTime` 单位真的是秒 | `docs/01` §4.2 一直标 ⚠️ 未独立验证 | 验收步骤 3 可间接观察：900ms 事件若渐变明显偏长/偏短，说明不是秒 |
| `requiredExpression` 的 `>` 运算符行为 | 频率条件动作依赖 `{var} > 0` | 步骤 5/6 会覆盖：频率 0 与 >0 两种情况都要走到 |
| 导出 JSON 与导入 JSON 的字段差异 | 旧文档一直待填写 | 导入后如果 UI 里发现字段被改写，请记录到 `docs/01` §8 |

**任何一项未能观察到的，就写"未验证"，不要写成"通过"。**

---

## 8. 验收后要做的事

1. 把实测差异补进 `docs/01-xtoys-script-format.md` §8 的 ⚠️/❌ 清单（尤其是 `rampTime` 单位）。
2. 把本轮结果记进 `docs/07-stage0-status-and-todo.md`。
3. 记录本次测试的 Script 修订号与设备/通道绑定（`HANDOFF.md` §9.1 最后一条）。
4. 提交时**不要**包含真实 Webhook ID。

---

## 9. 本地验证（不需要设备，也不需要 XToys）

```powershell
npm run verify     # = build && test && contract
```

| 命令 | 验什么 | 不能验什么 |
| --- | --- | --- |
| `npm run build` | Script JSON 结构、映射自检 | 真机行为 |
| `npm run test` | 56 项运行时逻辑（映射 / 仲裁 / 序号栅栏 / driveId 推送 / 频率缺省 / 归零 / ES5 子集） | 真机行为 |
| `npm run contract` | **Script JSON 与运行时的契约**：输出 Job 引用的每个 `{变量}` 都确实被运行时写过 | 真机行为 |

> `npm run contract` 抓到过一个真实缺陷：生成器按 metric 命名（`xthb-vibrate-*`），
> 运行时按 Channel ID 命名（`xthb-vibrator-*`），输出 Job 去读了永远没人写的变量 ——
> 单元测试当时全绿，因为测试里的期望值也是照同一个错误假设手写的。现在命名规则
> 只有一个真源（`tools/xtoys-naming.mjs`），且契约检查动态验证写入方。

**本地验证全绿 ≠ 真机可用。** mock 宿主只说明"JS 调用没有同步抛异常"，
不代表 Job 执行了、设备收到了（`HANDOFF.md` §3.4）。
