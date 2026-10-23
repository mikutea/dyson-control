[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BridgeDll,
    [Parameter(Mandatory = $true)][string]$DysonServerRoot
)

$ErrorActionPreference = 'Stop'
$cecilPath = Join-Path $DysonServerRoot 'BepInEx\core\Mono.Cecil.dll'
[void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($cecilPath))
$resolver = New-Object Mono.Cecil.DefaultAssemblyResolver
$resolver.AddSearchDirectory((Join-Path $DysonServerRoot 'BepInEx\core'))
$resolver.AddSearchDirectory((Join-Path $DysonServerRoot 'DSPGAME_Data\Managed'))
$parameters = New-Object Mono.Cecil.ReaderParameters
$parameters.AssemblyResolver = $resolver
$assembly = [Mono.Cecil.AssemblyDefinition]::ReadAssembly([IO.Path]::GetFullPath($BridgeDll), $parameters)
try {
    if ($assembly.MainModule.HasDebugHeader) {
        $codeView = @($assembly.MainModule.GetDebugHeader().Entries | Where-Object { [string]$_.Directory.Type -ceq 'CodeView' })
        if ($codeView.Count -gt 0) { throw 'The release Bridge must not embed a CodeView PDB path; release bundles do not distribute symbols.' }
    }
    $plugin = @($assembly.MainModule.Types | Where-Object { $_.FullName -ceq 'DysonControl.Bridge.DysonControlBridgePlugin' })
    if ($plugin.Count -ne 1) { throw 'Expected the compiled Bridge plugin type.' }
    $dependencies = @($plugin[0].CustomAttributes | Where-Object { $_.AttributeType.FullName -ceq 'BepInEx.BepInDependency' })
    $nebula = @($dependencies | Where-Object { [string]$_.ConstructorArguments[0].Value -ceq 'dsp.nebula-multiplayer' })
    if ($nebula.Count -ne 1 -or [int]$nebula[0].ConstructorArguments[1].Value -ne 1) {
        throw 'The Bridge must retain its hard dependency on the Nebula multiplayer runtime.'
    }
    # Nebula v0.9.22 LobbyRequestProcessor.CheckMods requires client parity for
    # IMultiplayerMod implementations and all direct Nebula API dependencies.
    $requiresClient = @($dependencies | Where-Object { [string]$_.ConstructorArguments[0].Value -ceq 'dsp.nebula-multiplayer-api' }).Count -gt 0
    $requiresClient = $requiresClient -or @($plugin[0].Interfaces | Where-Object {
        $_.InterfaceType.FullName -in @('NebulaAPI.Interfaces.IMultiplayerMod', 'NebulaAPI.Interfaces.IMultiplayerModWithSettings')
    }).Count -gt 0
    if ($requiresClient) { throw 'The server-only Bridge must not require client installation during the Nebula handshake.' }
    Write-Output 'PASS: compiled Bridge has no PDB path, retains Nebula load order, and is excluded from client mod parity checks.'
}
finally { $assembly.Dispose(); $resolver.Dispose() }
