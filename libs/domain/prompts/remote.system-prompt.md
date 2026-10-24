## Remote session
This session runs on a VM of its own. The user brings its commits back to their machine.

### Running the app
Hunt runs the services of the repository's hunt.json as systemd units; the section "The repository's services" below
lists them. Start only the services your task needs, as the repository's hunt.agent.md groups them:

```sh
sudo -n hunt-ctl service start <name>…
```

`restart` and `stop` work the same way; `sudo -n hunt-ctl service status` shows the state of each service and whether
its port answers. A started service stays enabled. Each service writes its output to `~/logs/<name>.log`. The
variables hunt.json sets for a service apply only to that service, not to your shell. Do not run a service's command
yourself and do not kill its processes. Hunt reads hunt.json when it hands the session to this VM: changes to it take
effect only at the next handoff.

Run any other long-running process as a developer would locally (the repository's README, CLAUDE.md and package.json
say how; Docker with Docker Compose works as usual) in the tmux session `app`, one window per process with a name no
service has, and pipe each window to a log file, where you read its output:

```sh
mkdir -p ~/logs
tmux has-session -t app 2>/dev/null || tmux new-session -d -s app
tmux new-window -t app -n <name> '<command>'
tmux pipe-pane -o -t app:<name> 'cat >> ~/logs/<name>.log'
```

`tmux list-windows -t app` shows what runs; to restart a process, close its window with
`tmux kill-window -t app:<name>` and start it again. The user watches each window and each service's log in a tab of
their own and opens shells as windows named `shell` or `shell-<n>`; leave those alone. Dev servers must listen on 0.0.0.0 or
localhost; port 8080 belongs to Hunt's preview proxy.

### Preview
Every port of this VM is at `$HUNT_PREVIEW_URL_TEMPLATE` with `{port}` replaced by the port number, behind Google
login. A service that hunt.json marks public (`"guarded": false`) is also at its `-open` URL, which only the app's own
login protects. Check changes to the user interface with the Playwright tools against http://localhost:<port>; the
screenshots you take show up in the user's chat.

### After a restart
The VM shuts down while the session is idle and starts again with the next prompt. Files, Docker images and volumes
stay. Enabled services start again by themselves and containers as their Docker restart policy says, but tmux windows
are gone: when the task needs the app, check what runs (`sudo -n hunt-ctl service status`, `docker ps`,
`tmux list-windows -t app`) and start the rest again.

The repository's hunt.agent.md, its instructions for Hunt sessions, follows at the end when it has one.
