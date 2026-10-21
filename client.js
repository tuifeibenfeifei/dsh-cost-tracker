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
      '.dshctn-float{display:inline-flex;align-items:center;gap:6px;',
      '  border-radius:12px;line-height:1.45;font-weight:600;',
      '  white-space:normal;word-break:break-word;',
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
      const usageMap = usage || {}

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
                const parts = []
                if (Number(lt.costTokenBased) > 0) parts.push('¥' + pNum(lt.costTokenBased))
                if (lt.workbuddy && typeof lt.workbuddy.spent === 'number' && lt.workbuddy.spent > 0) {
                  parts.push(pNum(lt.workbuddy.spent) + ' 积分')
                }
                const reason = lt.workbuddy && lt.workbuddy.reason
                const pending = reason === 'zero-pending' || reason === 'unconfirmed'
                  || reason === 'baseline-established' || reason === 'baseline-stale'
                let label
                if (parts.length) label = parts.join(' / ')
                else if (pending) label = reason === 'unconfirmed' ? '积分未入账' : '结算中…'
                else if (lt.allFree) label = '免费'
                else label = '—'
                return kv('本轮', label, parts.length ? 'warn' : (label === '免费' ? 'free' : ''))
              })(),
              kv('今天 ' + ((ledger.day || {}).turns || 0) + ' 轮',
                (Number((ledger.day || {}).costTokenBased) > 0 ? '¥' + pNum(ledger.day.costTokenBased) + ' / ' : '')
                + ((ledger.day || {}).workbuddyCredits || 0) + ' 积分'),
              kv('本月 ' + ((ledger.month || {}).turns || 0) + ' 轮',
                (Number((ledger.month || {}).costTokenBased) > 0 ? '¥' + pNum(ledger.month.costTokenBased) + ' / ' : '')
                + ((ledger.month || {}).workbuddyCredits || 0) + ' 积分'),
            ]),
            h('div', { key: 'n', className: 'dshctp-hint', style: { marginTop: '8px' } },
              '阿里云不参与记账：token 推算偏差过大，无可信金额。'),
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

        // ---- 模型清单 + 信息编辑 ----
        h('div', { key: 'm', className: 'dshctp-card' }, [
          h('h3', { key: 'h' }, 'WorkBuddy 模型'),
          h('div', { key: 'list', className: 'dshctp-models' },
            ranked.map((m) => {
              const u = usageMap[m.id]
              const lim = (limits || {})[m.id]
              const exhausted = !!(lim && (lim.quotaExhaustedAt || lim.creditExhaustedAt))
              const pills = []
              if (m.free) pills.push({ t: '免费', c: '#15803d' })
              if (lim && lim.rateLimited) pills.push({ t: '限流', c: '#b91c1c' })
              if (exhausted) pills.push({ t: lim.creditExhaustedAt ? '欠费' : '额度尽', c: '#b91c1c' })
              const rate = m.credits && String(m.credits).trim() && !/^x?0(\.0+)?$/i.test(String(m.credits).trim())
                ? String(m.credits).trim() : ''
              return h('div', { key: m.id, className: 'dshctp-mrow' }, [
                h('div', { key: 'l' }, [
                  h('div', { key: 'n', className: 'dshctp-mname' }, [
                    ...pills.map((p, i) => h('span', {
                      key: 'p' + i,
                      className: 'dshctp-pill',
                      style: { background: p.c },
                    }, p.t)),
                    String(m.name || m.id),
                  ]),
                  h('div', { key: 'meta', className: 'dshctp-mmeta' }, [
                    m.free ? '免费' : (rate ? rate + ' 倍率' : '倍率未知'),
                    m.contextWindow ? ' · 上下文 ' + pTokens(m.contextWindow) : '',
                    (m.badges && m.badges.length) ? ' · ' + m.badges.join(' · ') : '',
                    u ? ' · 你已用 ' + u.turns + ' 轮'
                      + (u.credits > 0 ? ' · ' + pNum(u.credits) + ' 积分' : '')
                      + (u.cost > 0 ? ' · ¥' + pNum(u.cost) : '') : '',
                  ].join('')),
                  notes[m.id]
                    ? h('div', { key: 'note', className: 'dshctp-mnote' }, notes[m.id])
                    : null,
                ]),
                h('button', {
                  key: 'b',
                  className: 'dshctp-btn',
                  type: 'button',
                  onClick: () => setPick(m.id),
                }, '编辑信息'),
              ])
            }),
          ),
        ]),

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
            const key = lt ? (String(lt.sessionId || '') + ':' + cur) : ''
            const prevKey = noticeShared ? noticeShared.key : ''
            let toast = null
            if (cur > 0 && prevKey !== '' && key !== prevKey && lt) {
              const wb = lt.workbuddy || {}
              let text
              let kind = 'info'
              if (wb.reason === 'unconfirmed' || wb.reason === 'zero-pending') {
                text = '本轮积分未入账，稍后自动结算'
                kind = 'pending'
              } else if (Number(wb.spent) > 0) {
                text = '本轮消耗 ' + pNum(wb.spent) + ' 积分'
                if (Number(j.day && j.day.workbuddyCredits) > 0) {
                  text += '（今天累计 ' + pNum(j.day.workbuddyCredits) + '）'
                }
                kind = 'spent'
              } else if (lt.allFree) {
                text = '本轮免费，未消耗积分'
                kind = 'free'
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
            if (!noticeShared) noticeShared = { ledger: null, lastTurn: 0, toast: null }
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
    }

    /** 订阅共享数据的常驻条 */
    function CostDockLive(props) {
      const [, force] = useState(0)
      useEffect(() => {
        const off = props.subscribe(() => force((n) => n + 1))
        return () => { if (typeof off === 'function') off() }
      }, [props.subscribe])
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
      // 位置与尺寸走内联样式，覆盖 CSS 默认的 left/top，避免两处打架
      return h('div', { className: cls, role: 'status', style: toastStyle(pref) }, icon + shown.text)
    }

    /**
     * 气泡外观设置（持久化到 localStorage）。
     *
     * 为什么要可配置：气泡固定在某个屏幕位置，而每个人的侧栏宽度、显示器
     * 尺寸、缩放比例都不同，写死的坐标对别人可能正好压在对话区上。
     * 提供「位置预设 + 尺寸 + 停留时长」三个开关，比让用户自己改 CSS 现实。
     *
     * 存储键独立于宿主，卸载插件不影响宿主任何数据；读失败一律退回默认值。
     */
    const TOAST_PREF_KEY = 'dsh-cost-tracker:toast-pref'
    const TOAST_PREF_DEFAULT = {
      position: 'left',   // left（左侧栏旁，默认）| top-right | bottom-right | top-center
      size: 'normal',     // small | normal | large
      durationMs: 6000,   // 停留时长
    }
    let toastPref = null
    const toastPrefListeners = new Set()

    function readToastPref() {
      if (toastPref) return toastPref
      let v = { ...TOAST_PREF_DEFAULT }
      try {
        const raw = window.localStorage.getItem(TOAST_PREF_KEY)
        if (raw) {
          const o = JSON.parse(raw)
          if (o && typeof o === 'object') {
            if (typeof o.position === 'string') v.position = o.position
            if (typeof o.size === 'string') v.size = o.size
            if (Number(o.durationMs) > 0) v.durationMs = Number(o.durationMs)
          }
        }
      } catch { /* 读不到用默认 */ }
      toastPref = v
      return v
    }

    function writeToastPref(patch) {
      const next = { ...readToastPref(), ...(patch || {}) }
      toastPref = next
      try { window.localStorage.setItem(TOAST_PREF_KEY, JSON.stringify(next)) } catch { /* 忽略 */ }
      toastPrefListeners.forEach((fn) => { try { fn(next) } catch { /* 忽略 */ } })
      return next
    }

    /** 把位置/尺寸预设翻译成内联样式，避免依赖宿主主题里不存在的类 */
    function toastStyle(pref) {
      const p = pref.position || 'left'
      const base = { position: 'fixed', zIndex: 14000 }
      if (p === 'left') {
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
      const sizing = {
        small: { fontSize: '11.5px', padding: '6px 10px', maxWidth: '220px' },
        normal: { fontSize: '12.5px', padding: '8px 12px', maxWidth: '300px' },
        large: { fontSize: '14px', padding: '12px 16px', maxWidth: '420px' },
      }[pref.size] || { fontSize: '12.5px', padding: '8px 12px', maxWidth: '300px' }
      return { ...base, ...sizing }
    }

    /** 设置区：气泡位置 / 尺寸 / 停留时长 */
    function ToastPrefsCard() {
      const [pref, setPref] = useState(() => readToastPref())
      useEffect(() => {
        const fn = (next) => setPref({ ...next })
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
      ]
      const sizes = [['small', '小'], ['normal', '中'], ['large', '大']]
      const durations = [[4000, '4 秒'], [6000, '6 秒'], [10000, '10 秒'], [0, '常驻']]

      return h('div', { className: 'dshctp-card' }, [
        h('h3', { key: 'h' }, '气泡提示'),
        h('div', { key: 'p', className: 'dshctp-hint', style: { marginBottom: '4px' } }, '显示位置'),
        h('div', { key: 'pv' }, positions.map(([v, label]) =>
          chip(label, pref.position === v, () => writeToastPref({ position: v }), 'pos-' + v))),
        h('div', { key: 's', className: 'dshctp-hint', style: { margin: '4px 0' } }, '尺寸'),
        h('div', { key: 'sv' }, sizes.map(([v, label]) =>
          chip(label, pref.size === v, () => writeToastPref({ size: v }), 'size-' + v))),
        h('div', { key: 'd', className: 'dshctp-hint', style: { margin: '4px 0' } }, '停留时长'),
        h('div', { key: 'dv' }, durations.map(([v, label]) =>
          chip(label, pref.durationMs === v, () => writeToastPref({ durationMs: v }), 'dur-' + v))),
        h('div', { key: 'n', className: 'dshctp-hint', style: { marginTop: '6px' } },
          '「左侧栏旁」会紧贴左侧图标栏右侧的空白处，不遮挡对话内容。'
          + '选「常驻」后气泡不会自动消失，下一条消息到来时才替换。'),
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
