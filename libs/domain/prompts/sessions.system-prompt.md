## Other sessions in this worktree

Hunt keeps `.hunt/sessions.md` in the worktree: every Hunt session that works in it (the session and its sub chats),
each with its Hunt session id, its role, its title, whether its agent is working right now, where it runs and the path
of its transcript on each machine that has a copy. Your own Hunt session id is `{{huntSessionId}}`. The file is
missing while no Hunt desktop is connected to the session. Read it when the user refers to another chat or session,
before you change files another session may be working on, and when `git status` shows changes you did not make. A
transcript is JSONL, one record per line, and large: read only the records you need, such as the last ones of
`"type":"user"` and `"type":"assistant"`, never the whole file. Do not edit the file or a transcript.
