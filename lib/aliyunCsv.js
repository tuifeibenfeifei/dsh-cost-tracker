// 阿里云百炼代金券流水 CSV 解析与校准
//
// 背景：阿里云百炼按「请求级/分段级」出账（实测 552 笔流水中，同一秒多笔、
// 单笔金额跨 6 个数量级、余额链条有 84 处并发断链），因此**无法用
// token × 峰谷单价 反推真实扣减**。本模块提供「用官方流水校准」的能力：
// 用户从阿里云控制台导出 coupon use flow CSV，插件解析出真实余额与消耗，
// 作为 token 估算值的校准基准。
//
// CSV 格式（2026-10 实测，UTF-8 with BOM，字段带制表符后缀）：
//   订单号/账单号,处理时间,券号,交易类型,交易说明,处理金额,当前余额,
//   抵扣账号,所属账号,优惠券流水ID,币种,商品名称,账期
//
// 隐私：解析结果不保留账号名，只输出脱敏后的统计量。

/** 列名到内部字段的映射（容忍首尾空白与 BOM） */
const COLUMNS = [
  ['订单号/账单号', 'orderId'],
  ['处理时间', 'at'],
  ['券号', 'couponId'],
  ['交易类型', 'txType'],
  ['交易说明', 'txNote'],
  ['处理金额', 'amount'],
  ['当前余额', 'balance'],
  ['抵扣账号', 'account'],
  ['所属账号', 'owner'],
  ['优惠券流水ID', 'flowId'],
  ['币种', 'currency'],
  ['商品名称', 'product'],
  ['账期', 'period'],
]

/** 去掉 BOM / 制表符 / 首尾空白 */
function cleanCell(s) {
  return String(s == null ? '' : s).replace(/^﻿/, '').replace(/\t+$/, '').trim()
}

/** 账号脱敏：只保留前 8 位 */
export function maskAccount(v) {
  const s = String(v || '')
  return s.length > 8 ? s.slice(0, 8) + '…' : s
}

/** 解析单个 CSV 行为字段对象；列数不符返回 null */
function parseLine(line, headerIndex) {
  const cells = line.split(',')
  if (cells.length < 7) return null
  const row = {}
  for (let i = 0; i < COLUMNS.length && i < cells.length; i++) {
    row[COLUMNS[i][1]] = cleanCell(cells[i])
  }
  // 兜底：按列名顺序取（防止表头顺序变化时错位）
  if (headerIndex && headerIndex.balance !== undefined) {
    row.balance = cleanCell(cells[headerIndex.balance])
    row.amount = cleanCell(cells[headerIndex.amount])
    row.at = cleanCell(cells[headerIndex.at])
  }
  return row
}

/** 定位表头中各关键列的下标 */
function locateHeader(cells) {
  const norm = cells.map((c) => cleanCell(c).replace(/﻿/, ''))
  const idx = {}
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] === '处理金额') idx.amount = i
    else if (norm[i] === '当前余额') idx.balance = i
    else if (norm[i] === '处理时间') idx.at = i
    else if (norm[i] === '商品名称') idx.product = i
  }
  return (idx.amount !== undefined && idx.balance !== undefined) ? idx : null
}

/**
 * 解析整份 CSV 文本。
 * @param {string} text CSV 原文
 * @returns {{ok:boolean, reason?:string, rows?:object[], summary?:object}}
 */
export function parseAliyunCouponCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty-input' }
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return { ok: false, reason: 'no-data-rows' }

  const headerCells = lines[0].split(',')
  const headerIndex = locateHeader(headerCells)
  if (!headerIndex) return { ok: false, reason: 'unrecognized-header' }

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const row = parseLine(lines[i], headerIndex)
    if (!row) continue
    const amount = Number(row.amount)
    const balance = Number(row.balance)
    if (!Number.isFinite(amount) || !Number.isFinite(balance)) continue
    rows.push({
      orderId: row.orderId,
      at: row.at,
      couponId: row.couponId,
      txType: row.txType,
      txNote: row.txNote,
      amount,
      balance,
      currency: row.currency,
      product: row.product,
      period: row.period,
    })
  }
  if (rows.length === 0) return { ok: false, reason: 'no-parseable-rows' }

  return { ok: true, rows, summary: summarizeRows(rows) }
}

/** 汇总统计：总消耗、末余额、笔数、时间范围 */
export function summarizeRows(rows) {
  let spent = 0
  let inflow = 0
  for (const r of rows) {
    if (r.amount < 0) spent += -r.amount
    else inflow += r.amount
  }
  const last = rows[rows.length - 1]
  const first = rows[0]
  return {
    rows: rows.length,
    spent: Math.round(spent * 1e6) / 1e6,
    inflow: Math.round(inflow * 1e6) / 1e6,
    lastBalance: last ? last.balance : null,
    lastAt: last ? last.at : null,
    firstAt: first ? first.at : null,
    products: [...new Set(rows.map((r) => r.product).filter(Boolean))],
    coupons: [...new Set(rows.map((r) => r.couponId).filter(Boolean))],
  }
}

/**
 * 用一份 CSV 校准余额基准。
 * @param {string} text CSV 原文
 * @param {object} prev 上一次校准状态 { balance, at }
 * @returns {{ok:boolean, reason?:string, balance?:number, at?:string, spentSince?:number}}
 */
export function calibrateFromCsv(text, prev) {
  const parsed = parseAliyunCouponCsv(text)
  if (!parsed.ok) return parsed

  const s = parsed.summary
  const balance = s.lastBalance
  // 「处理时间」形如 2026-10-19 18:05:58；转成 epoch ms 供界面显示
  const atMs = s.lastAt ? Date.parse(s.lastAt.replace(' ', 'T') + '+08:00') : Date.now()

  const result = {
    ok: true,
    balance,
    at: s.lastAt,
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
    rows: s.rows,
    products: s.products,
  }

  // 若上一次也有基准，算出两次校准之间的真实消耗
  if (prev && Number.isFinite(Number(prev.balance))) {
    const delta = Number(prev.balance) - balance
    result.spentSince = Math.round(delta * 1e6) / 1e6
  }
  return result
}
