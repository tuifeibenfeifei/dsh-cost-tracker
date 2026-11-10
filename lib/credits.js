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

/**
 * 遵循「DeepSeek 官方峰谷」规则的模型。
 *
 * 它们的上游 promo 标成「夜间折扣」，但 schedule.daily 实际是全天
 * (0:00–23:59)，hover 明说「工作日 09:00–12:00、14:00–18:00 高峰原价，
 * 非高峰期 5 折」——这是 deepseek 官方峰谷，不是「只有半夜打折」。
 * 本地 recommend.js 的 effectiveRate 已按 peak 精确算，客户端展示
 * 「谷时5折 / 高峰原价」。若保留上游「夜间折扣」会自相矛盾，故在数据源头剔除。
 *
 * ⚠️ 除这两个之外的模型一律不删：例如 glm-5.2 的「夜间折扣」是**真实**
 * 23:00–次日 8:00 五折（schedule.daily 23:00–7:50 + discount.multiplier=0.5），
 * 2026-11-05 之前全局一刀切把它也误删了（用户反馈标签没更新）。
 */
const PEAK_RULE_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro']

/** 是否是「官方峰谷」模型（其误导性「夜间折扣」badge 需剔除） */
function isPeakRuleModel(id) {
  return PEAK_RULE_MODELS.indexOf(String(id || '')) !== -1
}

/**
 * 单轮积分的合理上限。超过它一定是采样口径异常，不是真实消耗。
 *
 * 实测（2026-11-10 逐轮核对）：正常轮次 0.1~25 积分，极端长上下文几十。
 * 取 200 是**宽松**阈值——足以放过任何真实的大轮次，又能拦住 730 那种
 * 「账号池只返回了部分账号」造成的假跳变。
 */
const MAX_TURN_SPEND = 200

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
  // ⚠️ 按账号记账的余额明细（2026-11-10 新增）。
  //
  // 为什么必须逐账号：WorkBuddy 是 5 个账号的池子，`spent` 原本靠
  // 「两次采样的总额之差」反推。只要某次采样漏了账号（账号被临时排除、
  // 请求超时、池子在重组），总额就会凭空少几百，差额被记成「这一轮消耗」——
  // 实测出现过单轮 730 积分的假账。
  // 逐账号比对可以识别这种情况：只对「两次采样都出现」的账号算差值，
  // 缺席账号的余额变化一律不计，从根上消除口径不一致的噪声。
  const balances = {}
  for (const a of accounts) {
    const id = String((a && (a.accountId || a.accountName)) || '')
    if (!id) continue
    balances[id] = Number(a && a.credits) || 0
  }
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
    // ⚠️ 只对「峰谷规则模型」剔除误导性的「夜间折扣」badge。
    // deepseek 系遵循官方峰谷——工作日 9-12/14-18 高峰原价，其余时段
    // （含中午、晚间、周末、法定节假日全天）谷时 5 折。上游却只给一个
    // 「夜间折扣」，让人以为只有半夜才打折。本地 recommend.js 已按
    // effectiveRate 精确计算，客户端展示「谷时5折 / 高峰原价」，故删掉
    // 这个会自相矛盾的 badge。
    //
    // 其他模型（如 glm-5.2 真实 23:00–次日 8:00 五折，discount.multiplier=0.5）
    // **必须保留**：删了它们就没有夜间折扣信息了。2026-11-05 之前这里全局
    // 一刀切过滤，误伤了 glm-5.2（用户反馈「标签没更新」）。
    const badgesSanitized = isPeakRuleModel(m && m.id)
      ? badges.filter((b) => b.indexOf('夜间折扣') === -1)
      : badges
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
    // 逐账号余额快照：{ [accountId]: credits }。用于「按账号记账」，
    // 缺席账号在记账时被排除，避免口径不一致造成的假消耗。
    balances,
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
        // 与 summarizeNew 一致：只对遵循官方峰谷的 deepseek 系剔除「夜间折扣」，
        // 其他模型（如 glm-5.2 真实夜间五折）必须保留。
        badges: [...new Set(Array.isArray(m && m.badges) ? m.badges.map(String) : [])]
          .filter((b) => !(isPeakRuleModel(m && m.id) && b.indexOf('夜间折扣') !== -1)),
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
 * 按账号计算两次采样之间的真实消耗（2026-11-10 新增，核心修复）。
 *
 * 为什么不能用总额差：账号池里只要有账号在某次采样中缺席（被限流排除、
 * 请求超时、池子重组），总额就会凭空少几百，这个差额会被误记成
 * 「这一轮花的积分」。实测出现过单轮 730 积分的假账。
 *
 * 做法：只对**两次采样都出现**的账号比较余额，缺席账号的变化完全忽略。
 * 这样口径不一致带来的噪声从根上消除。
 *
 * 返回 null 表示无法计算（缺少按账号明细，例如旧插件结构），
 * 调用方应退回总额差法。
 *
 * @param {object|null} prev 上一次采样
 * @param {object|null} now  本次采样
 * @returns {{spent:number, compared:number, missing:number}|null}
 */
function perAccountSpend(prev, now) {
  const a = prev && prev.balances
  const b = now && now.balances
  if (!a || !b) return null
  const keys = Object.keys(a)
  if (!keys.length) return null
  let spent = 0
  let compared = 0
  let missing = 0
  for (const id of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, id)) { missing += 1; continue }
    const before = Number(a[id])
    const after = Number(b[id])
    if (!Number.isFinite(before) || !Number.isFinite(after)) { missing += 1; continue }
    compared += 1
    const d = before - after
    // 单个账号余额上升（充值）或异常跳变都不计入：
    // 充值会让差值变负；跳变说明该账号数据不可信。
    if (d > 0 && d <= MAX_TURN_SPEND) spent += d
  }
  if (!compared) return null
  return { spent, compared, missing }
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
    // ⚠️ 采样到「总额 0」几乎一定是账号池没返回余额（账号被移除/未登录/接口异常），
    // 真实余额不会整笔归零。绝不能把 prev.total - 0 当作本轮消耗——那会一次性
    // 把整个余额记成花费（实测 2026-10-26：hy3 三条各 6731.99 分，当天用量被抬到 2 万）。
    // 这里也**不推进** this.last：0 不是有效基准，留着旧基准反而更安全
    // （跨度太大时会被 staleMs 判为 baseline-stale，只是不报数，不会算错）。
    if (!(Number(now.total) > 0)) {
      return {
        ok: false, spent: null, before: prev ? prev.total : null, after: now.total,
        reason: 'invalid-total',
        signedIn: now.signedIn, expiresAtMs: now.expiresAtMs,
      }
    }
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
    // ⚠️ 优先用按账号差值（2026-11-10）：总额差在账号缺席时会把
    // 「缺失账号的余额」误记成消耗。逐账号比对只采信两次都出现的账号。
    //
    // 注意：`missing > 0`（有账号缺席）**不是**放弃的理由，恰恰是这套算法
    // 存在的意义——缺席账号的变化被排除，剩余账号照常记账。
    // 只有「一个账号都没法比」时（pa 为 null）才退回总额差法。
    const pa = perAccountSpend(prev, now)
    if (pa) {
      this.last = now
      return {
        ok: true, spent: pa.spent, before: prev.total, after: now.total,
        reason: pa.spent === 0 ? 'zero-pending' : undefined,
        accountsCompared: pa.compared,
        accountsMissing: pa.missing,
        signedIn: now.signedIn, expiresAtMs: now.expiresAtMs,
      }
    }
    // 单轮跳变防护：同 confirmTurn。账号池某次只返回部分账号时，
    // prev 与 now 的口径不同，差额是「缺失账号的余额」而不是消耗。
    if (diff > MAX_TURN_SPEND) {
      return {
        ok: true, spent: null, before: prev.total, after: now.total,
        reason: 'implausible-jump', implausibleSpent: diff,
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
    const prevSnap = this.last
    const now = await this.sample()
    if (!now) return { ok: false, spent: null, after: null, reason: this.lastError || 'sample-failed' }
    if (typeof before !== 'number' || !Number.isFinite(before)) {
      return { ok: false, spent: null, after: now.total, reason: 'no-baseline' }
    }
    // 同上：总额 0 = 账号池没返回余额，不是「扣光了」
    if (!(Number(now.total) > 0)) {
      return { ok: false, spent: null, after: now.total, reason: 'invalid-total' }
    }
    const diff = before - now.total
    if (diff < 0) {
      // 复查期间充值了，无法判断本轮消耗
      return { ok: true, spent: null, after: now.total, reason: 'balance-increased' }
    }
    // ⚠️ 优先用按账号差值（2026-11-10）。
    // `before` 只是总额，无法判断口径是否一致；而 this.last 里带着上次的
    // 逐账号明细，可以逐账号比对。只有当上次快照确实对应「本轮开始前」时
    // 才可信——即上次采样的总额等于传给我们的 before。
    const sameBaseline = prevSnap && Math.abs(Number(prevSnap.total) - Number(before)) < 0.01
    const pa = sameBaseline ? perAccountSpend(prevSnap, now) : null
    if (pa) {
      this.last = now
      return {
        ok: true, spent: pa.spent, after: now.total,
        reason: pa.spent === 0 ? 'still-zero' : 'confirmed',
        accountsCompared: pa.compared,
        accountsMissing: pa.missing,
      }
    }
    // ⚠️ 单轮消耗上限防护（2026-11-10 实测故障）。
    //
    // 故障：10:35 一轮记了 730.72 积分。原因是 before 采样到的是**不完整的
    // 账号池**（少了约 730 分，WorkBuddy 池子里 5 个账号，某次只返回了部分），
    // after 才是完整余额 13798.18。差额被当成「这一轮花掉的」。
    // 证据：下一轮（11:04）的 before 又回到 14493.49 正常量级——钱根本没少。
    //
    // 单轮真实消耗的量级：实测正常轮次 0.1~25 积分，极端长上下文也就几十。
    // 730 这种数量级只可能是「采样口径变化」，不是消耗。这里用宽松阈值拦住
    // 明显不合理的跳变，宁可漏记一轮（标记待确认），也不虚记几百积分。
    if (diff > MAX_TURN_SPEND) {
      return {
        ok: true, spent: null, after: now.total,
        reason: 'implausible-jump',
        implausibleSpent: diff,
      }
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

export { STATUS_PATH_NEW, STATUS_PATH_OLD, MAX_TURN_SPEND, perAccountSpend }
