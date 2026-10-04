# XToys Haptic Bridge

把游戏里的战斗/状态事件通过 Webhook 转发给 XToys，驱动实体设备（E-Stim / 振动 / 旋转）。

游戏侧只描述**逻辑意图**（哪个部位、多大强度、多久），XToys 侧负责把逻辑部位映射到具体
物理执行器。两边通过一个稳定的 Webhook 协议解耦。

---

## 当前状态（2026-10-05）

**阶段 0（XToys 接收端）已完成并在真机验证通过。**

| 项 | 状态 |
| --- | --- |
| ES5 运行时 + 9 个 Block 的可导入 Script | ✅ |
| 本地测试 105 项 + 契约检查 | ✅ 全绿 |
| 真机验收 14 步 | ✅ 符合 13 / 无法验证 2 |
| Final Actions 安全性时序专项验证 | ✅ 有真机证据 |
| **旋转两方向** | ❌ **无旋转器，未验证** |
| 游戏侧插件（阶段 1） | ⬜ **未开始** |

- **怎么用**：看 [docs/06-minimal-script-build.md](docs/06-minimal-script-build.md)
  （导入、在 UI 绑定 Block、跑验收）。
- **想知道为什么这么设计**：看 [docs/03-protocol-mapping.md](docs/03-protocol-mapping.md)
  与 [docs/04-architecture-flow.md](docs/04-architecture-flow.md)。
- **想了解现状与待办**：看 [docs/07-stage0-status-and-todo.md](docs/07-stage0-status-and-todo.md)。

---

## 先读这个

**[HANDOFF.md](HANDOFF.md)** —— 主工作文档入口：项目目标、不可协商的硬约束、XToys 平台知识
摘要、路线图。

## 目录

| 路径 | 内容 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | 主工作文档（入口） |
| [docs/01-xtoys-script-format.md](docs/01-xtoys-script-format.md) | XToys 脚本 JSON 语法与宿主 JS API（含实测确认/未验证清单） |
| [docs/02-webhook-protocol.md](docs/02-webhook-protocol.md) | 游戏 → XToys 通信协议 |
| [docs/03-protocol-mapping.md](docs/03-protocol-mapping.md) | part → Block 映射与仲裁（**权威定义**） |
| [docs/04-architecture-flow.md](docs/04-architecture-flow.md) | Webhook → Block 输出 的完整数据流与时序图 |
| [docs/05-game-event-mappings.md](docs/05-game-event-mappings.md) | 各游戏事件映射 + probe 方法论 |
| [docs/06-minimal-script-build.md](docs/06-minimal-script-build.md) | **怎么导入、绑定、验收**（阶段 0 交付说明） |
| [docs/07-stage0-status-and-todo.md](docs/07-stage0-status-and-todo.md) | 当前状态、真机验收记录、剩余待办 |
| [src/](src/) | ES5 运行时（被嵌入 Script 的 `customFunctions`） |
| [tools/](tools/) | 生成器、契约检查、逻辑测试、真机验收脚本 |
| [examples/](examples/) | `xtoys-minimal-3path.json` 是**要导入的那份** |
| [reference/](reference/) | 旧游戏侧适配器源码（MV / MZ / UE4SS / BepInEx，只作参考） |

## 常用命令

```powershell
npm run build      # 生成 examples/xtoys-minimal-3path.json（含 7 项结构自检）
npm run test       # 105 项运行时逻辑测试（mock 宿主）
npm run contract   # Script JSON ↔ 运行时 契约检查
npm run verify     # = build && test && contract

# 改完运行时后必须重新生成并【重新导入】到 XToys
```

真机验收：

```powershell
$env:XTOYS_WEBHOOK_ID = "<真实 ID>"
pwsh -File tools/Invoke-XtoysAcceptance.ps1 -SkipUnverifiable
```

## 安全

- 只控制**当前输出值**，**绝不修改设备最大强度与最大旋转速度** —— 那始终是用户的设置。
- Final Actions 的**字面量归零**排在 `customCode` 之前，是经真机验证的**必需**顺序
  （见 [docs/01](docs/01-xtoys-script-format.md) §7）。
- **不要把填了真实值的 XToys Webhook ID 提交进仓库。**
