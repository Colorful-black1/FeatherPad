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
$action = if ($record.action) { [string]$record.action } else { 'open' }
if ($action -notin @('open', 'open-degraded', 'save', 'cancel', 'overwrite', 'confirm-system', 'inspect-overwrite', 'confirm-overwrite', 'reject-overwrite', 'inspect-hardlink', 'confirm-hardlink', 'reject-hardlink')) { throw 'Unexpected native chooser action.' }
$fixtures = @($record.fixtures)
if (($action -eq 'cancel' -and $fixtures.Count -ne 0) -or ($action -ne 'cancel' -and ($fixtures.Count -lt 1 -or $fixtures.Count -gt 8)) -or ($action -notin @('open', 'cancel') -and $fixtures.Count -ne 1)) { throw 'Unexpected chooser fixture count.' }
$verified = @()
foreach ($fixture in $fixtures) {
    $fixturePath = [IO.Path]::GetFullPath([string]$fixture.path)
    if (-not $fixturePath.StartsWith($artifactRoot + '\webview2-', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Fixture is outside the generated WebView test directory.'
    }
    if ($action -eq 'save') {
        if (Test-Path -LiteralPath $fixturePath) { throw 'Controlled new save destination already exists.' }
        $item = Get-Item -LiteralPath (Split-Path -Parent $fixturePath)
        if (-not $item.PSIsContainer) { throw 'Controlled destination parent is not a directory.' }
    } else {
        $item = Get-Item -LiteralPath $fixturePath
        if ($action -eq 'open-degraded') {
            if ($item.Length -ne 2097153 -or $item.PSIsContainer) { throw 'Unexpected controlled degraded fixture size/type.' }
        } elseif ($item.Length -gt 1024 -or $item.PSIsContainer) { throw 'Unexpected chooser fixture.' }
    }
    $ancestor = $item
    while ($ancestor.FullName -ne $projectRoot) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Fixture path contains a reparse point.' }
        $ancestor = Get-Item -LiteralPath (Split-Path -Parent $ancestor.FullName)
    }
    $fixtureHash = $null
    if ($action -notin @('save', 'cancel')) {
        $fixtureHash = Get-ControlledHash $fixturePath
        if ($fixtureHash -ne $fixture.sha256) { throw 'Fixture hash mismatch.' }
    }
    $verified += [pscustomobject]@{ path=$fixturePath; sha256=$fixtureHash }
}
$selectionText = ($verified | ForEach-Object { '"' + $_.path + '"' }) -join ' '
if ($action -in @('save', 'overwrite')) { $selectionText = $verified[0].path }
if ($selectionText.Length -gt 32000) { throw 'Combined fixture paths exceed the controlled limit.' }
$expectedExe = [IO.Path]::GetFullPath([string]$record.executable)
if ($expectedExe -ne (Join-Path $projectRoot 'src-tauri\target\release\featherpad.exe') -and
    $expectedExe -ne (Join-Path $projectRoot 'src-tauri\target\debug\featherpad.exe')) { throw 'Unexpected test executable.' }
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.processId)"
if (-not $target -or $target.ExecutablePath -ne $expectedExe -or
    $target.ParentProcessId -ne [int]$record.workerProcessId) { throw 'Test process identity mismatch.' }
if ((Get-ControlledHash $expectedExe) -ne $record.executableSha256) { throw 'Test executable hash mismatch.' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$uiaReferences = @('System.dll', [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Threading.Dispatcher].Assembly.Location)
Add-Type -ReferencedAssemblies $uiaReferences -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
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
    [DllImport("user32.dll", EntryPoint="PostMessageW", SetLastError=true)]
    private static extern bool PostCommand(IntPtr window, uint message, IntPtr parameter, IntPtr value);
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
    public static void Select(int processId, string fixture, bool cancel, bool saving, bool asynchronous) {
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
        if (cancel) {
            var button = GetDlgItem(dialog, 2); RequireOwned(button, processId);
            if (Class(button) != "Button" || !IsWindowEnabled(button)) throw new InvalidOperationException("Native cancel button is not enabled.");
            IntPtr receipt;
            if (Command(dialog, 0x0111, (IntPtr)2, button, 2, 5000, out receipt) == IntPtr.Zero) throw new InvalidOperationException("Native cancel command timed out.");
            return;
        }
        var edits = new List<IntPtr>();
        var editDeadline = DateTime.UtcNow.AddSeconds(5);
        do {
        edits.Clear();
        EnumChildWindows(dialog, delegate(IntPtr window, IntPtr unused) {
            if (Class(window) == "Edit") {
                if (saving) {
                    if (GetDlgCtrlID(window) == 1001 && Class(GetParent(window)) == "ComboBox") edits.Add(window);
                    return true;
                }
                var ancestor = window;
                for (var depth = 0; depth < 8 && ancestor != dialog && ancestor != IntPtr.Zero; depth++) {
                    if (GetDlgCtrlID(ancestor) == 1148) { edits.Add(window); break; }
                    ancestor = GetParent(ancestor);
                }
            }
            return true;
        }, IntPtr.Zero);
        if (edits.Count == 0) Thread.Sleep(100);
        } while (edits.Count == 0 && DateTime.UtcNow < editDeadline);
        if (edits.Count != 1) {
            var controls = new List<string>();
            EnumChildWindows(dialog, delegate(IntPtr window, IntPtr unused) {
                if (controls.Count < 100) controls.Add(Class(window) + ":" + GetDlgCtrlID(window) + "/" + GetDlgCtrlID(GetParent(window)));
                return true;
            }, IntPtr.Zero);
            throw new InvalidOperationException("Expected exactly one native filename Edit control. Controls: " + String.Join("|", controls));
        }
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
        // Existing destinations may open a nested OS confirmation; do not synchronously wait on it.
        if (asynchronous) {
            if (!PostCommand(dialog, 0x0111, (IntPtr)1, open)) throw new InvalidOperationException("Native Save command could not be posted.");
            return;
        }
        if (Command(dialog, 0x0111, (IntPtr)1, open, 2, 5000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Native Open command timed out.");
    }
    private static string Text(IntPtr window) {
        var text = new StringBuilder(32768); IntPtr result;
        if (ReadText(window, 0x000d, (IntPtr)text.Capacity, text, 2, 5000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Owned confirmation text could not be verified.");
        return text.ToString();
    }
    public static void Confirm(int processId, string fixture, int role, int buttonId) {
        if (role < 0 || role > 2) throw new InvalidOperationException("Unexpected owned confirmation role.");
        var system = role == 0;
        var dialogs = new List<IntPtr>();
        var deadline = DateTime.UtcNow.AddSeconds(15);
        do {
            dialogs.Clear();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint actual; GetWindowThreadProcessId(window, out actual);
                if (actual != processId || Class(window) != "#32770" || !IsWindowEnabled(window)) return true;
                var title = Text(window);
                var matches = system ? title == "Confirm Save As" || title == "\u786e\u8ba4\u53e6\u5b58\u4e3a"
                    : role == 1 ? title == "\u786e\u8ba4\u8986\u76d6\u6587\u4ef6"
                    : title == "\u786e\u8ba4\u66ff\u6362\u786c\u94fe\u63a5";
                if (matches) dialogs.Add(window);
                return true;
            }, IntPtr.Zero);
            if (dialogs.Count == 0) Thread.Sleep(100);
        } while (dialogs.Count == 0 && DateTime.UtcNow < deadline);
        if (dialogs.Count != 1) {
            var observed = new List<string>();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint actual; GetWindowThreadProcessId(window, out actual);
                if (actual != processId || Class(window) != "#32770") return true;
                var controls = new List<string>();
                EnumChildWindows(window, delegate(IntPtr control, IntPtr ignored) {
                    if (controls.Count < 50) controls.Add(Class(control) + ":" + GetDlgCtrlID(control));
                    return true;
                }, IntPtr.Zero);
                observed.Add(Text(window) + "/enabled=" + IsWindowEnabled(window) + "/" + String.Join("|", controls));
                return true;
            }, IntPtr.Zero);
            throw new InvalidOperationException("Expected exactly one owned, named overwrite confirmation. Owned dialogs: " + String.Join(";", observed));
        }
        var dialog = dialogs[0]; RequireOwned(dialog, processId);
        var parts = new List<string>();
        var yes = new List<IntPtr>(); var no = new List<IntPtr>();
        EnumChildWindows(dialog, delegate(IntPtr window, IntPtr unused) {
            var kind = Class(window);
            if (kind == "Static" || kind == "SysLink") { RequireOwned(window, processId); parts.Add(Text(window)); }
            if (kind == "Button" && IsWindowEnabled(window)) {
                RequireOwned(window, processId);
                var label = Text(window).Replace("&", "");
                if (label == "Yes" || label == "\u662f(Y)" || label == "\u662f") yes.Add(window);
                if (label == "No" || label == "\u5426(N)" || label == "\u5426") no.Add(window);
            }
            return true;
        }, IntPtr.Zero);
        // DirectUI content is exposed through UI Automation rather than WM_GETTEXT.
        var automation = AutomationElement.FromHandle(dialog);
        if (automation.Current.ProcessId != processId) throw new InvalidOperationException("Confirmation accessibility owner changed.");
        var content = automation.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
        if (content.Count > 100) throw new InvalidOperationException("Unexpected confirmation content size.");
        for (var index = 0; index < content.Count; index++) {
            if (content[index].Current.ProcessId != processId) throw new InvalidOperationException("Confirmation content owner changed.");
            parts.Add(content[index].Current.Name);
        }
        var expected = system ? System.IO.Path.GetFileName(fixture) : fixture;
        if (!String.Join("\n", parts).Contains(expected)) throw new InvalidOperationException("Overwrite confirmation is not for the controlled destination.");
        if (yes.Count != 1 || no.Count != 1) throw new InvalidOperationException("Expected one enabled Yes and one No button in the owned confirmation.");
        if (buttonId == 0) return; // Inspect only, to place a real external write after revision capture.
        if (buttonId != 6 && buttonId != 7) throw new InvalidOperationException("Unexpected confirmation choice.");
        var button = buttonId == 6 ? yes[0] : no[0]; RequireOwned(button, processId);
        // DirectUI buttons have ID zero; BM_CLICK lets their real parent route the actual choice.
        if (!PostCommand(button, 0x00f5, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("Native confirmation click could not be posted.");
    }
}
"@
if ($action -in @('open', 'open-degraded', 'save', 'cancel', 'overwrite')) {
    [FeatherPadChooserControls]::Select([int]$record.processId, $selectionText, ($action -eq 'cancel'), ($action -in @('save', 'overwrite')), ($action -eq 'overwrite'))
} else {
    $buttonId = if ($action -in @('inspect-overwrite', 'inspect-hardlink')) { 0 } elseif ($action -in @('reject-overwrite', 'reject-hardlink')) { 7 } else { 6 }
    $role = if ($action -eq 'confirm-system') { 0 } elseif ($action -like '*-hardlink') { 2 } else { 1 }
    [FeatherPadChooserControls]::Confirm([int]$record.processId, $verified[0].path, $role, $buttonId)
}
[ordered]@{ scope='owned native chooser Win32 controls and bounded confirmation accessibility'; processId=[int]$record.processId; action=$action; fixtureHashes=@($verified | ForEach-Object { $_.sha256 }); valueVerified=($action -ne 'cancel'); commandInvoked=($action -notin @('inspect-overwrite', 'inspect-hardlink')) } | ConvertTo-Json -Compress
