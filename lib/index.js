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
import { recommendByTime, isPeak, isNight, applyUserConfig } from './recommend.js'

const NAME = 'cost-tracker'
const inject = ['llm', 'webServer']

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 状态文件名（$DSH_HOME 下） */
const STATE_FILENAME = '.cost-tracker.json'

/** 阿里云抵用券默认初始值（2026-10-19 由用户提供） */
const DEFAULT_ALIYUN_BALANCE = 226.086813663

/**
 * 模型官方信息（限时活动/免费时段）的内置默认值。
 *
 * 这些是**官方公告原文**的精简版，随插件一起发布，保证开箱就能看到
 * 「这个模型什么时候免费、什么时候结束」。用户可以在设置面板里改，
 * 也可以把官方公告贴给 AI 让 AI 改——改动落在状态文件的 modelNotes，
 * 覆盖这里的默认值（默认值只作为初值和兜底）。
 *
 * 时间窗过期后不必删：面板会按当前日期提示「已结束」。
 */
const DEFAULT_MODEL_NOTES = {
  'hy3': '限时免费：7 月 6 日 – 10 月 31 日，每日赠送免费额度（当日额度用尽后需等次日重置）',
  'step-5-preview': '独家限免：10 月 12 日 – 10 月 25 日，独家官方合作，限时免费体验',
  'hy4-preview': '免费额度：9 月 11 日 – 10 月 31 日，每晚 23:00 — 次日 8:00 享免费额度（其余时段按倍率计费）',
}

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
    /**
     * 模型限额状态（持久化）。
     * 必须落盘：内存标记一重启就丢，用户标记的「额度用尽」会失效，
     * 悬停提示和推荐排除全跟着失效（实测教训 2026-10-20）。
     * key = modelId，value = { quotaExhaustedAt, rateLimitedUntil, manual, ... }
     */
    limits: {},
    /**
     * 模型官方信息（限时活动/免费时段）覆盖层。
     * key = modelId，value = 文案字符串；空字符串表示用户主动清空。
     * 与 DEFAULT_MODEL_NOTES 合并后对外下发；用户改过的优先。
     */
    modelNotes: {},
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

/**
 * 合并「内置官方公告」与「用户/AI 改过的文案」。
 * 用户的覆盖优先；值为空字符串表示显式清空（不再显示内置公告）。
 *
 * @param {object} state 已读取的状态
 * @returns {Record<string,string>} modelId -> 文案
 */
function effectiveModelNotes(state) {
  const user = (state && state.modelNotes && typeof state.modelNotes === 'object') ? state.modelNotes : {}
  const out = {}
  for (const k of Object.keys(DEFAULT_MODEL_NOTES)) out[k] = DEFAULT_MODEL_NOTES[k]
  for (const k of Object.keys(user)) {
    const v = user[k]
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function apply(ctx, config) {
  const cfg = config || {}
  const log = (msg) => { try { ctx.logger.info('dsh-cost-tracker: ' + msg) } catch { /* 无 logger 时忽略 */ } }
  const warn = (msg) => { try { ctx.logger.warn('dsh-cost-tracker: ' + msg) } catch { /* 同上 */ } }

  /**
   * ===== 可配置项（通用化）=====
   * 每个人的模型清单、峰谷规则、常用度都不同，全部从 patch config 读，
   * 代码里只保留无伤大雅的兜底值。用户在 cordis.patch.yml 的
   * cost-tracker 行下加 config: {...} 即可覆盖（见 README「配置」）。
   */
  const USER_CFG = {
    /** 遵循「工作日 9-12/14-18 高峰原价、其余谷价」规则的模型 id */
    peakModels: Array.isArray(cfg.peakModels) && cfg.peakModels.length ? cfg.peakModels.map(String) : null,
    /** 每日赠额型模型 id（额度用尽转付费/429） */
    quotaModels: Array.isArray(cfg.quotaModels) && cfg.quotaModels.length ? cfg.quotaModels.map(String) : null,
    /** 常用模型 id（推荐排序的同分优先项） */
    preferred: Array.isArray(cfg.preferred) && cfg.preferred.length ? cfg.preferred.map(String) : null,
    /** 档位：主力/常用 模型 id（client 半身标签用，透传给 /models 路由） */
    tiers: (cfg.tiers && typeof cfg.tiers === 'object' && !Array.isArray(cfg.tiers)) ? cfg.tiers : null,
    /** 转发到 client 半身与推荐引擎的完整配置（HTTP /config 路由下发） */
  }
  // 透传给前端：/cost-tracker/config 路由返回这份（client.js 的标签/档位用）
  const clientConfig = {
    peakModels: USER_CFG.peakModels || undefined,
    quotaModels: USER_CFG.quotaModels || undefined,
    preferred: USER_CFG.preferred || undefined,
    tiers: USER_CFG.tiers || undefined,
  }
  // 推荐引擎用同一份清单
  try { applyUserConfig(USER_CFG) } catch { /* 配置异常时用默认 */ }

  let stopped = false
  const disposers = []

  // ---------- 页面挂件注入 ----------
  // ⚠️ 2026-10-21 移除（曾是最严重的 bug 源）：
  // 原先这里通过 webserver/index-inject 往页面注入 widget.js 浮层，
  // 带来两个反复出现的问题：
  //   1) 注入表是 DSH 启动期一次性收集的，热重载/刷新不重新收集
  //      → 「💰 插件时不时消失」；
  //   2) 浮层自带的 💰 按钮贴到侧栏账户行右端，与正式侧栏行并存，
  //      出现「启动时瞬移到用户头像位置并覆盖头像」。
  // 现在唯一入口是 client 半区注册的 sidebar.panellist 行 + main panel，
  // 那是 React 树里的正式一行，不依赖注入表，也不会与头像争位置。
  // widget.js 文件与 /cost-tracker/widget.js 路由保留（历史兼容），
  // 但不再被任何路径自动加载。

  // ---------- 状态 ----------
  let state = readState()
  if (!Array.isArray(state.turns)) state.turns = []

  /** 每轮聚合桶：sessionId -> { turn, tokens, byModel, startedAt } */
  const turnAggs = new Map()

  /**
   * 模型额度/限制状态：modelId -> { rateLimitedUntil, contextOverflowAt, note, ... }
   * 与 state.limits 双向同步：启动时从盘上读，变更时写回。
   */
  const limitsByModel = state.limits || {}
  // 启动清洗：旧版本会把 model id 为空的失败也写进来（实测状态文件里有一条
  // key = "" 的记录），它不指向任何模型，却会被 freeExhaustedIds() 误当成
  // 「有用尽的模型」，污染推荐与提示。这里直接删掉。
  try {
    for (const k of Object.keys(limitsByModel)) {
      if (!String(k).trim()) delete limitsByModel[k]
    }
  } catch { /* 忽略 */ }
  /** 把内存里的限额状态写回盘（失败不影响主流程） */
  function persistLimits() {
    try {
      state.limits = limitsByModel
      writeState(state)
    } catch { /* 忽略 */ }
  }

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
   *
   * 关心的三类（来自 WorkBuddy 上游实测报文）：
   *   400 client     —— 上下文过长（"内容过长，请精简或新建任务"）
   *   402 hard_credit —— **积分余额不足**（WorkBuddy 的额度耗尽就是这个，不是 429）
   *   429 soft_rate   —— 触发频率限制，报文里带重置时间（UTC+8）
   *
   * 历史教训（2026-10-21）：之前只认 429，导致 WorkBuddy 积分真正耗尽时
   * （402）链路一声不响，用户看到的就是「莫名就用完了，还没报错」。
   */
  /**
   * 从错误文本里认出「到底是哪个模型出了问题」。
   *
   * 为什么需要：`agent/request-error` 的 payload 只给当前选中的模型，
   * 而限额/限流是**绑定在上游账户或具体模型**上的。用户切模型重试后，
   * 同一段 429 会被记到新模型头上，警告就说反了（2026-10-21 实测）。
   *
   * 只做保守匹配：先按已配置的模型清单做整词查找，命中唯一一个才采用；
   * 命中多个或有歧义时返回 undefined，退回调用方给的 model —— 宁可不说，
   * 也不要把警告安到错误的模型上。
   */
  function guessModelFromText(text) {
    try {
      const s = String(text || '')
      if (!s) return undefined
      // 候选：上游 catalog 里的模型 id + 本地已知的模型 id
      const candidates = new Set()
      try {
        const snap = credits.snapshot()
        for (const m of (snap && Array.isArray(snap.models) ? snap.models : [])) {
          if (m && m.id) candidates.add(String(m.id))
        }
      } catch { /* 忽略 */ }
      for (const k of Object.keys(limitsByModel)) candidates.add(String(k))
      if (!candidates.size) return undefined

      const hits = []
      for (const id of candidates) {
        if (!id) continue
        // 整词匹配：前后不能紧邻字母数字，避免 "hy3" 命中 "hy3-x"
        const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp('(^|[^A-Za-z0-9._-])' + esc + '($|[^A-Za-z0-9._-])', 'i')
        if (re.test(s)) hits.push(id)
      }
      if (hits.length === 1) return hits[0]
      // 命中多个：取出现在文本中最靠前的那个（报文通常先点明主体）
      if (hits.length > 1) {
        let best = null
        let bestAt = Infinity
        for (const id of hits) {
          const at = s.toLowerCase().indexOf(id.toLowerCase())
          if (at >= 0 && at < bestAt) { bestAt = at; best = id }
        }
        return best || undefined
      }
      return undefined
    } catch { return undefined }
  }

  function recordFailure(provider, model, error) {
    try {
      const text = String(
        (error && (error.message || error.text)) ||
        (typeof error === 'string' ? error : '') ||
        JSON.stringify(error || {}),
      )

      // ⚠️ 先尝试从**错误文本**里认出真正出问题的模型。
      //
      // 2026-10-21 实测故障：step-5-preview 触发 429，用户切到
      // deepseek-v4.1-flash 重试，事件里的 p.model 已经是 flash，
      // 于是限流被错记到 flash 头上，气泡还提示「flash 已限流，
      // 建议改用 Step-5-Preview」——正好说反，而真正限额的是 step。
      //
      // 上游报文里通常带模型标识（如 "... upstream soft_rate ... <model> ..."），
      // 能认出来就以它为准；认不出才退回事件给的 model。
      const guessed = guessModelFromText(text)

      const mid = String(guessed || model || '').trim()
      // 没有模型 id 的失败无从归属（旧状态文件里就有一条 "" 脏数据），
      // 写进去只会污染 freeExhaustedIds() 的判定，直接丢弃。
      if (!mid) return
      if (guessed && String(model || '') && guessed !== String(model || '').trim()) {
        log('failure model corrected by message text: ' + model + ' -> ' + guessed)
      }
      const now = Date.now()
      const entry = limitsByModel[mid] || (limitsByModel[mid] = { id: mid })

      // ⚠️ 先判「输出被截断」，再判「上下文过长」——两者报文都含
      // token/length 字样，顺序反了会把截断误标成上下文溢出。
      //
      // 实测（2026-10-21 hy3）：用户看到的是
      //   「已达到输出 token 上限回答被截断，已有输出保留在对话中。
      //     发送"继续"可让模型接着输出。」
      // 这不是上下文装不下（那要精简历史），而是单轮输出长度到顶，
      // 发「继续」即可。标成「上下文过长，请精简」属于误导。
      const truncated = /输出\s*token\s*上限|回答被截断|输出被截断|max_tokens.*(limit|exceed)|maxTokens.*(limit|exceed)/i.test(text)
      const overlong = !truncated
        && /内容过长|context.*(too\s*long|length)|context_length_exceeded/i.test(text)

      if (overlong) {
        entry.contextOverflowAt = now
        entry.note = '上次因上下文过长失败，请精简或新建任务'
      }
      // 截断只留一句温和提示，不打「额度/限流」标记，也不影响推荐
      if (truncated) {
        entry.truncatedAt = now
        entry.note = '上次输出达到单轮上限被截断，发「继续」可接着生成'
      }

      // 积分余额不足（402 hard_credit）：额度耗尽，与 429 同样标 quotaExhaustedAt，
      // 但说明文案不同——这是「钱的问题」不是「频率的问题」，提示用户去充值/换模型。
      if (/402|hard_credit|积分不足|余额不足|insufficient.*(credit|balance|quota)/i.test(text)) {
        entry.quotaExhaustedAt = now
        entry.creditExhaustedAt = now
        entry.rateLimitedAt = now
        entry.kind = 'credit'
        entry.note = '积分/余额不足，请求被拒'
        log('credit exhausted: model=' + mid)
        persistLimits()
      }

      // 频率限制：报文里通常带「将在 YYYY-MM-DD HH:mm:ss UTC+8 重置」
      if (/soft_rate|429|频率限制|rate.?limit/i.test(text)) {
        entry.rateLimitedAt = now
        // 免费模型报 429 = 每日赠额用尽（不是临时限流，要等次日重置）。
        // 标记后推荐引擎不再把它当免费，避免反复推荐一个用不了的模型。
        entry.quotaExhaustedAt = now
        if (!entry.kind) entry.kind = 'quota'
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
        log('rate limited: model=' + mid + ' until=' + new Date(entry.rateLimitedUntil).toISOString())
        persistLimits()
      }
    } catch { /* 记录失败不影响主流程 */ }
  }

  /**
   * 判断一条限额记录现在是否仍然有效。
   *
   * ⚠️ 历史教训（2026-10-21，两次误报的根源）：
   * 上一版把「额度尽」徽章改成"quotaExhaustedAt 一经记录就长期显示"，
   * 结果把用户 10/20 **手动误标**的三个模型永久标成"额度尽"——
   * 而那些模型之后照样成功跑了 19 轮，用户看到的就是
   * 「你提示我用完了，但我还能对话」。
   *
   * 规则（关键：手动标记和上游拒绝的区别对待）：
   *   - 上游 402/429 触发的（无 manual 标记）→ **不过期**。
   *     那是真的被拒了，必须一直提示，直到用户手动清除。
   *   - 用户手动标记的 → 24 小时硬过期。手标本质是猜测
   *     （WorkBuddy 的 status 接口根本不返回额度状态），
   *     猜错就该自动失效，不能永久污染推荐与徽章。
   */
  const MANUAL_MARK_TTL_MS = 24 * 3600 * 1000
  function limitEntryActive(st) {
    if (!st) return false
    const exhaustedAt = typeof st.quotaExhaustedAt === 'number' ? st.quotaExhaustedAt : 0
    if (!(exhaustedAt > 0)) return false
    if (st.manual === true) {
      const ttl = typeof st.manualUntil === 'number' ? st.manualUntil : exhaustedAt + MANUAL_MARK_TTL_MS
      return Date.now() < ttl
    }
    return true
  }

  /**
   * 免费额度已用尽的模型 id 列表（**只含当前仍有效**的标记）。
   * 判定依据：该模型报过 429/402，或用户手动标记且未过期。
   * 这些模型不再按「免费」参与推荐排序，改用付费替代倍率。
   */
  function freeExhaustedIds() {
    const out = []
    try {
      for (const id of Object.keys(limitsByModel || {})) {
        if (!String(id).trim()) continue
        const st = limitsByModel[id]
        if (limitEntryActive(st)) out.push(id)
      }
    } catch { /* 忽略 */ }
    return out
  }

  /** 把已过期的手动标记从内存与盘上清掉（幂等，启动与定时调用） */
  function pruneExpiredManualMarks() {
    try {
      let changed = false
      for (const id of Object.keys(limitsByModel || {})) {
        if (!String(id).trim()) continue
        const st = limitsByModel[id]
        if (!st || st.manual !== true) continue
        const ttl = typeof st.manualUntil === 'number' ? st.manualUntil : (st.quotaExhaustedAt || 0) + MANUAL_MARK_TTL_MS
        if (ttl > 0 && Date.now() >= ttl) {
          delete limitsByModel[id]
          changed = true
          log('pruned expired manual mark: ' + id)
        }
      }
      if (changed) persistLimits()
    } catch { /* 忽略 */ }
  }

  /**
   * 主动省钱提示。
   *
   * 输入：已经算好的推荐结果 + 模型列表
   * 输出：{ level, message, action, model } —— 一条可以直接展示给用户的建议
   *
   * level:
   *   'switch'  —— 强烈建议切换（当前模型不可用，或贵很多）
   *   'suggest' —— 建议切换（有更省的，但当前也能用）
   *   'ok'      —— 当前已是最优，附上「为什么最优」
   */
  function buildAdvice(result, models) {
    try {
      const now = Date.now()
      // 当前在用的模型 = 最近一轮用的模型
      const turns = Array.isArray(state.turns) ? state.turns : []
      let currentId = null
      for (let i = turns.length - 1; i >= 0; i--) {
        const mm = (turns[i] && turns[i].models) || []
        if (mm.length) { currentId = mm[0].model; break }
      }

      const byId = {}
      for (const m of models || []) if (m && m.id) byId[m.id] = m

      // 长文场景的第一名（用户长对话多，用它作为「最优」基准）
      const longSc = (result.scenarios || []).find((s) => s.key === 'long')
      const best = longSc && longSc.models && longSc.models[0] ? longSc.models[0] : null

      // ① 当前模型被限流 → 强烈建议切换
      const st = currentId ? limitsByModel[currentId] : null
      if (currentId && st && typeof st.rateLimitedUntil === 'number' && st.rateLimitedUntil > now) {
        const leftMs = st.rateLimitedUntil - now
        return {
          level: 'switch',
          currentId,
          model: best ? best.id : null,
          message: currentId + ' 已限流，' + fmtDuration(leftMs) + '后恢复'
            + (best ? '，建议改用 ' + best.name : ''),
          action: best ? 'switch-to-' + best.id : null,
        }
      }

      // ② 当前模型免费额度用尽 → 建议切换
      // 手动标记（猜测）不在此报警：用户 10/20 误标过 hy3 / step-5-preview，
      // 之后这两个模型照样成功跑了 19 轮，插件却斩钉截铁提示
      // 「已用尽，开始计费」——用户直接问「我还能对话啊，有在消耗积分吗」。
      // 手标只在悬停说明里以灰色「手标」低调提示，不当作事实播报。
      const exhausted = freeExhaustedIds()
      const curSt = currentId ? limitsByModel[currentId] : null
      const curManual = !!(curSt && curSt.manual === true)
      if (currentId && exhausted.indexOf(currentId) !== -1 && !curManual) {
        const isCredit = !!(curSt && curSt.creditExhaustedAt)
        return {
          level: 'switch',
          currentId,
          model: best ? best.id : null,
          message: isCredit
            ? (currentId + ' 积分/余额不足，请求已被上游拒绝，需充值'
              + (best ? '，建议改用 ' + best.name : ''))
            : (currentId + ' 免费额度已用尽，开始计费'
              + (best ? '，建议改用 ' + best.name : '')),
          action: best ? 'switch-to-' + best.id : null,
        }
      }

      // ③ 当前不是最优：比较实际倍率
      if (currentId && best && best.id !== currentId && byId[currentId]) {
        const cur = byId[currentId]
        const curFree = cur.free === true
        const bestFree = best.free === true
        if (!curFree && bestFree) {
          return {
            level: 'suggest',
            currentId,
            model: best.id,
            message: '当前 ' + currentId + ' 消耗积分，' + best.name + ' 现在免费，切过去更省',
            action: 'switch-to-' + best.id,
          }
        }
        const curRate = Number(cur.credits && String(cur.credits).replace(/^x/i, ''))
        if (Number.isFinite(curRate) && Number.isFinite(best.rate) && best.rate > 0
          && curRate > best.rate * 1.5) {
          return {
            level: 'suggest',
            currentId,
            model: best.id,
            message: '当前 ' + currentId + '（x' + curRate + '）比 ' + best.name
              + '（x' + best.rate + '）贵，切过去可省',
            action: 'switch-to-' + best.id,
          }
        }
      }

      // ④ 已经最优
      if (best) {
        return {
          level: 'ok',
          currentId,
          model: best.id,
          message: '当前时段最优：' + best.name + (best.free ? '（免费）' : best.rate ? '（x' + best.rate + '）' : ''),
          action: null,
        }
      }
      return { level: 'ok', currentId: null, model: null, message: '暂无推荐', action: null }
    } catch (e) {
      return { level: 'ok', currentId: null, model: null, message: '推荐计算异常', action: null }
    }
  }

  /** 毫秒转「X 小时 Y 分」 */
  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '即将'
    const s = Math.floor(ms / 1000)
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return d + ' 天 ' + h + ' 小时'
    if (h > 0) return h + ' 小时 ' + m + ' 分'
    if (m > 0) return m + ' 分'
    return s + ' 秒'
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

    // 扣减延迟复查：WorkBuddy 积分要几秒才入账，立即采样常读到 0。
    // 这里隔 8 秒再算一次，用「本轮开始前的余额」作基准回写该轮记录。
    if (hasWorkbuddy && wb && wb.reason === 'zero-pending' && typeof wb.before === 'number') {
      scheduleConfirm(record, wb.before)
    }
  }

  /**
   * 延迟复查一轮的 WorkBuddy 消耗并回写。
   *
   * 为什么需要：WorkBuddy 积分扣减有延迟（实测 3 秒内才入账），
   * 轮次刚结束时采样读到的是「还没扣」的余额，diff=0 会被误判为免费。
   *
   * 回写时同时修正 totals，避免单轮和累计对不上。
   */
  function scheduleConfirm(record, before) {
    // 扣减入账实测 3 秒内；8 秒是保守值。复查失败自动重试（指数退避），
    // 直到拿到非零消耗或重试次数用尽——「结算中」不能无限挂着。
    const delay = 4000
    const maxRetries = 4
    let retries = 0
    // 退避复查计时器集合（插件卸载时可清理）
    const timers = []
    function attempt() {
      Promise.resolve()
        .then(() => credits.confirmTurn(before))
        .then((r) => {
          if (!r || !r.ok || !Number.isFinite(r.spent)) {
            if (++retries < maxRetries) { const t = setTimeout(attempt, delay * (retries + 1)); timers.push(t); try { t.unref && t.unref() } catch {} }
            return
          }
          if (r.spent <= 0) {
            // 复查仍为 0：保持 zero-pending 并继续慢速复查（积分可能隔轮才扣），
            // 不急着定「免费」——挂件对此显示「—」并提示未入账
            if (++retries < 12) {
              if (record.workbuddy) record.workbuddy.reason = 'zero-pending'
              writeState(state)
              const t = setTimeout(attempt, 15000)
              timers.push(t); try { t.unref && t.unref() } catch {}
            } else {
              if (record.workbuddy) record.workbuddy.reason = 'unconfirmed'
              writeState(state)
            }
            return
          }
          // 真实消耗到手：回写单轮与累计
          if (record.workbuddy) {
            record.workbuddy.spent = r.spent
            record.workbuddy.after = r.after
            record.workbuddy.reason = 'confirmed-late'
          } else {
            record.workbuddy = { spent: r.spent, before, after: r.after, reason: 'confirmed-late' }
          }
          const t2 = state.totals
          t2.workbuddyCredits = round6((Number(t2.workbuddyCredits) || 0) + r.spent)
          writeState(state)
          log('turn #' + record.turn + ' workbuddy spent confirmed: ' + r.spent + ' (延迟入账)')
        })
        .catch((e) => warn('confirm turn failed: ' + (e && e.message ? e.message : 'unknown')))
    }
    const timer = setTimeout(attempt, delay)
    timers.push(timer); try { timer.unref && timer.unref() } catch {}
    // 不阻止进程退出
    try { if (timer && typeof timer.unref === 'function') timer.unref() } catch { /* 忽略 */ }
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

    /**
     * 按模型聚合的累计消耗。
     *
     * 给前端悬停说明用：在模型名旁显示「你已用：N 轮 · X 积分」。
     * 这是选模型时最直接的依据——倍率再低，用得多的模型总消耗也可能更高。
     *
     * 输出：{ ok, models: { [modelId]: { turns, tokens, credits, cost } } }
     * 阿里云不计入 credits（token 推算不可信），只累计 cost。
     */
    registerRoute('/cost-tracker/usage', async (req, res) => {
      const turns = Array.isArray(state.turns) ? state.turns : []
      const byModel = {}
      for (const t of turns) {
        if (!t || !Array.isArray(t.models)) continue
        // 一轮里同一模型可能多段，按轮计次（不重复计）
        const seen = {}
        for (const m of t.models) {
          if (!m || !m.model) continue
          const id = String(m.model)
          if (seen[id]) continue
          seen[id] = true
          const agg = byModel[id] || (byModel[id] = { turns: 0, tokens: 0, credits: 0, cost: 0 })
          agg.turns += 1
          agg.tokens += Number(t.tokens) || 0
          if (t.workbuddy && typeof t.workbuddy.spent === 'number') {
            agg.credits += t.workbuddy.spent
          }
          agg.cost += Number(t.costTokenBased) || 0
        }
      }
      const out = {}
      for (const k of Object.keys(byModel)) {
        const a = byModel[k]
        out[k] = {
          turns: a.turns,
          tokens: Math.round(a.tokens),
          credits: round6(a.credits),
          cost: round6(a.cost),
        }
      }
      sendJson(res, 200, { ok: true, at: Date.now(), models: out })
    })

    /** DeepSeek 官方余额（真钱），force=1 时跳过缓存 */
    registerRoute('/cost-tracker/deepseek-balance', async (req, res) => {
      const force = typeof req.url === 'string' && req.url.indexOf('force=1') !== -1
      const b = await refreshDeepseekBalance(force)
      // 附带诊断：注入作用域状态，便于排查取不到服务的情况
      sendJson(res, 200, { ok: true, deepseekBalance: b, scope: accountScopeDiag })
    })

    /**
     * 分时段省钱推荐。
     * 返回当前时段的峰谷状态，以及「短对话 / 长文」两个场景各 3 个推荐。
     */
    registerRoute('/cost-tracker/recommend', async (req, res) => {
      try { await credits.refresh() } catch { /* 用缓存 */ }
      const snap = credits.snapshot()
      const models = snap ? snap.models : []
      const result = recommendByTime(models, {
        timeMs: Date.now(),
        limit: 3,
        limits: limitsByModel,
        freeExhausted: freeExhaustedIds(),
        // 通用化：峰谷/额度/常用清单可由 patch config 覆盖
        peakModels: USER_CFG.peakModels || undefined,
        quotaModels: USER_CFG.quotaModels || undefined,
        preferred: USER_CFG.preferred || undefined,
      })

      // 附上限流状态，前端可提示「该换模型了」
      const now = Date.now()
      const limited = []
      for (const id of Object.keys(limitsByModel || {})) {
        const st = limitsByModel[id]
        if (st && typeof st.rateLimitedUntil === 'number' && st.rateLimitedUntil > now) {
          limited.push({ id, until: st.rateLimitedUntil, leftMs: st.rateLimitedUntil - now })
        }
      }
      result.limited = limited

      // ===== 主动省钱提示 =====
      // 判断「当前正在用的模型」是否该换，而不是只给一个候选列表。
      // 依据：限流状态 > 是否已非最优 > 时段切换。
      result.advice = buildAdvice(result, models)

      sendJson(res, 200, result)
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
        // 模型官方信息（限时活动/免费时段）：内置公告 + 用户/AI 覆盖
        modelNotes: effectiveModelNotes(state),
        // 同一份数据以 promoDesc 之名下发给 client 半身：模型列表悬停直接显示公告
        promoDesc: effectiveModelNotes(state),
        // 客户端设置面板的模型下拉清单：id + 当前显示名（来自上游 catalog）
        modelCatalog: models
          .filter((m) => m && m.id)
          .map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
        // 通用化：把用户配置的档位透传给 client 半身（空则前端用内置兜底）
        tiers: clientConfig.tiers || null,
        quotaModels: clientConfig.quotaModels || null,
      })
    })

    /**
     * 保存某个模型的官方信息（限时活动/免费时段）。
     *
     * 设置面板的「模型信息」编辑器走这里；用户把官方公告贴给 AI 后，
     * AI 也通过同一路由写入，保证面板与 AI 看到的是同一份数据。
     *
     * body: { id: "hy3", note: "限时免费：…" } 或 { notes: { hy3: "…" } }
     */
    registerRoute('/cost-tracker/model-notes', async (req, res) => {
      try {
        let raw = ''
        try {
          const chunks = []
          await new Promise((resolve) => {
            req.on('data', (c) => chunks.push(c))
            req.on('end', resolve)
            req.on('error', resolve)
          })
          raw = Buffer.concat(chunks).toString('utf8')
        } catch { /* 空 body */ }

        let body = {}
        try { body = raw.trim() === '' ? {} : JSON.parse(raw) } catch { body = {} }
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: 'invalid body' })
          return
        }
        if (!state.modelNotes || typeof state.modelNotes !== 'object') state.modelNotes = {}
        const incoming = {}
        if (typeof body.id === 'string' && typeof body.note === 'string') {
          incoming[body.id] = body.note
        }
        if (body.notes && typeof body.notes === 'object' && !Array.isArray(body.notes)) {
          for (const k of Object.keys(body.notes)) {
            if (typeof body.notes[k] === 'string') incoming[String(k)] = body.notes[k]
          }
        }
        const changed = []
        for (const k of Object.keys(incoming)) {
          // 空串 = 显式清空（不再显示内置公告），保留空串而不是删除
          state.modelNotes[k] = String(incoming[k]).trim()
          changed.push(k)
        }
        if (!changed.length) {
          sendJson(res, 400, { ok: false, error: 'nothing to update' })
          return
        }
        writeState(state)
        sendJson(res, 200, {
          ok: true,
          changed,
          modelNotes: effectiveModelNotes(state),
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e && e.message ? e.message : 'save failed' })
      }
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
        const active = limitEntryActive(st)
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
          // 额度用尽标记（免费模型 429）：即使 rateLimitedUntil 已过期也保留，
          // 因为「每日赠额用尽」要到次日才重置，不是 1 小时。
          // active=false 表示这条已失效（手动标记过期），前端不得据此报警。
          quotaExhaustedAt: active && typeof st.quotaExhaustedAt === 'number' ? st.quotaExhaustedAt : null,
          // 积分/余额不足（402 hard_credit）：钱的问题，要充值或换模型。
          creditExhaustedAt: active && typeof st.creditExhaustedAt === 'number' ? st.creditExhaustedAt : null,
          // 来源区分：manual=true 是用户手标的（可能是误判），
          // 前端必须显示「（手动标记，可能不准）」而不是斩钉截铁的「已用尽」。
          manual: st.manual === true,
          manualUntil: st.manual === true
            ? (typeof st.manualUntil === 'number' ? st.manualUntil : (st.quotaExhaustedAt || 0) + MANUAL_MARK_TTL_MS)
            : null,
          contextOverflowAt: st.contextOverflowAt || null,
          note: st.note || '',
        }
      })
      sendJson(res, 200, { ok: true, at: now, models: list })
    })

    /**
     * 手动标记模型的可用状态。
     *
     * 为什么需要：WorkBuddy 的 status 接口**不返回**额度/限流状态，
     * 只有真的触发 429 时 DSH 才能感知到。如果用户已经知道某个模型
     * 用尽（比如在 WorkBuddy 客户端看到的），需要能手动标记。
     *
     * POST body:
     *   { model: 'hy3', state: 'exhausted', hours: 12 }  标记额度用尽，12 小时后自动解除
     *   { model: 'hy3', state: 'exhausted', kind: 'credit' }  标记积分/余额不足（不自动解除）
     *   { model: 'hy3', state: 'clear' }                 清除标记
     */
    registerRoute('/cost-tracker/model-state', async (req, res) => {
      let body = ''
      try {
        const chunks = []
        await new Promise((resolve) => {
          req.on('data', (c) => chunks.push(c))
          req.on('end', resolve)
          req.on('error', resolve)
        })
        body = Buffer.concat(chunks).toString('utf8')
      } catch { /* 空 body */ }

      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }

      const model = String(payload.model || '').trim()
      const state = String(payload.state || '').trim()
      if (!model) { sendJson(res, 400, { ok: false, reason: 'model required' }); return }

      const entry = limitsByModel[model] || (limitsByModel[model] = { id: model })
      const now = Date.now()

      if (state === 'exhausted') {
        const isCredit = String(payload.kind || '') === 'credit'
        const hours = Number(payload.hours)
        const h = Number.isFinite(hours) && hours > 0 ? hours : 12
        entry.quotaExhaustedAt = now
        entry.rateLimitedAt = now
        entry.manual = true
        // 手动标记一律 24 小时硬过期：WorkBuddy 的 status 接口不返回额度状态，
        // 手标本质是猜测，猜错必须能自动失效（10/20 的三个误标就是这样
        // 把两个明明能用的模型永久标成"额度尽"的）。
        entry.manualUntil = now + MANUAL_MARK_TTL_MS
        entry.rateLimitedUntil = now + h * 3600 * 1000
        entry.rateLimitedApprox = true
        if (isCredit) {
          // 积分不足：钱的问题不会自己好，不设自动解除时间
          entry.creditExhaustedAt = now
          entry.note = '手动标记：积分/余额不足'
        } else {
          entry.note = '手动标记：额度已用尽'
        }
        log('manual mark exhausted: ' + model + ' for ' + h + 'h kind=' + (isCredit ? 'credit' : 'quota'))
        persistLimits()
      } else if (state === 'clear') {
        delete entry.quotaExhaustedAt
        delete entry.creditExhaustedAt
        delete entry.rateLimitedAt
        delete entry.rateLimitedUntil
        delete entry.rateLimitedApprox
        delete entry.manual
        entry.note = ''
        log('manual clear: ' + model)
        persistLimits()
      } else {
        sendJson(res, 400, { ok: false, reason: 'state must be exhausted or clear' })
        return
      }

      sendJson(res, 200, { ok: true, model, state, entry })
    })

    /**
     * 本次会话花费。
     *
     * 按 `session` 字段（sessionId 前 12 位）聚合最近记录。
     * `?session=` 不传时取「最近一轮所属的会话」——即当前正在用的会话。
     *
     * 三平台口径不同，返回值里分开列：
     *   - deepseek：token × 官方峰谷单价，**准确**（实测与账单吻合）
     *   - workbuddy：积分余额差，**准确**（但不是钱）
     *   - aliyun：token 数**仅供参考**，不给金额（实测偏差 26.6 倍，见 README）
     */
    registerRoute('/cost-tracker/session', async (req, res) => {
      const url = String(req.url || '')
      const m = url.match(/[?&]session=([^&]+)/)
      const wanted = m ? decodeURIComponent(m[1]) : null

      const turns = Array.isArray(state.turns) ? state.turns : []
      // 不指定就取最近一轮的会话
      const sid = wanted || (turns.length ? turns[turns.length - 1].session : null)

      if (!sid) {
        sendJson(res, 200, { ok: true, session: null, turns: 0, note: '暂无会话记录' })
        return
      }

      const mine = turns.filter((t) => t && t.session === sid)
      let cost = 0
      let credits = 0
      let aliyunTokens = 0
      let tokens = 0
      const byModel = {}
      for (const t of mine) {
        cost += Number(t.costTokenBased) || 0
        tokens += Number(t.tokens) || 0
        const wb = t.workbuddy
        if (wb && typeof wb.spent === 'number') credits += wb.spent
        for (const mm of t.models || []) {
          if (!mm) continue
          if (mm.platform === 'aliyun') aliyunTokens += Number(mm.tokens) || 0
          const key = (mm.platform || '?') + '/' + (mm.model || '?')
          if (!byModel[key]) byModel[key] = { platform: mm.platform, model: mm.model, tokens: 0, cost: 0, count: 0 }
          byModel[key].tokens += Number(mm.tokens) || 0
          byModel[key].cost += Number(mm.cost) || 0
          byModel[key].count += 1
        }
      }

      sendJson(res, 200, {
        ok: true,
        session: sid,
        turns: mine.length,
        tokens: tokens,
        costTokenBased: round6(cost),
        workbuddyCredits: round6(credits),
        aliyunTokens: aliyunTokens,
        startedAt: mine.length ? mine[0].at : null,
        lastAt: mine.length ? mine[mine.length - 1].at : null,
        models: Object.keys(byModel).map((k) => byModel[k]).sort((a, b) => b.cost - a.cost),
        note: 'aliyun 只统计 token，不给金额（实测偏差 26.6 倍）',
      })
    })

    /**
     * 记账：单轮费用 + 当天 / 当月汇总（仿小鲸鱼 usage-records 的双档结构）。
     *
     * 口径（刻意收窄，不给就是没有）：
     *   - DeepSeek：token×峰谷单价，**准确** → 金额
     *   - WorkBuddy：积分余额差，**准确** → 积分（不是钱，单列）
     *   - 阿里云：**不统计**。token 推算偏差 26.6 倍，无 CSV 校准就没有可信金额。
     *
     * 北京时区按「自然日/自然月」聚合。
     */
    registerRoute('/cost-tracker/ledger', async (req, res) => {
      // 采样一次拿模型 free 状态（allFree 判定用）
      try { await credits.refresh() } catch { /* 失败用缓存 */ }
      const snap = credits.snapshot()
      const turns = Array.isArray(state.turns) ? state.turns : []
      const pad = (n) => String(n).padStart(2, '0')
      const bjDay = (ms) => {
        const d = new Date(Number(ms) + 8 * 3600 * 1000)
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
      }
      const bjMonth = (ms) => bjDay(ms).slice(0, 7)

      const today = bjDay(Date.now())
      const thisMonth = bjMonth(Date.now())

      const summarize = (list) => {
        let cost = 0
        let credits = 0
        let turnCount = 0
        const models = {}
        for (const t of list) {
          turnCount += 1
          cost += Number(t.costTokenBased) || 0
          const wb = t.workbuddy
          if (wb && typeof wb.spent === 'number') credits += wb.spent
          for (const mm of t.models || []) {
            if (!mm || mm.platform === 'aliyun') continue // 阿里云不记账
            const key = mm.model || '?'
            if (!models[key]) models[key] = { model: key, platform: mm.platform, turns: 0, tokens: 0, cost: 0 }
            models[key].turns += 1
            models[key].tokens += Number(mm.tokens) || 0
            models[key].cost += Number(mm.cost) || 0
          }
        }
        return {
          turns: turnCount,
          costTokenBased: round6(cost),
          workbuddyCredits: round6(credits),
          models: Object.keys(models).map((k) => models[k]).sort((a, b) => b.cost - a.cost),
        }
      }

      const dayTurns = turns.filter((t) => t && t.at && bjDay(t.at) === today)
      const monthTurns = turns.filter((t) => t && t.at && bjMonth(t.at) === thisMonth)

      sendJson(res, 200, {
        ok: true,
        date: today,
        month: thisMonth,
        // 最后一轮的单次费用（含分模型明细），即「本次对话这一轮花了多少」
        // 附模型免费状态：前端据此区分「免费模型轮」与「付费轮但没采到消耗」
        lastTurn: turns.length ? {
          at: turns[turns.length - 1].at,
          turn: turns[turns.length - 1].turn,
          // ⚠️ sessionId 必须下发：turn 是**单会话轮次号**，不是全局序号。
          // 多会话并行时 lastTurn.turn 会在各会话间跳（实测 19→177→20→178），
          // 前端若只用 turn 变化判断「新回合」，会被别的会话触发误弹、
          // 也会漏掉同一会话的连续轮次。必须按 sessionId+turn 组合判断。
          // 注意：turn 记录里的字段名是 `session`（不是 sessionId），
          // 这里统一以 sessionId 之名下发给前端。
          sessionId: turns[turns.length - 1].session || turns[turns.length - 1].sessionId || '',
          tokens: turns[turns.length - 1].tokens,
          costTokenBased: round6(Number(turns[turns.length - 1].costTokenBased) || 0),
          workbuddy: turns[turns.length - 1].workbuddy,
          models: turns[turns.length - 1].models,
          // 「免费」判定必须基于模型的实时 free 状态（上游接口），
          // 不能用 cost===null —— WorkBuddy 积分模型的 cost 恒为 null
          // （积分制不做 token 计价），按它判会把付费积分模型也标成免费。
          // 免费清单从 credits 快照的 free 标志来。
          allFree: (turns[turns.length - 1].models || []).length > 0
            && (turns[turns.length - 1].models || []).every((m) => {
              if (!m) return false
              if (m.platform !== 'workbuddy') return false
              const info = (snap ? snap.models : []).find((x) => x && x.id === m.model)
              return !!(info && info.free === true)
            }),
        } : null,
        day: summarize(dayTurns),
        month: summarize(monthTurns),
        note: '阿里云不参与记账（token 推算偏差 26.6 倍，无可信金额）',
        /**
         * 结算健康度：最近 N 轮里有多少轮的 WorkBuddy 积分**没结清**。
         *
         * 为什么需要：WorkBuddy 的积分扣减有延迟（实测几秒），也有轮次
         * 根本没扣（免费模型 / 未计费）。以前这些轮次的 reason
         * （unconfirmed / zero-pending）只躺在状态文件里，面板一个字都不提，
         * 用户看到的就是「一切正常，但钱莫名在掉 / 莫名就不能用了」。
         * 现在把统计结果显式下发，面板据此给一句实话。
         */
        settlement: (() => {
          const recent = turns.slice(-12)
          // 未结清 = 真的还不知道花了多少的轮次。
          // covered-by-earlier / confirmed-late 都已结清（前者消耗已记在
          // 更早那轮上），不参与统计；unresolvable 是充值导致无法归因，
          // 单独一类，提示方式不同。
          const bad = recent.filter((t) => {
            const r = t && t.workbuddy && t.workbuddy.reason
            return r === 'unconfirmed' || r === 'zero-pending'
          })
          const unresolvable = recent.filter((t) => {
            return t && t.workbuddy && t.workbuddy.reason === 'unresolvable'
          })
          return {
            recent: recent.length,
            unsettled: bad.length,
            unresolvable: unresolvable.length,
            reasons: bad.map((t) => ({
              at: t.at,
              turn: t.turn,
              model: (t.models && t.models[0] && t.models[0].model) || '',
              reason: t.workbuddy.reason,
            })),
          }
        })(),
      })
    })

    /**
     * 手动结算未结清的 WorkBuddy 轮次（面板上的「刷新积分」按钮）。
     *
     * 为什么需要：WorkBuddy 积分扣减有延迟，而「这一轮到底花了多少积分」
     * 只能靠余额差反推。delay 复查失败/重试用尽后，轮次会停在
     * zero-pending / unconfirmed，面板就一直显示「N 轮积分未结清」——
     * 用户看到的是一条永远消不掉的警告。
     *
     * 做法：拿当前积分余额，与每一条未结清轮次的 before 基准逐个相减，
     * 差额即为该轮真实消耗；回写单轮与 totals，reason 改为 confirmed-late。
     *
     * 关键取舍：**余额上升时不回写**。充值/发放权益会让余额变大，
     * 此时 diff < 0，无法判断消耗，只能把 reason 标成 unresolvable
     * 并给出说明，绝不编一个数出来。
     *
     * POST body: { } 或 { limit: 50 }
     */
    registerRoute('/cost-tracker/reconcile', async (req, res) => {
      let body = ''
      try {
        const chunks = []
        await new Promise((resolve) => {
          req.on('data', (c) => chunks.push(c))
          req.on('end', resolve)
          req.on('error', resolve)
        })
        body = Buffer.concat(chunks).toString('utf8')
      } catch { /* 空 body */ }
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const limit = Number(payload.limit) > 0 ? Math.min(Number(payload.limit), 200) : 50

      // 先采样一次拿当前积分总额（失败就用上次的缓存，总比不做好）
      let snap = null
      try { snap = await credits.refresh() } catch { /* 用缓存 */ }
      if (!snap) snap = credits.snapshot()
      const nowTotal = snap ? snap.total : null
      if (!Number.isFinite(nowTotal)) {
        sendJson(res, 200, { ok: false, reason: 'no-credit-sample', message: '读不到 WorkBuddy 积分余额，无法结算' })
        return
      }

      const turns = Array.isArray(state.turns) ? state.turns : []
      // 只处理「有 before 基准且仍未结清」的轮次
      const pending = turns.filter((t) => {
        const wb = t && t.workbuddy
        if (!wb) return false
        if (wb.reason !== 'zero-pending' && wb.reason !== 'unconfirmed') return false
        return typeof wb.before === 'number' && Number.isFinite(wb.before)
      }).slice(-limit)

      let settled = 0
      let credited = 0
      let unresolved = 0
      const details = []

      // ⚠️ 归因方式（关键，容易算错）：
      // 每轮只记了「该轮开始前的余额」before，没有记该轮结束后的余额。
      // 现在只有一个当前余额 nowTotal，所以：
      //   - 最早那条未结清轮次的 before 与 nowTotal 的差，
      //     就是**从那时到现在**的总消耗（含中间所有已结清轮次的消耗）。
      //   - 因此不能每轮都减一遍（会把同一段消耗重复计数）。
      // 正确做法：把总差额一次性记到**最早**那条未结清轮次上，
      // 其余轮次标记为「已被前序轮次覆盖」，不再重复计。
      // 若期间余额上升（充值/发放），差额为负，无法归因 → 全部标记待确认。
      if (pending.length > 0) {
        const first = pending[0]
        const totalDiff = first.workbuddy.before - nowTotal
        if (totalDiff < 0) {
          for (const t of pending) {
            t.workbuddy.reason = 'unresolvable'
            t.workbuddy.after = nowTotal
            unresolved += 1
            details.push({ turn: t.turn, spent: null, reason: 'balance-increased' })
          }
        } else {
          // 总差额记到最早那条
          first.workbuddy.spent = totalDiff
          first.workbuddy.after = nowTotal
          first.workbuddy.reason = 'confirmed-late'
          settled += 1
          credited += totalDiff
          details.push({ turn: first.turn, spent: totalDiff, reason: 'confirmed-late' })
          // 其余轮次：消耗已包含在上一行的总差额里，标记为已覆盖，不再计
          for (let i = 1; i < pending.length; i++) {
            const t = pending[i]
            t.workbuddy.spent = 0
            t.workbuddy.after = nowTotal
            t.workbuddy.reason = 'covered-by-earlier'
            settled += 1
            details.push({ turn: t.turn, spent: 0, reason: 'covered-by-earlier' })
          }
        }
      }

      // 回写累计：只加这次真实拿到的部分
      if (credited > 0) {
        const t2 = state.totals
        t2.workbuddyCredits = round6((Number(t2.workbuddyCredits) || 0) + credited)
      }
      // 同步基准，避免下一轮 settleTurn 把这段差值又算一遍
      try {
        const cur = credits.snapshot()
        if (cur) credits.last = { ...cur, total: nowTotal, at: Date.now() }
      } catch { /* 忽略 */ }
      if (settled > 0 || unresolved > 0) writeState(state)

      log('reconcile: settled=' + settled + ' credited=' + credited + ' unresolved=' + unresolved
        + ' (scanned ' + pending.length + ')')
      sendJson(res, 200, {
        ok: true,
        at: Date.now(),
        balance: nowTotal,
        scanned: pending.length,
        settled,
        credited: round6(credited),
        unresolved,
        details,
        message: settled > 0
          ? ('已结算 ' + settled + ' 轮，补记 ' + round6(credited) + ' 积分'
            + (unresolved > 0 ? '；' + unresolved + ' 轮因余额上升无法归因' : ''))
          : (unresolved > 0
            ? ('有 ' + unresolved + ' 轮因余额上升（充值/发放）无法归因，已标记待人工确认')
            : '没有需要结算的轮次'),
      })
    })

    /** 费用挂件脚本（供注入的页面读取） */
    registerRoute('/cost-tracker/widget.js', (req, res) => {
      try {
        const src = fs.readFileSync(path.join(PKG_ROOT, 'widget.js'), 'utf8')
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(src)
      } catch (e) {
        sendJson(res, 404, { ok: false, reason: 'widget.js not found' })
      }
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
    //
    // ⚠️ 归因规则（2026-10-21 实测踩坑后确定）：
    // 不能用 payload 里的 p.model 就下结论。step-5-preview 触发 429 后，
    // 用户切到 deepseek-v4.1-flash 重试，此时 p.model 已是 flash，
    // 但 429 仍是 step 的额度 —— 记到 flash 头上就会提示「flash 已限流，
    // 建议改用 Step-5-Preview」，正好说反。
    // 归因优先级：
    //   1. 错误文本里能认出的模型（最可靠）
    //   2. 该会话内最近一轮**真正跑过**的模型（比 p.model 可信：
    //      p.model 是「当前选中」，而 request-error 发生时可能已经切换）
    //   3. p.model（最后兜底）
    disposers.push(ctx.on('agent/request-error', (payload) => {
      try {
        const p = payload || {}
        const err = p.failure || p.error
        const text = String(
          (err && (err.message || err.text)) || (typeof err === 'string' ? err : '') || '',
        )
        let provider = String(p.provider || '')
        let model = guessModelFromText(text) || lastTurnModelFor(p) || String(p.model || '')
        recordFailure(provider, model, err)
      } catch { /* 忽略 */ }
    }))
    // 补听 agent/error：有些耗尽不以请求失败出现，而是 step 直接 error 收尾。
    disposers.push(ctx.on('agent/error', (payload) => {
      try {
        const p = payload || {}
        const err = p.error || p.failure
        const text = String(
          (err && (err.message || err.text)) || (typeof err === 'string' ? err : '') || '',
        )
        let provider = String(p.provider || '')
        const model = guessModelFromText(text) || lastTurnModelFor(p) || String(p.model || '')
        if (model) recordFailure(provider, model, err)
      } catch { /* 忽略 */ }
    }))
  }

  /**
   * 取「该会话最近一轮真正跑过的模型」。
   *
   * 比 payload 里的 model 可信：payload 给的是**当前选中**的模型，
   * 而失败往往发生在用户刚切换模型之后（旧模型的额度限制仍在生效）。
   * 拿不到会话信息时退回全局最近一轮。
   */
  function lastTurnModelFor(payload) {
    try {
      const sid = payload && payload.agent && payload.agent.sessionId
        ? String(payload.agent.sessionId) : ''
      const turns = Array.isArray(state.turns) ? state.turns : []
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i]
        if (!t) continue
        if (sid && String(t.session || '') !== sid) continue
        const m = Array.isArray(t.models) ? t.models[0] : null
        if (m && m.model) return String(m.model)
        if (!sid) break
      }
      return ''
    } catch { return '' }
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
        // 启动即清理：把上次运行留下的、已过期的手动标记删掉。
        // 不删的话这些误标会一直显示「额度尽」——10/20 的三个误标
        // 就把两个明明能正常对话的模型永久标成了用尽。
        pruneExpiredManualMarks()
        // 之后每小时再清一次，保证手动标记到期后一定消失
        setInterval(() => pruneExpiredManualMarks(), 3600 * 1000)
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
