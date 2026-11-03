param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('HoldConflict', 'Press', 'Minimize', 'Query')]
  [string]$Action,
  [string]$Shortcut,
  [int]$ProcessId,
  [string]$ExpectedExecutable
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FeatherPadGlobalShortcutTestNative {
  [StructLayout(LayoutKind.Sequential)]
  private struct Point {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct WindowPlacement {
    public int Length;
    public int Flags;
    public int ShowCommand;
    public Point MinimumPosition;
    public Point MaximumPosition;
    public Rect NormalPosition;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr window, int id);

  [DllImport("user32.dll")]
  public static extern bool keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr window);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);

  [DllImport("user32.dll")]
  private static extern int GetWindowTextLength(IntPtr window);

  [DllImport("user32.dll")]
  private static extern bool GetWindowPlacement(IntPtr window, ref WindowPlacement placement);

  [DllImport("user32.dll")]
  private static extern bool SetWindowPlacement(IntPtr window, ref WindowPlacement placement);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern int GetWindowThreadProcessId(IntPtr window, out int processId);

  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  public static IntPtr FindVisibleWindow(int processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, parameter) => {
      int ownerProcessId;
      GetWindowThreadProcessId(window, out ownerProcessId);
      if (ownerProcessId == processId && IsWindowVisible(window) && GetWindowTextLength(window) > 0) {
        found = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string GetWindowTitle(IntPtr window) {
    int length = GetWindowTextLength(window);
    StringBuilder text = new StringBuilder(length + 1);
    GetWindowText(window, text, text.Capacity);
    return text.ToString();
  }

  public static bool MinimizeWindow(IntPtr window) {
    WindowPlacement placement = new WindowPlacement();
    placement.Length = Marshal.SizeOf(typeof(WindowPlacement));
    if (!GetWindowPlacement(window, ref placement)) return false;
    placement.ShowCommand = 6;
    return SetWindowPlacement(window, ref placement);
  }
}
'@

function Convert-Shortcut([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim() -or $Value.Length -gt 64) {
    throw 'Invalid shortcut'
  }
  $parts = $Value.Split('+')
  $key = $parts[-1]
  $modifiers = [uint32]0x4000
  for ($index = 0; $index -lt ($parts.Length - 1); $index++) {
    $modifier = switch ($parts[$index]) {
      'Ctrl' { [uint32]0x0002 }
      'Shift' { [uint32]0x0004 }
      'Alt' { [uint32]0x0001 }
      default { throw 'Invalid shortcut modifier' }
    }
    if (($modifiers -band $modifier) -ne 0) { throw 'Duplicate shortcut modifier' }
    $modifiers = $modifiers -bor $modifier
  }
  if (($modifiers -band (0x0002 -bor 0x0001)) -eq 0 -and $key -notmatch '^F([1-9]|1[0-2])$') {
    throw 'Shortcut requires Ctrl, Alt, or a function key'
  }
  $virtualKey = switch -Regex ($key) {
    '^F([1-9]|1[0-2])$' { [uint32](0x6F + [int]$key.Substring(1)) }
    '^[A-Za-z0-9]$' { [uint32][char]::ToUpperInvariant($key[0]) }
    '^Space$' { [uint32]0x20 }
    '^Tab$' { [uint32]0x09 }
    '^Enter$' { [uint32]0x0D }
    default { throw 'Invalid shortcut key' }
  }
  return [pscustomobject]@{ Modifiers = $modifiers; VirtualKey = $virtualKey }
}

function Get-OwnedWindow {
  if ($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedExecutable)) {
    throw 'A positive process id and expected executable are required'
  }
  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  $expected = [IO.Path]::GetFullPath($ExpectedExecutable)
  $actual = [IO.Path]::GetFullPath($process.Path)
  if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Owned executable mismatch'
  }
  $window = [FeatherPadGlobalShortcutTestNative]::FindVisibleWindow($ProcessId)
  if ($window -eq [IntPtr]::Zero) {
    throw 'Owned process has no visible top-level window'
  }
  return $window
}

switch ($Action) {
  'HoldConflict' {
    if ([string]::IsNullOrWhiteSpace($Shortcut)) { throw 'Shortcut is required' }
    $parsed = Convert-Shortcut $Shortcut
    if (-not [FeatherPadGlobalShortcutTestNative]::RegisterHotKey(
      [IntPtr]::Zero, 0x4651, $parsed.Modifiers, $parsed.VirtualKey
    )) {
      throw "Unable to reserve external shortcut: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    try {
      [Console]::Out.WriteLine('READY')
      [Console]::Out.Flush()
      while ($true) { Start-Sleep -Seconds 1 }
    } finally {
      [void][FeatherPadGlobalShortcutTestNative]::UnregisterHotKey([IntPtr]::Zero, 0x4651)
    }
  }
  'Press' {
    if ([string]::IsNullOrWhiteSpace($Shortcut)) { throw 'Shortcut is required' }
    $parsed = Convert-Shortcut $Shortcut
    $keys = [System.Collections.Generic.List[byte]]::new()
    if (($parsed.Modifiers -band 0x0002) -ne 0) { $keys.Add(0x11) }
    if (($parsed.Modifiers -band 0x0004) -ne 0) { $keys.Add(0x10) }
    if (($parsed.Modifiers -band 0x0001) -ne 0) { $keys.Add(0x12) }
    foreach ($key in $keys) {
      [void][FeatherPadGlobalShortcutTestNative]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 25
    }
    [void][FeatherPadGlobalShortcutTestNative]::keybd_event([byte]$parsed.VirtualKey, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [void][FeatherPadGlobalShortcutTestNative]::keybd_event([byte]$parsed.VirtualKey, 0, 2, [UIntPtr]::Zero)
    for ($index = $keys.Count - 1; $index -ge 0; $index--) {
      [void][FeatherPadGlobalShortcutTestNative]::keybd_event($keys[$index], 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 25
    }
  }
  'Minimize' {
    $window = Get-OwnedWindow
    if (-not [FeatherPadGlobalShortcutTestNative]::MinimizeWindow($window)) {
      throw 'Unable to post the owned window minimize command'
    }
  }
  'Query' {
    $window = Get-OwnedWindow
    $foreground = [FeatherPadGlobalShortcutTestNative]::GetForegroundWindow()
    $foregroundProcessId = 0
    [void][FeatherPadGlobalShortcutTestNative]::GetWindowThreadProcessId(
      $foreground, [ref]$foregroundProcessId
    )
    [pscustomobject]@{
      processId = $ProcessId
      windowHandle = ('0x{0:X}' -f $window.ToInt64())
      windowTitle = [FeatherPadGlobalShortcutTestNative]::GetWindowTitle($window)
      minimized = [FeatherPadGlobalShortcutTestNative]::IsIconic($window)
      foregroundProcessId = $foregroundProcessId
      foreground = $foregroundProcessId -eq $ProcessId
    } | ConvertTo-Json -Compress
  }
}
