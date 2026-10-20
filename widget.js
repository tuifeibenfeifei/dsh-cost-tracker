/**
 * dsh-cost-tracker —— 费用挂件（页面脚本）
 *
 * 通过 webserver/index-inject 注入，与 dsh-whale-widget 的技术路线一致：
 * 自己是独立页面脚本，不依赖 DSH 的 slot 机制。
 *
 * 设计要点：
 *   1. 内联 script 行注入（不能用 script-src，加载失败会 reject 掉
 *      __DSH_BOOT_READY__ 导致应用起不来 —— 鲸鱼 issue #154 的教训）
 *   2. 真正干活的是本文件自己建的 <script src="/cost-tracker/widget.js">
 *      并吞掉 onerror：路由在就加载，不在就静默失败，永不拖垮 DSH
 *   3. 挂件自己只画 DOM，数据全部来自 /cost-tracker/* 接口
 *   4. 位置记忆用 localStorage，不写任何 DSH 配置
 */

(function () {
  if (window.__dshCostWidget) return
  window.__dshCostWidget = true

  var CSS_ID = 'dsh-cost-widget-css'
  var STORE_KEY = 'dsh-cost-widget-pos'
  var REFRESH_MS = 60000

  // 分类映射：阿里云按使用方向，WorkBuddy 按档位，其余 provider 平铺
  var ALIYUN_CATEGORIES = [
    { key: 'text',   label: '文本对话', match: [/^deepseek-v4\.1-flash/, /^vanchin\/deepseek-v4\.1/, /^qwen3\.8-max/, /^kimi-k3$/, /^qwen3-coder-flash/, /^deepseek-v4\.1-flash-1017/] },
    { key: 'img',    label: '图片',     match: [/^qwen-image/, /^wan[\d.]*-image/, /^z-image/] },
    { key: 'mt',     label: '翻译字幕', match: [/^qwen-mt/] },
    { key: 'speech', label: '实时语音', match: [/audio|omni|livetranslate|tts|s2s|speech|asr|fun-asr/i] },
    { key: 'ocr',    label: 'OCR/研究', match: [/ocr|deep-research|deep-search|analysis|gui-plus|flash-character/i] },
  ]
  var WB_FREE = [/^hy3$/, /^step-5-preview$/]
  var WB_MAIN = [/^deepseek-v4\.1-flash$/]
  // ---------- 样式 ----------
  function injectCss() {
    if (document.getElementById(CSS_ID)) return
    var css = [
      '.dshcw-root{position:fixed;z-index:12000;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;user-select:none}',
      '.dshcw-card{background:#1f2937;color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.32);overflow:hidden;width:230px}',
      '.dshcw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;cursor:pointer;font-weight:700;font-size:12px;letter-spacing:.3px}',
      '.dshcw-title{display:flex;align-items:center;gap:5px;flex:none}',
      '.dshcw-toggle{opacity:.6;font-size:11px;padding:0 2px;flex:none}',
      '.dshcw-body{padding:0 10px 9px;display:flex;flex-direction:column;gap:5px}',
      '.dshcw-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;line-height:17px;white-space:nowrap}',
      '.dshcw-label{color:#9ca3af;display:flex;align-items:center;gap:5px}',
      '.dshcw-dot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.dshcw-val{font-weight:700;font-variant-numeric:tabular-nums}',
      '.dshcw-val.free{color:#4ade80}',
      '.dshcw-val.warn{color:#fca5a5}',
      '.dshcw-sep{height:1px;background:rgba(255,255,255,.12);margin:3px 0}',
      '.dshcw-reco{font-size:11px;line-height:16px;color:#d1d5db}',
      '.dshcw-reco b{color:#fff}',
      '.dshcw-tip{margin-top:2px;padding:5px 7px;border-radius:6px;background:rgba(252,165,165,.14);border:1px solid rgba(252,165,165,.32);color:#fecaca;font-size:11px;line-height:15px}',
      '.dshcw-suggest{margin-top:2px;padding:5px 7px;border-radius:6px;background:rgba(251,191,36,.14);border:1px solid rgba(251,191,36,.34);color:#fde68a;font-size:11px;line-height:15px}',
      '.dshcw-ok{margin-top:2px;padding:5px 7px;border-radius:6px;background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.28);color:#bbf7d0;font-size:11px;line-height:15px}',
      // —— 树形模型选择器 ——
      '.dshcw-mtree{position:fixed;z-index:13000;width:260px;max-height:60vh;overflow:auto;background:#111827;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);font-size:12px;padding:6px}',
      '.dshcw-mtree-head{display:flex;align-items:center;justify-content:space-between;padding:4px 6px 8px;font-weight:700;font-size:12px;color:#9ca3af}',
      '.dshcw-mtree-close{cursor:pointer;opacity:.7;padding:0 4px}',
      '.dshcw-mtree-close:hover{opacity:1}',
      '.dshcw-mgroup{margin:2px 0}',
      '.dshcw-mgroup-label{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;font-weight:700}',
      '.dshcw-mgroup-label:hover{background:rgba(255,255,255,.07)}',
      '.dshcw-mcaret{width:10px;flex:none;opacity:.6;font-size:10px}',
      '.dshcw-mdot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.dshcw-mcat{margin-left:16px}',
      '.dshcw-mcat-label{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;color:#d1d5db}',
      '.dshcw-mcat-label:hover{background:rgba(255,255,255,.06)}',
      '.dshcw-mitem{margin-left:34px;padding:4px 6px;border-radius:6px;cursor:pointer;color:#e5e7eb;display:flex;align-items:center;justify-content:space-between;gap:6px}',
      '.dshcw-mitem:hover{background:rgba(59,130,246,.25)}',
      '.dshcw-mitem.cur{background:rgba(59,130,246,.4);font-weight:700}',
      '.dshcw-mitem .eff{color:#9ca3af;font-size:10px}',
      '.dshcw-mempty{padding:10px;color:#9ca3af;text-align:center}',
      '.dshcw-empty{padding:8px 10px;font-size:11px;color:#9ca3af}',
      '.dshcw-hidden .dshcw-body{display:none}',
      '.dshcw-hidden .dshcw-head{border-bottom:none}',
      '.dshcw-drag{cursor:move}'
    ].join('')
    var s = document.createElement('style')
    s.id = CSS_ID
    s.textContent = css
    ;(document.head || document.documentElement).appendChild(s)
  }

  // ---------- 位置记忆 ----------
  function loadPos() {
    try {
      var raw = localStorage.getItem(STORE_KEY)
      if (!raw) return null
      var p = JSON.parse(raw)
      if (p && typeof p.left === 'number' && typeof p.top === 'number') return p
    } catch (e) {}
    return null
  }
  function savePos(p) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(p)) } catch (e) {}
  }

  function fmtNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—'
    return n.toFixed(2)
  }

  function fmtLeft(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '已解除'
    var s = Math.floor(ms / 1000)
    var d = Math.floor(s / 86400)
    var h = Math.floor((s % 86400) / 3600)
    var m = Math.floor((s % 3600) / 60)
    if (d > 0) return d + '天' + h + '小时'
    if (h > 0) return h + '小时' + m + '分'
    if (m > 0) return m + '分'
    return s + '秒'
  }

  // ---------- 建 DOM ----------
  var root = null
  var collapsed = false
  var lastReco = null

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function build() {
    injectCss()
    root = el('div', 'dshcw-root')
    var card = el('div', 'dshcw-card')

    var head = el('div', 'dshcw-head')
    var title = el('div', 'dshcw-title')
    title.appendChild(el('span', null, '💰'))
    title.appendChild(el('span', null, '费用'))
    // 「模型」按钮：打开树形选择器（与费用折叠互不影响）
    var mb = el('span', null, '🌳')
    mb.style.cursor = 'pointer'
    mb.style.marginLeft = '4px'
    mb.title = '按分类选模型'
    mb.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleModelTree(mb)
    })
    title.appendChild(mb)
    head.appendChild(title)
    var toggle = el('span', 'dshcw-toggle', '▾')
    head.appendChild(toggle)

    var body = el('div', 'dshcw-body')
    body.appendChild(el('div', 'dshcw-empty', '加载中…'))

    head.addEventListener('click', function (e) {
      if (e.target === toggle || dragging) return
      collapsed = !collapsed
      card.classList.toggle('dshcw-hidden', collapsed)
      toggle.textContent = collapsed ? '▸' : '▾'
    })

    card.appendChild(head)
    card.appendChild(body)
    root.appendChild(card)
    ;(document.body || document.documentElement).appendChild(root)

    // 初始位置：右下角，避开鲸鱼（往上偏移）
    var pos = loadPos()
    if (!pos) {
      var vw = window.innerWidth || 1200
      var vh = window.innerHeight || 800
      pos = { left: vw - 210, top: vh - 250 }
    }
    applyPos(pos)
    enableDrag(head, card)
    return body
  }

  function applyPos(p) {
    if (!root || !p) return
    // 四边都按卡片**实际尺寸**钳制：水平用固定宽度（与 CSS .dshcw-card 一致），
    // 垂直用卡片当前 offsetHeight（展开/折叠高度不同，不能写死）。
    // 否则往下拖卡片会沉出 DSH 界面，内容看不见也拖不回来。
    var CARD_W = 230
    var card = root.firstElementChild
    var h = (card && card.offsetHeight) || 160
    var maxL = (window.innerWidth || 1200) - CARD_W - 4
    var maxT = (window.innerHeight || 800) - h - 4
    root.style.left = Math.max(0, Math.min(p.left, maxL)) + 'px'
    root.style.top = Math.max(0, Math.min(p.top, maxT)) + 'px'
  }

  // ---------- 拖动 ----------
  var dragging = false
  function enableDrag(handle, card) {
    var startX = 0, startY = 0, startL = 0, startT = 0
    handle.classList.add('dshcw-drag')
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      dragging = true
      startX = e.clientX; startY = e.clientY
      var r = root.getBoundingClientRect()
      startL = r.left; startT = r.top
      e.preventDefault()
    })
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return
      var p = { left: startL + (e.clientX - startX), top: startT + (e.clientY - startY) }
      applyPos(p)
    })
    window.addEventListener('mouseup', function (e) {
      if (!dragging) return
      dragging = false
      var r = root.getBoundingClientRect()
      var p = { left: r.left, top: r.top }
      savePos(p)
    })
  }

  // ---------- 渲染 ----------
  function row(label, value, dotColor, valClass) {
    var r = el('div', 'dshcw-row')
    var l = el('div', 'dshcw-label')
    if (dotColor) {
      var d = el('span', 'dshcw-dot')
      d.style.background = dotColor
      l.appendChild(d)
    }
    l.appendChild(el('span', null, label))
    r.appendChild(l)
    var v = el('div', 'dshcw-val' + (valClass ? ' ' + valClass : ''), value)
    r.appendChild(v)
    return r
  }

  function render(summary, reco, ledger) {
    var body = root.querySelector('.dshcw-body')
    if (!body) return
    body.textContent = ''

    var db = summary && summary.deepseekBalance
    var al = summary && summary.aliyun
    var wb = summary && summary.workbuddy

    // DeepSeek 官方（真钱）
    body.appendChild(row('DeepSeek', db && db.available !== null && db.available !== undefined
      ? '¥' + fmtNum(db.available) : (db && db.error ? '读不到' : '—'), '#ef4444', 'warn'))

    // 阿里云（券）
    body.appendChild(row('阿里云券', al && al.calibratedBalance !== null && al.calibratedBalance !== undefined
      ? '¥' + fmtNum(al.calibratedBalance) : '—', '#f59e0b'))

    // WorkBuddy（积分）
    body.appendChild(row('WorkBuddy', wb && wb.credits !== null && wb.credits !== undefined
      ? wb.credits + ' 积分' : '—', '#22c55e', 'free'))

    body.appendChild(el('div', 'dshcw-sep'))

    // ===== 记账：单轮 → 当天 → 当月 =====
    if (ledger && ledger.ok) {
      // 单轮：最近一次对话花了多少
      var lt = ledger.lastTurn
      if (lt) {
        var one = []
        if (Number(lt.costTokenBased) > 0) one.push('¥' + fmtNum(lt.costTokenBased))
        if (lt.workbuddy && typeof lt.workbuddy.spent === 'number' && lt.workbuddy.spent > 0) {
          one.push(lt.workbuddy.spent + ' 积分')
        }
        // 积分扣减有延迟：本轮刚结束、还没入账时显示「结算中」而不是「免费」
        var wbReason = lt.workbuddy && lt.workbuddy.reason
        var pending = wbReason === 'zero-pending' || wbReason === 'baseline-established' || wbReason === 'baseline-stale'
        var label = one.length ? one.join(' / ') : (pending ? '结算中…' : '免费')
        body.appendChild(row('本轮', label, null, one.length ? 'warn' : (pending ? '' : 'free')))
      }

      // 当天 / 当月两档
      var d = ledger.day || {}
      var m = ledger.month || {}
      var dParts = []
      if (Number(d.costTokenBased) > 0) dParts.push('¥' + fmtNum(d.costTokenBased))
      if (Number(d.workbuddyCredits) > 0) dParts.push(d.workbuddyCredits + ' 积分')
      body.appendChild(row('今天 ' + (d.turns || 0) + ' 轮',
        dParts.length ? dParts.join(' / ') : '0', null, dParts.length ? 'warn' : 'free'))

      var mParts = []
      if (Number(m.costTokenBased) > 0) mParts.push('¥' + fmtNum(m.costTokenBased))
      if (Number(m.workbuddyCredits) > 0) mParts.push(m.workbuddyCredits + ' 积分')
      body.appendChild(row('本月 ' + (m.turns || 0) + ' 轮',
        mParts.length ? mParts.join(' / ') : '0', null, mParts.length ? 'warn' : 'free'))

      // 注：阿里云不进记账——token 推算偏差 26.6 倍，无可信金额
    }

    // 主动省钱建议（最重要，放最上面显眼位置）
    if (reco && reco.advice && reco.advice.message) {
      var adv = reco.advice
      var cls = adv.level === 'switch' ? 'dshcw-tip' : (adv.level === 'suggest' ? 'dshcw-suggest' : 'dshcw-ok')
      var icon = adv.level === 'switch' ? '⚠ ' : (adv.level === 'suggest' ? '💡 ' : '✓ ')
      body.appendChild(el('div', cls, icon + adv.message))
    }

    // 时段推荐
    if (reco && reco.ok) {
      body.appendChild(el('div', 'dshcw-sep'))
      var rl = el('div', 'dshcw-reco')
      rl.appendChild(el('div', null, reco.peakLabel))
      // 长文场景优先展示（用户长对话多）
      var longSc = null
      for (var i = 0; i < reco.scenarios.length; i++) {
        if (reco.scenarios[i].key === 'long') longSc = reco.scenarios[i]
      }
      var sc = longSc || (reco.scenarios && reco.scenarios[0])
      if (sc && sc.models && sc.models.length) {
        for (var j = 0; j < sc.models.length; j++) {
          var m = sc.models[j]
          var line = el('div', null)
          line.appendChild(el('b', null, m.rank + '. '))
          // 挂件只显示模型名，思考强度等细节留给模型列表的悬停说明
          var label = m.name
          if (m.free) label += '（免费）'
          else if (m.outOfQuota) label += '（额度尽 x' + m.rate + '）'
          line.appendChild(document.createTextNode(label))
          rl.appendChild(line)
        }
      }
      body.appendChild(rl)
    }

    // 注：限流/额度用尽的详细信息**不在挂件里显示**，
    // 统一放在模型列表的悬停说明里（用户要求）。
    // 这里只在「当前模型不可用」时由 advice 给一句总括提示。
  }

  // ---------- 树形模型选择器 ----------
  // 数据来自 DSH 内核的 Remote API（modelCatalog / selectModel）。
  // remote.session 只存在于 client 半身的注入作用域（对 settings-models 的
  // 源码核实），**不挂 window 全局**——裸页面脚本拿不到。
  // 所以 client.js（正式 client 半身，inject 含 "remote.session"）把它桥到
  // window.__dshCostWidgetApi；这里只认这个桥，桥不存在就明确报错。
  function findRemoteSession() {
    try {
      var api = window.__dshCostWidgetApi
      if (api && typeof api.modelCatalog === 'function' && typeof api.selectModel === 'function') return api
    } catch (e) {}
    return null
  }

  var mtreeOpen = false
  var mtreeEl = null
  var mtreeState = null // { groups, default, byId }

  function toggleModelTree(anchor) {
    if (mtreeOpen) { closeModelTree(); return }
    openModelTree(anchor)
  }

  function closeModelTree() {
    if (mtreeEl) { mtreeEl.remove(); mtreeEl = null }
    mtreeOpen = false
  }

  function openModelTree(anchor) {
    closeModelTree()
    mtreeOpen = true
    mtreeEl = el('div', 'dshcw-mtree')
    mtreeEl.appendChild(el('div', 'dshcw-mtree-head', '按分类选模型'))
    var closeBtn = el('span', 'dshcw-mtree-close', '✕')
    closeBtn.addEventListener('click', closeModelTree)
    mtreeEl.lastChild.appendChild(closeBtn)
    mtreeEl.appendChild(el('div', 'dshcw-mempty', '加载模型目录…'))
    ;(document.body || document.documentElement).appendChild(mtreeEl)

    // 定位：锚点按钮左下
    var r = anchor.getBoundingClientRect()
    var left = Math.max(4, Math.min(r.left - 120, (window.innerWidth || 1200) - 270))
    var top = Math.min(r.bottom + 6, (window.innerHeight || 800) - 200)
    mtreeEl.style.left = left + 'px'
    mtreeEl.style.top = top + 'px'

    loadCatalogAndRender()
  }

  function loadCatalogAndRender() {
    var remote = findRemoteSession()
    var p = remote && typeof remote.modelCatalog === 'function'
      ? Promise.resolve(remote.modelCatalog())
      : Promise.reject(new Error('remote session API 不可用'))
    p.then(function (cat) {
      mtreeState = cat
      renderModelTree()
    }).catch(function (err) {
      mtreeEl.textContent = ''
      mtreeEl.appendChild(el('div', 'dshcw-mempty', '模型目录加载失败：' + String(err && err.message || err).slice(0, 60)))
    })
  }

  /** 把 provider 的模型分到分类桶里；不属于任何分类的归「其他」 */
  function categorize(providerId, models) {
    var buckets = []
    function bucket(label) {
      for (var i = 0; i < buckets.length; i++) if (buckets[i].label === label) return buckets[i]
      var b = { label: label, models: [] }
      buckets.push(b)
      return b
    }
    if (providerId === 'aliyun' || /aliyun|dashscope/i.test(providerId)) {
      for (var i = 0; i < models.length; i++) {
        var m = models[i]
        var placed = false
        for (var c = 0; c < ALIYUN_CATEGORIES.length; c++) {
          var cat = ALIYUN_CATEGORIES[c]
          for (var r = 0; r < cat.match.length; r++) {
            if (cat.match[r].test(m.id)) { bucket(cat.label).models.push(m); placed = true; break }
          }
          if (placed) break
        }
        if (!placed) bucket('其他').models.push(m)
      }
    } else if (/workbuddy/i.test(providerId)) {
      for (var j = 0; j < models.length; j++) {
        var mm = models[j], pb = false
        for (var a = 0; a < WB_FREE.length; a++) if (WB_FREE[a].test(mm.id)) { bucket('免费').models.push(mm); pb = true; break }
        if (pb) continue
        for (var b2 = 0; b2 < WB_MAIN.length; b2++) if (WB_MAIN[b2].test(mm.id)) { bucket('主力').models.push(mm); pb = true; break }
        if (pb) continue
        bucket('其他').models.push(mm)
      }
    }
    return buckets
  }

  function renderModelTree() {
    if (!mtreeEl || !mtreeState) return
    mtreeEl.textContent = ''
    var head = el('div', 'dshcw-mtree-head', '按分类选模型')
    var closeBtn = el('span', 'dshcw-mtree-close', '✕')
    closeBtn.addEventListener('click', closeModelTree)
    head.appendChild(closeBtn)
    mtreeEl.appendChild(head)

    var groups = mtreeState.groups || []
    var def = mtreeState.default || {}
    if (!groups.length) {
      mtreeEl.appendChild(el('div', 'dshcw-mempty', '没有可用模型'))
      return
    }

    groups.forEach(function (g) {
      var gEl = el('div', 'dshcw-mgroup')
      var dotColor = /deepseek-account/i.test(g.id) ? '#ef4444'
        : /aliyun|dashscope/i.test(g.id) ? '#f59e0b'
        : /workbuddy/i.test(g.id) ? '#22c55e'
        : /deepseek/i.test(g.id) ? '#ef4444' : '#8b5cf6'
      var gLabel = el('div', 'dshcw-mgroup-label')
      gLabel.appendChild(el('span', 'dshcw-mcaret', '▸'))
      var dot = el('span', 'dshcw-mdot'); dot.style.background = dotColor
      gLabel.appendChild(dot)
      gLabel.appendChild(el('span', null, g.name || g.id))
      gLabel.appendChild(el('span', null, '（' + g.models.length + '）'))
      gEl.appendChild(gLabel)

      var bodyWrap = el('div')
      bodyWrap.style.display = 'none'
      gEl.appendChild(bodyWrap)

      // 分桶：阿里云/WorkBuddy 有分类，其他平铺
      var cats = categorize(g.id, g.models)
      if (cats.length) {
        cats.forEach(function (cat) {
          var cEl = el('div', 'dshcw-mcat')
          var cLabel = el('div', 'dshcw-mcat-label')
          cLabel.appendChild(el('span', 'dshcw-mcaret', '▸'))
          cLabel.appendChild(el('span', null, cat.label))
          cLabel.appendChild(el('span', null, '（' + cat.models.length + '）'))
          cEl.appendChild(cLabel)
          var cBody = el('div'); cBody.style.display = 'none'
          cEl.appendChild(cBody)
          cat.models.forEach(function (m) { cBody.appendChild(modelRow(g, m, def)) })
          cLabel.addEventListener('click', function () {
            var open = cBody.style.display !== 'none'
            cBody.style.display = open ? 'none' : 'block'
            cLabel.querySelector('.dshcw-mcaret').textContent = open ? '▸' : '▾'
          })
          bodyWrap.appendChild(cEl)
        })
      } else {
        g.models.forEach(function (m) { bodyWrap.appendChild(modelRow(g, m, def)) })
      }

      gLabel.addEventListener('click', function (e) {
        if (e.target !== gLabel && e.target !== gLabel.lastChild) {
          // 点在 dot/文字上也算
        }
        var open = bodyWrap.style.display !== 'none'
        bodyWrap.style.display = open ? 'none' : 'block'
        gLabel.querySelector('.dshcw-mcaret').textContent = open ? '▸' : '▾'
      })

      mtreeEl.appendChild(gEl)
    })
  }

  function modelRow(group, model, def) {
    var isCur = def && def.provider === group.id && def.model === model.id
    var row = el('div', 'dshcw-mitem' + (isCur ? ' cur' : ''))
    var nameSpan = el('span', null, model.name || model.id)
    row.appendChild(nameSpan)
    if (model.reasoning && model.reasoning.defaultEffort) {
      row.appendChild(el('span', 'eff', model.reasoning.defaultEffort))
    }
    row.addEventListener('click', function () {
      pickModel(group.id, model, def)
    })
    return row
  }

  function pickModel(providerId, model, def) {
    var remote = findRemoteSession()
    if (!remote || typeof remote.selectModel !== 'function') {
      alert('切换接口不可用（内核 Remote API 未暴露），请用自带模型选择器')
      return
    }
    var sessionId = def && def.sessionId
    var payload = {
      provider: providerId,
      model: model.id,
      ...(model.reasoning && model.reasoning.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {})
    }
    if (sessionId) payload.sessionId = sessionId
    Promise.resolve(remote.selectModel(payload)).then(function () {
      closeModelTree()
      if (mtreeEl) mtreeEl.remove()
      // 重新打开会刷新选中态
    }).catch(function (err) {
      alert('切换失败：' + String(err && err.message || err).slice(0, 80))
    })
  }

  // ---------- 数据 ----------
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() })
  }

  function tick() {
    Promise.all([
      fetchJson('/cost-tracker/summary'),
      fetchJson('/cost-tracker/recommend'),
      fetchJson('/cost-tracker/ledger'),
    ]).then(function (res) {
      render(res[0], res[1], res[2])
      lastReco = res[1]
    }).catch(function () {
      var body = root && root.querySelector('.dshcw-body')
      if (body) { body.textContent = ''; body.appendChild(el('div', 'dshcw-empty', '取数失败')) }
    })
  }

  // ---------- 启动 ----------
  function start() {
    try {
      build()
      tick()
      setInterval(tick, REFRESH_MS)
    } catch (e) {}
  }

  if (document.body) start()
  else window.addEventListener('DOMContentLoaded', start)
})()
