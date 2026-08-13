$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$noEnv = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

foreach ($arg in $args) {
	if ($arg -eq "--no-env") {
		$noEnv = $true
	} else {
		$forwardArgs.Add($arg)
	}
}

if ($noEnv) {
	$tsxBin = Join-Path $repoRoot "node_modules/.bin/tsx.cmd"
	$envListPath = Join-Path $repoRoot "scripts/list-provider-auth-env.ts"
	$envVarsToUnset = @(& $tsxBin --tsconfig (Join-Path $repoRoot "tsconfig.json") $envListPath) + @("GH_TOKEN", "GITHUB_TOKEN")

	foreach ($name in $envVarsToUnset) {
		Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
	}

	Write-Host "Running without API keys..."
}

$tsxBin = Join-Path $repoRoot "node_modules/.bin/tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxBin)) {
	throw "tsx not found at $tsxBin. Run npm install from the repo root first."
}

$cliPath = Join-Path $repoRoot "packages/coding-agent/src/cli.ts"
& $tsxBin $cliPath @forwardArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
