# TokenLedger

> 🚧 **早期开发中**：已作为 DSH 插件在真实 DSH 中跑通全链路；界面尚未完成，也未发布 npm。

> ⚠️ **非官方声明**：TokenLedger 是独立的第三方社区项目，与 DeepSeek 无隶属、赞助或背书关系。「DeepSeek」及相关商标归其权利人所有。

**统计 DeepSeek Harness 的 Token 消耗，并归属到实际服务这次请求的中转站——不用配置，不用凭据。**

用量统计本身在 DSH 生态里已经有几十个实现。TokenLedger 存在的理由是它们都缺的那一维：**你的用量记录里没有「这笔花在哪个中转站」。**

## 它解决什么问题

你在两个中转站买了 `deepseek-v4` 的额度。月底一个站说你花了 ¥47，另一个说 ¥89。你手里有 DSH 的会话日志，但日志里只有 provider 路由名和模型名，没有站点身份——你答不出「这 ¥89 对应我发出去的多少 token」。

TokenLedger 把 `(中转站, Provider, 模型)` 作为一等维度记录下来。中转站身份不需要你告诉它：**你在 DSH 的 provider 设置里填过一次 Base URL，那份配置宿主自己就能交出来**，插件读到之后按 origin 分组，域名就是站名。

> **关于账单对账**：仓库里有一套能读 New API / Sub2API 账单并复算扣费的引擎，用 1960 行真实消费记录验证过（0 条无法解释）。但它**目前只是库函数，没有接到配置上，普通用户用不了**——而且 New API 的逐请求消费日志是管理员接口，现实中只有站主能读。所以它不是本插件的主线功能，详见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 现在能用的部分

```js
import { foldUsage, bySite, byModel } from "dsh-tokenledger";
import { RelaySiteRegistry, createSiteResolver } from "dsh-tokenledger/relay-sites";

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

bySite(days);            // 按中转站汇总
byModel(days, {}, "nine"); // 只看某个站的模型分布
```

作为插件跑的时候上面这段不用写：`resolveSite` 由 `discovery.js` 从宿主的 provider 配置直接推出来。这个库入口是给 UsagePlane 这类外部消费者用的。

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

共 **152 个测试**。运行时依赖只有一个：`@deepseek-ai/schemastery`（108 KB，用来声明 settings 命名空间）。SQLite 用 Node 内置的 `node:sqlite`。

（早期版本宣称「零运行时依赖」，现在不成立了，撤回。曾想声明成可选 peer 靠 DSH 那份，但 pnpm 不会自动装可选 peer，能不能解析到取决于提升策略——赌不起，就自己带一份。`dsh-settings` 的 `resolve()` 只是 `schema(value)` 一个普通调用，没有 `instanceof` 检查，所以多一份副本不会出问题。）

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
| 中转站软件指纹识别（零凭证） | ✅ 默认关闭，见下 |
| **中转站自动发现**（读宿主 provider 配置，零配置） | ✅ |
| `/tokenledger site add\|rm\|list`（不用改文件） | ✅ |
| 接真实 DSH 会话日志 | ✅ 已端到端验证 |
| DSH 插件封装（`dsh.bundle` + Cordis 行） | ✅ 已在真实 DSH 里跑通 |
| `/tokenledger` 报表命令 | ✅ |
| New API 适配器（余额 / 聚合 / 请求级 + 扣费复算） | ⚠️ 库函数可用，**未接到配置** |
| Sub2API 适配器（余额 / 累计 / 双费用口径） | ⚠️ 库函数可用，**未接到配置** |
| 对账引擎（证据等级 / 拒绝不可比） | ⚠️ 库函数可用，**用户无法触达** |
| 侧栏面板 | ⬜ 见下 |
| 发 npm / 提交索引收录 | ⬜ |

那三条 ⚠️ 之前标的是 ✅。引擎本身确实是 ✅，但 `collectReconciliations` 读的是 `config.billing[站点id]`——一个**函数**的映射，YAML 里写不出来，只有测试能注入；`NewApiClient` / `Sub2ApiClient` 在插件路径里一次都没有被构造。所以对真实用户来说这个功能是不通的，标 ✅ 属于失实。

### 界面为什么还没做

**设置页里那张插件配置卡片：进不去。** `dsh-host-apiproxy` 用一个硬编码的七项白名单（`agent-loop`、`shell`、`locale`、`permission`、`ui-conversation`、`ui-theme`、`web-search-deepseek`）决定哪些 settings 命名空间能下发给浏览器，其余一律 `settings-not-exposed`。上游自己把改法记为待办：

> Moving that declaration to `settings.register()`, so a plugin can expose its own configuration without a change in this package, is deferred work.

注意这只挡**浏览器**那条 settings RPC。宿主侧的 `ctx.settings.get/register/update` 不受影响——自动发现和 `/tokenledger site` 正是靠它做到的。

**侧栏入口：能做，故意先不做。** 位置是 `sidebar.footer.action`（齿轮旁边那一排，`list` 插槽，目前只有一个占用者），面板挂 `shell.overlay`，抄 `dsh-client-ui-cordis` 十来行就能注册。代价是要带一个 React 浏览器半边、约 6 个 `@deepseek-ai/dsh-client-*` peer 依赖、一条本包现在没有的打包链，以及一块零测试覆盖的表面；还有一个没查清的点：第三方插件怎么注册自己的 RPC 给面板取数。

顺序上先把命令行这边补完整，再给一个完整的能力加入口，而不是给半截功能加壳。

### 作为 DSH 插件安装

```bash
dsh plugin --profile web add github:zh667/TokenLedger
```

**就这一条。** `dsh plugin` 转发给 pnpm；因为本包声明了 `dsh.bundle`，DSH 会自动把它登记进该 profile 的 `dsh.profile.bundles`，bundle patch 随即自动挂载插件行——不需要改 `package.json`，也不需要手写任何 YAML。

**装完就行，没有第二步。** 中转站是自动发现的：

```js
ctx.llm.listConfigurableProviders()   // 每条 provider 路由的配置存放位置
ctx.settings.get(那个命名空间)         // 沿 settingsPath 走到 profile，取 baseURL
```

按 origin 分组，域名就是站名。**profile 里紧挨着 `baseURL` 的那个凭据引用一个字节都不读**——只取 `baseURL` 这一个字段，站点记录本身也拒收 `apiKey` / `token`，两道。

识别中转站跑的是 New API 还是 Sub2API（`detectRelaySoftware`，零凭据）**默认关闭**：它唯一的用途是挑选账单适配器，而账单已后置，开着就是对第三方发六个没人读的请求。要开：

```yaml
tokenledger:
  fingerprint: true
```

想看发现到了什么：

```
/tokenledger site
```

有两种情况自动发现覆盖不到：组合里没挂 settings 服务；或者 provider 是 agent preset 在 `agent.cordis.yml` 里挂的（那种注册不了 settings 命名空间）。这时手动补一条，也不用开文件：

```
/tokenledger site add <路由名> <地址>
```

路由名是 `dsh-llm-pi-ai` 的 `config.providers` 下的键名，也就是每条 assistant 消息上 `AssistantProvenance.provider` 的值——上面 `site list` 会把已知的路由列出来给你抄。

要写进文件也可以，`settings.yaml` 里加一段（改了热更新，不用重启）：

```yaml
tokenledger:
  relays:
    my-route: https://relay.example.com/v1
```

手动配置是**覆盖**，优先级高于自动发现——你会写它，正是因为自动那份不对。要改站名或站点类型就用长形式：

```yaml
tokenledger:
  relays:
    my-route:
      baseUrl: https://relay.example.com/v1
      id: my-label
      type: sub2api
```

> 归属是在**折叠时**写死进记录的，历史永不重写。所以中转站集合发生变化时，插件会丢弃索引并全量重建——否则报表会显示这个站「从被认出来那一刻才开始有流量」，读起来像是你刚开始用它。

卸载：`dsh plugin --profile web remove dsh-tokenledger`。

采集器**扫描**而不是订阅：`listSnapshots()` 的 revision 让未变动的会话零成本跳过，`readFrom(id, seq)` 只读尾部。订阅会把这段代码放进请求热路径，而且插件没运行时写入的一切会永久丢失——重启后静默少算。扫描是幂等且自愈的。

**任何失败都是采集器的问题，不是 DSH 的**：日志损坏、数据库锁住、上游改形状，全部降级成计数 + 一条日志 + 跳过该会话。记账值得做，但不值得让一轮对话失败。

### Windows 实测（2026-08-14）

在一台 Windows 机器上装好后第一次运行，用户此前无任何会话历史：

```
── 用量 ────────────────────────────────────────
  全部时间 · 中转站：全部

  47,085 tokens      — 估算      3 请求
  █

  模型               输入           缓存   输出  估算
  deepseek-v4-pro  27,492  18,560(40.3%)  1,033     —

  中转站分布
  直连/官方  47,085
```

这一次验证了三件开发阶段无法验证的事：DSH 带着插件能在 Windows 上启动；**`/tokenledger` 会被真实 Web UI 派发**（headless 不派发命令，所以命令注册这条路径此前从未端到端跑过）；`node:sqlite` 在 Windows 上可用。等宽表格的 CJK 列宽在 PowerShell 里也是对齐的。

顺带印证了一个设计选择：那台机器的会话日志并不在 `$DSH_HOME/sessions`。采集器走 `sessionPersistence` API 而不是猜路径，所以它照样读到了。

### 端到端实测（2026-08-14，真实会话 + 真实中转站）

不是 fixture：一次真实的 agent 对话，真实扣费。

```
1. detect      api.<relay> -> newapi (confidence 1)      零凭证
2. fold        真实会话日志 -> input=10119 output=26 requests=1
3. relay       扣费 8991 quota（¥0.131269）
               用它自己的比率复算 = 8991，delta=0
4. reconcile   level=aggregate，token 差额全为 0
               扣费 ¥0.1312686 vs 估算 ¥0.131263（+0.000006）
```

最有价值的一条：**替换规则在真实流量上生效了**。同一个 `(turn, step) 1/1` 被报告了两次——一次在 `assistant/chunk`，一次在 `assistant/message`——折叠后 `requests: 1` 而不是 2。这是普通的一轮对话，不是边缘情况。**任何只订阅一个来源、或者把两个来源相加的实现，在这里就已经错了。**

另外发现一个坑：会话日志是 **zstd 多帧拼接**（每次 flush 一帧）。单次 `zstdDecompressSync` 只解第一帧然后静默返回一小部分——一个 11.9 KB 的文件看起来只有一行。直接读文件的实现必须按 `28 B5 2F FD` 帧头逐帧解。**更好的做法是根本别直接读文件**，走 `sessionPersistence.readFrom()`。

### 对账引擎：重点是拒绝，不是相减

算出一个差额很容易，难的是知道**什么时候这个差额是证据，什么时候它只是把两种根本不同的度量摆在一起的产物**。四条规则：

**等级取两侧较弱的那个。** DSH 侧永远是按天、按模型、按站点；中转站可能粗得多。而 `request` 级目前对任何站都不可达——DSH 的会话日志不记录供应商的 request id，所以就算站点给了也没法逐笔 join。

**累计数回答不了带时间窗的问题。** 只报生涯累计的站，不能拿去跟"最近 30 天"比——那等于让它为窗口之前的每一笔请求背锅。这种组合直接返回 `comparable: false`，除非 DSH 侧也是全量。

**币种绝不换算。** 估算是 CNY、扣费是 USD，那是两个事实；编一个汇率去相减，等于伪造用户来查的那个数。

**缺失的值是 `null` 不是 `0`。** 零是一个测量结果。

还有一条给报表的：**混合报表取最弱等级**，否则一个只有 summary 的站会被当成已验证的看。

### 为什么是「每种软件一个适配器」，不是每个站点一个

**站点身份来自 Base URL，不是 key**——key 只证明你有权调用。而**能拿到什么账单数据**取决于这个站跑的是哪套软件。

中转站有成千上万个，中转站**程序**只有几种。所有跑 New API 的站都答 `/api/status`、都用内部 quota 单位；所有 Sub2API 都答 `/v1/usage`、都用真实货币。一个适配器覆盖该软件的全部部署，所以适配器数量跟的是**软件生态**，不是站点列表。而且这些程序很多互为分叉（One API → New API → VoAPI…），共享路由，一个适配器常能覆盖一整支。

识别不需要凭证——**不存在的路由答 404，存在的答 401**：

```
端点                Sub2API   New API
/api/status           404       200
/v1/usage             401       404
/api/usage/token      404       401
/api/log/self         404       401
```

两组实测签名完全可分。不认识的站点也能用，只是少一半：`detectRelaySoftware()` 报 `unknown`，对账降级为只有 DSH 侧数字——**用量统计照常，只是没得比**。绝不会把不认识的站硬套进已知适配器：用 New API 的 quota 换算去读 Sub2API 的余额，会得到一个自信的错数，比诚实的空白更糟。

### 两个站的账单形状差多少

| | New API | Sub2API |
|---|---|---|
| 金额单位 | 内部 `quota` 整数，要查 `/api/status` 换算 | 真实货币，`unit: "USD"` |
| 粒度 | 请求级日志 | 只有 today + 累计 |
| prompt token | **含**缓存（OpenAI 口径） | **不含**缓存（和 DSH 一致） |
| 是否暴露比率 | 是，扣费可独立复算 | 否 |
| 费用字段 | 一个 | **两个**——`cost` 与 `actual_cost` |

最后一行是实测里最要命的：同一批流量 `cost: 0.33138075`、`actual_cost: 0.231966525`，**差 30%**。一个是标价一个是实扣，合并成"费用"要么虚报要么把折扣藏掉。两个都原样带出，交给对账层决定问的是哪一个。

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
