# 游戏事件映射知识

本文件保存**已实测确认**的游戏内部事件 → 逻辑部位/强度的映射。这些是通过逐游戏 probe（探测）得到的一手结论，
是重做时最省时间的资产：**不要重新猜，直接用**。

后续每接入一个新游戏，把结论追加到本文件。

---

## 0. 通用方法论：probe 先行

不要假设变量/字段 ID。流程：

1. **判定引擎与布局**：RPG Maker MV 用 `www/js/rpg_*.js`，MZ 用 `js/rmmz_*.js`；
   Unity 用 BepInEx + Harmony；UE 用 UE4SS Lua Mod。
2. **写独立探针**，与正式 Bridge 分开：
   - RPG Maker：Hook `Game_Switches.prototype.setValue`、`Game_Variables.prototype.setValue`，另加战斗动作/状态。
   - Unity：Harmony postfix 打在候选方法上，dump 字段变化。
   - UE：反射遍历候选对象，dump 属性与数值。
3. **一次只触发一个行为**地玩，收集日志。
4. **只信可重复的量**：优先计数器、累计值、阶段变量；避免只和动画相关的字段。
5. 从日志提取：部位开关、强度变量、阶段变量、高潮计数器。
6. **探针必须在正式 Bridge 里默认关闭或独立分发**，不要让它成为运行时依赖。

探针写日志、弹窗要防右键菜单崩溃（RPG Maker 里选中文字后右键会崩游戏，需拦截 `contextmenu`）。

---

## 1. RPG Maker MV — 駆錬輝晶（原始参考实现）

- 路径：`駆錬輝晶 クォルタ　アルミネス＆タンジェル EG/www/js/plugins/XtoysWS.js`
- 完整拷贝见 `reference/rpg-maker-mv/XtoysWS.js`。
- 它是整个项目的起点：直接 POST XToys Webhook + 运行时弹窗填 Webhook ID + 本地日志。
- 该实现是**游戏专属**的，不要直接搬到别的游戏；只作为"最小可用形态"的参考。

---

## 2. RPG Maker MZ — レピテーション！

- 桥接插件：`reference/rpg-maker-mz/XtoysBridgeMZ.js`（用户确认实际运行正常）。
- 这个游戏用**开关 + 变量**表达全部状态，映射表如下。

### 2.1 部位 EP 攻击开关（false → true 即一次命中）

| 开关 | 游戏内名称 | 建议部位键 |
| --- | --- | --- |
| #83 | 汎用EP攻撃中 | `generic_ep`（可映射到 whole_body） |
| #84 | 胸EP攻撃中 | `breast` |
| #85 | 乳首EP攻撃中 | `nipple` |
| #86 | 陰唇EP攻撃中 | `vulva` |
| #87 | クリEP攻撃中 | `clitoris` |
| #88 | 膣EP攻撃中 | `vagina` |
| #89 | 口EP攻撃中 | `mouth` |
| #90 | 腋EP攻撃中 | `armpit` |
| #91 | お尻EP攻撃中 | `butt` |
| #92 | 両穴EP攻撃中 | `vagina + anus`（双穴） |
| #93 | 突起EP攻撃中 | `nipple`（突起） |
| #94 | 全身EP攻撃中 | `whole_body` |

### 2.2 EP 与高潮变量

| 变量 | 名称 | 用途 |
| --- | --- | --- |
| #29 | 絶頂までのEPストック | 上升时发强度更新（epStock） |
| #39 | 1ターンEP合計 | 每回合 EP 量，可作强化参考 |
| #40 | 当前/显示用 EP 镜像 | 观察用 |
| #112 | 絶頂経験 | **上升即高潮**，比推断 EP 存量可靠 |
| #113 | 淫乱度/状态值 | 可用于提升基线 |

### 2.3 拘束

| ID | 名称 | 用途 |
| --- | --- | --- |
| 变量 #24 | 拘束段階 | 变化时更新基线强度 |
| 开关 #44 / #45 / #46 | 拘束中 / 拘束攻撃許可 / EP攻撃許可 | 观察用 |

### 2.4 经验计数器（理解日志用，不必发协议）

变量 #102 胸経験、#103 乳首経験、#104 陰唇経験、#105 クリ経験、#106 膣経験、#107 口経験、
#108 腋経験、#109 尻経験、#110 H攻撃経験、#111 自慰経験（常出现在 #83 之前）。

### 2.5 催眠/洗脑（已确认但当前不发送）

变量 #34 催眠段階（0→6）、开关 #42 催眠状態ON、#43 洗脳状態ON、#50 洗脳攻撃許可；
状态 #37–#39 催眠LV1–3、#40–#42 洗脑LV1–3；变量 #88 催眠经验、#91 催眠攻击子结果。
技能 #241 手部催眠攻击、#246 面纱催眠攻击。

> 结论：催眠字段对玩具脚本价值低，**保持不发送**。需要时再启用。

### 2.6 实现注意事项

- 高潮锁窗口：避免同一高潮重复发送（旧实现用 8 秒锁 + 发送失败重试）。
- 命中冷却：旧实现 120 ms，防止同一开关抖动产生连环命中。
- 弹窗必须拦截原生右键菜单，否则选中文字右键会崩游戏。

---

## 3. Unity — ドミネートプラン（BepInEx + Harmony）

- 形式：BepInEx 插件，只发 Webhook，正式 Bridge 与探针分离。
- 源码拷贝见 `reference/dominate-plan/`。

### 3.1 运行时字段映射

| 游戏字段（BattleStatus） | 部位 |
| --- | --- |
| KuchiPlus（值 KuchiSt，UI Ku_H/Num） | `mouth` |
| MunePlus（MuneSt，Mu_H/Num） | `chest` |
| KabuPlus（KabuSt，Ka_H/Num） | `lower` |
| KethuPlus（KethuSt，Ke_H/Num） | `butt` |
| HigyakuPlus | `abuse`（已确认映射，当前未接） |

高潮检测：执行完部位方法后检查 `OrgNow >= 1`，Bridge 自己维护高潮计数。

### 3.2 关键经验：必须做批量合并

游戏攻击事件极密，逐条 POST 会打爆 Webhook。实测有效参数：

- 单部位重复命中冷却 50 ms
- 命中批量窗口 200 ms（窗口内同部位保留最新值）
- 高潮去重窗口 1000 ms
- POST 成功日志按 5 s 聚合（否则日志刷屏）

批量载荷用**固定槽位顺序**，缺失部位发 JSON `null`，让 XToys 侧条件判断更简单：

```json
{
  "action": "hit",
  "batched": true,
  "windowMs": 200,
  "part1": "mouth", "partValue1": 1234, "partPercent1": 12.5,
  "part2": null,    "partValue2": null, "partPercent2": null,
  "part3": "lower", "partValue3": 5678, "partPercent3": 45,
  "part4": null,    "partValue4": null, "partPercent4": null
}
```

结论：partValue 对输出控制不重要，XToys 侧用 `partPercent`。

> ⚠️ 注意：这个游戏用的是**自己的旧式扁平协议**（外层 action 取 hit/climax/test），
> 不是本仓库的通用协议。重做时应统一到 `docs/02-webhook-protocol.md`。

---

## 4. UE — Aruna and the Labyrinth of SealedLewd（UE4SS Lua Mod）

- 形式：UE4SS Mod，Lua 侧读内存对象并 POST。源码见 `reference/aruna-ue4ss/`。

### 4.1 目标对象

- 类：`WG_Converter_C`，路径 `/Game/0LDAC/00Actor/Pawn/0Component/Converter/WG_Converter.WG_Converter_C`
- 版本 1.206 反复测试中 **instance=2** 是活动实例；instance=1 基本静止（BDValue 全 0、Core=50000）。
  选择实例应按"开发值有增量 / Core 在变"判断，而不是取第一个。

### 4.2 部位开发值

- `DevelopmentParts`：部位名数组
- `BDValue`：累计开发值数组（**累计值**，必须用**采样差值**判断当前刺激，不能把非零当活动标志）
- 索引映射：1 口腔→`oral`、2 乳房→`breast`、3 クリトリスペニス→`clit_penis`、
  4 フタナリ→`futanari`、5 尿道→`urethra`、6 膣→`vagina`、7 肛門→`anus`
- 全身攻击会让 7 项一起增长；单点攻击会明显偏向某一项
  （实测一次胸部攻击：breast 增量约为其他联动项的 90 倍）。
- 选部位策略：取**最大正增量**，可选按 delta / maxDelta 做次级权重。

### 4.3 高潮与状态

- `OrgasmNum`（会话内）、`TotalOrgasmNum`（累计）：适合做**事件/增量**源，不适合做连续强度源。
- `ShellOrgasmStrength`、`EnergyOrgasmStrength`：实时刺激/余韵候选，适合做主连续强度。
- `Core`：持续攻击与高潮期下降，可作辅助危险/状态信号，**不要当主强度源**。
- 脱离攻击后 `OrgasmNum`/`Core` 仍会变化一小段时间 → 必须用**衰减或静默窗口**停输出，而不是单次采样。

### 4.4 禁止读取的字段（会崩原生代码）

`BodyDevelopmentName`、`BodyDevelopmentValue`、`DevelopmentPartsText`、`Clitoris`、`Penis`

### 4.5 尚未映射

灵敏度倍率（显示 x1.0→x2.0）、Shell/Energy 进度条及其粉色副条、可见高潮计数。
工作假设：两个 pink bar 对应两个 OrgasmStrength；但**未确认安全字段前不要接**。
