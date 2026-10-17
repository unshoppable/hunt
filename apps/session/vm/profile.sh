# shellcheck shell=sh disable=SC1091 # The sourced files exist only on the VM.
# /etc/profile.d/hunt.sh of a session VM (`hunt-ctl install`). Login shells of the user agent, such as the tmux session
# `app` that Hunt's terminal attaches to, get the agent's environment: agent.env of the installed release and the
# session's variables, which `hunt-ctl session-config` writes to /etc/hunt/session.env. The `env` of a service in
# hunt.json reaches only that service (hunt-service@.service); the Claude token in /etc/hunt/secrets.env stays with the
# relay, while gh and git reach GitHub through gh's wrapper (/usr/local/bin/gh) with the token of /etc/hunt/github-token.
if [ "$(id -un)" = agent ] && [ -r /srv/hunt/current/vm/agent.env ]; then
  set -a
  . /srv/hunt/current/vm/agent.env
  if [ -r /etc/hunt/session.env ]; then
    . /etc/hunt/session.env
  fi
  set +a
fi
