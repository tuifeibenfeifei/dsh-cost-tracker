/**
 * dsh-cost-tracker — 浏览器半身：WorkBuddy 模型内联标签 + 悬停两行说明。
 *
 * 手写 ModuleLoader bundle：无构建步骤，只依赖 shell 已提供的 react。
 *
 * 注册契约（来自 DSH 内核实测）：
 *   ctx.slots.inject('conversation.input.model.label', () =>
 *     ctx.slots.register({ name: '...', locale: ns }, Component))
 *   组件 props = { provider, model, placement, selected }
 *
 * **placement 三态**（内核 renderModelLabel 的三个调用点实测）：
 *   - 'trigger' 主界面输入框的当前模型名  → 本插件**完全不改动**，原样返回
 *   - 'menu'    折叠上层的当前模型名      → 同上
 *   - 'option'  下拉列表里的模型项        → 加档位/促销标签 + 悬停说明
 *
 * 显示：
 *   Hy4 preview  [常用] [夜间免费]
 *   Hy3          [免费] [额度限制]
 *   Step-5-Preview [免费]
 *   Deepseek-V4.1-Flash [主力] [夜间折扣]
 *
  * 悬停（仅 'option' 时）显示模型信息：
  *   倍率 / 促销 badge（上游实时）+ 限时提示 + 可用状态
  *
  * ⚠️ 促销时间窗不在本地硬编码 —— 上游 badge 本身就是实时状态，
  *    本地写死日期会过期且与上游不同步。需要自定义说明走配置 promoDesc（见 README「配置」）。
 *
 * 两条硬性约束（踩过坑）：
 * 1. 返回空字符串会吞掉模型名 —— 内核只在 null/undefined 时用 fallback。
 * 2. 不能吞掉模型项的鼠标事件 —— 选择动作依赖 click 冒泡。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-tracker',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    /**
     * 档位/清单默认值（兜底）。全部可被宿主 /models 路由下发的
     * tiers / quotaModels / peakModels 配置覆盖——每个人的模型清单不同，
     * 硬编码只是开箱示例。促销时间窗**不做硬编码**：上游 badge 本身就是
     * 实时状态（「夜间免费」「限时免费」），悬停直接展示 badge 文字。
     */
    let TIER_MAIN = ['deepseek-v4.1-flash']
    let TIER_COMMON = ['glm-5.3-flash', 'space-bunny', 'minimax-m2.7', 'hy4-preview']

    /** 档位配色：高饱和实心块 */
    const TIER_VIEW = {
      free:   { text: '免费', bg: '#15803d' },
      main:   { text: '主力', bg: '#1d4ed8' },
      common: { text: '常用', bg: '#b45309' },
      rare:   { text: '少用', bg: '#4b5563' },
    }

    /** 峰谷规则模型（上游不给 badge，按官方峰谷本地推算；可被配置覆盖） */
    let NIGHT_DISCOUNT = ['deepseek-v4.1-flash', 'deepseek-v4-pro']

    /** 每日赠额类模型：显示「额度限制」标签（可被配置覆盖） */
    let QUOTA_MODEL = ['hy3']

    /** 应用宿主下发的配置（/models 路由的 tiers / quotaModels / peakModels） */
    let PROMO_DESC = {}
    function applyModelConfig(cfg) {
      const c = cfg || {}
      if (Array.isArray(c.tiers)) {
        if (Array.isArray(c.tiers.main)) TIER_MAIN = c.tiers.main.map(String)
        if (Array.isArray(c.tiers.common)) TIER_COMMON = c.tiers.common.map(String)
      }
      if (Array.isArray(c.quotaModels) && c.quotaModels.length) QUOTA_MODEL = c.quotaModels.map(String)
      if (Array.isArray(c.peakModels) && c.peakModels.length) NIGHT_DISCOUNT = c.peakModels.map(String)
      // 促销说明：可选配置（promoDesc: { 模型id: 文案 }）；不配则悬停显示 badge 原文
      if (c.promoDesc && typeof c.promoDesc === 'object') {
        PROMO_DESC = {}
        for (const k of Object.keys(c.promoDesc)) PROMO_DESC[String(k)] = String(c.promoDesc[k])
      }
    }

    let badgeCache = null
    let badgeFetchedAt = 0
    let badgeInFlight = null
    const REFRESH_MS = 30000

    /** 限流/限额状态缓存：modelId -> { rateLimited, rateLimitedUntil, quotaExhaustedAt, creditExhaustedAt, ... } */
    let limitCache = null
    let limitFetchedAt = 0
    let limitInFlight = null

    function fetchJson(path) {
      return fetch(path, { headers: { accept: 'application/json' } }).then(r => (r.ok ? r.json() : null))
    }

    /**
     * 拉取限流/限额状态。
     * 悬停说明要用它显示「什么时候能再用」。
     * 失败时保留上一次的缓存，不阻断其他功能。
     */
    function refreshLimits() {
      if (limitInFlight) return limitInFlight
      if (limitCache !== null && Date.now() - limitFetchedAt < REFRESH_MS) return Promise.resolve(limitCache)
      limitInFlight = fetchJson('/cost-tracker/model-limits')
        .then(json => {
          const models = json && Array.isArray(json.models) ? json.models : []
          const map = {}
          for (const m of models) {
            if (!m || !m.id) continue
            map[m.id] = {
              rateLimited: m.rateLimited === true,
              rateLimitedUntil: typeof m.rateLimitedUntil === 'number' ? m.rateLimitedUntil : null,
              rateLimitedApprox: m.rateLimitedApprox === true,
              // 宿主只在标记**仍有效**时才下发这两个字段；已过期的手动标记
              // 会被置 null，前端据此不显示任何警告。
              quotaExhaustedAt: typeof m.quotaExhaustedAt === 'number' ? m.quotaExhaustedAt : null,
              creditExhaustedAt: typeof m.creditExhaustedAt === 'number' ? m.creditExhaustedAt : null,
              // 来源：true = 用户手标（WorkBuddy 的 status 接口不返回额度状态，
              // 手标本质是猜测，可能误判），false = 上游真的 402/429 拒绝。
              manual: m.manual === true,
              manualUntil: typeof m.manualUntil === 'number' ? m.manualUntil : null,
              contextOverflowAt: typeof m.contextOverflowAt === 'number' ? m.contextOverflowAt : null,
              note: typeof m.note === 'string' ? m.note : '',
            }
          }
          limitCache = map
          limitFetchedAt = Date.now()
          return map
        })
        .catch(() => limitCache)
        .finally(() => { limitInFlight = null })
      return limitInFlight
    }

    function refreshBadges() {
      if (badgeInFlight) return badgeInFlight
      if (badgeCache !== null && Date.now() - badgeFetchedAt < REFRESH_MS) return Promise.resolve(badgeCache)
      badgeInFlight = fetchJson('/cost-tracker/models')
        .then(json => {
          // 宿主下发的可配置清单：档位/额度/峰谷/促销说明
          applyModelConfig(json)
          const ranked = json && Array.isArray(json.ranked) ? json.ranked : []
          const map = {}
          for (const m of ranked) {
            if (!m || !m.id) continue
            map[m.id] = {
              free: m.free === true,
              credits: m.credits ? String(m.credits) : '',
              badges: Array.isArray(m.badges) ? m.badges : [],
              contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
            }
          }
          // ⚠️ ranked 为空时回退到 modelCatalog。
          // ranked 依赖 credits.snapshot().models，而 WorkBuddy 登录态抖动、
          // 采样失败时它会是空数组 —— 那会让所有模型的「免费/常用」标签
          // 一起消失（用户 2026-10-21 报的「图标没了」就是这个）。
          // modelCatalog 用的是同一份数据但更宽松，至少能保住模型 id 清单，
          // 让 buildTags 的档位兜底逻辑还能跑。
          if (!ranked.length && json && Array.isArray(json.modelCatalog)) {
            for (const m of json.modelCatalog) {
              if (!m || !m.id) continue
              if (!map[m.id]) map[m.id] = { free: false, credits: '', badges: [], contextWindow: null, fallback: true }
            }
          }
          badgeCache = map
          badgeFetchedAt = Date.now()
          return map
        })
        .catch(() => badgeCache)
        .finally(() => { badgeInFlight = null })
      return badgeInFlight
    }

    /**
     * 拉取「我在每个模型上的累计消耗」。
     * 失败时保留旧值，不阻断标签与悬停说明的其他内容。
     */
    function refreshUsage() {
      return fetchJson('/cost-tracker/usage')
        .then(json => {
          if (json && json.ok && json.models && typeof json.models === 'object') {
            myUsage = json.models
          }
          return myUsage
        })
        .catch(() => myUsage)
    }

    function isWorkbuddy(provider) {
      const pid = String((provider && provider.id) || '')
      return pid.indexOf('workbuddy') !== -1
    }

    function tierOf(provider, model) {
      if (!isWorkbuddy(provider)) return null
      const id = String((model && model.id) || '')
      const meta = badgeCache && badgeCache[id]
      if (meta && meta.free) return 'free'
      if (TIER_MAIN.indexOf(id) !== -1) return 'main'
      if (TIER_COMMON.indexOf(id) !== -1) return 'common'
      return 'rare'
    }

    /** 去掉 dsh-workbuddy-connect 拼进 name 的「 · x0.11 · 夜间免费」后缀 */
    function baseName(raw) {
      const s = String(raw || '')
      const i = s.indexOf(' · ')
      return i === -1 ? s : s.slice(0, i).trim()
    }

    /** 0.11x 倍率 */
    function fmtRate(credits) {
      const s = String(credits || '').trim()
      if (!s) return ''
      const m = s.match(/^x?([\d.]+)$/i)
      return m ? m[1] + 'x 倍率' : s
    }

    /** 数字紧凑显示：1234.5 → 1.2k */
    function fmtNum(n) {
      const v = Number(n)
      if (!isFinite(v) || v <= 0) return '0'
      if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
      if (v >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
      if (v >= 1000) return String(Math.round(v))
      return String(Math.round(v * 100) / 100)
    }

    /** token 数紧凑显示：2630956 → 2.63M */
    function fmtTokens(n) {
      const v = Number(n)
      if (!isFinite(v) || v <= 0) return '0 tokens'
      if (v >= 1000000) return (v / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M tokens'
      if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K tokens'
      return String(Math.round(v)) + ' tokens'
    }

    /**
     * 我在每个模型上的累计消耗。
     * 由宿主 /cost-tracker/usage 路由下发（按模型聚合）。
     * 悬停说明里显示「你已用：N 轮 · X 积分」，让用户知道这个模型
     * 对自己到底有多贵——这是选模型时最直接的依据。
     */
    let myUsage = {}

    /** 北京时间现在是否处于 deepseek 官方非高峰（5 折）时段 */
    function isOffPeakNow() {
      const d = new Date(Date.now() + 8 * 3600 * 1000)
      const hour = d.getUTCHours()
      const dow = d.getUTCDay()
      if (dow === 0 || dow === 6) return true
      return !((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    }

    /** 北京时间现在是否处于「夜间」时段（23:00–次日 8:00） */
    function isNightNow() {
      const d = new Date(Date.now() + 8 * 3600 * 1000)
      const hour = d.getUTCHours()
      return hour >= 23 || hour < 8
    }

    /** 组装标签 */
    function buildTags(tier, modelId, meta) {
      const tags = []

      const view = TIER_VIEW[tier]
      tags.push({ text: view.text, bg: view.bg, title: '使用频度分档' })

      // 促销：上游 badges 实时值（badge 文字本身即实时状态，不做时间窗硬编码）
      const badges = Array.isArray(meta.badges) ? meta.badges : []
      for (const b of badges) {
        if (!b) continue
        const text = String(b)
        // 免费模型已有「免费」档位标签，冗余的免限字样跳过
        if (meta.free && (text.indexOf('免费') !== -1 || text.indexOf('限免') !== -1)) continue
        const bg = text.indexOf('免费') !== -1 ? '#0e7490'
          : text.indexOf('折扣') !== -1 ? '#7c3aed'
          : '#6d28d9'
        tags.push({ text, bg, title: text })
      }

      // 峰谷折扣：按官方峰谷规则推算（模型清单可配置）。
      // 注意**不能叫「夜间折扣」**——非高峰包含中午 12-14、18-次日 9 点、
      // 以及周末与法定节假日全天，夜间只是其中一段。
      if (NIGHT_DISCOUNT.indexOf(modelId) !== -1 && !badges.some(b => String(b).indexOf('折扣') !== -1)) {
        const offPeak = isOffPeakNow()
        tags.push({
          text: offPeak ? '谷时5折' : '高峰原价',
          bg: offPeak ? '#7c3aed' : '#9ca3af',
          title: '周一至周五 09:00–12:00、14:00–18:00 属高峰原价；中午、晚间与周末节假日为谷时 5 折',
        })
      }

      // 额度限制
      if (QUOTA_MODEL.indexOf(modelId) !== -1) {
        tags.push({ text: '额度限制', bg: '#0369a1', title: '每日赠送额度过期或用尽后转付费' })
      }

      return tags
    }

    /** 剩余时间人类可读 */
    function fmtLeftMs(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '已恢复'
      const s = Math.floor(ms / 1000)
      const d = Math.floor(s / 86400)
      const h = Math.floor((s % 86400) / 3600)
      const m = Math.floor((s % 3600) / 60)
      if (d > 0) return d + ' 天 ' + h + ' 小时'
      if (h > 0) return h + ' 小时 ' + m + ' 分'
      if (m > 0) return m + ' 分'
      return s + ' 秒'
    }

    /** 精确到分钟的恢复时刻，例如「2026-10-20 18:07」 */
    function fmtUntil(ts) {
      try {
        const d = new Date(ts)
        const pad = (n) => String(n).padStart(2, '0')
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      } catch { return '' }
    }

    /**
     * 悬停说明：把一个 WorkBuddy 模型的所有有用信息一次讲全。
     *
     * 为什么重写：以前只有「倍率 + 促销 + 可用状态」三行，且：
     *   - 上下文窗口（决定能塞多长的历史）一个字都不提
     *   - 「每天送多少免费额度」只有 hy3/step-5-preview 两个手写文案
     *   - 免费时段型模型（hy4-preview）不显示时段就一句笼统的「免费」
     *   - 用户自己花了多少在这个模型上，完全不显示
     * 用户要求「每一个 workbuddy 模型都告诉我模型信息」，所以这里按
     * 统一模板输出，缺的字段自动跳过，不会出现空白行。
     *
     * 输出行序（有才显示）：
     *   1. 计费方式：免费 / x倍率（+当前时段是否免费/折扣）
     *   2. 上下文窗口
     *   3. 免费额度政策（夜间型给时段，每日赠额型给重置规则）
     *   4. 促销 / 峰谷说明
     *   5. 你在该模型上的累计消耗
     *   6. 可用状态：额度尽 / 限流 / 上下文溢出
     */
    function buildHoverLines(modelId, meta) {
      const lines = []
      const isNightFree = (meta.badges || []).some((b) => String(b).indexOf('夜间免费') !== -1)

      // ---- 1) 计费方式 ----
      if (meta.free === true) {
        lines.push('免费（当前不消耗积分）')
      } else if (isNightFree) {
        lines.push(isNightNow()
          ? '夜间免费中（23:00–次日 8:00）'
          : fmtRate(meta.credits) + '（仅 23:00–次日 8:00 免费）')
      } else {
        lines.push(fmtRate(meta.credits) || '倍率未知')
      }

      // ---- 2) 上下文窗口 ----
      if (meta.contextWindow) {
        const k = Math.round(meta.contextWindow / 1000)
        lines.push('上下文 ' + k + 'K tokens（历史过长会被截断或报错）')
      }

      // ---- 3) 免费额度政策 ----
      // 夜间免费型：明确时段；每日赠额型：明确重置规则。
      // 两者都可能不在 QUOTA_MODEL 清单里（清单可配置），所以按特征判断而非查表。
      if (isNightFree) {
        lines.push('免费时段：每晚 23:00 — 次日 08:00（其余时段按倍率计费）')
      } else if (meta.free === true) {
        lines.push('每日赠送免费额度，当日用尽后需等次日 00:00 重置')
      }

      // ---- 4) 促销 / 峰谷说明 ----
      const desc = PROMO_DESC[modelId]
      if (desc) {
        lines.push(desc)
      } else if (NIGHT_DISCOUNT.indexOf(modelId) !== -1) {
        lines.push('周一至周五 09:00–12:00、14:00–18:00 属高峰原价；中午、晚间与周末节假日为谷时 5 折')
      } else if (meta.badges && meta.badges.length) {
        // badge 是上游实时状态（夜间免费/限时免费/独家限免…）。
        // 本地不编造时间窗——那些日期会过期且与上游不同步；
        // 只标注「限时」性质，并提示以官方公告为准。
        const badges = meta.badges.map(String)
        lines.push(badges.join(' · '))
        const limited = badges.some((b) => /限|免费|折扣/.test(b))
        if (limited) {
          lines.push('⚠ 限时活动：有期限限制，结束后恢复原价/按倍率计费，以官方公告为准')
        }
      }

      // ---- 5) 用户在该模型上的累计消耗 ----
      const usage = myUsage && myUsage[modelId]
      if (usage) {
        const parts = []
        parts.push(usage.turns + ' 轮')
        if (usage.credits > 0) parts.push(fmtNum(usage.credits) + ' 积分')
        if (usage.cost > 0) parts.push('¥' + fmtNum(usage.cost))
        if (usage.tokens > 0) parts.push(fmtTokens(usage.tokens))
        if (parts.length > 1) lines.push('你已用：' + parts.slice(1).join(' · '))
      }

      // ---- 6) 可用状态 ----
      // ⚠️ 历史教训（2026-10-21）：这里原来只认「rateLimitedUntil 还没到」，
      // 于是手动标记 12 小时过期后，hy3 / step-5-preview 的「额度已用尽」
      // 提示**整条消失**——用户看到的就是「莫名就用完了，还没任何提示」。
      // 现在改成：quotaExhaustedAt / creditExhaustedAt 一经记录就长期展示，
      // 与「还有多久恢复」解耦；恢复时间只作为附加信息。
      const lim = (limitCache && limitCache[modelId]) || {}
      const now = Date.now()
      const until = lim.rateLimitedUntil
      const left = typeof until === 'number' ? until - now : null

      if (left !== null && left > 0) {
        // 免费模型 429 = 每日赠额用尽；付费模型 = 临时限流
        const label = meta.free ? '额度已用尽' : '已限流'
        const approx = lim.rateLimitedApprox ? '（估算）' : ''
        lines.push('⛔ ' + label + '：' + fmtUntil(until) + ' 恢复' + approx
          + '，还剩 ' + fmtLeftMs(left))
      } else if (lim.quotaExhaustedAt || lim.creditExhaustedAt) {
        // 恢复时间已过 / 从未给过：额度用尽的事实仍然有效。
        // 免费模型要等次日重置；积分不足型是钱的问题，要充值或换模型。
        if (lim.creditExhaustedAt) {
          lines.push('⛔ 积分/余额不足：请求已被上游拒绝，需充值或改用其他模型')
        } else {
          lines.push('⛔ 免费额度已用尽，等待每日重置后才能再用')
        }
      } else if (lim.rateLimited && left !== null && left <= 0) {
        lines.push('✅ 限流已结束，可正常使用')
      }

      // 手动标记一律附「可能不准」的免责说明。
      // ⚠️ 2026-10-21 的两次误报都源于此：用户 10/20 手标了 hy3 /
      // step-5-preview，之后这两个模型照样成功跑了 19 轮，
      // 而插件斩钉截铁地显示「额度尽」——用户看到的就是
      // 「你提示我用完了，但我还能对话」。
      if ((lim.quotaExhaustedAt || lim.creditExhaustedAt) && lim.manual) {
        lines.push('ℹ 以上为手动标记（上游不返回额度状态，仅供参考）；'
          + '24 小时后自动失效，也可在面板里手动清除')
      }

      if (lim.contextOverflowAt) {
        lines.push('⚠ 上次因上下文过长失败，请精简或新建任务')
      }

      return lines
    }

    /**
     * 模型项：模型名 + 内联标签；悬停显示两行说明。
     * **只在 placement === 'option'（下拉列表）时生效**，
     * 主界面（trigger / menu）原样返回，绝不改动。
     */
    /**
     * 悬停说明面板。
     *
     * 位置策略：**固定在模型列表右侧之外**，不跟随鼠标、不跟随当前模型项。
     * 这样无论悬停哪个模型，信息都出现在同一个地方，绝不遮挡列表本身。
     *
     * 为什么必须 portal：模型列表容器是 `position:fixed; overflow:hidden`
     * （内核 .menu 样式），插在列表项内部的内容会被裁掉或顶开下面的项。
     *
     * 如何找到「列表右边界」：从锚点（模型项）向上找最近的可滚动/定位祖先，
     * 也就是 .menu 容器；拿它的 getBoundingClientRect()。找不到就退回
     * 锚点自身位置。
     */
    function HoverTip({ anchorEl, lines }) {
      const tipRef = useRef(null)
      const [pos, setPos] = useState(null)

      /** 往上找模型列表容器（overflow hidden 的那个 .menu） */
      const findMenuRect = useCallback(() => {
        let el = anchorEl
        let best = null
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el)
          if (style.position === 'fixed' && style.overflow === 'hidden') {
            best = el.getBoundingClientRect()
            break
          }
          el = el.parentElement
        }
        if (!best && anchorEl && anchorEl.getBoundingClientRect) {
          best = anchorEl.getBoundingClientRect()
        }
        return best
      }, [anchorEl])

      const place = useCallback(() => {
        const menuRect = findMenuRect()
        if (!menuRect) return
        const MARGIN = 10
        const el = tipRef.current
        const w = el ? el.offsetWidth : 300
        const hh = el ? el.offsetHeight : 100

        // 水平：贴列表右边界外；右侧放不下就贴左边界外
        let left = menuRect.right + 10
        if (left + w > window.innerWidth - MARGIN) left = menuRect.left - w - 10
        if (left < MARGIN) left = Math.min(Math.max(MARGIN, menuRect.right + 10), window.innerWidth - w - MARGIN)

        // 垂直：与列表顶部对齐（固定位置，不跟随具体模型项）
        let top = menuRect.top
        if (top + hh > window.innerHeight - MARGIN) top = window.innerHeight - hh - MARGIN
        if (top < MARGIN) top = MARGIN

        setPos({ left, top })
      }, [findMenuRect])

      React.useLayoutEffect(() => { place() }, [place])

      useEffect(() => {
        const onScroll = () => place()
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        return () => {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [place])

      /**
       * 面板固定宽度、自适应高度。
       * 配色用深底浅字，和模型列表的浅底拉开对比，避免文字与背景融合。
       */
      const box = {
        position: 'fixed',
        zIndex: 10001,
        left: pos ? pos.left + 'px' : '-9999px',
        top: pos ? pos.top + 'px' : '-9999px',
        width: '300px',
        maxWidth: 'calc(100vw - 24px)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '14px 16px',
        borderRadius: '10px',
        // 深色底：与列表的浅色背景强对比
        background: '#1f2937',
        border: '1px solid rgba(255,255,255,.16)',
        boxShadow: '0 10px 32px rgba(0,0,0,.35)',
        // 浅色字
        color: '#ffffff',
        fontSize: '18px',
        lineHeight: '26px',
        fontWeight: 600,
        pointerEvents: 'none',
        whiteSpace: 'normal',
      }

      const node = h('div', { ref: tipRef, style: box }, lines.map((ln, i) => {
        // 限流/失败提示行：红底高亮，和普通说明区分开
        if (typeof ln === 'string' && ln.indexOf('⚠') === 0) {
          return h('span', {
            key: 'l' + i,
            style: {
              marginTop: '4px',
              padding: '6px 9px',
              borderRadius: '6px',
              background: 'rgba(220,38,38,.18)',
              border: '1px solid rgba(248,113,113,.45)',
              color: '#fecaca',
              fontSize: '17px',
              lineHeight: '24px',
              fontWeight: 600,
            },
          }, ln)
        }
        return h('span', {
          key: 'l' + i,
          style: i === 0
            ? { fontWeight: 800, fontSize: '20px', lineHeight: '28px', color: '#ffffff' }
            : { color: '#e5e7eb', fontSize: '18px', lineHeight: '26px', fontWeight: 400 },
        }, ln)
      }))

      const reactDom = require('react-dom')
      if (reactDom && reactDom.createPortal && typeof document !== 'undefined' && document.body) {
        return reactDom.createPortal(node, document.body)
      }
      return node
    }

    /**
     * 模型项：模型名 + 内联标签；悬停时在**旁侧浮层**显示两行说明。
     * **只在 placement === 'option'（下拉列表）时生效**，
     * 主界面（trigger / menu）原样返回，绝不改动。
     */
    function CostTrackerModelLabel(props) {
      const { provider, model, placement } = props || {}
      const [hover, setHover] = useState(false)
      const wrapRef = useRef(null)
      const leaveTimer = useRef(null)

      // 每 60 秒重算，让「夜间折扣 / 高峰原价」按时段自动切换
      const [, tick] = useState(0)
      useEffect(() => {
        const t = setInterval(() => tick(x => x + 1), 60000)
        return () => clearInterval(t)
      }, [])

      useEffect(() => {
        if (badgeCache === null) refreshBadges()
        if (limitCache === null) refreshLimits()
        // 累计消耗数据：首次挂载时拉一次，之后由 30s 定时器维护
        refreshUsage()
      }, [])

      // 悬停期间每秒重绘，让「还剩 X 分 Y 秒」实时跳动
      useEffect(() => {
        if (!hover) return undefined
        const t = setInterval(() => tick(x => x + 1), 1000)
        return () => clearInterval(t)
      }, [hover])

      useEffect(() => () => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
      }, [])

      const rawName = String((model && model.name) || '')
      const name = baseName(rawName) || rawName

      // ===== 关键：非下拉列表位置一律原样返回 =====
      if (placement !== 'option') return rawName
      if (!isWorkbuddy(provider)) return rawName

      const tier = tierOf(provider, model)
      if (tier === null) return rawName

      const modelId = String((model && model.id) || '')
      const meta = (badgeCache && badgeCache[modelId]) || {}
      const tags = buildTags(tier, modelId, meta)

      const onEnter = () => {
        if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null }
        setHover(true)
      }
      const onLeave = () => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        leaveTimer.current = setTimeout(() => setHover(false), 150)
      }

      const tagNodes = tags.map((tag, i) => h('span', {
        key: 'tag' + i,
        title: tag.title || tag.text,
        style: {
          padding: '0 7px',
          borderRadius: '4px',
          background: tag.bg,
          color: '#fff',
          fontSize: '10px',
          lineHeight: '17px',
          fontWeight: 700,
          // 字间拉开：常 用 / 夜 间 免 费，比紧贴更清晰
          letterSpacing: '0.18em',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          pointerEvents: 'none',
        },
      }, tag.text))

      const lines = buildHoverLines(modelId, meta)

      // 限流/额度用尽标记：**不经悬停也能一眼看到「这个模型现在不能用」**
      // 三种状态用三种颜色，避免把「猜测」和「事实」混为一谈：
      //   - 上游 402/429 真的拒绝了 → 红色「欠费」/「额度尽」
      //   - 用户手动标记（猜测，可能误判）→ 灰色「手标」，不吓人
      //   - 仅临时限流 → 红色「限流」
      // ⚠️ 教训：2026-10-21 曾把 10/20 的手标误判永久显示成红色「额度尽」，
      // 而那两个模型之后照样成功跑了 19 轮，用户直接质疑插件在胡说。
      const limNow = (limitCache && limitCache[modelId]) || {}
      const limitedNow = !!(limNow.rateLimited && limNow.rateLimitedUntil
        && limNow.rateLimitedUntil > Date.now())
      const exhaustedNow = !!(limNow.quotaExhaustedAt || limNow.creditExhaustedAt)
      const manualMark = exhaustedNow && limNow.manual === true

      const nodes = [h('span', { key: 'n' }, name || rawName), ...tagNodes]

      if (exhaustedNow && manualMark) {
        // 手标：灰色 + 文字说明这是猜的，绝不冒充事实
        nodes.push(h('span', {
          key: 'manual-mark',
          title: '手动标记，上游不返回额度状态故可能是误判；24 小时后自动失效',
          style: {
            padding: '0 6px',
            borderRadius: '4px',
            background: '#4b5563',
            color: '#fff',
            fontSize: '10px',
            lineHeight: '17px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
          },
        }, '手 标'))
      } else if (exhaustedNow) {
        const isCredit = !!limNow.creditExhaustedAt
        nodes.push(h('span', {
          key: 'exhausted',
          title: isCredit
            ? '积分/余额不足，需充值或改用其他模型'
            : '免费额度已用尽，等待每日重置后才能再用',
          style: {
            padding: '0 6px',
            borderRadius: '4px',
            background: isCredit ? '#7f1d1d' : '#b91c1c',
            color: '#fff',
            fontSize: '10px',
            lineHeight: '17px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
          },
        }, isCredit ? '欠 费' : '额 度 尽'))
      } else if (limitedNow) {
        nodes.push(h('span', {
          key: 'locked',
          style: {
            padding: '0 6px',
            borderRadius: '4px',
            background: '#b91c1c',
            color: '#fff',
            fontSize: '10px',
            lineHeight: '17px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
          },
        }, '限 流'))
      }

      if (hover && lines.length) {
        nodes.push(h(HoverTip, { key: 'tip', anchorEl: wrapRef.current, lines }))
      }

      return h('span', {
        key: 'wrap',
        ref: wrapRef,
        style: { display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap', maxWidth: '100%' },
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
      }, nodes)
    }

    // ======================================================================
    // 费用面板页面（sidebar.panellist 行点击后由宿主渲染进 main 区域）
    //
    // 这里用宿主主题令牌（--dsw-alias-*）而不是 widget.js 的硬编码深色，
    // 因为面板是宿主页面的一部分，必须跟随明/暗主题。
    // 数据全部来自 /cost-tracker/* 路由，与浮层同源，不会出现两份口径。
    // ======================================================================

    const PANEL_CSS = [
      // ⚠️ 必须有滚动：面板内容比一屏高（余额/记账/模型清单/编辑器/设置卡），
      // 早期只写 max-width 没有高度约束与 overflow，超出部分直接被裁掉，
      // 用户滚轮也滚不动，最底下的设置卡根本看不到。
      // 用 height:100% + min-height:0 + overflow-y:auto 撑满宿主给的面板区，
      // 让滚动发生在面板内部，而不是靠整个页面滚。
      '.dshctp-root{display:flex;flex-direction:column;gap:14px;padding:18px 20px;',
      '  box-sizing:border-box;width:100%;height:100%;min-height:0;',
      '  overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;',
      '  scrollbar-gutter:stable;',
      '  color:var(--dsw-alias-text-primary,inherit);font-size:13px;line-height:1.6}',
      // 滚动条样式：跟随主题，不让它看起来像外来的
      '.dshctp-root::-webkit-scrollbar{width:10px}',
      '.dshctp-root::-webkit-scrollbar-track{background:transparent}',
      '.dshctp-root::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-primary,rgba(127,127,127,.35));',
      '  border-radius:6px;border:2px solid transparent;background-clip:content-box}',
      '.dshctp-root::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-strong,rgba(127,127,127,.55));',
      '  background-clip:content-box}',
      // 内容限宽并居中，超宽屏幕上不至于拉成一整行
      '.dshctp-inner{display:flex;flex-direction:column;gap:14px;width:100%;max-width:860px;',
      '  margin:0 auto;flex:0 0 auto}',
      '.dshctp-root h2{margin:0;font-size:16px;font-weight:700}',
      '.dshctp-root h3{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;',
      '  color:var(--dsw-alias-text-secondary,#9ca3af);text-transform:uppercase}',
      '.dshctp-card{padding:14px 16px;border-radius:10px;',
      '  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.18))}',
      '.dshctp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 18px}',
      '.dshctp-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px}',
      '.dshctp-kv .k{color:var(--dsw-alias-text-secondary,#9ca3af);font-size:12px}',
      '.dshctp-kv .v{font-weight:700;font-variant-numeric:tabular-nums}',
      '.dshctp-kv .v.free{color:var(--dsw-alias-state-success-primary,#22a06b)}',
      '.dshctp-kv .v.warn{color:var(--dsw-alias-state-error-primary,#d92d20)}',
      '.dshctp-sep{height:1px;background:var(--dsw-alias-border-primary,rgba(127,127,127,.18));margin:8px 0}',
      '.dshctp-tip{padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.55;',
      '  background:var(--dsw-alias-state-warning-primary,rgba(251,191,36,.12));',
      '  border:1px solid var(--dsw-alias-state-warning-primary,rgba(251,191,36,.35))}',
      '.dshctp-tip.bad{background:var(--dsw-alias-state-error-primary,rgba(217,45,32,.1));',
      '  border-color:var(--dsw-alias-state-error-primary,rgba(217,45,32,.32))}',
      '.dshctp-tip.good{background:var(--dsw-alias-state-success-primary,rgba(34,160,107,.1));',
      '  border-color:var(--dsw-alias-state-success-primary,rgba(34,160,107,.3))}',
      '.dshctp-models{display:flex;flex-direction:column;gap:8px}',
      '.dshctp-mrow{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start;',
      '  padding:9px 11px;border-radius:8px;',
      '  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.14))}',
      // 模型清单里的一行：更紧凑，不要每行都像卡片
      '.dshctp-mrow.tight{grid-template-columns:1fr;gap:0;padding:6px 9px;margin-bottom:3px;',
      '  background:transparent;border:none;',
      '  border-bottom:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.1))}',
      '.dshctp-group{margin-bottom:14px}',
      '.dshctp-grouphd{display:flex;align-items:center;gap:6px;margin-bottom:6px;',
      '  padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.18))}',
      '.dshctp-dot2{width:8px;height:8px;border-radius:50%;flex:none}',
      '.dshctp-mname{font-weight:700;word-break:break-all}',
      '.dshctp-mmeta{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af);margin-top:2px}',
      '.dshctp-mnote{font-size:11px;margin-top:5px;white-space:pre-wrap;',
      '  color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.dshctp-pill{display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;',
      '  font-weight:700;letter-spacing:.06em;color:#fff;margin-right:5px}',
      '.dshctp-form{display:flex;flex-direction:column;gap:8px}',
      '.dshctp-form select,.dshctp-form textarea{width:100%;box-sizing:border-box;',
      '  padding:6px 8px;font-size:12px;font-family:inherit;border-radius:6px;',
      '  color:var(--dsw-alias-text-primary,inherit);',
      '  background:var(--dsw-alias-bg-base,transparent);',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.25))}',
      '.dshctp-form textarea{min-height:64px;resize:vertical;line-height:1.55;white-space:pre-wrap}',
      '.dshctp-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}',
      '.dshctp-btn{cursor:pointer;padding:4px 12px;font-size:11px;border-radius:6px;',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.3));',
      '  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));',
      '  color:var(--dsw-alias-text-primary,inherit)}',
      '.dshctp-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.18))}',
      '.dshctp-btn.primary{background:var(--dsw-alias-state-success-primary,#22a06b);',
      '  border-color:transparent;color:#fff}',
      '.dshctp-hint{font-size:11px;color:var(--dsw-alias-text-secondary,#9ca3af);line-height:1.55}',
      '.dshctp-saved{font-size:11px;color:var(--dsw-alias-state-success-primary,#22a06b)}',
      // 自定义气泡的数值输入区
      '.dshctp-custom{margin-top:8px;padding:10px 12px;border-radius:8px;',
      '  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));',
      '  border:1px dashed var(--dsw-alias-border-primary,rgba(127,127,127,.3))}',
      '.dshctp-numrow{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}',
      '.dshctp-num{display:flex;align-items:center;gap:6px;font-size:12px;',
      '  color:var(--dsw-alias-text-secondary,#9ca3af)}',
      '.dshctp-num input{width:78px;box-sizing:border-box;padding:4px 6px;font-size:12px;',
      '  border-radius:6px;font-family:inherit;',
      '  color:var(--dsw-alias-text-primary,inherit);',
      '  background:var(--dsw-alias-bg-base,transparent);',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.25))}',
      '.dshctp-num input:focus{outline:none;',
      '  border-color:var(--dsw-alias-state-success-primary,#22a06b)}',
      '.dshctp-num span.dshctp-hint{margin-left:2px}',
      // —— 主动提示（常驻条 + 帧级气泡）——
      // 常驻条位于 conversation.input.dock（输入框上方），用宿主令牌配色
      '.dshctn-dock{display:flex;flex-direction:column;gap:4px;padding:2px 0;',
      '  align-items:flex-start}',
      '.dshctn-tip{display:inline-block;max-width:100%;box-sizing:border-box;',
      '  padding:5px 10px;border-radius:8px;font-size:12px;line-height:1.45;',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      '  color:var(--dsw-alias-text-primary,inherit)}',
      '.dshctn-tip.warn{background:var(--dsw-alias-state-warning-primary,rgba(251,191,36,.12));',
      '  border:1px solid var(--dsw-alias-state-warning-primary,rgba(251,191,36,.35))}',
      '.dshctn-tip.bad{background:var(--dsw-alias-state-error-primary,rgba(217,45,32,.1));',
      '  border:1px solid var(--dsw-alias-state-error-primary,rgba(217,45,32,.32))}',
      '.dshctn-tip.ok{background:var(--dsw-alias-state-success-primary,rgba(34,160,107,.1));',
      '  border:1px solid var(--dsw-alias-state-success-primary,rgba(34,160,107,.3))}',
      // 帧级气泡：位置/尺寸由 toastStyle() 以**内联样式**下发（用户可配），
      // 这里只留与位置无关的外观，避免两处 left/top 打架。
      // align-items 用 flex-start：多行文本从顶部起排，内容超高时可滚，
      // 不会像 center 那样上下同时被裁。
      '.dshctn-float{display:inline-flex;align-items:flex-start;gap:6px;',
      '  border-radius:12px;line-height:1.45;font-weight:600;',
      '  white-space:normal;word-break:break-word;text-align:left;',
      '  box-shadow:0 6px 20px rgba(0,0,0,.22);',
      '  color:var(--dsw-alias-text-primary,inherit);',
      '  background:var(--dsw-alias-bg-layer-2,#1f2430);',
      '  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.3));',
      '  animation:dshctn-in .18s ease-out}',
      '@keyframes dshctn-in{from{opacity:0}to{opacity:1}}',
      '.dshctn-float.spend{border-color:var(--dsw-alias-state-warning-primary,rgba(251,191,36,.6))}',
      '.dshctn-float.free{border-color:var(--dsw-alias-state-success-primary,rgba(34,160,107,.6))}',
      '.dshctn-float.pending{border-color:var(--dsw-alias-state-error-primary,rgba(217,45,32,.5))}',
    ].join('')

    let panelCssMounted = false
    function mountPanelCss() {
      if (panelCssMounted) return
      try {
        if (typeof document === 'undefined') return
        if (document.getElementById('dshctp-css')) { panelCssMounted = true; return }
        const s = document.createElement('style')
        s.id = 'dshctp-css'
        s.textContent = PANEL_CSS
        ;(document.head || document.documentElement).appendChild(s)
        panelCssMounted = true
      } catch { /* 样式失败不影响功能 */ }
    }

    /** 面板数字格式：整数不留小数点 */
    function pNum(n) {
      const v = Number(n)
      if (!isFinite(v) || v <= 0) return '0'
      return v >= 100 ? String(Math.round(v)) : (Math.round(v * 100) / 100).toString()
    }

    function pTokens(n) {
      const v = Number(n)
      if (!isFinite(v) || v <= 0) return '0'
      if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
      return String(Math.round(v))
    }

    /** 取一次 JSON；失败返回 null，由调用方兜底 */
    function pFetch(path) {
      return fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    }

    /** 主动建议条：拉一次 /recommend，把「该换模型了」这类话讲出来 */
    function RecoTip() {
      const [advice, setAdvice] = useState(null)
      useEffect(() => {
        let alive = true
        pFetch('/cost-tracker/recommend').then((j) => {
          if (alive && j && j.advice) setAdvice(j.advice)
        })
        return () => { alive = false }
      }, [])
      if (!advice || !advice.message) return null
      const cls = advice.level === 'switch' ? 'bad' : (advice.level === 'suggest' ? '' : 'good')
      const icon = advice.level === 'switch' ? '⚠ ' : (advice.level === 'suggest' ? '💡 ' : '✓ ')
      return h('div', { className: 'dshctp-tip ' + cls }, icon + advice.message)
    }

    function CostTrackerPanel() {
      mountPanelCss()
      const [summary, setSummary] = useState(null)
      const [ledger, setLedger] = useState(null)
      const [models, setModels] = useState(null)
      const [limits, setLimits] = useState(null)
      const [usage, setUsage] = useState(null)
      // 模型信息编辑器
      const [pick, setPick] = useState('')
      const [text, setText] = useState('')
      const [saved, setSaved] = useState('')
      // 手动结算状态
      const [reconciling, setReconciling] = useState(false)
      const [recoMsg, setRecoMsg] = useState('')

      const load = useCallback(() => {
        pFetch('/cost-tracker/summary').then(setSummary)
        pFetch('/cost-tracker/ledger').then(setLedger)
        pFetch('/cost-tracker/models').then(setModels)
        pFetch('/cost-tracker/model-limits').then((j) => {
          if (j && j.ok) {
            const map = {}
            for (const m of j.models || []) map[m.id] = m
            setLimits(map)
          }
        })
        pFetch('/cost-tracker/usage').then((j) => {
          if (j && j.ok) setUsage(j.models || {})
        })
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 60000)
        return () => clearInterval(t)
      }, [load])

      // 选中模型变化时，把当前已保存的文案填进编辑框
      useEffect(() => {
        if (!pick) { setText(''); return }
        const notes = (models && models.modelNotes) || {}
        setText(typeof notes[pick] === 'string' ? notes[pick] : '')
      }, [pick, models])

      const save = useCallback(() => {
        if (!pick) return
        fetch('/cost-tracker/model-notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: pick, value: text }),
        })
          .then((r) => r.json())
          .then((j) => {
            setSaved(j && j.ok ? '已保存' : '保存失败')
            setTimeout(() => setSaved(''), 2000)
            load()
          })
          .catch(() => setSaved('保存失败'))
      }, [pick, text, load])

      /**
       * 手动结算未结清轮次（面板「刷新积分」按钮）。
       * 服务端用当前余额与最早未结清轮次的基准相减，补记消耗并回写 totals。
       * 成功后重新拉数据，警告条会因 unsettled 归零而自动消失。
       */
      const reconcile = useCallback(() => {
        setReconciling(true)
        setRecoMsg('')
        fetch('/cost-tracker/reconcile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
          .then((r) => r.json())
          .then((j) => {
            setRecoMsg(j && j.message ? j.message : (j && j.reason ? '结算失败：' + j.reason : '结算失败'))
            load()
          })
          .catch((e) => setRecoMsg('结算失败：' + (e && e.message ? e.message : '网络错误')))
          .then(() => { setReconciling(false); setTimeout(() => setRecoMsg(''), 8000) })
      }, [load])

      const db = summary && summary.deepseekBalance
      const al = summary && summary.aliyun
      const wb = summary && summary.workbuddy
      const ranked = (models && models.ranked) || []
      const notes = (models && models.modelNotes) || {}

      const kv = (k, v, cls) => h('div', { key: k, className: 'dshctp-kv' }, [
        h('span', { key: 'k', className: 'k' }, k),
        h('span', { key: 'v', className: 'v' + (cls ? ' ' + cls : '') }, v),
      ])

      // 外层 .dshctp-root 负责撑满 + 滚动，内层 .dshctp-inner 负责限宽居中。
      // 两层分开是因为在同一元素上同时做「撑满滚动」和「限宽居中」会互相干扰：
      // max-width 会让滚动条内缩，看起来像内容被截断。
      return h('div', { className: 'dshctp-root' }, [
        h('div', { key: 'inner', className: 'dshctp-inner' }, [
        h('h2', { key: 't' }, '费用追踪'),

        // ---- 余额 ----
        h('div', { key: 'bal', className: 'dshctp-card' }, [
          h('h3', { key: 'h' }, '余额'),
          h('div', { key: 'g', className: 'dshctp-grid' }, [
            kv('DeepSeek 官方',
              db && db.available != null ? '¥' + pNum(db.available) : (db && db.error ? '读不到' : '—'),
              'warn'),
            kv('阿里云券',
              al && al.calibratedBalance != null ? '¥' + pNum(al.calibratedBalance) : '—'),
            kv('WorkBuddy 积分',
              wb && wb.credits != null ? pNum(wb.credits) + ' 积分' : '—', 'free'),
          ]),
        ]),

        // ---- 记账 ----
        ledger && ledger.ok
          ? h('div', { key: 'led', className: 'dshctp-card' }, [
            h('h3', { key: 'h' }, '记账'),
            h('div', { key: 'g', className: 'dshctp-grid' }, [
              (() => {
                const lt = ledger.lastTurn
                if (!lt) return kv('本轮', '—')
                // 本轮也要分平台：aliyun 走人民币、workbuddy 走积分，
                // 拼成一行会让人以为 WorkBuddy 在扣钱。
                const plat = ((lt.models || [])[0] || {}).platform || ''
                const reason = lt.workbuddy && lt.workbuddy.reason
                const pending = reason === 'zero-pending' || reason === 'unconfirmed'
                  || reason === 'baseline-established' || reason === 'baseline-stale'
                if (plat === 'workbuddy' || (lt.workbuddy && typeof lt.workbuddy.spent === 'number')) {
                  const spent = Number(lt.workbuddy && lt.workbuddy.spent)
                  let label
                  // 与气泡同理：allFree 优先，免费轮不该说成「结算中/未入账」
                  if (lt.allFree) label = '免费'
                  else if (Number.isFinite(spent) && spent > 0) label = pNum(spent) + ' 积分'
                  else if (pending) label = reason === 'unconfirmed' ? '积分未入账' : '结算中…'
                  else label = '0 积分'
                  return kv('本轮 · WorkBuddy', label,
                    spent > 0 && !lt.allFree ? 'warn' : (label === '免费' ? 'free' : ''))
                }
                if (Number(lt.costTokenBased) > 0) {
                  return kv('本轮 · 阿里云', '¥' + pNum(lt.costTokenBased), 'warn')
                }
                return kv('本轮', '—')
              })(),
              // ⚠️ 两个平台的账必须分列，不能合成一行。
              // 2026-10-22 用户质疑「WorkBuddy 不是看积分吗，怎么会有人民币计费」——
              // 实测那 ¥4.70 全部来自 aliyun（阿里云 deepseek-v4.1-flash，11 轮），
              // WorkBuddy 的 5 个模型 cost 全是 0。口径本身没错，错在面板把
              // 「今天的 ¥X / Y 积分」写在一起，看起来就像 WorkBuddy 也在扣钱。
              kv('今天 ' + ((ledger.day || {}).turns || 0) + ' 轮 · 阿里云',
                '¥' + pNum((ledger.day || {}).costTokenBased),
                Number((ledger.day || {}).costTokenBased) > 0 ? 'warn' : ''),
              kv('今天 WorkBuddy',
                String((ledger.day || {}).workbuddyCredits || 0) + ' 积分',
                Number((ledger.day || {}).workbuddyCredits) > 0 ? 'warn' : ''),
              kv('本月 ' + ((ledger.month || {}).turns || 0) + ' 轮 · 阿里云',
                '¥' + pNum((ledger.month || {}).costTokenBased)),
              kv('本月 WorkBuddy',
                String((ledger.month || {}).workbuddyCredits || 0) + ' 积分'),
            ]),
            h('div', { key: 'n', className: 'dshctp-hint', style: { marginTop: '8px' } },
              'WorkBuddy 只扣积分，不产生人民币费用（上表已分平台列出）。'
              + '阿里云的 ¥ 是 token 按倍率折算的估算值，非账单。'),
          ])
          : null,

        // ---- 结算异常 + 手动结算按钮 ----
        // 「N 轮积分未结清」以前是一条永远消不掉的警告——用户没有任何
        // 办法让它消失。这里给一个「刷新积分」按钮：拉一次当前余额，
        // 用最早未结清轮次的基准与余额差补记消耗，然后警告自然消失。
        ledger && ledger.settlement && ledger.settlement.unsettled > 0
          ? h('div', { key: 'set', className: 'dshctp-tip bad' }, [
            h('div', { key: 'txt' },
              '⚠ 最近 ' + ledger.settlement.recent + ' 轮里有 ' + ledger.settlement.unsettled
              + ' 轮积分未结清：该轮消耗未确认，累计积分可能偏低。'),
            h('div', { key: 'act', className: 'dshctp-actions', style: { marginTop: '8px', justifyContent: 'flex-start' } }, [
              h('button', {
                key: 'rc',
                className: 'dshctp-btn',
                type: 'button',
                disabled: !!reconciling,
                onClick: reconcile,
              }, reconciling ? '结算中…' : '刷新积分并结算'),
              recoMsg ? h('span', { key: 'm', className: 'dshctp-hint' }, recoMsg) : null,
            ]),
          ])
          : null,

        // ---- 无法归因的轮次（余额上升导致）----
        ledger && ledger.settlement && ledger.settlement.unresolvable > 0
          ? h('div', { key: 'unr', className: 'dshctp-tip' },
            '⚠ 有 ' + ledger.settlement.unresolvable + ' 轮无法归因：期间余额上升'
            + '（充值或发放权益），无法从余额差反推消耗。可点「刷新积分」重试。')
          : null,

        // ---- 主动建议 ----
        h(RecoTip, { key: 'adv' }),

        // ---- 全平台模型清单（按平台分组，没用过的折叠）----
        h(AllModelsCard, { key: 'allmodels' }),

        // ---- 模型信息编辑器 ----
        h('div', { key: 'e', className: 'dshctp-card' }, [
          h('h3', { key: 'h' }, '补充模型信息'),
          h('div', { key: 'f', className: 'dshctp-form' }, [
            h('select', {
              key: 's',
              value: pick,
              onChange: (e) => setPick(e.target.value),
            }, [
              h('option', { key: 'ph', value: '' }, '选择模型…'),
              ...ranked.map((m) => h('option', { key: m.id, value: m.id }, String(m.name || m.id))),
            ]),
            h('textarea', {
              key: 't',
              value: text,
              placeholder: '把官方公告或自己的备注粘贴到这里，例如：\n限时免费：7 月 6 日 – 10 月 31 日，每日赠送免费额度',
              onChange: (e) => setText(e.target.value),
            }),
            h('div', { key: 'a', className: 'dshctp-actions' }, [
              saved ? h('span', { key: 'sv', className: 'dshctp-saved' }, saved) : null,
              h('button', {
                key: 'save',
                className: 'dshctp-btn primary',
                type: 'button',
                disabled: !pick,
                onClick: save,
              }, '保存'),
            ]),
            h('div', { key: 'h', className: 'dshctp-hint' },
              '保存后，模型选择器里该模型的悬停说明会显示这段文字（覆盖内置公告）。'
              + '清空并保存可恢复内置公告。'),
          ]),
        ]),

        // ---- 气泡外观设置 ----
        h(ToastPrefsCard, { key: 'toastprefs' }),
        ]),
      ])
    }

    /**
     * 拖动预览的常驻位点（注册在 shell.overlay）。
     *
     * ⚠️ 为什么必须放 shell.overlay 而不是面板内：
     * 用户要「一边看对话一边调位置」，而费用面板会占满主区域、看不到对话。
     * shell.overlay 是宿主提供的**帧级浮动层**（渲染在所有列之上、独立于
     * 各列的滚动容器），注册进去后切到任何面板——包括对话——预览都还在，
     * 这样才谈得上「看着对话确定位置」。
     *
     * 只在用户选过「自定义」之后才显示，避免平时多一个碍事的框。
     */
    function ToastDragPreviewHost() {
      const [pref, setPref] = useState(() => readToastPref())
      useEffect(() => {
        const fn = (next) => setPref({ ...next, custom: { ...next.custom } })
        toastPrefListeners.add(fn)
        return () => { toastPrefListeners.delete(fn) }
      }, [])
      // 显式开关：用户可能只想用预设，不希望页面上老浮着一个框
      if (pref.editing !== true) return null
      return h(ToastDragPreview)
    }

    const inject = ['slots', 'locale']

    /**
     * 插件入口。
     *
     * ⚠️ 整个函数包在 try/catch 里：**前端插件抛异常会让 DSH 判定启动失败**，
     * 弹出「禁用第三方插件」恢复界面，把用户所有插件都清掉。
     * 代价是调试信息会丢，所以出错时打 console.error 而不静默。
     * 任何新代码都必须先跑一遍运行时验证（apply + 组件渲染），
     * 不能只靠 node --check —— 它查不出未定义标识符。
     */
    function apply(ctx) {
      try {
        applyInner(ctx)
      } catch (e) {
        try { console.error('[dsh-cost-tracker] apply failed:', e) } catch { /* 忽略 */ }
      }
    }

    function applyInner(ctx) {
      const namespace = 'cost-tracker'

      ctx.effect(
        () => ctx.locale.register(namespace, {
          zh: { 'tier.free': '免费', 'tier.main': '主力', 'tier.common': '常用', 'tier.rare': '少用' },
          en: { 'tier.free': 'free', 'tier.main': 'main', 'tier.common': 'common', 'tier.rare': 'rare' },
        }),
        'cost-tracker: dictionaries',
      )

      refreshBadges()
      // 限流状态也要拉：悬停说明里要显示「何时恢复」
      refreshLimits()
      // 累计消耗：悬停说明里显示「你已用：N 轮 · X 积分」
      refreshUsage()

      // 悬停说明里的倒计时需要持续刷新，30 秒重拉一次限流状态
      ctx.effect(() => {
        const t = setInterval(() => { refreshLimits(); refreshUsage() }, 30000)
        return () => clearInterval(t)
      }, 'cost-tracker: limits refresh')

      // ---- 模型下拉标签（single slot）----
      // ⚠️ 必须显式给 priority。
      // `conversation.input.model.label` 是 **single** slot，原生 UI（registrant
      // "Kb"）已占用 priority 0。用默认 0 注册会抛
      //   "single slot ... already has a registration at priority 0
      //    (registered by Kb) — register at a different priority to shadow it"
      // 而这个异常会被外层 try/catch 吞掉，**连带后面的侧栏入口和提示全部
      // 不执行**——2026-10-21 的「钱袋没了 + 提示没了」就是这个原因。
      // 规则：single slot 用不同 priority 遮蔽原生渲染。
      // ⚠️ 遮蔽方向极易搞反（2026-10-21 就错了一次）：
      //   报错文案说 "lowest renders" —— **优先级数值最小的那个才渲染**。
      //   原生 Kb 占 0，所以必须用**负数**才能真正盖过它；
      //   上一版写 priority: 10（比 0 大）等于把渲染权让给原生，
      //   于是「免费/常用」标签全没了——用户报的「模型列表标签没了」就是这个。
      //   同时不能用 0（会和原生撞车直接抛错，那才是钱袋消失的原因）。
      const LABEL_PRIORITY = -10
      ctx.effect(() => {
        let dispose = null
        try {
          dispose = ctx.slots.inject('conversation.input.model.label', () =>
            ctx.slots.register({
              name: 'conversation.input.model.label',
              priority: LABEL_PRIORITY,
              locale: namespace,
            }, CostTrackerModelLabel))
        } catch (e) {
          try { console.error('[dsh-cost-tracker] model label register failed:', e) } catch { /* 忽略 */ }
        }
        return () => { try { dispose && dispose() } catch { /* 忽略 */ } }
      }, 'cost-tracker: model label')

      // ---- 左侧栏入口：与「扩展管理」等原生行并列 ----
      // 做法完全对齐官方插件市场 dshmarket 的 sidebar-entry：
      //   sidebar.panellist 注册一个图标行 + main 注册一个 panel，
      //   点击行由宿主 layout.selectPanel() 切换到我们的 panel。
      // 这是宿主公开契约里唯一支持的「一键打开一个页面」路径。
      //
      // ⚠️ 不再保留浮层兜底。历史上浮层（widget.js）带来两个反复出现的 bug：
      //   1) 桌面端 index-inject 表是启动期一次性收集，热重载/刷新常丢失
      //      → 「插件时不时消失」；
      //   2) 浮层自带的 💰 按钮会贴到侧栏账户行右端，与正式侧栏行**并存**，
      //      出现「瞬移到用户头像位置并覆盖头像」。
      // 侧栏行由本 client 半区在每次页面加载时重新注册，本就是稳定入口，
      // 浮层只会制造重复入口，故彻底移除。
      //
      // ⚠️ 三个注册点（模型标签 / 侧栏入口 / 主动提示）各自独立 try/catch：
      // 任一注册抛错都不许连累其他功能，更不许冒泡到 applyInner 之外。
      // 2026-10-21 的教训：单个 single-slot 的 priority 冲突，
      // 就让整个插件的钱袋和主动提示一起消失。
      try { registerSidebarEntry(ctx, namespace) } catch (e) {
        try { console.error('[dsh-cost-tracker] sidebar entry failed:', e) } catch { /* 忽略 */ }
      }
      try { registerCostNotices(ctx) } catch (e) {
        try { console.error('[dsh-cost-tracker] notices failed:', e) } catch { /* 忽略 */ }
      }
    }

    // ======================================================================
    // 主动提示：用户要的两件事
    //
    // 1.「当前模型不是最省钱的」→ 输入框上方常驻条 + 帧级气泡
    // 2.「本回合消耗多少积分」→ 回合结束后气泡 + 常驻条里的累计
    //
    // 实现方式（全部走宿主公开契约，不用 DOM hack）：
    //   - conversation.input.dock（list）：输入框上方的常驻条，属于当前会话
    //   - shell.overlay（list）：帧级浮动层，用于回合结束的瞬时气泡
    // 数据来源是已有的 /cost-tracker/* HTTP 路由，client 定时轮询。
    // ======================================================================

    /** 轮询间隔：提示要跟手，又不能把 host 打爆 */
    const NOTICE_POLL_MS = 8000

    /**
     * 共享数据：一个 poller 产出，两个位点订阅。
     * ⚠️ 必须是**模块作用域**变量：注册函数返回的组件（CostDockLive /
     * CostToastLive）在闭包外渲染，读不到 registerCostNotices 的局部变量。
     * 这一点被运行时测试抓到过：noticeShared 放在函数里时组件永远渲染成空。
     */
    let noticeShared = null
    const noticeListeners = new Set()
    function subscribeNotices(fn) { noticeListeners.add(fn); return () => noticeListeners.delete(fn) }
    function notifyNotices() { noticeListeners.forEach((fn) => fn()) }

    /** 注册两个提示位点 */
    function registerCostNotices(ctx) {
      // 自诊断：把注册结果挂到 window 上，便于在真实浏览器里核对
      // （inspect 工具在本环境拿不到 occupants，只能让页面自己报）
      // ⚠️ 只初始化**自己负责**的两个字段。panellist / panel 归
      // registerSidebarEntry 管，这里若也置 'pending' 会把它的成功状态
      // 覆盖掉——2026-10-21 实测踩过：侧栏明明注册成功，诊断却显示 pending。
      const diag = (window.__dshCostTrackerDiag = window.__dshCostTrackerDiag || {})
      if (diag.dock === undefined) diag.dock = 'pending'
      if (diag.overlay === undefined) diag.overlay = 'pending'
      diag.lastTurn = 0
      diag.lastSession = ''
      diag.toast = null
      diag.adviceLevel = null

      ctx.effect(() => {
        let alive = true
        // 指纹：只有它变化才通知订阅者，避免无意义重渲染导致闪烁
        let lastFingerprint = ''
        const poll = () => {
          if (!alive) return
          pFetch('/cost-tracker/ledger').then((j) => {
            if (!alive || !j) return
            const lt = j.lastTurn
            const cur = lt && typeof lt.turn === 'number' ? lt.turn : 0
            // ⚠️ 必须按 sessionId + turn 组合判断「新回合」。
            // turn 是**单会话轮次号**而非全局序号：多会话并行时它会在各会话间
            // 跳（实测 19→177→20→178→21）。只用 cur !== prev 会有两个错：
            //   · 别的会话完成一轮 → 本界面也弹气泡（误触发）
            //   · 同一会话连续两轮 turn 相同 → 不弹（漏触发）
            // 所以 key 取「sessionId:turn」，只有它变了才算新回合。
            // ⚠️ prevKey 必须保证是字符串，不能是 undefined。
            // 见下方 recommend 回调处对 noticeShared 兜底对象的说明：
            // 一旦 key 字段缺失，这里拿到 undefined 会让
            // `prevKey !== ''` 恒假，气泡永远不触发。
            const prevKey = noticeShared && typeof noticeShared.key === 'string' ? noticeShared.key : ''
            // 只有「上一轮基准已建立 且 组合 key 变了」才算新回合：
            // 首次 poll 只建基准不弹，避免每次开页面都重放历史气泡。
            const hasBaseline = prevKey !== ''
            const isNewTurn = hasBaseline && key !== prevKey
            let toast = null
            if (cur > 0 && isNewTurn && lt) {
              const wb = lt.workbuddy || {}
              let text
              let kind = 'info'
              // ⚠️ allFree 必须**优先**于 reason 判断。
              // 实测（2026-10-22 23:12，hy4-preview 夜间免费轮）：
              // 免费轮本来就该 spent=0，reason 于是落到 zero-pending，
              // 若先判 reason 就会显示「本轮积分未入账」——把没花钱的
              // 一轮说成账没算清，是误导。免费轮应直接说「本轮免费」。
              if (lt.allFree) {
                text = '本轮免费，未消耗积分'
                kind = 'free'
              } else if (wb.reason === 'unconfirmed' || wb.reason === 'zero-pending') {
                text = '本轮积分未入账，稍后自动结算'
                kind = 'pending'
              } else if (Number(wb.spent) > 0) {
                text = '本轮消耗 ' + pNum(wb.spent) + ' 积分'
                if (Number(j.day && j.day.workbuddyCredits) > 0) {
                  text += '（今天累计 ' + pNum(j.day.workbuddyCredits) + '）'
                }
                kind = 'spent'
              }
              if (text) toast = { key: 'turn-' + cur + '-' + Date.now(), text, kind }
            }
            noticeShared = { ledger: j, lastTurn: cur, key, toast: toast || (noticeShared ? noticeShared.toast : null) }
            // 诊断：把最近一次 poll 的结果挂上去，便于在控制台核对气泡是否触发
            diag.lastTurn = cur
            diag.lastSession = lt ? String(lt.sessionId || '') : ''
            diag.toast = toast ? (toast.kind + ': ' + toast.text) : null
            // ⚠️ 只在真有变化时通知订阅者。
            // 以前每 8 秒 poll 都无条件 notifyListeners()，即使数据完全没变，
            // 也会让常驻条/气泡重渲染一次 —— 用户看到的就是「时不时一闪一闪」。
            // 用 key + toast.key 做指纹，指纹不变就不通知。
            const fp = key + '|' + (toast ? toast.key : '')
            if (fp !== lastFingerprint) {
              lastFingerprint = fp
              noticeListeners.forEach((fn) => fn())
            }
          }).catch(() => {})
          pFetch('/cost-tracker/recommend').then((j) => {
            if (!alive || !j || !j.advice) return
            // ⚠️ 兜底对象必须带 key:''。
            // 两个请求是并发的，谁先返回不确定。若 recommend 先回来并在这里
            // 建了一个没有 key 字段的对象，下一次 ledger 回调读
            // `prevKey = noticeShared.key` 会得到 undefined，
            // 于是 `prevKey !== ''` 为 false → 永远进不了「新回合」分支
            // → toast 恒为 null → 气泡永远不显示。
            // （2026-10-22 实测：lastTurn 正确变 206，但 toast 一直是 null，
            //  用户反馈「再触发一次冒泡，我没看见」就是这个原因。）
            if (!noticeShared) noticeShared = { ledger: null, lastTurn: 0, key: '', toast: null }
            const prevLevel = noticeShared.advice ? noticeShared.advice.level : ''
            const prevMsg = noticeShared.advice ? noticeShared.advice.message : ''
            noticeShared.advice = j.advice
            diag.adviceLevel = j.advice.level
            // 同样只在建议真的变了才通知，避免每 8 秒闪一次
            if (j.advice.level !== prevLevel || j.advice.message !== prevMsg) {
              noticeListeners.forEach((fn) => fn())
            }
          }).catch(() => {})
        }
        poll()
        const t = setInterval(poll, NOTICE_POLL_MS)
        return () => { alive = false; clearInterval(t) }
      }, 'cost-tracker: notice poller')

      const subscribe = (fn) => { noticeListeners.add(fn); return () => noticeListeners.delete(fn) }

      // 常驻条（输入框上方）
      ctx.slots.inject('conversation.input.dock', () => {
        try {
          const off = ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-cost-tracker-notice',
            order: 50,
            label: '费用提示',
          }, () => h(CostDockLive, { subscribe }))
          diag.dock = 'registered'
          return off
        } catch (e) {
          diag.dock = 'failed: ' + (e && e.message ? e.message : String(e))
          return () => {}
        }
      })

      // 帧级气泡（回合结束）
      ctx.slots.inject('shell.overlay', () => {
        try {
          const off = ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-cost-tracker-toast',
            order: 60,
            label: 'dsh-cost-tracker',
          }, () => h(CostToastLive, { subscribe }))
          diag.overlay = 'registered'
          return off
        } catch (e) {
          diag.overlay = 'failed: ' + (e && e.message ? e.message : String(e))
          return () => {}
        }
      })

      // 拖动预览也挂在 shell.overlay：切换面板（包括回到对话）时它都还在，
      // 用户才能「看着对话调位置」。独立 id，与上面的瞬时气泡互不干扰。
      ctx.slots.inject('shell.overlay', () => {
        try {
          const off = ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-cost-tracker-dragpreview',
            order: 55,
            label: 'dsh-cost-tracker 拖动预览',
          }, () => h(ToastDragPreviewHost))
          diag.dragPreview = 'registered'
          return off
        } catch (e) {
          diag.dragPreview = 'failed: ' + (e && e.message ? e.message : String(e))
          return () => {}
        }
      })
    }

    /** 订阅共享数据的常驻条 */
    function CostDockLive(props) {
      const [pref] = useState(() => readToastPref())
      const [, force] = useState(0)
      useEffect(() => {
        const off = props.subscribe(() => force((n) => n + 1))
        const onPref = () => force((n) => n + 1)
        toastPrefListeners.add(onPref)
        return () => {
          if (typeof off === 'function') off()
          toastPrefListeners.delete(onPref)
        }
      }, [props.subscribe])
      // ⚠️ 常驻条默认关闭。
      // 2026-10-22 用户明确表示：建议不该显示在输入框上方（「不是气泡
      // 该有的位置」）。建议已并入气泡显示，这里默认不渲染；
      // 若用户确实想要输入框上方常驻，可在设置里打开。
      if (pref.dockAdvice !== true) return null
      // 共享对象在模块级，这里直接读（subscribe 触发重渲染）
      if (!noticeShared) return null
      const advice = noticeShared.advice
      if (!advice || !advice.message || advice.level === 'ok') return null
      const cls = advice.level === 'switch' ? 'dshctn-tip bad' : 'dshctn-tip warn'
      const icon = advice.level === 'switch' ? '⚠ ' : '💡 '
      const nodes = [h('div', { key: 'adv', className: cls }, icon + advice.message)]
      if (noticeShared.toast) {
        const tcls = noticeShared.toast.kind === 'spent' ? 'dshctn-tip warn'
          : (noticeShared.toast.kind === 'free' ? 'dshctn-tip ok' : 'dshctn-tip bad')
        nodes.push(h('div', { key: noticeShared.toast.key, className: tcls }, '🧾 ' + noticeShared.toast.text))
      }
      return h('div', { className: 'dshctn-dock' }, nodes)
    }

    /**
     * 全平台模型清单：按平台分组，**没用过的默认折叠**。
     *
     * 用户要求：「把其他 API 的也弄进去，包括阿里云的、deepseek 官方的，
     * 然后在分类里面，把没用的模型整理起来不展开显示，如果有需要再展开」。
     *
     * 为什么必须折叠：阿里云一家就 54 个模型，其中只有 2 个用过；
     * 全展开会把「用过的」淹没在几十条无关项里。
     */
    function AllModelsCard() {
      const [data, setData] = useState(null)
      const [open, setOpen] = useState({})

      useEffect(() => {
        let alive = true
        const load = () => {
          pFetch('/cost-tracker/all-models').then((j) => {
            if (alive && j && j.ok) setData(j.groups || [])
          }).catch(() => {})
        }
        load()
        const t = setInterval(load, 60000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      if (!data) {
        return h('div', { className: 'dshctp-card' }, [
          h('h3', { key: 'h' }, '模型清单'),
          h('div', { key: 'l', className: 'dshctp-hint' }, '加载中…'),
        ])
      }

      const PLAT_COLOR = { aliyun: '#0369a1', deepseek: '#4f46e5', workbuddy: '#15803d' }

      const rowOf = (m) => {
        const pills = []
        if (m.free) pills.push({ t: '免费', c: '#15803d' })
        if (Number(m.usedTurns) > 0) pills.push({ t: '用过', c: '#6b7280' })
        const meta = []
        if (m.credits) meta.push(String(m.credits) + ' 倍率')
        if (m.contextWindow) meta.push('上下文 ' + pTokens(m.contextWindow))
        if (m.badges && m.badges.length) meta.push(m.badges.join(' · '))
        if (Number(m.usedTurns) > 0) meta.push('已用 ' + m.usedTurns + ' 轮')
        if (Number(m.usedCost) > 0) meta.push('¥' + pNum(m.usedCost))
        return h('div', { key: m.id + '@' + (m.provider || ''), className: 'dshctp-mrow tight' }, [
          h('div', { key: 'l' }, [
            h('div', { key: 'n', className: 'dshctp-mname' }, [
              ...pills.map((p, i) => h('span', {
                key: 'p' + i, className: 'dshctp-pill', style: { background: p.c },
              }, p.t)),
              String(m.name || m.id),
            ]),
            meta.length ? h('div', { key: 'meta', className: 'dshctp-mmeta' }, meta.join(' · ')) : null,
          ]),
        ])
      }

      return h('div', { className: 'dshctp-card' }, [
        h('h3', { key: 'h' }, '模型清单'),
        h('div', { key: 'hint', className: 'dshctp-hint', style: { marginBottom: '8px' } },
          '按平台分组；没用过的模型默认收起，需要时点「展开」。'),
        ...data.map((g) => {
          const used = g.models.filter((m) => Number(m.usedTurns) > 0)
          const unused = g.models.filter((m) => !(Number(m.usedTurns) > 0))
          const isOpen = open[g.platform] === true
          return h('div', { key: g.platform, className: 'dshctp-group' }, [
            h('div', { key: 't', className: 'dshctp-grouphd' }, [
              h('span', {
                key: 'dot',
                className: 'dshctp-dot2',
                style: { background: PLAT_COLOR[g.platform] || '#6b7280' },
              }),
              h('span', { key: 'n', style: { fontWeight: 700 } }, g.title),
              h('span', { key: 'c', className: 'dshctp-hint', style: { marginLeft: '6px' } },
                g.models.length + ' 个 · 用过 ' + used.length),
            ]),
            h('div', { key: 'used' }, used.map(rowOf)),
            unused.length
              ? h('div', { key: 'unused' }, [
                h('button', {
                  key: 'toggle',
                  type: 'button',
                  className: 'dshctp-btn',
                  style: { marginTop: '4px' },
                  onClick: () => setOpen((s) => ({ ...s, [g.platform]: !isOpen })),
                }, isOpen ? '▾ 收起 ' + unused.length + ' 个未使用' : '▸ 展开 ' + unused.length + ' 个未使用'),
                isOpen ? h('div', { key: 'list', style: { marginTop: '4px' } }, unused.map(rowOf)) : null,
              ])
              : null,
          ])
        }),
      ])
    }

    /** 订阅共享数据的帧级气泡：按设置的位置/尺寸显示，按时长自动消失（0=常驻） */
    function CostToastLive(props) {
      const [shown, setShown] = useState(null)
      const [off, setOff] = useState(false)
      // 订阅设置变化：用户在面板里改完，下一个气泡立刻按新样式出现
      const [pref, setPref] = useState(() => readToastPref())
      useEffect(() => {
        const fn = (next) => setPref({ ...next })
        toastPrefListeners.add(fn)
        return () => { toastPrefListeners.delete(fn) }
      }, [])
      useEffect(() => {
        const unsub = props.subscribe(() => {
          if (noticeShared && noticeShared.toast && (!shown || noticeShared.toast.key !== shown.key)) {
            setShown(noticeShared.toast)
            setOff(false)
          }
        })
        return () => { if (typeof unsub === 'function') unsub() }
      }, [shown])
      useEffect(() => {
        if (!shown) return
        // durationMs === 0 → 常驻，不自动消失（下一条消息到来时才替换）
        if (!(Number(pref.durationMs) > 0)) return
        const t = setTimeout(() => setOff(true), Number(pref.durationMs))
        return () => clearTimeout(t)
      }, [shown, pref.durationMs])
      if (!shown || off) return null
      const cls = shown.kind === 'spent' ? 'dshctn-float spend'
        : (shown.kind === 'free' ? 'dshctn-float free'
          : (shown.kind === 'pending' ? 'dshctn-float pending' : 'dshctn-float info'))
      const icon = shown.kind === 'spent' ? '🧾 ' : (shown.kind === 'free' ? '✓ ' : (shown.kind === 'pending' ? '⏳ ' : 'ℹ '))

      // ⚠️ 省钱建议要**并进气泡**，而不是另开一块常驻条。
      // 2026-10-22 用户反馈：建议（「当前 X 消耗积分，Y 现在免费，切过去更省」）
      // 显示在输入框上方，用户认为「不是气泡该有的位置」。
      // 两类信息都归气泡：第 1 行本轮消耗，第 2 行省钱建议（若有）。
      const advice = pref.dockAdvice !== true && noticeShared ? noticeShared.advice : null
      const adviceLine = advice && advice.message && advice.level !== 'ok'
        ? (advice.level === 'switch' ? '⚠ ' : '💡 ') + advice.message
        : null

      return h('div', {
        className: cls,
        role: 'status',
        style: { ...toastStyle(pref), flexDirection: 'column', alignItems: 'stretch' },
      }, [
        h('div', { key: 'main' }, icon + shown.text),
        adviceLine ? h('div', {
          key: 'adv',
          style: { marginTop: '4px', opacity: 0.9, fontSize: '0.92em' },
        }, adviceLine) : null,
      ])
    }

    /**
     * 可拖动的气泡预览：直接在页面上拖主体移动、拖四角改大小。
     *
     * 为什么不用「手填 X/Y/宽/高」：那种方式要先在脑子里换算坐标，
     * 填完还得想象效果，用户实测评价是「太垃圾」。拖拽所见即所得，
     * 拖完松手即保存，是这个场景真正合适的交互。
     *
     * 实现要点：
     * - 拖动用 window 级 pointermove/pointerup 监听，而不是在被拖元素上，
     *   否则鼠标快速移动会脱离元素、拖拽中断。
     * - 用 Pointer Events 而不是 mouse 事件，触控板/触屏都能用。
     * - 拖动过程中只改本地 state（不写 localStorage），松手才落盘，
     *   避免每帧写存储。
     * - 四个角各自有独立的向左/向右、向上/向下的缩放逻辑；
     *   拖左上角时 left 与 width 要反向联动（这是最容易写错的地方）。
     * - 所有结果都夹在视口内，绝不把气泡拖出屏幕外。
     * - **10 秒无操作自动关闭**：预览是常驻浮层，浮久了会挡视线；
     *   用户调完往往就忘了关。任何拖动/缩放都会重置这个计时，
     *   所以「正在调」的时候绝不会被关掉。
     */
    const PREVIEW_IDLE_MS = 10000

    function ToastDragPreview() {
      const [pref, setPref] = useState(() => readToastPref())
      // 拖动中的临时几何，松手才写回持久化
      const [geo, setGeo] = useState(null)
      const [active, setActive] = useState(false)
      const dragRef = useRef(null)
      // 空闲计时器：每次交互重置
      const idleRef = useRef(null)

      /** 重置空闲计时；到点自动关掉预览（写 editing=false） */
      const bumpIdle = useCallback(() => {
        if (idleRef.current) { clearTimeout(idleRef.current); idleRef.current = null }
        idleRef.current = setTimeout(() => {
          idleRef.current = null
          writeToastPref({ editing: false })
        }, PREVIEW_IDLE_MS)
      }, [])

      // 挂载即开始计时；卸载时清掉，避免定时器泄漏
      useEffect(() => {
        bumpIdle()
        return () => {
          if (idleRef.current) { clearTimeout(idleRef.current); idleRef.current = null }
        }
      }, [bumpIdle])

      useEffect(() => {
        const fn = (next) => setPref({ ...next, custom: { ...next.custom } })
        toastPrefListeners.add(fn)
        return () => { toastPrefListeners.delete(fn) }
      }, [])

      const cur = geo || {
        x: pref.custom.x,
        y: pref.custom.y,
        width: pref.custom.width,
        height: pref.custom.height > 0 ? pref.custom.height : 120,
      }

      // 统一开始拖拽：mode 为 'move' 或四角之一 'nw'/'ne'/'sw'/'se'
      const startDrag = (mode) => (ev) => {
        try {
          ev.preventDefault()
          ev.stopPropagation()
        } catch { /* 忽略 */ }
        // 一开始拖就重置空闲计时：用户正在操作，绝不能被自动关闭
        bumpIdle()
        const begin = { ...cur }
        const startX = ev.clientX
        const startY = ev.clientY
        dragRef.current = { mode, begin, startX, startY }
        setActive(true)

        const onMove = (e) => {
          const d = dragRef.current
          if (!d) return
          // 拖动过程中每次移动都续期：手一直动着就不该被关
          bumpIdle()
          const dx = e.clientX - d.startX
          const dy = e.clientY - d.startY
          const b = d.begin
          // 视口边界：留 8px 余量，避免贴死后抓不住
          const vw = (window.innerWidth || 1200) - 8
          const vh = (window.innerHeight || 800) - 8
          let next = { ...b }

          if (d.mode === 'move') {
            next.x = clampNum(b.x + dx, 0, Math.max(0, vw - b.width), b.x)
            next.y = clampNum(b.y + dy, 0, Math.max(0, vh - b.height), b.y)
          } else {
            // 四角缩放。左/上边被拖动时，位置与尺寸反向联动：
            // 往左拖 → x 减小、width 增大；往右拖 → x 增大、width 减小。
            if (d.mode === 'se') {
              next.width = clampNum(b.width + dx, 120, 800, b.width)
              next.height = clampNum(b.height + dy, 40, 600, b.height)
            } else if (d.mode === 'sw') {
              const w = clampNum(b.width - dx, 120, 800, b.width)
              next.x = clampNum(b.x + (b.width - w), 0, vw, b.x)
              next.width = w
              next.height = clampNum(b.height + dy, 40, 600, b.height)
            } else if (d.mode === 'ne') {
              const h = clampNum(b.height - dy, 40, 600, b.height)
              next.y = clampNum(b.y + (b.height - h), 0, vh, b.y)
              next.height = h
              next.width = clampNum(b.width + dx, 120, 800, b.width)
            } else if (d.mode === 'nw') {
              const w = clampNum(b.width - dx, 120, 800, b.width)
              const h = clampNum(b.height - dy, 40, 600, b.height)
              next.x = clampNum(b.x + (b.width - w), 0, vw, b.x)
              next.y = clampNum(b.y + (b.height - h), 0, vh, b.y)
              next.width = w
              next.height = h
            }
            // 缩放后仍要保证整个气泡在视口内
            next.x = Math.min(next.x, Math.max(0, vw - next.width))
            next.y = Math.min(next.y, Math.max(0, vh - next.height))
          }
          setGeo(next)
        }

        const onUp = () => {
          const d = dragRef.current
          dragRef.current = null
          setActive(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          // 松手落盘：同时切到 custom 模式，真实气泡立刻用这套几何
          setGeo((g) => {
            if (g) {
              writeToastPref({ custom: g, position: 'custom', size: 'custom' })
            }
            return null
          })
          // 松手后重新开始计时：给用户 10 秒决定「继续调」还是「就这样」
          bumpIdle()
          void d
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      // 预览外观与真实气泡保持一致（同一套圆角/底色/边框/阴影/字号规则），
      // 只在外面加一圈虚线定位框和四个抓手，这样「拖出来的样子 = 最终样子」。
      const fit = pref.autoFit
        ? (() => {
          const fs = Math.max(10, Math.min(24, Math.round(cur.width / 24)))
          const padX = Math.max(8, Math.min(24, Math.round(cur.width / 20)))
          const padY = Math.max(5, Math.min(18, Math.round(fs * 0.7)))
          return { fontSize: fs + 'px', padding: padY + 'px ' + padX + 'px', lineHeight: 1.45 }
        })()
        : { fontSize: '12.5px', padding: '8px 12px', lineHeight: 1.45 }

      const style = {
        position: 'fixed',
        left: cur.x + 'px',
        top: cur.y + 'px',
        width: cur.width + 'px',
        height: cur.height + 'px',
        boxSizing: 'border-box',
        zIndex: 13500,
        display: 'flex',
        // 纵向两行（与真实气泡一致：第1行消耗，第2行建议）
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        borderRadius: '12px',
        cursor: active ? 'grabbing' : 'grab',
        userSelect: 'none',
        touchAction: 'none',
        // 与真实气泡完全相同的配色，所见即所得
        color: 'var(--dsw-alias-text-primary,inherit)',
        background: 'var(--dsw-alias-bg-layer-2,#1f2430)',
        border: '1px solid var(--dsw-alias-state-success-primary,#22a06b)',
        boxShadow: '0 6px 20px rgba(0,0,0,.28)',
        // 预览文案用 \n 分行，需要 pre-line 才生效
        whiteSpace: 'pre-line',
        textAlign: 'left',
        // 内容超长时可滚（而不是裁掉）
        overflowY: 'auto',
        overflowX: 'hidden',
        ...fit,
      }

      // 定位框：贴在外层，用伪元素感的虚线描边标出可拖边界，
      // 但不影响气泡本身的观感
      const frameStyle = {
        position: 'fixed',
        left: (cur.x - 6) + 'px',
        top: (cur.y - 6) + 'px',
        width: (cur.width + 12) + 'px',
        height: (cur.height + 12) + 'px',
        boxSizing: 'border-box',
        zIndex: 13499,
        border: '1px dashed var(--dsw-alias-state-success-primary,#22a06b)',
        borderRadius: '16px',
        pointerEvents: 'none',
        opacity: active ? 0.95 : 0.55,
      }

      // 四角抓手：小圆点，hover 变实心，不抢视觉
      const handle = (corner, cursor, css) => h('div', {
        key: corner,
        onPointerDown: startDrag(corner),
        style: {
          position: 'absolute',
          width: '11px',
          height: '11px',
          cursor,
          background: 'var(--dsw-alias-bg-layer-1,#fff)',
          border: '2px solid var(--dsw-alias-state-success-primary,#22a06b)',
          borderRadius: '50%',
          boxShadow: '0 1px 3px rgba(0,0,0,.3)',
          touchAction: 'none',
          zIndex: 1,
          ...css,
        },
        title: '拖动改变大小',
      })

      return h('div', null, [
        h('div', { key: 'frame', style: frameStyle }),
        h('div', {
          key: 'preview',
          style,
          onPointerDown: startDrag('move'),
          title: '拖动移动位置',
        }, [
          h('span', { key: 't', style: { flex: 1, minWidth: 0 } },
            '🧾 本轮消耗 12 积分\n💡 当前 X 消耗积分，Y 现在免费，切过去更省'),
          handle('nw', 'nwse-resize', { left: '-5px', top: '-5px' }),
          handle('ne', 'nesw-resize', { right: '-5px', top: '-5px' }),
          handle('sw', 'nesw-resize', { left: '-5px', bottom: '-5px' }),
          handle('se', 'nwse-resize', { right: '-5px', bottom: '-5px' }),
        ]),
      ])
    }

    /**
     * 气泡外观设置（持久化到 localStorage）。
     *
     * 为什么要可配置：气泡固定在某个屏幕位置，而每个人的侧栏宽度、显示器
     * 尺寸、缩放比例都不同，写死的坐标对别人可能正好压在对话区上。
     *
     * 存储键独立于宿主，卸载插件不影响宿主任何数据；读失败一律退回默认值。
     */
    const TOAST_PREF_KEY = 'dsh-cost-tracker:toast-pref'
    const TOAST_PREF_DEFAULT = {
      position: 'left',   // left | top-right | bottom-right | top-center | custom
      size: 'normal',     // small | normal | large | custom
      durationMs: 6000,   // 停留时长
      // 自定义模式：位置（px，距视口左上）与宽高（px）
      custom: { x: 280, y: 0, width: 300, height: 0 },
      autoFit: true,      // 字号随气泡尺寸自适应
      editing: false,     // 是否常驻显示可拖动预览（用户手动开关）
      dockAdvice: false,  // 是否在输入框上方常驻一条建议（默认关：建议已并入气泡）
    }
    let toastPref = null
    const toastPrefListeners = new Set()

    /** 把任意值夹到 [min,max]，并保证是有限数 */
    function clampNum(v, min, max, dflt) {
      const n = Number(v)
      if (!Number.isFinite(n)) return dflt
      return Math.max(min, Math.min(max, Math.round(n)))
    }

    function readToastPref() {
      if (toastPref) return toastPref
      let v = { ...TOAST_PREF_DEFAULT, custom: { ...TOAST_PREF_DEFAULT.custom } }
      try {
        const raw = window.localStorage.getItem(TOAST_PREF_KEY)
        if (raw) {
          const o = JSON.parse(raw)
          if (o && typeof o === 'object') {
            if (typeof o.position === 'string') v.position = o.position
            if (typeof o.size === 'string') v.size = o.size
            if (Number(o.durationMs) >= 0) v.durationMs = Number(o.durationMs)
            if (typeof o.autoFit === 'boolean') v.autoFit = o.autoFit
            if (typeof o.editing === 'boolean') v.editing = o.editing
            if (typeof o.dockAdvice === 'boolean') v.dockAdvice = o.dockAdvice
            if (o.custom && typeof o.custom === 'object') {
              // 越界值一律夹回合法区间：手改 localStorage 或旧版本数据都不能
              // 让气泡飞到屏幕外（那样用户会以为插件坏了，却无从恢复）
              v.custom = {
                x: clampNum(o.custom.x, 0, 4000, TOAST_PREF_DEFAULT.custom.x),
                y: clampNum(o.custom.y, 0, 4000, TOAST_PREF_DEFAULT.custom.y),
                width: clampNum(o.custom.width, 120, 800, TOAST_PREF_DEFAULT.custom.width),
                height: clampNum(o.custom.height, 0, 600, TOAST_PREF_DEFAULT.custom.height),
              }
            }
          }
        }
      } catch { /* 读不到用默认 */ }
      toastPref = v
      return v
    }

    function writeToastPref(patch) {
      const cur = readToastPref()
      const next = { ...cur, ...(patch || {}) }
      if (patch && patch.custom) next.custom = { ...cur.custom, ...patch.custom }
      toastPref = next
      try { window.localStorage.setItem(TOAST_PREF_KEY, JSON.stringify(next)) } catch { /* 忽略 */ }
      toastPrefListeners.forEach((fn) => { try { fn(next) } catch { /* 忽略 */ } })
      return next
    }

    /**
     * 把偏好翻译成内联样式。
     *
     * 字号与排版的自适应规则（autoFit=true 时生效）：
     *   气泡按「宽×高」给出一个面积，字号随宽度分档变化，
     *   同时根据高度决定文本是单行省略还是换行铺满 —— 这样用户把气泡
     *   拉大后字也跟着变大，而不是留一大片空白围着两行小字。
     *   height=0 表示高度自适应（不锁死），此时按宽度定字号。
     */
    function toastStyle(pref) {
      const p = pref.position || 'left'
      const base = { position: 'fixed', zIndex: 14000 }
      const custom = pref.custom || TOAST_PREF_DEFAULT.custom

      if (p === 'custom') {
        base.left = custom.x + 'px'
        base.top = custom.y + 'px'
      } else if (p === 'left') {
        base.left = 'var(--dshctn-toast-left,272px)'
        base.top = '50%'
        base.transform = 'translateY(-50%)'
      } else if (p === 'top-right') {
        base.right = '20px'
        base.top = '16px'
      } else if (p === 'bottom-right') {
        base.right = '20px'
        base.bottom = '20px'
      } else {
        base.left = '50%'
        base.top = '16px'
        base.transform = 'translateX(-50%)'
      }

      // 预设尺寸
      const presets = {
        small: { fontSize: 11.5, padding: '6px 10px', maxWidth: 220 },
        normal: { fontSize: 12.5, padding: '8px 12px', maxWidth: 300 },
        large: { fontSize: 14, padding: '12px 16px', maxWidth: 420 },
      }
      let fontSize = 12.5
      let padding = '8px 12px'
      let width = null
      let height = null

      if (pref.size === 'custom' || p === 'custom') {
        width = custom.width
        height = custom.height > 0 ? custom.height : null
        if (pref.autoFit) {
          // 字号随宽度线性缩放，夹在 10–24px，避免过大或看不清
          fontSize = Math.max(10, Math.min(24, Math.round(width / 24)))
          // 内边距也按比例走，窄气泡不至于被 padding 吃光
          const padX = Math.max(8, Math.min(24, Math.round(width / 20)))
          const padY = Math.max(5, Math.min(18, Math.round(fontSize * 0.7)))
          padding = padY + 'px ' + padX + 'px'
        }
      } else {
        const s = presets[pref.size] || presets.normal
        fontSize = s.fontSize
        padding = s.padding
        width = s.maxWidth
      }

      const out = {
        ...base,
        fontSize: fontSize + 'px',
        padding,
        maxWidth: width ? width + 'px' : undefined,
        width: width ? width + 'px' : undefined,
        boxSizing: 'border-box',
      }
      if (height) {
        out.height = height + 'px'
        // ⚠️ 从顶部排版（flex-start），不要 center。
        // 固定高度下 center 会把多行文本垂直居中，一旦内容超高就上下同时
        // 被裁——用户抱怨「信息不全」正是这个原因。顶部起排 + 可滚动，
        // 才能先看到开头再滚着看完。
        out.overflowY = 'auto'
        out.overflowX = 'hidden'
        out.alignItems = 'flex-start'
      }
      // 自定义高度足够高时允许换行（否则一行省略很浪费空间）
      if (height && height >= fontSize * 2.6) {
        out.whiteSpace = 'normal'
        out.textAlign = 'left'
      } else {
        out.whiteSpace = 'normal'
      }
      return out
    }

    /** 设置区：位置 / 尺寸 / 停留时长，含自定义坐标与宽高 */
    function ToastPrefsCard() {
      const [pref, setPref] = useState(() => readToastPref())
      useEffect(() => {
        const fn = (next) => setPref({ ...next, custom: { ...next.custom } })
        toastPrefListeners.add(fn)
        return () => { toastPrefListeners.delete(fn) }
      }, [])

      const chip = (label, active, onClick, key) => h('button', {
        key,
        type: 'button',
        className: 'dshctp-btn' + (active ? ' primary' : ''),
        style: { marginRight: '6px', marginBottom: '6px' },
        onClick,
      }, label)

      const positions = [
        ['left', '左侧栏旁'],
        ['top-right', '右上角'],
        ['bottom-right', '右下角'],
        ['top-center', '顶部居中'],
        ['custom', '自定义'],
      ]
      const sizes = [['small', '小'], ['normal', '中'], ['large', '大'], ['custom', '自定义']]
      const durations = [[4000, '4 秒'], [6000, '6 秒'], [10000, '10 秒'], [0, '常驻']]

      const c = pref.custom

      return h('div', { className: 'dshctp-card' }, [
        h('h3', { key: 'h' }, '气泡提示'),

        h('div', { key: 'p', className: 'dshctp-hint', style: { marginBottom: '4px' } }, '显示位置'),
        h('div', { key: 'pv' }, positions.map(([v, label]) =>
          chip(label, pref.position === v, () => writeToastPref({ position: v }), 'pos-' + v))),

        h('div', { key: 's', className: 'dshctp-hint', style: { margin: '4px 0' } }, '尺寸'),
        h('div', { key: 'sv' }, sizes.map(([v, label]) =>
          chip(label, pref.size === v, () => writeToastPref({ size: v }), 'size-' + v))),

        // 拖动预览开关：预览是常驻浮层，切到对话也能看到，便于边看边调
        h('div', { key: 'drag', className: 'dshctp-custom' }, [
          h('div', { key: 't', className: 'dshctp-hint' },
            '拖动气泡移动位置，拖四个角改变大小（松手即保存）'),
          h('div', { key: 'act', className: 'dshctp-actions', style: { justifyContent: 'flex-start', marginTop: '6px' } }, [
            h('button', {
              key: 'on',
              type: 'button',
              className: 'dshctp-btn' + (pref.editing ? ' primary' : ''),
              onClick: () => writeToastPref({ editing: !pref.editing }),
            }, pref.editing ? '✓ 预览已常驻，点此关闭' : '① 开启拖动预览'),
          ]),
          h('div', { key: 'hint', className: 'dshctp-hint', style: { marginTop: '2px', opacity: 0.8 } },
            pref.editing
              ? '预览气泡已浮在页面上，切到对话界面它也还在——边看对话边拖，位置才准。'
              + '10 秒无操作会自动关闭（拖动时会重新计时）。'
              : '开启后预览气泡会浮在整个页面上（不只在费用面板），切到对话也能看到；'
              + '10 秒无操作自动关闭。'),
        ]),

        // 自适应字号
        h('div', { key: 'af', style: { marginTop: '6px' } }, [
          chip(pref.autoFit ? '✓ 字号随尺寸自适应' : '字号随尺寸自适应',
            pref.autoFit,
            () => writeToastPref({ autoFit: !pref.autoFit }),
            'autofit'),
        ]),

        // 建议的显示位置：默认并进气泡（不在输入框上方另开一条）
        h('div', { key: 'dk', className: 'dshctp-hint', style: { margin: '6px 0 2px' } }, '省钱建议'),
        h('div', { key: 'dkv' }, [
          chip(pref.dockAdvice ? '显示在输入框上方' : '✓ 显示在气泡里（推荐）',
            !pref.dockAdvice,
            () => writeToastPref({ dockAdvice: false }),
            'dock-off'),
          chip(pref.dockAdvice ? '✓ 显示在输入框上方' : '显示在输入框上方',
            pref.dockAdvice,
            () => writeToastPref({ dockAdvice: true }),
            'dock-on'),
        ]),
        h('div', { key: 'dkh', className: 'dshctp-hint', style: { marginTop: '2px', opacity: 0.8 } },
          pref.dockAdvice
            ? '建议会在输入框上方常驻一条，同时气泡里也会带一行。'
            : '建议直接并进气泡显示（第 2 行），输入框上方不再另占位置。'),

        h('div', { key: 'd', className: 'dshctp-hint', style: { margin: '4px 0' } }, '停留时长'),
        h('div', { key: 'dv' }, durations.map(([v, label]) =>
          chip(label, pref.durationMs === v, () => writeToastPref({ durationMs: v }), 'dur-' + v))),

        h('div', { key: 'n', className: 'dshctp-hint', style: { marginTop: '6px' } },
          '开启「字号自适应」后，字号与内边距会随气泡宽高按比例变化。'),

        // 当前几何值（只读展示，方便核对；真正改尺寸靠拖动）
        h('div', { key: 'geo', className: 'dshctp-hint', style: { marginTop: '4px' } },
          '当前：位置 (' + c.x + ', ' + c.y + ') · 大小 ' + c.width + '×'
          + (c.height > 0 ? c.height : '自适应')),
      ])
    }

    /**
     * 注册左侧栏行 + 主面板。
     *
     * 参考 dshmarket/client.js L15978-16012 的官方实现：
     *   - ctx.slots.register({ name: 'main', key: PANEL_ID }, Component) 出页面
     *   - ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID }, Icon) 出行
     *   - 点击行的切换由宿主自己完成（它知道 activePanelId），插件不用管
     *
     * 宿主太老、没有 sidebar.panellist 时 register 会抛，这里静默降级
     * （交给人 injectWidgetScript 的浮层兜底），绝不影响模型标签功能。
     */
    const PANEL_ID = 'dsh-cost-tracker'
    function registerSidebarEntry(ctx, namespace) {
      const diag = (window.__dshCostTrackerDiag = window.__dshCostTrackerDiag || {})
      if (diag.panellist === undefined) diag.panellist = 'pending'
      if (diag.panel === undefined) diag.panel = 'pending'
      // ⚠️ 必须等 slot 就绪再注册。
      //
      // 踩过的坑（2026-10-21）：裸调用 ctx.slots.register({name:'sidebar.panellist'})
      // 看起来成功（返回了 disposer），但实测 inspect 的 occupants 里**没有**本插件——
      // slot 在 apply 早期尚未建立，注册被静默丢弃，钱袋图标就「消失」了。
      // dshmarket 的等价做法是 gate 延迟注册（client.js L15978 sidebarGate），
      // 本质一样：等宿主把 slot 立起来，再往里注册。
      // ctx.slots.inject(key, cb) 的回调正是在该 slot 可用时执行，故用它包裹。
      return ctx.effect(() => {
        let offPanel = null
        let offRow = null
        let layoutRef = null

        const offInject = ctx.slots.inject('sidebar.panellist', () => {
          // 两个注册各自独立 try：任一失败都不能连累另一个，
          // 更不能冒泡到 applyInner 把模型标签一起废掉。
          try {
            offPanel = ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: namespace,
            }, CostTrackerPanel)
            diag.panel = 'registered'
          } catch (e) {
            diag.panel = 'failed: ' + (e && e.message ? e.message : String(e))
            try { console.error('[dsh-cost-tracker] main panel register failed:', e) } catch { /* 忽略 */ }
          }
          try {
            offRow = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 90,
              label: '费用',
              locale: namespace,
            }, CostTrackerNavIcon)
            diag.panellist = 'registered'
          } catch (e) {
            diag.panellist = 'failed: ' + (e && e.message ? e.message : String(e))
            try { console.error('[dsh-cost-tracker] sidebar.panellist register failed:', e) } catch { /* 忽略 */ }
          }
        })

        try {
          ctx.inject(['layout'], (scoped) => { layoutRef = scoped && scoped.layout ? scoped.layout : null })
        } catch { /* 宿主无 layout 服务时忽略 */ }

        return () => {
          try {
            if (layoutRef && layoutRef.panelInfo
              && layoutRef.panelInfo.getSnapshot().activePanelId === PANEL_ID) {
              layoutRef.selectPanel(null)
            }
          } catch { /* 忽略 */ }
          if (typeof offRow === 'function') { try { offRow() } catch { /* 忽略 */ } }
          if (typeof offPanel === 'function') { try { offPanel() } catch { /* 忽略 */ } }
          if (typeof offInject === 'function') { try { offInject() } catch { /* 忽略 */ } }
        }
      }, 'cost-tracker: sidebar entry')
    }

    /** 侧栏行的图标：宿主给 16px 格子，传 owner.size */
    function CostTrackerNavIcon(owner) {
      const size = (owner && owner.size) || 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, [
        h('path', { key: 'b', d: 'M3 9h18l-1.6 10.2a2 2 0 0 1-2 1.8H6.6a2 2 0 0 1-2-1.8L3 9Z' }),
        h('path', { key: 'h', d: 'M8.5 9V6.5a3.5 3.5 0 0 1 7 0V9' }),
      ])
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
