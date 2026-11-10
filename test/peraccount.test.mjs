import { perAccountSpend, MAX_TURN_SPEND, CreditTracker } from '../lib/credits.js'

let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log((ok ? '  PASS ' : '  FAIL ') + name + '  → ' + JSON.stringify(got) + (ok ? '' : '  期望 ' + JSON.stringify(want)))
  ok ? pass++ : fail++
}

console.log('=== perAccountSpend 测试 ===\n')

// 1) 正常场景：5 账号都出现，各花一点
check('5 账号都出现，正常消耗',
  perAccountSpend(
    { balances: { a: 100, b: 200, c: 300, d: 400, e: 500 } },
    { balances: { a: 99, b: 199.5, c: 300, d: 399, e: 500 } },
  ),
  { spent: 2.5, compared: 5, missing: 0 })

// 2) 关键：某账号缺席 —— 总额差会是 730，但逐账号只算出现过的
check('1 个账号缺席（730 假账场景）',
  perAccountSpend(
    { balances: { a: 100, b: 200, c: 300, d: 400, e: 500 } },   // 总额 1500
    { balances: { a: 100, b: 200, c: 300, d: 400 } },            // e 缺席，总额 1000
  ),
  { spent: 0, compared: 4, missing: 1 })

// 3) 缺席 + 其他账号真有消耗
check('1 账号缺席 + 其他账号消耗 3',
  perAccountSpend(
    { balances: { a: 100, b: 200, c: 300, d: 400, e: 500 } },
    { balances: { a: 98, b: 199, c: 300, d: 400 } },
  ),
  { spent: 3, compared: 4, missing: 1 })

// 4) 单账号异常跳变（超过上限）被忽略
check('单账号跳变超上限被忽略',
  perAccountSpend(
    { balances: { a: 100, b: 200 } },
    { balances: { a: 99, b: 200 - MAX_TURN_SPEND - 1 } },        // b 跳变超限
  ),
  { spent: 1, compared: 2, missing: 0 })

// 5) 账号充值（余额上升）不计入
check('账号充值不计入消耗',
  perAccountSpend(
    { balances: { a: 100, b: 200 } },
    { balances: { a: 99, b: 500 } },                              // b 充值了
  ),
  { spent: 1, compared: 2, missing: 0 })

// 6) 无 balances（旧插件结构）→ 返回 null，调用方退回总额差法
check('旧结构无 balances 返回 null', perAccountSpend({ total: 100 }, { total: 99 }), null)

// 7) 空 balances → null
check('空 balances 返回 null', perAccountSpend({ balances: {} }, { balances: {} }), null)

// 8) 新增账号（下次才出现）不影响
check('新增账号不影响',
  perAccountSpend(
    { balances: { a: 100 } },
    { balances: { a: 99, z: 9999 } },
  ),
  { spent: 1, compared: 1, missing: 0 })

console.log('\n=== CreditTracker 集成：缺席账号不再产生假账 ===\n')

function snap(balances) {
  let total = 0
  for (const k of Object.keys(balances)) total += balances[k]
  return {
    total, balances, at: Date.now(), signedIn: true, expiresAtMs: Date.now() + 1e9,
    models: [],
  }
}

const t = new CreditTracker({ fetchStatus: async () => ({}) })
let n = 0
const seq = [
  snap({ a: 100, b: 200, c: 300 }),          // 基准 600
  snap({ a: 99, b: 199 }),                    // c 缺席！总额 298，差 302
]
t.sample = async () => seq[n++]

const first = await t.settleTurn()
console.log('  #1 建基准: spent=' + first.spent + ' reason=' + first.reason)
const second = await t.settleTurn()
console.log('  #2 账号缺席: spent=' + second.spent + ' reason=' + (second.reason || 'ok') + ' compared=' + second.accountsCompared)
const ok2 = second.spent === 2
console.log((ok2 ? '  PASS ' : '  FAIL ') + ' 缺席场景只记真实消耗 2（而非总额差 302）')
ok2 ? pass++ : fail++

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
