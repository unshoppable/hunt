#!/bin/bash
# Sets up the container of install.test.ts: the gateway's metadata, the fake tools, a fake Node that reports who runs it,
# and three OS Login users: alice, the admin bob (google-sudoers) and the admin carol, whom sudo lets run anything
# through a rule of her own, as OS Login grants it, without google-sudoers.
set -euo pipefail
mkdir -p /srv/fakemeta/instance/attributes /srv/fakemeta/project
echo projects/123/zones/europe-west1-c >/srv/fakemeta/instance/zone
echo 'europe-west1-c, europe-west1-b,us-central1-a,europe-west1-c,europe-west1-*,europe-west1-d' >/srv/fakemeta/instance/attributes/hunt-session-zones
echo medconomy-hunt >/srv/fakemeta/project/project-id
install -m 0755 /fixtures/curl /usr/local/bin/curl
install -m 0755 /fixtures/fake /usr/local/bin/systemctl
install -m 0755 /fixtures/fake /usr/local/bin/docker
install -D -m 0755 /fixtures/node /opt/hunt/node/bin/node
groupadd google-sudoers
useradd -m -s /bin/bash alice
useradd -m -s /bin/bash -G google-sudoers bob
useradd -m -s /bin/bash carol
echo 'carol ALL=(ALL:ALL) NOPASSWD: ALL' >/etc/sudoers.d/carol
chmod 0440 /etc/sudoers.d/carol
# sshd -t checks for its privilege separation folder, which systemd creates on a VM.
mkdir -p /run/sshd
