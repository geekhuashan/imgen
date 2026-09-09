$ErrorActionPreference = 'Stop'

$ProjectDir = $PSScriptRoot
if (-not $ProjectDir -or -not (Test-Path (Join-Path $ProjectDir 'package.json'))) {
    throw '拒绝远程管道安装：请先克隆或打开已审阅的 imgen fork，再从仓库内运行 install-skill.ps1。'
}

$SkillDir = Join-Path $HOME '.agents\skills\imgen'

Push-Location $ProjectDir
try {
    Write-Host '==> Installing locked dependencies...'
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

    Write-Host '==> Testing and building imgen...'
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

    Write-Host '==> Linking imgen CLI globally...'
    npm link
    if ($LASTEXITCODE -ne 0) { throw 'npm link failed' }

    function Install-Skill([string]$SkillDir) {
        if (Test-Path $SkillDir) {
            $item = Get-Item $SkillDir -Force
            if ($item.LinkType) {
                # 已是链接/junction，只删链接本身（.Delete() 不会递归删 target）
                $item.Delete()
            } else {
                throw "拒绝覆盖非链接目录：$SkillDir"
            }
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $SkillDir -Parent) | Out-Null
        # 用 junction 而非 symlink：指向本地目录、无需管理员权限
        New-Item -ItemType Junction -Path $SkillDir -Target $ProjectDir | Out-Null
        Write-Host "  $SkillDir -> $ProjectDir"
    }

    Write-Host '==> Installing the canonical personal skill...'
    Install-Skill $SkillDir

    $syncSharedSkills = Join-Path $HOME '.local\bin\sync-shared-skills'
    if (Test-Path $syncSharedSkills) {
        & $syncSharedSkills --adopt
        if ($LASTEXITCODE -ne 0) { throw 'sync-shared-skills failed' }
    } else {
        Write-Warning "未找到 $syncSharedSkills；个人技能已安装，但共享技能尚未同步。"
    }

    Write-Host ''
    $imgen = (Get-Command imgen -ErrorAction SilentlyContinue).Source
    if ($imgen) {
        Write-Host "Done. imgen CLI: $imgen"
    } else {
        Write-Host 'Done. imgen CLI linked (open a new terminal if `imgen` is not found).'
    }
    Write-Host "Skill: $SkillDir -> $ProjectDir"
} finally {
    Pop-Location
}
