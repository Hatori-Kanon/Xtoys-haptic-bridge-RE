#!/usr/bin/env node
/*
 * 把 src/xtoys-bridge.js（ES5 运行时）+ 通道 / Job / Action 骨架
 * 组装成可直接导入 XToys 的 Script JSON。
 *
 * 用法：
 *   node tools/build-xtoys-script.mjs
 *
 * 输出：
 *   examples/xtoys-minimal-3path.json   ← 导入 XToys 用
 *   examples/xthb-customFunctions.js    ← 与 JSON 内嵌内容完全一致的独立副本
 *
 * 命名与映射规则全部来自 tools/xtoys-naming.mjs（单一真源，见该文件头注释）。
 * 依据：docs/03-protocol-mapping.md、docs/04-architecture-flow.md
 *
 * 安全边界（HANDOFF.md §3.2）：
 *   - 归零 = 归零音量。绝不写频率（频率是设置项，缺省=不动，docs/03 §4.5）。
 *   - 不含任何设置最大强度 / 最大旋转速度的 Action。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_METRICS, FREQUENCY_SENTINEL, KNOWN_PART_NAMES, METRIC_TYPE,
  SCHEDULER_INTERVAL_SECONDS, SCHEDULER_JOB,
  buildBlocks, buildBridgeConfig,
} from "./xtoys-naming.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const RUNTIME_SRC = join(ROOT, "src", "xtoys-bridge.js");
const OUT_JSON = join(ROOT, "examples", "xtoys-minimal-3path.json");
const OUT_JS = join(ROOT, "examples", "xthb-customFunctions.js");

const BLOCKS = buildBlocks();
const BRIDGE_CONFIG = buildBridgeConfig();

/* ==================================================================
 * 通道定义
 * ================================================================== */

function buildChannels() {
  const channels = {
    "webhook-a": { name: "", type: "webhook", outbound: false, hideWebhookInfo: false },
  };
  for (const b of BLOCKS) {
    channels[b.channelId] = { name: b.uiName, type: METRIC_TYPE[b.metric] };
  }
  return channels;
}

/* ==================================================================
 * Action 助手
 * ================================================================== */

function customCode(code, variables = []) {
  return { type: "customCode", code, resultVar: "result", variables, storeResult: false };
}

function updateVariable(variable, value) {
  return { type: "updateVariable", variable, value };
}

function updateComponent(action, channel, extra) {
  return Object.assign({ type: "updateComponent", action, channel }, extra);
}

function startJob(job) {
  return { type: "updateJob", job, action: "start" };
}

function stopJob(job) {
  return { type: "updateJob", job, action: "stop" };
}

/*
 * 一个 Block 的"归零"动作组：只归零音量。
 * 频率是 E-Stim 的调制设置而非刺激量，缺省语义是"保持设备当前值"，
 * 所以 Initial / Final Actions 都【不写频率】（docs/03 §4.5）。
 * setMode 同属设置项，本阶段不作为归零的一部分（待确认，docs/07 §4.2）。
 */
function zeroBlockActions(block) {
  return [
    updateComponent("setVolume", block.channelId, { rampTime: 0, percentVolume: "0" }),
  ];
}

/* ==================================================================
 * Jobs
 * ================================================================== */

function buildOutputJob(block) {
  const actions = [];

  /* ① 旋转槽专属：方向必须排在速度【之前】，否则换向会慢一拍（docs/01 §3）。 */
  if (block.directionVar) {
    actions.push(updateComponent("setDirection", block.channelId, {
      direction: "clockwise",
      requiredExpression: `{${block.directionVar}} == 1`,
    }));
    actions.push(updateComponent("setDirection", block.channelId, {
      direction: "counterclockwise",
      requiredExpression: `{${block.directionVar}} == -1`,
    }));
  }

  /* ② 音量：无条件写（音量是当前输出值，缺省即归零）。 */
  actions.push(updateComponent("setVolume", block.channelId, {
    rampTime: `{${block.rampVar}}`,
    percentVolume: `{${block.volumeVar}}`,
  }));

  /*
   * ③ E-Stim 频率：【条件动作】。频率变量为哨兵值(-1)表示"本次没有频率意图"，
   *    两条 Action 的 requiredExpression 都不成立，设备频率保持原样。
   *    不用 >= 0 直接判断，是为了避开表达式比较运算符的实测不确定性，
   *    并与旋转方向 Action 的既有形状保持一致。
   */
  if (block.frequencyVar) {
    actions.push(updateComponent("setFrequency", block.channelId, {
      format: "relative",
      frequencyPercent: "0",
      requiredExpression: `{${block.frequencyVar}} == 0`,
    }));
    actions.push(updateComponent("setFrequency", block.channelId, {
      format: "relative",
      frequencyPercent: `{${block.frequencyVar}}`,
      requiredExpression: `{${block.frequencyVar}} > 0`,
    }));
  }

  /* ④ 一次性刷新器：写完硬件立刻停自己。 */
  actions.push(stopJob(block.outputJob));

  return { steps: { START: { actions } } };
}

function buildSchedulerJob() {
  return {
    steps: {
      START: {
        actions: [customCode("xtoysBridgeTick();")],
        triggers: [
          {
            type: "stepState",
            event: "timer",
            amount: SCHEDULER_INTERVAL_SECONDS,
            actions: [
              { job: SCHEDULER_JOB, step: "START", type: "updateJob", action: "goTo" },
            ],
          },
        ],
      },
    },
  };
}

/* ==================================================================
 * 顶层结构
 * ================================================================== */

function buildScript(runtimeSource) {
  const jobs = { [SCHEDULER_JOB]: buildSchedulerJob() };
  for (const block of BLOCKS) {
    jobs[block.outputJob] = buildOutputJob(block);
  }

  /* ---- Initial Actions：归零音量 → 写配置 → 初始化 JS → 启动调度 ---- */
  const initialActions = [];
  for (const block of BLOCKS) initialActions.push(...zeroBlockActions(block));
  initialActions.push(updateVariable("xthb-config-json", JSON.stringify(BRIDGE_CONFIG)));
  initialActions.push(customCode("xtoysBridgeInit();"));
  initialActions.push(startJob(SCHEDULER_JOB));

  /*
   * ---- Final Actions：顺序是有意这么排的 ----
   *
   * 1. 先停调度 Job（不再有新计算进来）
   * 2. 【显式 UI 归零每个 Block 的音量】← 硬件停止的硬保障
   * 3. 停所有输出 Job
   * 4. 最后才跑 JS 的清理函数
   *
   * 前两步是**字面量归零**，不依赖任何 JS：即使第 4 步的 JS 抛异常、
   * 甚至 XToys 在某个 Action 抛错后就中止后续 Action，硬件也已经被写成 0。
   * 早期版本把 customCode 放在最前面 —— 那正好把唯一的硬保障押在"JS 不抛错"上，
   * 与 docs/01 §7「JS 抛错时 Final Actions 是唯一保障」自相矛盾。
   */
  const finalActions = [];
  finalActions.push(stopJob(SCHEDULER_JOB));
  for (const block of BLOCKS) finalActions.push(...zeroBlockActions(block));
  for (const block of BLOCKS) finalActions.push(stopJob(block.outputJob));
  /*
   * 4. 最后才跑 JS 的清理函数。
   *    这一条故意【不用 safeCall 包裹】——与已验证可导入的参考实现保持完全相同的
   *    调用形状（直接调全局函数）。运行时内部已经把所有宿主调用包在 try/catch 里，
   *    所以这里不需要再多一层；少一层就少一个"与已知可用形状不同"的变量。
   */
  finalActions.push(customCode("xtoysBridgeStopAll();"));

  return {
    initialActions,
    finalActions,
    globalTriggers: [
      {
        type: "componentState",
        action: "xtoys_game_bridge",
        channel: "webhook-a",
        parsedAction: "xtoys_game_bridge",
        actions: [
          customCode("xtoysBridgeHandle(payload);", [
            { name: "payload", value: "trigger-payload", expression: null },
          ]),
        ],
      },
    ],
    jobs,
    queues: [],
    channels: buildChannels(),
    controls: [],
    controlPresets: [],
    media: { audio: {}, voices: {}, patterns: {} },
    customFunctions: runtimeSource,
  };
}

/* ==================================================================
 * 生成 + 自检（自检失败即中止，不产出半成品 JSON）
 * ================================================================== */

const runtimeSource = readFileSync(RUNTIME_SRC, "utf8");
const script = buildScript(runtimeSource);

function selfCheck() {
  const errors = [];

  /* 1. 一个 Block 专属一个 part。 */
  const ownerOf = new Map();
  for (const part of Object.keys(BRIDGE_CONFIG.parts)) {
    for (const metric of Object.keys(BRIDGE_CONFIG.parts[part])) {
      const id = BRIDGE_CONFIG.parts[part][metric];
      if (ownerOf.has(id)) {
        errors.push(`Channel ${id} 同时属于 ${ownerOf.get(id)} 与 ${part}`);
      }
      ownerOf.set(id, part);
    }
  }

  /* 2. 映射引用的 Channel 必须存在，且类型与 metric 匹配。 */
  for (const part of Object.keys(BRIDGE_CONFIG.parts)) {
    for (const metric of Object.keys(BRIDGE_CONFIG.parts[part])) {
      const id = BRIDGE_CONFIG.parts[part][metric];
      const ch = script.channels[id];
      if (!ch) {
        errors.push(`映射引用了不存在的 Channel ${id}（属于 ${part}）`);
      } else if (ch.type !== METRIC_TYPE[metric]) {
        errors.push(`${id} 类型是 ${ch.type}，与 metric ${metric} 不匹配`);
      }
    }
  }

  /* 3. 映射表里的部位名必须在合法清单里。 */
  for (const part of Object.keys(BRIDGE_CONFIG.parts)) {
    if (!KNOWN_PART_NAMES.includes(part)) errors.push(`${part} 不在合法部位名清单里`);
  }

  /* 4-8… 变量的写入方由 tools/check-script-contract.mjs 动态验证：
   * 运行时是按 Channel ID 动态拼变量名的，静态文本匹配证明不了任何事情。
   * 这里只保留能静态证明的结构性检查。 */

  /* 5. Final Actions 必须显式归零每个 Block 的音量。 */
  for (const block of BLOCKS) {
    const zeroed = script.finalActions.some(
      (a) => a.type === "updateComponent" && a.action === "setVolume" &&
        a.channel === block.channelId && String(a.percentVolume) === "0",
    );
    if (!zeroed) errors.push(`安全：Final Actions 缺少 ${block.channelId} 的音量归零`);
  }

  /* 5b. 字面量归零必须排在 Final Actions 的 customCode【之前】：
   * 否则唯一的硬件硬保障就押在"JS 不抛错"上了。 */
  const firstCustomInFinal = script.finalActions.findIndex((a) => a.type === "customCode");
  script.finalActions.forEach((a, i) => {
    if (a.type === "updateComponent" && a.action === "setVolume" && String(a.percentVolume) === "0") {
      if (firstCustomInFinal >= 0 && i > firstCustomInFinal) {
        errors.push(`安全：Final Actions 里 ${a.channel} 的归零排在 customCode 之后`);
      }
    }
  });

  /* 6. 不得出现任何频率归零动作。 */
  for (const bucket of [script.initialActions, script.finalActions]) {
    for (const a of bucket) {
      if (a.type === "updateComponent" && a.action === "setFrequency") {
        errors.push(`安全：${a.channel} 在 Initial/Final Actions 里写了频率（违反 docs/03 §4.5）`);
      }
    }
  }

  /* 7. 旋转 Job 里方向必须排在音量之前。 */
  for (const block of BLOCKS) {
    if (!block.directionVar) continue;
    const actions = script.jobs[block.outputJob].steps.START.actions;
    const firstVolume = actions.findIndex((a) => a.action === "setVolume");
    const lastDirection = actions.map((a) => a.action).lastIndexOf("setDirection");
    if (lastDirection > firstVolume) {
      errors.push(`顺序：${block.outputJob} 的 setDirection 排在 setVolume 之后`);
    }
  }

  /* 8. 每个通道必须恰好有一个输出 Job 引用它。 */
  for (const block of BLOCKS) {
    const referencing = Object.entries(script.jobs)
      .filter(([, job]) => job.steps.START.actions.some((a) => a.channel === block.channelId));
    if (referencing.length !== 1 || referencing[0][0] !== block.outputJob) {
      errors.push(`通道 ${block.channelId} 的输出 Job 引用异常：${referencing.map((r) => r[0]).join(",")}`);
    }
  }

  if (errors.length > 0) {
    console.error("自检失败，未产出 JSON：");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

selfCheck();

mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, `${JSON.stringify(script, null, 2)}\n`, "utf8");
writeFileSync(OUT_JS, runtimeSource, "utf8");

const jobActionCount = Object.values(script.jobs).reduce(
  (n, job) => n + Object.values(job.steps).reduce((m, step) => m + step.actions.length, 0), 0);

console.log(`已生成 ${OUT_JSON}`);
console.log(`  parts         : ${Object.keys(BRIDGE_CONFIG.parts).length} (${Object.keys(BRIDGE_CONFIG.parts).join(", ")})`);
console.log(`  Block / 通道  : ${BLOCKS.length}`);
console.log(`  jobs          : ${Object.keys(script.jobs).length} (1 调度 + ${BLOCKS.length} 输出)`);
console.log(`  initialActions: ${script.initialActions.length}`);
console.log(`  finalActions  : ${script.finalActions.length}`);
console.log(`  Job 内 Action : ${jobActionCount}`);
console.log(`  customFunctions: ${runtimeSource.length} 字符`);
console.log("  自检：Block 专属 / Channel 类型匹配 / Final 归零齐全 / 无频率归零 / 方向顺序 / Job 引用唯一");
for (const block of BLOCKS) {
  console.log(`    ${block.uiName.padEnd(18)} ${block.channelId.padEnd(26)} ${block.outputJob}`);
}
