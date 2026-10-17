# Windows 游戏与 Bridge 接入

`configure-game.ps1` 把已安装的 Dyson Control 版本接到同机 DSP/Nebula 服务器。它读取私有 `control.config.json`，部署指定哈希的 Bridge，创建固定启动设置，并注册由面板按需调用的游戏启动任务。脚本不移动存档，也不会立即启动任务。

## 前提

- 先完成 Dyson Control 服务安装，并确认私有配置通过 `validate-config`。
- 从当前安装版本的 `scripts\windows` 目录运行脚本。任务会绑定该版本旁的受管 `start-game.ps1`；升级程序版本后，应使用新版本脚本重新准备并更新游戏任务。
- 游戏必须已安装 BepInEx 与 Nebula，`DSPGAME.exe`、存档目录、备份目录和 `dataDirectory` 已存在。
- Steam 购入版需要可用的 Steam 登录。Nebula 的[无界面服务器说明](https://github.com/NebulaModTeam/nebula/wiki/Setup-Headless-Server)仍要求登录 Steam，并说明可使用离线模式；`-batchmode -nographics` 不会移除该要求。当前脚本注册 SYSTEM 游戏任务，不能借用其他 Windows 用户的 Steam 会话。请先在隔离副本确认所选运行账户能完成 Steam 初始化；任务注册成功不等于游戏可启动。
- `dataDirectory`、Bridge 控制目录、Bridge secret、受管脚本和 startup settings 必须留在本机 NTFS。游戏、存档、备份和日志可以位于本机固定卷，或使用已经存在且状态健康的 SMB 全局映射盘符。
- 完整发布包已经在当前版本的 `dist\bridge` 中提供经过发布清单核验的候选 DLL 与清洗后的构建清单。面板包不含候选文件，必须从源码用 `scripts\build-bridge.ps1` 另行构建。Bridge 构建或发布核验只证明编译、文件身份与引用证据相容，不证明真实游戏验收完成。

## 路径边界

网络游戏目录只能通过现有 `Get-SmbGlobalMapping` 返回的单盘符映射使用，且状态必须为 `0`/`OK`。脚本不会创建或修复映射，不接收、保存或调用任何 SMB 凭据，也不接受普通用户映射盘或直接配置任意 UNC 路径。进程检查会把该全局映射的盘符路径（例如 `M:\...`）与其精确 `RemotePath\...` UNC 形式规范化后比较；不属于健康全局映射的 UNC 路径不会被视为等价。

`game.root`、`game.saveDirectory`、`game.backupDirectory` 和 `game.logFile` 可使用上述全局映射。SQLite 队列所在的 `dataDirectory`、`game.bridgeDirectory`、`game.bridgeSecretFile`、受管 `start-game.ps1`、配套 `path-policy.ps1` 和 `dataDirectory\game-startup.json` 必须位于本机 NTFS，因此无需为了接入面板迁移游戏或存档。

`-PrepareOnly` 的 `plan.json` 会列明这个边界，但不会注册任务或以 SYSTEM 探测。应用模式在备份、停用旧任务、部署 Bridge 或创建业务目录之前，会注册一个随机命名、无触发器的一次性 SYSTEM 任务。该任务只在每个目标或其最近的已有父目录中创建自身随机探测目录，完成 create/write/read/rename/delete 读回，并读取运行所需文件；随后精确删除自己的文件和任务。任一访问或清理失败都会终止应用，且不会继续修改游戏、存档或面板业务数据。

## 只准备并审查

只准备模式不需要停游戏，也不更改游戏目录、目标 secret、计划任务或存档。输出目录必须尚不存在：

```powershell
$version = 'C:\Program Files\Dyson Control\versions\0.1.0'
$config = 'C:\ProgramData\Dyson Control\control.config.json'
$bridgeBuild = Join-Path $version 'dist\bridge'
$bridgeManifest = Get-Content "$bridgeBuild\bridge-manifest.json" -Raw | ConvertFrom-Json
$bridgeHash = (Get-FileHash "$bridgeBuild\DysonControlBridge.dll" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($bridgeHash -cne [string]$bridgeManifest.dll.sha256) { throw 'Bridge SHA-256 mismatch.' }

& "$version\scripts\windows\configure-game.ps1" `
  -ConfigPath $config `
  -BridgeBuildDirectory $bridgeBuild `
  -BridgeSha256 $bridgeHash `
  -PrepareOnly `
  -OutputDirectory 'C:\Temp\dyson-game-plan'
```

上述路径适用于完整包。若当前安装版本来自面板包，可在受控源码检出中生成独立候选目录，再以同样方式读取清单并重新计算 DLL 哈希：

```powershell
.\scripts\build-bridge.ps1 `
  -DysonServerRoot 'D:\Servers\Dyson Sphere Program' `
  -OutputDirectory 'C:\Temp\dyson-bridge-build'
$bridgeBuild = 'C:\Temp\dyson-bridge-build'
$bridgeManifest = Get-Content "$bridgeBuild\bridge-manifest.json" -Raw | ConvertFrom-Json
$bridgeHash = (Get-FileHash "$bridgeBuild\DysonControlBridge.dll" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($bridgeHash -cne [string]$bridgeManifest.dll.sha256) { throw 'Bridge SHA-256 mismatch.' }
```

审查 `plan.json`、待部署 DLL、`net.miyuo.dyson-control.bridge.cfg` 和默认 `game-startup.json`。当目标 secret 不存在时，输出还包含 ACL 仅允许 SYSTEM 与 Administrators 的 `bridge-secret.new`；`plan.json` 和控制台输出都不包含其值。Bridge 配置只含以下三个键：

```ini
[Bridge]
ControlDirectory = C:\ProgramData\Dyson Control\bridge
SecretFile = C:\ProgramData\Dyson Control\private\bridge-secret
ExpectedSaveDirectory = D:\DysonData\Save
```

## 应用

确认精确的受管 `DSPGAME.exe` 已停止后，在管理员 Windows PowerShell 5.1 中从当前安装版本执行：

```powershell
& "$version\scripts\windows\configure-game.ps1" `
  -ConfigPath $config `
  -BridgeBuildDirectory $bridgeBuild `
  -BridgeSha256 $bridgeHash `
  -ConfirmStopped
```

应用模式会再次核对精确游戏进程，拒绝正在运行的同名任务，并执行这些操作：

1. 验证本机 NTFS 与健康 SMB 全局映射边界，并在任何业务变更前完成且清理一次性 SYSTEM 权限探测。
2. 在 `dataDirectory\game-configuration-backups\<timestamp>-<id>` 保存原 Bridge DLL、原配置及属于本工具的原任务 XML；不存在的项目会记录为 absent。
3. 原子部署哈希匹配的 DLL 与精确三键配置。已有有效 secret 保持原值；缺少时生成 32 字节随机值。secret 及其目录只授权 SYSTEM 和 Administrators，脚本不打印 secret。
4. 保留有效的 `dataDirectory\game-startup.json`，或创建 `{schema:1,targetUps:60,saveName:null}`。
5. 注册根路径下 `game.startTaskName` 指定的任务。任务以 SYSTEM 运行固定 `start-game.ps1` 和固定 startup settings 路径，没有自动触发器。任务自身无需交互登录，但 Steam 版游戏的登录要求仍然存在。

脚本只会更新描述精确为 `DYSON_CONTROL_MANAGED_GAME_START_V1` 的同名任务；任何没有该标记的同名任务都会被拒绝。失败时会尝试恢复原 DLL、配置、任务、startup 文件和 secret ACL，备份证据保留供检查。

成功返回中的 `taskStarted` 为 `false`，且 `savesMoved` 为 `false`。随后通过面板启动一次真实游戏，检查新 PID 的签名 heartbeat，再依次完成受保护的真实保存、受控停止、重启恢复和外部 Nebula 客户端加入；准备输出、任务注册或 Bridge 构建本身不构成这些验收。
