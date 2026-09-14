# 升级手册（跟上游）

> 目标：上游发新版时，**用装配线跟上去，并且有东西替我们报警**——不存在"零成本自动跟随"。

> **一条命令（推荐，2026-09-14 起）**
> ```powershell
> pwsh -NoProfile -File .\our\bump-upstream.ps1 -Version <新版>
> ```
> 它把下面 ①–⑧ 全部固化：取官方包 → vendored → 复制补丁为新版命名 → `--check`
> （**打不上就在这里报警**）→ 按**实测值**自动登记 `manifest.json` → 更新 `apply.ps1`
> 默认版本 → 装配（⓪ + 五道断言）→ 回归（21/21 + 20/20）。
> 幂等：已集成过的版本再跑一次 = 只复验。下面的手工步骤保留为**脚本不可用时的等价流程**。

## 一、跟一版上游（标准流程）

```powershell
# ① 取新版官方包（npm 可达即可，不需要 GitHub）
cd <临时工作目录>                      # 任意空目录
npm pack '@linxin666/dsh-ssh@<新版>'  # 例：0.3.21
tar -xzf linxin666-dsh-ssh-<新版>.tgz

# ② vendored 进本仓库（原样保存：只放产物+源码+许可，别把 node_modules 带进来）
#    <repo>\upstream\<新版>\  ← 解包出的 package\ 内容

# ③ 复制补丁为「新版补丁」并按新版重打
#    copy patch\@linxin666__dsh-ssh@0.3.14.patch → patch\@linxin666__dsh-ssh@<新版>.patch
#    然后修补丁的落点（上游改动会导致 context 失效）

# ④ 先跳过哈希断言装配，看命中数断言怎么报
pwsh -NoProfile -File .\our\apply.ps1 -Version <新版> -NoAssert
#    · 若 ③ 命中数断言报错 → 说明补丁落点变了（**这就是我们要的报警**）→ 按报错修补丁
#    · 若全过 → 继续

# ⑤ 跑回归（两个单测必须先全绿）
node .\our\tests\test-hostkey-guard.mjs      # 期望 21/21
node .\our\tests\test-conn-budget.mjs        # 期望 20/20

# ⑥ 核对差异并重新登记期望值
#    · 用 tool 对比 dist\ 与 upstream\<新版>\：只有我们那 3 个文件应不同
#    · 把新的命中数与三个文件的新 sha256 写进 manifest.json → versions.<新版>
pwsh -NoProfile -File .\our\apply.ps1 -Version <新版>   # 这次带全断言，必须全过

# ⑦ 真服务式探针验收（先在非生产档，别直接上生产）
dsh --profile <staging-profile> --port 0 --no-open      # 看到 `dsh web: http://…` 即通过；随后停掉

# ⑧ 生产切换（一个重启窗口内一步到位，见 README 红线）
```

## 二、什么时候该跟

| 情形 | 动作 |
|---|---|
| 上游修了安全/连接池问题 | **优先跟**（本仓库加固的是"校验与闸门"，上游修的是"行为"，两者不冲突但要合并） |
| 上游改了 `buildConnectConfig` / `withClient` 的形态 | **必跟且必重打补丁**——命中数断言会第一时间报警 |
| 上游把我们的两处加固收进官方（PR 被采纳） | 本仓库可**变薄**：删掉对应补丁段，退回纯 vendored；或整体撤掉 |
| 只是想"用最新版"、没有具体理由 | **不必跟**：当前 0.3.14 + 加固 = 已验证可用；无理由跟版只增加回归成本 |

> **实测登记（2026-09-13）**：把 0.3.14 的补丁直接往 **0.3.21** 上试，
> `git apply --check` **全过**（6/6 hunk，仅位置偏移 2–442 行）；上游 0.3.21 仍保留心跳调用与遥测域名，
> 即 fork 改造的两个前提都没变。→ **升级到 0.3.21 属于低风险**；
> 但偏移较大，务必按 ⑥ 的"人工核对差异"逐处确认语义落点，再重新登记 `manifest.json`。

## 三、红线（每次升级都要过一遍）

1. **命中数断言不许绕过**：它是唯一能发现"`git apply` 报成功却一处都没应用"的东西。
2. **两个单测必须全绿**才准切档；活体脚本（`live-verifier-test.mjs` / `budget-wave-test.mjs`）在停机窗口补跑。
3. **patch 与 `link:` 不许并存**（重复注册 → 崩），切换一步到位 + 重启。
4. **切完必跑 ⑥ 真服务式探针**（`--port 0 --no-open` 看到监听行）。
5. **许可与归属**：vendored 目录里的 `LICENSE` 不许删；README 里"非官方分支"声明不许删。

## 四、将来若要做「源码级 fork」（A，而不是 A′）

需要上游 **git 仓库**（构建配置 `tsconfig.build.json` / tsdown 配置**只在仓库里，npm 包故意不带**——
S0 实测：`npm run build` → `TS5058: tsconfig.build.json 不存在`）。届时：

```powershell
git clone https://github.com/zhu1090093659/dsh-web.git   # 需要 GitHub 可达
# 把我们的两处改动移植到 src/（TS）作为独立提交 → pnpm i → pnpm build → 与 npm 产物逐文件比对
# 一致 → 升级变成 `git fetch upstream && git merge`（git 替我们合代码）
# 同时提 PR 把加固回馈上游（采纳后本仓库可撤）
```
