# dsh-cost-tracker

DeepSeek Harness（DSH）多平台费用追踪插件：**按模型自动切换计费口径**，每轮对话结束结算花费，阿里云抵用券余额校准，并监控 WorkBuddy 账号状态与模型优先级。

## 成本观：先讲清楚「为什么不是按单价便宜排序」

这是本插件最重要的设计前提，写在这里免得日后自己困惑。

三个平台花的**不是同一种钱**：

| 优先级 | 平台 | 花的是什么钱 | 说明 |
|---|---|---|---|
| 第 1 优先 | WorkBuddy 免费模型 | **不花钱** | `hy3`、`step-5-preview`，免费期随时可能变 |
| 第 2 优先 | WorkBuddy `deepseek-v4.1-flash` | **免费积分** | 倍率 x0.11（全场最低之一），积分每日可领约 3K |
| 第 3 优先 | 阿里云百炼 | **虚拟钱** | 抵用券有限，留给 WorkBuddy 上没有的模型（GLM / Kimi / MiniMax） |
| 第 4 优先 | DeepSeek 官方 | **真钱** | 余额约 45 元，花一分少一分 |

**所以优先级不是按单价便宜排序，而是按「花不花真钱 / 可再生不可再生」排序。**

积分是**每日免费补充的可再生资源**，抵用券是**用完就没的有限资源**，真钱是**花一分少一分的资源**。
因此免费模型到期后，先用 WorkBuddy 的付费模型（花积分），再用阿里云（花抵用券），最后才动官方。

用户的目标是：**先把阿里云抵用券花在 WorkBuddy 覆盖不到的模型上，保留 DeepSeek 官方余额**（因为那是真钱）。
因此面板突出显示官方余额与抵用券余额，而不是累计花费。

### 纯看单价，官方在任何时段都更便宜

典型用量（缓存命中 2M、未命中输入 0.1M、输出 0.02M）下的每轮成本对比，单位元/轮：

| 时段 | 阿里云百炼 | DeepSeek 官方 | 更便宜的 |
|---|---|---|---|
| 工作日 9-12、14-18 | 0.76（忙时） | 0.44（高峰） | 官方 |
| 工作日 12-14、18-22 | 0.76（忙时） | 0.22（谷价） | 官方便宜 71% |
| 每天 22-8 | 0.38（闲时） | 0.22（谷价） | 官方便宜 42% |
| 周末全天 | 0.76（忙时） | 0.22（谷价） | 官方便宜 71% |

**结论：纯看单价，官方在任何时段都更便宜；但选择先用阿里云，是因为抵用券不是真钱。**

三家的时段规则差异也很关键：

| 平台 | 峰/谷规则 | 实际效果 |
|---|---|---|
| DeepSeek 官方 | 工作日 9-12、14-18 为高峰；周末与法定节假日全天谷价 | **全天 20 小时是谷价**，仅工作日 4 小时高峰 |
| 阿里云百炼 | 东八区 22:00-次日 8:00 为闲时，其余（含周末与节假日）忙时 | **白天 14 小时（8-22）全是忙时** |
| WorkBuddy | 积分制，无峰谷 | 按积分倍率计费 |

### 价目表（元 / 百万 token，数组为 `[闲时, 忙时]`）

| 平台 | 类型 | 闲时 | 忙时 |
|---|---|---|---|
| DeepSeek 官方 | 缓存命中 hit | 0.02 | 0.04 |
| DeepSeek 官方 | 未命中输入 miss | 1 | 2 |
| DeepSeek 官方 | 输出 out | 4 | 8 |
| 阿里云百炼 | 缓存命中 hit | 0.1 | 0.2 |
| 阿里云百炼 | 未命中输入 miss | 1 | 2 |
| 阿里云百炼 | 输出 out | 4 | 8 |

阿里云与官方的唯一差异是**缓存命中价贵 5 倍**；miss 与 out 相同。

## 功能

### 1. 多平台统一记账

监听会话事件，按 turn 聚合 token，在一轮结束时结算：

```
金额 = cacheRead/1e6 × hit价 + input/1e6 × miss价 + output/1e6 × out价
```

峰谷系数按平台规则取。`reasoningTokens` 已含在 `outputTokens` 内，不重复累加。

`turnAggs` 用 `Map` 按 `sessionId` 分桶，避免多会话并发串账。

### 2. 按模型自动切换计费口径

按 provider 判定平台：

1. `provider` 或 `model` 含 `workbuddy` → WorkBuddy
2. `provider` ∈ {`deepseek-account`, `deepseek`, `deepseek-official`} → DeepSeek 官方
3. `ctx.get('llm').listProviders()` 查该 provider 的 `baseURL` 含 `aliyuncs` → 阿里云
4. 模型名含 `deepseek` 兜底 → 阿里云（本机实际情形）

### 3. WorkBuddy 余额采样与账号异常提醒

每轮对话结束后采样一次积分余额，与上次相减得本轮消耗。

**两种失效情况不报数：**

| 情况 | 处理 |
|---|---|
| 基准过旧（默认超过 30 分钟未采样） | 不报数——否则会把中间时段的消耗都算进来 |
| 余额上升（充值或发放新权益） | 不报数，仅更新基准 |

**健康检查覆盖三种情况**，提醒形式为冒泡提示 + 面板显示，两者都有：

| 状态 | 级别 |
|---|---|
| 未登录 | error |
| 令牌已过期 | error |
| 令牌 3 天内到期 | warn |

### 4. 模型列表优先级排序

#### ⚠️ 先说限制：无法跨 provider 交错排序

DSH 模型选择器**先按 provider 分组，组内保留第三方 catalog 顺序**。

`dsh-client-ui-model-selection` 文档原文：

> Both entries group models by provider, third-party providers retain their catalog order.

因此**做不到**「WorkBuddy 免费模型 → 阿里云 → WorkBuddy flash」这种全局顺序。本插件的落点是：

1. **WorkBuddy 组内四档排序**（产出数据 + 路由）
2. **每个模型的免费状态徽章**（`conversation.input.model.label`）
3. **全局优先级写成本文的使用约定**，实际切换仍需手动选择

#### 用户实际使用顺序（约定）

1. WorkBuddy 免费模型（`hy3`、`step-5-preview`）
2. WorkBuddy 的 `deepseek-v4.1-flash`（花免费积分，倍率 x0.11）
3. 阿里云百炼（花抵用券，留给 WorkBuddy 没有的模型）
4. 其他 WorkBuddy 模型
5. DeepSeek 官方账号（花真钱）

> 积分每日免费补充、可再生；抵用券用完就没；真钱花一分少一分。
> 所以免费模型到期后先用 WorkBuddy 付费模型，再用阿里云，最后才动官方。

#### WorkBuddy 组内四档排序

| 档位 | 模型 |
|---|---|
| 第一档（`free === true`） | `hy3`、`step-5-preview` |
| 第二档（主力） | `deepseek-v4.1-flash` |
| 第三档（其他常用） | `glm-5.3-flash`、`hy3-x`、`space-bunny`、`minimax-m2.7`、`hy4-preview` |
| 第四档（不常用，排最后） | `glm-5.3`、`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、`minimax-m3`、`kimi-k3-1`、`kimi-k2.8-preview`、`kimi-k2.7`、`kimi-k2.6`、`deepseek-v4-pro`、`mimo-v2.6-pro` |

**免费状态实时读 status 接口**，不硬编码免费时间表——免费期会变。

同档内保持 catalog 原序；未登记的新模型追加在末尾。

#### 徽章

每个模型显示：`免费` / 倍率（如 `x0.29`）/ 促销徽章（如 `夜间折扣`、`限时免费`）。

> 注：用户提到的「快速 / 均衡 / 极致」三个名字在 WorkBuddy 模型清单中不存在，本插件不臆造对应关系。

### 5. 阿里云抵用券余额校准

#### 为什么阿里云不做「token 单价反推」

实测阿里云官方代金券流水（552 笔）发现：

- 单笔金额跨 **6 个数量级**（`-0.0002025472` 到 `-25`）
- 余额链条有 **84 处并发断链**（同一秒多笔写入互相覆盖）
- 同一秒多笔、间隔仅数秒——是**流式请求的分段计费**

**阿里云百炼按「请求级 / 分段级」出账，不是 token 级。** 所以按 `token × 峰谷单价` 反推永远对不上实际扣减。

#### 因此阿里云**不做** token 计价

实测阿里云官方代金券流水（552 笔）发现：

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

阿里云百炼按「请求级 / 分段级」出账，且含联网搜索等附加功能费，**token 单价完全推不出真实扣减**。

**所以阿里云只累计 token 用量作参考，余额完全依赖 CSV 校准。**

#### 如何校准

从阿里云控制台「费用与成本 → 明细账单」导出代金券流水 CSV，然后：

```bash
curl -X POST http://127.0.0.1:<port>/cost-tracker/aliyun/calibrate \
  -H 'Content-Type: application/json' \
  -d '{"path": "C:\\Users\\<你>\\Desktop\\xxx_coupon_use_flow.csv"}'
```

或用 `{"csv": "<CSV 原文>"}` 直接传内容。

返回 `spentSincePreviousCalibration` 字段，即两次校准之间的真实消耗——可用来核对账目。

## HTTP 路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/cost-tracker/summary` | GET | 汇总视图（各平台花费、三个余额、健康状态、最近 20 轮） |
| `/cost-tracker/turn` | GET | 最近一轮 |
| `/cost-tracker/health` | GET | WorkBuddy 账号健康（顺带采样） |
| `/cost-tracker/aliyun` | GET | 阿里云抵用券余额视图 |
| `/cost-tracker/aliyun/calibrate` | POST | 用官方 CSV 校准抵用券余额 |
| `/cost-tracker/deepseek-balance` | GET | DeepSeek 官方余额（真钱）；加 `?force=1` 跳过 60 秒缓存 |
| `/cost-tracker/models` | GET | WorkBuddy 模型排序 + 徽章表 |
| `/cost-tracker/reset` | GET | 清空统计（保留阿里云校准基准） |

> 端口不固定（每次启动可能变）。用 `ctx.webServer.getOrigin()` 在宿主侧取，
> 或从 DSH 的 Web GUI 地址栏读取。

`/cost-tracker/summary` 返回示例：

```json
{
  "ok": true,
  "version": 2,
  "totals": { "turns": 12, "costTokenBased": 3.4821, "workbuddyCredits": 46 },
  "byPlatform": {
    "deepseek":  { "turns": 5, "tokens": 1200000, "cost": 1.2 },
    "aliyun":    { "turns": 4, "tokens": 900000,  "cost": 2.2821 },
    "workbuddy": { "turns": 3, "tokens": 210000,  "cost": 0, "credits": 46 }
  },
  "aliyun": {
    "calibratedBalance": 217.9633927594,
    "calibratedAt": "2026-10-19 19:45:55",
    "source": "csv",
    "note": "余额来自 CSV 校准，不做 token 估算；刷新请重新导出代金券流水校准"
  },
  "deepseekBalance": {
    "available": 45.110947,
    "recharged": 22.490029,
    "bonus": 22.620918,
    "currency": "CNY",
    "at": "2026-10-19T11:46:13.379Z",
    "error": null
  },
  "workbuddy": {
    "health": "ok",
    "reason": "ok",
    "account": "abcd1234…",
    "credits": 3954
  },
  "recentTurns": []
}
```

### 三个平台的余额来源

| 平台 | 余额字段 | 性质 |
|---|---|---|
| DeepSeek 官方（真钱） | `available` = `recharged` + `bonus` | **实时真实**，经 `deepseekAccount.getBalance()` |
| 阿里云抵用券（虚拟钱） | `estimatedRemaining` | **CSV 校准 + token 估算** |
| WorkBuddy（免费） | `credits` | **实时真实**，积分余额 |

官方余额**必须把充值钱包与赠金钱包一起看** —— 只看 `value`（充值）会漏掉 `bonusWallets`（赠金），
只登录客户端的账号常常只有赠金。本插件对齐 DSH 自己的账号卡片判据，两边一起求和。

## HTTP 路由（完整）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/cost-tracker/summary` | GET | 汇总视图（各平台花费、三个余额、健康状态、最近 20 轮） |
| `/cost-tracker/turn` | GET | 最近一轮 |
| `/cost-tracker/health` | GET | WorkBuddy 账号健康（顺带采样） |
| `/cost-tracker/aliyun` | GET | 阿里云抵用券余额视图 |
| `/cost-tracker/aliyun/calibrate` | POST | 用官方 CSV 校准抵用券余额 |
| `/cost-tracker/deepseek-balance` | GET | DeepSeek 官方余额（真钱）；加 `?force=1` 跳过 60 秒缓存 |
| `/cost-tracker/models` | GET | WorkBuddy 模型排序 + 徽章表 |
| `/cost-tracker/reset` | GET | 清空统计（保留阿里云校准基准） |

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

- 所有外部调用（读状态、请求路由、调 llm 服务）都包 try/catch，失败不影响 DSH 主流程
- `turnAggs` 用 `Map` 按 `sessionId` 分桶
- 结算函数幂等：同一 session 的桶取不到就跳过，多条触发路径不会重复记账
- 节假日表未覆盖当前年份时，峰谷判定退化为「全谷价」并打日志——宁少算不多算

## 已知限制

| 限制 | 说明 |
|---|---|
| 跨 provider 排序 | DSH 按 provider 分组，无法交错。见「功能 4」 |
| 阿里云余额精度 | token 估算与真实扣减有偏差，需 CSV 校准 |
| `turn/end` 事件不存在 | DSH 0.2.1-rc.2 事件目录无此事件。改用 `session/event` 的 type 分派 + `agent/turn-stopping` 兜底 |
| `workspace.toast` 不可用 | key 域已满。冒泡提醒需另寻 slot（见下方开发注记） |

### 开发注记

`workspace.toast` 的 keyDomain 是固定集合（`archived`、`createFailed`、… 都已被占用），无法注册新 toast kind。冒泡提醒计划改用 `shell.overlay`（list slot，可注册，`order` 控制位置）自绘轻量卡片；同时 `conversation.input.right` 旁挂紧凑余额指示（复用 `dsh-workbuddy-connect` 已有的位置约定，用 `order: 20` 错开它的 `order: 10`）。

## 文件结构

```
dsh-cost-tracker/
├── package.json          # dsh.bundle.patch + dsh.client.inject 声明
├── cordis.patch.yml      # insert: id=cost-tracker, name=dsh-cost-tracker
├── lib/
│   ├── index.js          # 宿主入口：事件监听 + 结算 + 路由
│   ├── pricing.js        # 三平台价目 + 峰谷判定
│   ├── credits.js        # CreditTracker：积分余额差 + 健康检查
│   ├── aliyunCsv.js      # 阿里云代金券流水 CSV 解析与校准
│   └── modelOrder.js     # WorkBuddy 四档排序 + 徽章文案
├── client.js             # 前端：model.label 徽章注入
├── icon.svg
├── README.md
└── LICENSE
```

## 许可证

MIT
