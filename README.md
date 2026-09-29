# XToys Haptic Bridge（重启版）

把游戏里的战斗/状态事件通过 Webhook 转发给 XToys，驱动实体设备（E-Stim / 振动 / 旋转）。

本工作区是**保留知识、丢弃实现**的重启版本：只留下实测确认过的 XToys 平台知识、通信协议、
游戏事件映射与参考代码，不含旧的通用运行时引擎与测试。

## 先读这个

**[HANDOFF.md](HANDOFF.md)** —— 主工作文档。包含项目目标、硬约束、XToys 脚本语法、通信协议、
游戏映射、重做路线图、真机验收清单。

## 目录

| 路径 | 内容 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | 主工作文档（入口） |
| [docs/xtoys-script-format.md](docs/xtoys-script-format.md) | XToys 脚本 JSON 语法与宿主 JS API |
| [docs/webhook-protocol.md](docs/webhook-protocol.md) | 游戏 → XToys 通信协议（精简版） |
| [docs/game-event-mappings.md](docs/game-event-mappings.md) | 各游戏事件映射与 probe 方法论 |
| [examples/](examples/) | 真实可导入的 Script 示例（**仅作语法参考**） |
| [reference/](reference/) | 旧游戏侧适配器源码（MV / MZ / UE4SS / BepInEx） |

## 安全

只控制当前输出值，**不修改设备最大强度与最大旋转速度**。停止 Script 时 Final Actions 必须显式把所有输出归零。
不要把填了真实值的 XToys Webhook ID 提交进仓库。
