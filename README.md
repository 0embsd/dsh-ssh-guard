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
        │  our\apply.ps1 装配（五道断言）
        ▼
分发的插件包        包名 = dsh-ssh-guard                    ← 成品（dist\ → link: 挂载）
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

## 装配（从源码构建 `dist\`）

```powershell
git clone <本仓库> ~/.dsh/tools/dsh-ssh-guard
cd ~/.dsh/tools/dsh-ssh-guard
pwsh -NoProfile -File .\our\apply.ps1           # 产出 dist\（五道断言必须全过）
node .\our\tests\test-hostkey-guard.mjs         # 21 例
node .\our\tests\test-conn-budget.mjs           # 20 例
```

可选参数：`-RepoUrl <你的仓库地址>` `-Author <你的名字>`（写入 `dist\package.json` 的归属字段；
不传则**删掉**上游遗留的 `repository` 指向）；`-Version <上游版本>`；`-NoAssert`（升级专用）。

## 挂载到 DSH profile

profile 的 `package.json` 里用 `link:` 指向本仓库的 **`dist\`**，并把包名登记进 `dsh.profile.bundles`：

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
├── upstream/0.3.14/   上游发布物原样 vendored（lib 产物 + src 源码 + LICENSE + cordis.patch.yml）
├── patch/             本仓库的增量（唯一真相）：@linxin666__dsh-ssh@0.3.14.patch
├── our/
│   ├── conn-budget.js      本仓库的模块（与补丁内容一致，供审阅）
│   ├── hostkey-guard.js    本仓库的模块（同上）
│   ├── apply.ps1           装配脚本（五道断言 + 依赖自包含）
│   └── tests/              回归用例：21 hostkey + 20 budget + 活体/波形/探针脚本
├── manifest.json      每个上游版本的期望值（命中数 + 结果哈希）
├── UPGRADE.md         跟上游的升级手册
└── dist/              ★ 装配产物 —— 这才是 `link:` 的挂载目标（不入库）
```

## 红线（踩过的坑，别重犯）

1. **`patches/` 补丁与 `link:` 自建包不许同时生效** —— 同名工具会被注册两次，直接崩掉整个 profile。
   切换必须**一步到位 + 重启**。
2. **`link:` 的包必须自带 `node_modules`**：ESM 按**真实路径**解析（符号链接会被展开），
   从 `dist\` 往上**永远到不了** profile 的 `node_modules` →
   ① 运行期依赖（`ssh2` / `ws` / `@xterm/*`）必须装进 `dist\node_modules`；
   ② 宿主提供的 `@deepseek-ai/dsh-*`（peer）必须以 junction 链进同一处。
   装配脚本 **⑤.5 步**自动做这两件事；缺任何一个都会在启动时报 `ERR_MODULE_NOT_FOUND`。
3. **切换后必须跑真服务式探针验收**：`dsh --profile <档> --port 0 --no-open`，
   看到 `dsh web: http://…` 即通过。
4. **命中数断言不许绕过** —— 它是唯一能发现"`git apply` 报成功却一处都没应用"的东西。

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

```powershell
pwsh -NoProfile -File .\our\bump-upstream.ps1 -Version <新版>
```

它自动完成：取官方包 → vendored → 复制补丁 → `--check`（打不上即报警）→ 按实测值登记
`manifest.json` → 更新默认版本 → 装配（五道断言）→ 回归。手工等价流程见 [`UPGRADE.md`](UPGRADE.md)。

仍然刻意保持"**改动可分离**"的形态（补丁落点集中、断言口径明确），以便上游若自行实现了
同样的加固时，本仓库可以**变薄**（删掉对应补丁段，退回纯 vendored）。
