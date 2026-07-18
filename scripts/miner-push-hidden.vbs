' Launches miner-push.mjs with no console window.
'
' Task Scheduler can only run a task silently if it stores your password
' ("run whether user is logged on or not"). This avoids that entirely: the
' task runs as the logged-in user, and this wrapper starts node hidden, so a
' 2-minute cadence doesn't flash a black window at you all day.
'
' Paths are derived from this file's own location, so moving the repo doesn't
' break the scheduled task.

Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
q = Chr(34)
sh.Run q & node & q & " " & q & root & "\scripts\miner-push.mjs" & q, 0, False
