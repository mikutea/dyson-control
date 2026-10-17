# 模组适用端与客户端包

Thunderstore 的标准包清单包含名称、版本和依赖等信息，没有统一的客户端/服务器适用端字段。因此面板不会把未声明的模组自动当作“两端使用”，也不会采信任意包中的非标准 `side` 字段。

面板内置确认 Nebula、Nebula API 和 BepInEx 为两端组件，Dyson Control Bridge 仅用于服务器。其他模组在“已安装”中显示“适用端待确认”。管理员应查看当前版本作者的说明，再选择“两端使用”“仅服务器”或“仅客户端”。确认记录保存在私有数据目录，按模组和具体版本绑定；更新版本后需要重新确认。

这项设置控制客户端包内容，不移动、不停用服务器上的文件。生成 `.r2z` 时会排除已停用和仅服务器模组，并要求所有已启用模组的适用端已确认、Thunderstore 包身份已识别、安装版本可精确表达。客户端仍须实际导入并入服验证兼容性。

依据：[Thunderstore 包格式](https://wiki.thunderstore.io/mods/creating-a-package)、[Nebula 安装说明](https://github.com/NebulaModTeam/nebula/wiki/Installation)。
