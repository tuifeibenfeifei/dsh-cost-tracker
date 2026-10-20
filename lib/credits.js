// WorkBuddy 积分追踪
//
// 原理：WorkBuddy 以「积分」计价，官方未公布 token↔积分 的换算率，
// 因此不做单价估算，而是**采样余额、用差值反推消耗**：
//   每轮对话结束 → 查询当前剩余积分 → 与上一轮记录的余额相减 = 本轮消耗
//
// 数据来源：dsh-workbuddy-connect 插件暴露的宿主侧 HTTP 路由
//   GET /plugins/dsh-workbuddy-connect/status
//
// 鉴权实测（2026-10）：该路由只校验「Host 头是回环地址」+「Origin（若有）是
// 回环」。宿主进程内的 fetch 不带 Origin 头，直接放行，不需要任何会话凭据。
// 上游源码见 dsh-workbuddy-connect/lib/index.js 的 loopbackRequest()。

const STATUS_PATH = '/plugins/dsh-workbuddy-connect/status'

/** 单次采样结果 */
function summarize(payload) {
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
        badges: Array.isArray(m && m.badges) ? m.badges.map(String) : [],
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
      try {
        const payload = await this.fetchStatus(STATUS_PATH)
        const s = summarize(payload)
        if (!s) {
          this.lastError = 'unexpected-payload'
          return null
        }
        this.lastError = null
        return s
      } catch (e) {
        this.lastError = e && e.message ? String(e.message) : 'fetch-failed'
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

export { STATUS_PATH }
