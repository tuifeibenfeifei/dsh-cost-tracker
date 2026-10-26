/**
 * credits.js 记账防护的回归测试（0.5.7）。
 *
 * 背景：WorkBuddy 的 /usage 偶尔不返回账号池余额，合计读成 0。旧代码用
 * `before - 0` 算本轮消耗，等于把整个余额记成一笔花费，而且会被重复结算
 * （2026-10-26 实测连记三条各 6731.99 分，当天从 419.30 虚增到 20615.27）。
 *
 * 跑法：node test/credits.test.mjs
 */
import { CreditTracker } from '../lib/credits.js'

function mk(total) {
  return {
    total,
    packages: [],
    models: [],
    at: Date.now(),
    signedIn: true,
    status: 'signed-in',
    expiresAtMs: 0,
    account: 'test',
  }
}

/** 让 tracker.sample() 返回固定快照 */
function stub(tracker, total) {
  tracker.sample = async () => mk(total)
}

const cases = []
const check = (name, pass, detail) => cases.push([name, !!pass, detail])

// 1) 正常扣费：6494.73 -> 6490.73，应记 4 分
{
  const t = new CreditTracker({})
  t.last = { total: 6494.73, at: Date.now(), signedIn: true }
  stub(t, 6490.73)
  const r = await t.settleTurn()
  check('正常扣费 4 分', r.ok === true && r.spent === 4, JSON.stringify(r))
}

// 2) 采样读到总额 0：绝不能记 6494.73
{
  const t = new CreditTracker({})
  t.last = { total: 6494.73, at: Date.now(), signedIn: true }
  stub(t, 0)
  const r = await t.settleTurn()
  check(
    '总额 0 拒绝结算',
    r.ok === false && r.spent === null && r.reason === 'invalid-total',
    JSON.stringify(r),
  )
  // 0 不是有效基准，this.last 必须保持旧值
  check('总额 0 不推进基准', t.last.total === 6494.73, 'this.last.total=' + t.last.total)
}

// 3) total 字段缺失（undefined）
{
  const t = new CreditTracker({})
  t.last = { total: 500, at: Date.now(), signedIn: true }
  stub(t, undefined)
  const r = await t.settleTurn()
  check('total 缺失拒绝结算', r.reason === 'invalid-total' && r.spent === null, JSON.stringify(r))
}

// 4) confirmTurn 读到总额 0
{
  const t = new CreditTracker({})
  stub(t, 0)
  const r = await t.confirmTurn(6494.73)
  check(
    'confirmTurn 总额 0 拒绝',
    r.ok === false && r.spent === null && r.reason === 'invalid-total',
    JSON.stringify(r),
  )
}

// 5) confirmTurn 正常扣费
{
  const t = new CreditTracker({})
  stub(t, 6492.73)
  const r = await t.confirmTurn(6494.73)
  check('confirmTurn 正常 2 分', r.spent === 2 && r.reason === 'confirmed', JSON.stringify(r))
}

// 6) 余额上升（充值）不算消耗
{
  const t = new CreditTracker({})
  t.last = { total: 100, at: Date.now(), signedIn: true }
  stub(t, 800)
  const r = await t.settleTurn()
  check('充值不记消耗', r.spent === null && r.reason === 'balance-increased', JSON.stringify(r))
}

// 7) 首次采样只建基准
{
  const t = new CreditTracker({})
  stub(t, 3000)
  const r = await t.settleTurn()
  check('首次采样建基准', r.spent === null && r.reason === 'baseline-established', JSON.stringify(r))
}

let failed = 0
for (const [name, ok, detail] of cases) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   ' + detail))
  if (!ok) failed += 1
}
console.log(
  failed === 0
    ? `\n全部通过 (${cases.length})`
    : `\n失败 ${failed} / ${cases.length}`,
)
process.exit(failed === 0 ? 0 : 1)
