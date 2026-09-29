#!/usr/bin/env node
/*
 * 运行时逻辑测试：在 Node 里用 mock 宿主 API 跑 src/xtoys-bridge.js。
 *
 * 这不是"覆盖每一个防御分支"的测试套件（HANDOFF.md §7.3 明确不要那种）。
 * 它只验证会被**证伪**的关键逻辑：
 *   - 协议解析与非法输入拒绝
 *   - sequence 严格递增（事件 + 基线各自）
 *   - 同槽竞争仲裁：priority -> 数值 -> sequence
 *   - 有限事件到期后回到基线（不是归零）
 *   - 值没变就不写变量 / 不启动 Job（防抖）
 *   - stop / stop_all / 停止函数 一定把所有输出写零
 *
 * 它**不能**替代真机验收（§9.1）：mock 只是"调用没抛异常"的模拟，
 * 不代表任何设备行为。旋转路径在真机上仍未验证。
 *
 * 用法：node tools/test-bridge-logic.mjs
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RUNTIME_SRC = join(ROOT, "src", "xtoys-bridge.js");

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
let failed = 0;
const failures = [];
let currentTest = "(none)";

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message ? err.message : String(err)}`);
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

function createMockHost() {
  const state = {
    variables: {},
    variableLog: [],
    jobsStarted: [],
    actions: [],
    logs: [],
  };
  const testDate = { current: 1000000 };

  const sandbox = {
    setVariable(name, value) {
      state.variables[name] = value;
      state.variableLog.push({ name, value });
    },
    getVariable(name) {
      return Object.prototype.hasOwnProperty.call(state.variables, name)
        ? state.variables[name]
        : null;
    },
    callAction(action) {
      state.actions.push(action);
      if (action && action.type === "updateJob" && action.action === "start") {
        state.jobsStarted.push(action.job);
      }
    },
    console: { log: (text) => state.logs.push(String(text)) },
    Date: { now: () => testDate.current },
    JSON,
    Object,
    Math,
  };
  sandbox.globalThis = sandbox;

  const context = createContext(sandbox);
  runInContext(readFileSync(RUNTIME_SRC, "utf8"), context, { filename: "xtoys-bridge.js" });

  /* 需要从 context 里调用的入口函数。 */
  const call = {
    init: () => runInContext("xtoysBridgeInit();", context),
    tick: () => runInContext("xtoysBridgeTick();", context),
    handle: (payload) => {
      context.__payload = payload;
      return runInContext("xtoysBridgeHandle(__payload);", context);
    },
    stopAll: () => runInContext("xtoysBridgeStopAll();", context),
  };

  function outputs() {
    return {
      estim: state.variables["xthb-estim-value"],
      frequency: state.variables["xthb-estim-frequency"],
      vibrator: state.variables["xthb-vibrator-value"],
      rotator: state.variables["xthb-rotator-value"],
      direction: state.variables["xthb-rotator-direction-code"],
    };
  }

  /* 每次 push 会把三个输出 Job 各启动一次；按 3 个一组切分。 */
  function pushCount() {
    return state.jobsStarted.length / 3;
  }

  function lastPush() {
    const n = state.jobsStarted.length;
    return n === 0 ? null : {
      jobs: state.jobsStarted.slice(n - 3, n),
    };
  }

  return { state, testDate, call, outputs, pushCount, lastPush };
}

const CONFIG = JSON.stringify({
  protocolVersion: 1,
  parts: [
    "mouth", "breast", "nipple", "armpit", "clitoris", "vulva",
    "vagina", "urethra", "anus", "butt", "penis", "prostate",
  ],
  channels: {
    estim: { intensity: "part-estim-a", frequency: "part-estim-a" },
    vibrator: { intensity: "part-vibrator-a" },
    rotator: { volume: "part-rotator-a", direction: "part-rotator-a" },
  },
  routing: { mode: "broadcast-intensity" },
});

/* 把内层协议对象包成 Webhook 外层载荷。 */
function envelope(inner) {
  return JSON.stringify({ action: "xtoys_game_bridge", payload: JSON.stringify(inner) });
}

/* 建一个已初始化、配置写好的宿主。 */
function bootHost() {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = CONFIG;
  host.call.init();
  return host;
}

/* ============================================================ 测试开始 */

console.log("XToys 触觉桥 — 运行时逻辑测试（mock 宿主，不代表设备行为）");

section("1. 初始化与安全边界");

test("初始化后所有输出变量为 0", () => {
  const host = bootHost();
  assertEqual(host.outputs(), { estim: 0, frequency: 0, vibrator: 0, rotator: 0, direction: 0 },
    "初始输出应全为 0");
});

test("未初始化状态下 handle 被拒绝而不是驱动输出", () => {
  const host = createMockHost();
  const result = host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  assertEqual(result.ok, false, "未初始化应返回 ok:false");
  assertEqual(host.state.jobsStarted.length, 0, "不应启动任何输出 Job");
});

test("配置非法时初始化失败且 tick 不驱动输出", () => {
  const host = createMockHost();
  host.state.variables["xthb-config-json"] = "{ not json";
  assertEqual(host.call.init(), "init_failed", "非法配置应返回 init_failed");
  host.call.tick();
  assertEqual(host.state.jobsStarted.length, 0, "配置非法时不应启动输出 Job");
});

test("运行时代码只引用允许的宿主 API（setVariable/getVariable/callAction/console）", () => {
  const source = readFileSync(RUNTIME_SRC, "utf8");
  const banned = [
    /setMax[A-Za-z]*\s*\(/,
    /maxIntensity/i,
    /maxRotate/i,
    /setMaxVolume/i,
    /setDevice/i,
    /eval\s*\(/,
    /\bnew\s+Function\s*\(/,
  ];
  for (const pattern of banned) {
    assert(!pattern.test(source), `源码命中禁止模式 ${pattern}`);
  }
});

section("2. 协议解析与拒绝");

test("外层 action 不是 xtoys_game_bridge 时拒绝", () => {
  const host = bootHost();
  const payload = JSON.stringify({ action: "something_else", payload: "{}" });
  assertEqual(host.call.handle(payload).ok, false, "错误外层 action 应被拒绝");
  assertEqual(host.pushCount(), 0, "拒绝的载荷不应驱动输出");
});

test("内层 payload 非合法 JSON 时返回 invalid_json", () => {
  const host = bootHost();
  const payload = JSON.stringify({ action: "xtoys_game_bridge", payload: "{ broken" });
  assertEqual(host.call.handle(payload), { ok: false, code: "invalid_json" }, "应返回 invalid_json");
});

test("protocolVersion 非 1 时拒绝", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({ protocolVersion: 2, command: "stop_all", source: "s" }));
  assertEqual(result.code, "unsupported_protocol_version", "应拒绝不支持的协议版本");
});

test("未知 command 时拒绝", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({ protocolVersion: 1, command: "nope", source: "s" }));
  assertEqual(result.code, "unsupported_command", "应拒绝未知命令");
});

test("缺少 source 时拒绝", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({ protocolVersion: 1, command: "stop_all" }));
  assertEqual(result.code, "missing_source", "应要求 source 非空");
});

test("未知 part 时整体拒绝，不部分写入", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "clitoris", intensity: 50, durationMs: 500 }, { part: "tentacle", intensity: 90, durationMs: 500 }],
  }));
  assertEqual(result.code, "invalid_targets", "未知 part 应导致整体拒绝");
  host.call.tick();
  assertEqual(host.outputs().estim, 0, "整体拒绝后不应有输出");
});

test("intensity 超出 0-100 时夹取", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "clitoris", intensity: 250, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 100, "intensity 应被夹到 100");
});

test("intensity 非有限数时拒绝", () => {
  const host = bootHost();
  for (const bad of ["50", null, true, {}, []] ) {
    const result = host.call.handle(envelope({
      protocolVersion: 1, command: "play", source: "s", eventId: "e" + String(bad), sequence: 1,
      targets: [{ part: "clitoris", intensity: bad, durationMs: 500 }],
    }));
    assertEqual(result.code, "invalid_targets", `intensity=${JSON.stringify(bad)} 应被拒绝`);
  }
});

test("play 缺 durationMs 或非正值时返回 invalid_duration", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "clitoris", intensity: 50 }],
  }));
  assertEqual(result.code, "invalid_duration", "缺少 durationMs 应被拒绝");
});

test("rotateSpeed > 0 缺少 rotateDirection 时拒绝", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "vagina", rotateSpeed: 60, durationMs: 1000 }],
  }));
  assertEqual(result.code, "invalid_targets", "旋转必须显式给方向");
});

test("stop 没有任何选择器时返回 missing_stop_selector", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({ protocolVersion: 1, command: "stop", source: "s" }));
  assertEqual(result.code, "missing_stop_selector", "无选择器的 stop 应被拒绝");
});

test("test 命令只校验不驱动硬件", () => {
  const host = bootHost();
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "test", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 50 }],
  }));
  assertEqual(result, { ok: true, code: "validated" }, "test 应返回 validated");
  host.call.tick();
  assertEqual(host.outputs().estim, 0, "test 不得驱动输出");
  assertEqual(host.pushCount(), 0, "test 不得启动输出 Job");
});

section("3. 基线与有限事件");

test("set_baseline 产生持续输出（estim + vibrator 广播）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 25, frequency: 20 }],
  }));
  host.call.tick();
  const out = host.outputs();
  assertEqual(out.estim, 25, "estim 应为基线值");
  assertEqual(out.frequency, 20, "频率应跟随同一意图");
  assertEqual(out.vibrator, 25, "vibrator 按广播规则同样输出");
  assertEqual(out.rotator, 0, "基线不驱动旋转通道");
});

test("基线是完整快照：新快照遗漏的部位被清除", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 40 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 40, "第一次基线应生效");
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 2,
    targets: [{ part: "vagina", intensity: 10 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 10, "clitoris 应被新快照清除，只剩 vagina");
});

test("空 targets 的 set_baseline 清空基线", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 40 }],
  }));
  host.call.tick();
  host.call.handle(envelope({ protocolVersion: 1, command: "set_baseline", source: "s", sequence: 2, targets: [] }));
  host.call.tick();
  assertEqual(host.outputs().estim, 0, "空快照应清空基线输出");
});

test("play 在基线上瞬态叠加，到期后回到基线而不是归零", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 20 }],
  }));
  host.call.tick();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "hit-1", sequence: 1,
    targets: [{ part: "clitoris", intensity: 80, durationMs: 300 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 80, "play 期间应取更高的瞬态值");

  host.testDate.current += 400;
  host.call.tick();
  assertEqual(host.outputs().estim, 20, "到期后应回到基线 20，而不是 0");
  assertEqual(host.outputs().vibrator, 20, "vibrator 同样回到基线");
});

test("play 与 update 用同一身份：只有更大的 sequence 才生效", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 5,
    targets: [{ part: "clitoris", intensity: 30, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 30, "首个事件应生效");

  const stale = host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "e1", sequence: 5,
    targets: [{ part: "clitoris", intensity: 90, durationMs: 60000 }],
  }));
  assertEqual(stale.code, "invalid_sequence", "相同 sequence 应被忽略");
  host.call.tick();
  assertEqual(host.outputs().estim, 30, "被忽略的更新不得改变输出");

  host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "e1", sequence: 6,
    targets: [{ part: "clitoris", intensity: 90, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 90, "更大的 sequence 应替换整个目标集");
});

test("不同 source 可用相同 eventId 且互不影响", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "a", eventId: "hit", sequence: 1,
    targets: [{ part: "clitoris", intensity: 30, durationMs: 60000 }],
  }));
  const result = host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "b", eventId: "hit", sequence: 1,
    targets: [{ part: "clitoris", intensity: 70, durationMs: 60000 }],
  }));
  assertEqual(result.ok, true, "不同 source 的同名 eventId 不应冲突");
  host.call.tick();
  assertEqual(host.outputs().estim, 70, "应取更高的值");
});

test("基线序号栅栏在 stop_all 后保留，必须继续递增", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 7,
    targets: [{ part: "clitoris", intensity: 30 }],
  }));
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  const stale = host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 7,
    targets: [{ part: "clitoris", intensity: 30 }],
  }));
  assertEqual(stale.code, "invalid_sequence", "停机后相同序号应被拒绝");
  const fresh = host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 8,
    targets: [{ part: "clitoris", intensity: 30 }],
  }));
  assertEqual(fresh.ok, true, "更大序号应被接受");
});

section("4. 同槽竞争仲裁");

test("priority 大者胜，即使数值更小", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "weak", sequence: 1,
    targets: [{ part: "clitoris", intensity: 90, durationMs: 60000, priority: 1 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "strong", sequence: 2,
    targets: [{ part: "vagina", intensity: 10, durationMs: 60000, priority: 5 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 10, "priority 5 应压过 priority 1 的更高数值");
});

test("priority 相同时数值大者胜", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "a", sequence: 9,
    targets: [{ part: "clitoris", intensity: 30, durationMs: 60000, priority: 2 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "b", sequence: 1,
    targets: [{ part: "vagina", intensity: 60, durationMs: 60000, priority: 2 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 60, "同 priority 应取更大数值，与 sequence 无关");
});

test("priority 与数值都相同时 sequence 大者胜", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "old", sequence: 1,
    targets: [{ part: "clitoris", intensity: 50, durationMs: 60000 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "new", sequence: 2,
    targets: [{ part: "vagina", intensity: 50, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 50, "值相同时输出仍为 50");
  /* 用 stop 移除序列更大的那个，剩下的仍应保持 50，证明两者都在参与仲裁。 */
  host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s", eventId: "new",
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 50, "移除新事件后旧事件应接管");
});

test("基线（priority 0）会被高优先级的有限事件压过", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 30 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "hit", sequence: 2,
    targets: [{ part: "vagina", intensity: 95, durationMs: 60000, priority: 10 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 95, "高优先级瞬态应压过基线");
});

section("5. 旋转路径");

test("rotateSpeed 与显式方向写入旋转变量，且不驱动强度通道", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "drill", sequence: 1,
    targets: [{ part: "vagina", rotateSpeed: 60, rotateDirection: "counterclockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  const out = host.outputs();
  assertEqual(out.rotator, 60, "旋转速度应写入旋转变量");
  assertEqual(out.direction, -1, "counterclockwise 应编码为 -1");
  assertEqual(out.estim, 0, "rotateSpeed 不得推导出强度");
  assertEqual(out.vibrator, 0, "rotateSpeed 不得推导出振动强度");
});

test("旋转不会自动反向：必须显式发新的方向", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "d", sequence: 1,
    targets: [{ part: "vagina", rotateSpeed: 50, rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().direction, 1, "初始方向应为顺时针");
  host.call.handle(envelope({
    protocolVersion: 1, command: "update", source: "s", eventId: "d", sequence: 2,
    targets: [{ part: "vagina", rotateSpeed: 50, rotateDirection: "counterclockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().direction, -1, "显式 update 后方向应改变");
});

test("rotateDirection 大小写归一化", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "d", sequence: 1,
    targets: [{ part: "vagina", rotateSpeed: 50, rotateDirection: "ClockWise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().direction, 1, "大小写不敏感，应归一化为顺时针");
});

section("6. 停止与归零");

test("stop 只移除列出的部位", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [
      { part: "clitoris", intensity: 80, durationMs: 60000 },
      { part: "vagina", intensity: 40, durationMs: 60000 },
    ],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 80, "两个目标都在时取较大值");
  host.call.handle(envelope({
    protocolVersion: 1, command: "stop", source: "s", eventId: "e1",
    targets: [{ part: "clitoris" }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 40, "移除 clitoris 后应回落到 vagina 的 40");
});

test("stop 只给 eventId 时移除整个事件，回到基线", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 15 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e1", sequence: 1,
    targets: [{ part: "clitoris", intensity: 90, durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.outputs().estim, 90, "事件期间为 90");
  host.call.handle(envelope({ protocolVersion: 1, command: "stop", source: "s", eventId: "e1" }));
  host.call.tick();
  assertEqual(host.outputs().estim, 15, "停止事件后应回到基线 15");
});

test("stop_all 把所有输出写零并把归零推给输出 Job", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 70, frequency: 50 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "r", sequence: 1,
    targets: [{ part: "vagina", rotateSpeed: 55, rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assert(host.outputs().estim === 70 && host.outputs().rotator === 55, "停机前应有非零输出");

  const before = host.pushCount();
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  assertEqual(host.outputs(), { estim: 0, frequency: 0, vibrator: 0, rotator: 0, direction: 0 },
    "stop_all 应把全部输出变量写零");
  assert(host.pushCount() > before, "stop_all 应把归零推给输出 Job（否则设备可能留在旧值）");
});

test("stop_all 之后 tick 不会恢复任何输出", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "clitoris", intensity: 80, durationMs: 60000 }],
  }));
  host.call.tick();
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  host.call.tick();
  host.call.tick();
  assertEqual(host.outputs(), { estim: 0, frequency: 0, vibrator: 0, rotator: 0, direction: 0 },
    "stop_all 后持续 tick 应保持全零");
});

test("脚本停止函数把所有输出写零（Final Actions 的 JS 部分）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "clitoris", intensity: 80, frequency: 60, durationMs: 60000 }],
  }));
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "r", sequence: 1,
    targets: [{ part: "vagina", rotateSpeed: 70, rotateDirection: "clockwise", durationMs: 60000 }],
  }));
  host.call.tick();
  assertEqual(host.call.stopAll(), "stopped", "停止函数应返回 stopped");
  assertEqual(host.outputs(), { estim: 0, frequency: 0, vibrator: 0, rotator: 0, direction: 0 },
    "停止后所有输出变量必须为 0");
});

section("7. 防抖（唯一的优化）");

test("值没变时重复 tick 不再写变量、不再启动 Job", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 33 }],
  }));
  host.call.tick();
  const first = host.pushCount();
  host.call.tick();
  host.call.tick();
  host.call.tick();
  assertEqual(host.pushCount(), first, "值未变化时不得重复推送");
});

test("值变化时才推送一次", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 1,
    targets: [{ part: "clitoris", intensity: 33 }],
  }));
  host.call.tick();
  const afterFirst = host.pushCount();
  host.call.handle(envelope({
    protocolVersion: 1, command: "set_baseline", source: "s", sequence: 2,
    targets: [{ part: "clitoris", intensity: 44 }],
  }));
  host.call.tick();
  assertEqual(host.pushCount(), afterFirst + 1, "值变化应恰好推送一次");
});

test("到期归零也会推送（否则设备会粘在旧值）", () => {
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "clitoris", intensity: 80, durationMs: 200 }],
  }));
  host.call.tick();
  const during = host.pushCount();
  host.testDate.current += 500;
  host.call.tick();
  assertEqual(host.outputs().estim, 0, "到期后应归零");
  assertEqual(host.pushCount(), during + 1, "归零必须推送一次，不能只在内存里归零");
});

section("8. 诊断变量措辞（§3.4）");

test("写入的变量名与日志不声称设备已确认", () => {
  const banned = ["已确认", "已下发", "已送达", "confirmed", "acked"];
  const host = bootHost();
  host.call.handle(envelope({
    protocolVersion: 1, command: "play", source: "s", eventId: "e", sequence: 1,
    targets: [{ part: "clitoris", intensity: 80, durationMs: 1000 }],
  }));
  host.call.tick();
  host.call.handle(envelope({ protocolVersion: 1, command: "stop_all", source: "s" }));
  const haystack = host.state.logs.join("\n") + "\n" + Object.keys(host.state.variables).join("\n");
  for (const word of banned) {
    assert(!haystack.includes(word), `日志/变量名出现禁止措辞「${word}」`);
  }
});

/* ============================================================ 汇总 */

console.log(`\n${"-".repeat(60)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed > 0) {
  console.log("\n失败明细:");
  for (const f of failures) {
    console.log(`  - ${f.name}\n      ${f.message}`);
  }
  process.exit(1);
}
console.log("运行时逻辑测试全部通过。");
console.log("注意：这是在 Node mock 宿主上验证逻辑，不代表任何真实设备行为；");
console.log("      旋转路径在真机上仍未验证（HANDOFF.md §8 阶段 0 / §9.1）。");
