Update the Hunt state diagram for this session. The session's changes are the files
`git diff --name-only {{diffBase}}` lists plus untracked files (`git ls-files --others --exclude-standard`); use
exactly this base, whatever earlier diagrams covered.

Rebuild `.hunt/diagram.states.json` (`"type": "states"`, schema in `.hunt/diagram.schema.json`) as described in
your instructions:

- Scope: the diagram shows the one state machine of the entity the session's changes touch (an order, a session, a
  job, a document). It is complete within that scope, so every state of the entity is in it, changed or not.
- Nodes: one `start` node where the entity comes into being, one `state` node per state with the state's meaning in
  `description`, and an `end` node for every terminal state.
- Edges: an edge is a transition from the state left (`source`) to the state entered (`target`), labeled with the
  event that triggers it (`payment received`, `timeout`), with a `description` of one to three sentences on the
  condition and what the transition does.
- Change marks: mark every node and edge the session's changes introduce with `"change": "added"` and every one
  they alter with `"change": "changed"`; everything else carries no `change`.
- Ids: give every node a stable kebab-case `id` derived from its name.
- Language: write every label, description and title in {{language}}. {{englishTerms}}

Additional instructions for this run: {{instructions}}
