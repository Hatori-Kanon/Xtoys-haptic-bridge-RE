#!/usr/bin/env node
/*
 * Script JSON ↔ 运行时 契约检查。
 *
 * 为什么需要它：这个检查抓到过一个"单元测试全绿但真机什么也收不到"的缺陷 ——
 * 生成器把变量名写成 xthb-vibrate-nipple-volume，运行时按 Channel ID 写成
 * xthb-vibrator-nipple-volume。输出 Job 于是去读一个永远没人写的变量。
 * 单元测试没抓到，是因为测试里的期望值也是照生成器的错误假设手写的。
 *
 * 所以这里不信任任何一方的命名假设，而是：
 *   1. 从生成好的 JSON 里抽出输出 Job 引用的【每一个】{变量}；
 *   2. 用真实运行时 + mock 宿主跑一遍真实场景；
 *   3. 断言每个被引用的变量都【确实被运行时写过】。
 *
 * 用法：node tools/check-script-contract.mjs
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCRIPT_JSON = join(ROOT, "examples", "xtoys-minimal-3path.json");
const RUNTIME_SRC = join(ROOT, "src", "xtoys-bridge.js");

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const script = JSON.parse(readFileSync(SCRIPT_JSON, "utf8"));

console.log("Script JSON ↔ 运行时 契约检查\n");

/* ---------------------------------------------------------------- 1. 结构 */

console.log("1. 顶层结构");
const REQUIRED_KEYS = [
  "initialActions", "finalActions", "globalTriggers", "jobs",
  "queues", "channels", "controls", "controlPresets", "media", "customFunctions",
];
for (const k of REQUIRED_KEYS) {
  check(`存在顶层键 ${k}`, Object.prototype.hasOwnProperty.call(script, k));
}
check("customFunctions 是字符串（不是结构化数据）", typeof script.customFunctions === "string");
check("queues / controls / controlPresets 为空数组",
  Array.isArray(script.queues) && script.queues.length === 0 &&
  Array.isArray(script.controls) && script.controls.length === 0 &&
  Array.isArray(script.controlPresets) && script.controlPresets.length === 0);

/* ------------------------------------------------- 2. 输出 Job 引用的变量 */

console.log("\n2. 输出 Job 引用的变量");
const referencedVars = new Set();
for (const [jobName, job] of Object.entries(script.jobs)) {
  for (const step of Object.values(job.steps)) {
    for (const a of step.actions) {
      for (const field of ["percentVolume", "rampTime", "frequencyPercent"]) {
        const m = typeof a[field] === "string" && a[field].match(/^\{([^}]+)\}$/);
        if (m) referencedVars.add(m[1]);
      }
      if (typeof a.requiredExpression === "string") {
        for (const m of a.requiredExpression.matchAll(/\{([^}]+)\}/g)) referencedVars.add(m[1]);
      }
    }
  }
}
check(`抽到 ${referencedVars.size} 个被引用的 Script 变量`, referencedVars.size > 0);

/* ------------------------------------------- 3. 用真实运行时跑出真正写入的变量 */

console.log("\n3. 用真实运行时在 mock 宿主上跑一遍，看真正写了哪些变量");

const configAction = script.initialActions.find(
  (a) => a.type === "updateVariable" && a.variable === "xthb-config-json");
check("Initial Actions 里有配置变量写入", Boolean(configAction));

const written = new Set();
const jobsStarted = [];
const sandbox = {
  setVariable: (name) => written.add(name),
  getVariable: (name) => (name === "xthb-config-json" ? configAction.value : null),
  callAction: (a) => { if (a && a.action === "start") jobsStarted.push(a.job); },
  console: { log: () => {} },
  Date: { now: () => 1000000 },
  JSON, Object, Math,
};
const ctx = createContext(sandbox);
runInContext(script.customFunctions, ctx, { filename: "customFunctions.js" });

const call = (expr) => runInContext(expr, ctx);
const send = (inner) => {
  ctx.__p = JSON.stringify({ action: "xtoys_game_bridge", payload: JSON.stringify(inner) });
  return call("xtoysBridgeHandle(__p)");
};

check("xtoysBridgeInit() 返回 initialized", call("xtoysBridgeInit()") === "initialized");

/* 尽可能把每条路径都激活一次：三条指标 + 有/无频率 + 方向 + 到期 + 停止。 */
const parts = Object.keys(JSON.parse(configAction.value).parts);
for (const part of parts) {
  const spec = JSON.parse(configAction.value).parts[part];
  const target = { part, durationMs: 60000 };
  if (spec.estim || spec.vibrate) {
    target.intensity = 55;
    if (spec.estim) target.frequency = 35;
  }
  if (spec.rotate) {
    target.rotateSpeed = 40;
    target.rotateDirection = "clockwise";
  }
  send({ protocolVersion: 1, command: "play", source: "contract", eventId: `e-${part}`, sequence: 1, targets: [target] });
  call("xtoysBridgeTick()");
}
/* 无频率 + 反向 + 到期 + 停止，覆盖剩余的写入路径。 */
send({ protocolVersion: 1, command: "set_baseline", source: "contract-b", sequence: 1,
  targets: [{ part: parts[0], intensity: 20, rampUpMs: 500, rampDownMs: 900 }] });
call("xtoysBridgeTick()");
send({ protocolVersion: 1, command: "stop_all", source: "contract" });
call("xtoysBridgeStopAll()");

/* ------------------------------------------------------ 4. 断言变量全覆盖 */

console.log("\n4. 断言：Job 引用的每个变量都被运行时写过");
const missing = [...referencedVars].filter((v) => !written.has(v)).sort();
if (missing.length === 0) {
  check(`全部 ${referencedVars.size} 个被引用变量都有写入方`, true);
} else {
  check(`全部 ${referencedVars.size} 个被引用变量都有写入方`, false,
    `以下变量被输出 Job 读取但运行时从未写入：\n       ${missing.join("\n       ")}`);
}

/* 反向：运行时写出的变量不应有孤儿（写了但没人读）—— 只做提示，不算失败。 */
const orphans = [...written].filter(
  (v) => !referencedVars.has(v) && !v.startsWith("xthb-status") && v !== "xthb-config-json" &&
    !v.startsWith("xthb-tick") && !v.startsWith("xthb-active") && !v.startsWith("xthb-calls") &&
    !v.startsWith("xthb-rejected") && !v.startsWith("xthb-ignored") && !v.startsWith("xthb-last"),
);
console.log(`  info 运行时写出的变量共 ${written.size} 个；其中被 Job 读取 ${referencedVars.size} 个` +
  (orphans.length ? `；未被读取的诊断变量 ${orphans.length} 个` : ""));

/* --------------------------------------------------- 5. 启动的 Job 都存在 */

console.log("\n5. 运行时启动的 Job 必须存在于 JSON 里");
const unknownJobs = [...new Set(jobsStarted)].filter((j) => !script.jobs[j]);
check(`启动的 Job 全部存在（共 ${new Set(jobsStarted).size} 个）`, unknownJobs.length === 0,
  unknownJobs.join(", "));

/* ------------------------------------------------- 6. 通道被 Job 恰好引用一次 */

console.log("\n6. 每个物理通道恰好被一个输出 Job 引用");
const physicalChannels = Object.entries(script.channels)
  .filter(([, c]) => c.type !== "webhook").map(([id]) => id);
for (const id of physicalChannels) {
  const refs = Object.entries(script.jobs).filter(([, job]) =>
    job.steps.START.actions.some((a) => a.channel === id && a.action !== "stop"));
  check(`${id} 被 1 个 Job 引用（实际 ${refs.length}）`, refs.length === 1,
    refs.map((r) => r[0]).join(", "));
}

/* ------------------------------------------------------------ 汇总 */

console.log(`\n${"-".repeat(64)}`);
if (failures > 0) {
  console.log(`契约检查失败：${failures} 项`);
  process.exit(1);
}
console.log("契约检查全部通过。");
