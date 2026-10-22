// 分时段省钱推荐引擎
//
// 峰谷判定复用 pricing.js（那边含周末 + 法定节假日全天谷价的完整规则），
// 本模块不自己实现，避免漏掉节假日。
import { isDeepseekPeak, HOLIDAYS_BY_YEAR } from './pricing.js'
//
// 目标：回答两个问题
//   1. 当前这个时段，用哪个模型最省（钱 / 积分）？
//   2. 如果首选模型用不了（限流 / 上下文不够），下一个该换谁？
//
// 排序依据不是「单价最低」，而是：
//   实际倍率（含时段折扣） → 上下文够不够 → 是否限流 → 常用度
//
// 三条硬规则（来自实测，不要改）：
//   1. WorkBuddy 的折扣是「按模型 + 时间窗」声明的，不是全局峰谷。
//      只有 deepseek-v4.1-flash / deepseek-v4-pro 遵循官方峰谷（非高峰 5 折）。
//   2. 免费模型（credits x0.00）永远排最前，但它们有每日额度，
//      额度用尽会转 hy3-x（x0.05）或直接 429。
//   3. 上下文不够的模型直接淘汰，不能推荐（用户长对话会报「内容过长」）。

/**
 * 默认清单（兜底）。全部可通过 opts 覆盖——每个人的模型清单、
 * 峰谷规则、常用度都不同，硬编码只作为开箱即用的示例。
 */
let PEAK_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro']

/** 夜间免费/折扣时段 23:00-次日 8:00（用于 hy4-preview、glm-5.2） */
const NIGHT_START = 23
const NIGHT_END = 8

/** 每日赠额类模型：额度有限，用尽转付费 */
let QUOTA_MODELS = ['hy3']

/**
 * 常用模型（同分时优先）。
 *
 * ⚠️ 顺序即优先级，**不要把高倍率模型放在前面**。
 * 2026-10-22 用 490 条真实请求复盘：旧顺序把 deepseek-v4.1-flash 放第 1 位，
 * 结果它 8 天烧掉 777 积分（占 36.5%）——而同为免费、上下文 1M 的
 * step-5-preview 只花了 39.97。倍率相同时的「同分优先」会被这个顺序
 * 直接决定，所以免费/低倍率模型必须排在前面。
 */
let PREFERRED = [
  'step-5-preview',
  'hy3',
  'hy4-preview',
  'hy3-x',
  'space-bunny',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'glm-5.3',
]

/**
 * 高单次消耗模型：倍率不高但**单次实际花得多**（长上下文 + 高思考强度）。
 *
 * 2026-10-22 实测（490 条请求）：space-bunny 倍率仅 x0.08（与 glm-5.3-flash
 * 同价），但单次均值 18.75 积分，是 glm-5.3-flash（15.16）的 1.24 倍、
 * 是 deepseek-v4.1-flash（5.12）的 3.7 倍。19 次请求烧掉 356 积分（占 16.7%）。
 * 倍率排序完全看不出这种模型的问题——倍率是「每 token 单价」，
 * 真实花费 = 倍率 × token 量，而这类模型每次都塞特别多 token。
 */
let HEAVY_MODELS = ['space-bunny', 'glm-5.3', 'glm-5.3-flash']

/**
 * 重型模型的倍率放大系数（用于排序，不改变展示的官方倍率）。
 *
 * 为什么需要：只看倍率会把 space-bunny(x0.08) 排到 deepseek-v4.1-flash(x0.11)
 * 前面，但它单次实际花 18.75 vs deepseek 的 5.12——排在前面的反而更贵。
 * 用实测单次消耗反推 token 量比值：同倍率下 space-bunny 的 token 量是
 * deepseek 的约 5 倍、glm-5.3-flash 的 1.24 倍。取 2 倍是保守值：
 * 足以把 x0.08 的重型模型压到 x0.11 的轻型模型之后，又不会把
 * 极低倍率的重型模型（如 x0.01）不合理地踩到底。
 */
const HEAVY_RATE_FACTOR = 2.0

/** 应用用户配置（null/undefined 项保留默认） */
export function applyUserConfig(cfg) {
  const c = cfg || {}
  if (Array.isArray(c.peakModels) && c.peakModels.length) PEAK_MODELS = c.peakModels.map(String)
  if (Array.isArray(c.quotaModels) && c.quotaModels.length) QUOTA_MODELS = c.quotaModels.map(String)
  if (Array.isArray(c.preferred) && c.preferred.length) PREFERRED = c.preferred.map(String)
  if (Array.isArray(c.heavyModels)) HEAVY_MODELS = c.heavyModels.map(String)
}

/**
 * 模型适用场景（正面描述「适合干什么」，不说「不能干什么」）。
 *
 * 2026-10-22 用户明确要求：「标签不用写效果不行，也不要说什么模型复杂任务
 * 不能完成，要说 XX 模型适用于什么，具体适用于什么情景」。
 *
 * 内容来自公开评测与社区反馈（2026-10 检索），只写结论、不堆参数：
 *   - Step 5 Preview：AA 智能指数 44（全球开源前二），单任务成本 $0.71；
 *     实测能跨 Blender/文件系统/网页工程完成长链路交付；金融研究评测
 *     FrontierFinance、深度研究 DRACO 仅次于 GPT-6 Astra / Claude Opus 5。
 *   - Hy4 preview：770B MoE，1M 上下文，CodeArena WebDev 全球第 6，
 *     163 专家 203 任务盲测 2.99/4。高峰期可能排队、复杂任务思考时间长。
 *   - Hy3：295B，256K 上下文，CodeArena WebDev 第 28。轻量成熟、响应快。
 *   - GLM-5.3-Flash：320B，1M 上下文，MIT 开源，支持图像输入；
 *     AA 智能指数 42，单任务 $0.28（GLM-5.3 的 1/7）。长文档推理
 *     (AA-LCR) 与 GLM-5.3 持平 80%，GDP.pdf 15% vs 11%。
 *   - GLM-5.3：40B 激活，Terminal-Bench 4.0 完成率 42%（Flash 33%），
 *     SciCode 59%（Flash 52%），事实召回 14（Flash 7）。
 *   - DeepSeek V4 Flash：20 个真实任务赢 7 个（含 5 个编码），
 *     用更少 token 达到与 Pro 相同结果；1M 上下文大海捞针测试稳定。
 *     复杂工程落地、精致前端、首次就要成活的任务不够稳。
 *   - MiniMax M3.1 Flash（即 space-bunny）：AutomationBench 最前列，
 *     DeepSWE 73.7%，OSWorld V2 61.7（国产第一），CyberGym 82%。200+ TPS。
 */
const SUITABILITY = {
  'step-5-preview': '长程 Agent、复杂软件工程、金融分析、深度研究',
  'hy4-preview': '长文档、大代码库、跨文件分析、带排版的 PPT/表格',
  'hy3': '日常办公、高频问答、简单内容处理',
  'hy3-x': '日常办公、高频问答（Hy3 额度用尽后的付费延续）',
  'glm-5.3-flash': '文档/PDF 推理、多模态读图、高吞吐后台批处理',
  'glm-5.3': '编码/终端 Agent、凭记忆的事实问答、正式交付物',
  'deepseek-v4.1-flash': '编码、Agent 工作流、长上下文检索、成本敏感的重复调用',
  'space-bunny': '跨 SaaS 业务流自动化、软件工程、电脑操作、安全审计',
  'minimax-m3.1-flash': '跨 SaaS 业务流自动化、软件工程、电脑操作、安全审计',
  'minimax-m3': '跨 SaaS 业务流自动化、软件工程、电脑操作',
  'wb-lite': '极简问答、格式转换',
  'hy-image3.5-preview': '图片生成',
}

/** 夜间折扣系数（0.5 = 5 折；官方未公布具体值，按常见错峰折扣取 5 折） */
const NIGHT_DISCOUNT_FACTOR = 0.5

/**
 * 思考强度 → 输出 token 放大系数。
 *
 * 思考越强，模型在正文之前生成的思考 token 越多，而思考 token 计入 output
 * 按输出价计费。所以「倍率相同」的两个模型，默认思考强度高的实际更贵。
 *
 * 这些系数是按常见推理模型的经验值取的近似（非官方公布），
 * 只用于**同倍率模型之间的排序微调**，不参与金额计算。
 */
const EFFORT_WEIGHT = {
  none: 0.6,
  off: 0.6,
  minimal: 0.7,
  low: 0.85,
  medium: 1.0,
  high: 1.25,
  xhigh: 1.5,
  max: 1.8,
}

/** 中文名（展示用） */
const EFFORT_ZH = {
  none: '关', off: '关', minimal: '最低', low: '低',
  medium: '中', high: '高', xhigh: '极高', max: '最高',
}

/**
 * 一个模型的默认思考强度权重。
 * 优先用 defaultEffort；没有就取 declaredEfforts 的中间值。
 */
function effortWeightOf(model) {
  const def = String((model && model.defaultEffort) || '').toLowerCase()
  if (EFFORT_WEIGHT[def] !== undefined) return EFFORT_WEIGHT[def]
  const list = Array.isArray(model && model.declaredEfforts) ? model.declaredEfforts : []
  if (list.length === 0) return 1.0 // 不暴露思考档位，按中位算
  const mid = String(list[Math.floor((list.length - 1) / 2)] || '').toLowerCase()
  return EFFORT_WEIGHT[mid] !== undefined ? EFFORT_WEIGHT[mid] : 1.0
}

/** 人类可读的思考强度描述 */
export function effortLabelOf(model) {
  const def = String((model && model.defaultEffort) || '').toLowerCase()
  const list = Array.isArray(model && model.declaredEfforts) ? model.declaredEfforts : []
  if (list.length === 0) {
    return def ? '固定 ' + (EFFORT_ZH[def] || def) : '不可调'
  }
  const names = list.map((e) => EFFORT_ZH[String(e).toLowerCase()] || e).join('/')
  return '默认' + (EFFORT_ZH[def] || def || '—') + '（可选 ' + names + '）'
}

/**
 * 北京时间的日历字段。
 * 与 pricing.js 的 beijingParts 同算法（那边入参是秒，这边是毫秒）。
 */
function beijingParts(timeMs) {
  const d = new Date(Number(timeMs) + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    hour: d.getUTCHours(),
    dow: d.getUTCDay(), // 0=周日 6=周六
    year: d.getUTCFullYear(),
    date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
  }
}

/**
 * 是否在高峰。
 * **直接复用 pricing.js 的 isDeepseekPeak**，不自己重写——
 * 那边已正确处理「周末 + 法定节假日全天谷价」，自己写会漏掉节假日。
 */
export function isPeak(timeMs) {
  return isDeepseekPeak(Math.floor(Number(timeMs) / 1000))
}

/** 是否在夜间时段（23:00-次日 8:00） */
export function isNight(timeMs) {
  const { hour } = beijingParts(timeMs)
  return hour >= NIGHT_START || hour < NIGHT_END
}

/** 今天是否法定节假日（全天谷价） */
export function isHoliday(timeMs) {
  const { year, date } = beijingParts(timeMs)
  const set = HOLIDAYS_BY_YEAR[String(year)]
  return !!(set && set.has(date))
}

/** 是否周末（全天谷价） */
export function isWeekend(timeMs) {
  const { dow } = beijingParts(timeMs)
  return dow === 0 || dow === 6
}

/** 解析倍率字符串 x0.11 -> 0.11 */
function parseRate(credits) {
  const s = String(credits || '').trim()
  const m = s.match(/^x?([\d.]+)$/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 计算一个模型在指定时刻的**实际倍率**。
 *
 * @param {object} model { id, credits, free, badges, contextWindow }
 * @param {number} timeMs
 * @returns {{rate:number, free:boolean, discount:string|null}}
 */
export function effectiveRate(model, timeMs) {
  const id = String((model && model.id) || '')
  const base = parseRate(model && model.credits)
  const free = model && model.free === true
  if (free) return { rate: 0, free: true, discount: null }

  // deepseek 系：官方峰谷
  if (PEAK_MODELS.indexOf(id) !== -1 && base !== null) {
    if (isPeak(timeMs)) return { rate: base, free: false, discount: null }
    return { rate: base * 0.5, free: false, discount: '非高峰 5 折' }
  }

  // 夜间促销：badge 区分「夜间免费」与「夜间折扣」
  //   - 夜间免费：23:00-次日 8:00 期间**实际免费**（rate 归 0）
  //   - 夜间折扣：23:00-次日 8:00 期间打折（默认 5 折，可配）
  // 非夜间时段则按原价，并把优惠信息附在说明里。
  const badges = Array.isArray(model && model.badges) ? model.badges : []
  const night = isNight(timeMs)
  const nightFree = badges.some((b) => String(b).indexOf('夜间免费') !== -1)
  const nightDiscount = badges.some((b) => String(b).indexOf('夜间折扣') !== -1)

  if (nightFree) {
    if (night) return { rate: 0, free: true, discount: '夜间免费生效中（23:00-次日 8:00）' }
    return { rate: base, free: false, discount: '23:00-次日 8:00 免费' }
  }
  if (nightDiscount) {
    if (night) {
      return {
        rate: base === null ? null : base * NIGHT_DISCOUNT_FACTOR,
        free: false,
        discount: '夜间折扣生效中（' + NIGHT_DISCOUNT_FACTOR * 10 + ' 折）',
      }
    }
    return { rate: base, free: false, discount: '23:00-次日 8:00 限时立减' }
  }

  return { rate: base, free: false, discount: null }
}

/**
 * 为一个场景推荐模型。
 *
 * @param {object[]} models 模型列表（含 id/credits/free/badges/contextWindow）
 * @param {object} opts { timeMs, minContext, limit }
 *   minContext 需要的上下文容量（0 表示不限制）
 * @returns {object[]} 推荐列表，每项含 rank 与理由
 */
/**
 * 为一个场景推荐模型。
 *
 * @param {object[]} models 模型列表（含 id/credits/free/badges/contextWindow）
 * @param {object} opts { timeMs, minContext, limit, limits, freeExhausted }
 *   minContext 需要的上下文容量（0 表示不限制）
 *   limits     实时限制状态：{ [modelId]: { rateLimitedUntil, contextOverflowAt } }
 *   freeExhausted 免费额度已用尽的模型 id 数组（不再按免费参与排序）
 * @returns {object[]} 推荐列表，每项含 rank 与理由
 */
export function recommend(models, opts) {
  const o = opts || {}
  const timeMs = Number(o.timeMs) || Date.now()
  const minContext = Number(o.minContext) || 0
  const limit = Number(o.limit) || 3
  const limits = o.limits || {}
  const exhausted = Array.isArray(o.freeExhausted) ? o.freeExhausted : []

  const scored = []
  for (const m of models || []) {
    const id = String((m && m.id) || '')
    if (!id) continue

    const ctx = Number(m && m.contextWindow) || 0
    // 上下文不够 → 直接淘汰
    if (minContext > 0 && ctx > 0 && ctx < minContext) continue

    const st = limits[id] || {}

    // ① 正在限流（429）→ 直接淘汰，推荐了也用不了
    if (typeof st.rateLimitedUntil === 'number' && st.rateLimitedUntil > timeMs) continue

    const eff = effectiveRate(m, timeMs)

    // ② 免费额度已用尽 → 不再按「免费」排序，改用它的付费替代倍率
    //    （hy3 用尽后实际按 hy3-x 的 x0.05 计费，所以退回原价而不是 0）
    const outOfQuota = exhausted.indexOf(id) !== -1
    const free = eff.free && !outOfQuota
    const rate = eff.rate === null ? Infinity : (outOfQuota && eff.rate === 0 ? QUOTA_EXHAUSTED_RATE : eff.rate)

    // ③ 之前因上下文过长失败过 → 降权（但不淘汰，可能是偶发）
    const overflowed = typeof st.contextOverflowAt === 'number' && st.contextOverflowAt > 0

    const prefIdx = PREFERRED.indexOf(id)
    const prefScore = prefIdx === -1 ? 99 : prefIdx

    // ④ 高单次消耗模型降权：倍率不高但每次实际花得多（长上下文/高思考）。
    //    2026-10-22 实测 space-bunny x0.08 却单次 18.75 积分。
    //    **放大系数直接进排序键**：只把它当同倍率时的次级键是不够的——
    //    space-bunny(0.08) 会因此排到 deepseek-v4.1-flash(0.11) 前面，
    //    而它单次实际花 18.75 vs deepseek 的 5.12。乘以 HEAVY_RATE_FACTOR
    //    让「预估实际成本」参与主排序，展示给用户的仍是官方倍率。
    const heavy = HEAVY_MODELS.indexOf(id) !== -1
    const sortRate = heavy && Number.isFinite(rate) ? rate * HEAVY_RATE_FACTOR : rate

    scored.push({
      id,
      name: m && m.name ? String(m.name) : id,
      credits: m && m.credits ? String(m.credits) : '',
      rate: rate,
      effectiveRate: rate,
      sortRate,
      free,
      outOfQuota,
      overflowed,
      heavy,
      discount: eff.discount,
      contextWindow: ctx,
      quotaLimited: QUOTA_MODELS.indexOf(id) !== -1,
      badges: Array.isArray(m && m.badges) ? m.badges : [],
      // 思考强度：倍率相同的情况下，默认思考越强 → 输出 token 越多 → 实际越贵
      defaultEffort: m && m.defaultEffort ? String(m.defaultEffort) : '',
      declaredEfforts: Array.isArray(m && m.declaredEfforts) ? m.declaredEfforts : [],
      effortLabel: effortLabelOf(m),
      effortWeight: effortWeightOf(m),
      // 排序键：可用免费 > 实际成本(含重型放大) > 思考成本 > 常用度 > 是否溢过出
      _free: free ? 0 : 1,
      _rate: sortRate,
      _effort: effortWeightOf(m),
      _overflow: overflowed ? 1 : 0,
      _pref: prefScore,
    })
  }

  scored.sort((a, b) => {
    if (a._free !== b._free) return a._free - b._free // 可用免费优先
    if (a._rate !== b._rate) return a._rate - b._rate // 实际成本低优先
    // 实际成本相同：默认思考强度低的更省（思考 token 按输出价计费）
    if (a._effort !== b._effort) return a._effort - b._effort
    if (a._overflow !== b._overflow) return a._overflow - b._overflow // 没溢过出的优先
    return a._pref - b._pref // 常用优先
  })

  return scored.slice(0, limit).map((s, i) => ({
    rank: i + 1,
    id: s.id,
    name: s.name,
    credits: s.credits,
    rate: s.effectiveRate,
    free: s.free,
    outOfQuota: s.outOfQuota,
    overflowed: s.overflowed,
    heavy: s.heavy,
    discount: s.discount,
    contextWindow: s.contextWindow,
    quotaLimited: s.quotaLimited,
    badges: s.badges,
    defaultEffort: s.defaultEffort,
    declaredEfforts: s.declaredEfforts,
    effortLabel: s.effortLabel,
    reason: buildReason(s, i, minContext),
  }))
}

/** 免费额度用尽后，按 hy3-x 的倍率计费（实测 hy3 额度用尽 → 账单记 hy3-x x0.05） */
const QUOTA_EXHAUSTED_RATE = 0.05

/** 推荐理由（给人看的一句话） */
function buildReason(s, index, minContext) {
  // 免费额度用尽：明确告知「已转付费」，用 effectiveRate（含替代倍率）
  if (s.outOfQuota) {
    return '免费额度已用尽，现按 x' + s.rate + ' 计费（等价 hy3-x）'
  }
  if (s.free) {
    const base = s.quotaLimited
      ? '免费，但有每日额度，用尽后转付费或需换模型'
      : '免费，不消耗积分，优先使用'
    const note = s.quotaLimited ? base : base + '；' + s.effortLabel
    // 正面描述适用场景，不说「效果不行」
    const suit = SUITABILITY[s.id]
    return suit ? note + '；适合：' + suit : note
  }
  const parts = []
  if (s.discount) parts.push(s.discount)
  // 重型模型：展示官方倍率，同时说明为何实际更贵（用户看到 x0.08 会疑惑
  // 为什么它排在 x0.11 后面）。倍率是每 token 单价，这类模型每次塞的 token
  // 特别多，所以实际花费高得多——这是成本事实，不是好坏评价。
  if (s.heavy) {
    parts.push('倍率 x' + s.rate + '，单次消耗高（实际成本约 x'
      + (Math.round(s.rate * HEAVY_RATE_FACTOR * 100) / 100) + '）')
  } else {
    parts.push('倍率 ' + (s.rate === null ? '未知' : 'x' + s.rate))
  }
  // 思考强度直接影响输出 token 量，必须让用户知道
  parts.push('思考' + s.effortLabel)
  if (minContext > 0 && s.contextWindow >= minContext) {
    parts.push('上下文 ' + Math.round(s.contextWindow / 1000) + 'K 满足需求')
  } else if (s.contextWindow > 0) {
    parts.push('上下文 ' + Math.round(s.contextWindow / 1000) + 'K')
  }
  if (s.overflowed) parts.push('曾因上下文过长失败')
  // 适用场景：正面描述「适合干什么」（用户 2026-10-22 明确要求）
  const suit = SUITABILITY[s.id]
  if (suit) parts.push('适合：' + suit)
  if (index > 0) parts.push('备选')
  return parts.join('；')
}

/**
 * 判断当前时段并给出场景化推荐。
 *
 * 推荐是**实时**的，三个实时信号会改变结果：
 *   - limits：429 限流中的模型直接淘汰
 *   - limits：曾因上下文过长失败的模型降权
 *   - freeExhausted：免费额度用尽的模型不再按免费排序
 *
 * @param {object[]} models
 * @param {object} opts { timeMs, limit, limits, freeExhausted }
 */
export function recommendByTime(models, opts) {
  const o = opts || {}
  const timeMs = Number(o.timeMs) || Date.now()
  const limit = Number(o.limit) || 3
  const limits = o.limits || {}
  const freeExhausted = o.freeExhausted || []
  // heavyModels 可在调用时覆盖（与 preferred 同机制）
  if (Array.isArray(o.heavyModels)) HEAVY_MODELS = o.heavyModels.map(String)

  // 时段标签要区分「周末」「法定节假日」「工作日高峰」——
  // DeepSeek 官方规则里周末与法定节假日都算谷期，但成因不同，展示上要分清。
  let peakLabel
  if (isPeak(timeMs)) {
    peakLabel = '工作日高峰（原价）'
  } else if (isHoliday(timeMs)) {
    peakLabel = '法定节假日（全天谷价）'
  } else if (isWeekend(timeMs)) {
    peakLabel = '周末（全天谷价）'
  } else {
    peakLabel = '工作日非高峰（5 折）'
  }

  return {
    ok: true,
    at: timeMs,
    peak: isPeak(timeMs),
    night: isNight(timeMs),
    holiday: isHoliday(timeMs),
    weekend: isWeekend(timeMs),
    peakLabel,
    // 回显实时状态，便于前端/用户确认推荐是依据当前实际情况算出来的
    live: {
      limited: Object.keys(limits).filter((id) => {
        const st = limits[id]
        return st && typeof st.rateLimitedUntil === 'number' && st.rateLimitedUntil > timeMs
      }),
      freeExhausted: freeExhausted.slice(),
    },
    scenarios: [
      {
        key: 'short',
        label: '短对话 / 问答',
        minContext: 0,
        models: recommend(models, { timeMs, minContext: 0, limit, limits, freeExhausted }),
      },
      {
        // 长文阈值取 90 万而不是 100 万：96 万的 Hy4 preview 才不会被误淘汰
        // （它是夜间免费模型，夜间实际免费，必须能进长文场景）
        key: 'long',
        label: '长文 / 大上下文（≥90 万）',
        minContext: 900000,
        models: recommend(models, { timeMs, minContext: 900000, limit, limits, freeExhausted }),
      },
    ],
  }
}

