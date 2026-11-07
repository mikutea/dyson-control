# Windows 安装、升级与卸载

Dyson Control 的程序版本、私有配置和运行数据必须分开保存。推荐布局如下：

```text
C:\Program Files\Dyson Control\
  install-state.json
  versions\0.1.10\
  rollback\...
C:\ProgramData\Dyson Control\
  control.config.json
  data\
```

计划任务以 `SYSTEM` 身份在 Windows 启动时运行编译后的 `dist/server/index.js`。配置文件路径由安装程序写进该版本的固定启动器，不放进版本目录或公开发布包。游戏、存档和备份仍保留在配置指定的持久化目录。

每个运行中的面板独占其配置的 `dataDirectory`。同一数据目录中的第二个面板即使使用其他端口，也会在恢复任务前退出。在一台主机上运行多套服务器时，请给每套服务器使用独立的游戏目录、数据目录、计划任务和监听端口。面板关闭或进程意外退出时，系统会释放 `panel-owner.sqlite` 的文件锁。请将这个文件保留在数据目录中。

从尚未使用此锁的旧版本升级时，请先停止旧面板进程，再启动新版本。面板会在恢复任务前试绑定配置的固定监听地址和端口，地址已占用时直接退出，正式启动时再次绑定。旧版若在其他端口使用同一数据目录，仍需先停止旧进程。安装程序和 `npm start` 均通过 `startServer` 取得所有权。直接调用底层 `buildApp` 的程序需自行隔离数据目录。

## 要求与边界

- Windows 10 1809、Windows Server 2019 或更新版本，Windows PowerShell 5.1。
- 全局安装 Node.js 24 或更新版本，并可使用配套的 `npm.cmd`。
- 安装、升级和卸载计划任务时使用管理员 PowerShell。准备发布包和配置无需管理员权限。
- 默认配置必须监听 `127.0.0.1`。远程管理应在回环监听前配置独立的 HTTPS 反向代理。`-AllowNonLoopback` 只用于部署者明确接受直接监听风险的环境。
- 安装脚本会联网执行 `npm ci --omit=dev --ignore-scripts`，依据发布包中的 `package-lock.json` 安装生产依赖。
- 本地构建、计划任务注册和 HTTP 健康检查不证明实际游戏保存、恢复、外部玩家加入或公网路由已通过验收。

## 生成发布包

完整包包含面板和与该版本匹配的 Bridge 候选文件。先在源码根目录安装锁定依赖，再用实际游戏/Nebula 引用构建 Bridge，最后把明确的 Bridge 输出目录交给发布工具：

```powershell
npm ci
.\scripts\build-bridge.ps1 `
  -DysonServerRoot 'D:\Servers\Dyson Sphere Program' `
  -OutputDirectory .\dist\bridge
node .\scripts\release.mjs `
  --bridge-dir .\dist\bridge `
  --out-dir .\dist\release
```

需要只分发面板时必须显式声明：

```powershell
node .\scripts\release.mjs --panel-only --out-dir .\dist\release
```

CI 使用 `--panel-only`，因为公共构建机没有受控的游戏/Nebula 引用。`--bridge-dir` 与 `--panel-only` 互斥；两者都省略时，工具只会尝试验证源码根目录下现有的 `dist\bridge`，缺失或不合格会直接失败，不会静默降级为面板包。

发布工具重新编译服务端与网页，随后生成版本化 ZIP 和同名 `.sha256` 文件。每个 ZIP 根目录都有严格的 `release-manifest.json`：`kind` 为 `complete` 或 `panel-only`，后者的 `bridge` 必须为 `null`。完整包名为 `dyson-control-v<version>-windows.zip`；面板包名带 `-windows-panel-only.zip`。

两个包都会收录：

- `dist/server`、`dist/shared` 和 `dist/web` 的运行构建；
- `package.json`、`package-lock.json` 与 GPL-3.0 `LICENSE`；
- `scripts/windows` 下的受控 Windows 脚本；
- `control.config.example.json`、`README.md`、`GOAL.md`、`docs` 和 `release-manifest.json`。

完整包另外只收录 `dist\bridge\DysonControlBridge.dll` 与 `dist\bridge\bridge-manifest.json`。构建清单保留 DLL 以及九项编译引用的相对文件名、程序集版本、大小和 SHA-256 证据，不收录游戏、BepInEx、Nebula 或 websocket-sharp 程序集。发布工具要求 Bridge 目录恰好只有这两个文件，并交叉核对版本、DLL 大小、哈希、PE 文件头和完整引用集合。

工具通过显式允许列表收集文件，并拒绝测试、临时目录、真实配置、数据库、日志、备份、私钥、常见令牌格式和已知私有部署路径。它不会收录 `node_modules`、`control.config.json`、`.data` 或 `state`。

准备可供发布的同一提交产物时，先提交已审查的源码，在干净的 Git 工作区运行：

```powershell
node .\scripts\prepare-release.mjs `
  --bridge-dir .\dist\bridge `
  --out-dir .\dist\release-candidate
```

此命令依次生成完整包、仅面板包及各自的 `.sha256`，复读 ZIP 校验文件内容，并逐文件确认两种包的共用内容完全一致，再生成 `SHA256SUMS`、`RELEASE_NOTES.md` 和 `release-evidence.json`。Bridge 身份从归档内读取；证据文件仅记录公开版本、源码提交、文件数、构建身份和产物散列，不包含主机路径。输出目录必须不存在，源码有未提交变更时会拒绝打包；命令不创建 Git 标签、不上传或发布 Release。

发布时使用该提交通过检查后的两个 ZIP 和对应校验文件。完整包服务首次安装，面板更新器使用仅面板包。先确认发布说明与实际验证一致，再创建公开版本；具体步骤见[发布准备](releasing.md)。

分发前在发布目录验证校验值：

```powershell
$zip = Resolve-Path .\dyson-control-v0.1.10-windows.zip # 替换为下载的版本；面板包使用 *-windows-panel-only.zip
$expected = ((Get-Content "$zip.sha256" -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SHA-256 mismatch.' }
```

从浏览器下载的 ZIP 可能带有 Windows 网络来源标记。校验通过并解压后，仅解除本发布包脚本的标记：

```powershell
Get-ChildItem 'C:\Temp\dyson-control-release\scripts\windows\*.ps1' | Unblock-File
```

## 准备私有配置

先将发布 ZIP 解压到临时目录。准备新服务器时，可以直接生成配置，无需手工编辑 JSON 或粘贴密码散列。在 PowerShell 中运行：

```powershell
$release = 'C:\Temp\dyson-control-release'
$privateRoot = 'C:\ProgramData\Dyson Control'
New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null
Push-Location $release
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node .\dist\server\admin.js check-runtime
node .\dist\server\admin.js init-windows "$privateRoot\control.config.json" `
  --server-root 'D:\Dyson' `
  --address 'game.example.com:8469' `
  --name 'Dyson Server'
node .\dist\server\admin.js validate-config "$privateRoot\control.config.json"
Pop-Location
```

将 `D:\Dyson` 换成自己的持久化存储目录，示例域名换成自己的游戏地址。按提示输入并确认至少 12 字符的管理员密码，输入不会回显，配置中只保存 scrypt 散列。不要在命令参数中传密码。

生成的配置默认保持回环监听；可用 `--port 13021` 更改面板端口。省略 `--address` 时，游戏地址默认为本机 `127.0.0.1:8469`，适合先完成本机配置，之后再修改为实际分享地址。

希望从面板检查自身更新时，在初始化命令中追加 `--updates-repository 'mikutea/dyson-control'`；使用其他分发仓库时替换为自己信任的 `owner/repository`。此选项只保存明确选择的更新来源，不下载或安装更新。省略时不配置更新源，已有配置可按[面板自身更新](control-updates.md)调整。仓库尚无正式 Release 时，页面会说明暂无可验证版本。

| 内容 | 上述示例的路径 |
| --- | --- |
| 私有配置 | `C:\ProgramData\Dyson Control\control.config.json` |
| 面板数据 | `C:\ProgramData\Dyson Control\data` |
| 游戏文件 | `D:\Dyson\game` |
| 存档与备份 | `D:\Dyson\userdata\Save`、`D:\Dyson\backups` |
| Bridge 通信与密钥 | `D:\Dyson\bridge`、`D:\Dyson\private\bridge-secret` |

初始化只创建这一份配置；已有同名文件会被保留，命令不会下载或启动游戏，也不注册 Windows 任务。游戏与数据目录会由后续安装流程按需准备。

接入已有游戏或使用其他目录布局时，仍可复制 `control.config.example.json` 后自行调整：各目录应使用版本目录之外的绝对路径，`host` 保持回环监听。使用 `node .\dist\server\admin.js hash-password` 生成管理员散列，随后通过 `validate-config` 检查配置。

不要把密码、散列后的私有配置、Bridge 密钥或真实服务器路径提交到仓库或重新打进 ZIP。配置确认后可用本地化无关的 SID 限制读取权限：

```powershell
icacls "$privateRoot\control.config.json" /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)'
```

## 首次安装

在管理员 Windows PowerShell 5.1 中运行：

```powershell
$release = 'C:\Temp\dyson-control-release'
$config = 'C:\ProgramData\Dyson Control\control.config.json'
& "$release\scripts\windows\install-control.ps1" `
  -SourcePath $release `
  -InstallRoot 'C:\Program Files\Dyson Control' `
  -ConfigPath $config `
  -TaskName 'Dyson-Control'
```

安装程序会验证 Node.js 24、发布目录、`release-manifest.json`、绝对配置路径、回环监听和数据目录隔离；安装锁定的生产依赖；在暂存目录实际打开内存 SQLite，并启动隐藏的原生控制台子进程，再验证配置。通过后复制到 `versions/<package-version>`、注册唯一的开机计划任务、启动服务并检查 `/healthz`。只有产品名、包版本、进程 PID、实际 Node 命令中的版本根目录都匹配，且服务明确返回 `accepting: true` 时才写入安装状态。

`check-runtime` 不访问 Steam、不启动游戏、不修改配置；可在解压并安装生产依赖后手工运行。自检失败时检查 Windows 与 Node 版本，并从锁定文件重新安装依赖；不要从其他 Node 版本的目录复制 `node_modules`。升级也会在暂停旧面板之前完成相同自检。

完整包安装成功后，输出会明确显示 `Release: complete`、Bridge 候选目录和已核验的 SHA-256；候选文件保留在 `versions\<package-version>\dist\bridge`，安装程序不会直接替换游戏中的插件。面板包会明确显示 `Release: panel-only`，版本目录中没有 Bridge 候选文件，也不会更改游戏目录。

安装失败不会删除私有配置或 `dataDirectory`。脚本只清理本次创建且尚未启用的随机暂存目录；若失败发生在版本目录改名之后，同一发布内容再次安装时会核验 `.installing.json` 中的安装根、版本和内容指纹，确认没有进程使用后才清理该目录。已有安装状态、同名任务、不同内容的同版本目录或无法证明归属的目录都会被拒绝。

npm 的嵌套依赖可能使文件路径超过 260 字符。安装与升级统一使用已验证的 Node.js 运行时清理这类失败暂存目录，避免 Windows PowerShell 5.1 的递归删除限制；不需要修改系统长路径开关或缩短 TEMP。清理只接受指定 `versions` 下的直接子目录，拒绝清理根或其父路径经过目录链接；目录内部的链接只移除链接本身。若清理另有失败，会同时保留原始安装/升级错误。卸载仍保留所有版本与用户数据。

若 Node.js 或 npm 不在 PATH 中，可显式传入 `-NodePath` 和 `-NpmPath`。`-TaskName` 只接受字母、数字、空格、点、下划线和连字符，安装状态会记录精确名称供升级和卸载核对。

服务首次安装后，完整包用户可打开[安装与授权](server-setup.md)，在空游戏目录中一键安装服务器。现有游戏接入仍按 [Windows 游戏与 Bridge 接入](game-configuration.md) 使用当前安装版本的 `configure-game.ps1`：先运行 `-PrepareOnly` 审查计划，真正应用要求游戏已停止、管理员 PowerShell 和显式 `-ConfirmStopped`。面板包可修复 Steam 授权，但首次安装服务器需要完整包。两个接入流程都不自动启动游戏或迁移存档。

## 升级与自动回退

跨版本升级前，先给面板数据留一份可读的回退副本。若采用文件复制，在维护窗口等待队列排空、确认旧面板进程已正常退出后，再复制私有配置和完整 `dataDirectory`，并保留旧版本目录与安装状态。游戏存档按整组另行备份。需要演练时，用隔离的游戏、存档、备份目录和任务名称启动数据副本，检查原有任务回执、玩家记录、存档下载和客户端包。验证旧版回退时使用升级前的数据副本。

验证并解压新发布包后，在管理员 PowerShell 中运行新包里的升级脚本：

```powershell
$release = 'C:\Temp\dyson-control-new-release'
& "$release\scripts\windows\upgrade-control.ps1" `
  -SourcePath $release `
  -InstallRoot 'C:\Program Files\Dyson Control' `
  -TaskName 'Dyson-Control'
```

升级程序从 `install-state.json` 读取原配置、数据和 Node 路径。它先导出当前计划任务 XML 并备份安装状态，再把新版本装入新的版本目录。切换前，脚本在 `dataDirectory` 原子创建带随机 token 和请求进程 PID 的维护 marker；当前 `/healthz` 必须由安装状态指定版本根下的精确 PID 回认同一 token，并返回 `accepting: false`。此时新提交会被拒绝，已排队任务继续执行。脚本连续确认数据库中 `queued`/`running` 为 0，且 `uploads` 中没有 `.part` 事务文件后，才停止计划任务。

新版本在同一 marker 下启动并保持暂停；脚本核验新包版本、新 PID、新版本根和同一 token 后，才原子写入新安装状态。最后只删除自己 token 对应的 marker，并确认同一新 PID 恢复 `accepting: true`。任一步失败时，脚本在维护屏障仍生效时恢复任务定义和旧安装状态，启动旧版本，再释放自己的 marker 并确认旧进程恢复接单。旧版本目录、失败的新版本和回退证据均保留，便于诊断。

升级输出同样报告包种类。完整包的新 Bridge 仍只是新版本目录中的候选文件；需要另行执行 `configure-game.ps1 -PrepareOnly` 审查，再在游戏已停止时用 `-ConfirmStopped` 应用。面板包升级不会复制 Bridge 候选，也不会接触已经部署到游戏中的 Bridge；游戏端插件保持原状，直到部署者以后明确执行游戏配置流程。

`rollback/<timestamp>-<old-version>` 中的 XML 和状态副本是自动回退证据，不是可直接在线执行的回退命令。当前脚本只自动处理本次升级失败；不要绕过维护 marker 直接运行 `Stop-ScheduledTask` 做人工回退，因为这会重新引入“刚判断空闲就收到新任务”的竞态。需要计划性降级时，应先按同样的 token 回认、拒绝新任务和持久化排空流程准备单独的受审变更。

## 健康检查

配置默认端口为 `13020` 时：

```powershell
Get-ScheduledTask -TaskName 'Dyson-Control' -TaskPath '\' | Format-List TaskName,State,Description
Get-ScheduledTaskInfo -TaskName 'Dyson-Control' -TaskPath '\' | Format-List LastRunTime,LastTaskResult
Invoke-RestMethod 'http://127.0.0.1:13020/healthz'
Invoke-RestMethod 'http://127.0.0.1:13020/api/session'
```

先调用 `Invoke-RestMethod 'http://127.0.0.1:13020/healthz'`，确认 `product`、`version`、`processId`、`accepting: true` 和 `maintenanceToken: null`；再检查 `/api/session`。未登录 session 响应应为 HTTP 200，且 `data.authenticated` 为 `false`。运行日志位于私有 `dataDirectory` 下的 `control.stdout.log` 和 `control.stderr.log`。随后检查自己的管理员登录、Windows 游戏任务、Bridge 保存和存档恢复；需要远程管理或外网联机时，按[连接自己的服务器](networking.md)配置并检查相应入口。游戏重启恢复的限制见 [README](../README.md#已知限制)。

## 卸载计划任务

卸载脚本只停止并删除安装状态中精确匹配、描述也属于 Dyson Control 的计划任务。若服务正在运行，它会执行与升级相同的 token 回认和持久化排空，确认精确版本/PID 已暂停接单后才停止；卸载失败且任务仍存在时会恢复原服务并释放自己的 marker：

```powershell
& 'C:\Program Files\Dyson Control\versions\0.1.10\scripts\windows\uninstall-control.ps1' `
  -InstallRoot 'C:\Program Files\Dyson Control' `
  -TaskName 'Dyson-Control'
```

脚本不会删除版本目录、`install-state.json`、配置、数据库、日志、备份、存档或游戏文件。确认不再需要后，部署者可根据输出路径单独归档或处理程序版本；不要使用通配符清理持久化目录。
