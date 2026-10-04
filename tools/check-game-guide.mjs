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

/* 部位名：【可扩展】但有命名规范。
 * 文档不得把部位清单写成"只能用这些" —— 接收端本来就没有部位白名单，
 * 部位是否生效由接收端配置决定，可以按规范增加。 */
const partSectionStart = guide.indexOf("### 4.1");
check("能找到 §4.1 小节", partSectionStart >= 0);
const stdSectionStart = guide.indexOf("### 4.2", partSectionStart);
const partBlockStart = guide.indexOf("```", stdSectionStart);
const partBlockEnd = guide.indexOf("```", partBlockStart + 3);
const listedParts = guide.slice(partBlockStart + 3, partBlockEnd).split(/\s+/).filter(Boolean);
check("§4.2 已定义部位清单含 12 个标准名",
  listedParts.length === 12, `实际 ${listedParts.length}: ${listedParts.join(",")}`);
check("§4.2 清单用全称 clitoris/anus，不含 clit/anal",
  listedParts.includes("clitoris") && listedParts.includes("anus") &&
  !listedParts.includes("clit") && !listedParts.includes("anal"), listedParts.join(","));
/* 可扩展性必须写清楚，且要给出规范 */
check("§4.1 说明部位名可扩展", guide.includes("可扩展") || guide.includes("不是固定"));
check("§4.1 给出命名规范（解剖学全称 / 小写 / 下划线）",
  guide.includes("解剖学英文全称") && guide.includes("下划线"));
check("§4.1 明确部位名不得表示设备或事件",
  guide.includes("不表示") && guide.includes("estim_nipple"));
check("§4.1 说明新增部位需与接收端约定",
  guide.includes("接收端维护者") && guide.includes("约定"));
check("§4.1 明确警告不要用 clit/anal",
  guide.includes("不是 `clit`") && guide.includes("不是 `anal`"));
/* 反向：不得出现"只能用这 12 个"这类封闭表述 */
const CLOSED_WORDING = [/只能用这\s*\d+\s*个/, /仅限于这\s*\d+\s*个/, /不得超过这\s*\d+\s*个/];
for (const re of CLOSED_WORDING) {
  check(`未出现封闭式表述 ${re}`, !re.test(guide));
}
check("§4.5 警告游戏内部键名不能用",
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
  ["部位命名规范可扩展（不是固定清单）",
    (g) => (g.includes("可扩展") || g.includes("不是固定")) && g.includes("解剖学英文全称")],
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
  guide.includes("留给你的判断") && guide.includes("由游戏侧自行判断"));

/* H. 跨文档一致性：三份文档对"部位名"的描述必须一致（可扩展 + 同一套命名规范）
 * 否则游戏侧指南说"可扩展"、接口文档说"只有这 12 个"，读者无所适从。 */
console.log("\nH. 三份文档对「部位名」的描述必须一致");
const protocolDoc = readFileSync(join(ROOT, "docs", "02-webhook-protocol.md"), "utf8");
const mappingDoc = readFileSync(join(ROOT, "docs", "03-protocol-mapping.md"), "utf8");
for (const [label, doc] of [["docs/02 接口文档", protocolDoc], ["docs/03 映射文档", mappingDoc]]) {
  check(`${label}：说明部位名可扩展/非白名单`,
    (doc.includes("不是硬上限") || doc.includes("没有\"协议部位白名单\"") ||
     doc.includes("没有「协议部位白名单」") || doc.includes("可扩展")));
  check(`${label}：写出解剖学全称的命名规范`, doc.includes("解剖学"));
  check(`${label}：写出下划线规则`, doc.includes("下划线"));
  check(`${label}：明确只表示部位、不表示动作或设备`,
    doc.includes("只表示部位") || doc.includes("只表示\"哪个部位\""));
}
check("三份文档都不把部位清单写成封闭清单",
  [/只能用这\s*\d+\s*个/, /仅限于这\s*\d+\s*个/].every((re) =>
    !re.test(guide) && !re.test(protocolDoc) && !re.test(mappingDoc)));

/* I. 五个"容易被写含糊/写错"的点必须写清楚（2026-10-05 评审提出的问题） */
console.log("\nI. 关键易错点必须写清楚");
check("A：明确写出只有 test 不需要 eventId/sequence",
  guide.includes("只有 `test` 不需要 `eventId`"));
check("A：核对清单里不再要求所有命令都带 eventId",
  !/每条命令都带 eventId/.test(guide));
check("B：明确接收端返回值不会传给游戏侧",
  guide.includes("不会通过 Webhook 响应传回") || guide.includes("不会传给游戏侧"));
check("B：明确不得用响应做重试/状态机决策",
  guide.includes("响应体") && (guide.includes("不要") || guide.includes("不得")));
check("C：明确区分「接收端合并」与「POST 请求成本」",
  guide.includes("不减少") && guide.includes("POST"));
check("C：声明没有实测速率上限（不编造数值）",
  guide.includes("没有实测的速率上限"));
check("D：给出「全身/泛用」事件的扇出做法",
  guide.includes("扇出") && guide.includes("发多条 target"));
check("D：说明扇出到哪些部位由游戏侧决定",
  guide.includes("翻译决定") || guide.includes("游戏侧的职责"));
check("E：给出切换顺序与回退方案",
  guide.includes("切换时机") && guide.includes("回退"));
check("E：说明新旧协议不兼容、无并行期",
  guide.includes("完全不兼容") && guide.includes("唯一可用组合"));

/* 运行时的确证：test 只强制 source + targets */
const testNoEvt = send({
  protocolVersion: 1, command: "test", source: "spec-noevt",
  targets: [{ part: "nipple", estimIntensity: 10 }],
});
check("运行时确证：test 不带 eventId/sequence 被接受",
  testNoEvt.ok === true && testNoEvt.code === "validated", JSON.stringify(testNoEvt));

/* J. 骨架 API 必须支持"一次多部位"，且文档不得出现自相矛盾的响应措辞 */
console.log("\nJ. 骨架 API 与响应措辞");
check("骨架提供多 target 的发送原语 sendEvent(parts, opts)",
  guide.includes("function sendEvent(parts, opts)"));
check("骨架的 target 构造独立成 buildTarget（可复用）",
  guide.includes("function buildTarget(part, opts)"));
check("单部位 sendHit 是 sendEvent 的薄包装（不是另一条路径）",
  /function sendHit\(part, opts\)\s*\{\s*return sendEvent\(\[part\], opts\);/.test(guide));
check("说明多部位应合并进一条命令，不要循环单部位版本",
  guide.includes("不要写成 for 循环里调 sendHit") || guide.includes("不要循环调用单部位版本"));
check("提供 updateEvent（用更高 sequence 替换同一事件）",
  guide.includes("function updateEvent(eventId, parts, opts)"));
check("用法示例含多部位扇出调用", guide.includes("sendEvent(['nipple', 'clitoris', 'vagina', 'anus']"));

/* 响应措辞：不得再出现"接收端返回 …"这种会误导的断言式表述 */
const RESPONSE_CONTRADICTIONS = [
  [/格式正确时接收端返回/, "§8.1 仍写「接收端返回」(与 §1.1 矛盾)"],
  [/^> 接收端对每条命令返回/m, "docs/02 仍以「接收端返回」开头陈述"],
];
for (const [re, label] of RESPONSE_CONTRADICTIONS) {
  check(`未出现矛盾的响应措辞：${label}`, !re.test(guide) && !re.test(protocolDoc));
}
check("§8.1 明确 test 的结果只在 XToys 日志里看",
  guide.includes("去 XToys 日志里看结果"));
check("docs/02 §6 先讲「不会传给游戏侧」再讲内部返回值",
  protocolDoc.indexOf("不会传给游戏侧") < protocolDoc.indexOf("接收端内部对每条命令产生"));

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${"-".repeat(64)}`);
if (failures > 0) {
  console.log(`规格检查失败：${failures} 项 —— docs/08 与实现不一致，必须修`);
  process.exit(1);
}
console.log("docs/08 的全部规格声明与真实运行时一致。");
