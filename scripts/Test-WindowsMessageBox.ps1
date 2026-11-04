param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedText,
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class FeatherPadDialogSnapshot {
  public string Title { get; set; }
  public string[] Texts { get; set; }
  public FeatherPadDialogSnapshot() {
    Title = "";
    Texts = new string[0];
  }
}

public static class FeatherPadDialogProbe {
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowTextLength(IntPtr window);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);

  [DllImport("user32.dll")]
  private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

  private static string WindowText(IntPtr window) {
    int length = GetWindowTextLength(window);
    if (length <= 0) return "";
    var text = new StringBuilder(length + 1);
    return GetWindowText(window, text, text.Capacity) > 0 ? text.ToString() : "";
  }

  private static bool IsDialog(IntPtr window) {
    var className = new StringBuilder(64);
    return GetClassName(window, className, className.Capacity) > 0
      && className.ToString() == "#32770";
  }

  public static FeatherPadDialogSnapshot Find(uint processId) {
    FeatherPadDialogSnapshot result = null;
    EnumWindows((window, parameter) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != processId || !IsWindowVisible(window)) return true;
      if (!IsDialog(window)) return true;
      string title = WindowText(window);
      var texts = new List<string>();
      EnumChildWindows(window, (child, childParameter) => {
        string text = WindowText(child);
        if (!String.IsNullOrWhiteSpace(text)) texts.Add(text);
        return true;
      }, IntPtr.Zero);
      result = new FeatherPadDialogSnapshot { Title = title, Texts = texts.ToArray() };
      return false;
    }, IntPtr.Zero);
    return result;
  }

  public static bool Close(uint processId) {
    bool closed = false;
    EnumWindows((window, parameter) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != processId || !IsWindowVisible(window) || !IsDialog(window)) {
        return true;
      }
      closed = PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
      return false;
    }, IntPtr.Zero);
    return closed;
  }
}
"@

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$snapshot = $null
do {
  $snapshot = [FeatherPadDialogProbe]::Find([uint32]$TargetProcessId)
  if ($null -ne $snapshot) {
    $body = $snapshot.Texts -join "`n"
    if ($body.IndexOf($ExpectedText, [StringComparison]::Ordinal) -ge 0) {
      break
    }
  }
  if ($null -eq (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
    throw "The target process exited before the expected error dialog appeared."
  }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)

if ($null -eq $snapshot) {
  throw "No visible FeatherPad error dialog was found for process $TargetProcessId."
}
$text = $snapshot.Texts -join "`n"
if ($text.IndexOf($ExpectedText, [StringComparison]::Ordinal) -lt 0) {
  throw "The error dialog did not contain the expected text. Actual text: $text"
}
if (-not [FeatherPadDialogProbe]::Close([uint32]$TargetProcessId)) {
  throw "The FeatherPad error dialog could not be closed."
}

[pscustomobject]@{
  title = $snapshot.Title
  text = $text
  expectedText = $ExpectedText
  closed = $true
} | ConvertTo-Json -Depth 3
