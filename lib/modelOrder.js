// WorkBuddy 模型分组排序 + 徽章文案
//
// 用户实际使用优先级（成本观：WorkBuddy 免费模型 → 阿里云抵用券 → WorkBuddy
// 付费模型 → DeepSeek 官方真钱）：
//   1. WorkBuddy 免费模型
//   2. 阿里云（抵用券，非真钱）
//   3. WorkBuddy 的 deepseek-v4.1-flash
//   4. 其他 WorkBuddy 模型
//   5. DeepSeek 官方账号
//
// **跨 provider 无法交错排序**：DSH 模型选择器先按 provider 分组，组内保留
// 第三方 catalog 顺序（dsh-client-ui-model-selection 文档原文：
// "Both entries group models by provider, third-party providers retain their
// catalog order."）。因此本模块只产出 WorkBuddy 组内的四档排序数据，
// 全局优先级以 README 的使用约定形式呈现。

/** 第二档：主力模型（固定） */
const TIER_FLASH = ['deepseek-v4.1-flash']

/** 第三档：其他常用 */
const TIER_COMMON = [
  'glm-5.3-flash',
  'hy3-x',
  'space-bunny',
  'minimax-m2.7',
  'hy4-preview',
]

/** 第四档：不常用，排最后 */
const TIER_RARE = [
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'minimax-m3',
  'kimi-k3-1',
  'kimi-k2.8-preview',
  'kimi-k2.7',
  'kimi-k2.6',
  'deepseek-v4-pro',
  'mimo-v2.6-pro',
]

/**
 * 给一组 WorkBuddy 模型排序。
 *
 * 档位规则：
 *   第一档 free === true（实时读 status 接口，不硬编码免费时间表）
 *   第二档 deepseek-v4.1-flash
 *   第三档 其他常用
 *   第四档 不常用，排最后
 * 未登记的模型追加在末尾，保持 catalog 原序。
 *
 * @param {Array<{id:string, free?:boolean}>} models status 接口返回的模型列表
 * @returns {Array} 排序后的新数组（不改原数组）
 */
export function rankWorkbuddyModels(models) {
  if (!Array.isArray(models)) return []
  const list = models.map((m, i) => ({ m, i }))

  const tierOf = (entry) => {
    const id = String(entry.m && entry.m.id ? entry.m.id : '')
    if (entry.m && entry.m.free === true) return 1
    if (TIER_FLASH.indexOf(id) !== -1) return 2
    if (TIER_COMMON.indexOf(id) !== -1) return 3
    if (TIER_RARE.indexOf(id) !== -1) return 4
    return 5
  }

  return list
    .slice()
    .sort((a, b) => {
      const ta = tierOf(a)
      const tb = tierOf(b)
      if (ta !== tb) return ta - tb
      return a.i - b.i // 同档内保持 catalog 原序
    })
    .map((e) => e.m)
}

/**
 * 生成一个模型的徽章文案（用于 conversation.input.model.label）。
 *
 * 显示内容：
 *   - 免费（free === true）
 *   - 倍率，如 x0.29
 *   - 促销徽章，如 夜间折扣 / 限时免费
 *
 * @param {{id:string, credits?:string, free?:boolean, badges?:string[]}} model
 * @returns {string|null} 徽章文案；无内容时返回 null
 */
export function badgeOf(model) {
  if (!model || typeof model !== 'object') return null
  const parts = []
  if (model.free === true) parts.push('免费')
  const rate = model.credits !== undefined && model.credits !== null && String(model.credits).trim() !== ''
    ? String(model.credits).trim()
    : ''
  if (rate !== '' && !/^x?0(\.0+)?$/i.test(rate)) parts.push(rate)
  const badges = Array.isArray(model.badges) ? model.badges.filter(Boolean).map(String) : []
  for (const b of badges) {
    if (parts.indexOf(b) === -1) parts.push(b)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * 去掉 name 里可能被拼进的徽章后缀。
 *
 * 历史遗留：本模块的 join 分隔符曾被写成中文，导致下游把
 * 「x0.29 · 夜间免费」当成模型名的一部分。现在分隔符统一为 ' · '，
 * 这里按同一个分隔符裁剪，保证 name 永远是纯模型名。
 *
 * @param {string} raw
 * @returns {string}
 */
export function baseModelName(raw) {
  const s = String(raw || '')
  const i = s.indexOf(' · ')
  return i === -1 ? s.trim() : s.slice(0, i).trim()
}


/**
 * 全局使用优先级（面板与 README 展示用）。
 * 这是「约定」而非强制排序——DSH 无法跨 provider 交错。
 *
 * 排序依据不是单价，而是「花不花真钱 / 资源可不可再生」：
 *   积分每日免费补充（可再生） < 抵用券（用完就没） < 真钱（花一分少一分）
 *
 * 长任务例外：WorkBuddy 长任务 token 消耗极大（实测单轮 311 万 / 607 万），
 * 付费模型乘以倍率后积分掉得极快，所以长任务走阿里云更划算。
 */
export const GLOBAL_PRIORITY = [
  { rank: 1, target: 'WorkBuddy 免费模型', why: '不花钱，长短任务都能用（hy3；step-5-preview 限免已于 10/25 结束，现按 x0.33 计费）' },
  { rank: 2, target: '阿里云百炼', why: '花抵用券（虚拟钱），长任务 / 大上下文优先' },
  { rank: 3, target: 'WorkBuddy deepseek-v4.1-flash', why: '花免费积分（x0.11），实测 1.68 积分/轮，全天同价，长短任务都划算' },
  { rank: 4, target: '其他 WorkBuddy 模型', why: '按积分倍率与常用度排序' },
  { rank: 5, target: 'DeepSeek 官方账号', why: '花真钱，放最后' },
]

export { TIER_FLASH, TIER_COMMON, TIER_RARE }
