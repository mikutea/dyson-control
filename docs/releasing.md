# 发布准备

发布以一个明确的源码提交和一组不可混用的产物为单位。准备候选包不会发布 GitHub Release，也不会改动任何已部署实例。

## 准备候选

1. 确认 `package.json`、`package-lock.json`、Bridge 插件版本和 `docs/releases/v<version>.md` 一致。Bridge 按支持的游戏与 Nebula 引用构建，不打包这些第三方程序集。
2. 在干净的 Git 工作区运行 `node scripts/prepare-release.mjs --bridge-dir <Bridge目录> --out-dir <新目录>`。输出包含完整包、仅面板包、各自 `.sha256`、总校验表、版本说明与公开产物证据。
3. 核对 `release-evidence.json` 的 `sourceCommit` 与目标提交一致，并保留这个提交通过 CI 的记录。不能把另一个提交的 CI 结果用于新产物。
4. 按安装指南在独立目录验证生产依赖与使用流程。Windows CI 会用仅生产依赖的安装目录，以 `SYSTEM` 身份验证原生 Steam 授权控制台的密码提示、Guard 输入、完成和取消，并覆盖首次安装、升级和失败回滚后的运行目录。控制台夹具使用本地测试程序，不登录真实 Steam 账号；实际授权与入服证据另行保留。

## 发布文件

公开版本包含下面的文件，名称保持与打包结果一致：

```text
dyson-control-v<version>-windows.zip
dyson-control-v<version>-windows.zip.sha256
dyson-control-v<version>-windows-panel-only.zip
dyson-control-v<version>-windows-panel-only.zip.sha256
SHA256SUMS
release-evidence.json
```

使用 `RELEASE_NOTES.md` 作为版本说明的基础。说明应交代完整包与仅面板包的用途、Windows/Node/Steam 会话要求，以及无人持续模拟、无人值守和容量的实测边界。候选版发布为预发布时保留候选标识；公开稳定版需移除候选措辞，并确认其行为符合首版交付口径。

创建 `v<version>` 标签时使其指向产物证据中的源码提交。上传后重新下载公开的两个 ZIP，核对大小、SHA-256 与各自校验文件，并检查版本说明中的下载入口。

面板更新器只发现配置仓库中非草稿、非预发布的合适版本，使用 `-windows-panel-only.zip` 及其同名校验文件。首次安装用户则下载完整包。只上传其中一种包会使另一条使用路径缺少所需文件。

最后从当前已安装版本执行一次独立升级，检查持久化回执、新版本 PID、原有数据和失败回滚路径。真实游戏或网络未执行的验证在版本说明中保持原有边界；不要把安装器健康检查写成真实入服验证。
