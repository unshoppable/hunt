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