// WorkBuddy 积分追踪
//
// 原理：WorkBuddy 以「积分」计价，官方未公布 token↔积分 的换算率，
// 因此不做单价估算，而是**采样余额、用差值反推消耗**：
//   每轮对话结束 → 查询当前剩余积分 → 与上一轮记录的余额相减 = 本轮消耗
//
// 数据来源（二选一，自动探测）：
//   新：dsh-connect-workbuddy 插件的宿主侧只读路由
//     GET /plugins/dsh-connect-workbuddy/usage?region=cn
//   旧：dsh-workbuddy-connect 插件的
//     GET /plugins/dsh-workbuddy-connect/status
//
// 鉴权实测（2026-10）：两个路由都只校验「Host 头是回环地址」+「Origin（若有）
// 是回环」。宿主进程内的 fetch 不带 Origin 头，直接放行，不需要任何会话凭据。
// 新插件源码见 dsh-connect-workbuddy/lib/index.js 的 registerWorkBuddyStatusRoute()。

const STATUS_PATH_NEW = '/plugins/dsh-connect-workbuddy/usage?region=cn'
const STATUS_PATH_OLD = '/plugins/dsh-workbuddy-connect/status'

/** 单次采样结果（新插件 dsh-connect-workbuddy 的 /usage 结构） */
function summarizeNew(payload) {
  // 实测 2026-10-22：新插件 /usage 响应**同时**包含顶层 `credits`（含 packages 余额）
  // 与 `models[]`（新结构，字段是 creditMultiplier / promos / reasoning）。
  // 因此不能靠「有无顶层 credits」来区分新旧——旧插件也有 credits。
  // 真正能区分的是 models 内字段：新结构每个模型带 creditMultiplier，
  // 旧结构每个模型带 credits/free/badges。优先检测新结构特征。
  if (!payload || typeof payload !== 'object') return null
  const models = Array.isArray(payload.models) ? payload.models : []
  const looksNew = models.some(
    (m) => m && typeof m.creditMultiplier === 'number'
  )
  if (!looksNew) return null // 没有新结构特征 → 交给旧解析
  const accounts = Array.isArray(payload.pool && payload.pool.accounts)
    ? payload.pool.accounts
    : []
  let total = 0
  for (const a of accounts) total += Number(a && a.credits) || 0
  if (!accounts.length) return null
  const packages = accounts.map((a) => ({
    name: String(a && a.accountName ? a.accountName : ''),
    remain: Number(a && a.credits) || 0,
    size: Number(a && a.credits) || 0,
    endTimeMs: Number(a && a.nearestExpiryMs) || 0,
  }))
  const mapped = models.map((m) => {
    // 只保留「当前生效」的促销。上游下发的 promos 不会自动摘掉已过期的活动：
    // 实测 2026-10-26，step-5-preview 的「独家限免」validUntil 已过（10-26 00:00），
    // creditMultiplier 也已恢复 0.33 正常计费，但 promo 仍随 /usage 下发，
    // 于是标签一直显示「免费/限免」。validFrom / validUntil 都是绝对毫秒时间戳，
    // 直接与当前时间比较即可；不带 schedule 的 promo 视为常驻。
    const nowMs = Date.now()
    const promos = (Array.isArray(m && m.promos) ? m.promos : []).filter((p) => {
      const schedule = (p && p.schedule) || null
      if (!schedule) return true
      const from = Number(schedule.validFrom) || 0
      const until = Number(schedule.validUntil) || 0
      if (from && nowMs < from) return false
      if (until && nowMs >= until) return false
      return true
    })
    const badges = [...new Set(
      promos
        .map((p) => p && p.badge && p.badge.label)
        .filter(Boolean)
        .map(String)
    )]
    // ⚠️ 剔除「夜间折扣」：这个说法是错的。
    // deepseek 系模型遵循官方峰谷规则——工作日 9-12/14-18 高峰原价，
    // 其余时段（含中午 12-14、晚间 18-次日 9、周末与法定节假日全天）谷时 5 折。
    // 上游却只给一个「夜间折扣」，让人以为只有半夜才打折。
    // 在数据源头删掉，下游任何渲染者（本插件 client、DSH 内置标签插件、
    // 其他第三方 UI）都不会再显示它；时段折扣由 recommend.js 的
    // effectiveRate 按当前时刻计算，展示为「谷时5折 / 高峰原价」。
    const badgesSanitized = badges.filter((b) => b.indexOf('夜间折扣') === -1)
    // 只有 creditMultiplier===0 才是真·免费（不消耗积分）。
    // 不能把「带徽标」算成免费——hy4-preview 的「夜间免费」只是 23:00-08:00 免，
    // 白天仍按 x0.29 计费。徽标交给 recommend.js 的 effectiveRate 按时段判断。
    const free = Number(m && m.creditMultiplier) === 0
    const reasoning = (m && m.reasoning) || {}
    return {
      id: String(m && m.id ? m.id : ''),
      name: String(m && m.name ? m.name : ''),
      credits: m && m.creditMultiplier !== undefined ? String(m.creditMultiplier) : '',
      free,
      badges: badgesSanitized,
      contextWindow:
        m && typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : null,
      declaredEfforts: Array.isArray(reasoning.supportedEfforts)
        ? reasoning.supportedEfforts.map(String)
        : [],
      defaultEffort: reasoning.defaultEffort ? String(reasoning.defaultEffort) : '',
    }
  })
  return {
    total,
    packages,
    models: mapped,
    at: Date.now(),
    signedIn: String(payload.status || '') === 'signed-in',
    status: String(payload.status || ''),
    // 新插件用 tokenExpiresAtMs；顶层 credits 里也有 expiresAtMs 兜底
    expiresAtMs:
      Number(payload.tokenExpiresAtMs) ||
      Number(payload.credits && payload.credits.expiresAtMs) ||
      0,
    account: payload.accountName ? String(payload.accountName) : '',
  }
}

/** 单次采样结果（旧插件结构） */
function summarizeOld(payload) {
  if (!payload || typeof payload !== 'object') return null
  const credits = payload.credits
  if (!credits || typeof credits !== 'object') return null
  const total = Number(credits.total)
  if (!Number.isFinite(total)) return null
  const packages = Array.isArray(credits.accounts)
    ? credits.accounts.map((a) => ({
        name: String(a && a.packageName ? a.packageName : ''),
        remain: Number(a && a.remain) || 0,
        size: Number(a && a.size) || 0,
        endTimeMs: Number(a && a.endTimeMs) || 0,
      }))
    : []
  const models = Array.isArray(payload.models)
    ? payload.models.map((m) => ({
        id: String(m && m.id ? m.id : ''),
        name: String(m && m.name ? m.name : ''),
        credits: m && m.credits !== undefined ? String(m.credits) : '',
        free: m && m.free === true,
        badges: [...new Set(Array.isArray(m && m.badges) ? m.badges.map(String) : [])]
          .filter((b) => b.indexOf('夜间折扣') === -1),
        // 上下文容量与思考强度：详情浮层要用，缺省为 null / 空数组
        contextWindow: m && typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : null,
        declaredEfforts: Array.isArray(m && m.declaredEfforts) ? m.declaredEfforts.map(String) : [],
        defaultEffort: m && m.defaultEffort ? String(m.defaultEffort) : '',
      }))
    : []
  return {
    total,
    packages,
    models,
    at: Date.now(),
    signedIn: String(payload.status || '') === 'signed-in',
    status: String(payload.status || ''),
    expiresAtMs: Number(payload.expiresAt) || 0,
    account: payload.visibility && payload.visibility.account ? String(payload.visibility.account) : '',
  }
}

function summarize(payload) {
  return summarizeNew(payload) || summarizeOld(payload)
}

/**
 * 积分追踪器。持有「上一次采样」作为基准，每轮结束后采一次样算差值。
 */
export class CreditTracker {
  /**
   * @param {object} opts
   * @param {(path: string) => Promise<any>} opts.fetchStatus 宿主侧注入的状态查询函数
   * @param {number} [opts.staleMs] 超过此时长未采样则视为基准失效（默认 30 分钟）
   */
  constructor(opts = {}) {
    this.fetchStatus = opts.fetchStatus
    this.staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : 30 * 60 * 1000
    this.last = null // 上一次采样
    this.lastError = null
    this.inFlight = null
  }

  /** 采一次样，返回摘要或 null */
  async sample() {
    if (typeof this.fetchStatus !== 'function') {
      this.lastError = 'no-fetch-callback'
      return null
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      // 先试新插件路由；404/失败再退回旧路由（两插件并存或只装其一都能工作）
      try {
        for (const path of [STATUS_PATH_NEW, STATUS_PATH_OLD]) {
          try {
            const payload = await this.fetchStatus(path)
            const s = summarize(payload)
            if (s) {
              this.lastError = null
              return s
            }
          } catch (e) {
            this.lastError = e && e.message ? String(e.message) : 'fetch-failed'
          }
        }
        return null
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /**
   * 刷新快照但不结算（/health、/models 这类只读查询用）。
   *
   * 与 settleTurn 的区别：这里**不**推进基准，避免「看一眼健康状态」
   * 就吃掉上一轮的余额基准、导致真实结算时算不出本轮消耗。
   * 只更新 last（供 health()/snapshot() 读取），不动 baseline。
   */
  async refresh() {
    const now = await this.sample()
    if (now) this.last = now
    return now
  }

  /**
   * 一轮对话结束后调用：采样并与基准比较，得到本轮消耗。
   *
   * ⚠️ WorkBuddy 的积分扣减**有延迟**（实测数秒后才入账）。
   * 轮次刚结束时立即采样，常常读到「还没扣」的余额，diff=0 会被误判成免费。
   * 所以这里先按老逻辑算一次；调用方若发现 spent 为 0/null，应隔几秒
   * 调 confirmTurn() 复查并回写该轮记录（见 lib/index.js 的 scheduleConfirm）。
   *
   * @returns {{ok:boolean, spent:number|null, before:number|null, after:number|null,
   *            reason?:string, signedIn?:boolean, expiresAtMs?:number}}
   */
  async settleTurn() {
    const now = await this.sample()
    if (!now) {
      return { ok: false, spent: null, before: null, after: null, reason: this.lastError || 'sample-failed' }
    }

    const prev = this.last
    this.last = now
    // 首次采样：只建立基准，无法算差值
    if (!prev) {
      return {
        ok: true, spent: null, before: null, after: now.total, reason: 'baseline-established',
        signedIn: now.signedIn, expiresAtMs: now.expiresAtMs,
      }
    }

    // 基准过旧：差值会把中间时段的消耗都算进来，故不报数
    if (now.at - prev.at > this.staleMs) {
      return {
        ok: true, spent: null, before: prev.total, after: now.total, reason: 'baseline-stale',
        signedIn: now.signedIn, expiresAtMs: now.expiresAtMs,
      }
    }

    const diff = prev.total - now.total
    // 余额上升 = 充值/发放新权益，不是消耗；此时不报数，仅更新基准
    if (diff < 0) {
      return {
        ok: true, spent: null, before: prev.total, after: now.total, reason: 'balance-increased',
        signedIn: now.signedIn, expiresAtMs: now.expiresAtMs,
      }
    }
    // diff === 0：可能真的免费，也可能扣减尚未入账 —— 标记出来，让调用方复查
    return {
      ok: true, spent: diff, before: prev.total, after: now.total,
      reason: diff === 0 ? 'zero-pending' : undefined,
      signedIn: now.signedIn, expiresAtMs: now.expiresAtMs,
    }
  }

  /**
   * 延迟复查：隔一段时间再采样，与「本轮开始前的余额」比较。
   *
   * 用于 settleTurn 返回 zero-pending 的情况——扣减延迟导致第一次读到 0。
   * 注意这里**不推进 this.last 之外的状态**：基准用调用方传进来的 before，
   * 避免把复查期间其他轮次的消耗算进本轮。
   *
   * @param {number|null} before 本轮开始前的积分总额
   * @returns {{ok:boolean, spent:number|null, after:number|null, reason?:string}}
   */
  async confirmTurn(before) {
    const now = await this.sample()
    if (!now) return { ok: false, spent: null, after: null, reason: this.lastError || 'sample-failed' }
    if (typeof before !== 'number' || !Number.isFinite(before)) {
      return { ok: false, spent: null, after: now.total, reason: 'no-baseline' }
    }
    const diff = before - now.total
    if (diff < 0) {
      // 复查期间充值了，无法判断本轮消耗
      return { ok: true, spent: null, after: now.total, reason: 'balance-increased' }
    }
    // 复查后同步基准，避免后续轮次重复计算这段差值
    this.last = now
    return { ok: true, spent: diff, after: now.total, reason: diff > 0 ? 'confirmed' : 'still-zero' }
  }

  /**
   * 账号健康检查：未登录 / 令牌即将到期。
   * 覆盖三种情况：未登录、令牌已过期、令牌 3 天内到期。
   */
  health() {
    const last = this.last
    if (!last) {
      return { level: 'unknown', reason: this.lastError || 'no-sample-yet' }
    }
    if (!last.signedIn) return { level: 'error', reason: 'signed-out' }
    const left = last.expiresAtMs - Date.now()
    if (left <= 0) return { level: 'error', reason: 'token-expired', expiresAtMs: last.expiresAtMs }
    if (left < 3 * 24 * 3600 * 1000) {
      return { level: 'warn', reason: 'token-expiring', expiresAtMs: last.expiresAtMs, leftMs: left }
    }
    return { level: 'ok', expiresAtMs: last.expiresAtMs, leftMs: left }
  }

  /** 最近一次采样的原始摘要（供路由输出） */
  snapshot() {
    return this.last ? { ...this.last } : null
  }
}

/**
 * 前置插件探测：本插件的 WorkBuddy 功能完全依赖 WorkBuddy 连接插件。
 *
 * 为什么必须探测：DSH **没有声明式插件间依赖机制**（package.json 里没有
 * dsh.requires 之类字段，宿主也不解析插件间依赖）。用户只装
 * dsh-cost-tracker 而不装 WorkBuddy 连接插件时，积分/模型/推荐全部拿不到
 * 数据，却只会显示「—」或「暂无推荐」——看不出是缺插件还是没登录。
 *
 * 探测方式：直接请求两个已知插件的只读路由，看是否 200。
 *   - dsh-connect-workbuddy（新版，5.x）→ /usage?region=cn
 *   - dsh-workbuddy-connect（旧版，0.7.x）→ /status
 * 任一可达即视为依赖满足。
 *
 * @param {string} baseOrigin web 服务器 origin，如 http://127.0.0.1:57310
 * @param {(url:string, init?:object)=>Promise<{ok:boolean,status:number}>} fetchImpl
 * @returns {Promise<{available:boolean, plugin:string|null, reason?:string}>}
 */
export async function detectWorkbuddyProvider(baseOrigin, fetchImpl) {
  if (!baseOrigin) return { available: false, plugin: null, reason: 'no-web-origin' }
  const candidates = [
    { plugin: 'dsh-connect-workbuddy', path: '/plugins/dsh-connect-workbuddy/usage?region=cn' },
    { plugin: 'dsh-workbuddy-connect', path: '/plugins/dsh-workbuddy-connect/status' },
  ]
  for (const c of candidates) {
    try {
      const res = await fetchImpl(baseOrigin + c.path, {
        headers: { accept: 'application/json' },
      })
      // 200 = 插件在；404 = 没装；401/403 = 装了但未登录（插件本身在）
      if (res && (res.ok || res.status === 401 || res.status === 403)) {
        return { available: true, plugin: c.plugin }
      }
    } catch { /* 换下一个候选 */ }
  }
  return { available: false, plugin: null, reason: 'no-workbuddy-connect-plugin' }
}

export { STATUS_PATH_NEW, STATUS_PATH_OLD }
