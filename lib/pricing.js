// 三个平台的计费口径定义 + 峰谷时段判定 + 金额计算
//
// 平台口径差异（2026-10 实测/官方文档）：
//   1) deepseek-account —— DeepSeek 官方。峰谷规则：工作日 9-12、14-18 为高峰，
//      周末与法定节假日全天按谷价。缓存命中价 0.02/0.04。
//   2) fufu(阿里云百炼) —— 错峰规则：东八区 22:00-次日 8:00 为闲时，其余忙时。
//      缓存命中价 0.1/0.2（比官方贵 5 倍，这是两平台的关键差异）。
//   3) workbuddy —— 以「积分」计价，用余额采样反推，不走 token 单价。
//
// 单位统一为「元 / 百万 token」，数组含义 [闲时, 忙时]。

/** DeepSeek 官方 flash 价目 */
export const PRICE_DEEPSEEK = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }

/** 阿里云百炼 deepseek-v4.1-flash 价目（官方计费页，华北2 北京） */
export const PRICE_ALIYUN = { hit: [0.1, 0.2], miss: [1, 2], out: [4, 8] }

/** 官方高峰时段（北京时间小时区间，左闭右开） */
const DEEPSEEK_PEAK_HOURS = [[9, 12], [14, 18]]

/**
 * 法定节假日表（全天谷价）。
 *
 * 这是兜底数据：DSH 不下发节假日，官方规则又必须知道「今天是不是节假日」
 * 才能判断峰谷。表只覆盖已公布的年份，其他年份一律按谷价处理，
 * 避免把未知年份的普通工作日误判成高峰而多算钱。
 */
const HOLIDAYS_BY_YEAR = {
  2026: new Set([
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ]),
}

/** 取北京时间的日历字段 */
function beijingParts(timeSec) {
  const d = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    hour: d.getUTCHours(),
    dow: d.getUTCDay(), // 0=周日 6=周六
    year: d.getUTCFullYear(),
    date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
  }
}

/** 表内是否收录了该年份的节假日 */
export function hasHolidayTable(year) {
  return Object.prototype.hasOwnProperty.call(HOLIDAYS_BY_YEAR, String(year))
}

/**
 * DeepSeek 官方是否处于高峰时段。
 * 规则：工作日（周一至周五，不含法定节假日）9-12、14-18 为高峰；
 *       周末与法定节假日全天为谷价；节假日表未收录的年份按谷价（宁少算不多算）。
 */
export function isDeepseekPeak(timeSec) {
  if (!Number.isFinite(Number(timeSec))) return false
  const { hour, dow, year, date } = beijingParts(timeSec)
  if (dow === 0 || dow === 6) return false // 周末全天谷价
  const set = HOLIDAYS_BY_YEAR[String(year)]
  if (!set) return false // 未收录年份：按谷价，避免高估费用
  if (set.has(date)) return false // 法定节假日全天谷价
  for (const [start, end] of DEEPSEEK_PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/**
 * 阿里云百炼是否处于忙时。
 * 规则：东八区 22:00-次日 8:00 为闲时，其余（含周末与节假日）为忙时。
 */
export function isAliyunPeak(timeSec) {
  if (!Number.isFinite(Number(timeSec))) return false
  const { hour } = beijingParts(timeSec)
  return !(hour >= 22 || hour < 8)
}

/**
 * 依据 provider 判定使用哪套峰谷规则。
 * @returns {'deepseek'|'aliyun'} 口径标识
 */
export function peakRuleOf(provider) {
  const p = String(provider || '').toLowerCase()
  // 阿里云的 provider 在 DSH 里是用户自定义名（本项目实例中为 fufu），
  // 因此不能只认名字，还需结合端点判断；端点判断在 resolvePlatform 里做。
  if (p === 'deepseek-account' || p === 'deepseek' || p === 'deepseek-official') return 'deepseek'
  return 'aliyun'
}

/** 是否为 WorkBuddy 的 provider（按名字识别） */
export function isWorkbuddyProvider(provider, model) {
  const p = String(provider || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  return p.indexOf('workbuddy') !== -1 || m.indexOf('workbuddy') !== -1
}

/**
 * 按 token 明细计算金额（元）。
 * @param {{hit:number[],miss:number[],out:number[]}} price
 * @param {number} peakIndex 0=闲时 1=忙时
 */
export function costOf(price, peakIndex, tokens) {
  const i = peakIndex ? 1 : 0
  const hit = Number(tokens.cacheRead) || 0
  const miss = Number(tokens.input) || 0
  const out = Number(tokens.output) || 0
  return (hit / 1e6) * price.hit[i] + (miss / 1e6) * price.miss[i] + (out / 1e6) * price.out[i]
}

/** 固定小数位，避免浮点噪声累积 */
export function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6
}

export { HOLIDAYS_BY_YEAR }