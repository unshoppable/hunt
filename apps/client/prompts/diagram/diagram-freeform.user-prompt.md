Update the Hunt freeform diagram for this session. The session's changes are the files
`git diff --name-only {{diffBase}}` lists plus untracked files (`git ls-files --others --exclude-standard`); use
exactly this base, whatever earlier diagrams covered.

Rebuild `.hunt/diagrams/freeform.react-flow.json` (`"type": "freeform"`, schema in `.hunt/diagrams/diagram.schema.json`) as
described in your instructions:

- Scope: the diagram shows what the additional instructions below ask for. Without instructions it sketches the
  session's changes: the parts they touch and how those parts work together.
- Nodes: pick each shape by what it stands for: `action` (box) for a thing or step, `state` (rounded box) for a
  condition or phase, `decision` (diamond) for a question, `start` and `end` (circles) for entry and exit points,
  `person` for a human, `database` for stored data, `queue` for a buffer or channel, `externalSystem` (dashed box) for
  something outside the scope. Put what a node is in `label` and one sentence on it in `description` where that helps.
- Groups: enclose elements that belong together in a group and name it in `label`; the elements name it as `parent`.
- Edges: connect what relates; label an edge with one to four words when the relation is not obvious.
- Change marks: mark every node, group and edge the session's changes introduce with `"change": "added"` and every
  one they alter with `"change": "changed"`; everything else carries no `change`.
- Ids: give every node and group a stable kebab-case `id` derived from its name.
- Language: write every label, description and title in {{language}}. {{englishTerms}}

Additional instructions for this run: {{instructions}}
