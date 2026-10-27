' ============================================================
' (fix 570) Hidden launch of start.bat
'
' WshShell.Run: non-blocking process launch.
' 0 = HideWindow (window does not appear in taskbar or screen)
' False = do not wait for completion (VBS exits immediately, cmd runs in background)
'
' When Electron window is closed, electron/main.js kills parent
' cmd process via taskkill (parent PID = process.ppid in Node.js).
'
' Launch: cscript //nologo start_hidden.vbs
' ============================================================

Option Explicit

' (fix 580) VBS error dialog on startup — otherwise errors are hidden
' and the user only sees empty start.bat output.
On Error Resume Next

Dim shell
Set shell = CreateObject("WScript.Shell")
' (fix 587) Echo strings are ASCII: file is UTF-8, but cscript reads VBS
' as ANSI, so non-ASCII in Echo would become garbled.
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to create WshShell: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If

' Path to start.bat — in the same folder as this VBS script
' (fix 574) WScript.ScriptFolder does not work in cscript — use FSO
' (fix 716) Errors during FSO creation/folder resolution ARE CHECKED. Previously
' On Error Resume Next suppressed them, and script exited with code 0 without
' launching anything (user saw nothing).
Dim fso, scriptDir, batPath
Set fso = CreateObject("Scripting.FileSystemObject")
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to create FileSystemObject: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to resolve script folder: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If
If Len(scriptDir) = 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to resolve script folder (empty path)"
  WScript.Quit 1
End If
batPath = scriptDir & "\start.bat"

' Launch: 0 = hidden window, False = non-blocking
' (fix 570) cmd /c call "...\start.bat" :hidden — bat will receive :hidden as $1.
' Quotes via Chr(34) preserve paths with spaces; VBS exits immediately.
shell.Run "cmd /c call " & Chr(34) & batPath & Chr(34) & " :hidden", 0, False
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to run start.bat: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If

' VBS exits — cmd (hidden window) continues running with Electron inside.
' When Electron window is closed, main.js will kill parent (cmd.exe) via taskkill.
WScript.Quit 0
