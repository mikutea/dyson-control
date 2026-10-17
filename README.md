# Dyson Control

戴森球计划 Nebula 多人服务器管理面板。一个管理员、一套 API、一个持久化任务队列，直接管理游戏运行、存档、模组和客户端配置包。

这是独立重新实现的项目。完整交付目标见 [GOAL.md](GOAL.md)，实现结构见 [架构说明](docs/architecture.md)。演示环境用于开发和交互测试；实际部署、游戏内操作和外部玩家加入需要单独验证。

运维说明：[后台监控与玩家历史](docs/monitoring.md)、[Steam 更新](docs/steam-updates.md)、[版本锁定](docs/version-locks.md)、[部署与实际验收](docs/acceptance.md)。

## 本地运行

需要 Node.js 24 LTS 和 npm。Windows 游戏操作另需 Windows PowerShell 5.1。

```powershell
npm ci
npm run admin -- init-demo
npm run build
npm start
```

初始化时设置至少 12 字符的管理员密码。默认在 `http://127.0.0.1:13020` 打开面板。配置写入 `control.config.json`，运行数据写入 `.data/`；两者均不会提交到源码仓库。演示页面有醒目标识，不连接实际游戏。

开发时分别运行 `npm run dev` 和 `npm run dev:web`；界面开发地址为 `http://127.0.0.1:5174`，API 请求转发到本地控制服务。

```powershell
npm run typecheck
npm test
npm run build
```

## 配置实际服务器

复制 `control.config.example.json` 为私有配置，填入游戏目录、存档目录、备份目录和启动计划任务名称。停止服务器由游戏内 Bridge 接受签名请求并退出进程，不需要独立的停止计划任务。使用 `npm run admin -- hash-password` 生成密码散列，替换示例占位值，再运行 `npm run admin -- validate-config control.config.json`。

`DYSON_CONTROL_CONFIG` 可指定另一配置文件。面板与游戏应运行在同一台 Windows 主机，且面板账户需要读取游戏进程、相关目录和管理任务的权限。游戏内保存需要 Bridge；未经游戏内确认的写盘不会显示为保存成功。

Windows 首次部署顺序见 [安装、升级与卸载](docs/installation.md) 和 [游戏与 Bridge 接入](docs/game-configuration.md)。游戏接入先生成只读审查计划，再在停机后应用；脚本不会立即启动游戏或迁移存档。

游戏与存档继续保留在指定持久化目录。面板源码、公开发布包和任务日志不得包含管理员密码、Bridge 密钥、玩家资料或真实存档。

管理服务默认只监听回环地址。远程访问通过部署者配置的 HTTPS 入口接入；游戏协议连接需要独立配置和验证。

## 日常使用

- **服务器**：查看状态，启动、保存、停止和重启。会中断连接的操作先确认，进度和结果保存在活动记录。
- **存档**：将游戏文件和配套数据作为一组备份、下载和恢复；恢复前自动保留原数据。
- **模组与版本**：查看安装内容与可用更新，在执行结果中确认变更是否完成。
- **模组适用端**：依据作者说明确认当前版本用于服务器、客户端或两端，再生成客户端包；详见[适用端说明](docs/mod-requirements.md)。
- **客户端**：生成 `.r2z` 配置包，下载后交给玩家使用 r2modman 导入；导入时仍需下载所列模组并拥有游戏。
- **设置**：面板名称和连接地址即时使用；启动参数在下一次启动时生效。不受当前游戏接口支持的字段会标记为不可编辑。

## 当前验证边界

本项目正在完成从零重建与集中联调。类型检查、构建和本地演示验证用于发现代码问题；它们不证明真实游戏保存、更新、无人值守恢复或外部客户端已通过验收。完整完成标准以 `GOAL.md` 为准。
## 面板自身更新

面板更新源、下载校验、安装结果回执与手动维护边界见 [面板自身更新](docs/control-updates.md)。
