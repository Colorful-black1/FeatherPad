#requires -Version 5.1
# Test-only native dialog client. It can select only an owned fixture in a spawned test app.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSHOME 'Modules\CimCmdlets\CimCmdlets.psd1')
function Get-ControlledHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $projectRoot '.artifacts\T002'
$manifestPath = [IO.Path]::GetFullPath($Manifest)
if (-not $manifestPath.StartsWith($artifactRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture manifest is outside the controlled test root.'
}
$record = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$fixturePath = [IO.Path]::GetFullPath([string]$record.fixture)
if (-not $fixturePath.StartsWith($artifactRoot + '\webview2-', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture is outside the generated WebView test directory.'
}
$item = Get-Item -LiteralPath $fixturePath
if ($item.Length -gt 1024 -or $item.PSIsContainer) { throw 'Unexpected chooser fixture.' }
$ancestor = $item
while ($ancestor.FullName -ne $projectRoot) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fixture path contains a reparse point.' }
    $ancestor = Get-Item -LiteralPath (Split-Path -Parent $ancestor.FullName)
}
$fixtureHash = Get-ControlledHash $fixturePath
if ($fixtureHash -ne $record.fixtureSha256) { throw 'Fixture hash mismatch.' }
$expectedExe = [IO.Path]::GetFullPath([string]$record.executable)
if ($expectedExe -ne (Join-Path $projectRoot 'src-tauri\target\release\featherpad.exe') -and
    $expectedExe -ne (Join-Path $projectRoot 'src-tauri\target\debug\featherpad.exe')) { throw 'Unexpected test executable.' }
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.processId)"
if (-not $target -or $target.ExecutablePath -ne $expectedExe -or
    $target.ParentProcessId -ne [int]$record.workerProcessId) { throw 'Test process identity mismatch.' }
if ((Get-ControlledHash $expectedExe) -ne $record.executableSha256) { throw 'Test executable hash mismatch.' }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class FeatherPadChooserControls {
    private delegate bool Enumerate(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr SetText(IntPtr window, uint message, IntPtr parameter, string value, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr ReadText(IntPtr window, uint message, IntPtr parameter, StringBuilder value, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)]
    private static extern IntPtr Command(IntPtr window, uint message, IntPtr parameter, IntPtr value, uint flags, uint timeout, out IntPtr result);
    private static string Class(IntPtr window) {
        var text = new StringBuilder(128); GetClassName(window, text, text.Capacity); return text.ToString();
    }
    private static void RequireOwned(IntPtr window, int expected) {
        uint actual; if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out actual) == 0 || actual != expected)
            throw new InvalidOperationException("Native chooser process identity changed.");
    }
    public static void Select(int processId, string fixture) {
        var dialogs = new List<IntPtr>();
        var deadline = DateTime.UtcNow.AddSeconds(15);
        do {
            dialogs.Clear();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint actual; GetWindowThreadProcessId(window, out actual);
                if (actual == processId && Class(window) == "#32770") dialogs.Add(window);
                return true;
            }, IntPtr.Zero);
            if (dialogs.Count == 0) Thread.Sleep(100);
        } while (dialogs.Count == 0 && DateTime.UtcNow < deadline);
        if (dialogs.Count != 1) throw new InvalidOperationException("Expected exactly one owned native file dialog.");
        var dialog = dialogs[0]; RequireOwned(dialog, processId);
        var edits = new List<IntPtr>();
        EnumChildWindows(dialog, delegate(IntPtr window, IntPtr unused) {
            if (Class(window) == "Edit") {
                var ancestor = window;
                for (var depth = 0; depth < 8 && ancestor != dialog && ancestor != IntPtr.Zero; depth++) {
                    if (GetDlgCtrlID(ancestor) == 1148) { edits.Add(window); break; }
                    ancestor = GetParent(ancestor);
                }
            }
            return true;
        }, IntPtr.Zero);
        if (edits.Count != 1) throw new InvalidOperationException("Expected exactly one native filename Edit control.");
        var edit = edits[0]; var open = GetDlgItem(dialog, 1);
        RequireOwned(edit, processId); RequireOwned(open, processId);
        if (Class(open) != "Button" || !IsWindowEnabled(dialog) || !IsWindowEnabled(edit) || !IsWindowEnabled(open)
            || (GetWindowLong(edit, -16) & 0x800) != 0) throw new InvalidOperationException("Native chooser controls not enabled/editable.");
        IntPtr result;
        if (SetText(edit, 0x000c, IntPtr.Zero, fixture, 2, 5000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Native filename WM_SETTEXT timed out.");
        var readback = new StringBuilder(32768);
        if (ReadText(edit, 0x000d, (IntPtr)readback.Capacity, readback, 2, 5000, out result) == IntPtr.Zero || readback.ToString() != fixture)
            throw new InvalidOperationException("Native filename readback mismatch.");
        RequireOwned(dialog, processId); RequireOwned(open, processId);
        // The same IDOK/BN_CLICKED command produced by the enabled Open button.
        if (Command(dialog, 0x0111, (IntPtr)1, open, 2, 5000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Native Open command timed out.");
    }
}
"@
[FeatherPadChooserControls]::Select([int]$record.processId, $fixturePath)
[ordered]@{ scope='owned native chooser Win32 controls'; processId=[int]$record.processId; fixtureSha256=$fixtureHash; valueVerified=$true; openInvoked=$true } | ConvertTo-Json -Compress