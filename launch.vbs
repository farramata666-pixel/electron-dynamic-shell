Dim scriptDir
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

Set WshShell = CreateObject("WScript.Shell")
' WindowStyle 0 = hidden, bWaitOnReturn = True so VBScript stays alive until bat exits
WshShell.Run "cmd /c """ & scriptDir & "run.bat""", 0, True
