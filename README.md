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
| `/cost-tracker/health` | GET | WorkBuddy 账号健康（顺带采样） |
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

## 文件结构

```
dsh-cost-tracker/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert: id=cost-tracker
├── lib/
│   ├── index.js          # 宿主入口：事件 + 结算 + 路由 + 余额
│   ├── pricing.js        # 三平台价目 + 峰谷判定
│   ├── credits.js        # CreditTracker：积分余额差 + 健康检查
│   ├── aliyunCsv.js      # 代金券流水 CSV 解析与校准
│   └── modelOrder.js     # WorkBuddy 四档排序 + 徽章文案
├── client.js             # 前端：内联标签 + 悬停说明
├── icon.svg
├── README.md
└── LICENSE
```

## 版本

- **0.4.0** — 费用挂件（自动注入）；分时段省钱推荐（实时排除不可用模型）；
  记账双档（单轮/当天/当月）；限流标签与悬停恢复倒计时；限额状态持久化
- 0.3.0 — 模型内联标签 + 悬停说明；修复 DeepSeek 余额读取
- 0.2.1 — 移除阿里云 token 计价；新增 `/turns` 明细路由
- 0.2.0 — 三平台记账 + CSV 校准 + 四档排序

## 许可证

MIT
