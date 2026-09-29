/*
 * XToys 触觉桥 — 接收端运行时（阶段 0）
 * =====================================================================
 * 本文件被 tools/build-xtoys-script.mjs 嵌入 Script JSON 的 customFunctions
 * 字段，运行在 XToys 的 JS-Interpreter 中。
 *
 * 权威依据：
 *   - 映射与仲裁  docs/03-protocol-mapping.md
 *   - 协议字段    docs/02-webhook-protocol.md
 *   - 数据流      docs/04-architecture-flow.md
 *
 * 硬约束：
 *   - 只能 ES5：var + function。禁止 let/const/=>/class/async/await/
 *     模板字符串/解构/展开。tools/check-es5-subset.mjs 会检查。
 *   - 只写"当前输出值"（setVolume/setDirection）。绝不调用任何设置
 *     设备最大强度 / 最大旋转速度的接口（HANDOFF.md §3.2）。
 *   - 同步返回 != 设备确认（HANDOFF.md §3.4）。措辞不得声称设备已确认。
 *
 * 三条关键设计（讨论定论，不要"顺手优化"掉）：
 *   1. 事件驱动与输出刷新彻底分离：handle 只改状态，输出全部由 tick 计算。
 *   2. 推送判据 = 数值 或 驱动者身份（driveId）变化。不能只比数值，
 *      否则"新事件、强度恰好相同"会被静默吞掉（docs/03 §4.4）。
 *   3. frequency 缺省 = 保持设备当前值，不是置零（docs/03 §4.5）。
 */

/* =====================================================================
 * 1. 宿主 API（XToys 提供；本地测试注入同名 mock）
 *
 * 所有宿主调用都包在 try/catch 里（HANDOFF.md §7.3：try/catch 记一条日志即可）。
 * 这一步不是形式主义：stop_all 的推送循环里如果 setVariable/callAction 抛异常，
 * 异常会冲出 xtoysBridgeHandle —— 游戏侧收不到 ok:false，而剩下的 Block
 * 还停在旧输出上。包住之后，"把归零推出去"这件事不会因为某个通道失败而中断。
 * ===================================================================== */

var XTHB_setVariable_raw = setVariable;
var XTHB_getVariable_raw = getVariable;
var XTHB_callAction_raw = callAction;

/* 所有宿主调用的安全包装。抛异常时记一条日志并返回 false，绝不让异常逃出。 */
function XTHB_setVariable(name, value) {
  try {
    XTHB_setVariable_raw(name, value);
    return true;
  } catch (err) {
    xthbHostErrors = xthbHostErrors + 1;
    xthbLog("setVariable(" + name + ") 抛异常，已吞掉：" + err);
    return false;
  }
}

function XTHB_getVariable(name) {
  try {
    return XTHB_getVariable_raw(name);
  } catch (err) {
    xthbHostErrors = xthbHostErrors + 1;
    xthbLog("getVariable(" + name + ") 抛异常，按未设置处理");
    return null;
  }
}

function XTHB_callAction(action) {
  try {
    XTHB_callAction_raw(action);
    return true;
  } catch (err) {
    xthbHostErrors = xthbHostErrors + 1;
    xthbLog("callAction 抛异常，已吞掉：" + err);
    return false;
  }
}

/* =====================================================================
 * 2. 常量与状态
 * ===================================================================== */

var XTHB_PROTOCOL_VERSION = 1;
var XTHB_VAR_CONFIG = "xthb-config-json";

var XTHB_CMD_PLAY = "play";
var XTHB_CMD_UPDATE = "update";
var XTHB_CMD_STOP = "stop";
var XTHB_CMD_SET_BASELINE = "set_baseline";
var XTHB_CMD_STOP_ALL = "stop_all";
var XTHB_CMD_TEST = "test";

var XTHB_DIR_CLOCKWISE = "clockwise";
var XTHB_DIR_COUNTERCLOCKWISE = "counterclockwise";

/* 边界门：拒绝畸形输入，不是容量管理系统（HANDOFF.md §7.3）。 */
var XTHB_MAX_PAYLOAD_CHARS = 16384;
var XTHB_MAX_TARGETS = 16;
var XTHB_MAX_ID_CHARS = 64;
var XTHB_MAX_DURATION_MS = 600000;
var XTHB_MAX_EVENTS = 64;
/* 事件整体到期后，还保留多久作为序号栅栏（防重复投递变成重复刺激）。 */
var XTHB_EXPIRED_EVENT_KEEP_MS = 600000;

/* metric 取值（docs/03 §2.2）。 */
var XTHB_METRIC_ESTIM = "estim";
var XTHB_METRIC_VIBRATE = "vibrate";
var XTHB_METRIC_ROTATE = "rotate";
/* 频率不是 Block 类型，只是 estim Block 上的第二个维度；单独用这个键去仲裁。 */
var XTHB_METRIC_FREQUENCY = "frequency";

/* 解析后的配置。 */
var xthbConfig = null;
/* 由配置派生的"已配置 Block"列表。 */
var xthbBlocks = [];

/* 事件表：source + eventId -> 事件。 */
var xthbEvents = {};
/* 基线快照：source -> { sequence, parts }。 */
var xthbBaselines = {};
/* 每个 source 的基线序号栅栏（stop_all 清状态但保留它）。 */
var xthbBaselineSeq = {};

/* 上次写下的输出：channel -> { value, frequency, rampSeconds, driveId }。 */
var xthbWritten = {};
/* 是否需要强推一次（初始化与 stop_all 时把归零真正送出去）。 */
var xthbForcePush = false;

/* 诊断计数（措辞必须遵守 HANDOFF.md §3.4）。 */
var xthbTicks = 0;
var xthbCallsOK = 0;
var xthbRejected = 0;
var xthbIgnored = 0;
/* 被吞掉的宿主 API 异常次数。>0 说明 XToys 侧调用出过问题，要去看日志。 */
var xthbHostErrors = 0;
var xthbLastError = "";
var xthbLastIgnored = "";
/* 已留痕过的 (部位, 指标) 组合，避免同一个问题被反复计数。 */
var xthbAuditSeen = {};

/* =====================================================================
 * 3. 基础工具（全部 ES5）
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
  try {
    if (typeof console !== "undefined" && console && console.log) {
      console.log("[xthb] " + text);
    }
  } catch (logErr) {
    /* 日志失败不影响业务，也不写任何硬件状态。 */
  }
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

/* 返回夹取后的数字；非法（含显式 null）返回 null。 */
function xthbRequireNumber(value, low, high) {
  if (!xthbIsFiniteNumber(value)) {
    return null;
  }
  return xthbClamp(value, low, high);
}

function xthbIsNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/*
 * source / eventId 是事件身份的一部分，内部用 \u0000 当分隔符做键。
 * 如果 ID 本身含控制字符，(source,eventId) 就会互相碰撞 —— 例如
 * source="a\u0000b"/eventId="c" 与 source="a"/eventId="b\u0000c" 会撞在同一个键上，
 * 违反 docs/02 §2「不同 source 可用相同 eventId 而互不影响」。
 * 所以 ID 一律禁止控制字符（这是畸形输入，直接拒绝）。
 */
function xthbIsSafeId(value, maxChars) {
  var index;
  var code;
  if (!xthbIsNonEmptyString(value) || value.length > maxChars) {
    return false;
  }
  for (index = 0; index < value.length; index = index + 1) {
    code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

function xthbIsArray(value) {
  return typeof value === "object" && value !== null &&
    typeof value.length === "number" && typeof value.push === "function";
}

function xthbHasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function xthbCountOwn(obj) {
  var total = 0;
  var key;
  for (key in obj) {
    if (xthbHasOwn(obj, key)) {
      total = total + 1;
    }
  }
  return total;
}

function xthbOwnKeys(obj) {
  var keys = [];
  var key;
  for (key in obj) {
    if (xthbHasOwn(obj, key)) {
      keys.push(key);
    }
  }
  return keys;
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

/* 忽略留痕：部位合法但本部署没接那类设备（docs/03 §6.2.2）。 */
function xthbNoteIgnored(detail) {
  xthbIgnored = xthbIgnored + 1;
  xthbLastIgnored = detail;
  xthbLog("ignored " + detail);
}

/* =====================================================================
 * 4. 配置解析与校验
 * ===================================================================== */

/*
 * 配置 JSON（Initial Actions 写入 xthb-config-json）：
 *   {
 *     "protocolVersion": 1,
 *     "knownParts": ["nipple", ...],   // 配置校验用，不是载荷白名单
 *     "parts": { "<part>": { "estim": "<channelId>", "vibrate": ..., "rotate": ... } },
 *     "frequencySentinel": -1
 *   }
 *
 * 校验规则（违反则拒绝初始化，docs/03 §3）：
 *   1. 每个 Channel ID 只能出现在一个 part 下（Block 专属一个 part）。
 *   2. part 名必须是非空字符串（没有白名单；表里有的就是合法的）。
 *   3. metric 必须是 estim / vibrate / rotate。
 */
function xthbParseConfig() {
  var raw = XTHB_getVariable(XTHB_VAR_CONFIG);
  var parsed;
  var blocks = [];
  var seen = {};
  var part;
  var metric;
  var partSpec;
  var id;

  if (!xthbIsNonEmptyString(raw)) {
    return { error: "配置变量 " + XTHB_VAR_CONFIG + " 未设置或不是字符串" };
  }
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    return { error: "配置不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "配置不是对象" };
  }
  if (parsed.protocolVersion !== XTHB_PROTOCOL_VERSION) {
    return { error: "配置 protocolVersion 不受支持" };
  }
  if (typeof parsed.parts !== "object" || parsed.parts === null) {
    return { error: "配置缺少 parts" };
  }
  if (xthbCountOwn(parsed.parts) === 0) {
    return { error: "配置 parts 为空" };
  }
  if (!xthbIsFiniteNumber(parsed.frequencySentinel)) {
    return { error: "配置缺少 frequencySentinel" };
  }
  /*
   * 哨兵值必须在真实频率范围（0–100）之外，否则"没有频率意图"与"真实频率值"
   * 无法区分，estim Job 会在每次推送时都去写频率（docs/03 §4.5）。
   */
  if (parsed.frequencySentinel >= 0 && parsed.frequencySentinel <= 100) {
    return { error: "配置 frequencySentinel 必须落在 0–100 之外" };
  }
  knownParts = xthbIsArray(parsed.knownParts) ? parsed.knownParts : [];

  for (part in parsed.parts) {
    if (!xthbHasOwn(parsed.parts, part)) {
      continue;
    }
    if (!xthbIsNonEmptyString(part)) {
      return { error: "parts 含非法部位名" };
    }
    /*
     * 不校验"部位名是否在合法清单里"。docs/03 §6.1 定的是：
     * 部位名是否可用，完全由这张映射表决定 —— 表里有就是合法的，没有白名单。
     * 表里写错名字的后果只是那个名字不生效（游戏侧发它会被忽略并留痕），
     * 而不是让整个运行时停摆。
     */
    if (!xthbIsSafeId(part, XTHB_MAX_ID_CHARS)) {
      return { error: "parts 含控制字符或过长的部位名" };
    }
    partSpec = parsed.parts[part];
    if (typeof partSpec !== "object" || partSpec === null) {
      return { error: "parts." + part + " 不是对象" };
    }
    for (metric in partSpec) {
      if (!xthbHasOwn(partSpec, metric)) {
        continue;
      }
      if (metric !== XTHB_METRIC_ESTIM && metric !== XTHB_METRIC_VIBRATE &&
        metric !== XTHB_METRIC_ROTATE) {
        return { error: "parts." + part + " 含未知 metric " + metric };
      }
      id = partSpec[metric];
      if (!xthbIsNonEmptyString(id)) {
        return { error: "parts." + part + "." + metric + " 的 Channel ID 非法" };
      }
      /* 规则 1：Block 专属一个 part。 */
      if (xthbHasOwn(seen, id)) {
        return { error: "Channel " + id + " 同时属于 " + seen[id] + " 与 " + part };
      }
      seen[id] = part;
      blocks.push({
        part: part,
        metric: metric,
        channel: id,
        volumeVar: xthbVolumeVar(id),
        rampVar: xthbRampVar(id),
        frequencyVar: metric === XTHB_METRIC_ESTIM ? xthbFrequencyVar(id) : null,
        directionVar: metric === XTHB_METRIC_ROTATE ? xthbDirectionVar(id) : null
      });
    }
  }
  if (blocks.length === 0) {
    return { error: "配置没有派生任何 Block" };
  }
  return { config: parsed, blocks: blocks };
}

/* 该 metric 在这个部位上有没有 Block。没有 → 忽略该指标（docs/03 §6.2）。 */
function xthbBlocksFor(part, metric) {
  var out = [];
  var index;
  for (index = 0; index < xthbBlocks.length; index = index + 1) {
    if (xthbBlocks[index].part === part && xthbBlocks[index].metric === metric) {
      out.push(xthbBlocks[index]);
    }
  }
  return out;
}

/* 该部位在这个 metric 上有没有 Block。没有 → 该指标被忽略并留痕。 */
function xthbPartTakesMetric(part, metric) {
  return xthbBlocksFor(part, metric).length > 0;
}

function xthbHasPart(part) {
  var index;
  for (index = 0; index < xthbBlocks.length; index = index + 1) {
    if (xthbBlocks[index].part === part) {
      return true;
    }
  }
  return false;
}

/*
 * 变量名从 Channel ID 派生（与生成器命名规范一致，docs/03 §2.1）：
 *   part-estim-nipple     → xthb-estim-nipple-volume
 *   part-vibrator-nipple  → xthb-vibrator-nipple-volume
 *   part-rotator-nipple   → xthb-rotator-nipple-volume
 * 注意这里是 "vibrator"/"rotator"（通道类型用词），不是 metric 名 "vibrate"/"rotate"。
 * 以 Channel ID 为唯一真源，避免同一个 Block 出现两套名字。
 */
function xthbChannelSlug(channelId) {
  if (channelId.indexOf("part-") === 0) {
    return channelId.substring(5);
  }
  return channelId;
}

function xthbVolumeVar(channelId) {
  return "xthb-" + xthbChannelSlug(channelId) + "-volume";
}

function xthbRampVar(channelId) {
  return "xthb-" + xthbChannelSlug(channelId) + "-ramp-seconds";
}

function xthbFrequencyVar(channelId) {
  return "xthb-" + xthbChannelSlug(channelId) + "-frequency";
}

function xthbDirectionVar(channelId) {
  return "xthb-" + xthbChannelSlug(channelId) + "-direction-code";
}

/* 输出 Job 名由 metric + part 派生（与生成器一致）。 */
function xthbOutputJobFor(block) {
  return "xthb-output-" + block.metric + "-" + block.part;
}

/* =====================================================================
 * 5. targets 解析
 * ===================================================================== */

function xthbParseTarget(raw, index, requireDriveMetric) {
  var target = {};

  if (typeof raw !== "object" || raw === null || xthbIsArray(raw)) {
    return { error: "targets[" + index + "] 不是对象" };
  }
  /*
   * part 只要求非空字符串。部位名是否可用由映射配置决定，
   * 未识别的部位走"忽略并留痕"，不是整体拒绝（docs/03 §6.1）。
   */
  if (!xthbIsNonEmptyString(raw.part)) {
    return { error: "targets[" + index + "].part 必须是字符串" };
  }
  target.part = raw.part;

  if (xthbHasOwn(raw, "intensity")) {
    target.intensity = xthbRequireNumber(raw.intensity, 0, 100);
    if (target.intensity === null) {
      return { error: "targets[" + index + "].intensity 非法" };
    }
  }
  if (xthbHasOwn(raw, "frequency")) {
    target.frequency = xthbRequireNumber(raw.frequency, 0, 100);
    if (target.frequency === null) {
      return { error: "targets[" + index + "].frequency 非法" };
    }
  }
  if (xthbHasOwn(raw, "rotateSpeed")) {
    target.rotateSpeed = xthbRequireNumber(raw.rotateSpeed, 0, 100);
    if (target.rotateSpeed === null) {
      return { error: "targets[" + index + "].rotateSpeed 非法" };
    }
  }
  if (xthbHasOwn(raw, "rotateDirection")) {
    target.rotateDirection = xthbCanonicalDirection(raw.rotateDirection);
    if (target.rotateDirection === null) {
      return { error: "invalid_rotate_direction" };
    }
  }

  /* rotateSpeed > 0 必须给方向；== 0 表示停旋转，方向可省（docs/03 §6.2）。 */
  if (xthbHasOwn(target, "rotateSpeed") && target.rotateSpeed > 0 &&
    !xthbHasOwn(target, "rotateDirection")) {
    return { error: "rotateSpeed > 0 时必须有 rotateDirection" };
  }

  /* 驱动指标一个都没有 → 畸形输入（含只带 rotateDirection 的情况）。
   * stop 的选择器不受此约束：它只指出部位，不表达意图。 */
  if (requireDriveMetric &&
    !xthbHasOwn(target, "intensity") && !xthbHasOwn(target, "frequency") &&
    !xthbHasOwn(target, "rotateSpeed")) {
    return { error: "targets[" + index + "] 没有任何驱动指标" };
  }

  if (xthbHasOwn(raw, "durationMs")) {
    target.durationMs = xthbRequireNumber(raw.durationMs, 0, XTHB_MAX_DURATION_MS);
    if (target.durationMs === null) {
      return { error: "targets[" + index + "].durationMs 非法" };
    }
  }
  if (xthbHasOwn(raw, "rampUpMs")) {
    target.rampUpMs = xthbRequireNumber(raw.rampUpMs, 0, XTHB_MAX_DURATION_MS);
    if (target.rampUpMs === null) {
      return { error: "targets[" + index + "].rampUpMs 非法" };
    }
  }
  if (xthbHasOwn(raw, "rampDownMs")) {
    target.rampDownMs = xthbRequireNumber(raw.rampDownMs, 0, XTHB_MAX_DURATION_MS);
    if (target.rampDownMs === null) {
      return { error: "targets[" + index + "].rampDownMs 非法" };
    }
  }
  if (xthbHasOwn(raw, "priority")) {
    target.priority = xthbRequireNumber(raw.priority, -1000000, 1000000);
    if (target.priority === null) {
      return { error: "targets[" + index + "].priority 非法" };
    }
  }
  return { target: target };
}

/*
 * 解析 targets。
 * requireDriveMetric：
 *   true  —— play / update / set_baseline / test 的"意图"，必须至少有一个驱动指标。
 *   false —— stop 的"选择器"，只需要指出哪个部位，不需要也不应该有指标
 *            （"{part:'nipple'}" 是合法的 stop 选择器，见 docs/02 §5）。
 */
function xthbParseTargets(raw, requireDriveMetric) {
  var out = [];
  var parsed;
  var index;
  var seenPart = {};

  if (!xthbIsArray(raw)) {
    return { error: "targets 不是数组" };
  }
  if (raw.length > XTHB_MAX_TARGETS) {
    return { error: "targets 超过 " + XTHB_MAX_TARGETS + " 条" };
  }
  for (index = 0; index < raw.length; index = index + 1) {
    parsed = xthbParseTarget(raw[index], index, requireDriveMetric);
    if (parsed.error) {
      return { error: parsed.error };
    }
    /* 一个部位只出现一次；重复会造成静默覆盖，是数组语法问题（docs/03 §6.5）。 */
    if (xthbHasOwn(seenPart, parsed.target.part)) {
      return { error: "targets 里部位 " + parsed.target.part + " 重复出现" };
    }
    seenPart[parsed.target.part] = true;
    out.push(parsed.target);
  }
  return { targets: out };
}

/* 把 targets 转成 part -> 意图 的表。 */
function xthbTargetsToParts(targets) {
  var map = {};
  var index;
  for (index = 0; index < targets.length; index = index + 1) {
    map[targets[index].part] = targets[index];
  }
  return map;
}

/* =====================================================================
 * 6. 状态：有限事件与基线快照
 * ===================================================================== */

function xthbEventKey(source, eventId) {
  return source + "\u0000" + eventId;
}

function xthbRemoveEvent(source, eventId) {
  var key = xthbEventKey(source, eventId);
  if (xthbHasOwn(xthbEvents, key)) {
    delete xthbEvents[key];
  }
}

function xthbApplyPlay(source, eventId, sequence, parts, finishAtMs, partFinishAtMs) {
  var key = xthbEventKey(source, eventId);
  var existing = xthbHasOwn(xthbEvents, key) ? xthbEvents[key] : null;

  /* 身份 = source + eventId；只有严格更大的 sequence 才替换（协议 §2）。 */
  if (existing && sequence <= existing.sequence) {
    return { ok: false, code: "invalid_sequence" };
  }
  if (!existing && xthbCountOwn(xthbEvents) >= XTHB_MAX_EVENTS) {
    return { ok: false, code: "state_capacity_exceeded" };
  }
  xthbEvents[key] = {
    source: source,
    eventId: eventId,
    sequence: sequence,
    parts: parts,
    /* 事件整体到期时刻 = max(各部位)，用于内存清理与序号栅栏保留期。 */
    finishAtMs: finishAtMs,
    /* 每个部位自己的到期时刻 —— 到期必须按部位判定（docs/02 §3）。 */
    partFinishAtMs: partFinishAtMs,
    /* 已不再驱动任何输出的时刻；此后只作为序号栅栏保留，供重试载荷判定新旧。 */
    expiredAtMs: -1
  };
  return { ok: true, code: "accepted" };
}

/* 形式 1：只给 eventId → 整个事件；2：eventId+targets → 事件的这些部位；
 * 3：只给 targets → 该来源所有事件的这些部位。 */
function xthbApplyStop(source, eventId, parts) {
  var key;
  var event;
  var partNames;
  var index;
  var removed = 0;

  if (eventId !== null && parts === null) {
    if (!xthbHasOwn(xthbEvents, xthbEventKey(source, eventId))) {
      return { ok: false, code: "missing_stop_selector" };
    }
    xthbRemoveEvent(source, eventId);
    return { ok: true, code: "stopped_event" };
  }
  if (parts === null) {
    return { ok: false, code: "missing_stop_selector" };
  }

  partNames = xthbOwnKeys(parts);

  if (eventId !== null) {
    key = xthbEventKey(source, eventId);
    if (!xthbHasOwn(xthbEvents, key)) {
      return { ok: false, code: "missing_stop_selector" };
    }
    event = xthbEvents[key];
    for (index = 0; index < partNames.length; index = index + 1) {
      if (xthbHasOwn(event.parts, partNames[index])) {
        delete event.parts[partNames[index]];
        removed = removed + 1;
      }
    }
    /*
     * 先判断是否真的移除了东西，再决定清理空壳事件。
     * 反过来写会让"什么都没匹配到"的失败命令仍然删掉一个空事件 ——
     * 被拒绝的命令绝不能改变状态。
     */
    if (removed === 0) {
      return { ok: false, code: "missing_stop_selector" };
    }
    if (xthbCountOwn(event.parts) === 0) {
      xthbRemoveEvent(source, eventId);
    }
    return { ok: true, code: "stopped_parts" };
  }

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
  }
  if (removed === 0) {
    return { ok: false, code: "missing_stop_selector" };
  }
  /* 移除成功后才清理空壳事件。 */
  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    event = xthbEvents[key];
    if (event.source === source && xthbCountOwn(event.parts) === 0) {
      delete xthbEvents[key];
    }
  }
  return { ok: true, code: "stopped_parts" };
}

function xthbApplyBaseline(source, sequence, parts) {
  /* 序号栅栏：stop_all 清状态但保留它，所以必须继续递增（协议 §2）。 */
  if (xthbHasOwn(xthbBaselineSeq, source) && sequence <= xthbBaselineSeq[source]) {
    return { ok: false, code: "invalid_sequence" };
  }
  /* 基线是完整快照，不是叠加：新快照替换旧快照，遗漏的部位被清除。 */
  xthbBaselines[source] = { sequence: sequence, parts: parts };
  xthbBaselineSeq[source] = sequence;
  return { ok: true, code: "accepted" };
}

/* =====================================================================
 * 7. 仲裁与输出计算（docs/03 §4 / §5）
 * ===================================================================== */

function xthbIntentPriority(intent) {
  if (xthbIsFiniteNumber(intent.priority)) {
    return intent.priority;
  }
  return 0;
}

/*
 * 该意图在这个 metric 下的仲裁值；不参与 → null。
 *
 * 收集候选的条件不是"有 intensity"，而是"有本 Block 需要的东西"：
 *   - estim / vibrate 的音量：intensity
 *   - estim 的频率：frequency（**独立仲裁**，见 xthbComputeBlock）
 *   - rotate：rotateSpeed
 * 早期实现把 frequency-only 的意图当成 intensity=0 参与音量仲裁，
 * 结果是"只发频率"的意图被一个更强的音量意图压掉，频率根本没生效。
 */
function xthbMetricValue(intent, metric) {
  if (metric === XTHB_METRIC_ESTIM || metric === XTHB_METRIC_VIBRATE) {
    if (xthbIsFiniteNumber(intent.intensity)) {
      return intent.intensity;
    }
    return null;
  }
  if (metric === XTHB_METRIC_FREQUENCY) {
    if (xthbIsFiniteNumber(intent.frequency)) {
      return intent.frequency;
    }
    return null;
  }
  if (metric === XTHB_METRIC_ROTATE) {
    if (xthbIsFiniteNumber(intent.rotateSpeed)) {
      return intent.rotateSpeed;
    }
    return null;
  }
  return null;
}

/*
 * 收集某部位在某 metric 下的候选：该部位的基线意图 ∪ 该部位所有【未到期】事件的意图。
 *
 * 到期按【每个部位各自】判定：一个事件里 nipple 的 durationMs=200、clitoris 的
 * durationMs=5000 时，nipple 必须在 200ms 后就不再参与仲裁（docs/02 §3 把
 * durationMs 定义在 target 上）。早期实现把整个事件按 max(durationMs) 过期，
 * 会让 200ms 的一击持续输出 5 秒。
 */
function xthbCollectCandidates(part, metric, nowMs) {
  var candidates = [];
  var source;
  var key;
  var event;
  var intent;
  var value;
  var finishAt;

  for (source in xthbBaselines) {
    if (!xthbHasOwn(xthbBaselines, source)) {
      continue;
    }
    intent = xthbBaselines[source].parts[part];
    if (!intent) {
      continue;
    }
    value = xthbMetricValue(intent, metric);
    if (value === null) {
      continue;
    }
    candidates.push({
      value: value,
      priority: xthbIntentPriority(intent),
      sequence: xthbBaselines[source].sequence,
      driveId: source + "\u0000\u0000" + xthbBaselines[source].sequence,
      source: source,
      intent: intent
    });
  }

  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    event = xthbEvents[key];
    intent = event.parts[part];
    if (!intent) {
      continue;
    }
    /* 每个部位自己的到期时刻。 */
    finishAt = xthbHasOwn(event.partFinishAtMs, part)
      ? event.partFinishAtMs[part] : event.finishAtMs;
    if (finishAt <= nowMs) {
      continue;
    }
    value = xthbMetricValue(intent, metric);
    if (value === null) {
      continue;
    }
    candidates.push({
      value: value,
      priority: xthbIntentPriority(intent),
      sequence: event.sequence,
      driveId: event.source + "\u0000" + event.eventId + "\u0000" + event.sequence,
      source: event.source,
      intent: intent
    });
  }
  return candidates;
}

/* 三级比较：priority → 数值 → sequence（docs/03 §5）。 */
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
  if (candidate.sequence !== incumbent.sequence) {
    return candidate.sequence > incumbent.sequence;
  }
  /* 完全并列时按 driveId 定序，保证结果确定。 */
  return candidate.driveId > incumbent.driveId;
}

function xthbArbitrate(part, metric, nowMs) {
  var candidates = xthbCollectCandidates(part, metric, nowMs);
  var winner = null;
  var index;
  for (index = 0; index < candidates.length; index = index + 1) {
    if (xthbPickBetter(candidates[index], winner)) {
      winner = candidates[index];
    }
  }
  return winner;
}

/*
 * ramp 秒数：value <= 0 用 rampDownMs，否则 rampUpMs。
 * rampTime 单位在 docs/01 §4.2 仍标 ⚠️未独立验证（变量名暗示秒）。
 * 若不是秒，只改这一个函数。
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

function xthbDirectionCode(intent) {
  if (intent.rotateDirection === XTHB_DIR_CLOCKWISE) {
    return 1;
  }
  if (intent.rotateDirection === XTHB_DIR_COUNTERCLOCKWISE) {
    return -1;
  }
  return 0;
}

/*
 * 算出一个 Block 当前应该输出什么。
 *
 * value / frequency 各自可"未驱动"：
 *   - 非 estim Block（vibrate / rotate）：只由 intensity / rotateSpeed 驱动音量。
 *   - estim Block：音量需要 intensity；**频率可以独立于音量生效**
 *     （只发 frequency 的意图是合法的，见 docs/03 §6.2；此时音量不动、频率更新）。
 * 未驱动的字段写哨兵值，输出 Job 的条件 Action 就不会去碰设备上的那一项。
 */
function xthbComputeBlock(block, nowMs) {
  var winner = xthbArbitrate(block.part, block.metric, nowMs);
  var out = {
    channel: block.channel,
    block: block,
    value: 0,
    valueDriven: false,
    frequency: null,
    direction: 0,
    rampSeconds: 0,
    driveId: ""
  };
  var hasIntensity;
  var freqWinner;

  if (winner === null) {
    /* 没有候选：音量归零（这个部位确实不该输出）。 */
    out.valueDriven = true;
    out.value = 0;
    return out;
  }
  out.driveId = winner.driveId;

  if (block.metric === XTHB_METRIC_ESTIM) {
    hasIntensity = xthbIsFiniteNumber(winner.intent.intensity);
    if (hasIntensity) {
      out.valueDriven = true;
      out.value = winner.intent.intensity;
      out.rampSeconds = xthbRampSeconds(winner.intent, out.value);
    }
    /*
     * 频率维度独立仲裁：音量 winner 没给 frequency 时，不能就此把频率当成
     * "未指定" —— 同一部位可能有另一个（更强的）意图在明确要求频率。
     * 两者都带 frequency 时结果一致（同一个意图会在两个维度都胜出），
     * 只有音量 winner 缺 frequency 时才会由另一个意图补上。
     */
    freqWinner = winner;
    if (!xthbIsFiniteNumber(winner.intent.frequency)) {
      freqWinner = xthbArbitrate(block.part, XTHB_METRIC_FREQUENCY, nowMs);
      if (freqWinner === null) {
        freqWinner = winner;
      }
    }
    if (xthbIsFiniteNumber(freqWinner.intent.frequency)) {
      out.frequency = freqWinner.intent.frequency;
    }
    /* 只有频率意图（没有 intensity）时 valueDriven 保持 false：
     * 这次只动频率，音量变量根本不写 —— 否则会把正在输出的强度拽到 0。 */
    return out;
  }

  out.valueDriven = true;
  out.value = winner.value;
  out.rampSeconds = xthbRampSeconds(winner.intent, winner.value);
  if (block.metric === XTHB_METRIC_ROTATE) {
    out.direction = xthbDirectionCode(winner.intent);
  }
  return out;
}

function xthbComputeOutputs(nowMs) {
  var outs = [];
  var index;
  for (index = 0; index < xthbBlocks.length; index = index + 1) {
    outs.push(xthbComputeBlock(xthbBlocks[index], nowMs));
  }
  return outs;
}

/*
 * 忽略留痕（docs/03 §6.1 / §6.2）。
 *
 * 在【接受命令时】逐个 target 判定，而不是在 tick 里反复判定：
 *   1. tick 里判定会把计数变成"tick 数"，而且一个持续 10 秒的未知部位会在
 *      100ms 节奏下刷 100 条日志，把真正的错误淹掉；
 *   2. 短暂事件（durationMs 很小）会在下一次 tick 之前就到期，
 *      在 tick 里根本看不到它 —— 游戏侧拼错部位名就完全不会留下痕迹。
 *
 * 同一个 (部位, 指标) 只记一次，避免重复计数。
 */
function xthbNoteTargetIgnores(targets, context) {
  var index;
  var metricIndex;
  var target;
  var part;
  var metrics = [XTHB_METRIC_ESTIM, XTHB_METRIC_VIBRATE, XTHB_METRIC_ROTATE];
  var metric;
  var flagKey;

  for (index = 0; index < targets.length; index = index + 1) {
    target = targets[index];
    part = target.part;
    if (!xthbHasPart(part)) {
      flagKey = "part|" + part;
      if (!xthbHasOwn(xthbAuditSeen, flagKey)) {
        xthbAuditSeen[flagKey] = true;
        xthbNoteIgnored("部位 " + part + " 未在映射配置里（" + context + "）");
      }
      continue;
    }
    for (metricIndex = 0; metricIndex < metrics.length; metricIndex = metricIndex + 1) {
      metric = metrics[metricIndex];
      if (!xthbTargetCarriesMetric(target, metric)) {
        continue;
      }
      if (!xthbPartTakesMetric(part, metric)) {
        flagKey = part + "|" + metric;
        if (!xthbHasOwn(xthbAuditSeen, flagKey)) {
          xthbAuditSeen[flagKey] = true;
          xthbNoteIgnored(part + " 没有 " + metric + " 对应的 Block，该指标被忽略（" + context + "）");
        }
      }
    }
  }
}

/* 这条 target 是否带了这个指标（决定它需要不需要对应的 Block）。 */
function xthbTargetCarriesMetric(target, metric) {
  if (metric === XTHB_METRIC_ESTIM) {
    return xthbIsFiniteNumber(target.intensity) || xthbIsFiniteNumber(target.frequency);
  }
  if (metric === XTHB_METRIC_VIBRATE) {
    /* 振动只消费 intensity；没有 vibrate Block 时 intensity 无处可去。 */
    return xthbIsFiniteNumber(target.intensity);
  }
  if (metric === XTHB_METRIC_ROTATE) {
    return xthbIsFiniteNumber(target.rotateSpeed);
  }
  return false;
}

/* =====================================================================
 * 8. 推送：写变量 + 启动输出 Job（docs/03 §4.4）
 * ===================================================================== */

/*
 * 记入 xthbWritten 时统一把"本次不驱动频率"存成同一个哨兵值。
 * 绝不能一边存 null、一边存哨兵值 —— 那样 xthbNeedsPush 会把"没变"误判成
 * "变了"，每个 tick 都重复启动输出 Job（这个坑真踩过一次）。
 */
function xthbRecordedFrequency(out) {
  if (out.frequency === null) {
    return xthbConfig.frequencySentinel;
  }
  return out.frequency;
}

/*
 * 推送判据：数值 或 驱动者身份变化。不能只比数值 —— 否则"新事件、强度恰好
 * 与当前相同"会被静默吞掉。ramp 是设备级动作，重跑输出 Job 才会重新走一遍
 * rampTime，这正是连击需要的重触发。
 */
function xthbNeedsPush(out) {
  var last = xthbHasOwn(xthbWritten, out.channel) ? xthbWritten[out.channel] : null;
  var frequency;
  if (last === null) {
    return true;
  }
  frequency = xthbRecordedFrequency(out);
  if (last.valueDriven !== out.valueDriven) {
    return true;
  }
  if (out.valueDriven) {
    if (last.value !== out.value) {
      return true;
    }
    if (last.rampSeconds !== out.rampSeconds) {
      return true;
    }
  }
  if (last.frequency !== frequency) {
    return true;
  }
  if (last.driveId !== out.driveId) {
    return true;
  }
  return false;
}

function xthbPushOutputs(outs) {
  var pushed = 0;
  var index;
  var out;
  var force = xthbForcePush;

  xthbForcePush = false;

  for (index = 0; index < outs.length; index = index + 1) {
    out = outs[index];
    if (!force && !xthbNeedsPush(out)) {
      continue;
    }
    /*
     * 音量只在"这次确实有音量意图"时写。频率-only 的意图不碰音量变量，
     * 否则会把正在输出的强度拽到 0。
     */
    if (out.valueDriven) {
      XTHB_setVariable(out.block.volumeVar, out.value);
      XTHB_setVariable(out.block.rampVar, out.rampSeconds);
    }
    if (out.block.frequencyVar !== null) {
      /* null → 哨兵值：明确表示"本次不动频率"。 */
      XTHB_setVariable(out.block.frequencyVar,
        out.frequency === null ? xthbConfig.frequencySentinel : out.frequency);
    }
    if (out.block.directionVar !== null) {
      XTHB_setVariable(out.block.directionVar, out.direction);
    }
    /*
     * 唤醒输出 Job。成功只表示 callAction 没有同步抛异常，
     * 不代表 Job 执行了、更不代表设备收到了（HANDOFF.md §3.4）。
     */
    XTHB_callAction({ type: "updateJob", job: xthbOutputJobFor(out.block), action: "start" });
    xthbWritten[out.channel] = {
      value: out.value,
      valueDriven: out.valueDriven,
      rampSeconds: out.rampSeconds,
      frequency: xthbRecordedFrequency(out),
      driveId: out.driveId
    };
    pushed = pushed + 1;
  }
  return pushed;
}

/*
 * 把所有输出变量写成零，并把这份零状态记入 xthbWritten。
 *
 * 必须记入 xthbWritten：stop_all / 停止函数刚把零推给输出 Job 之后，
 * 下一个 tick 不应该再原样重推一遍。之前这里清空 xthbWritten，会让
 * 每次 tick 都认为"值变了"而重复启动 9 个输出 Job。
 */
function xthbWriteZerosAndRecord() {
  var index;
  var block;
  for (index = 0; index < xthbBlocks.length; index = index + 1) {
    block = xthbBlocks[index];
    XTHB_setVariable(block.volumeVar, 0);
    XTHB_setVariable(block.rampVar, 0);
    if (block.frequencyVar !== null) {
      /* 频率不动：写哨兵值，让输出 Job 不去碰设备频率。 */
      XTHB_setVariable(block.frequencyVar, xthbConfig.frequencySentinel);
    }
    if (block.directionVar !== null) {
      XTHB_setVariable(block.directionVar, 0);
    }
    xthbWritten[block.channel] = {
      value: 0,
      valueDriven: true,
      rampSeconds: 0,
      frequency: xthbConfig.frequencySentinel,
      driveId: ""
    };
  }
}

/* =====================================================================
 * 9. 入口：初始化 / tick / 载荷 / 停止
 * ===================================================================== */

function xthbCountParts() {
  var seen = {};
  var total = 0;
  var index;
  for (index = 0; index < xthbBlocks.length; index = index + 1) {
    if (!xthbHasOwn(seen, xthbBlocks[index].part)) {
      seen[xthbBlocks[index].part] = true;
      total = total + 1;
    }
  }
  return total;
}

/*
 * 所有从 UI Action 调进来的入口都包在 safeCall 里。
 *
 * 这样任何一个意外异常都不会冲到 XToys 的 Action 执行器里 —— Final Actions
 * 里那条字面量归零 Action 才是硬保障，但我们不希望因为一个 JS 异常就让
 * 后面的 Action 有没有机会执行变成未知数（docs/01 §7）。
 *
 * 注意：safeCall 内部【只包住】，不要试图在里面"补救"硬件状态 —— 补救是
 * Final Actions 的字面量 Action 的职责。
 */
function safeCall(body) {
  try {
    return body();
  } catch (err) {
    xthbHostErrors = xthbHostErrors + 1;
    xthbLastError = "safeCall: " + err;
    xthbLog("safeCall 捕获异常：" + err);
    XTHB_setVariable_raw("xthb-status", "error");
    return null;
  }
}

function xtoysBridgeInit() {
  var parsed = xthbParseConfig();

  xthbEvents = {};
  xthbBaselines = {};
  xthbBaselineSeq = {};
  xthbWritten = {};
  xthbBlocks = [];
  xthbConfig = null;
  xthbForcePush = false;
  xthbTicks = 0;
  xthbCallsOK = 0;
  xthbRejected = 0;
  xthbIgnored = 0;
  xthbLastError = "";
  xthbLastIgnored = "";
  xthbAuditSeen = {};
  xthbHostErrors = 0;

  if (parsed.error) {
    /* 配置错误：tick 保持静默、不驱动任何输出；音量归零由 Initial Actions 负责。 */
    xthbLog("init 失败：" + parsed.error + " —— 运行时静默，不会驱动任何输出");
    XTHB_setVariable("xthb-status", "config_error");
    XTHB_setVariable("xthb-last-error", parsed.error);
    return "config_error";
  }

  xthbConfig = parsed.config;
  xthbBlocks = parsed.blocks;

  /* 先把所有输出变量写成零，避免上一次运行的残留值被输出 Job 读走。 */
  xthbWriteZerosAndRecord();
  xthbWritten = {};
  /* 第一次 tick 强推一次全零，确保输出 Job 真的把零写出去。 */
  xthbForcePush = true;
  XTHB_setVariable("xthb-status", "running");
  xthbLog("初始化完成：部位 " + xthbCountParts() + " 个，Block " + xthbBlocks.length + " 个");
  return "initialized";
}

/* 100 ms 调度 Job 调这个。只计算、比较、必要时写变量 + 启动输出 Job。 */
function xtoysBridgeTick() {
  var nowMs;
  var key;

  if (xthbConfig === null) {
    return "not_initialized";
  }
  nowMs = xthbNowMs();
  xthbTicks = xthbTicks + 1;

  /*
   * 到期处理分两级：
   *   1. 每个部位各自到期 → 该部位不再参与仲裁（输出自然回落到基线）。
   *      这里不删事件，因为下面还要用它当序号栅栏。
   *   2. 事件整体到期一段时间后 → 才真正删除，避免状态无限增长。
   * 保留过期事件是有意的：重试/重复投递的 webhook 若带旧 sequence 必须被拒，
   * 否则一次重复投递就会变成重复刺激（docs/02 §2 的严格递增语义）。
   */
  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    if (xthbEvents[key].finishAtMs <= nowMs) {
      if (xthbEvents[key].expiredAtMs < 0) {
        xthbEvents[key].expiredAtMs = nowMs;
      }
      if (nowMs - xthbEvents[key].expiredAtMs > XTHB_EXPIRED_EVENT_KEEP_MS) {
        delete xthbEvents[key];
      }
    }
  }

  xthbPushOutputs(xthbComputeOutputs(nowMs));

  XTHB_setVariable("xthb-status", "running");
  xthbWriteDiagnostics();
  return "tick";
}

/* 诊断变量：每次入口都刷新，别只让 tick 写（stop_all / 停止函数也要更新）。 */
function xthbWriteDiagnostics() {
  XTHB_setVariable("xthb-tick-count", xthbTicks);
  XTHB_setVariable("xthb-active-events", xthbCountLiveEvents(xthbNowMs()));
  XTHB_setVariable("xthb-calls-ok", xthbCallsOK);
  XTHB_setVariable("xthb-rejected-count", xthbRejected);
  XTHB_setVariable("xthb-ignored-count", xthbIgnored);
  XTHB_setVariable("xthb-host-errors", xthbHostErrors);
  XTHB_setVariable("xthb-last-error", xthbLastError);
  XTHB_setVariable("xthb-last-ignored", xthbLastIgnored);
}

/* 仍在驱动输出的有限事件数（不含仅作序号栅栏保留的过期事件）。 */
function xthbCountLiveEvents(nowMs) {
  var total = 0;
  var key;
  for (key in xthbEvents) {
    if (!xthbHasOwn(xthbEvents, key)) {
      continue;
    }
    if (xthbEvents[key].finishAtMs > nowMs) {
      total = total + 1;
    }
  }
  return total;
}

/* 全局 Trigger 入口。payload 是 Webhook body（字符串）。 */
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
  /* 执行阶段的失败必须如实返回 ok:false，绝不能当成成功。 */
  result = xthbExecute(parsed);
  if (result.ok) {
    xthbCallsOK = xthbCallsOK + 1;
  } else {
    xthbRejected = xthbRejected + 1;
    xthbLastError = result.code;
    xthbLog("rejected " + result.code);
  }
  return result;
}

function xthbParseCommand(inner) {
  var command;
  var targets = null;
  var seq = null;
  var durationMs = 0;
  var maxDuration = 0;
  var hasEventId;
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
  if (!xthbIsSafeId(inner.source, XTHB_MAX_ID_CHARS)) {
    return { error: "missing_source" };
  }

  /* stop_all 不需要其他字段 —— 它必须永远能执行。 */
  if (command === XTHB_CMD_STOP_ALL) {
    return { command: command, source: inner.source, eventId: null, targets: null, sequence: null };
  }

  if (command === XTHB_CMD_STOP) {
    hasEventId = xthbHasOwn(inner, "eventId") && inner.eventId !== null;
    if (hasEventId && !xthbIsSafeId(inner.eventId, XTHB_MAX_ID_CHARS)) {
      return { error: "missing_event_id" };
    }
    if (xthbHasOwn(inner, "targets") && inner.targets !== null) {
      /* stop 的 targets 是选择器：不需要驱动指标。 */
      targets = xthbParseTargets(inner.targets, false);
      if (targets.error) {
        return { error: "invalid_targets" };
      }
      targets = targets.targets;
    }
    /* 选择器校验放在解析阶段，否则会拖到执行阶段变成静默成功。 */
    if (!hasEventId && targets === null) {
      return { error: "missing_stop_selector" };
    }
    /* 空 targets 数组同样没有选择器 —— 也在解析阶段就拒绝。 */
    if (!hasEventId && targets.length === 0) {
      return { error: "missing_stop_selector" };
    }
    return {
      command: command,
      source: inner.source,
      eventId: hasEventId ? inner.eventId : null,
      targets: targets,
      sequence: null
    };
  }

  /*
   * test 是"只校验不驱动"的预检命令（docs/02 §5），不带 sequence 也合法 ——
   * 它不改变任何状态，没有"新旧"可言。
   */
  if (command !== XTHB_CMD_TEST) {
    if (!xthbIsFiniteNumber(inner.sequence) || inner.sequence < 0) {
      return { error: "invalid_sequence" };
    }
    seq = inner.sequence;
  } else if (xthbHasOwn(inner, "sequence")) {
    if (!xthbIsFiniteNumber(inner.sequence) || inner.sequence < 0) {
      return { error: "invalid_sequence" };
    }
    seq = inner.sequence;
  }

  if (command === XTHB_CMD_SET_BASELINE || command === XTHB_CMD_TEST) {
    if (!xthbHasOwn(inner, "targets") || inner.targets === null) {
      return { error: "missing_targets" };
    }
    /* 空数组是合法的：set_baseline 的空快照 = 清空该来源基线（docs/02 §5）。 */
    targets = xthbParseTargets(inner.targets, true);
    if (targets.error) {
      return { error: "invalid_targets" };
    }
    return {
      command: command, source: inner.source, eventId: null,
      targets: targets.targets, sequence: seq
    };
  }

  /* play / update */
  if (!xthbIsSafeId(inner.eventId, XTHB_MAX_ID_CHARS)) {
    return { error: "missing_event_id" };
  }
  if (!xthbHasOwn(inner, "targets") || inner.targets === null) {
    return { error: "missing_targets" };
  }
  targets = xthbParseTargets(inner.targets, true);
  if (targets.error) {
    return { error: "invalid_targets" };
  }
  /*
   * play/update 必须至少有一个目标：空数组会让下面这个循环一次都不执行，
   * maxDuration 停在 0，于是一个"什么也不做"的命令被当成 accepted，
   * 还白白占掉一个事件名额（docs/02 §3 要求每个目标有正 durationMs）。
   */
  if (targets.targets.length === 0) {
    return { error: "missing_targets" };
  }
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
  var nowMs;
  var partFinishAtMs;
  var index;
  var target;

  if (parsed.command === XTHB_CMD_STOP_ALL) {
    /* 紧急全停：清掉所有基线与事件，保留序号栅栏，写零并推给设备。 */
    xthbEvents = {};
    xthbBaselines = {};
    xthbLog("stop_all：状态已清空，正在把归零推给输出 Job（不保证设备已收到）");
    /*
     * 真实推送一次归零（forcePush 让本轮绕过"值没变就跳过"），
     * 然后把零状态记进 xthbWritten，避免下一个 tick 重复推一遍。
     * 最后才写状态：推送过程即使抛异常（宿主调用已被包住），
     * 也不会出现"状态说停了、实际还在输出"。
     */
    xthbForcePush = true;
    xthbPushOutputs(xthbComputeOutputs(nowMs = xthbNowMs()));
    XTHB_setVariable("xthb-status", "stopped_all");
    xthbWriteDiagnostics();
    return { ok: true, code: "stopped_all" };
  }

  if (parsed.command === XTHB_CMD_TEST) {
    /* 只校验不驱动硬件：不写输出变量、不启动 Job、也不留痕（它没被接受为状态）。 */
    return { ok: true, code: "validated" };
  }

  if (parsed.command === XTHB_CMD_SET_BASELINE) {
    xthbNoteTargetIgnores(parsed.targets, "baseline");
    return xthbApplyBaseline(parsed.source, parsed.sequence, xthbTargetsToParts(parsed.targets));
  }

  if (parsed.command === XTHB_CMD_STOP) {
    return xthbApplyStop(parsed.source, parsed.eventId,
      parsed.targets === null ? null : xthbTargetsToParts(parsed.targets));
  }

  /* play / update 语义相同：整集替换，靠 sequence 判断新旧。 */
  nowMs = xthbNowMs();
  xthbNoteTargetIgnores(parsed.targets, "event " + parsed.eventId);
  /*
   * 每个部位各自的到期时刻。docs/02 §3 把 durationMs 定义在 target 上，
   * 所以 200ms 的一击不能在同一个事件里被 5000ms 的另一个部位拖着继续输出。
   */
  partFinishAtMs = {};
  for (index = 0; index < parsed.targets.length; index = index + 1) {
    target = parsed.targets[index];
    partFinishAtMs[target.part] = nowMs + target.durationMs;
  }
  return xthbApplyPlay(parsed.source, parsed.eventId, parsed.sequence,
    xthbTargetsToParts(parsed.targets), nowMs + parsed.durationMs, partFinishAtMs);
}

/*
 * Final Actions 调这个：脚本停止时把所有音量归零，并把归零推给输出 Job。
 *
 * 注意这里必须【真的推送】一次（forcePush 绕过"值没变就跳过"）：只改变量
 * 而不启动输出 Job，零值就永远到不了设备。推送后 xthbWritten 已记录零状态，
 * 所以随后的 tick 不会再重复推一遍。
 */
function xtoysBridgeStopAll() {
  xthbEvents = {};
  xthbBaselines = {};

  if (xthbConfig === null) {
    /* 配置坏了也要尽量写零；Final Actions 的显式 UI 归零才是硬保障。 */
    xthbForcePush = false;
    xthbLog("停止：配置未成功加载，仅写入状态");
    XTHB_setVariable("xthb-status", "stopped");
    return "stopped";
  }
  xthbWriteZerosAndRecord();
  xthbForcePush = true;
  xthbPushOutputs(xthbComputeOutputs(xthbNowMs()));
  XTHB_setVariable("xthb-status", "stopped");
  xthbWriteDiagnostics();
  xthbLog("已把全部音量写零并推给输出 Job；硬件归零另有 Final Actions 的显式 Action 兜底");
  return "stopped";
}
