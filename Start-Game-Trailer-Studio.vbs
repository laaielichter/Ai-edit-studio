Option Explicit
Dim shell, script, command
Set shell = CreateObject("WScript.Shell")
script = Replace(WScript.ScriptFullName, ".vbs", ".ps1")
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & script & """"
shell.Run command, 0, False
