## 0.27.2 (2026-10-24)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.27.1 (2026-10-24)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.27.0 (2026-10-24)

### 🚀 Features

- every tmux window on a session VM logs to ~/logs by itself and a script run there offers Run again; a terminal tab or a pipe-pane -o no longer ends a window's log, and logs move to .log.1 beyond 20 MiB ([91fa34f](https://github.com/unshoppable/hunt/commit/91fa34f))

## 0.26.0 (2026-10-24)

### 🚀 Features

- the ADR folder of a repository comes from adrDir in its hunt.json (default .claude/resources/adrs), and the guardrail folders are no setting any more ([b01aab5](https://github.com/unshoppable/hunt/commit/b01aab5))

## 0.25.0 (2026-10-24)

### 🚀 Features

- **session:** hunt.json declares checks, which hunt-ctl check runs in a session's worktree as the agent ([567116f](https://github.com/unshoppable/hunt/commit/567116f))

## 0.24.2 (2026-10-23)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.24.1 (2026-10-20)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.24.0 (2026-10-20)

### 🚀 Features

- the push target is the git upstream of the session's branch, which a plain git push in the worktree uses too, and a right click on a session changes it; the sidebar shows a running turn or a question of a remote session before it is opened; the Git tab resets the branch to a commit ([7fa8987](https://github.com/unshoppable/hunt/commit/7fa8987))

## 0.23.2 (2026-10-20)

### 🔥 Performance

- **session:** a resumed session VM connects up to 30 s sooner, and the progress says whether the VM wakes up or boots ([1c13251](https://github.com/unshoppable/hunt/commit/1c13251))

## 0.23.1 (2026-10-19)

### 🚀 Features

- **gateway:** the swf section of a repository's hunt.json sets the Claude model of the sessions the poller starts for its issues ("swf": {"model": "opus"}); without it Claude Code's default model applies ([33caaa4](https://github.com/unshoppable/hunt/commit/33caaa4))

### 🩹 Fixes

- **gateway:** swf.model in a repository's hunt.json takes only the full ID of a Claude model such as claude-opus-5-5; an alias such as opus is rejected, since its model changes with Claude Code's releases ([bcd7a09](https://github.com/unshoppable/hunt/commit/bcd7a09))

## 0.23.0 (2026-10-18)

### 🚀 Features

- suspend idle session VMs instead of powering them off; a resume into a stockout stops and moves the VM ([#40](https://github.com/unshoppable/hunt/issues/40))

## 0.22.0 (2026-10-18)

### 🚀 Features

- transcripts of a remote session stream live both ways, and .hunt/sessions.md tells the agents of a worktree about one another ([d875510](https://github.com/unshoppable/hunt/commit/d875510))

## 0.21.0 (2026-10-18)

### 🚀 Features

- push a remote session's branch from this Mac, and a poller session's from its VM with the stored token (hunt-ctl push --stored, protocol 9) ([c0e4b19](https://github.com/unshoppable/hunt/commit/c0e4b19))

## 0.20.1 (2026-10-18)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.20.0 (2026-10-18)

### 🚀 Features

- sub chats of a remote session run on this Mac, and connecting a remote session applies the Claude account selected now ([df1e413](https://github.com/unshoppable/hunt/commit/df1e413))

## 0.19.1 (2026-10-18)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.19.0 (2026-10-18)

### 🚀 Features

- live two-way file sync of remote sessions through a sync helper on the VM, and a read-only local worktree while the VM cannot be reached ([3dc8a42](https://github.com/unshoppable/hunt/commit/3dc8a42))

## 0.18.0 (2026-10-17)

### 🚀 Features

- remote secrets for the services of session VMs, maintained in Hunt under Settings → Remote VM ([f2dd755](https://github.com/unshoppable/hunt/commit/f2dd755))

## 0.17.0 (2026-10-17)

### 🚀 Features

- declare the ignored files a service needs per service as worktreeInclude in hunt.json ([d576906](https://github.com/unshoppable/hunt/commit/d576906))

## 0.16.0 (2026-10-17)

### 🚀 Features

- name the private files of a repository in its hunt.json (privateFiles) instead of the app's settings ([85bc8c4](https://github.com/unshoppable/hunt/commit/85bc8c4))

## 0.15.0 (2026-10-17)

### 🚀 Features

- act on GitHub as a GitHub App in poller sessions, with one-hour installation tokens the poller renews on running VMs (hunt-ctl github-token, gh wrapper, clone --git-name/--git-email) ([#36](https://github.com/unshoppable/hunt/issues/36))

## 0.14.0 (2026-10-17)

### 🚀 Features

- send the local tokens to a poller session's relay too, which takes them only where its VM stores none (hunt-ctl start/clear --keep-stored, protocol 6) ([4c221c3](https://github.com/unshoppable/hunt/commit/4c221c3))

## 0.13.4 (2026-10-16)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.13.3 (2026-10-16)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.13.2 (2026-10-16)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.13.1 (2026-10-15)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.13.0 (2026-10-15)

### 🚀 Features

- commit and push remote sessions from the changelist on their VM ([7816dab](https://github.com/unshoppable/hunt/commit/7816dab))

## 0.12.0 (2026-10-14)

### 🚀 Features

- show each process of a session VM in its own terminal tab ([473dcde](https://github.com/unshoppable/hunt/commit/473dcde))

## 0.11.0 (2026-10-14)

### 🚀 Features

- run the sub chats of a remote session on its VM ([85061d5](https://github.com/unshoppable/hunt/commit/85061d5))

## 0.10.0 (2026-10-14)

### 🚀 Features

- log every tool call the agent finishes on a session VM to the journal ([fb349b3](https://github.com/unshoppable/hunt/commit/fb349b3))

## 0.9.1 (2026-10-14)

### 🩹 Fixes

- reserve the ports of the session VM's system services instead of hiding them in the client ([4c38a12](https://github.com/unshoppable/hunt/commit/4c38a12))

## 0.9.0 (2026-10-14)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.8.1 (2026-10-14)

### 🩹 Fixes

- explain with a 503 that a preview's service is not running instead of an empty 502 ([06521e5](https://github.com/unshoppable/hunt/commit/06521e5))

## 0.8.0 (2026-10-14)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.7.0 (2026-10-14)

### 🚀 Features

- run the services of hunt.json as systemd units, with IAP-free hosts for unguarded ones ([#27](https://github.com/unshoppable/hunt/issues/27))

## 0.6.0 (2026-10-14)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.5.0 (2026-10-14)

### 🚀 Features

- write the services' log lines with their severity ([5c05eb6](https://github.com/unshoppable/hunt/commit/5c05eb6))

## 0.4.1 (2026-10-14)

### 🩹 Fixes

- **session:** write the preview proxy's warnings and errors as readable lines ([ac7b79b](https://github.com/unshoppable/hunt/commit/ac7b79b))

## 0.4.0 (2026-10-14)

### 🚀 Features

- log Compute Engine calls, VM commands and hunt-ctl's stderr ([e94176c](https://github.com/unshoppable/hunt/commit/e94176c))

## 0.3.2 (2026-10-14)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.3.1 (2026-10-14)

### 🚀 Features

- **vm:** log hunt-ctl steps to the journal ([2624b92](https://github.com/unshoppable/hunt/commit/2624b92))

## 0.3.0 (2026-10-14)

This was a version bump only for session to align it with other projects, there were no code changes.

## 0.2.0 (2026-10-14)

### 🚀 Features

- name session branches like app-framework and review pull requests on their own branch ([#10](https://github.com/unshoppable/hunt/pull/10))

## 0.1.0 (2026-10-14)

### 🚀 Features

- deploy the server apps from CI and control remote sessions through the gateway API ([cf48c48](https://github.com/unshoppable/hunt/commit/cf48c48))