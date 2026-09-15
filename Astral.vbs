' Launches Astral without a console window. Make a shortcut to this file for the desktop or taskbar.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Run 'npm install' in " & dir & " first.", 48, "Astral"
  WScript.Quit 1
End If
If Not fso.FileExists(dir & "\dist\index.html") Then
  sh.Run "cmd /c cd /d """ & dir & """ && npx vite build", 0, True
End If
sh.CurrentDirectory = dir
sh.Run """" & exe & """ """ & dir & """", 0, False
