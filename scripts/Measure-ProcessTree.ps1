[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateRange(1, 2147483647)]
    [int]$RootProcessId
)

$ErrorActionPreference = 'Stop'

$processes = @(Get-CimInstance Win32_Process)
$root = $processes | Where-Object { $_.ProcessId -eq $RootProcessId } | Select-Object -First 1
if ($null -eq $root) {
    throw "Root process does not exist: $RootProcessId"
}

$ids = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add([uint32]$RootProcessId)
do {
    $added = $false
    foreach ($process in $processes) {
        if ($ids.Contains([uint32]$process.ParentProcessId) -and $ids.Add([uint32]$process.ProcessId)) {
            $added = $true
        }
    }
} while ($added)

$members = @($processes | Where-Object { $ids.Contains([uint32]$_.ProcessId) })
[pscustomobject]@{
    sampledAt = [DateTime]::UtcNow.ToString('o')
    rootProcessId = $RootProcessId
    processCount = $members.Count
    privateBytes = [uint64](($members | Measure-Object -Property PrivatePageCount -Sum).Sum)
    workingSetBytes = [uint64](($members | Measure-Object -Property WorkingSetSize -Sum).Sum)
    processes = @($members | Sort-Object Name, ProcessId | ForEach-Object {
        [pscustomobject]@{
            processId = [uint32]$_.ProcessId
            parentProcessId = [uint32]$_.ParentProcessId
            name = $_.Name
            privateBytes = [uint64]$_.PrivatePageCount
            workingSetBytes = [uint64]$_.WorkingSetSize
        }
    })
} | ConvertTo-Json -Depth 4 -Compress
