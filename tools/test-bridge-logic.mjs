#!/usr/bin/env node
/*
 * 运行时逻辑测试：在 Node 里用 mock 宿主 API 跑 src/xtoys-bridge.js。
 *
 * 这不是"覆盖每一个防御分支"的套件（HANDOFF.md §7.3 明确不要那种）。
 * 它只验证会被**证伪**的关键逻辑：
 *   - 映射：part → 专属 Block、指标分派、忽略留痕
 *   - 仲裁：priority → 数值 → sequence，只在同一部位内部
 *   - 序号栅栏与基线快照语义
 *   - 推送判据：数值 或 driveId 变化（含"新事件同强度必须重推"）
 *   - frequency 缺省 = 哨兵值，不是 0
 *   - 归零：stop_all / 停止函数 一定把所有音量变量写零
 *
 * 它**不能**替代真机验收（HANDOFF.md §9.1）：mock 只是"调用没抛异常"的模拟，
 * 不代表任何设备行为。Rotate-nipple 在真机上仍未验证。
 *
 * 用法：node tools/test-bridge-logic.mjs
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* 变量名 / Job 名一律从命名真源取，绝不手写 —— 手写过一次，结果与运行时
 * 对"vibrate vs vibrator"的理解不一致，单元测试全绿却谁也收不到输出。 */
import {
  FREQUENCY_SENTINEL, buildBridgeConfig,
  volumeVarFor, rampVarFor, frequencyVarFor, directionVarFor, channelId,
} from "./xtoys-naming.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RUNTIME_SRC = join(ROOT, "src", "xtoys-bridge.js");

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    const message = err && err.message ? err.message : String(err);
    failures.push({ name, message });
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.split("\n").join("\n       ")}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n       期望: ${e}\n       实际: ${a}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------- mock 宿主 */

/*
 * 配置直接取自命名真源（与 tools/build-xtoys-script.mjs 生成的 BRIDGE_CONFIG
 * 逐字一致），所以测试不可能再"照着自己的想象"编出一套变量名。
 */
function bridgeConfig(overrides = {}) {
  return Object.assign(buildBridgeConfig(), overrides);
}

/* 去掉注释，避免注释里提到的禁用语法（如 "=>"）被当成真代码。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function createMockHost() {
  const state = { variables: {}, variableLog: [], jobsStarted: [], logs: [] };
  const testDate = { current: 1000000 };
  const fault = { failCallActionOnJob: null, failAllCallActions: false };

  const sandbox = {
    setVariable(name, value) {
      state.variables[name] = value;
      state.variableLog.push({ name, value });
    },
    getVariable(name) {
      return Object.prototype.hasOwnProperty.call(state.variables, name)
        ? state.variables[name] : null;
    },
    callAction(action) {
      /* 让测试能模拟"宿主 API 抛异常"——真实 XToys 里无法预知，必须能扛住。 */
      if (fault.failAllCallActions) throw new Error("模拟：callAction 整体失败");
      if (fault.failCallActionOnJob && action && action.job === fault.failCallActionOnJob) {
        throw new Error("模拟：callAction 在 " + action.job + " 上抛异常");
      }
      if (action && action.type === "updateJob" && action.action === "start") {
        state.jobsStarted.push(action.job);
      }
    },
    console: { log: (text) => state.logs.push(String(text)) },
    Date: { now: () => testDate.current },
    JSON, Object, Math,
  };
  sandbox.globalThis = sandbox;

  const context = createContext(sandbox);
  runInContext(readFileSync(RUNTIME_SRC, "utf8"), context, { filename: "xtoys-bridge.js" });

  const call = {
    init: () => runInContext("xtoysBridgeInit();", context),
    tick: () => runInContext("xtoysBridgeTick();", context),
    handle: (payload) => {
      context.__payload = payload;
      return runInContext("xtoysBridgeHandle(__payload);", context);
    },
    stopAll: () => runInContext("xtoysBridgeStopAll();", context),
    raw: (expr) => runInContext(expr, context),
    /* 走 safeCall 的入口，用于验证异常被包住而不是冲出去。 */
    safe: (expr) => runInContext("safeCall(function(){" + expr + "});", context),
    injectFault: (f) => Object.assign(fault, f),
  };

  const V = (name) => state.variables[name];
  const pushCount = () => state.jobsStarted.length;
  const lastJobs = () => state.jobsStarted.slice(-9);

  return { state, testDate, call, V, pushCount, lastJobs };
}

function envelope(inner) {
  return JSON.stringify({ action: "xtoys_game_bridge", payload: JSON.stringify(inner) });
}

/* 已初始化、已跑过一次 tick 的宿主。tick 掉的第一次推送是初始化全零。 */
function bootHost(config = bridgeConfig()) {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = JSON.stringify(config);
  host.call.init();
  host.call.tick();
  return host;
}

/* 九条输出路径的代表性变量名 —— 全部由命名真源派生。 */
const ID = {
  estimNipple: channelId("estim", "nipple"),
  vibrateNipple: channelId("vibrate", "nipple"),
  rotateNipple: channelId("rotate", "nipple"),
  estimClitoris: channelId("estim", "clitoris"),
  vibrateVagina: channelId("vibrate", "vagina"),
  vibrateAnus: channelId("vibrate", "anus"),
};
const VOL = {
  estimNipple: volumeVarFor(ID.estimNipple),
  vibrateNipple: volumeVarFor(ID.vibrateNipple),
  rotateNipple: volumeVarFor(ID.rotateNipple),
  estimClitoris: volumeVarFor(ID.estimClitoris),
  vibrateVagina: volumeVarFor(ID.vibrateVagina),
  vibrateAnus: volumeVarFor(ID.vibrateAnus),
};
const FREQ_NIPPLE = frequencyVarFor(ID.estimNipple);
const DIR_NIPPLE = directionVarFor(ID.rotateNipple);
const RAMP_NIPPLE = rampVarFor(ID.estimNipple);

/* ============================================================== 测试开始 */

console.log("XToys 触觉桥 — 运行时逻辑测试（mock 宿主，不代表设备行为）");

section("1. 初始化与配置校验");

test("初始化后所有音量变量为 0、频率为哨兵值、方向为 0", () => {
  const host = bootHost();
  assertEqual(host.V(VOL.estimNipple), 0, "estim-nipple 音量应为 0");
  assertEqual(host.V(VOL.vibrateVagina), 0, "vibrate-vagina 音量应为 0");
  assertEqual(host.V(VOL.rotateNipple), 0, "rotate-nipple 音量应为 0");
  assertEqual(host.V(FREQ_NIPPLE), FREQUENCY_SENTINEL, "频率变量应为哨兵值（不动频率）");
  assertEqual(host.V(DIR_NIPPLE), 0, "方向码应为 0");
});

test("Block 专属一个 part：Channel 被两个 part 共用时拒绝初始化", () => {
  const config = bridgeConfig();
  config.parts.anus = { vibrate: "part-vibrator-vagina" }; /* 与 vagina 撞车 */
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = JSON.stringify(config);
  assertEqual(host.call.init(), "config_error", "配置冲突应返回 config_error");
  assertEqual(host.V("xthb-status"), "config_error", "状态应标记 config_error");
  host.call.tick();
  assertEqual(host.pushCount(), 0, "配置错误时不得驱动任何输出");
});

test("配置里出现清单外的部位名仍然可用（没有白名单）", () => {
  const config = bridgeConfig();
  /* docs/03 §6.1：部位名的合法性完全由这张映射表决定，表里有就是合法的。
   * 表里写错名字的后果只是那个名字不生效，而不是让整个运行时停摆。 */
  config.parts.tail = { vibrate: "part-vibrator-tail" };
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = JSON.stringify(config);
  assertEqual(host.call.init(), "initialized", "清单外的部位名不应导致配置错误");
  host.call.tick();
  assert(host.pushCount() > 0, "应正常驱动已配置的 Block");
});

test("配置的 frequencySentinel 落在 0–100 内时拒绝初始化", () => {
  const config = bridgeConfig();
  config.frequencySentinel = 50; /* 与真实频率值无法区分 → 必须拒绝 */
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = JSON.stringify(config);
  assertEqual(host.call.init(), "config_error", "哨兵值必须在 0–100 之外");
});

test("配置非法时 tick 静默，不驱动输出", () => {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = "{ 坏 JSON";
  assertEqual(host.call.init(), "config_error", "非法配置应返回 config_error");
  host.call.tick();
  assertEqual(host.pushCount(), 0, "不得启动输出 Job");
});

test("未初始化时 handle 被拒绝", () => {
  const host = createMockHost();
  const result = host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  assertEqual(result.ok, false, "应返回 ok:false");
  assertEqual(host.pushCount(), 0, "不得启动输出 Job");
});

test("运行时代码不引用禁止的 API（最大强度 / eval / Function）", () => {
  const source = readFileSync(RUNTIME_SRC, "utf8");
  const banned = [/setMax/i, /maxIntensity/i, /maxRotate/i, /maxVolume/i, /\beval\s*\(/, /new\s+Function/];
  for (const pattern of banned) {
    assert(!pattern.test(source), `源码命中禁止模式 ${pattern}`);
  }
});

test("ES5 子集：不含 let/const/箭头/模板字符串/class", () => {
  const source = stripComments(readFileSync(RUNTIME_SRC, "utf8"));
  const banned = [
    { re: /(^|[^\w.])let\s+[A-Za-z_$]/, name: "let" },
    { re: /(^|[^\w.])const\s+[A-Za-z_$]/, name: "const" },
    { re: /=>/, name: "箭头函数" },
    { re: /`/, name: "模板字符串" },
    { re: /(^|[^\w.])class\s+[A-Za-z_$]/, name: "class" },
    { re: /\basync\b/, name: "async" },
    { re: /\bawait\b/, name: "await" },
  ];
  for (const b of banned) {
    const hit = source.match(b.re);
    assert(!hit, `源码含 ES5 禁用语法：${b.name}（命中 ${JSON.stringify(hit && hit[0])}）`);
  }
});

section("2. 协议解析与拒绝");

test("外层 action 不匹配时拒绝，且不驱动输出", () => {
  const host = bootHost();
  const before = host.pushCount();
  const payload = JSON.stringify({ action: "something_else", payload: "{}" });
  assertEqual(host.call.handle(payload).ok, false, "应拒绝");
  assertEqual(host.pushCount(), before, "被拒载荷不得驱动输出");
});

test("内层 payload 非法 JSON → invalid_json", () => {
  const host = bootHost();
  const payload = JSON.stringify({ action: "xtoys_game_bridge", payload: "{ broken" });
  assertEqual(host.call.handle(payload).code, "invalid_json", "应返回 invalid_json");
});

test("protocolVersion 非 1 → unsupported_protocol_version", () => {
  const host = bootHost();
  assertEqual(
    host.call.handle(envelope({ protocolVersion: 2, command: "stop_all", source: "s" })).code,
    "unsupported_protocol_version", "应拒绝不支持的版本");
});

test("未知 command → unsupported_command", () => {
  const host = bootHost();
  assertEqual(
    host.call.handle(envelope({ protocolVersion: 1, command: "nope", source: "s" })).code,
    "unsupported_command", "应拒绝未知命令");
});

test("缺少 source → missing_source", () => {
  const host = bootHost();
  assertEqual(
    host.call.handle(envelope({ protocolVersion: 1, command: "stop_all" })).code,
    "missing_source", "应要求 source");
});

test("intensity 超范围夹取到 100", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", intensity: 250, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 100, "应夹到 100");
});

test("显式 null 的数值字段被拒绝", () => {
  const host = bootHost();
  for (const bad of ["50", null, true, {}, []]) {
    const result = host.call.handle(envelope({
      protocolVersion: 1, command: "play", source: "s", eventId: "e-" + String(bad), sequence: 1,
      targets: [{ part: "nipple", intensity: bad, durationMs: 500 }],
    }));
    assertEqual(result.ok, false, `intensity=${JSON.stringify(bad)} 应被拒绝`);
  }
});

test("play 缺 durationMs → invalid_duration", () => {
  const host = bootHost();
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", intensity: 50 }],
  })).code, "invalid_duration", "应要求正 durationMs");
});

test("rotateSpeed > 0 缺方向 → invalid_targets", () => {
  const host = bootHost();
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", rotateSpeed: 60, durationMs: 1000 }],
  })).code, "invalid_targets", "旋转必须显式给方向");
});

test("rotateSpeed = 0 可以不写方向（停旋转）", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", rotateSpeed: 0, durationMs: 1000 }],
  }));
  assertEqual(result.ok, true, "rotateSpeed=0 应合法");
});

test("只带 rotateDirection 没有驱动指标 → 拒绝", () => {
  const host = bootHost();
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", rotateDirection: "clockwise", durationMs: 1000 }],
  })).code, "invalid_targets", "没有任何驱动指标应拒绝");
});

test("stop 没有任何选择器 → missing_stop_selector（解析阶段就拒绝）", () => {
  const host = bootHost();
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s",
  })).code, "missing_stop_selector", "应拒绝无选择器的 stop");
});

test("同一个 targets 里同部位重复 → 整体拒绝", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [
      { part: "nipple", intensity: 40, durationMs: 1000 },
      { part: "nipple", rotateSpeed: 60, rotateDirection: "clockwise", durationMs: 1000 },
    ],
  }));
  assertEqual(result.ok, false, "重复部位应整体拒绝");
  assertEqual(result.code, "invalid_targets", "应返回 invalid_targets");
});

test("test 命令只校验不驱动硬件", () => {
  const host = bootHost();
  const before = host.pushCount();
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "test", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 50 }],
  })).code, "validated", "应返回 validated");
  host.call.tick();
  assertEqual(host.pushCount(), before, "test 不得启动输出 Job");
  assertEqual(host.V(VOL.estimNipple), 0, "test 不得驱动输出");
});

section("3. 未识别部位 / 无对应 Block → 忽略并留痕");

test("未识别的部位返回 ok:true 并被忽略（不是整体拒绝）", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "tentacle", intensity: 80, durationMs: 1000 }],
  }));
  assertEqual(result.ok, true, "未识别部位应被忽略而不是拒绝");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "忽略的部位不得驱动任何输出");
  assert(host.V("xthb-ignored-count") > 0, "应计入忽略计数");
  assert(String(host.V("xthb-last-ignored")).includes("tentacle"), "应记录被忽略的部位");
});

test("部位存在但该指标没有 Block → 该指标被忽略", () => {
  const host = bootHost();
  /* vagina 只配了 vibrate；发 frequency 与 rotateSpeed 都应被忽略。 */
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "vagina", intensity: 30, frequency: 90, rotateSpeed: 50,
      rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  assertEqual(result.ok, true, "应接受（部位与指标都合法）");
  host.call.tick();
  assertEqual(host.V(VOL.vibrateVagina), 30, "vibrate 应拿到 intensity");
  assertEqual(host.V(VOL.rotateNipple), 0, "rotate 不得被 vagina 的 rotateSpeed 驱动");
});

test("vibrate 永不消费 frequency（不写频率变量）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "vagina", intensity: 30, frequency: 90, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V("xthb-vibrator-vagina-frequency"), undefined, "vibrate 不应有频率变量");
});

section("4. 基线与有限事件");

test("set_baseline 产生持续输出；intensity 驱动 estim + vibrate", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 25 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 25, "estim 应输出基线值");
  assertEqual(host.V(VOL.vibrateNipple), 25, "vibrate 应输出基线值");
});

test("基线是完整快照：新快照遗漏的部位被清除", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 40 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 40, "第一条基线生效");
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 2,
    targets: [{ part: "clitoris", intensity: 10 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "nipple 应被新快照清除");
  assertEqual(host.V(VOL.estimClitoris), 10, "clitoris 生效");
});

test("空 targets 的 set_baseline 清空基线", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 40 }],
  }));
  host.call.tick();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 2, targets: [],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "空快照应清空输出");
});

test("play 瞬态叠加，到期回到基线而不是归零", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 20 }],
  }));
  host.call.tick();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "hit", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 300 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 80, "事件期间取瞬态值");
  host.testDate.current += 400;
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 20, "到期后回到基线 20，不是 0");
});

test("sequence 必须严格递增，否则如实返回 invalid_sequence", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 5,
    targets: [{ part: "nipple", intensity: 30, durationMs: 60000 }],
  }));
  host.call.tick();
  const stale = host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "e1", sequence: 5,
    targets: [{ part: "nipple", intensity: 90, durationMs: 60000 }],
  }));
  assertEqual(stale.ok, false, "相同 sequence 必须返回失败");
  assertEqual(stale.code, "invalid_sequence", "错误码应为 invalid_sequence");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 30, "被忽略的更新不得改变输出");
  host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "e1", sequence: 6,
    targets: [{ part: "nipple", intensity: 90, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 90, "更大 sequence 应替换");
});

test("不同 source 可用相同 eventId", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "a", eventId: "hit", sequence: 1,
    targets: [{ part: "nipple", intensity: 30, durationMs: 60000 }],
  }));
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "b", eventId: "hit", sequence: 1,
    targets: [{ part: "nipple", intensity: 70, durationMs: 60000 }],
  })).ok, true, "不同 source 不应冲突");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 70, "取更高值");
});

test("基线序号栅栏在 stop_all 后保留，必须继续递增", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 7,
    targets: [{ part: "nipple", intensity: 30 }],
  }));
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 7,
    targets: [{ part: "nipple", intensity: 30 }],
  })).code, "invalid_sequence", "停机后相同序号应被拒绝");
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 8,
    targets: [{ part: "nipple", intensity: 30 }],
  })).ok, true, "更大序号应被接受");
});

section("5. 同一部位内部仲裁");

test("priority 大者胜，即使数值更小", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "weak", sequence: 1,
    targets: [{ part: "nipple", intensity: 90, durationMs: 60000, priority: 1 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "strong", sequence: 2,
    targets: [{ part: "nipple", intensity: 10, durationMs: 60000, priority: 5 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 10, "priority 5 应压过 priority 1");
});

test("priority 相同时数值大者胜", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "a", sequence: 9,
    targets: [{ part: "nipple", intensity: 30, durationMs: 60000, priority: 2 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "b", sequence: 1,
    targets: [{ part: "nipple", intensity: 60, durationMs: 60000, priority: 2 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 60, "同 priority 取更大数值");
});

test("不同部位永不竞争：nipple 与 clitoris 各自独立", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "a", sequence: 1,
    targets: [{ part: "nipple", intensity: 20, durationMs: 60000, priority: 99 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "b", sequence: 2,
    targets: [{ part: "clitoris", intensity: 90, durationMs: 60000, priority: 1 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 20, "nipple 用自己的值");
  assertEqual(host.V(VOL.estimClitoris), 90, "clitoris 用自己的值，不受 nipple 影响");
});

test("基线（priority 0）被高优先级事件压过", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 30 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "hit", sequence: 2,
    targets: [{ part: "nipple", intensity: 95, durationMs: 60000, priority: 10 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 95, "高优先级瞬态压过基线");
});

test("数值更小但 priority 更高的事件能压过基线（priority 存在的理由）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 30 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "climax", sequence: 2,
    targets: [{ part: "nipple", intensity: 20, durationMs: 60000, priority: 10 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 20, "没有 priority 时会被基线的 30 静默压掉");
});

section("6. 旋转路径");

test("rotateSpeed + 方向驱动旋转通道，不驱动强度通道", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "drill", sequence: 1,
    targets: [{ part: "nipple", rotateSpeed: 60, rotateDirection: "counterclockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.rotateNipple), 60, "旋转速度应写入");
  assertEqual(host.V(DIR_NIPPLE), -1, "counterclockwise 应为 -1");
  assertEqual(host.V(VOL.estimNipple), 0, "rotateSpeed 不得推导出强度");
  assertEqual(host.V(VOL.vibrateNipple), 0, "rotateSpeed 不得推导出振动强度");
});

test("旋转不会自动反向，必须显式 update", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "d", sequence: 1,
    targets: [{ part: "nipple", rotateSpeed: 50, rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(DIR_NIPPLE), 1, "初始顺时针");
  host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "d", sequence: 2,
    targets: [{ part: "nipple", rotateSpeed: 50, rotateDirection: "counterclockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(DIR_NIPPLE), -1, "显式 update 后换向");
});

test("rotateDirection 大小写归一化", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "d", sequence: 1,
    targets: [{ part: "nipple", rotateSpeed: 50, rotateDirection: "ClockWise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(DIR_NIPPLE), 1, "应归一化为顺时针");
});

test("带方向的 intensity 事件同时驱动三条路径（合并成一条 target）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "all", sequence: 1,
    targets: [{
      part: "nipple", intensity: 65, frequency: 40,
      rotateSpeed: 50, rotateDirection: "clockwise", durationMs: 60000,
    }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 65, "estim 音量");
  assertEqual(host.V(FREQ_NIPPLE), 40, "estim 频率");
  assertEqual(host.V(VOL.vibrateNipple), 65, "vibrate 音量");
  assertEqual(host.V(VOL.rotateNipple), 50, "rotate 音量");
  assertEqual(host.V(DIR_NIPPLE), 1, "rotate 方向");
});

section("7. frequency 缺省 = 保持设备当前值");

test("没有 frequency 的意图 → 频率变量写哨兵值（不是 0）", () => {
  const host = bootHost();
  /* 先明确设一个频率值。 */
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "withFreq", sequence: 1,
    targets: [{ part: "nipple", intensity: 50, frequency: 70, durationMs: 100 }],
  }));
  host.call.tick();
  assertEqual(host.V(FREQ_NIPPLE), 70, "有频率意图时应写该值");
  /* 该事件到期，换一个不带 frequency 的事件。 */
  host.testDate.current += 500;
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "noFreq", sequence: 2,
    targets: [{ part: "nipple", intensity: 60, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 60, "强度应更新");
  assertEqual(host.V(FREQ_NIPPLE), FREQUENCY_SENTINEL,
    "没有频率意图时必须写哨兵值，而不是 0（否则会改变设备当前频率）");
});

test("显式 frequency = 0 是合法指令，写成 0（不是哨兵值）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", intensity: 50, frequency: 0, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(FREQ_NIPPLE), 0, "显式 0 应写成 0");
});

test("frequency 跟随强度 winner，不独立仲裁", () => {
  const host = bootHost();
  /* 低优先级但频率高；高优先级频率低且强度更大。 */
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "low", sequence: 1,
    targets: [{ part: "nipple", intensity: 10, frequency: 99, durationMs: 60000, priority: 1 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "high", sequence: 2,
    targets: [{ part: "nipple", intensity: 80, frequency: 20, durationMs: 60000, priority: 5 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 80, "强度 winner 是 high");
  assertEqual(host.V(FREQ_NIPPLE), 20, "频率必须跟随同一个 winner，不能取 low 的 99");
});

test("音量 winner 没有频率意图时，频率取自带频率的最高优先意图", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "withFreq", sequence: 1,
    targets: [{ part: "nipple", intensity: 10, frequency: 99, durationMs: 60000, priority: 1 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "noFreq", sequence: 2,
    targets: [{ part: "nipple", intensity: 80, durationMs: 60000, priority: 5 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 80, "音量 winner 是 noFreq");
  /*
   * 频率是独立维度：noFreq 没提频率（没有意见），所以"带频率的最高优先意图"
   * 就是 withFreq，频率取 99。规则与 docs/03 §4.5 一致 —— 没人提频率时
   * 才写哨兵值；一旦有人明确要求频率，就应该生效。
   */
  assertEqual(host.V(FREQ_NIPPLE), 99,
    "音量 winner 未提频率时，频率应由带频率的最高优先意图决定");
});

test("所有意图都没提频率时才写哨兵值", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "noFreq", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 80, "强度应生效");
  assertEqual(host.V(FREQ_NIPPLE), FREQUENCY_SENTINEL,
    "没有任何频率意图时必须写哨兵值，保持设备当前频率");
});

section("8. 推送判据：数值 或 driveId 变化");

test("值没变时重复 tick 不再推送", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 33 }],
  }));
  host.call.tick();
  const before = host.pushCount();
  host.call.tick();
  host.call.tick();
  host.call.tick();
  assertEqual(host.pushCount(), before, "稳定态不得重复推送（防抖）");
});

test("新事件强度与当前相同也必须重推（driveId 变化）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 20 }],
  }));
  host.call.tick();
  const before = host.pushCount();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "hit", sequence: 2,
    targets: [{ part: "nipple", intensity: 20, rampUpMs: 150, durationMs: 900 }],
  }));
  host.call.tick();
  assert(host.pushCount() > before,
    "同强度新事件必须重推，否则连击在体感上会消失（ramp 不会重跑）");
  assertEqual(host.V(VOL.estimNipple), 20, "数值不变");
});

test("到期回落也推送（否则设备粘在旧值）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 200 }],
  }));
  host.call.tick();
  const during = host.pushCount();
  host.testDate.current += 500;
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "到期应归零");
  assert(host.pushCount() > during, "归零必须推送一次");
});

test("rampSeconds 变化也触发推送", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", intensity: 50, rampUpMs: 100, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(RAMP_NIPPLE), 0.1, "rampUpMs=100 → 0.1 秒");
  /* 同强度同 driveId 不可能换 ramp，换事件则 driveId 也变 —— 两者都会触发推送。 */
  const before = host.pushCount();
  host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "e1", sequence: 2,
    targets: [{ part: "nipple", intensity: 50, rampUpMs: 400, durationMs: 60000 }],
  }));
  host.call.tick();
  assert(host.pushCount() > before, "ramp 变化应推送");
  assertEqual(host.V(RAMP_NIPPLE), 0.4, "400ms → 0.4 秒");
});

section("9. 停止与归零");

test("stop 只移除列出的部位", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [
      { part: "nipple", intensity: 80, durationMs: 60000 },
      { part: "clitoris", intensity: 40, durationMs: 60000 },
    ],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 80, "两个部位各自输出");
  assertEqual(host.V(VOL.estimClitoris), 40, "clitoris 输出自己的值");
  host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s", eventId: "e1",
    targets: [{ part: "nipple" }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "nipple 应停止");
  assertEqual(host.V(VOL.estimClitoris), 40, "clitoris 不受影响");
});

test("stop 只给 eventId 时移除整个事件，回到基线", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 15 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "nipple", intensity: 90, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 90, "事件期间 90");
  host.call.handle(envelope({ protocolVersion: 1, command: "stop", source: "s", eventId: "e1" }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 15, "回到基线 15");
});

test("stop 匹配不到任何东西时如实返回失败", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s", eventId: "不存在",
  }));
  assertEqual(result.ok, false, "不应静默成功");
  assertEqual(result.code, "missing_stop_selector", "应返回 missing_stop_selector");
});

test("stop_all 把所有音量写零并推给输出 Job", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 70, frequency: 50 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "r", sequence: 1,
    targets: [{ part: "nipple", rotateSpeed: 55, rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assert(host.V(VOL.estimNipple) === 70 && host.V(VOL.rotateNipple) === 55, "停机前有非零输出");
  const before = host.pushCount();
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  assertEqual(host.V(VOL.estimNipple), 0, "estim 归零");
  assertEqual(host.V(VOL.vibrateNipple), 0, "vibrate 归零");
  assertEqual(host.V(VOL.rotateNipple), 0, "rotate 归零");
  assertEqual(host.V(FREQ_NIPPLE), FREQUENCY_SENTINEL, "频率写哨兵值，不动设备频率");
  assert(host.pushCount() > before, "归零必须推给输出 Job");
});

test("stop_all 之后 tick 不会恢复任何输出", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 60000 }],
  }));
  host.call.tick();
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  host.call.tick();
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "保持全零");
  assertEqual(host.V(VOL.rotateNipple), 0, "保持全零");
});

test("脚本停止函数把所有音量写零（Final Actions 的 JS 部分）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, frequency: 60, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.call.stopAll(), "stopped", "应返回 stopped");
  assertEqual(host.V(VOL.estimNipple), 0, "estim 归零");
  assertEqual(host.V(VOL.vibrateNipple), 0, "vibrate 归零");
  assertEqual(host.V(VOL.rotateNipple), 0, "rotate 归零");
  assertEqual(host.V(FREQ_NIPPLE), FREQUENCY_SENTINEL, "频率不动");
});

test("停止后 tick 不再驱动输出", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 60000 }],
  }));
  host.call.tick();
  host.call.stopAll();
  const before = host.pushCount();
  host.call.tick();
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "状态已清空，输出保持 0");
  assertEqual(host.pushCount(), before, "不应再推送");
});

section("10. 措辞约束（HANDOFF §3.4）");

test("日志与变量名不声称设备已确认", () => {
  const banned = ["已确认", "已下发", "已送达", "设备收到了", "confirmed", "acked"];
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 1000 }],
  }));
  host.call.tick();
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "x", sequence: 1,
    targets: [{ part: "tentacle", intensity: 10, durationMs: 1000 }],
  }));
  host.call.tick();
  const haystack = host.state.logs.join("\n") + "\n" + Object.keys(host.state.variables).join("\n");
  for (const word of banned) {
    assert(!haystack.includes(word), `出现禁止措辞「${word}」`);
  }
});

section("11. 复核发现的回归（每一条对应一个真实缺陷）");

test("stop_all 在宿主 API 抛异常时仍然把所有音量写零并如实返回", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 80, "前置：有非零输出");

  /* 模拟输出 Job 启动时宿主抛异常：异常必须被吞掉，不能中断归零。 */
  host.call.injectFault({ failAllCallActions: true });
  const result = host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  assertEqual(result.ok, true, "stop_all 仍应如实返回");
  assertEqual(host.V(VOL.estimNipple), 0, "estim 必须归零，不能因异常半途而废");
  assertEqual(host.V(VOL.vibrateNipple), 0, "vibrate 必须归零");
  assertEqual(host.V(VOL.estimClitoris), 0, "所有通道都必须归零");
  assert(host.V("xthb-host-errors") > 0, "应记录被吞掉的宿主异常次数");
});

test("safeCall 包住入口，异常不冲出 JS 边界", () => {
  const host = bootHost();
  const threw = (() => {
    try {
      host.call.safe("throw new Error('boom');");
      return false;
    } catch (err) {
      return true;
    }
  })();
  assertEqual(threw, false, "safeCall 不应让异常传播出去");
  assertEqual(host.V("xthb-status"), "error", "应记录 error 状态");
});

test("停止函数在宿主抛异常时也不中断归零", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 80, durationMs: 60000 }],
  }));
  host.call.tick();
  host.call.injectFault({ failAllCallActions: true });
  assertEqual(host.call.stopAll(), "stopped", "仍应返回 stopped");
  assertEqual(host.V(VOL.estimNipple), 0, "音量必须归零");
});

test("指标级忽略会留痕（部位有，但没有该类 Block）", () => {
  const host = bootHost();
  /* vagina 在测试配置里同时有 estim 与 vibrate；用一个只配 vibrate 的配置。 */
  const config = bridgeConfig();
  delete config.parts.vagina.estim;
  const h = createMockHost();
  h.state.variables["xthb-config-json"] = JSON.stringify(config);
  h.call.init();
  h.call.tick();
  const before = h.V("xthb-ignored-count") || 0;
  h.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "vagina", intensity: 30, frequency: 70, rotateSpeed: 20,
      rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  h.call.tick();
  assert(h.V("xthb-ignored-count") > before,
    "vagina 上没有 estim/rotate Block，frequency 与 rotateSpeed 都必须留痕");
  const last = String(h.V("xthb-last-ignored"));
  assert(last.includes("vagina"), `留痕必须包含部位名，实际：${last}`);
  assert(host.state.logs.length >= 0, "保持接口统一");
});

test("同一问题不重复计数（忽略计数按事件而不是按 tick）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "tentacle", intensity: 40, durationMs: 60000 }],
  }));
  host.call.tick();
  const after1 = host.V("xthb-ignored-count");
  host.call.tick();
  host.call.tick();
  assertEqual(host.V("xthb-ignored-count"), after1, "重复 tick 不得重复计数");
});

test("短暂事件的忽略也会留痕（不能因为到期就消失）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "short", sequence: 1,
    targets: [{ part: "tentacle", intensity: 40, durationMs: 50 }],
  }));
  /* 事件在下一次 tick 之前就到期了。 */
  host.testDate.current += 200;
  host.call.tick();
  assert(host.V("xthb-ignored-count") > 0, "短暂事件的忽略也必须留痕");
  assert(String(host.V("xthb-last-ignored")).includes("tentacle"), "应记录部位名");
});

test("只有 frequency 的意图会真正改变频率，且不把音量拽到 0", () => {
  const host = bootHost();
  /* 先建立一个强度基线。 */
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 55 }],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 55, "前置：强度已输出");
  /* 再发一条只有频率的意图。 */
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "freq-only", sequence: 1,
    targets: [{ part: "nipple", frequency: 88, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.V(FREQ_NIPPLE), 88, "frequency-only 意图必须真正改变频率");
  assertEqual(host.V(VOL.estimNipple), 55,
    "frequency-only 意图不得把音量变量拽到 0（那会切断正在输出的强度）");
});

test("play 的空 targets 被拒绝，且不占用事件名额", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "empty", sequence: 1,
    targets: [],
  }));
  assertEqual(result.ok, false, "空 targets 是畸形输入，必须拒绝");
  host.call.tick();
  assertEqual(host.V("xthb-active-events"), 0, "不得留下空壳事件");
});

test("被拒绝的 stop 不得改变状态", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 70, durationMs: 60000 }],
  }));
  host.call.tick();
  /* 该事件里没有 clitoris，只停 clitoris 应当失败，并且不能动这个事件。 */
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s", eventId: "e",
    targets: [{ part: "clitoris" }],
  }));
  assertEqual(result.ok, false, "没有匹配到任何东西应返回失败");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 70, "被拒绝的命令绝不能改变已有输出");
});

test("stop 的空 targets 在解析阶段就被拒绝", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s", targets: [],
  }));
  assertEqual(result.ok, false, "空 targets 没有选择器");
  assertEqual(result.code, "missing_stop_selector", "应是 missing_stop_selector");
});

test("每个部位各自到期：短事件不被长事件拖着继续输出", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "mixed", sequence: 1,
    targets: [
      { part: "nipple", intensity: 90, durationMs: 200 },
      { part: "clitoris", intensity: 20, durationMs: 5000 },
    ],
  }));
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 90, "前置：nipple 正在输出");
  assertEqual(host.V(VOL.estimClitoris), 20, "前置：clitoris 正在输出");
  /* 过了 nipple 的 200ms，但还没到 clitoris 的 5000ms。 */
  host.testDate.current += 1000;
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0,
    "nipple 的 durationMs=200 已到，必须停止（不能被 5000ms 的 clitoris 拖着）");
  assertEqual(host.V(VOL.estimClitoris), 20, "clitoris 仍在自己的时长内");
});

test("test 命令不带 sequence 也合法（docs/02 §5 的示例形状）", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "test", source: "s",
    targets: [{ part: "nipple", intensity: 50 }],
  }));
  assertEqual(result, { ok: true, code: "validated" }, "test 不应要求 sequence");
  assertEqual(host.pushCount(), 9, "test 仍不得驱动硬件");
});

test("source / eventId 里的控制字符被拒绝（避免身份碰撞）", () => {
  const host = bootHost();
  const bad = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "a\u0000b", eventId: "c", sequence: 1,
    targets: [{ part: "nipple", intensity: 50, durationMs: 1000 }],
  }));
  assertEqual(bad.ok, false, "source 含控制字符应被拒绝");
  const bad2 = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "a", eventId: "b\u0000c", sequence: 1,
    targets: [{ part: "nipple", intensity: 50, durationMs: 1000 }],
  }));
  assertEqual(bad2.ok, false, "eventId 含控制字符应被拒绝");
});

test("过期事件的序号栅栏保留：重放旧 sequence 不会重复刺激", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 7,
    targets: [{ part: "nipple", intensity: 80, durationMs: 200 }],
  }));
  host.call.tick();
  /* 等它完全到期。 */
  host.testDate.current += 1000;
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "已到期归零");
  /* 重放同一个旧 sequence（模拟 webhook 重试）。 */
  const replay = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 7,
    targets: [{ part: "nipple", intensity: 80, durationMs: 200 }],
  }));
  assertEqual(replay.ok, false, "重放旧 sequence 必须被拒绝");
  assertEqual(replay.code, "invalid_sequence", "错误码应为 invalid_sequence");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 0, "重放不得造成重复刺激");
});

test("更大的 sequence 仍可替换已过期的事件", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 7,
    targets: [{ part: "nipple", intensity: 80, durationMs: 200 }],
  }));
  host.call.tick();
  host.testDate.current += 1000;
  host.call.tick();
  const fresh = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 8,
    targets: [{ part: "nipple", intensity: 60, durationMs: 60000 }],
  }));
  assertEqual(fresh.ok, true, "更大 sequence 应被接受");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 60, "新事件应生效");
});

section("12. 真机实测回归：启动时读不到配置");

test("启动时配置不可读，后续 tick 自动补读并恢复（真机踩到的故障）", () => {
  /*
   * 真机实测（2026-09-30）：Initial Actions 里 updateVariable 与 customCode 的
   * 实际执行顺序若不能保证，init 会读到空值 → 报"配置不是合法 JSON" →
   * 之后所有 webhook 都因"运行时未初始化"而无反应。
   * 这条测试锁住自愈行为：tick 里定期重读配置，读到就自动初始化。
   */
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = null; /* 变量还没就绪 */
  assertEqual(host.call.init(), "config_error", "启动时应报配置错误");
  assertEqual(host.call.handle(envelope({
    protocolVersion: 1, command: "stop_all", source: "s",
  })).code, "invalid_config", "未初始化时载荷被拒（真机现象）");

  /* 配置变量后来就绪（模拟 XToys 写变量晚于 customCode）。 */
  host.state.variables["xthb-config-json"] = JSON.stringify(bridgeConfig());
  assertEqual(host.call.tick(), "tick", "tick 应自动补读配置并正常跑完");
  assertEqual(host.V("xthb-status"), "running", "补读成功后应进入 running");

  /* 补读之后 webhook 必须恢复正常。 */
  const accepted = host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 40 }],
  }));
  assertEqual(accepted.ok, true, "补读后 webhook 必须恢复正常");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 40, "补读后输出必须正常");
});

test("配置始终不可读时不会无限刷日志（重试有上限）", () => {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = null;
  host.call.init();
  const before = host.state.logs.length;
  for (let i = 0; i < 40; i += 1) host.call.tick();
  const extra = host.state.logs.length - before;
  assert(extra <= 40, `重试日志应有上限，实际新增 ${extra} 条`);
  assertEqual(host.call.tick(), "not_initialized", "放弃重试后应明确返回 not_initialized");
});

test("配置不是合法 JSON 时把实际读到的内容打进日志（便于诊断）", () => {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = "这不是 JSON";
  host.call.init();
  const joined = host.state.logs.join("\n");
  assert(joined.includes("配置不是合法 JSON"), "应报告解析失败");
  assert(joined.includes("这不是 JSON"), "应把实际读到的内容打出来，而不是只说'不合法'");
});

test("配置值带 BOM / 首尾空白时仍能解析", () => {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = "\uFEFF  " + JSON.stringify(bridgeConfig()) + "  \n";
  assertEqual(host.call.init(), "initialized", "BOM 与首尾空白应被容忍");
});

section("13. 真机实测回归：配置注入（主路）");

test("注入的配置对象可以直接初始化（不读 Script 变量）", () => {
  /* 真机实测：updateVariable 写进变量再读回来，内容被打坏
   * （494 字符 → 91 字符、值全变 undefined）。所以主路改成直接注入。 */
  const host = createMockHost(); /* 注意：没有设置 xthb-config-json */
  const result = host.call.raw(`xtoysBridgeInit(${JSON.stringify(bridgeConfig())});`);
  assertEqual(result, "initialized", "注入对象应能直接完成初始化");
  assert(host.call.raw("xthbInjectedInfo").includes("object"), "应记录注入值类型");
});

test("注入的配置字符串（JSON 文本）可以初始化", () => {
  const host = createMockHost();
  const json = JSON.stringify(bridgeConfig());
  const result = host.call.raw(`xtoysBridgeInit(${JSON.stringify(json)});`);
  assertEqual(result, "initialized", "注入 JSON 文本应能完成初始化");
  assert(host.call.raw("xthbInjectedInfo").includes("string"), "应记录注入值类型");
});

test("即使 Script 变量里的配置被打坏，注入路仍能正常驱动输出", () => {
  /*
   * 精确复现真机故障：变量里是一段被破坏的内容（长度、值都坏了）。
   * 有了注入路，运行时必须照常工作。
   */
  const host = createMockHost();
  host.state.variables["xthb-config-json"] =
    '"undefined,"clitoris":undefined,"vagina":undefined,"anus":undefined},"frequencySentinel":-1}';

  host.call.raw(`xtoysBridgeInit(${JSON.stringify(bridgeConfig())});`);
  assertEqual(host.V("xthb-status"), "running", "注入成功即应进入 running");

  const accepted = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "nipple", intensity: 70, durationMs: 60000 }],
  }));
  assertEqual(accepted.ok, true, "webhook 必须被正常接受（真机故障时这里是 invalid_config）");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 70, "必须真的驱动输出");
});

test("没有注入值时回退读变量（备路仍然有效）", () => {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = JSON.stringify(bridgeConfig());
  assertEqual(host.call.init(), "initialized", "不注入时应回退到读变量");
  assert(host.call.raw("xthbInjectedInfo").includes("回退"), "应标记为回退路径");
});

test("初始化日志会写明配置来源与长度（便于真机核对传值完整性）", () => {
  const host = createMockHost();
  host.call.raw(`xtoysBridgeInit(${JSON.stringify(bridgeConfig())});`);
  const joined = host.state.logs.join("\n");
  assert(joined.includes("配置来源"), "日志应包含配置来源");
  assert(/object\/\d+字符/.test(joined), `日志应包含类型与长度，实际：${joined}`);
});

section("14. 真机实测回归：配置内联进代码文本（主路）");

test("紧凑配置（内联在 code 里）能完成初始化", () => {
  /*
   * 真机实测：配置字符串无论经 variables 注入、还是经变量读写，都会被 XToys 打坏
   * （494 字符 → 91 字符、值全变裸 undefined，模板替换的特征）。
   * 所以主路改成直接内联进 code 文本。这里锁住紧凑形状可用。
   */
  const host = createMockHost();
  const result = host.call.raw('xtoysBridgeInit({"p":{"nipple":["estim","vibrate","rotate"],"vagina":["estim","vibrate"]},"s":-1});');
  assertEqual(result, "initialized", "紧凑配置应能完成初始化");
  assertEqual(host.V("xthb-status"), "running", "状态应为 running");
  assert(host.call.raw("xthbInjectedInfo").includes("object"), "内联字面量是对象，应记录 object");
});

test("紧凑配置能真正派生出正确数量的 Block 并驱动输出", () => {
  const host = createMockHost();
  host.call.raw('xtoysBridgeInit({"p":{"nipple":["estim","vibrate","rotate"]},"s":-1});');
  assertEqual(host.call.raw("xthbBlocks.length"), 3, "nipple 应派生 3 个 Block");
  const accepted = host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "nipple", intensity: 45 }],
  }));
  assertEqual(accepted.ok, true, "应接受载荷");
  host.call.tick();
  assertEqual(host.V(VOL.estimNipple), 45, "estim 应输出");
  assertEqual(host.V(VOL.vibrateNipple), 45, "vibrate 应输出");
});

test("生成的 JSON 里初始化 customCode 内联了紧凑配置（不再依赖注入/变量）", () => {
  const script = JSON.parse(readFileSync(join(ROOT, "examples", "xtoys-minimal-3path.json"), "utf8"));
  const init = script.initialActions.find((a) => a.type === "customCode");
  assert(/^xtoysBridgeInit\(\{.*"p":\{/.test(init.code),
    `初始化代码应内联紧凑配置，实际：${init.code}`);
  assert(!init.variables || init.variables.length === 0,
    "不应再依赖 variables 注入（那条路在真机上会打坏内容）");
});

test("紧凑配置解析出的 Channel ID 与命名规范一致", () => {
  const host = createMockHost();
  host.call.raw('xtoysBridgeInit({"p":{"nipple":["estim","vibrate","rotate"]},"s":-1});');
  const ids = host.call.raw("xthbBlocks.map(function(b){return b.channel;}).join(',')");
  assert(ids.includes("part-estim-nipple"), `应有 part-estim-nipple，实际 ${ids}`);
  assert(ids.includes("part-vibrator-nipple"), `通道类型词应为 vibrator，实际 ${ids}`);
  assert(ids.includes("part-rotator-nipple"), `通道类型词应为 rotator，实际 ${ids}`);
});

test("初始化日志里的配置长度是真实序列化长度（不是 [object Object] 的 15）", () => {
  /*
   * 真机实测（2026-09-30）：日志显示"配置来源：object/15字符"，看起来像配置被截断，
   * 实际完全正常 —— 因为 String(普通对象) 在 XToys 里返回 "[object Object]"（15 字符）。
   * 诊断必须用 JSON.stringify 才能反映真实长度。
   */
  const host = createMockHost();
  host.call.raw('xtoysBridgeInit({"p":{"nipple":["estim","vibrate","rotate"]},"s":-1});');
  const info = host.call.raw("xthbInjectedInfo");
  const len = Number(/object\/(\d+)字符/.exec(info)[1]);
  assert(len > 30, `长度应是真实序列化长度，实际 ${len}（info=${info}）`);
  assert(!info.includes("/15字符"), `不得再出现 String(obj) 造成的 15，实际 ${info}`);
});

test("String(普通对象) 在本宿主里确实会得出 15 字符（说明为什么必须用 JSON.stringify）", () => {
  const host = createMockHost();
  const viaString = host.call.raw("String({a:1}).length");
  assertEqual(viaString, 15, "String({a:1}) 应为 '[object Object]' 的 15 字符");
});

/* ============================================================== 汇总 */

console.log(`\n${"-".repeat(64)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed > 0) {
  console.log("\n失败明细:");
  for (const f of failures) {
    console.log(`  - ${f.name}\n      ${f.message.split("\n").join("\n      ")}`);
  }
  process.exit(1);
}
console.log("运行时逻辑测试全部通过。");
console.log("注意：这是在 Node mock 宿主上验证逻辑，不代表任何真实设备行为；");
console.log("      Rotate-nipple 在真机上仍未验证（HANDOFF.md §8 阶段 0 / §9.1）。");
