# dsh-ssh-guard

> **非官方下游分支。** 面向 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 的 SSH 插件，
> 基于上游 `@linxin666/dsh-ssh`（Apache-2.0）加装两处加固：**主机身份守卫**与**池内连接预算**。
> 本项目**只新增，不修改上游已有逻辑的语义**；改动集中在
> `lib/hostkey-guard.js`（新增）、`lib/conn-budget.js`（新增）、`lib/index.js`（接线）。

## 三个名字的关系（先看这张图）

```
上游 npm 包        @linxin666/dsh-ssh @ <version>          ← 原料（Apache-2.0）
        │  vendored 进本仓库 upstream\<version>\
        │  + patch\ 里的增量补丁
        ▼
本仓库 / 装配线     仓库名 = dsh-ssh-guard                  ← 车间（本仓库就是它）
        │  npm run assemble（our/apply.mjs，五道断言）
        ▼
分发的插件包        包名 = dsh-ssh-guard                    ← 成品（dist/ → link: 挂载）
                   版本 = <上游版本>-guard.1
```

**仓库名 = 包名 = `dsh-ssh-guard`。** 唯一会出现上游包名的地方是**归属声明**
（`FORK.json` 的 `basedOn`、`package.json` 的元数据、本文档）—— 这是许可证要求，不是命名不一致。

挂进 profile 后一眼能看出挂的是哪一份：包名带 `guard`，版本带 `-guard.1` 后缀。

## 这两处加固解决什么问题

| 功能 | 缺口 | 加固 |
|---|---|---|
| **主机身份守卫**（host-key fail-closed） | 插件不校验服务器身份（不读 `known_hosts`、无 `hostVerifier`）→ 比它替代掉的系统 OpenSSH **水位更低**，可被中间人冒充 | 读 `~/.ssh/known_hosts` 逐台比对：命中放行；**不匹配 → 拒连并打印新旧指纹（绝不自动更新）**；**无记录 → 拒连**。新主机只能经 `DSH_SSH_HOSTKEY_ALLOW_NEW=1` 显式落库到 `$DSH_HOME/dsh-ssh-hostkeys.json` |
| **池内连接预算**（并发 / 速率 / 新建连接闸门） | 预算原先**只写在外层包装脚本**里 → 直接调 `ssh_exec` / `ssh_cluster` / GUI **全绕过**（多子代理同时冲同一台机器 → 触发 fail2ban 或重试风暴） | 下沉进插件本体：全局并发 4 / 每主机 2 / 每主机 60 次每分 / 新建连接最小间隔 5s / 排队上限 120s，任何调用方都绕不过 |

两个模块的设计原则：**要么排队复用同一条连接，要么明确失败** —— 不"再开一条"，也不静默降级。

## 安装到 DSH

> **为什么仓库里没有 `dist/`（成品）？** 本仓库是**装配车间**：`dist/` 是构建产物，内含
> `node_modules` 与**指向你本机 DSH 安装树**的符号链接（第 5.5 步），因此既不该入库、
> 也不可能对每台机器通用。请按下面对应的路线安装。

### 路线 A：从源码构建 + 本地挂载（当前唯一自足的方式）

```bash
git clone https://github.com/0embsd/dsh-ssh-guard
# 或：从本仓库页面右上角 Code 按钮复制地址（fork 后请换成你自己的地址）
cd dsh-ssh-guard
npm run assemble        # 需要 Node 22+；第 5.5 步会链接你本机的 DSH 宿主包
npm run smoke           # 推荐：自动建临时档验证「能装、能加载」
dsh plugin --profile <你的档> add link:$PWD/dist
```

`dsh plugin … add` 会**同时**把依赖写进 `dependencies`、并把包名登记进 `dsh.profile.bundles`（已实测），
所以这一条命令就够。装完**重启该档的 DSH**，侧边栏即出现「SSH」入口。

> ⚠️ 若该档里已装了别的 SSH 插件（如同名工具集的 `dsh-ssh-ops`，或上游 `@linxin666/dsh-ssh`），
> 必须先移除/禁用其中一个 —— 同名工具重复注册会让整个 profile 起不来。

### 路线 B：从 npm 安装（**尚未发布**）

```bash
dsh plugin --profile <你的档> add dsh-ssh-guard
```

这是对使用者最省事的方式，但需要先把这个包**发布到 npm**（见「自动化」的 L3）。
**这就是现在还没有"一行安装命令"的原因** —— 不是忘了写文档，而是发布这一步还没做。

### 路线 C：GitHub Release 附件（不需要 npm 账号）

由 GitHub Actions 构建 `dist/` 并打成 tar.gz 挂到 Release；使用者下载解包后：

```bash
dsh plugin --profile <你的档> add link:<解包目录>
```

（需要一个 release 工作流来启用，见「自动化」。）

**已实测的更好做法（推荐用于路线 C）**：Release 里放的是 **`npm pack` 出来的 `.tgz`**（不是在解包目录上 `link:`），
使用者一条命令装：

```bash
dsh plugin --profile <你的档> add file:<下载路径>/dsh-ssh-guard-<版本>.tgz
```

**为什么 tgz 比 `link:` 好**：tgz 会被 pnpm 解到**该档自己的** `node_modules/.pnpm/`，真实路径仍在档内 →
ESM 能向上解析到 `profiles/node_modules/@deepseek-ai/dsh-tools`，所以 **CI 模式（`--no-host-link`）产出的包也能直接装**，
不需要任何人本机装配。实测（`0.3.22-guard.1`）：安装成功 → 真启动 → `GET /api/dsh-ssh/hosts` 返回 **200**。

> ⚠️ **从 npm/tgz 安装的必需前提**：它会**真的去装运行期依赖**（`ssh2` / `cpu-features` 带构建脚本），
> 而 pnpm 默认不信任构建脚本 → 报 `ERR_PNPM_IGNORED_BUILDS`。该档的 `pnpm-workspace.yaml` 需要：
>
> ```yaml
> allowBuilds:
>   cpu-features: true
>   ssh2: true
> ```
>
> （官方 profile 本来就有这两行；本仓库的冒烟档也照此写。`link:` 路线不需要，因为它不装依赖 ——
> 这也正是「从 npm 装」与「`link:` 装」的一个真实差别。）

### 与上游安装方式的对照（为什么两边不一样）

上游 `@linxin666/dsh-ssh` 的 README 给的是：

```sh
# npm（推荐）
dsh plugin --profile web add @linxin666/dsh-ssh@latest
# 从仓库（开发）
git clone https://github.com/zhu1090093659/dsh-web.git && cd dsh-web
pnpm install && pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-ssh
```

对照如下 —— **路线结构其实一样（npm / 从仓库两条），差别只在"成品在哪"**：

| | 上游 | 本仓库 | 原因 |
|---|---|---|---|
| **npm 路线** | ✅ 有 | ⏳ 待发布（路线 B） | 上游把**预构建**的 `lib/**` 打进 npm 包（`files` 字段），装完即用；我们的产物必须先"装配"（打补丁+改名+摘遥测） |
| **从仓库路线** | `pnpm -r build` → `add link:packages/dsh-ssh` | `npm run assemble` → `add link:dist` | 上游是 **monorepo**，`packages/dsh-ssh` **本身就是可挂载包**（package.json 带 `main`/`exports`/`dsh.bundle.patch`）；我们是**单插件改造层**，仓库根是工具链（`private: true`，没有那些字段），可挂载的是**产物 `dist/`** |
| **为什么要构建** | 只是把 TS 编译成 JS | 还要打补丁、改名、摘遥测 | 我们的产物 ≠ 上游产物 |
| **要不要宿主链接** | 不需要 | `link:` 时需要；**npm/tgz 时不需要** | ESM 按**真实路径**解析：`link:` 的真实路径在档外，向上永远到不了 `profiles/node_modules` |
| **发布形态** | npm 包内含构建产物 | `dist/` 不入库（含机器相关链接，无法通用） | 见本节开头说明 |

**一句话**：上游发布的是"**装好的整机**"，我们目前提供的是"**车间 + 图纸 + 装配线**"；
把 `dist` 发到 npm（路线 B）或做成 Release 的 `.tgz`（路线 C），使用者体验就能和上游**完全一致**。

### 安装冒烟测试（一条命令）

**"装配能跑"不等于"装得上"** —— 装配产物再漂亮，若挂载路径、包名或宿主链接有一处不对，
用户装上去就是加载失败（与"验收脚本从未跑过"同型的风险）。所以本仓库把它做成可重复的一条命令：

```bash
npm run smoke
```

它会在一个**临时档**里走完真实安装路径：建档 → `dsh plugin … add link:<dist>` → 核对链接与包身份
→ **真启动一次**（`--port 0 --no-open`）→ 再**打插件自身的路由** `/api/dsh-ssh/hosts` 确认
**插件真的被加载**（只验"服务器起来了"会假绿）→ 杀进程树 → 删除临时档。加 `--keep` 保留临时档便于排查。

## 装配（从源码构建 `dist/`）（开发者；使用者请看上面的「安装到 DSH」）

```bash
git clone <本仓库> ~/.dsh/tools/dsh-ssh-guard
cd ~/.dsh/tools/dsh-ssh-guard
npm run assemble        # 产出 dist/（行尾前置门禁 + 五道断言 + 依赖自包含）
npm test                # 回归：21 hostkey + 20 budget
```

可选参数：`--repo-url <你的仓库地址>` `--author <你的名字>`（写入 `dist/package.json` 的归属字段；
不传则**删掉**上游遗留的 `repository` 指向）；`--version <上游版本>`；`--no-assert`（升级专用）。

## 挂载到 DSH profile

profile 的 `package.json` 里用 `link:` 指向本仓库的 **`dist/`**，并把包名登记进 `dsh.profile.bundles`：

```jsonc
{
  "dependencies": {
    "dsh-ssh-guard": "link:<本仓库绝对路径>/dist"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ssh-guard"]
    }
  }
}
```

然后重启该 profile 的 DSH。

## 配置（全部走环境变量，无需改代码）

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_SSH_HOSTKEY_MODE` | `strict` | `off` = 跳过主机身份校验（**仅排障用**，会恢复中间人风险） |
| `DSH_SSH_HOSTKEY_ALLOW_NEW` | （未设） | 设为 `1` = 无记录时允许首次信任并落库（TOFU，一次性） |
| `DSH_SSH_KNOWN_HOSTS` | `~/.ssh/known_hosts` | 权威指纹清单路径 |
| `DSH_SSH_BUDGET` | （启用） | `off` = 关闭连接预算 |
| `DSH_SSH_BUDGET_GLOBAL` | `4` | 全局并发上限 |
| `DSH_SSH_BUDGET_PER_HOST` | `2` | 每主机并发上限 |
| `DSH_SSH_BUDGET_RPM` | `60` | 每主机每分钟调用上限（滑动窗口） |
| `DSH_SSH_BUDGET_MIN_CONNECT_MS` | `5000` | 同一主机两次**真握手**最小间隔 |
| `DSH_SSH_BUDGET_WAIT_MS` | `120000` | 排队等待上限（超时则明确失败） |

状态文件：`$DSH_HOME/dsh-ssh-hostkeys.json`（TOFU 落库）、`$DSH_HOME/dsh-ssh-budget.json`（计数，供外部工具统一视图）。
主机清单沿用上游：`$DSH_HOME/dsh-ssh.json`。

> **第一次连一台新主机会被拒连** —— 这是 fail-closed 的设计，不是 bug。
> 确认指纹无误后，用 `DSH_SSH_HOSTKEY_ALLOW_NEW=1` 重试一次落库，或先把它写进 `~/.ssh/known_hosts`。

## 目录结构

```
dsh-ssh-guard/
├── package.json       工具链入口：npm run check / check:fix / assemble / bump / smoke / test
├── upstream/0.3.14/   上游发布物原样 vendored（lib 产物 + src 源码 + LICENSE + cordis.patch.yml）
├── patch/             本仓库的增量（唯一真相）：@linxin666__dsh-ssh@0.3.14.patch
├── our/
│   ├── lib/util.mjs        公共工具（外部命令 / 文本 / 哈希 / 符号链接 / 日志）
│   ├── checks/             行尾前置门禁 precheck-eol.mjs、活体定位器 live-target.mjs、安装冒烟 install-smoke.mjs
│   ├── conn-budget.js      本仓库的模块（与补丁内容一致，供审阅）
│   ├── hostkey-guard.js    本仓库的模块（同上）
│   ├── apply.mjs           装配脚本（Node；行尾门禁 + 五道断言 + 依赖自包含）
│   ├── bump-upstream.mjs   跟版脚本（一条命令集成上游新版）
│   └── tests/              回归用例：21 hostkey + 20 budget + 活体/波形/探针脚本
├── .github/workflows/  自动化：check-upstream（报信）+ integrate-upstream（自动装配开 PR）
├── docs/QUALITY-GATES.md  三道门 + 验收三原则 + 作业规则 + 事故档案
├── manifest.json      每个上游版本的期望值（命中数 + 结果哈希）
├── UPGRADE.md         跟上游的升级手册
└── dist/              ★ 装配产物 —— 这才是 `link:` 的挂载目标（不入库）
```

## 红线（踩过的坑，别重犯）

1. **`patches/` 补丁与 `link:` 自建包不许同时生效** —— 同名工具会被注册两次，直接崩掉整个 profile。
   切换必须**一步到位 + 重启**。
2. **`link:` 的包必须自带 `node_modules`**：ESM 按**真实路径**解析（符号链接会被展开），
   从 `dist/` 往上**永远到不了** profile 的 `node_modules` →
   ① 运行期依赖（`ssh2` / `ws` / `@xterm/*`）必须装进 `dist/node_modules`；
   ② 宿主提供的 `@deepseek-ai/dsh-*`（peer）必须以 junction 链进同一处。
   装配脚本 **⑤.5 步**自动做这两件事；缺任何一个都会在启动时报 `ERR_MODULE_NOT_FOUND`。
3. **切换后必须跑真服务式探针验收**：`dsh --profile <档> --port 0 --no-open`，
   看到 `dsh web: http://…` 即通过。
4. **命中数断言不许绕过** —— 它是唯一能发现"`git apply` 报成功却一处都没应用"的东西。
5. **"装配能跑"不等于"装得上"** —— 改过装配线、包名或依赖后跑一次 `npm run smoke`；
   它验到"插件自身的路由返回非 404"为止（只验服务器起来了会**假绿**）。

## 自动化（GitHub Actions）

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `check-upstream.yml`（L1 报信） | 每周一 + 手动 | 查上游 npm 是否有新版；有就**开 Issue**提醒（不改代码、不发布） |
| `integrate-upstream.yml`（L2 装配+PR） | 每周一 + 手动 | 跑完整跟版流程 → **推分支 + 开 PR**（**绝不直接改 main、绝不自动合并**） |

**为什么 L2 要用 `--no-host-link`**：GitHub 的 runner 上没有你本机的 DSH 安装树，无法把
`@deepseek-ai/dsh-tools` 链进 `dist/node_modules`。打开该开关只跳过这一步，**行尾门禁、五道断言
（含结果哈希）、单测仍然全跑** —— 也就是说"产物是否与登记值逐字节一致"在 CI 里照样被验证。
完整可挂载的 `dist` 仍由使用者在本地装配（路线 A）。

**还没做的一层（L3 自动发布）**：
- `npm publish` 到 npm → 使用者就能 `dsh plugin add dsh-ssh-guard`（需要你的 npm 账号 + token 存进 GitHub Secrets）
- 或：Actions 构建 `dist` 打成 tar.gz 挂到 GitHub Release（用自带 `GITHUB_TOKEN`，**不需要 npm 账号**），
  对应「路线 C」

## 许可与归属

- 上游 `LICENSE`（Apache-2.0）随 vendored 目录一并保留；本项目分发时同样按 **Apache-2.0**。
- 上游项目：`@linxin666/dsh-ssh` / `https://github.com/zhu1090093659/dsh-web`。
- **本项目为下游修改版，不代表上游，也未获上游背书。**
- 被改动的上游文件（`lib/index.js`、`lib/client.js`）文件头带 Apache-2.0 §4(b) 要求的**修改声明**；
  完整改动清单见装配产物里的 `FORK.json`（`basedOn` / `deviations` / `assertionScope`）。
- 相对上游的**有意偏离**共三类：① 改名与版本后缀；② 移除每日心跳上报（上游把遥测打包进
  `lib/client.js` 且无开关可关，内容为 `{kind, visitor, items:[{name,version}]}`，不含 SSH 数据，
  但属第三方出网）；③ 归属字段改写 + 修改声明。

## 与上游的关系（2026-09-14 决定）

本项目**独立维护自己的仓库，自行集成上游最新版**；**不向上游提 PR**（决策记录，便于后人理解为何没有 PR）。

跟版是**一条命令**：

```bash
npm run bump -- --version <新版>
```

它自动完成：取官方包 → vendored → 复制补丁 → `--check`（打不上即报警）→ 按实测值登记
`manifest.json` → 更新默认版本 → 装配（五道断言）→ 回归。手工等价流程见 [`UPGRADE.md`](UPGRADE.md)。

仍然刻意保持"**改动可分离**"的形态（补丁落点集中、断言口径明确），以便上游若自行实现了
同样的加固时，本仓库可以**变薄**（删掉对应补丁段，退回纯 vendored）。
