// dsh-cost-tracker 宿主侧入口
//
// 职责：
//   1) 监听会话事件，按 provider 选择计费口径，算出每轮花费
//      - DeepSeek 官方 / 阿里云：token × 峰谷单价
//      - WorkBuddy：积分余额差反推
//   2) 阿里云抵用券：token 估算 + 官方 CSV 校准（见 lib/aliyunCsv.js）
//   3) 暴露 HTTP 路由供前端读取统计、余额与账号健康状态
//
// 设计约束：
//   - 只读：不修改任何 provider 配置，不接管 shell，不写用户的业务文件
//   - 状态文件只写 $DSH_HOME/.cost-tracker.json
//   - 日志与接口输出一律脱敏（不出现完整 uid / token / API Key）
//   - 所有外部调用 try/catch，失败不影响 DSH 主流程
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRICE_DEEPSEEK, PRICE_ALIYUN,
  isDeepseekPeak, isAliyunPeak, isWorkbuddyProvider,
  hasHolidayTable, peakRuleOf,
  costOf, round6,
} from './pricing.js'
import { CreditTracker } from './credits.js'
import { calibrateFromCsv, maskAccount } from './aliyunCsv.js'
import { rankWorkbuddyModels, badgeOf, GLOBAL_PRIORITY } from './modelOrder.js'

const NAME = 'cost-tracker'
const inject = ['llm', 'webServer']

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 状态文件名（$DSH_HOME 下） */
const STATE_FILENAME = '.cost-tracker.json'

/** 阿里云抵用券默认初始值（2026-10-19 由用户提供） */
const DEFAULT_ALIYUN_BALANCE = 226.086813663

/** 状态文件路径：优先 $DSH_HOME，退回包目录 */
function stateFileCandidates() {
  const home = process.env.DSH_HOME || ''
  const out = []
  if (home) out.push(path.join(home, STATE_FILENAME))
  out.push(path.join(PKG_ROOT, STATE_FILENAME))
  return out
}

/** 默认状态 */
function defaultState() {
  return {
    version: 2,
    turns: [],
    totals: {
      turns: 0,
      costTokenBased: 0,
      workbuddyCredits: 0,
    },
    aliyun: {
      balance: DEFAULT_ALIYUN_BALANCE,
      balanceAt: '2026-10-19',
      calibratedAtMs: 0,
      source: 'manual',
    },
  }
}

/** 读取持久化状态；损坏或不存在时返回默认值 */
function readState() {
  for (const p of stateFileCandidates()) {
    try {
      if (!fs.existsSync(p)) continue
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (j && typeof j === 'object') {
        const base = defaultState()
        return {
          ...base,
          ...j,
          totals: { ...base.totals, ...(j.totals || {}) },
          aliyun: { ...base.aliyun, ...(j.aliyun || {}) },
        }
      }
    } catch { /* 不存在或损坏都视为空状态 */ }
  }
  return defaultState()
}

/** 原子写状态 */
function writeState(state) {
  const body = JSON.stringify(state, null, 0)
  for (const p of stateFileCandidates()) {
    try {
      const tmp = p + '.tmp'
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, p)
      return true
    } catch { /* 换下一个候选路径 */ }
  }
  return false
}

function apply(ctx, config) {
  const cfg = config || {}
  const log = (msg) => { try { ctx.logger.info('dsh-cost-tracker: ' + msg) } catch { /* 无 logger 时忽略 */ } }
  const warn = (msg) => { try { ctx.logger.warn('dsh-cost-tracker: ' + msg) } catch { /* 同上 */ } }

  let stopped = false
  const disposers = []

  // ---------- 状态 ----------
  let state = readState()
  if (!Array.isArray(state.turns)) state.turns = []

  /** 每轮聚合桶：sessionId -> { turn, tokens, byModel, startedAt } */
  const turnAggs = new Map()

  /** 模型额度/限制状态：modelId -> { rateLimitedUntil, contextOverflowAt, note } */
  const limitsByModel = {}

  // ---------- Web 端口来源 ----------
  /**
   * 拿本机回环地址（形如 http://127.0.0.1:PORT）。
   *
   * 实测 process.env.DSH_WEB_PORT 不存在，不能用环境变量。
   * ctx.webServer 只在 inject(['webServer']) 进入的作用域内可用：
   * 直接在 apply(ctx) 顶层访问会抛
   * "cannot get property webServer without inject"。
   *
   * 因此这里分三级：
   *   1) inject 作用域里缓存的 webServer 引用（最可靠）
   *   2) ctx.get('webApp').getAdvertisedUrl()
   *   3) ctx.get('webServer')（部分宿主允许经 get 取服务）
   * 任何一级拿到就返回，全失败才返回空串。
   */
  let webServerRef = null

  function originOf() {
    // 1) inject 作用域缓存
    try {
      const ws = webServerRef
      if (ws && typeof ws.getOrigin === 'function') {
        const o = String(ws.getOrigin() || '')
        if (o) return o
      }
    } catch { /* 继续下一级 */ }
    // 2) webApp 广播的地址
    try {
      const app = ctx.get && ctx.get('webApp')
      if (app && typeof app.getAdvertisedUrl === 'function') {
        const u = String(app.getAdvertisedUrl() || '')
        if (u) return u.replace(/\/+$/, '')
      }
    } catch { /* 继续下一级 */ }
    // 3) 经 ctx.get 取 webServer 服务
    try {
      const ws = ctx.get && ctx.get('webServer')
      if (ws && typeof ws.getOrigin === 'function') {
        const o = String(ws.getOrigin() || '')
        if (o) {
          // 顺手补进缓存，后续调用不必再走 try
          webServerRef = ws
          return o
        }
      }
    } catch { /* 全失败 */ }
    return ''
  }

  // ---------- WorkBuddy 积分追踪 ----------
  async function fetchWorkbuddyStatus(routePath) {
    const base = originOf()
    if (!base) throw new Error('no web origin')
    const res = await fetch(base + routePath, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error('workbuddy status HTTP ' + res.status)
    return await res.json()
  }

  const credits = new CreditTracker({ fetchStatus: fetchWorkbuddyStatus })

  // ---------- 平台判定 ----------
  /**
   * 判定一次请求属于哪个平台。
   * 1) provider/model 含 workbuddy → workbuddy
   * 2) provider 是已知官方名 → deepseek
   * 3) llm.listProviders() 查到该 provider 的 baseURL 含 aliyuncs → aliyun
   * 4) 模型名含 deepseek 兜底 → aliyun（本机实际情形）
   */
  let providerCache = null
  let providerCacheAt = 0

  async function providerBaseUrls() {
    const now = Date.now()
    if (providerCache && now - providerCacheAt < 60000) return providerCache
    try {
      const svc = ctx.get && ctx.get('llm')
      if (svc && typeof svc.listProviders === 'function') {
        const list = await svc.listProviders()
        if (Array.isArray(list)) {
          const map = new Map()
          for (const x of list) {
            const key = String(x && (x.id || x.name || '')).toLowerCase()
            if (key) map.set(key, String(x.baseURL || x.baseUrl || ''))
          }
          providerCache = map
          providerCacheAt = now
          return map
        }
      }
    } catch { /* 服务不可用时不影响主流程 */ }
    return providerCache || new Map()
  }

  function resolvePlatform(provider, model, baseUrls) {
    const p = String(provider || '').toLowerCase()
    const m = String(model || '').toLowerCase()
    if (isWorkbuddyProvider(p, m)) return 'workbuddy'
    if (p === 'deepseek-account' || p === 'deepseek' || p === 'deepseek-official') return 'deepseek'
    const url = baseUrls ? String(baseUrls.get(p) || '') : ''
    if (url.toLowerCase().indexOf('aliyuncs') !== -1) return 'aliyun'
    // provider 名不是已知官方名，且没有端点提示时，
    // 用模型名兜底：deepseek 系列多半来自第三方兼容端点（本机为阿里云）
    if (m.indexOf('deepseek') !== -1) return 'aliyun'
    return 'deepseek'
  }

  function priceForPlatform(platform) {
    return platform === 'aliyun' ? PRICE_ALIYUN : PRICE_DEEPSEEK
  }

  function peakIndexOf(platform, timeSec) {
    if (platform === 'aliyun') return isAliyunPeak(timeSec) ? 1 : 0
    return isDeepseekPeak(timeSec) ? 1 : 0
  }

  // ---------- 会话事件 ----------
  /**
   * 判断一个 session/event 的 event.type 是否表示「一轮结束」。
   * DSH 0.2.1-rc.2 事件目录里没有名为 turn/end 的事件，这里按名字宽松匹配，
   * 命中不了就走 agent/turn-stopping 兜底（该事件确认存在）。
   */
  function isTurnEndType(type) {
    const t = String(type || '').toLowerCase()
    if (t === '') return false
    if (t.indexOf('turn') === -1) return false
    return t.indexOf('end') !== -1 || t.indexOf('stop') !== -1 || t.indexOf('finish') !== -1
  }

  function handleSessionEvent(sessionId, event) {
    try {
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return

      if (isTurnEndType(type)) {
        finalizeTurn(sessionId)
        return
      }
      if (type !== 'assistant/message') return

      const usage = d.usage
      if (!usage || typeof usage !== 'object') return
      const turn = Number(d.turn)
      if (!Number.isFinite(turn)) return

      let agg = turnAggs.get(sessionId)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sessionId)
        agg = { turn, byModel: {}, tokens: 0, startedAt: Date.now() }
        turnAggs.set(sessionId, agg)
      }

      const src = (d.message && d.message.source) || {}
      const provider = String(src.provider || '')
      const model = String(src.model || '')

      const input = Number(usage.inputTokens) || 0
      const cacheRead = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      // DSH 保证 reasoningTokens ⊆ outputTokens，故不重复累加
      const tokens = input + cacheRead + output
      agg.tokens += tokens

      const key = provider + '|' + model
      const slot = agg.byModel[key] || (agg.byModel[key] = {
        provider, model, input: 0, cacheRead: 0, output: 0, cost: 0, billable: true,
      })
      slot.input += input
      slot.cacheRead += cacheRead
      slot.output += output

      // WorkBuddy 按积分计费，token 单价不适用，只累计 token 供展示
      const platform = resolvePlatform(provider, model, providerCache)
      slot.platform = platform
      if (platform === 'workbuddy') {
        slot.billable = false
      } else {
        const peak = peakIndexOf(platform, Math.floor(Date.now() / 1000))
        // 记下本段用的峰谷档，便于核对计价口径
        slot.peak = peak
        slot.cost = round6(slot.cost + costOf(priceForPlatform(platform), peak, {
          input, cacheRead, output,
        }))
      }
      // 便于诊断 provider 名与判定结果是否一致（debug 配置开启时才记）
      if (cfg.debugUsage === true) {
        log('usage: provider=' + (provider || '(empty)') + ' model=' + (model || '(empty)') +
          ' -> platform=' + platform + (slot.billable === false ? ' (非token计价)' : ' peak=' + slot.peak))
      }
    } catch (e) {
      warn('session event failed: ' + (e && e.message ? e.message : 'unknown'))
    }
  }

  /**
   * 记录一次请求失败，用于 /model-limits 展示额度状态。
   * 关心的两类（来自 WorkBuddy 上游实测报文）：
   *   400 client   —— 上下文过长（"内容过长，请精简或新建任务"）
   *   429 soft_rate —— 触发频率限制，报文里带重置时间（UTC+8）
   */
  function recordFailure(provider, model, error) {
    try {
      const text = String(
        (error && (error.message || error.text)) ||
        (typeof error === 'string' ? error : '') ||
        JSON.stringify(error || {}),
      )
      const now = Date.now()
      const entry = limitsByModel[model] || (limitsByModel[model] = { id: model })

      // 上下文过长
      if (/内容过长|context.*(too\s*long|length)|context_length_exceeded/i.test(text)) {
        entry.contextOverflowAt = now
        entry.note = '上次因上下文过长失败，请精简或新建任务'
      }

      // 频率限制：报文里通常带「将在 YYYY-MM-DD HH:mm:ss UTC+8 重置」
      if (/soft_rate|429|频率限制|rate.?limit/i.test(text)) {
        entry.rateLimitedAt = now
        const m = text.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*(?:UTC\+8)?/)
        if (m) {
          const t = Date.parse(m[1].replace(' ', 'T') + '+08:00')
          if (Number.isFinite(t)) entry.rateLimitedUntil = t
        }
        if (!entry.rateLimitedUntil) {
          // 报文没给时间就按 1 小时估算，界面上会显示「约」
          entry.rateLimitedUntil = now + 3600 * 1000
          entry.rateLimitedApprox = true
        }
        log('rate limited: model=' + model + ' until=' + new Date(entry.rateLimitedUntil).toISOString())
      }
    } catch { /* 记录失败不影响主流程 */ }
  }

  async function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (!agg) return
    turnAggs.delete(sessionId)

    const models = Object.keys(agg.byModel)
    if (!models.length) return

    const tokenCost = round6(models.reduce((a, k) => a + (Number(agg.byModel[k].cost) || 0), 0))
    const hasWorkbuddy = models.some((k) => agg.byModel[k].platform === 'workbuddy')
    const hasAliyun = models.some((k) => agg.byModel[k].platform === 'aliyun')

    // WorkBuddy 本轮：采样余额差
    let wb = { ok: false, spent: null, reason: 'not-applicable' }
    if (hasWorkbuddy) {
      try { wb = await credits.settleTurn() } catch (e) {
        wb = { ok: false, spent: null, reason: e && e.message ? e.message : 'settle-failed' }
      }
    }

        // 阿里云不做 token 计价，也不估算余额。
    // 实测结论（2026-10-19）：按 token×峰谷价算出 0.09826 元，
    // 而阿里云同区间实际扣减 2.611903 元，差 26.6 倍 —— 阿里云账务层
    // 不是按 token 线性计费（请求级/分段级出账，且含附加功能费）。
    // 因此阿里云只累计 token 用量作参考，余额完全依赖 CSV 校准。
    let aliyunTokens = 0
    for (const k of models) {
      if (agg.byModel[k].platform === 'aliyun') aliyunTokens += Number(agg.byModel[k].tokens) || 0
    }

    const record = {
      at: Date.now(),
      session: String(sessionId).slice(0, 12),
      turn: agg.turn,
      tokens: agg.tokens,
      models: models.map((k) => ({
        platform: agg.byModel[k].platform,
        model: agg.byModel[k].model,
        provider: agg.byModel[k].provider,
        tokens: agg.byModel[k].input + agg.byModel[k].cacheRead + agg.byModel[k].output,
        input: agg.byModel[k].input,
        cacheRead: agg.byModel[k].cacheRead,
        output: agg.byModel[k].output,
        peak: agg.byModel[k].peak === undefined ? null : agg.byModel[k].peak,
        cost: agg.byModel[k].billable ? agg.byModel[k].cost : null,
      })),
      costTokenBased: tokenCost,
      workbuddy: hasWorkbuddy
        ? { spent: wb.spent, before: wb.before, after: wb.after, reason: wb.reason }
        : null,
      aliyun: hasAliyun ? { note: 'token-only，不做金额估算' } : null,
    }

    state.turns.push(record)
    // 只保留最近 2000 轮，避免状态文件无限增长
    if (state.turns.length > 2000) state.turns = state.turns.slice(-2000)

    // 累计
    const t = state.totals
    t.turns = (Number(t.turns) || 0) + 1
    t.costTokenBased = round6((Number(t.costTokenBased) || 0) + tokenCost)
    if (hasWorkbuddy && Number.isFinite(wb.spent)) {
      t.workbuddyCredits = (Number(t.workbuddyCredits) || 0) + wb.spent
    }
    writeState(state)
    log('turn settled: tokens=' + agg.tokens + ' tokenCost=' + tokenCost +
      (hasWorkbuddy ? ' wbSpent=' + (wb.spent === null ? 'n/a(' + wb.reason + ')' : wb.spent) : '') +
      (hasAliyun ? ' aliyunTokens=' + aliyunTokens : ''))
  }

  // ---------- DeepSeek 官方余额（真钱） ----------
  /**
   * 官方余额经 deepseekAccount 服务读取，是三者中唯一的「真钱」数据。
   *
   * 契约来自 dsh-whale-widget 的实测用法（它已在生产环境读这个接口）：
   *   client metadata = { version, locale, timezoneOffsetSeconds }
   *   返回 { status: 'ready', value: [...充值钱包], bonusWallets: [...赠金钱包] }
   *   **钱包要两边一起看**：新用户/没充过值的账号常常只有赠金。
   *
   * 注意：必须用 ctx.get('deepseekAccount') 读可选服务，
   * 绝不能写进 inject —— 老宿主没这个服务时，进 inject 会让插件永远不 apply。
   * 失败一律返回 null 并记原因，不影响主流程。
   */
  let cachedDeepseekBalance = { available: null, at: null, error: 'not-fetched-yet' }
  let balanceFetchedAt = 0
  let balanceInFlight = null

  /** 数值化：非有限数返回 null（0 是合法余额，不能当缺失） */
  function numOrNull(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  /**
   * deepseekAccount 是可选服务，必须在一个能看到它的注入作用域里取。
   * 把 ctx.get('deepseekAccount') 直接放在 apply 顶层会拿到 undefined——
   * 因为 ctx.get 只返回**当前作用域内可见**的服务。
   * 所以这里由 accountScopeCtx 持有注入作用域里的 ctx，取不到再退回顶层 ctx。
   */
  let accountScopeCtx = null
  /** 诊断：记录注入作用域是否进入、取服务的结果 */
  let accountScopeDiag = 'not-injected'

  /** 等待注入作用域就绪，最多等 timeoutMs（默认 2500ms） */
  function waitForAccountScope(timeoutMs) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 2500
    if (accountScopeCtx) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t0 = Date.now()
      const tick = () => {
        if (accountScopeCtx) { resolve(true); return }
        if (Date.now() - t0 >= limit) { resolve(false); return }
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  async function refreshDeepseekBalance(force) {
    const now = Date.now()
    if (!force && cachedDeepseekBalance.at && now - balanceFetchedAt < 60000) return cachedDeepseekBalance
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = (async () => {
      // 重启后注入作用域需要几秒才进入；这里先等一会儿再取服务，
      // 否则第一次请求会误报 service-unavailable。
      await waitForAccountScope(2500)
      let err = null
      try {
        let svc = null
        const probes = []
        for (const [tag, c] of [['scope', accountScopeCtx], ['root', ctx]]) {
          if (!c || typeof c.get !== 'function') { probes.push(tag + ':no-get'); continue }
          try {
            const s = c.get('deepseekAccount')
            probes.push(tag + ':' + (s ? (typeof s.getBalance === 'function' ? 'ok' : 'no-method') : 'undefined'))
            if (s && typeof s.getBalance === 'function') { svc = s; break }
          } catch (e) { probes.push(tag + ':throw(' + (e && e.message) + ')') }
        }
        accountScopeDiag = probes.join(',')
        if (!svc) {
          cachedDeepseekBalance = { available: null, at: null, error: 'service-unavailable [' + accountScopeDiag + ']' }
          return cachedDeepseekBalance
        }
        const res = await svc.getBalance({
          version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
          locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        })
        if (!res) {
          cachedDeepseekBalance = { available: null, at: null, error: 'signed-out' }
          return cachedDeepseekBalance
        }
        if (res.status !== 'ready') {
          cachedDeepseekBalance = { available: null, at: null, error: 'not-ready:' + String(res.status || 'unknown') }
          return cachedDeepseekBalance
        }
        const normWallets = (Array.isArray(res.value) ? res.value : []).filter((w) => w && numOrNull(w.balance) !== null)
        const bonusWallets = (Array.isArray(res.bonusWallets) ? res.bonusWallets : []).filter((w) => w && numOrNull(w.balance) !== null)
        const all = normWallets.concat(bonusWallets)
        if (all.length === 0) {
          cachedDeepseekBalance = { available: null, at: null, error: 'no-wallet-data' }
          return cachedDeepseekBalance
        }
        const sum = (list) => list.reduce((a, w) => a + (numOrNull(w.balance) || 0), 0)
        const currency = (all.find((w) => String(w.currency || '').toUpperCase() === 'CNY') || all[0]).currency || 'CNY'
        cachedDeepseekBalance = {
          available: round6(sum(normWallets) + sum(bonusWallets)),
          recharged: round6(sum(normWallets)),
          bonus: round6(sum(bonusWallets)),
          currency: String(currency),
          at: new Date().toISOString(),
          error: null,
        }
      } catch (e) {
        err = e && e.message ? String(e.message).slice(0, 200) : 'fetch-failed'
      } finally {
        balanceFetchedAt = Date.now()
        balanceInFlight = null
      }
      if (err) cachedDeepseekBalance = { available: null, at: null, error: err }
      return cachedDeepseekBalance
    })()
    return balanceInFlight
  }

  // ---------- 阿里云余额视图 ----------
  /**
   * 阿里云抵用券余额。
   *
   * **只认 CSV 校准值**，不做 token 估算扣减。
   * 实测依据（2026-10-19）：token×峰谷价算出 0.09826 元，同区间阿里云实际
   * 扣减 2.611903 元，差 26.6 倍 —— 阿里云按请求级/分段级出账，且含附加
   * 功能费，token 单价完全推不出真实扣减。
   * 想刷新余额就重新导一次 CSV 校准，见 /cost-tracker/aliyun/calibrate。
   */
  function aliyunView() {
    const a = state.aliyun || {}
    const balance = Number.isFinite(Number(a.balance)) ? Number(a.balance) : null
    return {
      calibratedBalance: balance,
      calibratedAt: a.balanceAt || null,
      source: a.source || 'manual',
      note: '余额来自 CSV 校准，不做 token 估算；刷新请重新导出代金券流水校准',
    }
  }

  // ---------- 路由 ----------
  const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  function sendJson(res, code, obj) {
    try {
      res.writeHead(code, JSON_HEADERS)
      res.end(JSON.stringify(obj))
    } catch { /* 连接已断时忽略 */ }
  }

  function registerRoute(p, handler) {
    const ws = webServerRef
    if (!ws || typeof ws.register !== 'function') return
    disposers.push(ctx.effect(() => {
      const dispose = ws.register({ kind: 'exact', path: p, handler })
      return () => { try { dispose && dispose() } catch { /* 忽略 */ } }
    }))
  }

  /** 汇总视图：供前端读取 */
  function summaryView() {
    const turns = state.turns || []
    const byPlatform = {}
    for (const r of turns) {
      for (const m of r.models || []) {
        const p = m.platform || 'unknown'
        const s = byPlatform[p] || (byPlatform[p] = { turns: 0, tokens: 0, cost: 0, credits: 0 })
        s.turns++
        s.tokens += Number(m.tokens) || 0
        if (m.cost !== null && m.cost !== undefined) {
          s.cost = round6(s.cost + (Number(m.cost) || 0))
        }
        if (p === 'workbuddy' && r.workbuddy && Number.isFinite(r.workbuddy.spent)) {
          s.credits += Number(r.workbuddy.spent) || 0
        }
      }
    }
    const last = turns.length ? turns[turns.length - 1] : null
    const health = credits.health()
    const snap = credits.snapshot()
    return {
      ok: true,
      version: 2,
      totals: state.totals || {},
      byPlatform,
      lastTurn: last,
      aliyun: aliyunView(),
      deepseekBalance: cachedDeepseekBalance,
      workbuddy: {
        health: health.level,
        reason: health.reason,
        expiresAtMs: health.expiresAtMs || null,
        leftMs: health.leftMs || null,
        account: maskAccount(snap && snap.account),
        credits: snap ? snap.total : null,
      },
      recentTurns: turns.slice(-20),
    }
  }

  /**
   * 注册全部 HTTP 路由。
   * 必须在 ctx.inject(['webServer']) 的作用域里调用——ctx.webServer
   * 只在注入作用域内可用，直接访问顶层 ctx 会抛
   * "cannot get property webServer without inject"。
   */
  function registerAllRoutes() {
    registerRoute('/cost-tracker/summary', (req, res) => sendJson(res, 200, summaryView()))

    registerRoute('/cost-tracker/turn', (req, res) => {
      const turns = state.turns || []
      sendJson(res, 200, { ok: true, turn: turns.length ? turns[turns.length - 1] : null })
    })

    registerRoute('/cost-tracker/health', async (req, res) => {
      // 顺带刷新一次 WorkBuddy 采样，便于前端拿到最新健康状态
      try { await credits.refresh() } catch { /* 采样失败也照常返回现有信息 */ }
      const h = credits.health()
      const snap = credits.snapshot()
      sendJson(res, 200, {
        ok: true,
        level: h.level,
        reason: h.reason,
        expiresAtMs: h.expiresAtMs || null,
        leftMs: h.leftMs || null,
        account: maskAccount(snap && snap.account),
        sampleError: credits.lastError,
      })
    })

    /** 阿里云抵用券余额视图 */
    registerRoute('/cost-tracker/aliyun', (req, res) => {
      sendJson(res, 200, { ok: true, aliyun: aliyunView() })
    })

    /**
     * 每轮消耗明细，按时间倒序。
     * 用于排查「积分/真钱掉得比预期快」时定位是哪一轮、哪个模型吃掉的。
     *
     * query: ?limit=50&platform=workbuddy
     */
    registerRoute('/cost-tracker/turns', (req, res) => {
      let limit = 50
      let platformFilter = ''
      try {
        const qs = typeof req.url === 'string' && req.url.indexOf('?') !== -1
          ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1))
          : new URLSearchParams()
        const l = Number(qs.get('limit'))
        if (Number.isFinite(l) && l > 0) limit = Math.min(l, 500)
        platformFilter = String(qs.get('platform') || '')
      } catch { /* 参数异常用默认值 */ }

      let list = (state.turns || []).slice()
      if (platformFilter) {
        list = list.filter((r) => (r.models || []).some((m) => m.platform === platformFilter))
      }
      list = list.slice(-limit).reverse()

      sendJson(res, 200, {
        ok: true,
        count: list.length,
        turns: list.map((r) => ({
          turn: r.turn,
          at: r.at,
          tokens: r.tokens,
          costTokenBased: r.costTokenBased,
          workbuddyCredits: r.workbuddy ? r.workbuddy.spent : null,
          models: (r.models || []).map((m) => ({
            platform: m.platform,
            model: m.model,
            tokens: m.tokens,
            cost: m.cost,
          })),
        })),
      })
    })

    /** DeepSeek 官方余额（真钱），force=1 时跳过缓存 */
    registerRoute('/cost-tracker/deepseek-balance', async (req, res) => {
      const force = typeof req.url === 'string' && req.url.indexOf('force=1') !== -1
      const b = await refreshDeepseekBalance(force)
      // 附带诊断：注入作用域状态，便于排查取不到服务的情况
      sendJson(res, 200, { ok: true, deepseekBalance: b, scope: accountScopeDiag })
    })

    /**
     * 阿里云 CSV 校准。
     * POST body: { csv: "<原文>" } 或 { path: "<本地 CSV 路径>" }
     */
    registerRoute('/cost-tracker/aliyun/calibrate', async (req, res) => {
      let text = ''
      try {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw.trim() === '' ? {} : JSON.parse(raw)
        if (typeof body.csv === 'string' && body.csv.trim() !== '') {
          text = body.csv
        } else if (typeof body.path === 'string' && body.path.trim() !== '') {
          // 只允许读用户显式指定的单个文件
          text = fs.readFileSync(body.path.trim(), 'utf8')
        } else {
          sendJson(res, 400, { ok: false, reason: 'need csv or path' })
          return
        }
      } catch (e) {
        sendJson(res, 400, { ok: false, reason: e && e.message ? String(e.message) : 'bad-request' })
        return
      }

      const r = calibrateFromCsv(text, { balance: state.aliyun.balance })
      if (!r.ok) {
        sendJson(res, 400, { ok: false, reason: r.reason })
        return
      }
      state.aliyun = {
        ...state.aliyun,
        balance: r.balance,
        balanceAt: r.at,
        calibratedAtMs: r.atMs,
        source: 'csv',
      }
      writeState(state)
      sendJson(res, 200, {
        ok: true,
        balance: r.balance,
        at: r.at,
        rows: r.rows,
        products: r.products,
        spentSincePreviousCalibration: r.spentSince,
      })
    })

    /** WorkBuddy 模型排序 + 徽章（免费状态实时读 status 接口） */
    registerRoute('/cost-tracker/models', async (req, res) => {
      try { await credits.refresh() } catch { /* 采样失败用缓存 */ }
      const snap = credits.snapshot()
      const models = snap ? snap.models : []
      sendJson(res, 200, {
        ok: true,
        ranked: rankWorkbuddyModels(models),
        badges: Object.fromEntries(
          models
            .filter((m) => m && m.id)
            .map((m) => [String(m.id), badgeOf(m)]),
        ),
        globalPriority: GLOBAL_PRIORITY,
      })
    })

    /**
     * 模型额度与限制状态。
     * 给前端详情浮层用：积分倍率、上下文上限、限流解除时间、上下文溢出记录。
     */
    registerRoute('/cost-tracker/model-limits', async (req, res) => {
      try { await credits.refresh() } catch { /* 用缓存 */ }
      const snap = credits.snapshot()
      const models = snap ? snap.models : []
      const now = Date.now()
      const list = models.filter((m) => m && m.id).map((m) => {
        const st = limitsByModel[m.id] || {}
        const limited = typeof st.rateLimitedUntil === 'number' && st.rateLimitedUntil > now
        return {
          id: m.id,
          name: m.name,
          credits: m.credits || '',
          free: m.free === true,
          badges: m.badges || [],
          contextWindow: m.contextWindow || null,
          declaredEfforts: m.declaredEfforts || [],
          defaultEffort: m.defaultEffort || '',
          rateNote: m.free === true
            ? '免费模型，不消耗积分'
            : '倍率为 WorkBuddy 上游当前值；部分模型按自身时段或促销浮动',
          rateLimited: limited,
          rateLimitedUntil: limited ? st.rateLimitedUntil : null,
          rateLimitedApprox: limited ? st.rateLimitedApprox === true : false,
          contextOverflowAt: st.contextOverflowAt || null,
          note: st.note || '',
        }
      })
      sendJson(res, 200, { ok: true, at: now, models: list })
    })

    /** 清空统计 */
    registerRoute('/cost-tracker/reset', (req, res) => {
      const aliyun = state.aliyun
      state = { ...defaultState(), aliyun }
      writeState(state)
      sendJson(res, 200, { ok: true })
    })
  }

  // ---------- 事件订阅 ----------
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('session/event', (session, event) => {
      const sid = session && session.id ? session.id : 'default'
      handleSessionEvent(sid, event)
    }))
    // 兜底结算：agent/turn-stopping 语义是「本轮即将收尾，模型不会再回复」
    disposers.push(ctx.on('agent/turn-stopping', (agent) => {
      const sid = agent && agent.id ? agent.id : null
      if (sid) finalizeTurn(sid)
    }))
    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) turnAggs.delete(session.id)
    }))
    // 请求失败：记录限流 / 上下文溢出，供模型详情页展示
    disposers.push(ctx.on('agent/request-error', (payload) => {
      try {
        const p = payload || {}
        recordFailure(String(p.provider || ''), String(p.model || ''), p.failure || p.error)
      } catch { /* 忽略 */ }
    }))
  }

  // ---------- 清理 ----------
  ctx.effect(() => () => {
    stopped = true
    for (const d of disposers) {
      try { typeof d === 'function' && d() } catch { /* 忽略 */ }
    }
  })

  // 节假日表未覆盖当前年份时提醒一次，避免 silently 高估费用
  try {
    const y = new Date().getFullYear()
    if (!hasHolidayTable(y)) {
      warn('holiday table has no entry for ' + y + '; peak/off-peak falls back to off-peak')
    }
  } catch { /* 忽略 */ }

  // webServer 只在 inject 作用域内可用，注册路由必须放在这里
  // 注意：inject 回调是异步进入的，所以挂载时的首次采样放到回调里再做，
  // 否则此刻 webServerRef 还是 null，originOf() 拿不到端口。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        webServerRef = webCtx && webCtx.webServer ? webCtx.webServer : null
        if (!webServerRef) {
          warn('webServer service unavailable; routes not registered')
          return
        }
        registerAllRoutes()
        // 拿到端口后再采样，确保 workbuddy status 能取到数
        Promise.resolve()
          .then(() => credits.refresh())
          .then((s) => {
            if (s) log('workbuddy sampled: credits=' + s.total + ' models=' + s.models.length)
            else warn('workbuddy sample failed: ' + credits.lastError)
          })
          .catch((e) => warn('workbuddy sample threw: ' + (e && e.message ? e.message : 'unknown')))
        // 官方余额也顺手拉一次（失败不影响其他功能）
        Promise.resolve()
          .then(() => refreshDeepseekBalance(false))
          .then((b) => {
            if (b && b.error) warn('deepseek balance unavailable: ' + b.error)
            else if (b) log('deepseek balance: ' + b.available + ' ' + b.currency)
          })
          .catch(() => { /* 忽略 */ })
      })
    } catch (e) {
      warn('webServer inject failed: ' + (e && e.message ? e.message : 'unknown'))
    }

    // deepseekAccount 是「可选服务」：不写进 inject（老宿主没有它会永远不 apply），
    // 但要在一个能看到它的作用域里取。这里单独开一个作用域只保存 ctx 引用，
    // refreshDeepseekBalance 会优先用它。
    try {
      ctx.inject(['deepseekAccount'], (accountCtx) => {
        accountScopeCtx = accountCtx || null
        accountScopeDiag = accountCtx ? 'scope-ready' : 'scope-null'
        log('deepseekAccount scope ready')
        // 作用域就绪后立刻重试一次余额，覆盖之前 service-unavailable 的缓存
        Promise.resolve()
          .then(() => refreshDeepseekBalance(true))
          .then((b) => {
            if (b && b.error) warn('deepseek balance retry failed: ' + b.error)
            else if (b) log('deepseek balance: ' + b.available + ' ' + b.currency)
          })
          .catch(() => { /* 忽略 */ })
      })
    } catch (e) {
      warn('deepseekAccount inject failed: ' + (e && e.message ? e.message : 'unknown'))
    }
  }

  log('mounted (pricing: deepseek+aliyun, credits: workbuddy sampling, aliyun csv calibration)')
}

export { NAME as name, inject, apply }
