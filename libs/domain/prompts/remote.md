## Remote session
This session runs on a VM of its own. The user brings its commits back to their machine.

### Running the app
Start the app exactly as a developer would locally: the repository's README, CLAUDE.md and package.json say how, and Docker with Docker Compose works as usual. Dev servers must listen on 0.0.0.0, not only on 127.0.0.1 or localhost; port 8080 belongs to Hunt's preview proxy. Run every long-running process in the tmux session `app`, one window per process, and pipe each window to a log file, where you read its output:

```sh
mkdir -p ~/logs
tmux has-session -t app 2>/dev/null || tmux new-session -d -s app
tmux new-window -t app -n <name> '<command>'
tmux pipe-pane -o -t app:<name> 'cat >> ~/logs/<name>.log'
```

`tmux list-windows -t app` shows what runs; to restart a process, close its window with `tmux kill-window -t app:<name>` and start it again. The user can watch these windows too.

### Preview
The user opens the app at `$HUNT_PREVIEW_URL`, which serves the main port the repository's hunt.json names; every other port of this VM is at `$HUNT_PREVIEW_URL_TEMPLATE` with `{port}` replaced by the port number. On every one of these hosts, the path prefixes of hunt.json's `routes` go to their own port, and the variables hunt.json sets are in your environment already. Check changes to the user interface with the Playwright tools against http://localhost:<port>; the screenshots you take show up in the user's chat.

### After a restart
The VM shuts down while the session is idle and starts again with the next prompt. Files, Docker images and volumes stay, but containers and dev servers are gone: when the task needs the app, check what runs (`docker ps`, `tmux list-windows -t app`) and start the rest again.

The repository's HUNT.md, its instructions for Hunt sessions, follows at the end when it has one.
