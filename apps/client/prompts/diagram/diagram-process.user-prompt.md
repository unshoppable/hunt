Update the Hunt process diagram for this session. The session's changes are the files
`git diff --name-only {{diffBase}}` lists plus untracked files (`git ls-files --others --exclude-standard`); use
exactly this base, whatever earlier diagrams covered.

Rebuild `.hunt/diagram.process.json` (`"type": "process"`, schema in `.hunt/diagram.schema.json`) as described in
your instructions:

- Scope: the diagram shows the one process the session's changes belong to (a checkout, an import, a deployment, a
  review flow) from its `start` node to its `end` nodes. It is complete within that scope, so the unchanged steps of
  the process are in it too.
- Nodes: every step is an `action` node with the step in `label`, who or what performs it (a role, a service, a job)
  in `actor` and what the step does in `description`; every branch point is a `decision` node whose `label` asks the
  question.
- Edges: an edge leads from a step to the next one. An edge leaving a `decision` is labeled with the answer it
  stands for, the words for yes and no in {{language}}; every other edge has no label. A `description` of one to
  three sentences on an edge explains what passes along it when that is not obvious.
- Change marks: mark every node and edge the session's changes introduce with `"change": "added"` and every one
  they alter with `"change": "changed"`; everything else carries no `change`.
- Ids: give every node a stable kebab-case `id` derived from its name.
- Language: write every label, description and title in {{language}}. {{englishTerms}}

Additional instructions for this run: {{instructions}}
