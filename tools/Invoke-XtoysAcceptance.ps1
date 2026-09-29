<#
.SYNOPSIS
  阶段 0 真机验收脚本：逐条向 XToys Webhook 发命令，并记录你的观察结果。

.DESCRIPTION
  一步一条：打印该步要观察什么 → 发一条真实 POST → 等你回答实际观察结果。
  最后给出汇总表，可直接粘进 docs/07-stage0-status-and-todo.md。

  它【不会】替你判断设备行为，也不声称任何"设备已确认" —— 只能记录你看到的现象。
  依据：docs/06-minimal-script-build.md、HANDOFF.md §9.1。

.PARAMETER WebhookId
  XToys Webhook ID。不给则读环境变量 XTOYS_WEBHOOK_ID。
  【不要把真实 ID 写进仓库】。

.PARAMETER Steps
  只跑指定步骤号，例如 -Steps 3,4,5。

.PARAMETER List
  只列出步骤，不发任何请求。

.PARAMETER SkipUnverifiable
  自动跳过"需要旋转器"的步骤（本轮没有旋转器）。

.PARAMETER DryRun
  打印将要发送的请求体，但不实际发送。

.EXAMPLE
  $env:XTOYS_WEBHOOK_ID = "<真实ID>"
  pwsh -File tools/Invoke-XtoysAcceptance.ps1 -List
  pwsh -File tools/Invoke-XtoysAcceptance.ps1 -SkipUnverifiable
#>

[CmdletBinding()]
param(
  [string]$WebhookId = $env:XTOYS_WEBHOOK_ID,
  # 用 [string] 而不是 [int[]]：经过 `pwsh -File ... -Steps 3,13` 传参时，
  # "3,13" 会作为【一个字符串】到达，[int[]] 绑定会失败。这里自己解析。
  [string]$Steps,
  [switch]$List,
  [switch]$SkipUnverifiable,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$source = 'acceptance'

# 解析 -Steps "3,13" / "3, 13" / "3"
$stepFilter = @()
if ($Steps) {
  $stepFilter = $Steps -split ',' |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne '' } |
    ForEach-Object {
      $n = 0
      if ([int]::TryParse($_, [ref]$n)) { $n } else { throw "无法解析步骤号：'$_'" }
    }
  if (-not $stepFilter) { $stepFilter = @() }
}

function New-Payload {
  param([hashtable]$Inner)
  $outer = @{
    action  = 'xtoys_game_bridge'
    payload = ($Inner | ConvertTo-Json -Compress -Depth 10)
  }
  return ($outer | ConvertTo-Json -Compress -Depth 10)
}

function Inner {
  param(
    [string]$Command,
    [int]$Sequence = 1,
    [string]$EventId = $null,
    [array]$Targets = @(),
    [switch]$OmitSequence
  )
  $h = @{ protocolVersion = 1; command = $Command; source = $script:source }
  if (-not $OmitSequence) { $h.sequence = $Sequence }
  if ($EventId) { $h.eventId = $EventId }
  if ($PSBoundParameters.ContainsKey('Targets') -or $Targets.Count -gt 0) { $h.targets = $Targets }
  return $h
}

# ---------------------------------------------------------------- 步骤定义
# 每步：Id / Title / Inner(协议对象) / Expect(应观察到什么) / NeedsRotator

$stepDefs = @()

$stepDefs += @{
  Id = 1; Title = 'E-Stim 低强度持续输出（set_baseline）'; NeedsRotator = $false
  Expect = 'E-Stim 通道出现【低强度】持续输出。请先用你确认安全的很小的数值；不要用高档位开始。'
  Inner = (Inner -Command 'set_baseline' -Sequence 1 -Targets @(
      @{ part = 'nipple'; intensity = 15; frequency = 30; rampUpMs = 800 }))
}

$stepDefs += @{
  Id = 2; Title = '振动器低强度持续输出（set_baseline）'; NeedsRotator = $false
  Expect = '振动器出现低强度持续振动。'
  Inner = (Inner -Command 'set_baseline' -Sequence 2 -Targets @(
      @{ part = 'nipple'; intensity = 25; rampUpMs = 600 }))
}

$stepDefs += @{
  Id = 3; Title = 'play 瞬态叠加 + 到期回到基线'; NeedsRotator = $false
  Expect = 'E-Stim 强度短暂增强（约 0.9 秒），然后【回到步骤 1 的基线强度】，而不是归零。同时留意渐入是否大致像 0.3 秒。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-transient' -Targets @(
      @{ part = 'nipple'; intensity = 60; frequency = 30; durationMs = 900; rampUpMs = 300; rampDownMs = 300 }))
}

$stepDefs += @{
  Id = 4; Title = '同强度新事件必须重新渐入（driveId 推送判据）'; NeedsRotator = $false
  Expect = '在基线强度【没有变化】的前提下，再发一个与当前强度相同的短暂事件，应该能看到【又一次渐入脉冲】。若完全没有反应，说明推送判据退化成只比数值了。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-retrigger' -Targets @(
      @{ part = 'nipple'; intensity = 15; frequency = 30; durationMs = 900; rampUpMs = 300; rampDownMs = 300 }))
}

$stepDefs += @{
  Id = 5; Title = 'frequency 显式值生效'; NeedsRotator = $false
  Expect = 'E-Stim 【频率】明显变化（0-100 相对量），强度大体不变。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-freq-hi' -Targets @(
      @{ part = 'nipple'; intensity = 20; frequency = 85; durationMs = 3000; rampUpMs = 0 }))
}

$stepDefs += @{
  Id = 6; Title = 'frequency 缺省 = 保持不变（不改设备当前频率）'; NeedsRotator = $false
  Expect = '发一个【不带 frequency】的命令后：强度按新值变化，但【频率保持上一步 85 不变】。若频率被归零/跳回低值，说明缺省被当成 0 了 —— 这是本轮最关键的语义。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-freq-absent' -Targets @(
      @{ part = 'nipple'; intensity = 45; durationMs = 3000; rampUpMs = 0 }))
}

$stepDefs += @{
  Id = 7; Title = '旋转：速度 + 顺时针'; NeedsRotator = $true
  Expect = '旋转器开始转动。本轮【没有旋转器，无法验证】。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-rot-cw' -Targets @(
      @{ part = 'nipple'; rotateSpeed = 40; rotateDirection = 'clockwise'; durationMs = 4000 }))
}

$stepDefs += @{
  Id = 8; Title = '旋转：显式反向（换向）'; NeedsRotator = $true
  Expect = '旋转方向立刻改变，无中间停顿。本轮【没有旋转器，无法验证】。'
  Inner = (Inner -Command 'update' -Sequence 2 -EventId 'acc-rot-cw' -Targets @(
      @{ part = 'nipple'; rotateSpeed = 40; rotateDirection = 'counterclockwise'; durationMs = 4000 }))
}

$stepDefs += @{
  Id = 9; Title = '多部位独立（不同 Block 互不干扰）'; NeedsRotator = $false
  Expect = 'clitoris 与 nipple 各自输出自己的强度；改变 clitoris 不应影响 nipple。'
  Inner = (Inner -Command 'set_baseline' -Sequence 3 -Targets @(
      @{ part = 'nipple'; intensity = 20; frequency = 30 },
      @{ part = 'clitoris'; intensity = 50; rampUpMs = 500 }))
}

$stepDefs += @{
  Id = 10; Title = 'priority：数值更小但优先级更高的事件接管'; NeedsRotator = $false
  Expect = '强度本来在 20；发一个 intensity=10 但 priority=10 的事件后，输出应【降到 10】（而不是被 20 压住不动）。这验证 priority 是第一级判据。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-priority' -Targets @(
      @{ part = 'nipple'; intensity = 10; frequency = 30; durationMs = 3000; priority = 10; rampUpMs = 0 }))
}

$stepDefs += @{
  Id = 11; Title = '忽略留痕：未识别部位被忽略而不是整体拒绝'; NeedsRotator = $false
  Expect = '设备【没有任何反应】（这是对的）。XToys 日志里应出现 ignored 的说明，且既有输出不受影响。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-unknown' -Targets @(
      @{ part = 'tentacle'; intensity = 90; durationMs = 2000 }))
}

$stepDefs += @{
  Id = 12; Title = '拒绝：同一 targets 里同部位重复'; NeedsRotator = $false
  Expect = '设备【没有任何反应】（这是对的）。XToys 日志里应出现 rejected invalid_targets。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-dup' -Targets @(
      @{ part = 'nipple'; intensity = 40; durationMs = 2000 },
      @{ part = 'nipple'; intensity = 60; durationMs = 2000 }))
}

$stepDefs += @{
  Id = 13; Title = 'sequence 不递增必须被拒绝（缺陷 1 回归）'; NeedsRotator = $false
  Expect = '第二次发送应无效（设备不变）。日志里应出现 rejected invalid_sequence —— 这一条专门验"失败不再被静默当成成功"。'
  Inner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-seq' -Targets @(
      @{ part = 'nipple'; intensity = 90; durationMs = 2000 }))
  PreInner = (Inner -Command 'play' -Sequence 1 -EventId 'acc-seq' -Targets @(
      @{ part = 'nipple'; intensity = 90; durationMs = 2000 }))
}

$stepDefs += @{
  Id = 14; Title = 'stop_all：全部输出立刻归零'; NeedsRotator = $false
  Expect = '【所有】输出（E-Stim + 振动）立刻归零。这是紧急全停路径。'
  Inner = (Inner -Command 'stop_all' -OmitSequence)
}

# ---------------------------------------------------------------- 列表模式

if ($List) {
  Write-Host ''
  Write-Host '阶段 0 真机验收步骤' -ForegroundColor Cyan
  Write-Host ('=' * 72)
  foreach ($d in $stepDefs) {
    $tag = if ($d.NeedsRotator) { ' [需旋转器]' } else { '' }
    Write-Host ("  {0,2}. {1}{2}" -f $d.Id, $d.Title, $tag)
  }
  Write-Host ''
  Write-Host '用法：pwsh -File tools/Invoke-XtoysAcceptance.ps1            # 全部'
  Write-Host '      pwsh -File tools/Invoke-XtoysAcceptance.ps1 -Steps 3,4  # 只跑某几步'
  Write-Host '      pwsh -File tools/Invoke-XtoysAcceptance.ps1 -SkipUnverifiable'
  Write-Host ''
  exit 0
}

# ---------------------------------------------------------------- 前置检查

if (-not $WebhookId) {
  Write-Host ''
  Write-Host '缺少 Webhook ID。' -ForegroundColor Yellow
  Write-Host '  请先在 XToys 的 webhook 通道里拿到 ID，然后：'
  Write-Host '    $env:XTOYS_WEBHOOK_ID = "<真实ID>"'
  Write-Host '  或直接传参：-WebhookId "<真实ID>"'
  Write-Host ''
  exit 2
}

$uri = "https://webhook.xtoys.app/$WebhookId"

Write-Host ''
Write-Host 'XToys 触觉桥 — 阶段 0 真机验收' -ForegroundColor Cyan
Write-Host ('=' * 72)
Write-Host "  端点      : https://webhook.xtoys.app/<已隐藏>" 
Write-Host "  来源标识  : $source"
Write-Host "  模式      : $(if ($DryRun) { '仅打印请求体，不发送' } else { '真实发送' })"
if ($SkipUnverifiable) { Write-Host '  跳过需旋转器的步骤' }
Write-Host ''
Write-Host '开始前请确认：' -ForegroundColor Yellow
Write-Host '  1. XToys 里 Script 已【手动启动】'
Write-Host '  2. 每个 Block 已绑定到恰好一个设备/子通道'
Write-Host '  3. 设备最大强度/最大旋转速度仍是你选的安全值（本 Script 不会改它）'
Write-Host '  4. 第一±步会用很小的数值，你随时可以停 Script'
Write-Host ''
$ready = Read-Host '准备好了吗？(y/N)'
if ($ready -notmatch '^[yY]') { Write-Host '已取消。'; exit 0 }

# ---------------------------------------------------------------- 主循环

$results = New-Object System.Collections.Generic.List[object]
$selected = $stepDefs | Where-Object {
  (-not $stepFilter -or $stepFilter -contains $_.Id) -and
  (-not ($SkipUnverifiable -and $_.NeedsRotator))
}

if (-not $selected) { Write-Host '没有匹配的步骤。'; exit 2 }

$quit = $false
foreach ($d in $selected) {
  if ($quit) { break }
  Write-Host ''
  Write-Host ('-' * 72)
  Write-Host ("步骤 {0} / {1}" -f $d.Id, $d.Title) -ForegroundColor Cyan
  Write-Host ('-' * 72)
  Write-Host '应观察到：' -NoNewline
  Write-Host $d.Expect -ForegroundColor Yellow

  $payload = New-Payload -Inner $d.Inner

  # 步骤 13 需要先发一次建立事件，再发一次相同 sequence
  if ($d.ContainsKey('PreInner')) {
    $pre = New-Payload -Inner $d.PreInner
    Write-Host ''
    Write-Host '  先发一次（建立事件）：' -ForegroundColor DarkGray
    Write-Host "  $pre" -ForegroundColor DarkGray
    if (-not $DryRun) {
      try {
        $r = Invoke-WebRequest -Uri $uri -Method POST -ContentType 'application/json' -Body $pre -TimeoutSec 20
        Write-Host ("  HTTP {0}" -f $r.StatusCode) -ForegroundColor DarkGray
      } catch {
        Write-Host ("  请求失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
      }
      Start-Sleep -Milliseconds 500
    }
    Write-Host '  现在发第二次（相同 sequence，应被拒绝）：' -ForegroundColor DarkGray
  } else {
    Write-Host ''
    Write-Host '  请求体：' -ForegroundColor DarkGray
    Write-Host "  $payload" -ForegroundColor DarkGray
  }

  if ($DryRun) {
    $results.Add([pscustomobject]@{ Step = $d.Id; Title = $d.Title; Result = 'dry-run'; Note = '' })
    continue
  }

  try {
    $resp = Invoke-WebRequest -Uri $uri -Method POST -ContentType 'application/json' -Body $payload -TimeoutSec 20
    Write-Host ("  已发送：HTTP {0}（这【不】代表设备收到了 —— 见 HANDOFF.md §3.4）" -f $resp.StatusCode) -ForegroundColor DarkGray
  } catch {
    Write-Host ("  请求失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    $results.Add([pscustomobject]@{ Step = $d.Id; Title = $d.Title; Result = 'send-failed'; Note = $_.Exception.Message })
    continue
  }

  if ($d.Id -eq 3) {
    Write-Host '  等待 1.2 秒观察是否回落到基线…' -ForegroundColor DarkGray
    Start-Sleep -Milliseconds 1200
  }

  Write-Host ''
  $answer = Read-Host '  实际观察如何？ [y]符合 / [n]不符合 / [s]跳过 / [q]退出'
  $note = ''
  switch -Regex ($answer) {
    '^[yY]' { $result = '符合' }
    '^[nN]' {
      $result = '不符合'
      $note = Read-Host '  请记下实际看到的现象（会写进汇总表）'
    }
    '^[sS]' { $result = '跳过'; $note = Read-Host '  跳过的原因（可留空）' }
    '^[qQ]' {
      # 不用 break：switch 里的 break 只跳出 switch，不会跳出 foreach。
      $result = '用户中止'
      $quit = $true
      Write-Host '已中止。' -ForegroundColor Yellow
    }
    default { $result = '未记录' }
  }
  $results.Add([pscustomobject]@{ Step = $d.Id; Title = $d.Title; Result = $result; Note = $note })
}

# ---------------------------------------------------------------- 收尾

Write-Host ''
Write-Host ('=' * 72)
Write-Host '收尾：手动停止 Script' -ForegroundColor Yellow
Write-Host ('=' * 72)
Write-Host '请在 XToys 里【手动停止 Script】，然后确认：'
Write-Host '  - 所有输出归零（Final Actions 的显式 UI 归零是硬保障）'
Write-Host '  - 你觉得设备还有残余输出时，立刻停 Script 并记录'
Write-Host ''
Read-Host '停完按回车生成汇总'| Out-Null

Write-Host ''
Write-Host '验收汇总（可直接粘进 docs/07-stage0-status-and-todo.md）' -ForegroundColor Cyan
Write-Host ('=' * 72)
Write-Host ("测试时间：{0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'))
Write-Host ("端点来源：webhook ID 已隐藏；source = {0}" -f $source)
Write-Host ''
$results | Format-Table -AutoSize Step, Result, Title, Note | Out-String -Width 200 | Write-Host

$ok = ($results | Where-Object Result -eq '符合').Count
$bad = ($results | Where-Object Result -eq '不符合').Count
$skipped = ($results | Where-Object { $_.Result -in @('跳过', 'dry-run', '用户中止', 'send-failed', '未记录') }).Count
Write-Host ("符合 {0} / 不符合 {1} / 未完成 {2}（共 {3} 步）" -f $ok, $bad, $skipped, $results.Count)

if ($bad -gt 0) {
  Write-Host ''
  Write-Host '有不符合项：请把每一行的 Note 补进 docs/01-xtoys-script-format.md §8 与 docs/07。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '提醒：' -ForegroundColor DarkGray
Write-Host '  - 旋转的两个方向本轮【未验证】（没有旋转器），不要记成通过。' -ForegroundColor DarkGray
Write-Host '  - rampTime 单位是否为秒仍需从步骤 3/4 的渐变观感判断。' -ForegroundColor DarkGray
Write-Host '  - 提交时不要包含真实 Webhook ID。' -ForegroundColor DarkGray
Write-Host ''
