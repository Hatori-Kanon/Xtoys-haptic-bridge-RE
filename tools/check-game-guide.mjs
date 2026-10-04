#!/usr/bin/env node
/*
 * 文档 ↔ 运行时 规格一致性检查。
 *
 * 为什么需要它：`docs/08` 是写给"要写游戏侧桥接"的人的规格文档。如果它和真实运行时
 * 不一致，别人照文档写出来的东西会**静默失效**（HTTP 200 但设备不动）。
 * 本项目已经踩过一次同类坑：docs/03 的命名表写成 `-value`，而代码用 `-volume`。
 *
 * 这个检查把 docs/08 里的每条关键声明拿去和真实运行时对照 —— 能自动核的自动核，
 * 不能自动核的至少确认它存在于文档里（提醒改协议时别忘了同步文档）。
 *
 * 用法：node tools/check-game-guide.mjs
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBridgeConfig } from "./xtoys-naming.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const GUIDE = join(ROOT, "docs", "08-game-side-integration-guide.md");
const RUNTIME = join(ROOT, "src", "xtoys-bridge.js");
const SCRIPT_JSON = join(ROOT, "examples", "xtoys-minimal-3path.json");

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const guide = readFileSync(GUIDE, "utf8");
const runtime = readFileSync(RUNTIME, "utf8");

/* ---------------------------------------------------- 真实运行时（mock 宿主） */

const variables = {};
const context = createContext({
  setVariable: (name, value) => { variables[name] = value; },
  getVariable: (name) => (name in variables ? variables[name] : null),
  callAction: () => {},
  console: { log: () => {} },
  Date: { now: () => 1000000 },
  JSON, Object, Math,
});
runInContext(runtime, context, { filename: "xtoys-bridge.js" });
variables["xthb-config-json"] = JSON.stringify(buildBridgeConfig());
runInContext("xtoysBridgeInit()", context);

const send = (inner) => {
  context.__payload = JSON.stringify({ action: "xtoys_game_bridge", payload: JSON.stringify(inner) });
  return runInContext("xtoysBridgeHandle(__payload)", context);
};

console.log("docs/08 游戏侧指南 ↔ 运行时 规格检查\n");

/* ------------------------------------------------ A. 文档列的错误码必须真实存在 */

console.log("A. 文档给出的错误码必须存在于运行时");
const DOC_ERROR_CODES = [
  "invalid_payload", "invalid_json", "unsupported_protocol_version", "unsupported_command",
  "missing_source", "missing_event_id", "invalid_sequence", "invalid_duration",
  "invalid_targets", "missing_targets", "missing_stop_selector",
];
for (const code of DOC_ERROR_CODES) {
  check(`${code} 存在`, runtime.includes(`"${code}"`));
}

/* --------------------------------------------------- B. target 字段必须被解析 */

console.log("\nB. 文档列出的 target 字段必须都被运行时解析");
for (const field of ["estimIntensity", "vibrateIntensity", "frequency", "rotateSpeed",
  "rotateDirection", "durationMs", "rampUpMs", "rampDownMs", "priority"]) {
  check(`${field}`, runtime.includes(`"${field}"`));
}
check("part（属性访问形式）", /\btarget\.part\b|\braw\.part\b/.test(runtime));
check('已废除的 "intensity" 确实不在运行时里（文档说它会被拒绝）',
  !/"intensity"/.test(runtime));

/* ------------------------------------------- C. 文档的行为断言逐条真实验证 */

console.log("\nC. 文档的行为断言，用真实运行时逐条验证");

const dupTargets = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "dup", sequence: 1,
  targets: [
    { part: "nipple", estimIntensity: 40, durationMs: 900 },
    { part: "nipple", rotateSpeed: 60, rotateDirection: "clockwise", durationMs: 900 },
  ],
});
check("§3.2 规则一：重复 part 被整体拒绝",
  dupTargets.ok === false && dupTargets.code === "invalid_targets", JSON.stringify(dupTargets));

send({
  protocolVersion: 1, command: "play", source: "spec-est", eventId: "e", sequence: 1,
  targets: [{ part: "nipple", estimIntensity: 80, durationMs: 60000 }],
});
runInContext("xtoysBridgeTick()", context);
check("§3.2 规则二：只给 estimIntensity → 振动通道不动",
  variables["xthb-estim-nipple-volume"] === 80 && variables["xthb-vibrator-nipple-volume"] === 0,
  `estim=${variables["xthb-estim-nipple-volume"]} vibrate=${variables["xthb-vibrator-nipple-volume"]}`);

const noDrive = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "nd", sequence: 1,
  targets: [{ part: "nipple", rotateDirection: "clockwise", durationMs: 500 }],
});
check("§3.2 规则三：只有 rotateDirection 被拒绝", noDrive.ok === false, JSON.stringify(noDrive));

const legacyField = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "old", sequence: 1,
  targets: [{ part: "nipple", intensity: 50, durationMs: 900 }],
});
check("§3.2 旧字段 intensity 被拒绝（不是静默忽略）", legacyField.ok === false,
  JSON.stringify(legacyField));

send({
  protocolVersion: 1, command: "play", source: "spec-clamp", eventId: "c", sequence: 1,
  targets: [{ part: "nipple", estimIntensity: 250, durationMs: 60000 }],
});
runInContext("xtoysBridgeTick()", context);
check("§3.3 超出 0–100 被夹取到 100", variables["xthb-estim-nipple-volume"] === 100,
  String(variables["xthb-estim-nipple-volume"]));

const unknownPart = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "u", sequence: 1,
  targets: [{ part: "chest", estimIntensity: 50, durationMs: 900 }],
});
check("§4.4 未识别部位被忽略（ok:true）而不是整体拒绝", unknownPart.ok === true,
  JSON.stringify(unknownPart));

send({
  protocolVersion: 1, command: "set_baseline", source: "spec-freq", sequence: 1,
  targets: [{ part: "nipple", estimIntensity: 30, frequency: 70 }],
});
runInContext("xtoysBridgeTick()", context);
const freqExplicit = variables["xthb-estim-nipple-frequency"];
send({
  protocolVersion: 1, command: "set_baseline", source: "spec-freq", sequence: 2,
  targets: [{ part: "nipple", estimIntensity: 30 }],
});
runInContext("xtoysBridgeTick()", context);
const freqAbsent = variables["xthb-estim-nipple-frequency"];
check("§5.3 显式 frequency 生效", freqExplicit === 70, String(freqExplicit));
check("§5.3 缺省 frequency 写哨兵值(-1) 而不是 0", freqAbsent === -1, String(freqAbsent));

send({
  protocolVersion: 1, command: "play", source: "spec-seq", eventId: "e", sequence: 5,
  targets: [{ part: "nipple", estimIntensity: 50, durationMs: 60000 }],
});
const staleSeq = send({
  protocolVersion: 1, command: "play", source: "spec-seq", eventId: "e", sequence: 5,
  targets: [{ part: "nipple", estimIntensity: 50, durationMs: 60000 }],
});
check("§5.4 相同 sequence 被拒 invalid_sequence",
  staleSeq.ok === false && staleSeq.code === "invalid_sequence", JSON.stringify(staleSeq));

runInContext("xtoysBridgeStopAll()", context);
const afterFence = send({
  protocolVersion: 1, command: "set_baseline", source: "spec-freq", sequence: 1,
  targets: [{ part: "nipple", estimIntensity: 10 }],
});
check("§5.5 stop_all 后基线序号栅栏仍保留（旧序号被拒）",
  afterFence.ok === false && afterFence.code === "invalid_sequence", JSON.stringify(afterFence));

const emptyPlay = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "et", sequence: 1, targets: [],
});
check("§5.2 play 的空 targets 被拒绝", emptyPlay.ok === false, JSON.stringify(emptyPlay));

const emptyBaseline = send({
  protocolVersion: 1, command: "set_baseline", source: "spec-eb", sequence: 1, targets: [],
});
check("§5.2 set_baseline 的空 targets 合法（清空基线）", emptyBaseline.ok === true,
  JSON.stringify(emptyBaseline));

const testCmd = send({
  protocolVersion: 1, command: "test", source: "spec",
  targets: [{ part: "nipple", estimIntensity: 50 }],
});
check("§9.1 test 命令不需要 sequence",
  testCmd.ok === true && testCmd.code === "validated", JSON.stringify(testCmd));

const rotBad = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "r1", sequence: 1,
  targets: [{ part: "nipple", rotateSpeed: 60, durationMs: 900 }],
});
const rotZero = send({
  protocolVersion: 1, command: "play", source: "spec", eventId: "r2", sequence: 1,
  targets: [{ part: "nipple", rotateSpeed: 0, durationMs: 900 }],
});
check("§3.1 rotateSpeed>0 缺方向被拒绝", rotBad.ok === false, JSON.stringify(rotBad));
check("§3.1 rotateSpeed=0 可不给方向", rotZero.ok === true, JSON.stringify(rotZero));

const stopNoSelector = send({ protocolVersion: 1, command: "stop", source: "spec" });
check("§2.2 stop 无选择器被拒 missing_stop_selector",
  stopNoSelector.ok === false && stopNoSelector.code === "missing_stop_selector",
  JSON.stringify(stopNoSelector));

/* --------------------------------- D. 文档的"已配置部位"必须与生成物一致 */

console.log("\nD. 文档 §4.2 声明的『当前已配置部位』必须与生成物一致");
const scriptJson = JSON.parse(readFileSync(SCRIPT_JSON, "utf8"));
const inlineAction = scriptJson.initialActions.find((a) => a.type === "customCode");
const inlineCode = inlineAction.code;
const inlineConfig = JSON.parse(inlineCode.slice(inlineCode.indexOf("(") + 1, inlineCode.lastIndexOf(")")));
const configuredParts = Object.keys(inlineConfig.p).sort();
check("生成物内联配置 = nipple/clitoris/vagina/anus（与文档 §4.2 一致）",
  JSON.stringify(configuredParts) === JSON.stringify(["anus", "clitoris", "nipple", "vagina"]),
  configuredParts.join(","));

/* 文档 §4.1 的规范清单 */
const listStart = guide.indexOf("### 4.1 规范部位清单");
const blockStart = guide.indexOf("```", listStart);
const blockEnd = guide.indexOf("```", blockStart + 3);
const listedParts = guide.slice(blockStart + 3, blockEnd).split(/\s+/).filter(Boolean);
check("§4.1 清单含 12 个规范部位（与 webhook-protocol 一致）",
  listedParts.length === 12, `实际 ${listedParts.length}: ${listedParts.join(",")}`);
check("§4.1 清单用全称 clitoris/anus，不含 clit/anal",
  listedParts.includes("clitoris") && listedParts.includes("anus") &&
  !listedParts.includes("clit") && !listedParts.includes("anal"), listedParts.join(","));
check("§4.1 明确警告不要用 clit/anal",
  guide.includes("不是 `clit`") && guide.includes("不是 `anal`"));
check("§4.3 警告 docs/05 的旧键名会静默失效",
  guide.includes("generic_ep") && guide.includes("静默忽略"));

/* ------------------------------------------------- E. 文档必须讲到的要点 */

console.log("\nE. 文档必须覆盖的要点（防止改协议时漏同步文档）");
const REQUIRED_TOPICS = [
  ["HTTP 200 不代表生效", (g) => g.includes("HTTP 200") && g.includes("≠")],
  ["payload 必须是 JSON 字符串", (g) => g.includes("JSON 字符串")],
  ["六个命令都提到", (g) => ["play", "update", "stop", "set_baseline", "stop_all", "test"]
    .every((c) => g.includes(`\`${c}\``))],
  ["基线是完整快照（漏写通道会被清除）", (g) => g.includes("完整快照") && g.includes("清除")],
  ["sequence 严格递增 + 栅栏跨 stop_all 保留",
    (g) => g.includes("严格递增") && g.includes("stop_all") && g.includes("栅栏")],
  ["frequency 缺省 ≠ 0", (g) => g.includes("保持设备当前频率")],
  ["rotation 不会自动反向", (g) => g.includes("不会自动反向")],
  ["交付核对清单", (g) => g.includes("交付前必须核对的清单")],
  ["错误码表", (g) => g.includes("invalid_sequence") && g.includes("invalid_targets")],
  ["不出现设备名/通道名/Job 名的硬边界", (g) => g.includes("不得出现设备名")],
];
for (const [label, predicate] of REQUIRED_TOPICS) {
  check(label, predicate(guide));
}

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${"-".repeat(64)}`);
if (failures > 0) {
  console.log(`规格检查失败：${failures} 项 —— docs/08 与实现不一致，必须修`);
  process.exit(1);
}
console.log("docs/08 的全部规格声明与真实运行时一致。");
