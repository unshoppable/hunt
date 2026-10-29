## Long-running processes
Run every process that keeps running, such as a dev server, a watcher or `docker compose up`, in the tmux session `app`
of this worktree, one window per process, named with lowercase letters, digits and dashes that no window has yet. Use
only this tmux, through its absolute path; the user's own may not exist:

```sh
{{tmux}} new-window -d -t app: -n <name> -c "$PWD" '<command>' 2>/dev/null || {{tmux}} new-session -d -s app -n <name> -c "$PWD" '<command>'
```

Each window writes its output to `.hunt/logs/desktop/<name>.log` in the worktree; read it there, for example with
`tail -n 100`. `{{tmux}} list-windows -t app` shows what runs; to restart a process, close its window with
`{{tmux}} kill-window -t app:<name>` and start it again. The user watches every window in a tab of the Terminal panel
and opens shells as windows named `shell` or `shell-<n>`; leave those alone. Each window names the Hunt session it
belongs to in its option `@hunt-session` (`{{tmux}} list-windows -t app -F '#{window_name} #{@hunt-session}'`), and
the windows you create get yours; close or restart a window of another session only when the user asks for it. Commands that end by themselves, such as
tests and builds, run as usual, not in tmux.
