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
  var SETTINGS_KEY = 'dsh-cost-widget-settings'
  var REFRESH_MS = 60000

  // ---------- 用户设置（localStorage 持久化）----------
  var settings = {
    bubble: true,      // 轮次气泡
    sound: false,      // 提示音
    refreshSec: 60,    // 刷新间隔
    cardWidth: 230,    // 卡片宽度（预设档位或拖拽后的自定义值）
    alwaysShow: false, // 常驻显示（不随 💰 收起，一直挂在账户区旁）
  }
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        var s = JSON.parse(raw)
        if (typeof s.bubble === 'boolean') settings.bubble = s.bubble
        if (typeof s.sound === 'boolean') settings.sound = s.sound
        if ([30, 60, 120, 300].indexOf(Number(s.refreshSec)) !== -1) settings.refreshSec = Number(s.refreshSec)
        // 宽度：预设档位或 140–480 之间的自定义值（拖拽产生）
        var w = Number(s.cardWidth)
        if ([140, 230, 280, 330].indexOf(w) !== -1 || (w >= 140 && w <= 480)) settings.cardWidth = w
        if (typeof s.alwaysShow === 'boolean') settings.alwaysShow = s.alwaysShow
      }
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch (e) {}
  }
  loadSettings()

  // ---------- 样式 ----------
  function injectCss() {
    if (document.getElementById(CSS_ID)) return
    var css = [
      '.dshcw-root{position:fixed;z-index:12000;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px;user-select:none;display:none}',
      '.dshcw-card{background:#1f2937;color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.32);overflow:hidden;max-height:70vh;overflow-y:auto;position:relative}',
      // 拖拽手柄：面板右下角
      '.dshcw-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;opacity:.35}',
      '.dshcw-resize:hover{opacity:.9}',
      '.dshcw-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid #9ca3af;border-bottom:2px solid #9ca3af}',
      '.dshcw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;cursor:pointer;font-weight:700;font-size:12px;letter-spacing:.3px}',
      '.dshcw-title{display:flex;align-items:center;gap:5px;flex:none}',
      '.dshcw-toggle{opacity:.6;font-size:11px;padding:0 2px;flex:none}',
      '.dshcw-body{padding:0 10px 9px;display:flex;flex-direction:column;gap:5px}',
      '.dshcw-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;line-height:17px;white-space:nowrap}',
      '.dshcw-row.narrow{white-space:normal;flex-direction:column;align-items:flex-start;gap:1px}',
      '.dshcw-row.narrow .dshcw-val{white-space:normal;word-break:break-word}',
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
      '.dshcw-empty{padding:8px 10px;font-size:11px;color:#9ca3af}',
      // —— 设置面板 ——
      '.dshcw-settings{position:fixed;z-index:13002;width:250px;background:#111827;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.5);font-size:12px;padding:8px}',
      '.dshcw-settings-head{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 8px;font-weight:700;color:#9ca3af}',
      '.dshcw-setrow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 4px}',
      '.dshcw-setrow label{color:#e5e7eb;flex:none}',
      '.dshcw-setrow .hint{color:#6b7280;font-size:10px}',
      '.dshcw-btn{cursor:pointer;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#e5e7eb;border-radius:6px;padding:3px 10px;font-size:11px}',
      '.dshcw-btn:hover{background:rgba(255,255,255,.12)}',
      '.dshcw-btn.on{background:rgba(74,222,128,.25);border-color:rgba(74,222,128,.5);color:#bbf7d0}',
      '.dshcw-btn.danger{color:#fca5a5;border-color:rgba(248,113,113,.4)}',
      '.dshcw-setfoot{display:flex;justify-content:flex-end;gap:6px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1);margin-top:6px}',
      // 模型信息编辑区（设置面板里的「选模型 + 补信息」）
      '.dshcw-minfo{display:flex;flex-direction:column;gap:5px;padding:6px 4px 8px;border-top:1px solid rgba(255,255,255,.1);margin-top:6px}',
      '.dshcw-minfo .mhead{display:flex;align-items:center;justify-content:space-between;font-weight:700;color:#9ca3af}',
      '.dshcw-minfo select,.dshcw-minfo textarea{width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:4px 6px;font-size:11px;font-family:inherit}',
      '.dshcw-minfo textarea{min-height:58px;resize:vertical;line-height:1.5;white-space:pre-wrap}',
      '.dshcw-minfo .hint{color:#6b7280;font-size:10px;line-height:1.55}',
      '.dshcw-minfo .savebar{display:flex;align-items:center;gap:6px;justify-content:flex-end}',
      '.dshcw-minfo .saved{color:#86efac;font-size:10px}',
      '.dshcw-hidden .dshcw-body{display:none}',
      '.dshcw-hidden .dshcw-head{border-bottom:none}',
      '.dshcw-drag{cursor:move}'
    ].join('')
    var s = document.createElement('style')
    s.id = CSS_ID
    s.textContent = css
    ;(document.head || document.documentElement).appendChild(s)
  }

  // （侧栏面板模式下不再有拖动/位置记忆——面板位置锚定账户区，固定不出界）

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
  var lastReco = null
  /** 侧栏 💰 按钮引用：看门狗重建时复用，避免堆出多个入口 */
  var sidebarBtn = null
  /** 自愈看门狗计时器（只装一次） */
  var watchdogTimer = null

  // ---------- 模型官方信息（限时活动 / 免费时段）----------
  /**
   * 数据来源 /cost-tracker/models：
   *   modelCatalog: [{ id, name }]  设置面板下拉框
   *   modelNotes:   { id: 文案 }    内置官方公告 + 用户/AI 覆盖后的结果
   *
   * 改动落盘在 .cost-tracker.json 的 modelNotes，AI 与面板读写同一份，
   * 所以用户「把官方公告贴给 AI」和「自己在设置里改」效果一致。
   */
  var modelInfo = { catalog: [], notes: {} }
  var modelInfoLoaded = false

  function loadModelInfo() {
    return fetchJson('/cost-tracker/models').then(function (j) {
      if (j && Array.isArray(j.modelCatalog)) modelInfo.catalog = j.modelCatalog
      if (j && j.modelNotes && typeof j.modelNotes === 'object') modelInfo.notes = j.modelNotes
      modelInfoLoaded = true
      return modelInfo
    }).catch(function () { return modelInfo })
  }

  function saveModelNote(id, note) {
    return fetch('/cost-tracker/model-notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id, note: note }),
    }).then(function (r) { return r.json() })
  }

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
    // ⚙ 设置面板（气泡/音效/刷新间隔/卡片宽度）
    var gear = el('span', null, '⚙')
    gear.title = '设置'
    gear.style.cssText = 'cursor:pointer;font-size:11px;opacity:.7;margin-left:3px;user-select:none'
    gear.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleSettings(gear)
    })
    head.appendChild(gear)
    var closeBtn = el('span', 'dshcw-toggle', '✕')
    closeBtn.title = '收起'
    head.appendChild(closeBtn)
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      hidePanel()
    })

    var body = el('div', 'dshcw-body')
    body.appendChild(el('div', 'dshcw-empty', '加载中…'))

    card.appendChild(head)
    card.appendChild(body)
    // 拖拽手柄：右下角自由调宽
    card.appendChild(el('div', 'dshcw-resize'))
    root.appendChild(card)
    // 固定浮层：💰 按钮常驻左下角，点击展开/收起面板（面板 fixed 定位，
    // 不碰 DSH 的 React 节点，避免白屏 / 被重渲染移除）。
    mountFloating()
    // 默认折叠（仅标题所在面板隐藏），点 💰 或标题展开
    root.style.display = 'none'

    applyCardWidth()
    enableResize()
    // 暴露面板控制 API
    window.__dshCostPanel = {
      toggle: function () {
        var show = root.style.display === 'none'
        root.style.display = show ? 'block' : 'none'
        if (show) { positionPanel(); tick() }
      },
      close: hidePanel,
      open: function () { root.style.display = 'block'; positionPanel(); tick() },
    }
    mountFloatingButton()
    // 常驻显示：面板一直开着
    if (settings.alwaysShow) {
      root.style.display = 'block'
      positionPanel()
      tick()
    }
    return body
  }

  /**
   * 右下角拖拽手柄：自由调整面板宽度（140–480px），松手持久化。
   * 只改宽度，高度依旧自适应内容。
   */
  function enableResize() {
    var card = root.firstElementChild
    var handle = card.querySelector('.dshcw-resize')
    if (!handle) return
    var startX = 0, startW = 0, dragging = false
    handle.addEventListener('mousedown', function (e) {
      dragging = true
      startX = e.clientX
      startW = settings.cardWidth
      e.preventDefault(); e.stopPropagation()
    })
    window.addEventListener('mousemove', function (ev) {
      if (!dragging) return
      // 向左拖 = 变宽（面板锚在账户区右侧）
      var w = Math.max(140, Math.min(480, startW + (startX - ev.clientX)))
      settings.cardWidth = w
      applyCardWidth()
    })
    window.addEventListener('mouseup', function (ev) {
      if (!dragging) return
      dragging = false
      saveSettings()
      if (root.style.display !== 'none') positionPanel()
    })
  }

  /**
   * 固定浮层方案（最稳、与 DSH React 节点零耦合）：
   *  - 💰 按钮常驻左下角（z-index 高、不会被任何重渲染移除）；
   *  - 面板为 position:fixed，锚定按钮上方，不 append 进任何 React 容器，
   *    因此不会被宿主重渲染清掉，也不会导致白屏。
   *  - 常驻模式（设置里开）则面板直接常开，💰 按钮不再需要。
   */
  function mountFloating() {
    if (!root) return
    root.setAttribute('data-dsh-cost', '1')
    root.style.position = 'fixed'
    root.style.zIndex = '12000'
    root.style.width = Math.min(settings.cardWidth, (window.innerWidth || 1200) - 16) + 'px'
    // display 由调用方统一管理（默认 none，常驻时 block）
  }

  /** 常驻左下角的 💰 入口按钮（始终可见，除非面板已常开） */
  function mountFloatingButton() {
    if (sidebarBtn && sidebarBtn.parentNode) {
      try { sidebarBtn.parentNode.removeChild(sidebarBtn) } catch (e) {}
    }
    var btn = document.createElement('button')
    sidebarBtn = btn
    btn.textContent = '💰'
    btn.title = '费用追踪（点击展开）'
    btn.style.cssText = 'position:fixed;z-index:12005;left:8px;bottom:8px;width:32px;height:32px;' +
      'display:' + (settings.alwaysShow ? 'none' : 'flex') + ';align-items:center;justify-content:center;' +
      'background:rgba(31,41,55,.95);border:1px solid rgba(255,255,255,.2);border-radius:8px;' +
      'cursor:pointer;font-size:16px;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.45)'
    btn.addEventListener('click', function () {
      if (window.__dshCostPanel) window.__dshCostPanel.toggle()
    })
    ;(document.body || document.documentElement).appendChild(btn)
  }

  /** 面板定位：贴左下角 💰 按钮上方，钳制在视口内 */
  function positionPanel() {
    if (!root) return
    var w = root.offsetWidth || settings.cardWidth
    var h = root.offsetHeight || 300
    var vw = window.innerWidth || 1200
    var vh = window.innerHeight || 800
    var left = Math.max(8, vw - w - 12)
    var top = Math.max(8, vh - h - 48)   // 给 💰 按钮留 48px
    root.style.left = left + 'px'
    root.style.top = top + 'px'
    root.style.bottom = 'auto'
    root.style.right = 'auto'
  }

  function hidePanel() {
    if (root) root.style.display = 'none'
  }

  // ---------- 渲染 ----------
  function row(label, value, dotColor, valClass) {
    var narrow = settings.cardWidth < 200
    var r = el('div', 'dshcw-row' + (narrow ? ' narrow' : ''))
    var l = el('div', 'dshcw-label')
    if (dotColor) {
      var d = el('span', 'dshcw-dot')
      d.style.background = dotColor
      l.appendChild(d)
    }
    l.appendChild(el('span', null, label))
    var v = el('div', 'dshcw-val' + (valClass ? ' ' + valClass : ''), value)
    if (narrow) {
      // 窄面板：上下两行布局——标签在上、数值在下（先标题后内容，与宽面板一致）
      r.style.flexDirection = 'column'
      r.style.alignItems = 'flex-start'
      r.style.gap = '1px'
      l.style.width = '100%'
      v.style.width = '100%'
      v.style.whiteSpace = 'normal'
      v.style.wordBreak = 'break-word'
      r.appendChild(l)
      r.appendChild(v)
    } else {
      r.appendChild(l)
      r.appendChild(v)
    }
    return r
  }

  function render(summary, reco, ledger) {
    if (!root) return
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
        // 「免费」只有在使用免费模型时才成立：
        //  - allFree=true（本轮全部是上游标记免费的模型）→ 免费
        //  - zero-pending/unconfirmed（付费模型扣减未入账）→ 结算中…/—，绝不能显示免费
        var wbReason = lt.workbuddy && lt.workbuddy.reason
        var pending = wbReason === 'zero-pending' || wbReason === 'baseline-established' || wbReason === 'baseline-stale' || wbReason === 'unconfirmed'
        var label
        if (one.length) {
          label = one.join(' / ')
        } else if (pending) {
          label = wbReason === 'unconfirmed' ? '积分未入账' : '结算中…'
        } else if (lt.allFree) {
          label = '免费'
        } else {
          label = '—'
        }
        body.appendChild(row('本轮', label, null, one.length ? 'warn' : (label === '免费' ? 'free' : '')))
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

  // ---------- 数据 ----------
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() })
  }

  // ---------- 轮次气泡 + 音效 ----------
  var lastTurnSeen = null

  /** 短促「叮」：Web Audio 合成，无外部音频文件（不用鲸鱼素材，规避许可问题） */
  function playChime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      if (!playChime._ctx) playChime._ctx = new Ctx()
      var ctx = playChime._ctx
      var osc = ctx.createOscillator()
      var gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, ctx.currentTime)          // A5
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12) // 上滑到 E6
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(); osc.stop(ctx.currentTime + 0.4)
    } catch (e) {}
  }

  /** 轮次结束气泡：显示在账户区上方（用户要求的固定区域），4.5 秒后淡出 */
  function showTurnBubble(text) {
    try {
      var old = document.getElementById('dshcw-turn-bubble')
      if (old) old.remove()
      var b = el('div', null, text)
      b.id = 'dshcw-turn-bubble'
      b.style.cssText = 'position:fixed;z-index:12001;background:#1f2937;color:#fff;' +
        'border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:7px 11px;' +
        'font-size:12px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.4);' +
        'white-space:nowrap;opacity:0;transition:opacity .3s;pointer-events:none;' +
        'font-family:var(--dsw-font-family,system-ui,sans-serif)'
      ;(document.body || document.documentElement).appendChild(b)
      // 定位：账户区上方（头像上方的固定区域）
      var acc = findAccountArea()
      var left, top
      if (acc) {
        left = Math.max(4, acc.left)
        top = Math.max(4, acc.top - 44)
      } else {
        left = 8
        top = (window.innerHeight || 800) - 160
      }
      b.style.left = left + 'px'
      b.style.top = top + 'px'
      // 淡入
      requestAnimationFrame(function () { b.style.opacity = '1' })
      setTimeout(function () {
        b.style.opacity = '0'
        setTimeout(function () { b.remove() }, 400)
      }, 4500)
    } catch (e) {}
  }

  /** 检测新轮次：turn 序号变化且时间在最近 2 分钟内 → 弹气泡（免费轮不弹） */
  function checkNewTurn(ledger) {
    try {
      if (!ledger || !ledger.ok || !ledger.lastTurn) return
      var lt = ledger.lastTurn
      // 键 = 轮次 + 时间 + 积分值：积分延迟入账回写后 spent 变化 → 键变化
      // → 同一轮能触发第二次通知（这次才是真实消耗 + 音效）
      var wbSpent = lt.workbuddy && typeof lt.workbuddy.spent === 'number' ? lt.workbuddy.spent : 'x'
      var key = lt.turn + ':' + lt.at + ':' + wbSpent + ':' + (Number(lt.costTokenBased) || 0)
      if (lastTurnSeen === null) {
        // 首次加载：只记录，不弹（避免刷新页面时重弹历史轮）
        lastTurnSeen = key
        return
      }
      if (key === lastTurnSeen) return
      var firstNotice = lastTurnSeen.split(':')[0] !== String(lt.turn)
      lastTurnSeen = key
      // 只处理 2 分钟内的轮次
      if (Date.now() - Number(lt.at) > 120000) return
      if (!settings.bubble) return // 设置里关了气泡

      // 组文案：积分 / 真钱
      var parts = []
      if (Number(lt.costTokenBased) > 0) parts.push('¥' + fmtNum(lt.costTokenBased))
      if (lt.workbuddy && typeof lt.workbuddy.spent === 'number' && lt.workbuddy.spent > 0) {
        parts.push(lt.workbuddy.spent + ' 积分')
      }
      if (!parts.length) {
        // 消耗还没到手：也弹一次提示「对话已结束，积分结算中」+ 响铃——
        // 之前的静默导致用户以为气泡/音效坏了。复查到账后 key 变化
        // 会再弹一次真实数字（带「结算完成」标记）。
        var wbReason = (lt.workbuddy && lt.workbuddy.reason) || ''
        if (lt.workbuddy && (wbReason === 'zero-pending' || wbReason === 'unconfirmed')) {
          showTurnBubble('本轮对话结束，积分结算中…')
          if (settings.sound) playChime()
        }
        return
      }
      // 同一轮的第二次通知（延迟结算到账）标注出来，避免像重复弹
      var text = '本轮 ' + parts.join(' + ') + (firstNotice ? '' : '（结算完成）')
      showTurnBubble(text)
      // 音效与「真实消耗到手」同步：这里就是结算完成的时刻
      if (settings.sound) playChime()
    } catch (e) {}
  }

  // ---------- 设置面板 ----------
  var setEl = null
  var refreshTimer = null

  function applyCardWidth() {
    try {
      var card = root && root.firstElementChild
      if (card) card.style.width = settings.cardWidth + 'px'
      // 宽度变化后重新锚定账户区
      if (root && root.style.display !== 'none') positionPanel()
    } catch (e) {}
  }

  function applyRefreshInterval() {
    try {
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = setInterval(tick, settings.refreshSec * 1000)
    } catch (e) {}
  }

  function toggleSettings(anchor) {
    if (setEl) { setEl.remove(); setEl = null; return }
    setEl = el('div', 'dshcw-settings')
    var head = el('div', 'dshcw-settings-head', '设置')
    var closeBtn = el('span', 'dshcw-mtree-close', '✕')
    closeBtn.addEventListener('click', function () { if (setEl) { setEl.remove(); setEl = null } })
    head.appendChild(closeBtn)
    setEl.appendChild(head)

    function rowOf(label) {
      var r = el('div', 'dshcw-setrow')
      r.appendChild(el('label', null, label))
      return r
    }
    function toggleBtn(get, set, onText, offText) {
      var b = el('span', 'dshcw-btn' + (get() ? ' on' : ''), get() ? onText : offText)
      b.addEventListener('click', function () {
        set(!get())
        b.classList.toggle('on', get())
        b.textContent = get() ? onText : offText
        saveSettings()
      })
      return b
    }

    // 气泡开关
    var r1 = rowOf('轮次气泡')
    r1.appendChild(toggleBtn(
      function () { return settings.bubble },
      function (v) { settings.bubble = v },
      '开', '关'))
    setEl.appendChild(r1)

    // 提示音开关
    var r2 = rowOf('提示音')
    r2.appendChild(toggleBtn(
      function () { return settings.sound },
      function (v) { settings.sound = v; if (v) playChime() },
      '🔔 开', '🔕 关'))
    setEl.appendChild(r2)

    // 刷新间隔
    var r3 = rowOf('刷新间隔')
    var refWrap = el('div')
    ;[30, 60, 120, 300].forEach(function (sec) {
      var b = el('span', 'dshcw-btn' + (settings.refreshSec === sec ? ' on' : ''), sec + 's')
      b.style.marginLeft = '4px'
      b.addEventListener('click', function () {
        settings.refreshSec = sec
        saveSettings()
        applyRefreshInterval()
        // 更新选中态
        ;[].forEach.call(refWrap.children, function (c) { c.classList.toggle('on', c === b) })
      })
      refWrap.appendChild(b)
    })
    r3.appendChild(refWrap)
    setEl.appendChild(r3)

    // 卡片宽度（预设档位；精细调整用面板右下角拖拽手柄）
    // 档位按钮换行排列：四个 40px+ 按钮横排会超出 250px 的设置面板宽
    var r4 = rowOf('卡片宽度')
    r4.style.flexWrap = 'wrap'
    var wWrap = el('div')
    wWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;width:100%'
    ;[140, 230, 280, 330].forEach(function (w) {
      var b = el('span', 'dshcw-btn' + (settings.cardWidth === w ? ' on' : ''), w + 'px')
      b.addEventListener('click', function () {
        settings.cardWidth = w
        saveSettings()
        applyCardWidth()
        ;[].forEach.call(wWrap.children, function (c) { c.classList.toggle('on', c === b) })
      })
      wWrap.appendChild(b)
    })
    r4.appendChild(wWrap)
    setEl.appendChild(r4)
    var r4h = el('div', 'dshcw-setrow')
    r4h.appendChild(el('span', 'hint', '更细：拖面板右下角手柄，松手保存'))
    setEl.appendChild(r4h)

    // 常驻显示：面板不随 💰 收起，一直挂在账户区旁（配合窄宽度减少遮挡）
    var r5 = rowOf('常驻显示')
    r5.appendChild(toggleBtn(
      function () { return settings.alwaysShow },
      function (v) {
        settings.alwaysShow = v
        if (v) {
          root.style.display = 'block'
          positionPanel()
          tick()
        } else {
          hidePanel()
        }
      },
      '开', '关'))
    setEl.appendChild(r5)
    var r5h = el('div', 'dshcw-setrow')
    r5h.appendChild(el('span', 'hint', '开着时面板一直在，💰 仍可临时收起'))
    setEl.appendChild(r5h)

    // 模型官方信息（限时活动 / 免费时段）：选模型 + 补信息
    // 用途：官方常发「限时免费/夜间免费」，日期一过就失效；把公告写在这里，
    // 面板随模型列出，用户不用记。也能让 AI 直接改（同一份数据）。
    var minfo = el('div', 'dshcw-minfo')
    minfo.appendChild(el('div', 'mhead', '模型信息'))

    var sel = document.createElement('select')
    minfo.appendChild(sel)

    var ta = document.createElement('textarea')
    ta.placeholder = '例：限时免费：7月6日–10月31日，每日赠送免费额度'
    minfo.appendChild(ta)

    minfo.appendChild(el('div', 'hint',
      '把官方公告原文发给 AI，让它更新模型信息；也可以直接在这里改后保存。留空 = 不显示该模型的活动说明。'))

    var savebar = el('div', 'savebar')
    var savedTip = el('span', 'saved', '')
    var saveBtn = el('span', 'dshcw-btn', '保存')
    savebar.appendChild(savedTip)
    savebar.appendChild(saveBtn)
    minfo.appendChild(savebar)
    setEl.appendChild(minfo)

    function fillModelSelect() {
      while (sel.firstChild) sel.removeChild(sel.firstChild)
      var list = modelInfo.catalog
      if (!list.length) {
        var ph = document.createElement('option')
        ph.value = ''
        ph.textContent = '（未取到模型列表）'
        sel.appendChild(ph)
        return
      }
      for (var mi = 0; mi < list.length; mi++) {
        var op = document.createElement('option')
        op.value = list[mi].id
        op.textContent = list[mi].name || list[mi].id
        sel.appendChild(op)
      }
    }
    function syncNote() {
      var id = sel.value
      ta.value = (modelInfo.notes && modelInfo.notes[id]) || ''
      savedTip.textContent = ''
    }
    fillModelSelect()
    sel.addEventListener('change', syncNote)
    syncNote()
    if (!modelInfoLoaded) {
      loadModelInfo().then(function () { fillModelSelect(); syncNote() })
    }

    saveBtn.addEventListener('click', function () {
      var id = sel.value
      if (!id) return
      saveBtn.textContent = '保存中…'
      saveModelNote(id, ta.value).then(function (j) {
        if (j && j.ok) {
          if (j.modelNotes && typeof j.modelNotes === 'object') modelInfo.notes = j.modelNotes
          savedTip.textContent = '已保存'
        } else {
          savedTip.textContent = '保存失败'
        }
        saveBtn.textContent = '保存'
      }).catch(function () {
        savedTip.textContent = '保存失败'
        saveBtn.textContent = '保存'
      })
    })

    // 底部：重置面板（重新锚定账户区 + 刷新数据）
    var foot = el('div', 'dshcw-setfoot')
    var resetBtn = el('span', 'dshcw-btn danger', '重新锚定面板')
    resetBtn.title = '面板跑到奇怪位置时，重新对齐账户区'
    resetBtn.addEventListener('click', function () {
      positionPanel()
    })
    foot.appendChild(resetBtn)
    setEl.appendChild(foot)

    ;(document.body || document.documentElement).appendChild(setEl)
    // 定位：锚点（⚙）附近，视口钳制
    var r = anchor.getBoundingClientRect()
    var w = 250
    var left = Math.max(4, Math.min(r.right - w, (window.innerWidth || 1200) - w - 4))
    var top = Math.min(r.bottom + 6, (window.innerHeight || 800) - 300)
    setEl.style.left = left + 'px'
    setEl.style.top = top + 'px'
  }

  function tick() {
    Promise.all([
      fetchJson('/cost-tracker/summary'),
      fetchJson('/cost-tracker/recommend'),
      fetchJson('/cost-tracker/ledger'),
    ]).then(function (res) {
      render(res[0], res[1], res[2])
      lastReco = res[1]
      checkNewTurn(res[2])
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
      applyRefreshInterval() // 用设置里的间隔（30/60/120/300s）
    } catch (e) {}
  }

  /**
   * 自愈看门狗：DSH 视图切换 / HMR / React 重建 DOM 会把面板或 💰 入口
   * 带走，表现为「插件时不时消失」。3 秒巡检一次自动补回。
   *
   * 只做三件事，全部幂等：
   *   1) 面板节点不在文档里 → 丢弃引用后重建
   *   2) 💰 入口不在文档里 → 补一个
   *   3) 常驻模式下面板被意外收起 → 重新显示
   */
  function startWatchdog() {
    if (watchdogTimer) return
    watchdogTimer = setInterval(function () {
      try {
        var host = document.body || document.documentElement
        if (!host) return
        if (!root) { start(); return }
        // 1) 面板被移出文档（极端）-> 重建
        if (!host.contains(root)) {
          root = null
          start()
          return
        }
        // 2) 💰 入口按钮丢失 -> 补一个（常驻模式才隐藏）
        if (sidebarBtn && !sidebarBtn.parentNode) {
          mountFloatingButton()
        } else if (sidebarBtn && settings.alwaysShow) {
          sidebarBtn.style.display = 'none'
        }
        // 3) 常驻模式下面板被意外收起 -> 重新显示
        if (settings.alwaysShow && root.style.display === 'none') {
          root.style.display = 'block'
          positionPanel()
        }
      } catch (e) {}
    }, 3000)
  }

  function boot() {
    // 浮层入口始终启动（最稳，与标签页方案互不冲突）；
    // 若 Better Sidebar 标签页已注册，用户可在 Better Sidebar 里用标签页，
    // 也可保留左下角 💰 浮层——两者并存无碍。
    start()
    startWatchdog()
  }

  if (document.body) boot()
  else window.addEventListener('DOMContentLoaded', boot)
})()
