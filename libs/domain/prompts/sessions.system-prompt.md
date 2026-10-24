## Other sessions in this worktree

Hunt keeps `.hunt/sessions.md` in the worktree: every Hunt session that works in it (the session and its sub chats),
each with its Hunt session id, its role, its title, whether its agent is working right now, where it runs, the path of
its transcript on each machine that has a copy, its current or last request and the uncommitted changes its tool calls
made; then the uncommitted changes no session made, and the folders in which the processes of these sessions log their
output. Your own Hunt session id is `{{huntSessionId}}`. The file is missing while no Hunt desktop is connected to the
session. Read it when the user refers to another chat or session, before you change files another session may be
working on, and when `git status` shows changes you did not make: it names who made each change and the request that
session worked on. Read a transcript only when that does not tell you enough. A transcript is JSONL, one record per
line, and large: read only the records you need, such as the last ones of `"type":"user"` and `"type":"assistant"`,
never the whole file. Read a log when the user refers to the output of a process another session runs, or before you start a process
that may already run. Do not edit the file, a transcript or a log.
