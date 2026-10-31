param([string]$NodePath = (Get-Command node.exe).Source)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporaryRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$fixture = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('dyson-steam-terminal-' + [guid]::NewGuid().ToString('N'))))
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '.NET Framework C# compiler is required for the native console fixture.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\server\steam-terminal.js'))) { throw 'Build the server before running the native console fixture.' }
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $program = @'
using System;
class ConsoleFixture {
  static int Main(string[] args) {
    if (args.Length != 3 || args[0] != "+login" || args[1] != "fixture_native_account" || args[2] != "+quit") return 3;
    Console.Write("password:");
    if (Console.ReadLine() != "Fixture-Password-Only-18") return 4;
    Console.Write("\nSteam Guard code:");
    if (Console.ReadLine() != "QATEST") return 5;
    Console.WriteLine("\nLogin complete.");
    return 0;
  }
}
'@
  $source = Join-Path $fixture 'ConsoleFixture.cs'
  $executable = Join-Path $fixture 'steamcmd.exe'
  [IO.File]::WriteAllText($source, $program, [Text.UTF8Encoding]::new($false))
  & $compiler /nologo /target:exe (('/out:' + $executable)) $source
  if ($LASTEXITCODE -ne 0) { throw 'Unable to compile the console fixture.' }
  $test = @'
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [project, root] = process.argv.slice(2);
const { SteamAuthManager } = await import(pathToFileURL(path.join(project, 'dist/server/steam-auth.js')));
const config = { mode: 'windows', dataDirectory: path.join(root, 'data'), game: { steam: { executable: path.join(root, 'steamcmd.exe'), accountName: 'fixture_native_account' } } };
const manager = new SteamAuthManager(config, { timeoutMs: 15000, run: async ({args}) => {
  assert.deepEqual(args, ['+login', 'fixture_native_account', '+app_info_update', '1', '+app_info_print', '1366540', '+quit']);
  return { exitCode: 0, stderr: '', stdout: '"branches" { "public" { "buildid" "12345" } }' };
}});
async function waitFor(expected) {
  for (let n = 0; n < 120; n++) {
    const state = manager.status('fixture-owner');
    if (state.state === expected) return state;
    assert.notEqual(state.state, 'failed', 'Native console flow failed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Native console did not reach ${expected}`);
}
try {
  const started = await manager.start('fixture-owner', 'fixture_native_account');
  const password = await waitFor('password');
  manager.input('fixture-owner', started.id, password.promptId, 'Fixture-Password-Only-18');
  const guard = await waitFor('guard');
  manager.input('fixture-owner', started.id, guard.promptId, 'QATEST');
  const authorized = await waitFor('authorized');
  assert.equal(authorized.latestBuild, '12345');
  assert.doesNotMatch(JSON.stringify(authorized), /Fixture-Password-Only-18|QATEST/);
  assert.equal(manager.busy, false);
  await new Promise(resolve => setTimeout(resolve, 3100));
  const second = await manager.start('fixture-owner', 'fixture_native_account');
  await waitFor('password');
  assert.equal((await manager.cancel('fixture-owner', second.id)).state, 'cancelled');
  assert.equal(manager.busy, false);
  console.log('STEAM_TERMINAL_FIXTURE_OK: native prompts, password and Guard input, clean exit, reusable verification and cancellation');
} finally { await manager.close(); }
'@
  $testFile = Join-Path $fixture 'test.mjs'
  [IO.File]::WriteAllText($testFile, $test, [Text.UTF8Encoding]::new($false))
  & $NodePath $testFile $projectRoot $fixture
  if ($LASTEXITCODE -ne 0) { throw 'Native console fixture failed.' }
  $remaining = @(Get-CimInstance Win32_Process -Filter "Name='steamcmd.exe'" | Where-Object { $_.ExecutablePath -eq $executable })
  if ($remaining.Count) { throw 'Native console fixture left a SteamCMD process.' }
} finally {
  $resolved = [IO.Path]::GetFullPath($fixture)
  if (-not $resolved.StartsWith($temporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'dyson-steam-terminal-*') { throw 'Fixture cleanup escaped the temporary directory.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
