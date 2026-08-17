# 宿主契约：核实过的事实，和它们是怎么被搞错的

这份文件只记**已经出过事**的那些点。每一条都对着实装包核实过，并注明是哪个版本——因为版本本身就是其中一个坑。

写在最前面的一条，其余大半由它派生：

> **404 和「加载失败」在这个宿主里几乎从不报错。** 插件半边加载成功、日志漂亮、面板画得出来，而路由一条都没注册——这是本仓库出现过三次的形态。所以下面每一条都配了「怎么验证」，而不是「应该这样」。

---

## 1. 核服务名要核 composition 解析出的版本

`npm pack @deepseek-ai/<pkg>` 不带版本时解析 **`latest` dist-tag**，而这些包的 `latest` 指向 `0.0.1-rc.x`——**比 `0.1.0-rc.6` 更老的一条线**。

| 包 | `latest` 标签 | **`0.1.0-rc.6`** |
| --- | --- | --- |
| `dsh-host-webserver` | `httpServer` | **`webServer`** |
| `dsh-workspace` | `workspace` | **`workspaceRegistry`** |
| `dsh-session-persistence` | `sessionPersistence` | 同 |
| `dsh-settings` | `settings` | 同 |
| `dsh-credentials` | `credentials` | 同 |
| `dsh-llm` | `llm` | 同 |
| `dsh-commands` | `commands` | 同 |

照着 `latest` 核，**看起来像在对上游核实，实际在对另一个版本核实**。本仓库因此把一个正确的服务名「修」成了错的，面板 404 多了一整轮。

**怎么验证**

```bash
npm pack "@deepseek-ai/dsh-host-webserver@$(该 profile 里 dsh 的版本)"
tar xzf *.tgz && grep -n 'super(ctx, "' package/lib/index.js
```

**更可靠的证据：对同一个 profile 里已经注册的真实路由发请求。** 定位这个 bug 的不是任何 npm 查询，而是一个已加载插件的路由返回 200。**运行中的 composition 永远比 registry 上脱离上下文的包准。**

因此代码里两个名字都接受（`WEB_SERVER_NAMES`、`REGISTRY_NAMES`），新的优先。它们都是真实发行过的名字，不是猜出来的兼容层。

---

## 2. `inject` 只能是数组

`@deepseek-ai/cordis@4.0.1` 的归一化：

```js
if (Array.isArray(inject)) for (const name of inject) result[name] = null;
else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
```

对象是 **`name → intercept config` 映射**，不是 `{ required, optional }`。写成后者等于声明「必需两个分别叫 `required` 和 `optional` 的服务」，插件永远 pending，而 DSH 的启动断言会让**整个宿主起不来**。

**这个版本没有可选依赖。** 每个声明的名字都是必需的。想「有就用、没有也行」，唯一的路是**不声明**，用 `ctx.get(name)`——服务不在返回 `undefined`，不抛，也不需要事先声明。

---

## 3. 两个半边的加载路径完全不同

| | 怎么加载 |
| --- | --- |
| 浏览器半边 | 宿主扫描已装包的 `package.json` → `dsh.client` |
| **宿主半边** | profile 的 `package.json` → `dsh.profile.bundles` → 应用该包的 `cordis.patch.yml` |

**推论：浏览器半边一切正常，完全不能证明宿主半边挂上了。** 本仓库据此误判过一次。

**`cordis.yml` 里永远看不到插件条目。** 它只是基底，插件树是**在内存里**由 bundles 逐层 patch 出来的。去 grep 它是白费功夫（我干过）。

**怎么验证**

```bash
# 组合后的完整插件树
dsh --profile web --dump-config

# 注册在不在 layer 栈里
cat ~/.dsh/profiles/web/package.json   # 看 dsh.profile.bundles
```

`dsh plugin` 每次跑完都会 reconcile：`exportsPatch()` 去 resolve 已装包、读 `dsh.bundle.patch`，**resolve 失败就把条目从 bundles 里摘掉**。所以一次失败的安装可能悄悄注销这个插件。

---

## 4. 嵌套 `ctx.inject` 不是 entry，卡住不报错

`ctx.inject(names, cb)` 内部是 `this.plugin({ inject, apply: cb })`——**它开一个子 fiber**。而 DSH 的 `assertEntriesActivated` 只检查**顶层 entry**。

于是：子 fiber 可以永远 PENDING，顶层 entry 照样报「已激活」，启动零报错，唯一症状是浏览器里的 404。

代码里因此有：等待时打一行日志、十秒没等到打一条警告**并列出这个 context 能看见哪些服务**——两次事故的根因都是「要了个不存在的名字，而对的服务就在旁边」。

---

## 5. 被捕获的异常也得长得像 bug

路由注册包在 try/catch 里，为的是「面板坏了不拖垮宿主」——这个目标是对的。但它曾经把我们自己代码里的一个 `ReferenceError` 变成 `logger.warn` 的一行灰字，**路由缺失了好几周没人发现**。

现在是 `logger.error` 并带 stack。捕获是为了不崩，不是为了不说。

---

## 6. 排查 404 的顺序

按这个顺序走，每一步都能排除一大类：

1. **`dsh --profile web --dump-config | grep <插件>`** —— 条目在不在组合后的树里
2. **profile 的 `package.json`** —— `dsh.profile.bundles` 里有没有
3. **`dsh web` 那个终端的输出** —— 宿主日志只在这里，浏览器控制台一个字都没有
4. **同 profile 另一个插件的路由通不通** —— 区分「只有我们坏」和「整层没生效」
5. **装的是不是新代码** —— `grep` 已安装的 `node_modules/<pkg>/src/*.js`，别信 spec 字符串

---

## 7. 装插件时的两个环境坑

**pnpm 缓存 git spec。** `github:user/repo#main` 这个字符串不变，pnpm 认为不用重拉。**钉 commit SHA** 才能强制更新。

**`dsh plugin` 只是 `spawnSync("pnpm", args, {cwd: profileDir})`**，用 PATH 上的 pnpm，自己不带。如果 shell 里的 pnpm 和 `npx` 环境里解析到的是不同大版本，会撞 `ERR_PNPM_UNEXPECTED_STORE`。**解法是让 dsh 自己去跑 install**（`dsh plugin --profile web install`），这样两边必然是同一个 pnpm；别在那个目录里手敲 `pnpm`。
