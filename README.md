# dsh-cost-tracker

DeepSeek Harness（DSH）多平台费用追踪插件：**按模型自动切换计费口径**，每轮对话结算花费，
三个平台余额统一呈现，并给 WorkBuddy 模型加档位与促销标签。

## 成本观：为什么不是按单价排序

三个平台花的**不是同一种钱**：

| 优先级 | 平台 | 花的是什么钱 | 适用场景 |
|---|---|---|---|
| 第 1 | WorkBuddy 免费模型 | **不花钱** | `hy3`、`step-5-preview`，长短任务都能用 |
| 第 2 | 阿里云百炼 | **虚拟钱**（抵用券） | **长任务 / 大上下文优先**，100 万上下文 |
| 第 3 | WorkBuddy 付费模型 | **免费积分**（每日可再生） | 短对话 |
| 第 4 | DeepSeek 官方 | **真钱** | 最后才用，花一分少一分 |

**优先级按「花不花真钱 / 资源可不可再生」排序，不是按单价。**

积分每日免费补充、可再生；抵用券用完就没；真钱花一分少一分。

### 一个必须记住的实测结论

WorkBuddy 长任务 token 消耗极大（实测单轮 311 万 / 607 万 token）。
付费模型倍率一乘，积分掉得极快。所以：

- **长任务 → 阿里云**（抵用券够用；或 `step-5-preview`，免费且 100 万上下文）
- **短对话 → WorkBuddy 付费模型**（花积分，不心疼）

### 三个平台的时段规则不同

| 平台 | 规则 | 实际效果 |
|---|---|---|
| DeepSeek 官方 | 工作日 9-12、14-18 高峰；周末与法定节假日全天谷价 | 全天 20 小时是谷价，仅工作日 4 小时高峰 |
| 阿里云百炼 | 东八区 22:00-次日 8:00 闲时，其余忙时 | 白天 14 小时（8-22）全是忙时 |
| WorkBuddy | 积分制，**每个模型自己声明促销时段与折扣** | 不能用统一规则套 |

> ⚠️ **重要**：WorkBuddy 的折扣是「按模型 + 时间窗」声明的
> （源码里是 `discount.schedule` / `discount.factor`），**不能套用 DeepSeek 官方峰谷**。
> 比如「非高峰 5 折」只对 `deepseek-v4.1-flash` / `deepseek-v4-pro` 成立，
> `space-bunny` 没有这个规则。本插件只显示上游给出的 `credits` 与 `badges`，不跨模型套规则。

#### 价目表（元 / 百万 token，数组为 `[闲时, 忙时]`）

| 平台 | 缓存命中 hit | 未命中输入 miss | 输出 out |
|---|---|---|---|
| DeepSeek 官方 | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| 阿里云百炼 | 0.1 / 0.2 | 1 / 2 | 4 / 8 |

两者唯一差异是**缓存命中价贵 5 倍**；miss 与 out 相同。

## 功能

### 1. 多平台统一记账

监听会话事件，按 turn 聚合 token，一轮结束时结算：

```
金额 = cacheRead/1e6 × hit价 + input/1e6 × miss价 + output/1e6 × out价
```

`reasoningTokens` 已含在 `outputTokens` 内，不重复累加。

#### 结算触发：为什么不用 `turn/end`

DSH 0.2.1-rc.2 的事件目录里**没有 `turn/end`**。本插件用双保险：

1. **主路径**：`session/event` 里按 `event.type` 分派（含 turn + end/stop/finish 字样即结算）
2. **兜底**：`agent/turn-stopping`（语义是「本轮即将收尾，模型不会再回复」）

结算函数幂等：同一 session 的桶取不到就跳过，两条路径都触发也只记一次账。

`turnAggs` 用 `Map` 按 `sessionId` 分桶，避免多会话并发串账。

### 2. 按模型自动切换计费口径

按 provider 判定平台：

1. `provider` 或 `model` 含 `workbuddy` → WorkBuddy（积分制，不做 token 计价）
2. `provider` ∈ {`deepseek-account`, `deepseek`, `deepseek-official`} → DeepSeek 官方
3. `ctx.get('llm').listProviders()` 查 `baseURL` 含 `aliyuncs` → 阿里云
4. 模型名含 `deepseek` 兜底 → 阿里云

### 3. WorkBuddy 余额采样与账号健康

每轮结束后采样积分余额，与上次相减得本轮消耗。

**两种失效情况不报数：**

| 情况 | 处理 |
|---|---|
| 基准过旧（默认超过 30 分钟未采样） | 不报数——否则会把中间时段消耗都算进来 |
| 余额上升（充值或发放新权益） | 不报数，仅更新基准 |

**健康检查三种状态：**

| 状态 | 级别 |
|---|---|
| 未登录 | error |
| 令牌已过期 | error |
| 令牌 3 天内到期 | warn |

`refresh()` 只更新快照、**不推进基准**——避免「看一眼健康状态」就吃掉上一轮的结算基准。

### 4. 模型列表标签（前端半身）

#### 先说限制：无法跨 provider 交错排序

DSH 模型选择器**先按 provider 分组，组内保留第三方 catalog 顺序**
（`dsh-client-ui-model-selection` 文档原文：
"Both entries group models by provider, third-party providers retain their catalog order."）。

所以做不到「WorkBuddy 免费 → 阿里云 → WorkBuddy flash」的全局顺序。
本插件只能在 WorkBuddy 组内做标签与排序。

#### 标签显示

模型列表里每个 WorkBuddy 模型显示 **模型名 + 若干标签**：

```
Hy4 preview         [常 用] [夜 间 免 费]
Hy3                 [免 费] [额 度 限 制]
Step-5-Preview      [免 费]
Deepseek-V4.1-Flash [主 力] [夜 间 折 扣]
GLM-5.2             [常 用] [夜 间 折 扣]
Kimi-K3-1           [少 用]
```

**档位**（四档，高饱和实心块）：

| 档位 | 颜色 | 含义 |
|---|---|---|
| 免费 | 深绿 `#15803d` | `free === true` |
| 主力 | 深蓝 `#1d4ed8` | `deepseek-v4.1-flash` |
| 常用 | 深橙 `#b45309` | `glm-5.3-flash`、`space-bunny`、`minimax-m2.7`、`hy4-preview` |
| 少用 | 深灰 `#4b5563` | 其余 |

**促销标签**：来自上游 `badges`（实时，不硬编码免费时间表）

**夜间折扣**：`deepseek-v4.1-flash` / `deepseek-v4-pro` 上游不给 badge，
按官方峰谷规则本地推算，每分钟重算——非高峰显示 `夜 间 折 扣`，高峰显示 `高 峰 原 价`

**额度限制**：`hy3`（每日赠额，用尽后转付费）

**限流标记**：被限流/额度用尽的模型直接显示红底「限 流」标签，
不用悬停也能一眼看出不能用；悬停显示精确恢复时间 + 每秒跳动的倒计时。

#### 悬停说明

鼠标悬停模型项，在**模型列表右侧外层**显示两行：

```
┌──────────────────────────────────┐
│ 0.29x 倍率                        │
│ 9月11日–10月31日，每晚 23:00—      │
│ 次日 8:00 享免费额度。             │
└──────────────────────────────────┘
```

位置固定在列表右边界外，**不跟随鼠标、不遮挡列表**。
深色底（`#1f2937`）+ 白字，18/20px，与浅色列表强对比。

#### 只在模型选择列表生效

内核 `renderModelLabel` 有三个 `placement` 取值，本插件严格区分：

| placement | 位置 | 本插件行为 |
|---|---|---|
| `trigger` | 主界面输入框的当前模型名 | **原样返回，完全不改动** |
| `menu` | 折叠层的当前模型名 | **原样返回** |
| `option` | 下拉列表里的模型项 | 加标签 + 悬停说明 |

代码里就一行守卫：`if (placement !== 'option') return rawName`

#### 两条硬性约束（踩过的坑）

**1. 返回空字符串会吞掉模型名。**
内核是 `renderSlot(slot, props, { fallback: model.name })`——
只有返回 `null`/`undefined` 才用 fallback。返回 `''` 会被当成有效内容，模型名就没了。
本组件所有分支都保证返回非空。

**2. 不能吞掉模型项的鼠标事件。**
选择动作依赖 click 冒泡，标签一律 `pointerEvents: none`。

**3. 浮层必须 portal 到 body。**
模型列表容器是 `position: fixed; overflow: hidden`，
插在列表项内部的内容会被裁掉或顶开下面的模型项。

### 5. 阿里云抵用券：为什么不做 token 计价

实测阿里云官方代金券流水（552 笔 + 189 笔）发现：

- 单笔金额跨 **6 个数量级**（`-0.0002025472` 到 `-25`）
- 余额链条有 **84 处并发断链**（同一秒多笔写入互相覆盖）
- 同一秒多笔、间隔仅数秒——是**流式请求的分段计费**

**决定性对比**（2026-10-19 19:43 那轮，`provider=fufu`）：

| 项 | 数值 |
|---|---|
| token 用量 | in=203, cache=470,272, out=475 |
| token × 忙时单价（手算） | **0.09826 元** |
| 阿里云实际扣减（CSV） | **2.611903 元** |
| 偏差 | **26.6 倍** |

阿里云按「请求级 / 分段级」出账，且含联网搜索等附加功能费，
**token 单价完全推不出真实扣减**。

**所以阿里云只累计 token 用量作参考，余额完全依赖 CSV 校准。**

#### 如何校准

从阿里云控制台「费用与成本 → 明细账单」导出代金券流水 CSV，然后：

```bash
curl -X POST http://127.0.0.1:<port>/cost-tracker/aliyun/calibrate \
  -H 'Content-Type: application/json' \
  -d '{"path": "C:\\path\\to\\xxx_coupon_use_flow.csv"}'
```

或用 `{"csv": "<CSV 原文>"}` 直接传内容。

返回的 `spentSincePreviousCalibration` 即两次校准之间的真实消耗，可用来核对账目。

#### 阿里云百炼 deepseek 模型的官方参数与峰谷

2026-10-24 向阿里云客服确认（此前是自己实测误判）：

| 项 | 官方值 |
|---|---|
| 上下文窗口 | **1,048,576**（1M） |
| 最大输出 `max_tokens` | **393,216** |
| 适用模型 | `deepseek-v4.1-flash`、`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813` |

**峰谷规则**（百炼平台，与 DeepSeek 官方规则不同，别混用）：

| 时段 | 时间（北京时间） | 价格 |
|---|---|---|
| 忙时（峰期） | **08:00–22:00** | 原价 |
| 闲时（谷期） | **22:00–次日 08:00** | 谷价 |

对比 DeepSeek 官方：工作日 09:00–12:00、14:00–18:00 高峰，其余谷价（含周末与法定节假日全天）。**两套规则互不适用。**

⚠️ **踩坑记录**：曾观察到「输入 57 万 → 输出 1 token」并触发「已达到输出 token 上限」，
据此把 `contextWindow` 误配成 262144（256K）。真实原因是 **`max_tokens` 未配置**，
导致 DSH 不放开发送上限，长回答被压低——与窗口大小无关。
正确做法：`contextWindow: 1048576` + `maxTokens: 393216` 两个都显式声明。

另注：`deepseek-v4-pro`（无版本后缀）未采用峰谷定价。

### 6. DeepSeek 官方余额（真钱）

经 `deepseekAccount.getBalance()` 读取，**实时真实**。

```json
{
  "available": 40.00,
  "recharged": 20.00,
  "bonus": 20.00,
  "currency": "CNY",
  "error": null
}
```

**必须把充值钱包与赠金钱包一起看** —— 只看 `value`（充值）会漏掉 `bonusWallets`（赠金），
只登录客户端的账号常常只有赠金。本插件对齐 DSH 账号卡片的判据，两边一起求和。

> ⚠️ **实现要点**：`ctx.get('deepseekAccount')` 只能取到**当前注入作用域内可见**的服务。
> 放在 `apply(ctx)` 顶层调用会返回 `undefined`。必须单独开
> `ctx.inject(['deepseekAccount'], cb)` 作用域，在该作用域内取。
> 但**绝不能把 `deepseekAccount` 写进 `inject` 数组**——老宿主没这个服务时，
> 整个插件会永远等不到服务而完全不 apply。

### 7. 费用挂件（widget.js，自动注入页面）

固定 230px 宽的深色小卡片，通过 `webserver/index-inject` 的**内联 script 行**
注入到 DSH 页面（不能用 script-src：加载失败会 reject `__DSH_BOOT_READY__`
让整个应用起不来——dsh-whale-widget issue #154 的教训）。

```
┌────────────────────────────┐
│ 💰 费用                  ▾ │
├────────────────────────────┤
│ ● DeepSeek    ¥40.37       │  真钱
│ ● 阿里云券    ¥XXX.XX      │  抵用券
│ ● WorkBuddy   XXXX 积分    │
│ ────────────────────────── │
│ 单轮 #96       免费        │
│ 今天 8 轮   ¥0.10 / 3 积分 │
│ 本月 60 轮  ¥3.07 / 43 积分│
│ ────────────────────────── │
│ 💡 当前 xxx 消耗积分，      │
│    yyy 现在免费，切过去更省 │
│ ────────────────────────── │
│ 非高峰时段                  │
│ 1. GLM-5.3-Flash           │
│ 2. Space-Bunny             │
└────────────────────────────┘
```

- **记账双档**：单轮费用 + 当天/当月（北京时区自然日/月），阿里云不参与
- **主动建议**：红（当前模型不可用）/ 黄（有更省的）/ 绿（已最优）
- 可折叠、可拖动、位置记 localStorage；四边按卡片实际尺寸钳制，不会拖出界面
- 数据 60 秒自动刷新

### 8. 分时段省钱推荐（lib/recommend.js）

回答两个问题：**现在用哪个最省？首选不能用了换谁？**

- 按当前时段计算每个模型的**实际倍率**（含夜间免费/夜间折扣/官方峰谷 5 折）
- 排序：可用免费 > 实际倍率 > 思考成本（同倍率下默认思考低的优先）> 常用度
- **实时排除**：限流中的模型直接淘汰；免费额度用尽的按付费替代倍率（x0.05）参与排序
- 上下文过滤：长文场景（≥90 万）自动淘汰装不下的模型
- 峰谷判定复用 pricing.js（含周末 + 法定节假日全天谷价），本模块不自己实现
- 时段标签四类：工作日高峰 / 工作日非高峰 / 周末 / 法定节假日

**限额状态必须持久化**（`state.limits`）：内存标记一重启就丢，
用户标记的「额度用尽」会失效——实测教训。变更即写盘，启动即恢复。

**手动标记接口**（上游 status 不返回限额数据时的兜底）：

```bash
curl -X POST http://127.0.0.1:<port>/cost-tracker/model-state \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy3","state":"exhausted","hours":12}'
```

### 9. 等待审批 / 回答 的提示音与气泡

**问题**：Agent 执行到需要审批（工具调用确认）或结构化提问时会**静默阻塞**。
如果你离开电脑，完全不知道流程卡在那里，任务就一直停着。

**做法**：监听两个 Host 事件，记录「正在等待什么」，前端轮询后响铃 + 弹常驻气泡。

```
Agent 停下等审批
  ↓
Host 监听 approval/request / user-questions/request
  ↓ 记录 kind + title + detail，seq++，然后立刻 next() 放行
  ↓
GET /cost-tracker/pending  ← 前端每 8 秒轮询
  ↓ 发现 seq 变大 → 响提示音 + 弹气泡
```

**⚠️ waterfall 事件必须放行。** `approval/request` 和 `user-questions/request`
都是 **waterfall** 模式，监听器必须调用 `next()`，否则整条审批链会挂起，
Agent 永远等不到结果。所以这里只做「记录状态」，绝不拦截、不修改结果：

```js
disposers.push(ctx.on('approval/request', (req, next) => {
  try { pendingGate.note('approval', req) } catch { /* 记录失败不影响审批 */ }
  return next()   // ← 必须放行
}))
```

**用 `seq` 而不是时间戳去重。** `seq` 是单调递增计数器，前端记住上次见到的值，
变化了就是**新的**等待。比时间戳可靠——同一毫秒内多次请求也不会漏。

**10 分钟自动过期。** 后端拿不到「用户已处理」的可靠信号（waterfall 只给了
`next()` 的返回值，无法区分批准/拒绝），所以等待状态 10 分钟后自动失效，
避免气泡永久挂在屏幕上。

**提示音独立开关 `pendingSoundOn`（默认开）。** 消费气泡的提示音（`soundOn`）
默认关着，避免突然发声；但审批提醒是**告警**性质——用户离开电脑时正是最需要
它响的时候，不能因为关掉了消费提示音就一起静音。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `pendingSoundOn` | `true` | 等待审批时是否响一声（独立于 `soundOn`） |
| `soundVol` | `0.3` | 音量 0–1（两者共用） |
| `soundKind` | `'ping'` | 音色：`ping` / `coin` / `soft`（共用） |

**气泡样式**：琥珀底 + 加粗黄框 + 明确指引，与「本轮消耗」「省钱建议」气泡
视觉区分，且常驻不自动消失（带 × 手动关闭）：

```
┌──────────────────────────────────────┐
│ ⏸ 需要审批：bash                      │
│   rm -rf /tmp/build                   │
│   请回到对话窗口处理                    │
│                                  [×]  │
└──────────────────────────────────────┘
```

**已知限制**：浏览器自动播放策略要求页面先有过一次用户交互（点一下页面），
否则首次提示音可能被静默拦截。

## 配置（通用化）

插件开箱即用（内置一份默认模型清单），但**每个人的模型、倍率、常用度都不同**。
在你的 `cordis.patch.yml` 的 cost-tracker 行下加 `config:` 覆盖：

```yaml
- insert:
    - id: cost-tracker
      name: dsh-cost-tracker
      config:
        # 遵循「工作日 9-12/14-18 高峰原价、其余谷价」的模型
        peakModels: [deepseek-v4.1-flash, deepseek-v4-pro]
        # 每日赠额型模型（额度用尽转 429/付费）
        quotaModels: [hy3]
        # 推荐排序的同分优先项
        preferred: [deepseek-v4.1-flash, glm-5.3-flash]
        # 标签档位
        tiers:
          main: [deepseek-v4.1-flash]
          common: [glm-5.3-flash, space-bunny]
        # 促销时间窗说明（可选；不配则悬停显示上游 badge 原文）
        promoDesc:
          hy4-preview: 每晚 23:00—次日 8:00 享免费额度（以官方公告为准）。
```

不配置也能跑：内置清单作为开箱示例；但推荐排序与档位标签
只对示例清单准确，**按自己的实际情况覆盖才有意义**。
## HTTP 路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/cost-tracker/summary` | GET | 汇总（各平台花费、三个余额、健康、最近 20 轮） |
| `/cost-tracker/ledger` | GET | 记账：单轮费用 + 当天/当月双档（仿小鲸鱼；阿里云不参与） |
| `/cost-tracker/session` | GET | 本次会话花费（按 session 聚合） |
| `/cost-tracker/turn` | GET | 最近一轮 |
| `/cost-tracker/turns` | GET | 每轮消耗明细（`?limit=50&platform=workbuddy`） |
| `/cost-tracker/health` | GET | WorkBuddy 账号健康（顺带采样）+ 前置插件状态 |
| `/cost-tracker/dependency` | GET | 前置插件（WorkBuddy 连接插件）探测状态；`?force=1` 跳过 60 秒缓存 |
| `/cost-tracker/pending` | GET | 等待用户操作（审批/提问）的状态；`seq` 变化即有新等待 |
| `/cost-tracker/aliyun` | GET | 阿里云抵用券余额视图 |
| `/cost-tracker/aliyun/calibrate` | POST | 用官方 CSV 校准抵用券余额 |
| `/cost-tracker/deepseek-balance` | GET | 官方余额；`?force=1` 跳过 60 秒缓存 |
| `/cost-tracker/recommend` | GET | 分时段省钱推荐（实时排除限流/额度用尽的模型） |
| `/cost-tracker/model-limits` | GET | 模型倍率、上下文、思考强度、限流状态 |
| `/cost-tracker/models` | GET | WorkBuddy 模型排序 + 徽章表 |
| `/cost-tracker/model-state` | POST | 手动标记额度用尽/清除（上游不提供限额数据时的兜底） |
| `/cost-tracker/reset` | GET | 清空统计（保留阿里云校准基准） |
| `/cost-tracker/widget.js` | GET | 页面挂件脚本（由插件自动注入，无需手动访问） |

端口每次启动可能变，用 `ctx.webServer.getOrigin()` 取，或看 Web GUI 地址栏。

### 三个平台的余额来源

| 平台 | 字段 | 性质 |
|---|---|---|
| DeepSeek 官方（真钱） | `deepseekBalance.available` | 实时真实 |
| 阿里云抵用券（虚拟钱） | `aliyun.calibratedBalance` | CSV 校准 |
| WorkBuddy（积分） | `workbuddy.credits` | 实时真实 |

## 限流与上下文溢出

监听 `agent/request-error`，识别两类上游错误：

| 错误 | 识别 | 展示 |
|---|---|---|
| `400 client`「内容过长」 | 正则匹配 | 详情里标「上次因内容过长失败」 |
| `429 soft_rate` | 正则 + 解析报文里的重置时间 | 显示「免费恢复：X 小时 Y 分」倒计时 |

`hy3` 额度用尽后 WorkBuddy 会转到 `hy3-x` 按 x0.05 计费
（DSH 侧不会自动切换，客户端才有这个行为）。

## 安装

### 前置依赖（必装）

本插件的 **WorkBuddy 相关功能依赖 WorkBuddy 连接插件**，必须二选一先装好：

| 插件 | 说明 |
|---|---|
| `dsh-connect-workbuddy` | **推荐**。新版，5.x 系列 |
| `dsh-workbuddy-connect` | 旧版，0.7.x 系列 |

缺少它时：WorkBuddy 积分、模型清单、倍率、省钱推荐全部不可用（面板顶部会显示安装指引）。
阿里云 / DeepSeek 官方的轮次与 token 统计不受影响。

> DSH 没有声明式插件间依赖机制，所以本插件在**运行时探测**该前置插件
> （`GET /cost-tracker/dependency`），并在缺失时给出明确提示。

### 安装本插件

```bash
dsh plugin --profile desktop add link:<本插件目录的绝对路径>
```

装完重启客户端。

## 数据与隐私

| 项 | 说明 |
|---|---|
| 状态文件 | 只写 `$DSH_HOME/.cost-tracker.json` |
| 代码内容 | 无用户名路径、无账号 uid/uin、无 token、无 API Key |
| 账号标识 | 输出前脱敏，只保留前 8 位 |
| WorkBuddy status | 走本机回环，只校验 Host/Origin 为回环，不需要会话凭据 |
| CSV 解析 | 只输出统计量，不保留账号名 |

## 健壮性

- 所有外部调用（读状态、请求路由、调 llm / deepseekAccount 服务）都包 try/catch
- `turnAggs` 用 `Map` 按 `sessionId` 分桶
- 结算函数幂等，多条触发路径不会重复记账
- 节假日表未覆盖当前年份时，峰谷判定退化为「全谷价」并打日志——宁少算不多算

## 已知限制

| 限制 | 说明 |
|---|---|
| 跨 provider 排序 | DSH 按 provider 分组，无法交错 |
| 模型描述 / 免费时段 | `dsh-workbuddy-connect` 的 status 接口不返回这两项；国内版不解析 `modelPromotions`，所以截图里 WorkBuddy 客户端的促销时间窗文字在 DSH 侧拿不到 |
| 阿里云余额精度 | token 估算与真实扣减有偏差（26.6 倍），只用 CSV 校准 |
| `turn/end` 不存在 | 用 `session/event` 分派 + `agent/turn-stopping` 兜底 |
| `workspace.toast` 不可用 | key 域已满，冒泡提醒需改用 `shell.overlay` |
| hy3 自动转付费 | `dsh-workbuddy-connect` 没实现，429 直接报错；上游参数名未知，未擅自猜测 |
| 限流状态依赖插件探测缓存 | 自身只在「请求失败」时记录限流，**重启即丢**。现从 `$DSH_HOME/.workbuddy-pool.cn.json` 同步（启动时 + 每 5 分钟），该文件缺失或插件未探测时退回失败事件记录 |
| `advice` 换模型提示 | 必须用 `effectiveRate()` 的**实际倍率**比较；当前模型实际免费时**绝不**提示切到付费模型（硬约束） |
| `dsh-connect-workbuddy` 未登录 | 账号池返回 401 时全部功能不可用，面板顶部显示「缺少前置插件」指引（`/cost-tracker/dependency`） |
| 上游 badge 用词不准 | WorkBuddy 给 deepseek 系模型的 badge 是「夜间折扣」，但官方规则是**峰谷**（工作日 9-12/14-18 高峰原价，其余谷时 5 折）。本插件在 `credits.js` 解析阶段就剔除该 badge，避免误导 |

## 开发注意事项（踩过的坑）

**改 UI 前先确认渲染者。​** 2026-10-23 排查「deepseek 显示夜间折扣」时，我假设标签由本插件渲染，在 `client.js` 反复修改、升版本号、清 Electron 缓存，始终无效；最终发现那个标签来自 DSH 内置插件 `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`，正确做法是在 `cordis.patch.yml` 里 `disabled: true`。​判断方法：看 DOM 里是否同时出现本插件的档位标签（`免费/主力/常用/重型`），没有就说明渲染者不是本插件。​

**改 client.js 必须升 `package.json` 的 version。​** DSH 的 clientModules 按包名缓存 bundle，`lib/*.js`（宿主侧）改完重启即生效，但 `client.js` 只认版本号变化——不升版会持续加载旧 bundle，症状是「改了什么都没反应」。​

**多个插件同时注册同一 slot 会互相干扰。​** `conversation.input.model.label` 是 single slot，本插件用 `priority: -10` 遮蔽原生渲染；若与其他插件冲突，先查对方是否也注册了同一 slot（`ctx.slots.inject` 的 key）。​

**比倍率时两边必须同基准。​** 2026-10-23 23:53 实测（夜间）：hy4 `free=true rate=0 discount=夜间免费生效中`，deepseek `rate=0.055`。但 `advice` 说「hy4（x0.29）比 deepseek（x0.055）贵」——因为旧代码用 `cur.credits`（上游**原始倍率**）比 `best.rate`（**时段折算后**的实际倍率）。修复：当前模型也走 `effectiveRate()`，并加硬约束「当前模型实际免费时，绝不提示切到付费模型」。​

**状态类信息优先从权威来源同步，别只靠自己攒。​** 限流标记原本只在「请求失败」时写，重启即丢——导致明明还在限流的 deepseek 被当可用，继续推荐给用户（2026-10-23 实测）。插件自己有权威探测结果：`$DSH_HOME/.workbuddy-pool.cn.json` 的 `probes.<accountId>` 明确记录 `outcome / modelId / retryAtMs`。直接采信它，启动 + 定时同步，比重放失败事件可靠得多。​

**归因优先级：`p.model` 优先。​** 用户先用 hy4 发一条、秒切 deepseek 后收到 429，旧逻辑兜底取「会话内最近跑过的模型 = hy4」，把 deepseek 的限流记到 hy4 头上（实测 `probe hy4 → ok`，真正限流的是 deepseek）。`agent/request-error` 的 payload 对应**本次**请求，`p.model` 就是真正在跑的模型。顺序：`p.model` → 错误文本里的模型名 → 最近跑过的。​

**别用互斥条件做「全局错误」过滤。​** 旧代码写 `&& !/soft_rate|429|频率限制/` 来排除正常限流，结果真正的池级限流（`code 6004` + `soft_rate` + 「池中已无可用账号」）被整个放过。池级特征应**单独一条规则**优先匹配，而不是用否定式互斥。​

**别用观察推断替代官方参数。​** 2026-10-24：观察到「输入 57 万 token → 输出 1 token」就断定上下文窗口不够，把阿里云 `deepseek-v4.1-flash` 的 `contextWindow` 从 1M 改成 256K——结果长对话照样触发「输出 token 上限」。真实原因是 `max_tokens` 根本没配。向客服确认后：窗口是 1M、最大输出 393,216，两个都得显式声明。**先问官方，再改配置**；观察到的现象往往有多个可能解释。​

## 文件结构

```
dsh-cost-tracker/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert: id=cost-tracker
├── lib/
│   ├── index.js          # 宿主入口：事件 + 结算 + 路由 + 余额
│   ├── pricing.js        # 三平台价目 + 峰谷判定
│   ├── credits.js        # CreditTracker：积分余额差 + 健康检查 + 前置插件探测
│   ├── aliyunCsv.js      # 代金券流水 CSV 解析与校准
│   ├── modelOrder.js     # WorkBuddy 四档排序 + 徽章文案
│   └── recommend.js      # 分时段省钱推荐引擎（重型模型降权 + 适用场景）
├── client.js             # 前端：内联标签 + 悬停说明 + 气泡
├── widget.js             # 页面挂件脚本
├── icon.svg
├── README.md
└── LICENSE
```

## 版本

- **0.5.5** — `advice` 改用实际倍率比较（当前模型实际免费时绝不提示切到付费）；
  新增从插件探测缓存同步限流状态（`.workbuddy-pool.cn.json`），解决重启后
  限流丢失导致继续推荐已限流模型；失败归因改为 `p.model` 优先（修复秒切模型后
  限流记到上一个模型）；账号池级限流不再归因到单个模型
- **0.5.4** — 等待审批/回答时响提示音 + 弹常驻气泡（监听 `approval/request`
  与 `user-questions/request`，新增 `/cost-tracker/pending` 轮询接口，
  独立开关 `pendingSoundOn` 默认开）
- **0.5.3** — 数据源头剔除「夜间折扣」badge（deepseek 系改显示峰谷状态）；
  新增「重型」标签与倍率放大排序（高单次消耗模型不再排在低价模型前）；
  推荐算法按真实消耗数据重排档位；模型适用场景正面描述（基于公开评测）；
  记账区阿里云不显示折算金额；气泡堆叠修复
- **0.5.2** — 前置插件探测；版本号修正（DSH clientModules 缓存键）
- **0.5.1** — 新增前置插件探测与安装指引（缺 WorkBuddy 连接插件时明确提示）；
  记账三组分开展示；阿里云不再显示折算金额（只统计轮次）；
  省钱建议改为常驻气泡 + 手动关闭；修复全局报错误标单模型限流
- **0.5.0** — 适配 `dsh-connect-workbuddy` 5.x 的新 `/usage` 接口结构；
  额度用尽改按次日 00:00 重置；限流优先级最高
- 0.4.0 — 费用挂件（自动注入）；分时段省钱推荐（实时排除不可用模型）；
  记账双档（单轮/当天/当月）；限流标签与悬停恢复倒计时；限额状态持久化
- 0.3.0 — 模型内联标签 + 悬停说明；修复 DeepSeek 余额读取
- 0.2.1 — 移除阿里云 token 计价；新增 `/turns` 明细路由
- 0.2.0 — 三平台记账 + CSV 校准 + 四档排序

## 许可证

MIT
