param([string]$ProcName = "聊机")
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-Process -Name $ProcName | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { exit 1 }
$h = $p.MainWindowHandle
$sig = @"
using System;
using System.Runtime.InteropServices;
public class BF {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr ext);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
Add-Type -TypeDefinition $sig
if ([BF]::IsIconic($h)) { [void][BF]::ShowWindow($h, 9) }
[void][BF]::ShowWindow($h, 5)
$fg = [BF]::GetForegroundWindow()
$fgTid = 0; [void][BF]::GetWindowThreadProcessId($fg, [ref]$fgTid)
$myTid = [BF]::GetCurrentThreadId()
[void][BF]::AttachThreadInput($myTid, $fgTid, $true)
[BF]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][BF]::SetForegroundWindow($h)
[void][BF]::BringWindowToTop($h)
[BF]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][BF]::AttachThreadInput($myTid, $fgTid, $false)
Start-Sleep -Milliseconds 300
exit 0
