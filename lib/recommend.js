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
 * 2026-10-22 实测：space-bunny 倍率仅 x0.08（与 glm-5.3-flash 同价），
 * 但单次均值 18.75 积分，是后者（15.16）的 1.24 倍、是 deepseek-flash
 * （5.12）的 3.7 倍。19 次请求烧掉 356 积分（占 16.7%）。
 * 倍率排序完全看不出这种模型的问题，必须单独降权。
 */
let HEAVY_MODELS = ['space-bunny', 'glm-5.3', 'glm-5.3-flash']

/** 应用用户配置（null/undefined 项保留默认） */
export function applyUserConfig(cfg) {
  const c = cfg || {}
  if (Array.isArray(c.peakModels) && c.peakModels.length) PEAK_MODELS = c.peakModels.map(String)
  if (Array.isArray(c.quotaModels) && c.quotaModels.length) QUOTA_MODELS = c.quotaModels.map(String)
  if (Array.isArray(c.preferred) && c.preferred.length) PREFERRED = c.preferred.map(String)
  if (Array.isArray(c.heavyModels)) HEAVY_MODELS = c.heavyModels.map(String)
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
    //    这不是「贵」，是「每次都吃很多」，在倍率相同的模型里应排在后面。
    const heavy = HEAVY_MODELS.indexOf(id) !== -1

    scored.push({
      id,
      name: m && m.name ? String(m.name) : id,
      credits: m && m.credits ? String(m.credits) : '',
      rate: rate,
      effectiveRate: rate,
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
      // 排序键：可用免费 > 倍率 > 思考成本 > 不重型 > 常用度 > 是否溢过出
      _free: free ? 0 : 1,
      _rate: rate,
      _effort: effortWeightOf(m),
      _heavy: heavy ? 1 : 0,
      _overflow: overflowed ? 1 : 0,
      _pref: prefScore,
    })
  }

  scored.sort((a, b) => {
    if (a._free !== b._free) return a._free - b._free // 可用免费优先
    if (a._rate !== b._rate) return a._rate - b._rate // 倍率低优先
    // 倍率相同：默认思考强度低的更省（思考 token 按输出价计费）
    if (a._effort !== b._effort) return a._effort - b._effort
    // 倍率与思考都相同：非重型模型优先（单次实际消耗更低）
    if (a._heavy !== b._heavy) return a._heavy - b._heavy
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
    return s.quotaLimited ? base : base + '；' + s.effortLabel
  }
  const parts = []
  if (s.discount) parts.push(s.discount)
  parts.push('倍率 ' + (s.rate === null ? '未知' : 'x' + s.rate))
  // 思考强度直接影响输出 token 量，必须让用户知道
  parts.push('思考' + s.effortLabel)
  if (minContext > 0 && s.contextWindow >= minContext) {
    parts.push('上下文 ' + Math.round(s.contextWindow / 1000) + 'K 满足需求')
  } else if (s.contextWindow > 0) {
    parts.push('上下文 ' + Math.round(s.contextWindow / 1000) + 'K')
  }
  if (s.overflowed) parts.push('曾因上下文过长失败')
  if (s.heavy) parts.push('单次消耗偏高（长上下文/高思考），非必要不用')
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

