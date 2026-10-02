# 飞书桥

飞书桥是 Windows 上的常驻辅助程序。它观察本机 Codex 各项目已加载的用户任务，把待回答问题、需要在电脑处理的提示和新结果发到手机飞书。普通选择题和补充信息可以在手机回答，答案交回原任务。当前所有消息均使用普通通知，不额外请求应用内加急；手机弹窗由飞书和系统通知设置控制。

共享版源码入口：[SHC717/codex-feishu-bridge-community](https://github.com/SHC717/codex-feishu-bridge-community)。桥接核心版本 `1.3.1`，共享版 `1.3.1-community.1`。本仓库已包含安装需要的相邻 `shared/windows-native`，请完整克隆或解压仓库。

## 常驻与开关

- **开机并登录当前 Windows 用户后自动启动**，锁屏继续工作，不要求打开电脑端飞书。
- Windows 计划任务独立启动 GUI 子系统的 `NoWindowHost.exe`，以 `CreateNoWindow` 运行 PowerShell 和 Node 看护；Node 再看护收发消息的工作进程。启动链不创建终端窗口，启动/暂停快捷方式共用此入口。启动由 Windows 负责，不依附于某个 Codex 对话的工具进程。
- 启动器使用 Windows Job Object 管理本次子进程树，启动器或 PowerShell 异常退出时清理自身子进程，随后由计划任务恢复，不遗留重复后台实例。
- 同一任务同时只允许运行一个实例；每分钟的持续触发和失败重试可以恢复意外退出的外层程序。Node 工作进程断线后以 5–60 秒间隔重连。原实例仍在时会接续看护，避免重复消费者。
- 计划任务没有一天的重复期限、三天的执行期限或电池供电停止条件；使用当前用户普通权限，不创建系统服务、不提权、不保存 Windows 密码。
- 主动暂停会先保存停止意图并禁用看护任务；跨过每分钟检查、重新登录后仍保持暂停，直到手动恢复。
- Codex 关闭时，飞书桥保持看护并等待它重新运行。电脑睡眠或关机时不能执行任务；唤醒、联网且 Codex 可连接后再恢复收发。

部署目录中的 `启动飞书桥.lnk` 和 `暂停飞书桥.lnk` 是日常开关。内部目录仍叫 `CodexFeishuBridge`，便于保留原消息记录。

## 手机能力

完整选项显示在卡片正文，按钮显示“选择 A / B”；文字回答最多 500 字。电脑先回答，原卡变成“该任务已在电脑端处理”；手机回答被电脑接受后显示“已通过飞书处理”。结果卡显示任务名称和完整最终答复，不取推理或工具输出。同一未处理问题只提醒一次。

手机聊天列表使用两个私有群：**Codex 交互请求**接收选择、补充信息与待处理提示；**Codex 结果通知**接收完整结果及失败/中断状态。每个群只含本人和同一机器人，机器人显示名为 **Codex 助手**，Windows 后台程序仍叫 **飞书桥**。旧私聊记录保留；升级前已经开始投递的旧卡片保持原去向，新消息按类别分流。

正文通过普通本地代码转换，没有模型调用和额外 GPT token。手机回答使 Codex 原任务继续运行时，原任务本身仍按正常规则使用模型额度。保留加粗、段落、列表、链接和代码行；表格转为逐行字段，便于手机阅读。每张结果卡按序列化 UTF-8 大小控制在 10,000 字节以内，优先按完整段落/表格行/代码块分片，最多三张；超过三张或单个结构过长则发送说明卡和完整 `.md` 原文附件。附件超过 20 MiB 时按 Unicode 字符边界编号拆分，拼接后与原始正文一致。附件是原始 Markdown 文本，手机能否直接预览取决于飞书文件查看器。链接到的本地文件和图片只显示文字或路径，不自动读取、上传。

每一页/附件独立记录发送回执。中途断线后保留原文、稳定消息编号和上传回执，继续未完成部分；全部发出后清除本地队列中的完整正文，只留摘要与校验信息。普通模式不会追加加急请求；旧记录中尚未完成的加急重试会跳过，不重发正文。

命令、文件、权限审批及原生 Plan 提问目前仅提醒，需要在电脑处理。手机回答后电脑可能保留已答问题面板，自动关闭该面板尚未实现。

观察范围覆盖本机各项目的用户任务，排除归档、内部子代理和审查任务；不强制启动尚未加载的任务。离线期间已经结束、首次发现就是完成状态的回合不补发历史提醒。电脑开机、联网且 Codex 运行时，程序通过官方飞书 CLI 与飞书服务器通信，电脑端飞书客户端可以关闭。

## 环境和兼容性

| 项目 | 要求 |
|---|---|
| 系统 | Windows x64，当前用户的官方 OpenAI.Codex 包 |
| Codex | 应用版本仅作记录；身份和实际接口检查通过即可使用，上游已记录实测 `26.930.2377.0`；本设备仍需独立预检 |
| Node | 22+，上游记录使用 24.19.0；无 npm 依赖 |
| Python | 3.12+ 的 Python 3，上游记录使用 3.12.14；仅标准库 |
| PowerShell | 7.x，上游记录使用 7.6.5 |
| 飞书 CLI | 当前代码核验的 `1.0.93`，脚本不自动升级 |
| 数据库 | 只读 `state_5.sqlite`，先检查必需表和字段，不写 Codex 数据库 |

任务状态帧允许最多 128 MiB，以容纳较长对话的完整状态；超过上限仍拒绝并保留长度诊断，不无限分配内存。

每次重新连接都会核验当前安装的官方包、真实文件路径、命名管道服务端和用户身份，并自动使用当前安装路径。`compatibility.json` 中的 `testedCodexVersions` 只记录实测版本，不参与准入：单纯应用版本变化不会停用飞书桥。初始化、状态流协议、任务历史结构、回答归属和接受证据仍检查；协议确实不兼容时停止该连接并明确告警。未来真正破坏接口的升级仍可能需要维护，但不必为每次版本号变化修改清单。

## 故障和恢复提醒

独立监督进程通过原飞书应用将告警发送到“Codex 结果通知”，不依赖 Codex 初始化成功，不开启第二个回答监听连接。普通断连或消息工作进程失败持续约 2 分钟才普通提醒；身份验证、任务清单结构或状态流接口明确不兼容时尽快提醒。同一事件保存稳定发送编号和回执，跨重启继续；已成功发送的卡片不重复发送，也不追加加急。

当前工作进程必须有新鲜心跳、成功读取的任务清单和可用任务状态，并连续稳定 10 秒，才发送一次普通恢复通知。仅有进程心跳、旧进程留下的健康文件、连接空任务或不完整状态都不能证明恢复。没有已加载任务时等待实际任务，不把正常空桌面当成故障。网络暂不可用时保留待发通知并重试；电脑关机、睡眠、整个桥接尚未运行，或飞书服务本身不可达时不能即时发送。

`Get-BridgeStatus.ps1` 的 `codexVersion` 来自当前健康连接，未连接时为空；`installedAgainstCodexVersion` 是安装时版本，避免把旧配置误当成现状。`connectionHealth` 显示当前健康判断，`faultNotification` 显示告警等待、已发和恢复状态。本机新增 `state/health-notifications.json`，不进入 GitHub。

## 两台电脑的机器人

两台都常驻时，推荐使用两个不同 App ID 的应用/机器人。同一应用的多个长连接按集群方式接收回调，只有随机一个连接收到；当前程序没有跨电脑转发服务。[飞书官方长连接说明](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)

只更改 profile 名称而使用同一个 App ID 不能解决回调竞争。共用应用时任意时刻只允许一台电脑的该应用回调连接在线；暂停桥接后 CLI 的后台连接可能稍后才退出，有其他消费者时还可能继续在线。

本机 profile 必须明确指定，发卡、更新和回调均使用该 profile，不切换全局默认。部署记录同时绑定 App ID 和接收人，启动时检查 profile 是否被改到另一应用。凭据由官方 CLI 在本机保存，不能复制台式机的凭据、deployment.json、state 或日志到笔记本。接收人 open_id 必须属于选中的应用。

## 新电脑部署

1. 在本机非同步普通目录获取完整 `codex-feishu-bridge-community` 仓库。已有克隆先检查未提交改动和分叉，再安全更新；没有克隆则正常 clone，不强制覆盖。进入仓库的 `codex-feishu-bridge` 子目录执行后续步骤。
2. 使用普通当前用户 PowerShell 7，独立核验计算机名和 `whoami /user` 返回的用户 SID。安装器需要这个已核验的 SID。
3. 复用已有运行环境。默认寻找本用户 `.cache/codex-runtimes/codex-primary-runtime/dependencies` 和 `.local/bin/lark-cli.exe`；位置不同用参数明确指定。程序不会下载、安装或升级依赖。
4. 配置这台设备的飞书应用及本机 CLI profile。先读 `lark-cli profile add --help`，密钥只通过官方安全输入交给 CLI，不写进源码、命令、聊天或仓库。
5. 应用启用机器人，允许接收用户使用；启用长连接和 `card.action.trigger` 回调，授权机器人发消息、更新卡片和读取消息。本版本只用普通通知，无需为本桥接新增加急权限。后台要求发布时由用户发布生效。分类群还需要机器人创建/读取群和成员的权限；完整结果附件需要上传文件权限（`im:resource`）。权限不足时按 CLI 返回的官方入口开通，不能换用户身份或扩大到无关权限。
6. 在该设备选定应用下创建或核验两个专用私有群，名称为 `Codex 交互请求`、`Codex 结果通知`，只含接收人和该应用机器人，接收人为群主。读取 `im +chat-create --help` 后以 `--as bot --profile <本机profile>` 创建，或用飞书本人界面建群并加入机器人。先列出已有群，不能仅凭名称重复创建；保存两个 `oc_...` 标识仅到本机配置。用 `im +chat-members-list --as bot --chat-id <群ID> --page-all` 和 `im chats get` 核对成员、机器人 App ID、群主及 private 属性。

机器人显示名需在飞书开发者后台的“凭证与基础信息 → 国际化配置”修改并发布应用版本；Windows 程序版本与飞书应用发布版本相互独立。

先执行只读检查：

```powershell
.\Test-BridgeEnvironment.ps1 -CheckDesktop -ProfileName 'codex-notebook'
```

示例 profile 需替换为本机真实名称。可追加 `-NodePath`、`-PythonPath`、`-PwshPath`、`-LarkCliPath`、`-CodexHome`。检查不发消息、不提交答案、不安装文件；通过不等于手机通知和回传已验收。

在明确部署授权、已核验的 SID、profile 和该应用接收人后安装：

```powershell
.\Install-Bridge.ps1 -ExpectedUserSid 'S-1-5-21-请替换为完整SID' `
  -ProfileName 'codex-notebook' -Recipient 'ou_请替换为本应用接收人' `
  -InteractionChatId 'oc_请替换为交互群' -ResultChatId 'oc_请替换为结果群' -StartNow
```

安装使用 Windows 已有 .NET Framework 编译器构建 GUI 启动器，不安装新依赖；构建输出留在非同步临时区。安装复制并校验 32 个运行文件到 `%LOCALAPPDATA%\CodexFeishuBridge`，写入本机配置，登记当前用户计划任务 `飞书桥-<用户SID>`，生成两个开关快捷方式。`-StartNow` 立即启动；省略时由下次登录或下一分钟触发启动。首次连接可能需要几十秒，以 `workerReady=true` 为消息通道就绪标准。

从 Codex 的 MSIX 虚拟化上下文安装会被拒绝；回到已核验的普通用户终端，不放宽身份检查或提权。

## 状态与验收

按需分别执行：

```powershell
$bridge = Join-Path $env:LOCALAPPDATA 'CodexFeishuBridge'
& (Join-Path $bridge 'Get-BridgeStatus.ps1')
& (Join-Path $bridge 'Stop-Bridge.ps1') -PauseOnly  # 持久暂停
& (Join-Path $bridge 'Start-Bridge.ps1')           # 恢复并重新启用自动启动
```

`notificationMode=normal` 表示普通通知模式，包括交互、结果和桥接自身故障/恢复通知；没有加急 API 调用。`noConsoleStartup=true` 表示已使用匹配的无控制台启动定义，运行清单同时验证启动器字节；`taskMatches=true` 表示 Windows 看护定义与本安装一致；`autoStartEnabled=true` 表示登录和持续恢复已启用；`workerReady=true` 表示当前消息通道可用。仅有心跳或仅有 supervisorRunning 不能证明提醒正常。心跳是每秒更新的运行时间标记，还须检查实际进程身份和工作通道。

在新设备验证两个会话只含本人和机器人、手机回答→原任务继续、电脑回答→原卡关闭、完整正文和长文分页/附件、普通通知和手机顶部弹窗、暂停/恢复、登录或重启后自动运行。各设备分别验收，不从台式机推断笔记本已经通过。

已部署且没有待回答问题时，可以在明确授权后运行可复用的实际恢复检查：

```powershell
.\Test-BridgeRecovery.ps1 -ExpectedUserSid 'S-1-5-21-请替换为完整SID' -ConfirmLiveRecovery
```

该检查会短暂中断本桥接，验证工作进程、Node 看护、PowerShell 看护及 GUI 启动器四层退出恢复、重复启动单实例、暂停超过一分钟保持及恢复就绪，并在恢复期间检查可见窗口。它只操作 PID、创建时间、路径和任务身份均匹配的本安装，不停止 Codex 或其他 Node 程序。回执只写本机临时区，测试末尾恢复看护。它不会自动注销或重启 Windows；登录验收需另行进行。

## 更新与旧部署迁移

先检查本地未提交改动，再更新本仓库源码；部署使用本机源码副本，不直接修改运行目录。更新前暂停并确认停止，将整个安装目录冷备份为 ZIP，条目从目录内部开始，保存到自行选定的非同步本机备份目录，完整读取并记录 SHA-256。备份目录必须位于运行目录之外。共享版更新必须同时提供 `-BackupRoot` 和 `-BackupArchive`；不再要求电脑有某个固定盘符。然后执行：

```powershell
.\Install-Bridge.ps1 -ExpectedUserSid '<已核验SID>' -ProfileName '<原profile>' `
  -Recipient '<原接收人>' -Update -BackupRoot '<本机备份目录绝对路径>' `
  -BackupArchive '<该目录内已核验冷备份ZIP的绝对路径>' -StartNow
```

分类部署更新时省略群参数会保留现有两个群；从旧版首次切换分类时显式同时提供 `-InteractionChatId` 和 `-ResultChatId`。只提供一个或提供相同群会被拒绝。完全没有群配置的旧式单聊部署仍兼容。安装器会在线核验两个群均为接收人拥有的私有群，成员只有该接收人和选定应用机器人，然后才写入。

安装器逐文件检查冷备份和当前停机部署一致，禁止把旧消息状态挪给其他应用或接收人。版本 1.0.0 的 schema 2 尚未记录 App ID；早期 schema 1 也没有明确 profile。迁移这些已审阅的旧部署，还必须明确追加 `-MigrateLegacy -LegacyAppId '<独立确认的原应用ID>'`。该值须与所选本机 profile 一致，不能猜测来源或删除旧配置强行当新安装。原 schema 1 的 18 个文件哈希、已停止实例、原接收人及旧登录入口须先核验。

迁移保留消息/答案记录与日志。只有旧 Startup 快捷方式已证明属于本部署、且新计划任务回读正确后才移除它，改由 Windows 持续看护。失败时保留现场和备份，不自动恢复；恢复备份须另行授权。

## 无业务写入的测试

```powershell
node --test *.test.mjs
python -B metadata.test.py
pwsh -NoProfile -File Environment.Tests.ps1
pwsh -NoProfile -File BackupLocation.Tests.ps1
pwsh -NoProfile -File Lifecycle.Tests.ps1
pwsh -NoProfile -File NoWindowHost.Tests.ps1
pwsh -NoProfile -File ..\shared\windows-native\WindowsNative.Tests.ps1
```

本共享版的验证结果见根目录 [VALIDATION.md](../VALIDATION.md)。缺少 PATH 时使用自己电脑上已核验的运行时绝对路径。这组测试不发卡、不提交答案、不注册任务、不修改真实部署；启动器测试在非同步临时目录编译与运行合成子进程，核对无控制台、退出码、管道排空和异常退出清理。

仓库只保留源码、测试、说明与版本清单。配置、密钥、消息/答案状态、真实数据库、日志、快捷方式、截图、回执和运行时不入 GitHub。共享版维护规则见 [COMMUNITY.md](../COMMUNITY.md)。
