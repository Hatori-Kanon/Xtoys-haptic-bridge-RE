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
 *   examples/xthb-customFunctions.js    ← 与 JSON 内嵌内容完全一致的独立副本，
 *                                         便于在编辑器里阅读/审查（两者必须同步）
 *
 * 设计边界（HANDOFF.md §3.2）：
 *   - Initial/Final Actions 里的显式归零是硬件停止的强制项，由本脚本生成，
 *     不要手工从 JSON 里删。
 *   - 生成的 Action 只写"当前输出值"，不含任何最大强度/最大旋转速度设置项。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const RUNTIME_SRC = join(ROOT, "src", "xtoys-bridge.js");
const OUT_JSON = join(ROOT, "examples", "xtoys-minimal-3path.json");
const OUT_JS = join(ROOT, "examples", "xthb-customFunctions.js");

/* ---------------------------------------------------------------- 通道定义 */

const CHANNELS = {
  "webhook-a": { name: "", type: "webhook", outbound: false, hideWebhookInfo: false },
  "part-estim-a": { name: "E-Stim", type: "part-estim" },
  "part-vibrator-a": { name: "Vibrator", type: "part-vibrator" },
  "part-rotator-a": { name: "Rotator", type: "part-rotator" },
};

/* 3 条输出路径：estim / vibrator / rotator。见 HANDOFF.md §7.1。 */
const PATHS = [
  {
    channel: "estim",
    channelId: "part-estim-a",
    outputJob: "xthb-output-estim",
    valueVar: "xthb-estim-value",
    rampVar: "xthb-estim-ramp-seconds",
    frequencyVar: "xthb-estim-frequency",
  },
  {
    channel: "vibrator",
    channelId: "part-vibrator-a",
    outputJob: "xthb-output-vibrator",
    valueVar: "xthb-vibrator-value",
    rampVar: "xthb-vibrator-ramp-seconds",
  },
  {
    channel: "rotator",
    channelId: "part-rotator-a",
    outputJob: "xthb-output-rotator",
    valueVar: "xthb-rotator-value",
    rampVar: "xthb-rotator-ramp-seconds",
    directionVar: "xthb-rotator-direction-code",
  },
];

const SCHEDULER_JOB = "xthb-scheduler";
const SCHEDULER_INTERVAL_SECONDS = "0.1";

/* 逻辑部位白名单，与 docs/02-webhook-protocol.md §4 的叶子部位一致。 */
const PARTS = [
  "mouth", "breast", "nipple", "armpit", "clitoris", "vulva",
  "vagina", "urethra", "anus", "butt", "penis", "prostate",
];

/* 运行时读的配置对象。改映射规则时优先改这里，而不是改运行时源码。 */
const BRIDGE_CONFIG = {
  protocolVersion: 1,
  parts: PARTS,
  channels: {
    estim: { intensity: "part-estim-a", frequency: "part-estim-a" },
    vibrator: { intensity: "part-vibrator-a" },
    rotator: { volume: "part-rotator-a", direction: "part-rotator-a" },
  },
  /*
   * 阶段 0 临时规则：所有部位的强度意图广播给 estim 与 vibrator 两个通道；
   * 旋转通道只接受显式 rotateSpeed。正式 part -> 通道 映射留到下一轮协议讨论。
   * 想给某条通道限定时，加 "parts": ["clitoris", "anus"] 即可，运行时支持。
   */
  routing: { mode: "broadcast-intensity" },
};

/* ---------------------------------------------------------------- Action 助手 */

function customCode(code, variables = []) {
  return { type: "customCode", code, resultVar: "result", variables, storeResult: false };
}

function callBridge(code) {
  return customCode(code);
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

/* 一个 Block 的"归零"动作组。E-Stim 额外归零频率并回到 standard 模式。 */
function zeroBlockActions(path) {
  const actions = [];
  if (path.frequencyVar) {
    actions.push(updateComponent("setFrequency", path.channelId, {
      format: "relative",
      frequencyPercent: "0",
    }));
    actions.push(updateComponent("setMode", path.channelId, { mode: "standard" }));
  }
  actions.push(updateComponent("setVolume", path.channelId, {
    rampTime: 0,
    percentVolume: "0",
  }));
  return actions;
}

/* ---------------------------------------------------------------- Jobs */

function buildOutputJob(path) {
  const actions = [];

  /*
   * 旋转 Job 的顺序是硬要求（HANDOFF.md §4.3）：
   * 两个 setDirection 必须排在 setVolume 之前，否则换向会慢一拍。
   */
  if (path.directionVar) {
    actions.push(updateComponent("setDirection", path.channelId, {
      direction: "clockwise",
      requiredExpression: `{${path.directionVar}} == 1`,
    }));
    actions.push(updateComponent("setDirection", path.channelId, {
      direction: "counterclockwise",
      requiredExpression: `{${path.directionVar}} == -1`,
    }));
  }

  actions.push(updateComponent("setVolume", path.channelId, {
    rampTime: `{${path.rampVar}}`,
    percentVolume: `{${path.valueVar}}`,
  }));

  if (path.frequencyVar) {
    actions.push(updateComponent("setFrequency", path.channelId, {
      format: "relative",
      frequencyPercent: `{${path.frequencyVar}}`,
    }));
  }

  /* 一次性刷新器：写完硬件立刻停自己。 */
  actions.push(stopJob(path.outputJob));

  return { steps: { START: { actions } } };
}

function buildSchedulerJob() {
  return {
    steps: {
      START: {
        actions: [callBridge("xtoysBridgeTick();")],
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

/* ---------------------------------------------------------------- 顶层结构 */

function buildScript(runtimeSource) {
  const jobs = { [SCHEDULER_JOB]: buildSchedulerJob() };
  for (const path of PATHS) {
    jobs[path.outputJob] = buildOutputJob(path);
  }

  const initialActions = [];

  /* 1. 先把每个已绑定 Block 显式归零。 */
  for (const path of PATHS) {
    initialActions.push(...zeroBlockActions(path));
  }

  /* 2. 写配置变量。 */
  initialActions.push(updateVariable("xthb-config-json", JSON.stringify(BRIDGE_CONFIG)));

  /* 3. 初始化运行时（JS 侧同时把输出变量写零）。 */
  initialActions.push(callBridge("xtoysBridgeInit();"));

  /* 4. 启动调度 Job。 */
  initialActions.push(startJob(SCHEDULER_JOB));

  const finalActions = [];

  /* 1. JS 侧清状态 + 把输出变量写零。 */
  finalActions.push(callBridge("xtoysBridgeStopAll();"));

  /* 2. 停调度 Job。 */
  finalActions.push(stopJob(SCHEDULER_JOB));

  /* 3. 显式 UI 归零每个 Block —— JS 抛错 / 未初始化时唯一的硬件停止保障。 */
  for (const path of PATHS) {
    finalActions.push(...zeroBlockActions(path));
  }

  /* 4. 停掉所有输出 Job。 */
  for (const path of PATHS) {
    finalActions.push(stopJob(path.outputJob));
  }

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
    channels: CHANNELS,
    controls: [],
    controlPresets: [],
    media: { audio: {}, voices: {}, patterns: {} },
    customFunctions: runtimeSource,
  };
}

/* ---------------------------------------------------------------- 主流程 */

const runtimeSource = readFileSync(RUNTIME_SRC, "utf8");
const script = buildScript(runtimeSource);

mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, `${JSON.stringify(script, null, 2)}\n`, "utf8");
writeFileSync(OUT_JS, runtimeSource, "utf8");

const actionCount =
  script.initialActions.length + script.finalActions.length +
  Object.values(script.jobs).reduce((n, job) =>
    n + Object.values(job.steps).reduce((m, step) => m + step.actions.length, 0), 0);

console.log(`已生成 ${OUT_JSON}`);
console.log(`  channels      : ${Object.keys(script.channels).length}`);
console.log(`  jobs          : ${Object.keys(script.jobs).length}`);
console.log(`  globalTriggers: ${script.globalTriggers.length}`);
console.log(`  initialActions: ${script.initialActions.length}`);
console.log(`  finalActions  : ${script.finalActions.length}`);
console.log(`  Action 总数   : ${actionCount}`);
console.log(`  customFunctions: ${runtimeSource.length} 字符`);
