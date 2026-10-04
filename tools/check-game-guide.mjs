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

/* 规范部位清单：用【结构标记】定位，不靠标题文字（标题会被编辑改动）。
 * 文档里该清单是紧跟 "### 4.1" 之后的第一个代码块。 */
const partSectionStart = guide.indexOf("### 4.1");
check("能找到 §4.1 小节", partSectionStart >= 0);
const partBlockStart = guide.indexOf("```", partSectionStart);
const partBlockEnd = guide.indexOf("```", partBlockStart + 3);
const listedParts = guide.slice(partBlockStart + 3, partBlockEnd).split(/\s+/).filter(Boolean);
check("§4.1 规范清单含 12 个部位（与协议一致）",
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
  ["HTTP 200 不代表生效", (g) => g.includes("HTTP 200") && g.includes("不代表")],
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
  ["说明接收端如何工作（逻辑部位 → 输出槽，用户绑定设备）",
    (g) => g.includes("逻辑部位") && g.includes("绑定") && g.includes("输出槽")],
  ["硬边界：代码里不得出现设备名/通道名", (g) => g.includes("不得出现设备名")],
  ["priority 的作用与判定顺序", (g) => g.includes("priority") && g.includes("大者胜")],
  ["旋转换向要显式发方向", (g) => g.includes("rotateDirection")],
  ["给出可直接改用的代码骨架", (g) => g.includes("postCommand") && g.includes("setBaseline")],
  ["12 个规范部位全称", (g) => g.includes("urethra") && g.includes("prostate")],
  ["虚拟组不支持（要发多条 target）", (g) => g.includes("虚拟组") && g.includes("多条 target")],
];

/* 本文档必须【自包含】：不得要求读者去翻本项目的其它文档。
 * 允许出现的是"接收端在 XToys 侧接收"这类描述，不允许出现 docs/NN 这类路径依赖。 */
console.log("\nE2. 文档必须自包含（不得依赖本项目其它文档）");
const INTERNAL_DOC_REFS = [...guide.matchAll(/docs\/\d\d-[a-z-]+\.md|HANDOFF\.md|docs\/0\d/g)].map((m) => m[0]);
check("不引用 docs/NN-*.md 或 HANDOFF.md", INTERNAL_DOC_REFS.length === 0,
  `发现引用：${[...new Set(INTERNAL_DOC_REFS)].join(", ")}`);
check('不写「以其它文档为准」', !guide.includes("以那两份为准") && !guide.includes("权威规格在"));
for (const [label, predicate] of REQUIRED_TOPICS) {
  check(label, predicate(guide));
}

/* G. 文档内联的【数值限制与上限】必须与运行时常量一致。
 * 这些边界如果不符，照文档写同样会被拒 —— 与错误码一样属于硬契约。 */
console.log("\nG. 文档内联的数值限制必须与运行时一致");
const LIMITS = [
  ["targets 上限 16", /超过 16 条/, "XTHB_MAX_TARGETS = 16"],
  ["id 上限 64 字符", /≤\s*64\s*字符|64 字符/, "XTHB_MAX_ID_CHARS = 64"],
  ["时长上限 600000 ms", /≤\s*600000|600000\s*ms/, "XTHB_MAX_DURATION_MS = 600000"],
  ["同时有效事件上限 64", /超过\s*64\s*个/, "XTHB_MAX_EVENTS = 64"],
  ["payload 上限 16384 字符", /16384/, "XTHB_MAX_PAYLOAD_CHARS = 16384"],
];
for (const [label, re, constDecl] of LIMITS) {
  check(`${label}：文档写了`, re.test(guide));
  check(`${label}：运行时常量一致`, runtime.includes(constDecl), constDecl);
}
/* 文档里出现的具体数值也必须在运行时里存在，避免写错数字 */
for (const n of ["600000", "64", "100"]) {
  check(`数值 ${n} 在运行时里存在`, runtime.includes(n));
}

/* F. 本文档【不规定】体感逻辑（2026-10-05 用户决定）
 * 冷却 / 批量窗口 / 高潮锁这类策略因游戏而异，写进契约文档会变成误导性的"标准做法"。
 * 只保留"这一点由你判断"的提示，具体数值留在 docs/05 的逐游戏观察记录里。 */
console.log("\nF. 文档不得把体感策略写成规定（具体数值只留在 docs/05）");
const FORBIDDEN_PRESCRIPTIONS = [
  [/命中冷却\s*[:：]?\s*\d+\s*ms/, "规定了命中冷却的具体毫秒数"],
  [/批量窗口\s*[:：]?\s*\d+\s*ms/, "规定了批量窗口的具体毫秒数"],
  [/高潮(锁|去重)\s*[:：]?\s*\d+\s*(ms|秒|s)/, "规定了高潮锁的具体时长"],
  [/120\s*ms/, "出现旧实现的 120ms 参考值"],
  [/200\s*ms\s*窗口/, "出现旧实现的 200ms 批量窗口"],
];
for (const [re, label] of FORBIDDEN_PRESCRIPTIONS) {
  check(`未${label}`, !re.test(guide));
}
check("明确说明体感逻辑由游戏侧自行判断",
  guide.includes("留给你的判断") && guide.includes("按实际游戏定"));

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${"-".repeat(64)}`);
if (failures > 0) {
  console.log(`规格检查失败：${failures} 项 —— docs/08 与实现不一致，必须修`);
  process.exit(1);
}
console.log("docs/08 的全部规格声明与真实运行时一致。");
