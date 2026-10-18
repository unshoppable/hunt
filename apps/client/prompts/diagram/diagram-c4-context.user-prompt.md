Update the Hunt C4 context diagram for this session. The session's changes are the files
`git diff --name-only {{diffBase}}` lists plus untracked files (`git ls-files --others --exclude-standard`); use
exactly this base, whatever earlier diagrams covered.

Rebuild `.hunt/diagram.c4-context.json` (`"type": "c4-context"`, schema in `.hunt/diagram.schema.json`) as described
in your instructions:

- Scope: the diagram shows the system the session's changes belong to as one `system` node, the `person` nodes for
  the roles that use it and the `externalSystem` nodes it talks to. It is complete within that scope, so unchanged
  people and external systems are in it too.
- Nodes: the `description` of a node states the system's purpose, the person's role or what the external system
  provides.
- Edges: an edge points from the node that initiates the interaction to the one it uses, with a `label` of one to
  four words on what the source does with the target (`places orders`, `sends invoices over HTTPS`) and a
  `description` of one to three sentences on what the connection carries and why.
- Change marks: mark every node and edge the session's changes introduce with `"change": "added"` and every one
  they alter with `"change": "changed"`; everything else carries no `change`.
- Ids: give every node a stable kebab-case `id` derived from its name.
- Language: write every label, description and title in {{language}}. {{englishTerms}}

Additional instructions for this run: {{instructions}}
