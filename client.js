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

    /** 限流/限额状态缓存：modelId -> { rateLimited, rateLimitedUntil, contextOverflowAt } */
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
              quotaExhaustedAt: typeof m.quotaExhaustedAt === 'number' ? m.quotaExhaustedAt : null,
              contextOverflowAt: typeof m.contextOverflowAt === 'number' ? m.contextOverflowAt : null,
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
          badgeCache = map
          badgeFetchedAt = Date.now()
          return map
        })
        .catch(() => badgeCache)
        .finally(() => { badgeInFlight = null })
      return badgeInFlight
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
     * 悬停说明：
     *   1) 倍率
     *   2) 促销/折扣说明
     *   3) **可用状态**——额度用尽 / 限流时明确告知何时能再用
     *
     * 数据来源三条（优先级从高到低）：
     *   a) 上游 429 报文里的精确重置时间（rateLimitedUntil）
     *   b) 本地记录的额度用尽（quotaExhaustedAt，免费模型 429 = 每日赠额用尽）
     *   c) 都没有则显示「可用」
     *
     * 注意：WorkBuddy 的 status 接口**不返回**额度/限流状态，
     * 所以只能靠 429 事件累积。没触发过 429 的模型显示为可用。
     */
    function buildHoverLines(modelId, meta) {
      const lines = []
      const isNightFree = (meta.badges || []).some((b) => String(b).indexOf('夜间免费') !== -1)
      // 夜间免费模型（hy4-preview）：非夜间时段要按倍率计费，
      // 所以第一行显示当前实际状态，而不是笼统的「免费」
      if (isNightFree) {
        lines.push(isNightNow() ? '夜间免费中' : (fmtRate(meta.credits) + '（仅夜间免费）'))
      } else {
        lines.push(meta.free ? '免费' : (fmtRate(meta.credits) || '倍率未知'))
      }

      const desc = PROMO_DESC[modelId]
      if (desc) {
        lines.push(desc)
      } else if (NIGHT_DISCOUNT.indexOf(modelId) !== -1) {
        lines.push('周一至周五 09:00–12:00、14:00–18:00 属高峰原价；中午、晚间与周末节假日为谷时 5 折。')
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
      // ===== 可用状态 =====
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
      } else if (lim.quotaExhaustedAt && meta.free) {
        // 记过额度用尽但没拿到恢复时间
        lines.push('⛔ 额度已用尽，等待每日重置后才能再用')
      } else if (lim.rateLimited && left !== null && left <= 0) {
        lines.push('✅ 限流已结束，可正常使用')
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

      // 限流标记：不经悬停也能一眼看到「这个模型现在不能用」
      const limNow = (limitCache && limitCache[modelId]) || {}
      const limitedNow = !!(limNow.rateLimited && limNow.rateLimitedUntil
        && limNow.rateLimitedUntil > Date.now())

      const nodes = [h('span', { key: 'n' }, name || rawName), ...tagNodes]

      if (limitedNow) {
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

      // 悬停说明里的倒计时需要持续刷新，30 秒重拉一次限流状态
      ctx.effect(() => {
        const t = setInterval(() => { refreshLimits() }, 30000)
        return () => clearInterval(t)
      }, 'cost-tracker: limits refresh')

      ctx.effect(() => {
        const dispose = ctx.slots.inject('conversation.input.model.label', () =>
          ctx.slots.register({
            name: 'conversation.input.model.label',
            locale: namespace,
          }, CostTrackerModelLabel))
        return () => { try { dispose && dispose() } catch { /* 忽略 */ } }
      }, 'cost-tracker: model label')

      // ---- 根治「💰 入口偶尔消失」----
      // 桌面端唯一的注入通道是启动期一次性收集的 index-inject 表；热重载 / 刷新后
      // 这一行经常没被重新收集，于是 widget.js 没被加载、入口消失。
      // 这里的 client 半区在**每次页面加载**都会重新 apply，所以由它亲自把
      // widget.js 注入页面，无论怎么刷新 / 重载都能稳定出现。
      injectWidgetScript()
    }

    /**
     * 在浏览器里把费用浮层脚本注入页面（幂等：重复调用只留一个）。
     * 用原生 DOM 注入，不依赖任何 DSH 注入表，因此每次页面加载都必然生效。
     */
    function injectWidgetScript() {
      try {
        if (typeof document === 'undefined') return
        if (window.__dshCostWidgetInjected) return
        // 避免和插件启动期的 index-inject 钩子重复加载（同源脚本浏览器会复用）
        const existing = document.querySelector('script[src="/cost-tracker/widget.js"]')
        if (existing) { window.__dshCostWidgetInjected = true; return }
        const s = document.createElement('script')
        s.src = '/cost-tracker/widget.js'
        s.async = false
        s.onerror = function () { window.__dshCostWidgetInjected = false }
        ;(document.body || document.head || document.documentElement).appendChild(s)
        window.__dshCostWidgetInjected = true
      } catch (e) {
        try { console.error('[dsh-cost-tracker] injectWidgetScript failed:', e) } catch { /* 忽略 */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
