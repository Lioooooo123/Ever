$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
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
	$envVarsToUnset = @(
		"ANTHROPIC_AEVER_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_AEVER_KEY",
		"GEMINI_AEVER_KEY",
		"GROQ_AEVER_KEY",
		"CEREBRAS_AEVER_KEY",
		"XAI_AEVER_KEY",
		"OPENROUTER_AEVER_KEY",
		"ZAI_AEVER_KEY",
		"MISTRAL_AEVER_KEY",
		"MINIMAX_AEVER_KEY",
		"MINIMAX_CN_AEVER_KEY",
		"AI_GATEWAY_AEVER_KEY",
		"OPENCODE_AEVER_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"HF_TOKEN",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AZURE_OPENAI_AEVER_KEY",
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME"
	)

	foreach ($name in $envVarsToUnset) {
		Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
	}

	Write-Host "Running without API keys..."
}

$tsxBin = Join-Path $scriptDir "node_modules/.bin/tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxBin)) {
	throw "tsx not found at $tsxBin. Run npm install from the repo root first."
}

$cliPath = Join-Path $scriptDir "packages/coding-agent/src/cli.ts"
& $tsxBin $cliPath @forwardArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
