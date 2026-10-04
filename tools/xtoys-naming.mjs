/*
 * 生成器与测试共用的单一真源：映射表、命名规范、运行时配置形状。
 *
 * 为什么要有这个文件：命名规则（Channel ID / 变量名 / Job 名）曾经同时写在
 * 生成器和测试里，两边对 "vibrate" vs "vibrator" 的理解不一致，导致输出 Job
 * 读的变量名与运行时写的变量名对不上 —— 单元测试全绿但设备什么也收不到。
 * 现在规则只写在这里一处，生成器与测试都从这里取。
 *
 * 规则依据：docs/03-protocol-mapping.md §2.1 / §3
 */

/* ==================================================================
 * 1. 本阶段映射表（唯一的知识点：逻辑部位 → Block）
 *    一个 Block 专属一个 part，不跨 part 共享（docs/03 §1 第 2 条）
 * ================================================================== */

/*
 * metric 与 Channel type 的对应（docs/03 §2.2）：
 *   estim   → part-estim     消费 intensity + frequency
 *   vibrate → part-vibrator  消费 intensity（永不消费 frequency）
 *   rotate  → part-rotator   消费 rotateSpeed + 方向
 *
 * 本阶段 9 个 Block = 4 部位 (nipple / clitoris / vagina / anus) × (estim + vibrate)，
 * 另加 1 个 Rotate-nipple 样板。
 * Rotate-nipple 目前【没有任何物理设备接入】，真机行为无法验证（docs/03 §2.3）。
 */
export const PARTS = {
  nipple: { estim: true, vibrate: true, rotate: true },
  clitoris: { estim: true, vibrate: true },
  vagina: { estim: true, vibrate: true },
  anus: { estim: true, vibrate: true },
};

/* 合法部位名清单。用于【配置校验】（识别映射表里把部位名写错），
 * 不是用来拒绝游戏侧载荷的白名单 —— 见 docs/03 §6.1。 */
export const KNOWN_PART_NAMES = [
  "mouth", "breast", "nipple", "armpit", "clitoris", "vulva",
  "vagina", "urethra", "anus", "butt", "penis", "prostate",
];

/* metric → 通道类型。注意通道类型用词是 vibrator / rotator，
 * 而 metric 名是 vibrate / rotate —— 变量名跟随【通道 ID】，不跟随 metric。 */
export const METRIC_TYPE = {
  estim: "part-estim",
  vibrate: "part-vibrator",
  rotate: "part-rotator",
};

export const METRIC_LABEL = {
  estim: "Estim",
  vibrate: "Vibrate",
  rotate: "Rotate",
};

export const ALL_METRICS = ["estim", "vibrate", "rotate"];

export const SCHEDULER_JOB = "xthb-scheduler";
export const SCHEDULER_INTERVAL_SECONDS = "0.1";

/* 频率变量的哨兵值：表示"本次没有频率意图，不要动频率"（docs/03 §4.5）。 */
export const FREQUENCY_SENTINEL = -1;

/* ==================================================================
 * 2. 命名规范（docs/03 §2.1）—— 唯一实现
 * ================================================================== */

export function channelId(metric, part) {
  return `part-${METRIC_TYPE[metric].replace("part-", "")}-${part}`;
}

export function uiName(metric, part) {
  return `${METRIC_LABEL[metric]}-${part}`;
}

export function outputJob(metric, part) {
  return `xthb-output-${metric}-${part}`;
}

/* 变量名一律由 Channel ID 派生：part-vibrator-nipple → xthb-vibrator-nipple-volume。
 * 这样 Channel ID 是唯一真源，不会再出现 metric 名与通道名两套写法。 */
export function channelSlug(id) {
  return id.startsWith("part-") ? id.slice(5) : id;
}

export function volumeVarFor(id) {
  return `xthb-${channelSlug(id)}-volume`;
}

export function rampVarFor(id) {
  return `xthb-${channelSlug(id)}-ramp-seconds`;
}

export function frequencyVarFor(id) {
  return `xthb-${channelSlug(id)}-frequency`;
}

export function directionVarFor(id) {
  return `xthb-${channelSlug(id)}-direction-code`;
}

/* ==================================================================
 * 3. 由映射表派生 Block 列表与配置
 * ================================================================== */

export function buildBlocks() {
  const blocks = [];
  for (const part of Object.keys(PARTS)) {
    for (const metric of ALL_METRICS) {
      if (!PARTS[part][metric]) continue;
      const id = channelId(metric, part);
      blocks.push({
        part,
        metric,
        channelId: id,
        uiName: uiName(metric, part),
        outputJob: outputJob(metric, part),
        volumeVar: volumeVarFor(id),
        rampVar: rampVarFor(id),
        frequencyVar: metric === "estim" ? frequencyVarFor(id) : null,
        directionVar: metric === "rotate" ? directionVarFor(id) : null,
      });
    }
  }
  return blocks;
}

/*
 * 紧凑配置（进 customCode 代码文本里的那个）。
 *
 * 为什么要紧凑：真机上"把配置字符串经 variables 注入/变量读写传给 JS"这条路会打坏内容
 * （2026-09-30 实测：494 字符 → 91 字符、所有值变成裸 undefined，是模板替换的特征）。
 * 改成写进代码文本后，长度不再是硬约束，但越短越不容易再碰到任何长度或转义问题。
 *
 * 键名说明：运行时会大小写不敏感地取键，所以这里用短名。
 *   v  = protocolVersion（版本，运行时用它做兼容判断的兜底）
 *   p  = parts：部位 → 该部位启用的 metric 列表
 *   s  = frequencySentinel
 */
export function buildCompactConfig() {
  const p = {};
  for (const part of Object.keys(PARTS)) {
    p[part] = ALL_METRICS.filter((m) => PARTS[part][m]);
  }
  return { p, s: FREQUENCY_SENTINEL };
}

/*
 * 运行时配置（Initial Actions 写入 xthb-config-json）。
 * 形状必须与 src/xtoys-bridge.js 的 xthbParseConfig() 一致。
 * 这是"备路"：主路是 code 内嵌字面量；备路供 tick 补读与诊断。
 */
export function buildBridgeConfig() {
  const parts = {};
  for (const part of Object.keys(PARTS)) {
    parts[part] = {};
    for (const metric of ALL_METRICS) {
      if (!PARTS[part][metric]) continue;
      parts[part][metric] = channelId(metric, part);
    }
  }
  return {
    protocolVersion: 1,
    parts,
    frequencySentinel: FREQUENCY_SENTINEL,
  };
}
