# TokenLedger

> 🚧 **早期开发中**：核心用量折叠与中转站归属已可用且有测试覆盖，账单适配器尚未完成。

> ⚠️ **非官方声明**：TokenLedger 是独立的第三方社区项目，与 DeepSeek 无隶属、赞助或背书关系。「DeepSeek」及相关商标归其权利人所有。

**统计 DeepSeek Harness 的 Token 消耗，并和 New API、Sub2API 中转站的实际扣费对账。**

用量统计本身在 DSH 生态里已经有几十个实现。TokenLedger 存在的理由是它们都缺的那一半：**你的用量记录里没有「这笔钱花在哪个中转站」，所以永远对不上中转站的账单。**

## 它解决什么问题

你在两个中转站买了 `deepseek-v4` 的额度。月底一个站说你花了 ¥47，另一个说 ¥89。你手里有 DSH 的会话日志，但日志里只有 provider 路由名和模型名，没有站点身份——你无法回答「这 ¥89 里有多少是我真的发出去的请求」。

TokenLedger 把 `(中转站, Provider, 模型)` 作为一等维度记录下来，再去读两个站自己的账单 API，把两边并排放，并**明确标注这次比对的证据等级**：

| 等级 | 含义 |
|---|---|
| `request` | 有共享的请求标识，能一一对应 |
| `aggregate` | 按站点、模型、时间窗聚合比对 |
| `summary` | 站点只暴露累计额度/余额，无法细分 |

只有汇总数据时，界面不会假装是 `request` 级。估算费用、站点扣费、钱包余额、内部额度单位是四种不同的事实，永远不会被静默相加或换算。

## 现在能用的部分

```js
import { foldUsage, bySite, byModel } from "tokenledger";
import { RelaySiteRegistry, createSiteResolver } from "tokenledger/relay-sites";

const registry = new RelaySiteRegistry([
  { id: "nine", type: "newapi",  baseUrl: "https://api.relay-one.example/v1" },
  { id: "sub",  type: "sub2api", baseUrl: "https://api.relay-two.example" },
]);

// DSH 的 provider 路由 → 它配置的 Base URL
const resolveSite = createSiteResolver(registry, {
  relayA:   "https://api.relay-one.example/v1/chat",
  official: "https://api.deepseek.com",
});

const days = foldUsage(sessionEvents, { resolveSite });

bySite(days);            // 按中转站汇总——对账用的 DSH 侧数字
byModel(days, {}, "nine"); // 只看某个站的模型分布
```

## 三个别人会做错的地方

这三条都有测试覆盖（`test/usage.test.js`），也是照抄现成实现时最容易漏的：

**1. 请求失败了照样扣费。** 用量除了挂在 `assistant/message` 上，也会从 `assistant/chunk` 的 `{type:'usage'}` 流出。请求在报出 usage 之后失败，就永远等不到 `assistant/message`——但供应商已经收钱了。只订阅 `assistant/message` 会系统性少算这部分，而这恰恰是账单看起来偏高时最需要解释的部分。

**2. 同一个 `(turn, step)` 会被报告两次。** 后来的样本是**替换**前一个，不是累加。而且替换时必须从**原先归属的那一天和那条路由**里减回去——跨天、跨增量折叠边界时尤其容易错。

**3. 孤儿 usage chunk 不带任何身份。** `assistant/message` 在 `message.source` 里自带 provider 和 model，但 `StreamChunk` 的 usage 变体只有 `{type:'usage', usage}`。所以失败请求的那条记录必须回退到最近一次 `request/header` 归因，且要认得 `reason: 'resume'`（进程重启会重发 header，那不是换模型）。归不上的记为显式 `unknown`，绝不猜。

另外：`inputTokens`、`cacheReadTokens`、`cacheWriteTokens` 三个桶互斥，相加才是计费输入（DSH 的适配器已经把 DeepSeek `prompt_tokens` 里的缓存命中减出去了）；`reasoningTokens` 是 `outputTokens` 的子集，只做展示，加进总数就是重复计费。

## 中转站身份

站点用 **Base URL 的精确 origin** 识别，不从模型名猜。归属在**折叠时**就写死进记录——改了某个 provider 的 Base URL 只影响之后的调用，历史归属永不重写。

凭证只存引用，不存值；需要区分同一域名下的多把 key 时用不可逆指纹（`credentialFingerprint`）打标签。API Key 不进 URL、不进日志、不进用量行、不进诊断报告——查询串会漏进浏览器历史和反代日志，比 Authorization 头容易泄露得多。

## 状态

共 **63 个测试**，零运行时依赖（SQLite 用 Node 内置的 `node:sqlite`）。

| 模块 | 状态 |
|---|---|
| 用量折叠（双事件源 / 替换语义 / 路由归因） | ✅ |
| 中转站注册表与 origin 归一化 | ✅ |
| 区间 / 按模型 / 按站点查询 | ✅ |
| SQLite 汇总索引（按会话分行）与全量重建 | ✅ |
| 增量 checkpoint、跨重启折叠等价性 | ✅ |
| 费率表（生效日期 / 分桶计价 / 峰谷时段） | ✅ |
| 费用估算（未定价返回 null 而非 0） | ✅ |
| CSV / JSON 导出与索引诊断 | ✅ |
| New API 适配器（余额 / 聚合 / 请求级 + 扣费复算） | ✅ |
| Sub2API 适配器 | ⬜ |
| 对账引擎（三级证据） | ⬜ |
| DSH 插件封装与 Web UI 页面 | ⬜ |

### New API 适配器的实测结果

对一个真实运行的 New API 站点验证过（2026-08-14，只读）：**1960 条消费记录，全部能用记录自带的比率独立复算出扣费，0 条无法解释。**

```
按计费约定匹配：openai 1415 · anthropic 535 · 仅兜底 10
请求级合计 quota 14,504,892  ==  聚合端点合计 14,504,892（两个独立端点互证）
```

复算公式（比率全部来自记录本身）：

```
quota = round( (有效输入 + 输出×completion_ratio) × model_ratio × group_ratio )
```

「有效输入」正是坑所在——**同一个站点存在两种语义**：OpenAI 系的 `prompt_tokens` **包含**缓存，Anthropic 系的**不含**且缓存创建单独计价。用错约定会算出**负数**。

路线见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 开发

```bash
npm test      # node --test，无运行时依赖
```

## 许可与致谢

MIT。`src/usage.js` 的折叠逻辑改编自 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)（MIT），详见 [`NOTICE`](NOTICE)。

本项目脱胎于已归档的 [LanternDesk](https://github.com/zh667/LanternDesk)——那是一次桌面外壳尝试，放弃的原因写在这里：DSH 里所有值得做的能力都能做成插件，而插件做不到的部分（装包、拉进程、托盘）没有区分度，且原厂随时会补。
