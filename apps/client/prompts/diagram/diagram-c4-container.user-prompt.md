Update the Hunt C4 container diagram for this session. The session's changes are the files
`git diff --name-only {{diffBase}}` lists plus untracked files (`git ls-files --others --exclude-standard`); use
exactly this base, whatever earlier diagrams covered.

Rebuild `.hunt/diagram.c4-container.json` (`"type": "c4-container"`, schema in `.hunt/diagram.schema.json`) as
described in your instructions:

- Scope: one group in `groups` is the boundary of the system the session's changes belong to, and every `container`
  (a deployable process: app, service, worker, job), `database` and `queue` of that system names it as `parent`; the
  `person` nodes that use it and the `externalSystem` nodes it talks to sit outside the boundary. The diagram is
  complete within that scope: unchanged containers, databases and queues of the system are in it too.
- Nodes: the `description` of a container, database or queue names its technology (`Node, Express`,
  `PostgreSQL 16`, `Pub/Sub`); for a person its role, for an external system what it provides.
- Edges: an edge points from the node that initiates the interaction to the one it uses, with a `label` of one to
  four words on what the source does with the target and the protocol (`reads orders over HTTPS`,
  `publishes events`) and a `description` of one to three sentences on what the connection carries and why.
- Change marks: mark every node, group and edge the session's changes introduce with `"change": "added"` and every
  one they alter with `"change": "changed"`; everything else carries no `change`.
- Ids: give every node and group a stable kebab-case `id` derived from its name.
- Language: write every label, description and title in {{language}}. {{englishTerms}}

Additional instructions for this run: {{instructions}}
