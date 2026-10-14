# shellcheck shell=sh disable=SC1091 # The sourced files exist only on the VM.
# /etc/profile.d/hunt.sh of a session VM (`hunt-ctl install`). Login shells of the user agent, such as the tmux session
# `app` that Hunt's terminal attaches to, get the agent's environment: agent.env of the installed release and the
# session's variables from hunt.json (`hunt-ctl session-config`). The tokens in /etc/hunt/secrets.env stay with the relay.
if [ "$(id -un)" = agent ] && [ -r /srv/hunt/current/vm/agent.env ]; then
  set -a
  . /srv/hunt/current/vm/agent.env
  if [ -r /etc/hunt/session.env ]; then
    . /etc/hunt/session.env
  fi
  set +a
fi
