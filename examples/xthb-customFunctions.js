/*
 * XToys 触觉桥 — 最小接收端运行时（阶段 0）
 * =====================================================================
 * 这是被 tools/build-xtoys-script.mjs 嵌入到 Script JSON 的 customFunctions
 * 字段里的全局 JavaScript 源码。它运行在 XToys 的 JS-Interpreter 中。
 *
 * 硬约束（HANDOFF.md §3.1 / §3.2）：
 *   - 只能用 ES5：var + function，禁止 let/const/=>/class/async/await/
 *     模板字符串/解构/展开。tools/check-es5-subset.mjs 会强制检查。
 *   - 只写"当前输出值"（setVolume/setFrequency/setMode/setDirection）。
 *     本文件绝不调用任何设置设备最大强度或最大旋转速度的接口。
 *   - 同步返回 != 设备确认（HANDOFF.md §3.4）。日志与变量名只说
 *     "XToys 调用未抛异常"，不得出现"已确认""已下发成功"之类措辞。
 *
 * 设计（HANDOFF.md §7.2）：一份最新意图 + 一个 100 ms tick + 值没变就跳过。
 * 不做 generation、不做重试队列、不做重同步、不做容量上限系统。
 *
 * 协议实现范围：play / update / stop / set_baseline / stop_all / test
 * 正式参考：docs/02-webhook-protocol.md
 */

/* =====================================================================
 * 1. 宿主 API 引用（XToys 提供；本地测试工具会注入同名 mock）
 * ===================================================================== */

var XTHB_setVariable = setVariable;
var XTHB_getVariable = getVariable;
var XTHB_callAction = callAction;

/* =====================================================================
 * 2. 常量与运行期状态
 * ===================================================================== */

var XTHB_PROTOCOL_VERSION = 1;

var XTHB_CMD_PLAY = "play";
var XTHB_CMD_UPDATE = "update";
var XTHB_CMD_STOP = "stop";
var XTHB_CMD_SET_BASELINE = "set_baseline";
var XTHB_CMD_STOP_ALL = "stop_all";
var XTHB_CMD_TEST = "test";

var XTHB_DIR_CLOCKWISE = "clockwise";
var XTHB_DIR_COUNTERCLOCKWISE = "counterclockwise";

/* 有界校验门（HANDOFF.md §7.3：不做容量上限系统，只保留解析边界）。
 * 这些是"拒绝畸形输入"的门槛，不是需要精细维护的运行时状态。 */
var XTHB_MAX_PAYLOAD_CHARS = 16384;
var XTHB_MAX_TARGETS = 16;
var XTHB_MAX_ID_CHARS = 64;
var XTHB_MAX_DURATION_MS = 600000;
var XTHB_MAX_EVENTS = 64;

/* 键名刻意加 xthb- 前缀，避免与用户自己建的变量重名。 */
var XTHB_VAR_CONFIG = "xthb-config-json";

var XTHB_CH_ESTIM = "estim";
var XTHB_CH_VIBRATOR = "vibrator";
var XTHB_CH_ROTATOR = "rotator";

var XTHB_OUT_ESTIM = "xthb-output-estim";
var XTHB_OUT_VIBRATOR = "xthb-output-vibrator";
var XTHB_OUT_ROTATOR = "xthb-output-rotator";

/* 已初始化的配置（解析自 xthb-config-json）。 */
var xthbConfig = null;

/* 有限事件表：source+eventId -> 事件对象。 */
var xthbEvents = {};

/* 基线快照：source -> { sequence: number, parts: { part -> 意图 } }。 */
var xthbBaselines = {};

/* 每个 source 的基线序号栅栏。stop_all 清状态但保留栅栏（协议 §2）。 */
var xthbBaselineSeq = {};

/* 上次写进变量的输出值。值没变就不写、不启动 Job（唯一的优化）。 */
var xthbWritten = null;

/* 值归零时是否还启动一次输出 Job（用于把归零真正推给设备）。 */
var xthbForceWrite = false;

/* 运行期诊断计数（只在日志里用，措辞必须遵守 §3.4）。 */
var xthbTicks = 0;
var xthbCallsOK = 0;
var xthbRejected = 0;
var xthbLastError = "";

/* =====================================================================
 * 3. 小工具（全部 ES5）
 * ===================================================================== */

function xthbNowMs() {
  if (typeof Date === "undefined") {
    return 0;
  }
  if (typeof Date.now === "function") {
    return Date.now();
  }
  return new Date().getTime();
}

function xthbLog(text) {
  /* console.log 在 XToys 里可能不存在或被禁用，必须包住（§6）。 */
  try {
    if (typeof console !== "undefined" && console && console.log) {
      console.log("[xthb] " + text);
    }
  } catch (logErr) {
    /* 日志失败不影响业务；不写入任何硬件状态。 */
  }
}

function xthbSetVar(name, value) {
  return XTHB_setVariable(name, value);
}

function xthbStartJob(jobName) {
  return XTHB_callAction({ type: "updateJob", job: jobName, action: "start" });
}

function xthbIsFiniteNumber(value) {
  if (typeof value !== "number") {
    return false;
  }
  if (value !== value) {
    return false;
  }
  if (value === Infinity || value === -Infinity) {
    return false;
  }
  return true;
}

function xthbClamp(value, low, high) {
  if (value < low) {
    return low;
  }
  if (value > high) {
    return high;
  }
  return value;
}

function xthbRequireNumber(value, low, high) {
  if (!xthbIsFiniteNumber(value)) {
    return null;
  }
  return xthbClamp(value, low, high);
}

function xthbIsNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function xthbIsArray(value) {
  return typeof value === "object" && value !== null &&
    typeof value.length === "number" && typeof value.push === "function";
}

function xthbHasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function xthbCanonicalDirection(value) {
  var lowered;
  if (!xthbIsNonEmptyString(value)) {
    return null;
  }
  lowered = value.toLowerCase();
  if (lowered === "clockwise") {
    return XTHB_DIR_CLOCKWISE;
  }
  if (lowered === "counterclockwise") {
    return XTHB_DIR_COUNTERCLOCKWISE;
  }
  return null;
}

function xthbFail(code, detail) {
  var message = detail ? code + ": " + detail : code;
  xthbRejected = xthbRejected + 1;
  xthbLastError = message;
  xthbLog("rejected " + message);
  return { ok: false, code: code };
}

/* =====================================================================
 * 4. 配置
 * ===================================================================== */

/*
 * 配置 JSON（由 Initial Actions 写入 xthb-config-json）：
 *
 *   {
 *     "protocolVersion": 1,
 *     "parts": ["clitoris", "vagina", ...],          // 允许的逻辑部位
 *     "channels": {
 *       "estim":    { "intensity": "part-estim-a",    "frequency": "part-estim-a" },
 *       "vibrator": { "intensity": "part-vibrator-a" },
 *       "rotator":  { "volume": "part-rotator-a", "direction": "part-rotator-a" }
 *     },
 *     "routing": { "mode": "broadcast-intensity" }
 *   }
 *
 * 关于 routing.mode：
 *   HANDOFF.md §8 阶段 0 只做 3 条输出路径，而协议有 12 个逻辑叶子部位。
 *   本阶段采用「全部部位广播给所有强度/振动通道」的临时规则：
 *   任何部位的强度意图都会同时参与 estim 与 vibrator 两个通道的仲裁，
 *   旋转通道只接受显式 rotateSpeed（协议 §3：旋转不从 intensity 推导）。
 *   part -> 通道的正式映射规则留到下一轮协议讨论时替换 xthbChannelMapFor()。
 */

function xthbParseConfig() {
  var raw = XTHB_getVariable(XTHB_VAR_CONFIG);
  var parsed;
  var parts = [];
  var index;

  if (!xthbIsNonEmptyString(raw)) {
    return xthbFail("invalid_config", XTHB_VAR_CONFIG + " 未设置或非字符串");
  }
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    return xthbFail("invalid_config", "配置不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return xthbFail("invalid_config", "配置不是对象");
  }
  if (parsed.protocolVersion !== XTHB_PROTOCOL_VERSION) {
    return xthbFail("invalid_config", "配置 protocolVersion 不受支持");
  }
  if (!xthbIsArray(parsed.parts) || parsed.parts.length === 0) {
    return xthbFail("invalid_config", "配置缺少 parts 列表");
  }
  for (index = 0; index < parsed.parts.length; index = index + 1) {
    if (!xthbIsNonEmptyString(parsed.parts[index])) {
      return xthbFail("invalid_config", "parts 含非字符串项");
    }
    parts.push(parsed.parts[index]);
  }
  if (typeof parsed.channels !== "object" || parsed.channels === null) {
    return xthbFail("invalid_config", "配置缺少 channels");
  }
  parsed.parts = parts;
  return { ok: true, config: parsed };
}

function xthbPartAllowed(part) {
  var index;
  for (index = 0; index < xthbConfig.parts.length; index = index + 1) {
    if (xthbConfig.parts[index] === part) {
      return true;
    }
  }
  return false;
}

/* 阶段 0 的临时映射规则。下一轮换映射时只改这一个函数。 */
function xthbChannelMapFor(part, channel) {
  var spec = xthbConfig.channels[channel];
  if (!spec || typeof spec !== "object") {
    return false;
  }
  if (channel === XTHB_CH_ROTATOR) {
    /* 旋转通道只由显式 rotateSpeed 驱动。 */
    return true;
  }
  if (!spec.intensity) {
    return false;
  }
  return xthbSpecAllowsPart(spec, part);
}

/*
 * 通道可按 parts 字段限定接受哪些部位；缺省 = 接受全部（广播）。
 * 例：{ "intensity": "part-estim-a", "parts": ["clitoris", "anus"] }
 */
function xthbSpecAllowsPart(spec, part) {
  var index;
  if (!xthbIsArray(spec.parts) || spec.parts.length === 0) {
    return true;
  }
  for (index = 0; index < spec.parts.length; index = index + 1) {
    if (spec.parts[index] === part) {
      return true;
    }
  }
  return false;
}

/* =====================================================================
 * 5. targets 解析与校验
 * ===================================================================== */

function xthbParseTarget(raw, index) {
  var target = {};
  var value;

  if (typeof raw !== "object" || raw === null || xthbIsArray(raw)) {
    return { error: "targets[" + index + "] 不是对象" };
  }
  if (!xthbIsNonEmptyString(raw.part)) {
    return { error: "targets[" + index + "].part 缺失" };
  }
  target.part = raw.part;
  if (!xthbPartAllowed(target.part)) {
    return { error: "unknown_part " + target.part };
  }

  /* intensity / frequency：字段缺失 = 不驱动该槽；存在则必须是有限数。 */
  if (xthbHasOwn(raw, "intensity") && raw.intensity !== null) {
    value = xthbRequireNumber(raw.intensity, 0, 100);
    if (value === null) {
      return { error: "targets[" + index + "].intensity 非法" };
    }
    target.intensity = value;
  }
  if (xthbHasOwn(raw, "frequency") && raw.frequency !== null) {
    value = xthbRequireNumber(raw.frequency, 0, 100);
    if (value === null) {
      return { error: "targets[" + index + "].frequency 非法" };
    }
    target.frequency = value;
  }

  /* rotateSpeed / rotateDirection：旋转槽，绝不由 intensity 推导。 */
  if (xthbHasOwn(raw, "rotateSpeed") && raw.rotateSpeed !== null) {
    value = xthbRequireNumber(raw.rotateSpeed, 0, 100);
    if (value === null) {
      return { error: "targets[" + index + "].rotateSpeed 非法" };
    }
    target.rotateSpeed = value;
  }
  if (xthbHasOwn(raw, "rotateDirection") && raw.rotateDirection !== null) {
    target.rotateDirection = xthbCanonicalDirection(raw.rotateDirection);
    if (target.rotateDirection === null) {
      return { error: "invalid_rotate_direction" };
    }
  }
  if (xthbHasOwn(raw, "rotateSpeed") && raw.rotateSpeed > 0) {
    if (!target.rotateDirection) {
      return { error: "rotateSpeed > 0 时必须有 rotateDirection" };
    }
  }

  /* 有限事件字段。 */
  if (xthbHasOwn(raw, "durationMs") && raw.durationMs !== null) {
    value = xthbRequireNumber(raw.durationMs, 0, XTHB_MAX_DURATION_MS);
    if (value === null) {
      return { error: "targets[" + index + "].durationMs 非法" };
    }
    target.durationMs = value;
  }
  if (xthbHasOwn(raw, "rampUpMs") && raw.rampUpMs !== null) {
    value = xthbRequireNumber(raw.rampUpMs, 0, XTHB_MAX_DURATION_MS);
    if (value === null) {
      return { error: "targets[" + index + "].rampUpMs 非法" };
    }
    target.rampUpMs = value;
  }
  if (xthbHasOwn(raw, "rampDownMs") && raw.rampDownMs !== null) {
    value = xthbRequireNumber(raw.rampDownMs, 0, XTHB_MAX_DURATION_MS);
    if (value === null) {
      return { error: "targets[" + index + "].rampDownMs 非法" };
    }
    target.rampDownMs = value;
  }
  if (xthbHasOwn(raw, "priority") && raw.priority !== null) {
    value = xthbRequireNumber(raw.priority, -1000000, 1000000);
    if (value === null) {
      return { error: "targets[" + index + "].priority 非法" };
    }
    target.priority = value;
  }

  return { target: target };
}

function xthbParseTargets(raw) {
  var out = [];
  var parsed;
  var index;

  if (!xthbIsArray(raw)) {
    return { error: "targets 不是数组" };
  }
  if (raw.length > XTHB_MAX_TARGETS) {
    return { error: "targets 超过 " + XTHB_MAX_TARGETS + " 条" };
  }
  for (index = 0; index < raw.length; index = index + 1) {
    parsed = xthbParseTarget(raw[index], index);
    if (parsed.error) {
      return { error: parsed.error };
    }
    out.push(parsed.target);
  }
  return { targets: out };
}

/* 把 targets 转成 part -> 意图 的表；同一 part 出现多次时后者覆盖前者。 */
function xthbTargetsToParts(targets) {
  var map = {};
  var index;
  for (index = 0; index < targets.length; index = index + 1) {
    map[targets[index].part] = targets[index];
  }
  return map;
}

/* =====================================================================
 * 6. 有限事件与基线
 * ===================================================================== */

function xthbEventKey(source, eventId) {
  return source + "\u0000" + eventId;
}

function xthbCountEvents() {
  var total = 0;
  var key;
  for (key in xthbEvents) {
    if (xthbHasOwn(xthbEvents, key)) {
      total = total + 1;
    }
  }
  return total;
}

function xthbRemoveEvent(source, eventId) {
  var key = xthbEventKey(source, eventId);
  if (xthbHasOwn(xthbEvents, key)) {
    delete xthbEvents[key];
  }
}

function xthbApplyPlay(source, eventId, sequence, parts, finishAtMs) {
  var key = xthbEventKey(source, eventId);
  var existing = xthbHasOwn(xthbEvents, key) ? xthbEvents[key] : null;

  /* 身份 = source + eventId；只有严格更大的 sequence 才替换（协议 §2）。 */
  if (existing && sequence <= existing.sequence) {
    return { error: "invalid_sequence" };
  }
  if (!existing && xthbCountEvents() >= XTHB_MAX_EVENTS) {
    return { error: "state_capacity_exceeded" };
  }
  xthbEvents[key] = {
    source: source,
    eventId: eventId,
    sequence: sequence,
    parts: parts,
    finishAtMs: finishAtMs
  };
  return { ok: true };
}

function xthbApplyStop(source, eventId, parts) {
  var key;
  var event;
  var partNames;
  var index;
  var removed = 0;

  /* 形式 1：只给 eventId —— 移除整个事件。 */
  if (eventId !== null && parts === null) {
    if (!xthbHasOwn(xthbEvents, xthbEventKey(source, eventId))) {
      return { error: "missing_stop_selector" };
    }
    xthbRemoveEvent(source, eventId);
    return { ok: true };
  }

  if (parts === null) {
    return { error: "missing_stop_selector" };
  }

  /* 形式 2：eventId + targets —— 只移除该事件里列出的部位。 */
  if (eventId !== null) {
    key = xthbEventKey(source, eventId);
    if (!xthbHasOwn(xthbEvents, key)) {
      return { error: "missing_stop_selector" };
    }
    event = xthbEvents[key];
    partNames = xthbPartNames(parts);
    for (index = 0; index < partNames.length; index = index + 1) {
      if (xthbHasOwn(event.parts, partNames[index])) {
        delete event.parts[partNames[index]];
        removed = removed + 1;
      }
    }
    /* 没有剩余部位的事件直接丢弃，避免留下空壳。 */
    if (xthbCountParts(event.parts) === 0) {
      xthbRemoveEvent(source, eventId);
    }
    return { ok: true };
  }

  /* 形式 3：只给 targets —— 移除该来源所有事件里的这些部位。 */
  partNames = xthbPartNames(parts);
  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    event = xthbEvents[key];
    if (event.source !== source) {
      continue;
    }
    for (index = 0; index < partNames.length; index = index + 1) {
      if (xthbHasOwn(event.parts, partNames[index])) {
        delete event.parts[partNames[index]];
        removed = removed + 1;
      }
    }
    if (xthbCountParts(event.parts) === 0) {
      delete xthbEvents[key];
    }
  }
  if (removed === 0) {
    return { error: "missing_stop_selector" };
  }
  return { ok: true };
}

function xthbPartNames(parts) {
  var names = [];
  var key;
  for (key in parts) {
    if (xthbHasOwn(parts, key)) {
      names.push(key);
    }
  }
  return names;
}

function xthbCountParts(parts) {
  var total = 0;
  var key;
  for (key in parts) {
    if (xthbHasOwn(parts, key)) {
      total = total + 1;
    }
  }
  return total;
}

function xthbApplyBaseline(source, sequence, parts) {
  if (xthbHasOwn(xthbBaselineSeq, source) && sequence <= xthbBaselineSeq[source]) {
    return { error: "invalid_sequence" };
  }
  /* 基线是完整快照：新的 set_baseline 替换旧快照，遗漏的部位被清除（§2）。 */
  xthbBaselines[source] = { sequence: sequence, parts: parts };
  xthbBaselineSeq[source] = sequence;
  return { ok: true };
}

/* =====================================================================
 * 7. 仲裁：算出每个通道当前应该输出什么
 * ===================================================================== */

/*
 * 竞争规则（HANDOFF.md §7.2 / §12「同槽多事件竞争」）：
 *   1. priority 大者胜
 *   2. 相同 priority 时数值大者胜
 *   3. 再相同则 sequence 大者胜（更近的意图更贴合当前局面）
 * 基线参与者 priority 视为 0、sequence 用该来源的基线序号。
 */
function xthbPickBetter(candidate, incumbent) {
  if (incumbent === null) {
    return true;
  }
  if (candidate.priority !== incumbent.priority) {
    return candidate.priority > incumbent.priority;
  }
  if (candidate.value !== incumbent.value) {
    return candidate.value > incumbent.value;
  }
  return candidate.sequence > incumbent.sequence;
}

function xthbCollectCandidates(metric, channel) {
  var candidates = [];
  var key;
  var event;
  var source;
  var partNames;
  var index;
  var intent;
  var raw;

  /* 所有来源的基线快照。 */
  for (source in xthbBaselines) {
    if (!xthbHasOwn(xthbBaselines, source)) {
      continue;
    }
    partNames = xthbPartNames(xthbBaselines[source].parts);
    for (index = 0; index < partNames.length; index = index + 1) {
      intent = xthbBaselines[source].parts[partNames[index]];
      raw = xthbMetricValue(intent, metric);
      if (raw === null) {
        continue;
      }
      if (!xthbChannelMapFor(partNames[index], channel)) {
        continue;
      }
      candidates.push({
        value: raw,
        priority: xthbIntentPriority(intent),
        sequence: xthbBaselines[source].sequence,
        source: source,
        part: partNames[index],
        intent: intent
      });
    }
  }

  /* 所有未到期的有限事件。 */
  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    event = xthbEvents[key];
    partNames = xthbPartNames(event.parts);
    for (index = 0; index < partNames.length; index = index + 1) {
      intent = event.parts[partNames[index]];
      raw = xthbMetricValue(intent, metric);
      if (raw === null) {
        continue;
      }
      if (!xthbChannelMapFor(partNames[index], channel)) {
        continue;
      }
      candidates.push({
        value: raw,
        priority: xthbIntentPriority(intent),
        sequence: event.sequence,
        source: event.source,
        part: partNames[index],
        intent: intent
      });
    }
  }
  return candidates;
}

function xthbIntentPriority(intent) {
  if (xthbIsFiniteNumber(intent.priority)) {
    return intent.priority;
  }
  return 0;
}

function xthbMetricValue(intent, metric) {
  if (metric === "intensity") {
    if (xthbIsFiniteNumber(intent.intensity)) {
      return intent.intensity;
    }
    return null;
  }
  if (metric === "frequency") {
    if (xthbIsFiniteNumber(intent.frequency)) {
      return intent.frequency;
    }
    return null;
  }
  if (metric === "rotateSpeed") {
    if (xthbIsFiniteNumber(intent.rotateSpeed)) {
      return intent.rotateSpeed;
    }
    return null;
  }
  return null;
}

function xthbArbitrate(metric, channel) {
  var candidates = xthbCollectCandidates(metric, channel);
  var winner = null;
  var index;
  for (index = 0; index < candidates.length; index = index + 1) {
    if (xthbPickBetter(candidates[index], winner)) {
      winner = candidates[index];
    }
  }
  return winner;
}

/* 各通道的当前应输出值。 */
function xthbComputeOutputs() {
  var estim = xthbArbitrate("intensity", XTHB_CH_ESTIM);
  var vibrator = xthbArbitrate("intensity", XTHB_CH_VIBRATOR);
  var rotator = xthbArbitrate("rotateSpeed", XTHB_CH_ROTATOR);
  var frequency;
  var out = {};

  /*
   * 阶段 0 的广播规则：estim 与 vibrator 各自做一次仲裁。当前映射下两者
   * 接受同一批部位，所以结果相同；一旦开始在配置里按 parts 限定通道，
   * 两条通道就会自然分叉，不需要改这里。
   */
  out.estim = xthbChannelOutput(estim, XTHB_CH_ESTIM);
  out.vibrator = xthbChannelOutput(vibrator, XTHB_CH_VIBRATOR);
  out.rotator = xthbChannelOutput(rotator, XTHB_CH_ROTATOR);

  /*
   * 频率跟随 estim 通道的强度赢家（同一个意图的两个槽），而不是独立再仲裁
   * 一次 —— 否则频率可能来自另一个部位的事件，与正被驱动的位置不一致。
   */
  if (estim !== null && xthbIsFiniteNumber(estim.intent.frequency)) {
    frequency = estim.intent.frequency;
  } else {
    frequency = 0;
  }
  out.estim.frequency = frequency;
  return out;
}

function xthbChannelOutput(winner, channel) {
  var spec = xthbConfig.channels[channel];
  var value = 0;
  var direction = 0;
  var rampSeconds = 0;

  if (!spec || typeof spec !== "object") {
    return null;
  }
  if (winner === null) {
    return {
      value: 0,
      direction: 0,
      rampSeconds: 0,
      source: "",
      part: "",
      sequence: -1
    };
  }
  if (channel === XTHB_CH_ROTATOR) {
    value = winner.value;
    if (winner.intent.rotateDirection === XTHB_DIR_CLOCKWISE) {
      direction = 1;
    } else if (winner.intent.rotateDirection === XTHB_DIR_COUNTERCLOCKWISE) {
      direction = -1;
    }
  } else {
    value = winner.value;
  }
  rampSeconds = xthbRampSeconds(winner.intent, value);
  return {
    value: value,
    direction: direction,
    rampSeconds: rampSeconds,
    source: winner.source,
    part: winner.part,
    sequence: winner.sequence
  };
}

/*
 * rampTime 的单位在 docs/01-xtoys-script-format.md §4.2 仍标 ⚠️未独立验证
 * （变量名 "ramp-seconds" 暗示为秒）。这里统一按"秒"输出，真机验收时
 * 专门验一次；若不是秒，只改这一个函数。
 */
function xthbRampSeconds(intent, value) {
  var ms = 0;
  if (value <= 0) {
    if (xthbIsFiniteNumber(intent.rampDownMs)) {
      ms = intent.rampDownMs;
    }
  } else if (xthbIsFiniteNumber(intent.rampUpMs)) {
    ms = intent.rampUpMs;
  }
  if (ms < 0) {
    ms = 0;
  }
  return ms / 1000;
}

/* =====================================================================
 * 8. 推给硬件：写变量 + 启动输出 Job
 * ===================================================================== */

function xthbOutputsEqual(a, b) {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.estim.value !== b.estim.value) { return false; }
  if (a.estim.frequency !== b.estim.frequency) { return false; }
  if (a.vibrator.value !== b.vibrator.value) { return false; }
  if (a.rotator.value !== b.rotator.value) { return false; }
  if (a.rotator.direction !== b.rotator.direction) { return false; }
  return true;
}

function xthbPushOutputs(outputs) {
  var changed = !xthbOutputsEqual(outputs, xthbWritten);
  var started = 0;

  if (!changed && !xthbForceWrite) {
    return 0;
  }
  xthbForceWrite = false;

  xthbSetVar("xthb-estim-value", outputs.estim.value);
  xthbSetVar("xthb-estim-frequency", outputs.estim.frequency);
  xthbSetVar("xthb-estim-ramp-seconds", outputs.estim.rampSeconds);
  xthbSetVar("xthb-vibrator-value", outputs.vibrator.value);
  xthbSetVar("xthb-vibrator-ramp-seconds", outputs.vibrator.rampSeconds);
  xthbSetVar("xthb-rotator-value", outputs.rotator.value);
  xthbSetVar("xthb-rotator-direction-code", outputs.rotator.direction);
  xthbSetVar("xthb-rotator-ramp-seconds", outputs.rotator.rampSeconds);

  /*
   * 值真的变了（或需要强制归零）才启动输出 Job。这是唯一的防抖优化。
   * 这里的成功只表示 callAction 没有同步抛异常，不代表设备收到了（§3.4）。
   */
  xthbStartJob(XTHB_OUT_ESTIM);
  xthbStartJob(XTHB_OUT_VIBRATOR);
  xthbStartJob(XTHB_OUT_ROTATOR);
  started = 3;

  xthbWritten = outputs;
  return started;
}

/* =====================================================================
 * 9. 对外入口（Initial/Final Actions 与全局 Trigger 调用这些函数）
 * ===================================================================== */

function xtoysBridgeInit() {
  var parsed = xthbParseConfig();
  var key;

  xthbEvents = {};
  xthbBaselines = {};
  xthbBaselineSeq = {};
  xthbWritten = null;
  xthbTicks = 0;
  xthbCallsOK = 0;
  xthbRejected = 0;
  xthbLastError = "";

  if (!parsed.ok) {
    xthbConfig = null;
    xthbLog("init 失败：" + parsed.code + " —— tick 将保持静默、不驱动任何输出");
    return "init_failed";
  }
  xthbConfig = parsed.config;

  /* 先把所有输出变量归零，避免上一次运行的残留值被输出 Job 读走。 */
  for (key in xthbConfig.channels) {
    if (!xthbHasOwn(xthbConfig.channels, key)) {
      continue;
    }
    xthbZeroChannelVariables(key);
  }
  xthbForceWrite = true;
  xthbSetVar("xthb-status", "running");
  xthbLog("初始化完成：部件 " + xthbConfig.parts.length + " 个，通道 " +
    xthbChannelNames().length + " 个");
  return "initialized";
}

function xthbChannelNames() {
  var names = [];
  var key;
  for (key in xthbConfig.channels) {
    if (xthbHasOwn(xthbConfig.channels, key)) {
      names.push(key);
    }
  }
  return names;
}

function xthbZeroChannelVariables(channel) {
  if (channel === XTHB_CH_ESTIM) {
    xthbSetVar("xthb-estim-value", 0);
    xthbSetVar("xthb-estim-frequency", 0);
    xthbSetVar("xthb-estim-ramp-seconds", 0);
    return;
  }
  if (channel === XTHB_CH_VIBRATOR) {
    xthbSetVar("xthb-vibrator-value", 0);
    xthbSetVar("xthb-vibrator-ramp-seconds", 0);
    return;
  }
  if (channel === XTHB_CH_ROTATOR) {
    xthbSetVar("xthb-rotator-value", 0);
    xthbSetVar("xthb-rotator-direction-code", 0);
    xthbSetVar("xthb-rotator-ramp-seconds", 0);
  }
}

/* 100 ms 调度 Job 调这个。它只计算、比较、必要时写变量 + 启动输出 Job。 */
function xtoysBridgeTick() {
  var nowMs;
  var key;
  var expired = 0;
  var outputs;

  if (xthbConfig === null) {
    return "not_initialized";
  }
  nowMs = xthbNowMs();
  xthbTicks = xthbTicks + 1;

  /* 到期清理。 */
  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    if (xthbEvents[key].finishAtMs <= nowMs) {
      delete xthbEvents[key];
      expired = expired + 1;
    }
  }

  outputs = xthbComputeOutputs();
  xthbPushOutputs(outputs);

  xthbSetVar("xthb-status", "running");
  xthbSetVar("xthb-tick-count", xthbTicks);
  xthbSetVar("xthb-active-events", xthbCountEvents());
  xthbSetVar("xthb-calls-ok", xthbCallsOK);
  xthbSetVar("xthb-rejected-count", xthbRejected);
  xthbSetVar("xthb-last-error", xthbLastError);
  return "tick";
}

/*
 * 全局 Trigger 入口。payload 是 Webhook body 里固定的外层对象：
 *   { "action": "xtoys_game_bridge", "payload": "<内层协议对象的 JSON 字符串>" }
 */
function xtoysBridgeHandle(payload) {
  var outer;
  var inner;
  var parsed;
  var result;

  if (xthbConfig === null) {
    return xthbFail("invalid_config", "运行时未初始化");
  }
  if (typeof payload !== "string" || payload.length === 0) {
    return xthbFail("invalid_payload", "载荷为空或非字符串");
  }
  if (payload.length > XTHB_MAX_PAYLOAD_CHARS) {
    return xthbFail("invalid_payload", "载荷超过 " + XTHB_MAX_PAYLOAD_CHARS + " 字符");
  }
  try {
    outer = JSON.parse(payload);
  } catch (outerErr) {
    return xthbFail("invalid_json", "外层不是合法 JSON");
  }
  if (typeof outer !== "object" || outer === null) {
    return xthbFail("invalid_payload", "外层不是对象");
  }
  if (outer.action !== "xtoys_game_bridge") {
    return xthbFail("invalid_payload", "外层 action 不是 xtoys_game_bridge");
  }
  if (typeof outer.payload !== "string") {
    return xthbFail("invalid_payload", "外层 payload 不是字符串");
  }
  try {
    inner = JSON.parse(outer.payload);
  } catch (innerErr) {
    return xthbFail("invalid_json", "内层 payload 不是合法 JSON");
  }
  if (typeof inner !== "object" || inner === null) {
    return xthbFail("invalid_payload", "内层不是对象");
  }

  parsed = xthbParseCommand(inner);
  if (parsed.error) {
    return xthbFail(parsed.error);
  }
  result = xthbExecute(parsed);
  if (result.ok) {
    xthbCallsOK = xthbCallsOK + 1;
  }
  return result;
}

/* 解析内层协议对象；不做任何状态改动。 */
function xthbParseCommand(inner) {
  var command;
  var targets = null;
  var seq = null;
  var durationMs = 0;
  var maxDuration = 0;
  var index;

  if (inner.protocolVersion !== XTHB_PROTOCOL_VERSION) {
    return { error: "unsupported_protocol_version" };
  }
  command = inner.command;
  if (command !== XTHB_CMD_PLAY && command !== XTHB_CMD_UPDATE &&
    command !== XTHB_CMD_STOP && command !== XTHB_CMD_SET_BASELINE &&
    command !== XTHB_CMD_STOP_ALL && command !== XTHB_CMD_TEST) {
    return { error: "unsupported_command" };
  }
  if (!xthbIsNonEmptyString(inner.source) || inner.source.length > XTHB_MAX_ID_CHARS) {
    return { error: "missing_source" };
  }

  if (command === XTHB_CMD_STOP_ALL) {
    /* stop_all 不需要 eventId/sequence —— 它必须永远能执行（紧急全停）。 */
    return { command: command, source: inner.source, eventId: null, targets: null, sequence: null };
  }

  if (command === XTHB_CMD_STOP) {
    if (xthbHasOwn(inner, "eventId") && inner.eventId !== null) {
      if (!xthbIsNonEmptyString(inner.eventId) || inner.eventId.length > XTHB_MAX_ID_CHARS) {
        return { error: "missing_event_id" };
      }
    }
    if (xthbHasOwn(inner, "targets") && inner.targets !== null) {
      targets = xthbParseTargets(inner.targets);
      if (targets.error) {
        return { error: "invalid_targets" };
      }
      targets = targets.targets;
    } else {
      targets = null;
    }
    return {
      command: command,
      source: inner.source,
      eventId: xthbHasOwn(inner, "eventId") && inner.eventId !== null ? inner.eventId : null,
      targets: targets,
      sequence: null
    };
  }

  /* play / update / set_baseline / test 都需要 sequence。 */
  if (!xthbIsFiniteNumber(inner.sequence) || inner.sequence < 0) {
    return { error: "invalid_sequence" };
  }
  seq = inner.sequence;

  if (command === XTHB_CMD_SET_BASELINE || command === XTHB_CMD_TEST) {
    if (!xthbHasOwn(inner, "targets") || inner.targets === null) {
      return { error: "missing_targets" };
    }
    targets = xthbParseTargets(inner.targets);
    if (targets.error) {
      return { error: "invalid_targets" };
    }
    return {
      command: command,
      source: inner.source,
      eventId: null,
      targets: targets.targets,
      sequence: seq
    };
  }

  /* play / update。 */
  if (!xthbIsNonEmptyString(inner.eventId) || inner.eventId.length > XTHB_MAX_ID_CHARS) {
    return { error: "missing_event_id" };
  }
  if (!xthbHasOwn(inner, "targets") || inner.targets === null) {
    return { error: "missing_targets" };
  }
  targets = xthbParseTargets(inner.targets);
  if (targets.error) {
    return { error: "invalid_targets" };
  }

  /* play/update 的每个目标必须有正 durationMs（协议 §3）。 */
  for (index = 0; index < targets.targets.length; index = index + 1) {
    durationMs = targets.targets[index].durationMs;
    if (!xthbIsFiniteNumber(durationMs) || durationMs <= 0) {
      return { error: "invalid_duration" };
    }
    if (durationMs > maxDuration) {
      maxDuration = durationMs;
    }
  }
  return {
    command: command,
    source: inner.source,
    eventId: inner.eventId,
    targets: targets.targets,
    sequence: seq,
    durationMs: maxDuration
  };
}

function xthbExecute(parsed) {
  var key;
  var parts;

  if (parsed.command === XTHB_CMD_STOP_ALL) {
    /* 紧急全停：清掉所有基线与有限事件，保留序号栅栏；写零并推给设备。 */
    xthbEvents = {};
    xthbBaselines = {};
    xthbForceWrite = true;
    xthbSetVar("xthb-status", "stopped_all");
    xthbLog("stop_all：状态已清空，正在把归零推给输出 Job（不保证设备已收到）");
    xthbPushOutputs(xthbComputeOutputs());
    return { ok: true, code: "stopped_all" };
  }

  if (parsed.command === XTHB_CMD_TEST) {
    /* 只解析不驱动硬件：不写输出变量、不启动 Job。 */
    return { ok: true, code: "validated" };
  }

  if (parsed.command === XTHB_CMD_SET_BASELINE) {
    parts = xthbTargetsToParts(parsed.targets);
    return xthbApplyBaseline(parsed.source, parsed.sequence, parts);
  }

  if (parsed.command === XTHB_CMD_STOP) {
    return xthbApplyStop(parsed.source, parsed.eventId, parsed.targets === null ? null : xthbTargetsToParts(parsed.targets));
  }

  /* play / update 语义相同：整集替换，靠 sequence 判断新旧。 */
  parts = xthbTargetsToParts(parsed.targets);
  return xthbApplyPlay(parsed.source, parsed.eventId, parsed.sequence, parts,
    xthbNowMs() + parsed.durationMs);
}

/* Final Actions 调这个：脚本停止时把每个通道写成零。 */
function xtoysBridgeStopAll() {
  var channelNames;
  var index;

  xthbEvents = {};
  xthbBaselines = {};
  xthbForceWrite = false;
  xthbWritten = null;

  if (xthbConfig === null) {
    /* 即使初始化失败也要努力写出零值，虽然 UI 归零 Action 才是硬保障。 */
    xthbSetVar("xthb-estim-value", 0);
    xthbSetVar("xthb-estim-frequency", 0);
    xthbSetVar("xthb-vibrator-value", 0);
    xthbSetVar("xthb-rotator-value", 0);
    xthbSetVar("xthb-rotator-direction-code", 0);
    xthbSetVar("xthb-status", "stopped");
    return "stopped";
  }
  channelNames = xthbChannelNames();
  for (index = 0; index < channelNames.length; index = index + 1) {
    xthbZeroChannelVariables(channelNames[index]);
  }
  xthbSetVar("xthb-status", "stopped");
  xthbLog("已把全部输出变量写为零；硬件归零由 Final Actions 的显式 Action 负责");
  return "stopped";
}
