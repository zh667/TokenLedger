# TokenLedger

[![License](https://img.shields.io/badge/license-MIT-2da44e)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.6-1f6feb)](https://github.com/deepseek-ai/deepseek-harness)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Token 用量算清楚，并归属到**实际服务这次请求的中转站**——不用配置，不用凭据。

Token-usage accounting for the DeepSeek Harness Web GUI (`dsh web`), attributed
to the relay site that served each request. Zero configuration.

![TokenLedger 面板](docs/images/panel.png)

> 展示图使用演示数据与本机模拟中转站；面板上的每个数字都由真实代码路径算出，只是数据是造的。插件不会把 API Key 或上游原始响应发送到浏览器。

## 一眼看懂 / At a glance

| | 能力 | 说明 |
| --- | --- | --- |
| 🎯 | **中转站归属** | 按 provider 的 `baseURL` 归一化 origin 分组——同一站的多把 key 合成一行，站名就是域名，不是你自己起的路由别名 |
| 🔍 | **零配置发现** | 从宿主的 provider 配置里读出中转站，不用你再填一遍。只读 `baseURL`，绝不碰旁边的凭据 |
| 💳 | **余额** | DeepSeek 官方、New API、Sub2API，每个账户一把普通 key 即可；不限额度的 key 报"已用"而不是假余额 |
| 📊 | **用量分析** | 今日/本月/累计三窗口、按站点/模型下钻、缓存命中率、一年活跃度热力图（悬停看当天模型构成） |
| 🧮 | **费用估算** | 生效日期分段的费率表、分桶计价、峰谷时段；未定价的模型显示破折号而不是 0 |
| 🗂 | **导出与诊断** | CSV / JSON 导出，索引健康度，归因不上的行数单独列出 |
| 🔒 | **只读回环** | 两个端点仅接受回环 GET，且在 peer socket 地址上设防；从不读取提示词、工具参数或响应内容 |

## 快速安装 / Quick start

需要 DeepSeek Harness `web` profile（`@deepseek-ai/dsh >= 0.1.0-rc.6`）。

```bash
dsh plugin --profile web add "github:zh667/TokenLedger"
```

重启已经在跑的 `dsh web`，浏览器硬刷新。侧边栏底部会出现「用量账本」入口。

升级或卸载：

```bash
dsh plugin --profile web update dsh-tokenledger
dsh plugin --profile web remove dsh-tokenledger
```

装完即可用：没有要填的配置，也不需要任何凭据就能看到全部用量与中转站分布。余额是唯一用到 key 的地方，而那把 key 宿主已经替你存着了。

## 命令 / Commands

面板能回答的问题，命令行都能回答——两边读的是同一批查询，不存在第二套聚合。

```bash
/tokenledger                      # 全部时间
/tokenledger 7                    # 最近 7 天
/tokenledger 30 api.example.com   # 某个中转站，最近 30 天

/tokenledger site                 # 列出发现到的中转站
/tokenledger site add <路由名> <地址>
/tokenledger site rm <路由名>

/tokenledger export csv 30        # 导出
/tokenledger diagnostics          # 索引健康度
/tokenledger reindex              # 丢弃索引，从头重建
```

## 支持的账户类型 / Providers

| Provider | 模式 | 凭据 | 上游接口 |
| --- | --- | --- | --- |
| DeepSeek 官方 | 余额 | provider 的 `apiKeyEnv` | `/user/balance` |
| New API 系（含 One API、VoAPI 等分支） | 额度 | provider 的 `apiKeyEnv` | `/api/usage/token/` + `/api/status` |
| Sub2API | 余额 | provider 的 `apiKeyEnv` | `/v1/usage` |
| Moonshot / Kimi | 余额 | provider 的 `apiKeyEnv` | `/v1/users/me/balance` |
| 智谱 GLM / Z.ai | 余额 | provider 的 `apiKeyEnv` | `/api/paas/v4/balance` |
| OpenRouter | 余额 | **Management Key** | `/api/v1/credits` |

除 OpenRouter 外都只需要一把**普通 API key**——就是你已经配给那条路由、用来发请求的那把。OpenRouter 的额度接口只认 Management Key，用推理 key 会 401，面板会直接说明要哪一把，而不是丢一个 401 让你去查一把本来没问题的 key。

中转站跑的是哪套程序由路由指纹自动判定，第一次查余额时探测一次并记住。厂商自己的域名不需要探测——origin 直接决定用哪套读法，而且同一厂商的多条路由会合并成一个账户（一个钱包），这跟中转站正好相反。

New API 的额度是**按 key** 的：同一个站上两把 key 是两份额度，面板分别列出。

## 配置 / Configuration

**通常不需要任何配置。** 中转站从宿主的 provider 设置里读出来。

需要覆盖时，写进你已有的 `settings.yaml`（改完热更新，不用重启）：

```yaml
tokenledger:
  # 只在自动发现看不到时才需要——比如组合里没挂 settings 服务，
  # 或 provider 是 agent preset 在 agent.cordis.yml 里挂的
  relays:
    my-route: https://relay.example.com/v1

  # 费率表，用于费用估算；不配就显示破折号，不会猜
  rates: []

  # 探测中转站跑的是哪套程序。默认关闭，第一次查余额时会自动探一次
  fingerprint: false
```

## 正确性与数据口径 / Correctness

用量折叠有三个地方容易错，都有测试覆盖（`test/usage.test.js`）：

**请求失败了照样扣费。** 用量除了挂在 `assistant/message` 上，也会从 `assistant/chunk` 的 `{type:'usage'}` 流出。请求在报出 usage 之后失败，就永远等不到 `assistant/message`——但供应商已经收钱了。只订阅 `assistant/message` 会系统性少算这部分。

**同一个 `(turn, step)` 会被报告两次。** 后来的样本是**替换**前一个，不是累加；替换时必须从**原先归属的那一天和那条路由**里减回去。

**孤儿 usage chunk 不带身份。** `assistant/message` 自带 provider 和 model，`StreamChunk` 的 usage 变体没有。失败请求那条记录要回退到最近一次 `request/header`，且要认得 `reason: 'resume'`（进程重启会重发 header，那不是换模型）。归不上的记为显式 `unknown`，绝不猜。

口径上：`inputTokens`、`cacheReadTokens`、`cacheWriteTokens` 三个桶**互斥**，相加才是计费输入；`reasoningTokens` 是 `outputTokens` 的**子集**，只做展示，加进总数就是重复计费。天按**宿主进程的本地时间**切分，面板上会标出是哪个时区。

归属在**折叠时**写死进记录，历史永不重写。中转站集合发生变化时会丢弃索引并全量重建——否则新认出的站会显示成"你刚开始用它"。

## 隐私与安全 / Privacy & security

- **从不读取内容。** 只有计数和标识符：token 数、模型名、provider 路由名、站点域名。提示词、工具参数、响应正文既不读也不存。
- **凭据只在宿主侧。** key 由宿主的 credentials 服务按引用（`apiKeyEnv`）在请求时解析、用完即弃，始终走 `Authorization` 头，绝不进 URL 查询串。浏览器永远拿不到 key。
- **回环防护。** 两个 HTTP 端点注册为 exact 路由，因此位于 RPC 信任边界**之外**，处理器自己设防：拒绝非 GET，并同时校验 **peer socket 地址**（不可伪造）与 Host 头。
- **中转站指纹识别不用凭据**，靠路由的 404/401 特征。

## API

浏览器面板读这两个端点，仅限回环 GET：

| 端点 | 说明 |
| --- | --- |
| `GET /api/tokenledger/usage?days=&site=` | 整个面板的数据：三窗口合计、按天/模型/站点、一年活跃度与逐日模型构成、账户列表、索引诊断 |
| `GET /api/tokenledger/balance?account=` | 某个账户的余额 |

包也可作为库使用，供 DSH 之外的消费者：

```js
import { foldUsage, bySite, byModel } from "dsh-tokenledger";
import { LedgerStore } from "dsh-tokenledger/store";
import { readBalance } from "dsh-tokenledger/balance";
```

## 开发 / Development

```bash
npm test          # 含浏览器半边——它能在 Node 里被物化和测试
npm pack --dry-run
```

浏览器半边**没有构建步骤**：它是一个手写的 `__ModuleLoader__` bundle，React 由宿主作为 peer 提供，样式手写注入。因此它能在 Node 里被加载和测试。

## 致谢 / Credits

- 热力图的分位数分级与悬停详情参考 [`xiufengsun/TokenTracker`](https://github.com/xiufengsun/TokenTracker)（MIT）
- New API 的计费口径读自 [`QuantumNous/new-api`](https://github.com/QuantumNous/new-api) 源码

## 友情链接 / Links

感谢 [LINUX DO](https://linux.do/) 社区的帮助与支持。

*Thanks to the [LINUX DO](https://linux.do/) community for their help and support.*

<details>
<summary>DSH 生态 / The DSH ecosystem</summary>

**宿主 / The host**

- [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) —— 本插件运行其上的 agent harness

**插件索引 / Where to find plugins** —— 这几处收录了社区插件，装之前值得先逛一圈

- [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— 按功能分类的中英双语列表
- [`AdamPlatin123/awesome-dsh-plugins`](https://github.com/AdamPlatin123/awesome-dsh-plugins) —— 自动扫描 `dsh-plugin` topic，带兼容性状态列
- [`0xsline/awesome-deepseek-harness`](https://github.com/0xsline/awesome-deepseek-harness) —— 人工精选，另有自动生成的 `CATALOG.md`
- [`bruc3van/awesome-dsh-plugin`](https://github.com/bruc3van/awesome-dsh-plugin) —— 场景导航、入门套装与热度榜

**这个面板读得懂的上游 / Upstreams this panel reads**

- [`QuantumNous/new-api`](https://github.com/QuantumNous/new-api) —— 中转站程序；面板的额度换算口径是从它的路由与计费源码里读出来的

</details>

> ⚠️ **非官方声明**：TokenLedger 是独立的第三方社区项目，与 DeepSeek 无隶属、赞助或背书关系。以上友链亦不代表任何隶属、赞助或背书关系。「DeepSeek」及相关商标归其权利人所有。

## License

[MIT](LICENSE)
