# lark-channel-bridge

把飞书 / Lark 消息和本地 Claude Code 或 Codex CLI 打通的轻量 bot。用一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里和本机编程助手对话，让它读图、处理文件、改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 主要功能

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 Claude Code / Codex CLI。
- **流式卡片**：文本回复和工具调用实时更新在同一张卡片上。
- **COT 过程消息**：可选先发一条过程消息展示 agent 的阶段性文本和工具调用，再单独发送最终答案。
- **会话延续**：每个聊天、话题或文档评论有自己的会话，不会互相串。
- **排队与消息合并**：短时间连续发送的消息会合并处理；任务运行中收到的普通消息会排队到下一轮，`/new`、`/cd`、`/ws use`、`/stop` 这类命令可以中断当前任务。
- **多工作空间**：用 `/cd` 切换当前项目，用 `/ws` 保存和复用常用项目目录。
- **图片 / 文件**：直接发给 bot，bridge 下载到本地后交给本机 agent 处理。
- **卡片按钮**：`/help`、`/ws list`、`/status` 返回可点击的交互卡片。

## 前置条件

- Node.js **>= 20.12.0**
- 本机至少安装并登录一个 agent：
  - Claude Code：`claude`，安装说明：https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI：`codex`，安装说明：https://developers.openai.com/codex/cli
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

## 安装

```bash
npm i -g lark-channel-bridge
# 或
pnpm add -g lark-channel-bridge
```

## 本地安装（从源码）

改 bridge 本身、或者想用还没发到 npm 的构建时，用这种方式：

```bash
git clone <repo> lark-coding-agent-bridge
cd lark-coding-agent-bridge
pnpm install
pnpm build                                        # tsup → dist/cli.js
npm i -g --install-links .
```

`--install-links` 会把整个包**复制**进全局目录，而不是建软链。直接 `npm link`（或 `pnpm link`）是把全局命令指回你的工作目录：改到一半的代码一存盘就生效，工作目录一挪走全局命令就废。复制版是稳定的，代价是**它不跟随你的改动**——改完 `src/` 下的任何东西，都要重新 `pnpm build` 再跑一次安装命令。

验证：

```bash
lark-channel-bridge --version                  # 0.7.1-fork-0
ls -ld "$(npm root -g)/lark-channel-bridge"    # 是真目录，不是软链
```

然后重启 daemon。跑着的 daemon 一直用它启动时加载的那份 bundle，新代码只有重启后才生效：

```bash
lark-channel-bridge restart --profile <name>
```

### 开启 human-in-the-loop

配置和装 npm 版完全一样，完整行为见下面的 **让 agent 问你要权限** 一节。这里只说两个最容易踩的点：

- **没有命令可以设置它。** `permissions.claude.askHuman` 只能手改 `~/.lark-channel/config.json`，而且必须改在**实际在跑的那个 profile** 下：

  ```json
  {
    "profiles": {
      "claude": {
        "permissions": {
          "defaultAccess": "workspace",
          "maxAccess": "workspace",
          "claude": { "askHuman": true }
        }
      }
    }
  }
  ```

- **只有在 `workspace` 下才有作用。** `full` 走的是 `bypassPermissions`，永远不问；`read-only` 走 `plan`。`askHuman` 做的事是把 `workspace` 的映射从 `acceptEdits`（自动放行编辑、从不提问）改成 `default`，而 `default` 才是会弹出卡片的那档。如果 access 是 `full`，这个开关打开也不会有任何卡片。想绕过这条，用 `/mode`：只要 `askHuman` 开着，这套人机确认界面就会装上，跟模式无关；固定成一个确实会提问的模式（比如 `auto`）就能把卡片找回来，不用动 access 档位。

确认生效的办法：看 `run started` 日志里的 `permissionMode` 字段，应该是 `"default"`。如果是 `acceptEdits`，说明这个 key 没写或拼错了——所有工具都在自动放行，卡片一张也不会出现。

## 首次启动

```bash
lark-channel-bridge run
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 如果终端提示，选择本次要初始化的 agent。
5. 成功后配置写入 `~/.lark-channel/config.json`。

没有指定项目目录也可以启动。bridge 会创建一个 profile 托管的默认工作目录；启动后在飞书里发送 `/cd <path>` 切到实际项目。

如果已经有 PersonalAgent app，可以在初始化时传 `--app-id` 跳过创建应用流程；命令会提示输入 App Secret。

```bash
lark-channel-bridge run --app-id cli_xxx
# 或直接初始化并启动后台服务
lark-channel-bridge start --app-id cli_xxx
```

Lark 国际版应用可加 `--tenant lark`。

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist / systemd unit / Windows 任务会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`
- **Windows**：Task Scheduler 任务 `LarkChannelBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 多 profile：分别运行 Claude 和 Codex

默认情况下，bridge 使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

## 命令速查

### 宿主 CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
lark-channel-bridge migrate [--profile <name>] [--agent claude|codex]
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex 两个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/status` | 查看 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、访问控制和 lark-cli 身份策略 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group` | 移除访问控制条目 |
| `/stop` | 停止当前 run，也可点卡片停止按钮 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/mode [<模式>\|reset]` | 查看 / 切换 Claude 权限模式（管理员） |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

## 回复展示与 COT

`/config` 可以调整三类展示选项：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：`关闭` 只发送最终回复；`简略` 先用 COT 消息展示 agent 的过程文本和工具摘要；`详细` 还会展示工具参数和截断后的输出。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

### 固定 Claude 的权限模式

`permissions.claude.permissionMode` 直接指定 Claude 的 `--permission-mode`，覆盖上面的映射：

| 值 | 行为 |
|---|---|
| `default` | 每次操作都问（Claude Code 里也叫 `manual`） |
| `acceptEdits` | 自动放行文件编辑，其他仍然要问 |
| `plan` | 只读规划，不执行任何改动 |
| `auto` | 由分类器模型逐条判断：常规操作自动放行，超出你要求范围、或像被注入内容驱动的操作会被拦下 |
| `bypassPermissions` | 完全不检查权限 |

这个值的上限是 **`maxAccess`，不是 `defaultAccess`** —— 固定模式是运维在说「这个 profile 就跑这个模式」，`maxAccess` 是授权它的预算。`auto` 的放行范围远超文件编辑——包括推送、建 PR——所以它归在 `full` 档：`maxAccess` 还是 `workspace` 时固定它会报 `permission claude.permissionMode cannot exceed maxAccess`。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full",
    "claude": { "permissionMode": "auto" }
  }
}
```

所以固定模式的优先级高于更低的 `defaultAccess` —— `defaultAccess` 只在没有固定模式时才作为兜底：

```json
{
  "permissions": {
    "defaultAccess": "workspace",
    "maxAccess": "full",
    "claude": { "permissionMode": "auto" }
  }
}
```

这个 profile 实际跑 `auto`。`defaultAccess` 只有在 `/mode reset` 之后才重新起作用——那时会回到推导出来的模式，这里是 `acceptEdits`。

`auto` 和 `askHuman` 可以叠加：分类器自己放行常规调用，它不肯放行的那些照样落成卡片问你（已实测——强制触发提示的规则在 `auto` 模式下依然会把 run 停下来）。

### 在对话里切换模式

不一定要手改配置。`/mode` 读写的就是同一个 key：

| 命令 | 作用 |
|---|---|
| `/mode` | 显示当前生效的模式、它从哪来，以及当前 access 档位允许选哪些 |
| `/mode <值>` | 把 `permissions.claude.permissionMode` 固定为该值 |
| `/mode reset` | 清除固定，回退到由 access 档位推导 |

管理员命令，和其他配置类命令一致。和 `askHuman` 不同——后者在 bridge 启动时解析一次，因为它决定要不要装 human-in-the-loop 这套东西——模式是**每次 run 开始时**读取的，所以改完下一条消息就生效，不用重启。

超出 access 档位的值会被直接拒绝并说明原因，而不是写进去：`workspace` profile 下执行 `/mode auto` 会提示你先放宽 `maxAccess`。

## 让 agent 问你要权限

把 `permissions.claude.askHuman` 打开，agent 需要权限时就会在飞书里问你，而不是自己决定。bridge 会发一张带「允许一次 / 始终允许 / 拒绝」的卡片，run 停下来等你选。

```json
{
  "permissions": {
    "defaultAccess": "workspace",
    "maxAccess": "workspace",
    "claude": { "askHuman": true }
  }
}
```

默认关闭，因为它确实改变 run 的行为：在 `workspace` 下 bridge 会把 Claude 从 `acceptEdits` 切到 `default`，原本自动放行的编辑会停下来问你。

- **允许一次**：只批准这一次调用。
- **始终允许**：额外存一条规则，由 Claude Code 自己写进项目的 `.claude/settings.local.json`。bridge 不碰这个文件——它只把决定交给 CLI，规则格式由 CLI 说了算。
- **拒绝**：回绝这次调用，agent 继续往下走。

**没有超时。** 问题会一直等下去，所以你临时走开不会导致 run 被判死刑。代价是卡着的 run 会占住这个会话，直到你做出选择或发 `/stop`。等待期间它会让出并发槽位，别的会话照常跑。往卡住的会话里发消息会被排队，bridge 会回一句告诉你它在等什么。

这条通道承载 CLI 发起的**所有**阻塞式提问，不只是工具权限。bridge 在握手时声明自己能渲染哪些 dialog kind；渲染不了的根本不会发过来，对应流程按 CLI 自己的「无对话」行为降级。

### 让 agent 直接问你（选项 / 多选 / 自由输入）

同一条通道也承载 agent 主动发起的提问。Claude Code 的 `AskUserQuestion` 会渲染成一张**问题卡**，而不是权限卡——bridge 的系统提示词也要求 agent 需要用户做选择时优先用它，不要自己拼卡。

| 问题类型 | 卡上的控件 |
|---|---|
| 单选（`choice`，默认） | 每个选项一个按钮，点一下就是答案；多个问题时退化成下拉框 + 提交 |
| 多选（`multiSelect: true`） | 每个选项一个复选框，勾完点「提交」 |
| 文本（`type: "text"`） | 输入框 |
| 数字（`type: "number"`） | 输入框，卡上标出 `min ~ max` 范围 |

每张卡都额外带一个「其他」输入框，用户想写什么就写什么；单选时它优先于上面的选择，多选时它是列表里多出来的一项。一张卡可以同时问多个问题，用户一次性提交。

答案以 `answers`（问题文本 → 答案字符串）回到这次工具调用里，agent 直接接着往下做，不用再等一条用户消息。多选答案是把选中的选项用 `, ` 连起来的字符串。

卡上还有「跳过」：用户不想回答时点它，这次工具调用按**拒绝**处理——agent 收到拒绝应该换个方式问或按默认继续，而不是反复弹同一张卡。提交时什么都没填则是一组空答案，不是拒绝。

已回答的卡会被冻结成一份记录：每个问题和它得到的答案（没答的标 `_未回答_`），加上操作人，方便事后回看。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | root config，包含 profiles 和 active profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以迁移整棵本地状态目录。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里对**群内所有人**响应 | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-channel/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / agent 不回复**：通常是本机 `claude` 或 `codex` CLI 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**agent 子进程假死（卡片停在最后一帧不动）**：支持 idle 探活。agent 一段时间没输出就会被 SIGTERM kill，卡片末尾会标出自动终止原因。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前会话生效；`/timeout off` 关掉当前会话的探活；`/timeout default` 清掉会话覆盖，回退到全局设置。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 测试与 CI

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process-level adapter 测试。CI 在 macOS、Ubuntu、Windows 上执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck` 和 `pnpm build`。

不管是在终端里跑，还是从 bridge 拉起的 agent 会话里跑，结果都一样：`tests/setup/scrub-bridge-env.ts` 会在任何测试开始前删掉运行中的 bridge 注入给 agent 子进程的那些环境变量（`LARK_CHANNEL*`、`LARKSUITE_CLI_CONFIG_DIR`、`CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`）。不删的话它们会漏进子进程并改变结果——光 `LARK_CHANNEL_PROFILE` 一个就能把 secret 解析指向只在你本机存在的 profile。这个文件要留着；需要这些变量的测试自己显式设置。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

## 许可

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="飞书反馈群二维码" width="360">
