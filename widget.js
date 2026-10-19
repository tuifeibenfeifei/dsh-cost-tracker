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

  // ---------- 样式 ----------
  function injectCss() {
    if (document.getElementById(CSS_ID)) return
    var css = [
      '.dshcw-root{position:fixed;z-index:12000;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;user-select:none}',
      '.dshcw-card{background:#1f2937;color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.32);overflow:hidden;min-width:190px}',
      '.dshcw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;cursor:pointer;font-weight:700;font-size:12px;letter-spacing:.3px}',
      '.dshcw-title{display:flex;align-items:center;gap:5px}',
      '.dshcw-toggle{opacity:.6;font-size:11px;padding:0 2px}',
      '.dshcw-body{padding:0 10px 9px;display:flex;flex-direction:column;gap:5px}',
      '.dshcw-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;line-height:17px}',
      '.dshcw-label{color:#9ca3af;display:flex;align-items:center;gap:5px}',
      '.dshcw-dot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.dshcw-val{font-weight:700;font-variant-numeric:tabular-nums}',
      '.dshcw-val.free{color:#4ade80}',
      '.dshcw-val.warn{color:#fca5a5}',
      '.dshcw-sep{height:1px;background:rgba(255,255,255,.12);margin:3px 0}',
      '.dshcw-reco{font-size:11px;line-height:16px;color:#d1d5db}',
      '.dshcw-reco b{color:#fff}',
      '.dshcw-tip{margin-top:2px;padding:5px 7px;border-radius:6px;background:rgba(252,165,165,.14);border:1px solid rgba(252,165,165,.32);color:#fecaca;font-size:11px;line-height:15px}',
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
    var maxL = (window.innerWidth || 1200) - 60
    var maxT = (window.innerHeight || 800) - 40
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

  function render(summary, reco) {
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
      ? wb.credits + ' 分' : '—', '#22c55e', 'free'))

    body.appendChild(el('div', 'dshcw-sep'))

    // 今日花费
    var t = summary && summary.totals
    var today = []
    if (t) {
      if (Number(t.costTokenBased) > 0) today.push('¥' + fmtNum(t.costTokenBased))
      if (Number(t.workbuddyCredits) > 0) today.push(t.workbuddyCredits + ' 分')
    }
    body.appendChild(row('累计', today.length ? today.join(' / ') : '0', null, today.length ? 'warn' : 'free'))

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
          var label = m.name
          if (m.free) label += '（免费）'
          else if (m.outOfQuota) label += '（额度尽 x' + m.rate + '）'
          else label += '（x' + m.rate + '）'
          line.appendChild(document.createTextNode(label))
          // 思考强度：同倍率下它决定实际输出 token 量，直接显示出来
          if (m.effortLabel) {
            var eff = el('span', null, ' · ' + m.effortLabel)
            eff.style.opacity = '.7'
            eff.style.fontSize = '10px'
            eff.style.marginLeft = '4px'
            line.appendChild(eff)
          }
          rl.appendChild(line)
        }
      }
      body.appendChild(rl)
    }

    // 限流提示（实时）
    if (reco && reco.limited && reco.limited.length) {
      for (var k = 0; k < reco.limited.length; k++) {
        var lm = reco.limited[k]
        body.appendChild(el('div', 'dshcw-tip', '⚠ ' + lm.id + ' 已限流，' + fmtLeft(lm.leftMs) + '后恢复，建议切换模型'))
      }
    }

    // 免费额度用尽提示（实时）
    if (reco && reco.live && reco.live.freeExhausted && reco.live.freeExhausted.length) {
      body.appendChild(el('div', 'dshcw-tip',
        '⚠ 免费额度已用尽：' + reco.live.freeExhausted.join('、') + '，已改按付费倍率推荐'))
    }
  }

  // ---------- 数据 ----------
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() })
  }

  function tick() {
    Promise.all([
      fetchJson('/cost-tracker/summary'),
      fetchJson('/cost-tracker/recommend'),
    ]).then(function (res) {
      render(res[0], res[1])
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
