[CmdletBinding()]
param(
    [string]$DysonServerRoot,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$DysonServerRoot = if ([string]::IsNullOrWhiteSpace($DysonServerRoot)) { Join-Path $PSScriptRoot '..\..\server' } else { $DysonServerRoot }
$OutputDirectory = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { Join-Path $PSScriptRoot '..\dist\bridge' } else { $OutputDirectory }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverRoot = [IO.Path]::GetFullPath($DysonServerRoot)
$project = Join-Path $projectRoot 'integrations\bridge\DysonControlBridge.csproj'
$tests = Join-Path $projectRoot 'integrations\bridge\protocol-tests\DysonControlBridge.ProtocolTests.csproj'
$output = [IO.Path]::GetFullPath($OutputDirectory)
$references = [ordered]@{
    BepInEx = 'BepInEx\core\BepInEx.dll'
    AssemblyCSharp = 'DSPGAME_Data\Managed\Assembly-CSharp.dll'
    UnityEngine = 'DSPGAME_Data\Managed\UnityEngine.dll'
    UnityEngineCore = 'DSPGAME_Data\Managed\UnityEngine.CoreModule.dll'
    Netstandard = 'DSPGAME_Data\Managed\netstandard.dll'
    NebulaAPI = 'BepInEx\plugins\nebula-NebulaMultiplayerModApi\NebulaAPI.dll'
    NebulaModel = 'BepInEx\plugins\nebula-NebulaMultiplayerMod\NebulaModel.dll'
    NebulaWorld = 'BepInEx\plugins\nebula-NebulaMultiplayerMod\NebulaWorld.dll'
    WebSocketSharp = 'BepInEx\plugins\nebula-NebulaMultiplayerMod\websocket-sharp.dll'
}

foreach ($entry in $references.GetEnumerator()) {
    $path = Join-Path $serverRoot $entry.Value
    $item = Get-Item -LiteralPath $path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reference is a reparse point: $($entry.Key)" }
}

& dotnet run --project $tests -c Release --nologo -p:NuGetAudit=false
if ($LASTEXITCODE -ne 0) { throw 'Bridge protocol tests failed.' }
& dotnet build $project -c Release --nologo -p:NuGetAudit=false "-p:DysonServerRoot=$serverRoot"
if ($LASTEXITCODE -ne 0) { throw 'Bridge target build failed.' }

$dll = Join-Path $projectRoot 'integrations\bridge\bin\Release\net472\DysonControlBridge.dll'
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath $dll -Destination (Join-Path $output 'DysonControlBridge.dll') -Force
$referenceEvidence = foreach ($entry in $references.GetEnumerator()) {
    $item = Get-Item -LiteralPath (Join-Path $serverRoot $entry.Value)
    [ordered]@{
        name = $entry.Key
        file = $entry.Value
        assemblyVersion = [Reflection.AssemblyName]::GetAssemblyName($item.FullName).Version.ToString()
        bytes = $item.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()
    }
}
$candidate = Get-Item -LiteralPath (Join-Path $output 'DysonControlBridge.dll')
$manifest = [ordered]@{
    schema = 1
    pluginVersion = '0.1.0'
    builtAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    dll = [ordered]@{ file = $candidate.Name; bytes = $candidate.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate.FullName).Hash.ToLowerInvariant() }
    references = @($referenceEvidence)
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'bridge-manifest.json') -Encoding utf8
$unexpectedOutput = @(Get-ChildItem -LiteralPath $output -Force | Where-Object {
    $_.PSIsContainer -or $_.Name -notin @('DysonControlBridge.dll', 'bridge-manifest.json')
})
if ($unexpectedOutput.Count -ne 0) {
    throw "Bridge output contains unexpected files; game and third-party assemblies must never be published: $($unexpectedOutput.Name -join ', ')"
}
$manifest | ConvertTo-Json -Depth 5
