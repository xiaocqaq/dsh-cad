<#
.SYNOPSIS
  stdio bridge between the dsh-plugin-cad Node transport and a running AutoCAD.

.DESCRIPTION
  Reads one JSON request per line from stdin, performs it against the AutoCAD
  COM automation server, and writes one JSON response per line to stdout.

  AutoCAD is attached to, never launched, when it is already running; otherwise
  the script starts a visible instance so the engineer can see what the agent
  is doing. The COM reference is held for the process lifetime because repeated
  attach/detach cycles are slow and would churn the document's modified flag.

  stdout carries protocol traffic ONLY. Every diagnostic goes to stderr, or it
  would corrupt the framing.
#>
[CmdletBinding()]
param(
  [string] $ProgId = 'AutoCAD.Application',
  [string] $ProgIdFallbacks = '',
  [switch] $AllowLaunch
)

$ErrorActionPreference = 'Stop'
# NOTE: Set-StrictMode is deliberately NOT enabled. Under strict mode
# PowerShell loses the COM type adapter for AutoCAD automation objects, and
# every property access fails with 'property cannot be found on this object'.

# An empty `-ProgIdFallbacks` argument is dropped by PowerShell's parameter
# binder, so normalise the unbound case to a single space rather than $null.
if ($null -eq $ProgIdFallbacks) { $ProgIdFallbacks = ' ' }

# COM constants (AutoCAD type library values).
$acModelSpace = 1
$acPaperSpace = 0

function Write-Protocol([object] $Value) {
  # Single line, no embedded newlines: the Node side frames on "\n".
  $json = $Value | ConvertTo-Json -Depth 12 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function New-Ok([object] $Data, [string[]] $Handles = $null, [string[]] $Warnings = $null) {
  $o = [ordered]@{ ok = $true; data = $Data }
  if ($Handles) { $o['handles'] = @($Handles) }
  if ($Warnings -and $Warnings.Count -gt 0) { $o['warnings'] = @($Warnings) }
  return $o
}

function New-Err([string] $Code, [string] $Message, [string] $Details = $null) {
  $e = [ordered]@{ code = $Code; message = $Message }
  if ($Details) { $e['details'] = $Details }
  return [ordered]@{ ok = $false; error = $e }
}

function Convert-Point($P) {
  if ($null -eq $P) { return $null }
  # Build a real System.Double[] with New-Object: a `[double[]]@(...)` cast is
  # re-wrapped as Object[] once it crosses the function boundary, and AutoCAD
  # then rejects AddLine/AddCircle with "value does not fall within the expected range".
  $v = New-Object double[] 3
  $v[0] = 0.0; $v[1] = 0.0; $v[2] = 0.0
  if ($P.PSObject.Properties.Name -contains 'x') { $v[0] = [double]$P.x }
  if ($P.PSObject.Properties.Name -contains 'y') { $v[1] = [double]$P.y }
  if (($P.PSObject.Properties.Name -contains 'z') -and ($null -ne $P.z)) { $v[2] = [double]$P.z }
  return ,$v
}


# ---------------------------------------------------------------- attachment

function Get-AcadApp {
  $candidates = @($ProgId)
  if ($ProgIdFallbacks) { $candidates += ($ProgIdFallbacks -split ',' | Where-Object { $_ }) }

  foreach ($id in $candidates) {
    if (-not $id) { continue }
    try {
      # Attach to the engineer's existing session rather than starting a new one.
      $app = [Runtime.InteropServices.Marshal]::GetActiveObject($id)
      if ($app) {
        $script:App = $app
        return @{ ProgId = $id; Attached = $true }
      }
    } catch {
      # Not running under this ProgID; try the next one.
    }
  }

  if (-not $AllowLaunch) {
    throw ("BACKEND_UNAVAILABLE: 未找到运行中的 AutoCAD 实例。请先启动 AutoCAD 并打开图形后重试" +
      "（已尝试 ProgID: " + ($candidates -join ', ') + "）")
  }

  foreach ($id in $candidates) {
    if (-not $id) { continue }
    try {
      $app = New-Object -ComObject $id
      if ($app) {
        $script:App = $app
        return @{ ProgId = $id; Attached = $false }
      }
    } catch {
      # Try the next ProgID.
    }
  }
  throw "BACKEND_UNAVAILABLE: 无法创建 AutoCAD COM 实例（已尝试 ProgID: " + ($candidates -join ', ') + "）"
}

function Get-ActiveDoc($App) {
  try {
    $doc = $App.ActiveDocument
    if ($null -ne $doc) { return $doc }
  } catch {
    # No document open yet.
  }
  throw "NO_DOCUMENT: AutoCAD 当前没有打开的图形,请先打开或新建一个 DWG 文件"
}

function Get-Space {
  if ($script:Doc.ActiveSpace -eq $acPaperSpace) { $script:SPC = $script:Doc.PaperSpace }
  else { $script:SPC = $script:Doc.ModelSpace }
}

function Get-EntityKind($Ent) {
  # ObjectName looks like "AcDbLine", "AcDbCircle", "AcDbText", ...
  $n = $Ent.ObjectName
  if (-not $n) { return 'unknown' }
  switch -Regex ($n) {
    '^AcDbLine$'           { return 'line' }
    '^AcDbCircle$'         { return 'circle' }
    '^AcDbArc$'            { return 'arc' }
    '^AcDb2dPolyline$'     { return 'polyline' }
    '^AcDb3dPolyline$'     { return 'polyline' }
    '^AcDbPolyline$'       { return 'polyline' }
    '^AcDbText$'           { return 'text' }
    '^AcDbMText$'          { return 'mtext' }
    '^AcDbDimension$'      { return 'dimension' }
    '^AcDbHatch$'          { return 'hatch' }
    '^AcDbPoint$'          { return 'point' }
    '^AcDbEllipse$'        { return 'ellipse' }
    '^AcDbSpline$'         { return 'spline' }
    '^AcDbBlockReference$' { return 'block' }
    default                { return 'unknown' }
  }
}

function Get-BBox($Ent) {
  try {
    # GetBoundingBox fills two out-parameters; it returns nothing.
    $min = $null
    $max = $null
    $Ent.GetBoundingBox([ref]$min, [ref]$max)
    $lo = @($min)
    $hi = @($max)
    if ($lo.Count -ge 3 -and $hi.Count -ge 3) {
      return [ordered]@{
        min = [ordered]@{ x = [double]$lo[0]; y = [double]$lo[1]; z = [double]$lo[2] }
        max = [ordered]@{ x = [double]$hi[0]; y = [double]$hi[1]; z = [double]$hi[2] }
      }
    }
  } catch {
    # Entities with no extent (empty blocks, some hatches) throw here.
  }
  return $null
}

function Get-Measure($Ent, [string] $Kind) {
  $m = [ordered]@{}
  try {
    switch ($Kind) {
      'line'     { $m['length'] = [double]$Ent.Length }
      'circle'   { $m['radius'] = [double]$Ent.Radius }
      'arc'      {
        $m['radius'] = [double]$Ent.Radius
        $m['angle']  = [double]$Ent.Angle
      }
      'polyline' {
        $m['length'] = [double]$Ent.Length
        if ($Ent.Closed) { $m['area'] = [double]$Ent.Area }
      }
      'hatch'    { $m['area'] = [double]$Ent.Area }
      default    { }
    }
  } catch {
    # A property that does not apply to this entity is omitted.
  }
  if ($m.Count -eq 0) { return $null }
  return $m
}

function Get-EntityText($Ent, [string] $Kind) {
  try {
    switch ($Kind) {
      'text'  { return [string]$Ent.TextString }
      'mtext' { return [string]$Ent.Text }
      'block' { return [string]$Ent.Name }
      default { return $null }
    }
  } catch {
    return $null
  }
}

function Convert-Entity($Ent) {
  $kind = Get-EntityKind $Ent
  $o = [ordered]@{
    handle = [string]$Ent.Handle
    kind   = $kind
    layer  = [string]$Ent.Layer
    bbox   = Get-BBox $Ent
  }
  $meas = Get-Measure $Ent $kind
  if ($meas) { $o['measure'] = $meas }
  $txt = Get-EntityText $Ent $kind
  if ($null -ne $txt) { $o['text'] = $txt }
  try { $o['color'] = [int]$Ent.Color } catch { }
  try { $o['linetype'] = [string]$Ent.Linetype } catch { }
  return $o
}

function Find-Entity([string] $Handle) {
  # Uses script scope: a COM object received as a parameter loses its
  # type adapter, so $Doc.ModelSpace would come back null.
  Get-Space
  $space = $script:SPC
  foreach ($e in $space) {
    if ([string]$e.Handle -eq $Handle) { return $e }
  }
  return $null
}

function Set-Common($Ent, $Layer, $Color) {
  if ($Layer) {
    $name = [string]$Layer
    # AutoCAD rejects an assignment to a layer that does not exist yet.
      if (-not (Test-LayerExists $name)) { $null = $script:Doc.Layers.Add($name) }
    $Ent.Layer = $name
  }
  if ($null -ne $Color) {
    # Entities expose Color; ColorIndex does not exist on them.
    $Ent.Color = [int]$Color
  }
  return $Ent
}

function Test-LayerExists([string]$Name) {
  foreach ($l in $script:Doc.Layers) {
    if ([string]$l.Name -eq $Name) { return $true }
  }
  return $false
}

# ---------------------------------------------------------------- document ops

function Invoke-Status($App, $Doc) {
  # Two-step assignment, not $(...): a subexpression strips the COM type
  # adapter and $space would come back null.
  Get-Space
  $space = $script:SPC
  $info = [ordered]@{
    name            = [string]$Doc.Name
    path            = [string]$Doc.FullName
    unitsName       = [string]$Doc.GetVariable('INSUNITS')
    modelSpaceCount = [int]$space.Count
    activeSpace     = "$(if ($Doc.ActiveSpace -eq $acPaperSpace) { 'paper' } else { 'model' })"
  }
  return New-Ok ([ordered]@{
    backend  = 'com'
    progId   = $script:AcadProgId
    attached = $script:AcadAttached
    document = $info
  })
}

function Invoke-Open($App, $Req) {
  $path = [string]$Req.path
  if (-not (Test-Path -LiteralPath $path)) {
    return New-Err 'NOT_FOUND' "文件不存在: $path"
  }
  $full = (Resolve-Path -LiteralPath $path).Path
  $doc = $App.Documents.Open($full)
  $App.ActiveDocument = $doc | Out-Null
  Get-Space
  $space = $script:SPC
  return New-Ok ([ordered]@{
    name            = [string]$doc.Name
    path            = [string]$doc.FullName
    modelSpaceCount = [int]$space.Count
  })
}

function Invoke-SaveAs($App, $Doc, $Req) {
  $path = [string]$Req.path
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  # 64 = ac2018 (native DWG); avoids the DXF-route format surprises.
  $Doc.SaveAs($path, 64)
  return New-Ok ([ordered]@{ path = [string]$Doc.FullName })
}
function Invoke-ListLayers($Doc) {
  # Two-step assignment, not $(...): a subexpression strips the COM type
  # adapter and $space would come back null.
  Get-Space
  $space = $script:SPC
  $counts = @{}
  foreach ($e in $space) {
    $l = [string]$e.Layer
    if ($counts.ContainsKey($l)) { $counts[$l] += 1 } else { $counts[$l] = 1 }
  }
  $out = @()
  foreach ($lay in $Doc.Layers) {
    $n = [string]$lay.Name
    $o = [ordered]@{
      name   = $n
      color  = [int]$lay.Color
      on     = [bool]$lay.LayerOn
      frozen = [bool]$lay.Freeze
      locked = [bool]$lay.Lock
    }
    try { $o['linetype'] = [string]$lay.Linetype } catch { $o['linetype'] = '' }
    $o['entityCount'] = $(if ($counts.ContainsKey($n)) { [int]$counts[$n] } else { 0 })
    $out += $o
  }
  return New-Ok ([ordered]@{ layers = @($out) })
}

function Invoke-QueryEntities($Doc, $Req) {
  # Two-step assignment, not $(...): a subexpression strips the COM type
  # adapter and $space would come back null.
  Get-Space
  $space = $script:SPC
  $names = @($Req.PSObject.Properties.Name)
  $wantLayer = $null
  if ($names -contains 'layer' -and $Req.layer) { $wantLayer = ([string]$Req.layer).ToLowerInvariant() }
  $wantKind = $null
  if ($names -contains 'kind' -and $Req.kind) { $wantKind = [string]$Req.kind }
  $wantText = $null
  if ($names -contains 'textContains' -and $Req.textContains) {
    $wantText = ([string]$Req.textContains).ToLowerInvariant()
  }
  $limit = 0
  if ($names -contains 'limit' -and $Req.limit) { $limit = [int]$Req.limit }

  $hasWindow = ($names -contains 'window') -and ($null -ne $Req.window)
  $wxMin = 0.0; $wyMin = 0.0; $wxMax = 0.0; $wyMax = 0.0
  if ($hasWindow) {
    $wxMin = [double]$Req.window.min.x; $wyMin = [double]$Req.window.min.y
    $wxMax = [double]$Req.window.max.x; $wyMax = [double]$Req.window.max.y
  }

  $out = @()
  $truncated = $false
  foreach ($e in $space) {
    $kind = Get-EntityKind $e
    if ($wantLayer -and ([string]$e.Layer).ToLowerInvariant() -ne $wantLayer) { continue }
    if ($wantKind -and $kind -ne $wantKind) { continue }

    $bb = Get-BBox $e
    if ($hasWindow) {
      if ($null -eq $bb) { continue }
      $cx = ([double]$bb.min.x + [double]$bb.max.x) / 2.0
      $cy = ([double]$bb.min.y + [double]$bb.max.y) / 2.0
      if ($cx -lt $wxMin -or $cx -gt $wxMax -or $cy -lt $wyMin -or $cy -gt $wyMax) { continue }
    }

    if ($wantText) {
      $t = Get-EntityText $e $kind
      if ($null -eq $t -or $t.ToLowerInvariant().IndexOf($wantText) -lt 0) { continue }
    }

    if ($limit -gt 0 -and $out.Count -ge $limit) { $truncated = $true; break }
    $out += Convert-Entity $e
  }

  $warn = $null
  if ($truncated) { $warn = @("结果已截断至 limit=$limit,可能还有更多图元未显示") }
  return New-Ok ([ordered]@{ count = $out.Count; entities = @($out) }) $null $warn
}
function Invoke-Draw($Doc, $Req) {
  # Two-step assignment, not $(...): a subexpression strips the COM type
  # adapter and $space would come back null.
  Get-Space
  $space = $script:SPC
  $handles = @()
  $warnings = @()
  $warnings = @()
  # NOTE: undoLabel is accepted but intentionally not applied. Grouping a
  # batch into one undo step would need Document.StartUndoMark/EndUndoMark
  # (absent from the AutoCAD 2026 automation Document) or SendCommand, which
  # deadlocks the COM call from inside an automation client. Each entity stays
  # individually undoable with U.

  foreach ($item in $Req.items) {
    try {
      $names = @($item.PSObject.Properties.Name)
      $layer = $null
      if ($names -contains 'layer' -and $item.layer) { $layer = [string]$item.layer }
      $color = $null
      if ($names -contains 'color' -and $null -ne $item.color) { $color = [int]$item.color }

      $ent = $null
      switch ([string]$item.kind) {
        'line' {
          $ent = $space.AddLine((Convert-Point $item.start), (Convert-Point $item.end))
        }
        'circle' {
          $ent = $space.AddCircle((Convert-Point $item.center), [double]$item.radius)
        }
        'arc' {
          $ent = $space.AddArc((Convert-Point $item.center), [double]$item.radius,
            ([double]$item.startAngle * [Math]::PI / 180.0),
            ([double]$item.endAngle * [Math]::PI / 180.0))
        }
        'polyline' {
          $flat = New-Object System.Collections.Generic.List[double]
          foreach ($v in $item.vertices) {
            $p = Convert-Point $v
            $flat.Add($p[0]); $flat.Add($p[1])
          }
          if ($flat.Count -lt 4) { $warnings += '顶点不足的多段线已跳过'; continue }
          $ent = $space.AddLightWeightPolyline($flat.ToArray())
        }
        'text' {
          $h = 0.0
          if ($names -contains 'height' -and $item.height) { $h = [double]$item.height }
          $ent = $space.AddText([string]$item.text, (Convert-Point $item.position), $h)
        }
        'mtext' {
          $ent = $space.AddMText((Convert-Point $item.position), [string]$item.text)
        }
        default {
          $warnings += "不支持的图元类型,已跳过: $($item.kind)"
          continue
        }
      }

      if ($null -ne $ent) {
        Set-Common $ent $layer $color | Out-Null
        $handles += [string]$ent.Handle
      }
    } catch {
        $warnings += "创建图元失败(" + $item.kind + "): " + $_.Exception.Message
    }
  }

  return New-Ok ([ordered]@{ count = $handles.Count }) $handles $warnings
}

function Invoke-AddDimension($Doc, $Req) {
  # Two-step assignment, not $(...): a subexpression strips the COM type
  # adapter and $space would come back null.
  Get-Space
  $space = $script:SPC
  $names = @($Req.PSObject.Properties.Name)
  $pts = @()
  foreach ($p in $Req.points) { $pts += (Convert-Point $p) }
  $kind = [string]$Req.kind

  $offset = 0.0
  if ($names -contains 'offset' -and $null -ne $Req.offset) { $offset = [double]$Req.offset }
  $layer = $null
  if ($names -contains 'layer' -and $Req.layer) { $layer = [string]$Req.layer }
  $color = $null
  if ($names -contains 'color' -and $null -ne $Req.color) { $color = [int]$Req.color }

  $ent = $null
  switch ($kind) {
    'aligned' {
      if ($pts.Count -lt 2) { return New-Err 'INVALID_ARGUMENT' '对齐标注需要至少 2 个点' }
      $p1 = $pts[0]; $p2 = $pts[1]
      if ($offset -ne 0.0) { $p2 = [double[]]@($p2[0], $p2[1] + $offset, $p2[2]) }
      $ent = $space.AddDimAligned($p1, $p2)
    }
    'linear' {
      if ($pts.Count -lt 2) { return New-Err 'INVALID_ARGUMENT' '线性标注需要至少 2 个点' }
      $p1 = $pts[0]; $p2 = $pts[1]
      if ($offset -ne 0.0) { $p2 = [double[]]@($p2[0], $p2[1] + $offset, $p2[2]) }
      $ent = $space.AddDimRotated($p1, $p2, 0.0)
    }
    'angular' {
      if ($pts.Count -lt 3) { return New-Err 'INVALID_ARGUMENT' '角度标注需要 3 个点' }
      $ent = $space.AddDimAngular($pts[0], $pts[1], $pts[2])
    }
    'radius'   { $ent = $space.AddDimRadius($pts[0]) }
    'diameter' { $ent = $space.AddDimDiameter($pts[0]) }
    default    { return New-Err 'UNSUPPORTED' "不支持的标注类型: $kind" }
  }

  if ($null -eq $ent) { return New-Err 'BACKEND_ERROR' "AutoCAD 未能创建该标注($kind)" }
  Set-Common $ent $layer $color | Out-Null
  if ($names -contains 'textOverride' -and $Req.textOverride) {
    try { $ent.TextOverride = [string]$Req.textOverride } catch { }
  }
  return New-Ok ([ordered]@{ count = 1 }) @([string]$ent.Handle) $null
}

function Invoke-AddHatch($Doc, $Req) {
  # Two-step assignment, not $(...): a subexpression strips the COM type
  # adapter and $space would come back null.
  Get-Space
  $space = $script:SPC
  $names = @($Req.PSObject.Properties.Name)
  $pattern = 'ANSI31'
  if ($names -contains 'patternName' -and $Req.patternName) { $pattern = [string]$Req.patternName }

  # 0 = acHatchPatternTypePreDefined
  $hatch = $space.AddHatch(0, $pattern, $false, 0)
  $warnings = @()
  $isOuter = $true
  foreach ($loop in $Req.loops) {
    $flat = New-Object System.Collections.Generic.List[double]
    foreach ($p in $loop) {
      $cp = Convert-Point $p
      $flat.Add($cp[0]); $flat.Add($cp[1])
    }
    if ($flat.Count -lt 6) { $warnings += '顶点不足 3 个的填充环已跳过'; continue }
    # Closed ring: repeat the first vertex at the end.
    $flat.Add($flat[0]); $flat.Add($flat[1])
    $hatch.AddLineEdge($flat.ToArray(), $(if ($isOuter) { 0 } else { 1 })) | Out-Null
    $isOuter = $false
  }

  $layer = $null
  if ($names -contains 'layer' -and $Req.layer) { $layer = [string]$Req.layer }
  $color = $null
  if ($names -contains 'color' -and $null -ne $Req.color) { $color = [int]$Req.color }
  Set-Common $hatch $layer $color | Out-Null
  return New-Ok ([ordered]@{ count = 1 }) @([string]$hatch.Handle) $warnings
}
function Invoke-Modify($Doc, $Req) {
  $ent = Find-Entity ([string]$Req.handle)
  if ($null -eq $ent) { return New-Err 'NOT_FOUND' "图元不存在: $($Req.handle)" }

  $set = $Req.set
  $keys = @($set.PSObject.Properties.Name)
  $applied = @()
  try {
    if ($keys -contains 'layer' -and $set.layer) {
      $ent.Layer = [string]$set.layer; $applied += 'layer'
    }
    if ($keys -contains 'color' -and $null -ne $set.color) {
      $ent.Color = [int]$set.color; $applied += 'color'
    }
    if ($keys -contains 'linetype' -and $set.linetype) {
      $ent.Linetype = [string]$set.linetype; $applied += 'linetype'
    }
    $kind = Get-EntityKind $ent
    if ($keys -contains 'text' -and $null -ne $set.text) {
      if ($kind -eq 'mtext') { $ent.Text = [string]$set.text }
      else { $ent.TextString = [string]$set.text }
      $applied += 'text'
    }
    if ($keys -contains 'height' -and $null -ne $set.height) {
      $ent.Height = [double]$set.height; $applied += 'height'
    }
    if ($keys -contains 'rotation' -and $null -ne $set.rotation) {
      $ent.Rotation = [double]$set.rotation; $applied += 'rotation'
    }
    if ($keys -contains 'radius' -and $null -ne $set.radius) {
      $ent.Radius = [double]$set.radius; $applied += 'radius'
    }
  } catch {
    return New-Err 'BACKEND_ERROR' "修改图元失败: $($_.Exception.Message)"
  }
  return New-Ok ([ordered]@{ applied = @($applied) }) @([string]$ent.Handle) $null

}
# AutoCAD rejects COM calls with RPC_E_CALL_REJECTED while it is busy (a modal
# dialog, a long regen, or a user command in flight). These are transient, so
# retry with a short backoff before reporting failure.
function Invoke-WithComRetry([scriptblock] $Action, [int] $MaxAttempts = 20, [int] $DelayMs = 250) {
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      return & $Action
    } catch {
      $msg = $_.Exception.Message
      $transient = ($msg -like '*RPC_E_CALL_REJECTED*') -or
                    ($msg -like '*Call was rejected by callee*') -or
                    ($msg -like '*0x80010001*') -or
                    ($msg -like '*8001010A*') -or
                    ($msg -like '*RPC_E_SERVERCALL_RETRYLATER*')
      if ($transient -and $attempt -lt $MaxAttempts) {
        Start-Sleep -Milliseconds $DelayMs
        continue
      }
      throw
    }
  }
}

# True while a JSON fragment still has unbalanced braces/brackets, i.e. the
# document is incomplete and more lines should be read before parsing.
# String contents are skipped so braces inside text do not affect the count.
function Test-JsonIncomplete([string] $Text) {
  $depth = 0
  $inString = $false
  $escape = $false
  foreach ($ch in $Text.ToCharArray()) {
    if ($escape) { $escape = $false; continue }
    if ($ch -eq [char]0x5C) {
      if ($inString) { $escape = $true }
      continue
    }
    if ($ch -eq [char]0x22) { $inString = -not $inString; continue }
    if ($inString) { continue }
    if ($ch -eq [char]0x7B -or $ch -eq [char]0x5B) { $depth++ }
    elseif ($ch -eq [char]0x7D -or $ch -eq [char]0x5D) { $depth-- }
  }
  return ($depth -gt 0)
}

# Build a 4x4 row-major transformation matrix. TransformBy rejects a flat
# double[] ("safe array dimension incorrect"), so a rectangular array is required.
function New-XformMatrix([double]$tx, [double]$ty, [double]$angleDeg, [double]$scale, [double]$cx, [double]$cy) {
  $r = $angleDeg * [Math]::PI / 180.0
  $c = [Math]::Cos($r); $s = [Math]::Sin($r)
  $m = New-Object 'double[,]' 4,4
  # Translate to origin, scale/rotate, translate back, then apply the offset.
  $m[0,0] = $scale * $c;  $m[0,1] = -$scale * $s; $m[0,2] = 0.0; $m[0,3] = $cx - $scale * ($c * $cx - $s * $cy) + $tx
  $m[1,0] = $scale * $s;  $m[1,1] = $scale * $c;  $m[1,2] = 0.0; $m[1,3] = $cy - $scale * ($s * $cx + $c * $cy) + $ty
  $m[2,0] = 0.0; $m[2,1] = 0.0; $m[2,2] = 1.0; $m[2,3] = 0.0
  $m[3,0] = 0.0; $m[3,1] = 0.0; $m[3,2] = 0.0; $m[3,3] = 1.0
  return ,$m
}

function Invoke-Transform($Doc, $Req) {
  $names = @($Req.PSObject.Properties.Name)
  $mode = [string]$Req.mode
  $value = [double]$Req.value
  $valueY = 0.0
  if (($names -contains 'valueY') -and ($null -ne $Req.valueY)) { $valueY = [double]$Req.valueY }
  $copy = $false
  if (($names -contains 'copy') -and $Req.copy) { $copy = [bool]$Req.copy }

  $cx = 0.0; $cy = 0.0
  if (($names -contains 'center') -and $Req.center) {
    $cpt = Convert-Point $Req.center
    $cx = [double]$cpt[0]; $cy = [double]$cpt[1]
  } elseif ($mode -ne 'move') {
    return New-Err 'INVALID_ARGUMENT' 'rotate/scale 必须提供 center 基准点'
  }

  switch ($mode) {
    'move'   { $tx = $value; $ty = $valueY; $ang = 0.0; $sc = 1.0 }
    'rotate' { $tx = 0.0; $ty = 0.0; $ang = $value; $sc = 1.0 }
    'scale'  {
      if ($value -le 0) { return New-Err 'INVALID_ARGUMENT' '缩放系数必须为正数' }
      $tx = 0.0; $ty = 0.0; $ang = 0.0; $sc = $value
    }
    default   { return New-Err 'UNSUPPORTED' "不支持的变换模式: $mode" }
  }

  $matrix = New-XformMatrix $tx $ty $ang $sc $cx $cy
  $handles = @()
  $warnings = @()
  foreach ($h in $Req.handles) {
    $ent = Find-Entity ([string]$h)
    if ($null -eq $ent) { $warnings += "图元不存在,已跳过: $h"; continue }
    if ($copy) { $ent = $ent.Copy() }
    try {
      $ent.TransformBy($matrix)
      $handles += [string]$ent.Handle
    } catch {
      $warnings += "变换失败($h): $($_.Exception.Message)"
    }
  }
  return New-Ok ([ordered]@{ count = $handles.Count }) $handles $warnings
}


function Invoke-Delete($Doc, $Req) {
  $removed = @()
  $warnings = @()
  foreach ($h in $Req.handles) {
    $ent = Find-Entity ([string]$h)
    if ($null -eq $ent) { $warnings += "图元不存在,已跳过: $h"; continue }
    try {
      $ent.Delete() | Out-Null
      $removed += [string]$h
    } catch {
      $warnings += "删除失败($h): $($_.Exception.Message)"
    }
  }
  return New-Ok ([ordered]@{ count = $removed.Count }) $removed $warnings
}

function Invoke-RunCommand($App, $Doc, $Req) {
  # Escape hatch for native commands the typed operations do not cover.
  $cmd = [string]$Req.command
  if (($Req.PSObject.Properties.Name -contains 'args') -and $Req.args) {
    $cmd = ($cmd + ' ' + (($Req.args | ForEach-Object { [string]$_ }) -join ' '))
  }
  # COM SendCommand needs the trailing CR to terminate the command.
  $App.ActiveDocument.SendCommand($cmd + "`r")
  return New-Ok ([ordered]@{ executed = @($cmd) })
}

function Invoke-Dispatch([string] $Op, $Req) {
  # `status` also reports the active document, so resolve it for every op.
  $doc = Get-ActiveDoc $script:App
  $script:Doc = $doc
  switch ($Op) {
    'status'        { return Invoke-Status $script:App $doc }
    'open'          { return Invoke-Open $script:App $Req }
    'saveAs'        { return Invoke-SaveAs $script:App $doc $Req }
    'listLayers'    { return Invoke-ListLayers $doc }
    'queryEntities' { return Invoke-QueryEntities $doc $Req }
    'getEntity'     {
      $e = Find-Entity ([string]$Req.handle)
      if ($null -eq $e) { return New-Err 'NOT_FOUND' "图元不存在: $($Req.handle)" }
      return New-Ok ([ordered]@{ entity = Convert-Entity $e })
    }
    'draw'          { return Invoke-Draw $doc $Req }
    'addDimension'  { return Invoke-AddDimension $doc $Req }
    'addHatch'      { return Invoke-AddHatch $doc $Req }
    'modify'        { return Invoke-Modify $doc $Req }
    'transform'     { return Invoke-Transform $doc $Req }
    'delete'        { return Invoke-Delete $doc $Req }
    'runCommand'    { return Invoke-RunCommand $script:App $doc $Req }
    default           { return New-Err 'UNSUPPORTED' "不支持的操作: $Op" }
  }
}
# ---------------------------------------------------------------- main loop

try {
  $acad = Get-AcadApp
  $script:AcadProgId = $acad.ProgId
  $script:AcadAttached = $acad.Attached
  Write-Protocol @{ ready = $true }
} catch {
  Write-Protocol @{ error = $_.Exception.Message }
  exit 1

}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $text = $line.Trim()
  if (-not $text) { continue }

  # Requests may be pretty-printed across several lines. Accumulate until the
  # braces balance so a hand-written multi-line JSON document parses as one
  # request instead of a stream of broken fragments.
  if (Test-JsonIncomplete $text) {
    $buf = $text
    while ($true) {
      $more = [Console]::In.ReadLine()
      if ($null -eq $more) { break }
      $buf += "`n" + $more
      if (-not (Test-JsonIncomplete $buf)) { break }
    }
    $text = $buf
  }

  $id = ''
  try {
    $envelope = $text | ConvertFrom-Json
    $id = [string]$envelope.id
    $req = $envelope.request
    $op = [string]$req.op
    $resp = Invoke-WithComRetry { Invoke-Dispatch $op $req }
  } catch {
    $resp = New-Err 'BACKEND_ERROR' ("AutoCAD 忙或拒绝了本次调用: " + $_.Exception.Message)
  }

  Write-Protocol ([ordered]@{ id = $id; response = $resp })
}

# Release the COM reference so AutoCAD is not left thinking a client is attached.
try {
  if ($script:App) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($script:App) }
} catch { }
