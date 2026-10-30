param([Parameter(Mandatory = $true)][string]$Package)

# Refresh a previously packaged development build without rescanning unchanged
# third-party binaries. Changed files receive the same vsce secret checks.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packagePath = (Resolve-Path -LiteralPath $Package).Path
if (-not $packagePath.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package must be inside the extension directory.' }

function Read-ZipText($archive, [string]$name) {
    $reader = [IO.StreamReader]::new($archive.GetEntry($name).Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Source-Path([string]$relative) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid artifact path: $relative" }
    return $path
}

$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    $previous = (Read-ZipText $archive 'extension/runtime/payload-manifest.json') | ConvertFrom-Json
    $packagedVersion = ((Read-ZipText $archive 'extension/package.json') | ConvertFrom-Json).version
} finally { $archive.Dispose() }
$current = Get-Content (Join-Path $root 'runtime/payload-manifest.json') -Raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($current.platform -ne $previous.platform -or $packagedVersion -ne $version) { throw 'Target/version changed; create a new package with vsce.' }
if (($current.sim | ConvertTo-Json -Depth 20 -Compress) -ne ($previous.sim | ConvertTo-Json -Depth 20 -Compress)) { throw 'Bundled simulation runtime changed; create a new package with vsce.' }
$old = @{}
foreach ($item in $previous.files) { $old[$item.path] = $item.sha256 }
$changed = @('dist/extension.js', 'dist/webview.js', 'dist/webview.css', 'runtime/payload-manifest.json')
foreach ($item in $current.files) { if ($old[$item.path] -ne $item.sha256) { $changed += "runtime/$($item.path)" } }
$currentNames = @{}
foreach ($item in $current.files) { $currentNames[$item.path] = $true }
$removed = @($previous.files | Where-Object { -not $currentNames.ContainsKey($_.path) } | ForEach-Object { "runtime/$($_.path)" })
$changed = @($changed | Select-Object -Unique)
$scanInput = Join-Path $root '.vsix-changed-files.json'
@($changed | ForEach-Object { Source-Path $_ }) | ConvertTo-Json | Set-Content -LiteralPath $scanInput -Encoding utf8
Push-Location $root
try {
    node -e 'const fs=require("node:fs");const paths=JSON.parse(fs.readFileSync(".vsix-changed-files.json","utf8").replace(/^\uFEFF/,""));require("@vscode/vsce/out/secretLint.js").lintFiles(paths,true,true).then(r=>{console.log("Changed artifact scan:",r.ok);if(!r.ok)process.exitCode=1;});'
    if ($LASTEXITCODE -ne 0) { throw 'Changed artifact scan failed.' }
} finally { Pop-Location; Remove-Item -LiteralPath $scanInput -Force }

$temporary = "$packagePath.refreshing"
# Both resolved paths are within the already checked extension directory.
Copy-Item -LiteralPath $packagePath -Destination $temporary -Force
$archive = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Update)
try {
    foreach ($relative in @($changed + $removed)) {
        $null = Source-Path $relative
        $entry = $archive.GetEntry("extension/$relative")
        if ($entry) { $entry.Delete() }
    }
    foreach ($relative in $changed) {
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Source-Path $relative), "extension/$relative", [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $archive.Dispose() }
$archive = [IO.Compression.ZipFile]::OpenRead($temporary)
try {
    foreach ($relative in $changed) {
        $stream = $archive.GetEntry("extension/$relative").Open()
        try { $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
        if ($actual -ne (Get-FileHash -LiteralPath (Source-Path $relative) -Algorithm SHA256).Hash) { throw "Archive verification failed: $relative" }
    }
} finally { $archive.Dispose() }
Move-Item -LiteralPath $temporary -Destination $packagePath -Force
Write-Output "Refreshed and verified $($changed.Count) artifacts in $packagePath"
Get-FileHash -LiteralPath $packagePath -Algorithm SHA256
