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

/** 遵循 DeepSeek 官方峰谷的模型：工作日 9-12、14-18 高峰原价，其余 5 折 */
const PEAK_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro']

/** 夜间免费/折扣时段 23:00-次日 8:00（用于 hy4-preview、glm-5.2） */
const NIGHT_START = 23
const NIGHT_END = 8

/** 每日赠额类模型：额度有限，用尽转付费 */
const QUOTA_MODELS = ['hy3']

/** 用户常用模型（同分时优先） */
const PREFERRED = [
  'deepseek-v4.1-flash',
  'space-bunny',
  'glm-5.3-flash',
  'step-5-preview',
  'hy3',
]

/** 夜间折扣系数（0.5 = 5 折；官方未公布具体值，按常见错峰折扣取 5 折） */
const NIGHT_DISCOUNT_FACTOR = 0.5

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
export function recommend(models, opts) {
  const o = opts || {}
  const timeMs = Number(o.timeMs) || Date.now()
  const minContext = Number(o.minContext) || 0
  const limit = Number(o.limit) || 3

  const scored = []
  for (const m of models || []) {
    const id = String((m && m.id) || '')
    if (!id) continue

    const ctx = Number(m && m.contextWindow) || 0
    // 上下文不够 → 直接淘汰
    if (minContext > 0 && ctx > 0 && ctx < minContext) continue

    const eff = effectiveRate(m, timeMs)
    const rate = eff.rate === null ? Infinity : eff.rate

    // 免费模型额度有限：标出来但不淘汰
    const quotaLimited = QUOTA_MODELS.indexOf(id) !== -1

    const prefIdx = PREFERRED.indexOf(id)
    const prefScore = prefIdx === -1 ? 99 : prefIdx

    scored.push({
      id,
      name: m && m.name ? String(m.name) : id,
      credits: m && m.credits ? String(m.credits) : '',
      rate: eff.rate,
      free: eff.free,
      discount: eff.discount,
      contextWindow: ctx,
      quotaLimited,
      badges: Array.isArray(m && m.badges) ? m.badges : [],
      // 排序键：免费 > 倍率 > 常用度
      _free: eff.free ? 0 : 1,
      _rate: rate,
      _pref: prefScore,
    })
  }

  scored.sort((a, b) => {
    if (a._free !== b._free) return a._free - b._free // 免费优先
    if (a._rate !== b._rate) return a._rate - b._rate // 倍率低优先
    return a._pref - b._pref // 常用优先
  })

  return scored.slice(0, limit).map((s, i) => ({
    rank: i + 1,
    id: s.id,
    name: s.name,
    credits: s.credits,
    rate: s.rate,
    free: s.free,
    discount: s.discount,
    contextWindow: s.contextWindow,
    quotaLimited: s.quotaLimited,
    badges: s.badges,
    reason: buildReason(s, i, minContext),
  }))
}

/** 推荐理由（给人看的一句话） */
function buildReason(s, index, minContext) {
  if (s.free) {
    return s.quotaLimited
      ? '免费，但有每日额度，用尽后转付费或需换模型'
      : '免费，不消耗积分，优先使用'
  }
  const parts = []
  if (s.discount) parts.push(s.discount)
  parts.push('倍率 ' + (s.rate === null ? '未知' : 'x' + s.rate))
  if (minContext > 0 && s.contextWindow >= minContext) {
    parts.push('上下文 ' + Math.round(s.contextWindow / 1000) + 'K 满足需求')
  } else if (s.contextWindow > 0) {
    parts.push('上下文 ' + Math.round(s.contextWindow / 1000) + 'K')
  }
  if (index > 0) parts.push('备选')
  return parts.join('；')
}

/**
 * 判断当前时段并给出场景化推荐。
 * 场景按上下文需求分两档：短文（<20 万）与长文（>=100 万）。
 */
export function recommendByTime(models, opts) {
  const o = opts || {}
  const timeMs = Number(o.timeMs) || Date.now()
  const limit = Number(o.limit) || 3

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
    scenarios: [
      {
        key: 'short',
        label: '短对话 / 问答',
        minContext: 0,
        models: recommend(models, { timeMs, minContext: 0, limit }),
      },
      {
        // 长文阈值取 90 万而不是 100 万：96 万的 Hy4 preview 才不会被误淘汰
        // （它是夜间免费模型，夜间实际免费，必须能进长文场景）
        key: 'long',
        label: '长文 / 大上下文（≥90 万）',
        minContext: 900000,
        models: recommend(models, { timeMs, minContext: 900000, limit }),
      },
    ],
  }
}
