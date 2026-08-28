# dsh-task-notifier

DeepSeek Harness 社区插件（组合包）：**任务完成时弹出系统通知**，告诉你「某某任务已经完成」。

agent 经常在后台跑很久，等你回到窗口，它其实早就答完了。这个插件把 DSH 内部「一件任务结束了」的信号接出来，
交给操作系统的通知中心——Windows 吐司、Linux 桌面通知、macOS 通知中心——并带上任务的名字：

| 场景 | 通知标题 | 通知正文 |
| --- | --- | --- |
| 一轮对话答完 | DSH 任务完成 | 对话任务：修复登录接口 500 报错 |
| 委派的子任务结束 | DSH 任务完成 | 子任务：梳理 packages 依赖关系 |
| 后台任务跑完 | DSH 任务完成 | 后台任务：pnpm test |
| 目标标记完成 | DSH 任务完成 | 目标：把插件文档补全并跑通测试 |
| 工作流跑完 | DSH 任务完成 | 工作流：全仓依赖审计 |
| 出错 / 取消 / 截断 | DSH 任务未正常结束 | 后台任务：pnpm test |

任务名优先取会话标题（DSH 会自动生成），没有标题时退回该会话最近一条人类指令。

## 它监听什么

DSH 里「任务完成」有好几种形态，插件给每一类都留了独立开关，全部来自真实事件，不做轮询：

| 开关（默认开） | 事件接缝 | 判定 |
| --- | --- | --- |
| `onTurnEnd` | `session/event` 里的 `turn/end` | `reason.kind === 'completed'` 记为成功；`error` / `aborted` / `blocked` / `max-tokens` 记为未成功 |
| `onSubagentEnd` | `subagent/end` | `stopReason === 'completed'` |
| `onJobDone` | `ctx.jobs.onJobDone`（`@deepseek-ai/dsh-jobs`） | `status === 'completed'` |
| `onGoalComplete` | `goal/changed` | `operation` 为 `complete` 或 `block`（`create` / `edit` / `pause` / `resume` 是中间态，不打扰） |
| `onWorkflowEnd` | `workflow/end` | `stopReason === 'completed'` |

另外三条降噪规则：

- **子会话默认静音**。subagent 会话里的每一轮也带 `turn/end`，默认只在 `includeChildSessions: true` 时才通知；
  子任务本身的结束由 `onSubagentEnd` 负责，不会漏。
- **崩溃修补的 `interrupted` 轮次永远不通知**——那是持久化后端重放时补写的记录，不是刚跑完的活。
- **`dedupeMs` 去重窗口**（默认 2 秒）：同一个完成信号被多条接缝同时报出、或插件被热替换时，只弹一条。

投递是「尽力而为且必定吞掉错误」的：所有渠道都失败时只记一条 warn 日志，绝不会因为弹不出通知而让 agent 的一轮任务失败。

## 安装并启用

以下命令都在 [DSH 仓库根目录](https://github.com/deepseek-ai/deepseek-harness) 执行。

### 方式一：直接跑源码（推荐先这样验证）

先把开发层里的占位路径换成你自己的 checkout（一条命令，无需手改）：

```sh
node scripts/write-dev-patch.mjs   # 重写 load.dev.patch.yml，并打印可直接用的命令
cd /path/to/deepseek-harness
pnpm dsh web --patch "它打印出来的那个 load.dev.patch.yml 绝对路径"
```

打开 `http://127.0.0.1:3080`，随便提一个任务；agent 答完的那一瞬间，桌面会弹出「DSH 任务完成 / 对话任务：…」。
终端里同时能看到 `dsh-task-notifier` 打印的 `watching task completions` 与 `system notification shown`。

> **Windows 必看**：patch 里的插件路径必须绝对，而且要写成 `file:///E:/...` 形式。直接写 `E:/...` 会被 Node 的
> ESM 加载器当成未知协议拒绝（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）；`file:///` 形式在 Linux 与 macOS 上同样正确，
> 所以模板统一用它。

### 方式二：装成组合包

```sh
dsh plugin --profile demo add E:/ai_agent_workspace/deepseek_harness/dsh-task-notifier
dsh --profile demo
```

包声明了 `dsh.bundle.patch = ./cordis.patch.yml`，安装后 `id: task-notifier` 那一行自动进入组合。
只想看层是否生效、先不启动：`dsh --profile demo --dump-config`。

### 方式三：tarball（目标机器无需构建）

```sh
pnpm run pack                                 # 产出含预构建 lib/ 的 tarball
dsh plugin --profile demo add ./dsh-task-notifier-1.0.0.tgz
```

也可以直接 `dsh plugin --profile demo add github:yuan-source-666/dsh-task-notifier`。仓库里**带着预构建的 `lib/`**
（`.gitignore` 刻意没有忽略它），因为 DSH 的 git 安装只取源码、不会跑构建：这样装完即可加载，目标机器既不需要
TypeScript，也不需要授权 `prepare` 构建脚本。改了源码要自己构建时，`scripts/build.mjs` 在拿不到 TypeScript 的情况下
会明确报错并给出修法，而不是抛栈。

## 配置项

全部写在这一行的 `config:` 里；每个字段都有可用默认值，下面列出的就是默认值。

```yaml
- insert:
    - id: task-notifier
      name: dsh-task-notifier
      config:
        enabled: true                # 总开关，false 时连监听都不注册
        locale: 'zh'                 # 'zh' 或 'en'；一个字段决定整套文案语言
        title: ''                    # 成功标题；留空跟随 locale
        failureTitle: ''             # 未成功标题；留空跟随 locale
        bodyTemplate: ''             # 正文模板；留空跟随 locale
        taskNameChars: 120           # 任务名最长保留多少字符，超出用省略号收尾
        onTurnEnd: true
        onSubagentEnd: true
        onJobDone: true
        onGoalComplete: true
        onWorkflowEnd: true
        onlySuccess: false           # true = 出错/取消不再打扰
        includeChildSessions: false  # true = 子会话里的每一轮也通知
        sound: true                  # 支持的渠道带上提示音
        dedupeMs: 2000               # 同一完成信号的去重窗口
        appName: 'DeepSeek Harness'  # 通知里显示的应用名
        powershellProgram: ''        # Windows 指定 PowerShell；留空依次试 powershell.exe、pwsh.exe
        command: []                  # 自定义投递命令 argv，非空时覆盖内置渠道
        timeoutMs: 15000             # 单个投递进程最长运行时间，超时即换下一个渠道
```

正文模板可用占位符：`{kind}` 任务类型、`{task}` 任务名、`{outcome}` 结束原因、`{ref}` 会话或任务 id。
写错的占位符（例如 `{nope}`）会原样显示在通知里，而不是悄悄消失。

`locale` 一次切换同时改掉三处：类型与原因标签（`对话任务` / `Chat task`、`已完成` / `completed`）、默认标题、
以及默认模板里的分隔符（中文 `：` / 英文 `: `）——不会出现「Background job：xxx」这种半英不中的通知。

### 用别的程序投递

`command` 的 argv 里含 `{title}` / `{body}` 时就地替换；不含就把两个字符串追加到末尾。两种情况都不经过 shell：
任务名里有 `$&`、引号、反引号、`$(...)` 也只会被当作普通文字（冒烟测试里专门有一条覆盖这点）。

```yaml
        command:
          - /usr/local/bin/my-notify
          - --title={title}
          - --text={body}
```

## 各平台渠道与回落顺序

| 平台 | 依次尝试 |
| --- | --- |
| Windows | `powershell.exe` + WinRT 吐司 → `powershell.exe` + 托盘气泡 → `pwsh.exe` + 吐司 → `pwsh.exe` + 气泡 |
| Linux | `notify-send` → `zenity --notification` → `kdialog --passivepopup`（成功且 `sound: true` 时再尽力 `paplay` 一声） |
| macOS | `osascript` 的 `display notification`（`sound: true` 时用 Glass 音） |
| 任意平台 | `command` 非空时只用它 |

吐司脚本通过 `-EncodedCommand`（Base64 + UTF-16LE）递交，正文里的引号与换行破坏不了命令；子进程一律
`stdio: 'ignore'`，所以宿主进程即便跑在沙箱里也能正常派生通知程序。

## 自己验证

```sh
pnpm install
pnpm test              # 编译 + 26 项冒烟检查（假 ctx、假服务、真 spawn 到采集脚本）
pnpm run test:notify   # 用插件自己的投递代码，真弹一条系统通知
pnpm run test:notify -- --failure --locale=en
```

`tests/smoke-test.mjs` 不需要 harness、API key 或网络：它把 `command` 指向 `scripts/notify-sink.mjs`，用结构化的假
`ctx` 驱动 `session/event`、`subagent/end`、`ctx.jobs`、`goal/changed`、`workflow/end`，再断言桌面被要求显示的确切标题与正文。

## 给其他插件复用

每次判定完成后，插件会发出自己的事件，别的插件可以直接订阅同一信号，不必重新解析 harness 接缝：

```ts
ctx.on('task-notifier/completed', ({ completion, title, body }) => {
  // completion: { kind, task, outcome, success, key, ref }
})
```

## 已知边界

- 通知发生在**运行 dsh 的那台机器**上。浏览器远程打开 Web UI 时，弹的是服务器那边的通知。需要浏览器内提示的话，
  请另写一个客户端插件订阅 `task-notifier/completed`。
- 会话标题由 DSH 标题服务异步生成（它自带字节上限，所以通知里看到的是被截短的标题），标题还没生成时正文会退回「最近一条人类指令」。
- 目标（goal）自动续跑时每一轮都是一个新 `turn/end`，所以每轮答完都会通知一次。只想在目标真正完成时被叫醒，
  就把 `onTurnEnd: false`、保留 `onGoalComplete: true`。
- 通知里带任务名（默认最多 120 字符）。不想让提示词进桌面通知，就把 `bodyTemplate` 改成 `'{kind} {ref}'`，
  或调小 `taskNameChars`、保持 `includeChildSessions: false`。
- `onJobDone` 依赖组合里存在 `ctx.jobs`（如 `dsh-jobs-local`）。缺失时记一行日志并跳过该来源。

## 目录结构

```
src/index.ts            插件入口：Config schema、去重窗口、装配、task-notifier/completed 事件
src/task-source.ts      五类完成信号的归一化适配器（结构化视图，不 import harness 内部包）
src/format.ts           任务名折叠截断、中英文标签、标题与模板解析
src/notifier.ts         跨平台投递：吐司 / 气泡 / notify-send / zenity / kdialog / osascript / 自定义命令
cordis.patch.yml        组合包层（按包名引用）
load.dev.patch.yml      源码开发层（file:/// 绝对路径）
scripts/build.mjs       自包含构建（git 安装时的 prepare 用得上）
scripts/write-dev-patch.mjs 把开发层里的占位路径换成本机绝对路径，并打印启动命令
scripts/notify-test.mjs 真弹一条通知的手动检查
tests/smoke-test.mjs    假 ctx 冒烟测试
```

## 许可

MIT

