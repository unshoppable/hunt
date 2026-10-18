Update the Hunt ERD diagram for this session. The session's changes are the files
`git diff --name-only {{diffBase}}` lists plus untracked files (`git ls-files --others --exclude-standard`); use
exactly this base, whatever earlier diagrams covered.

Rebuild `.hunt/diagram.erd.json` (`"type": "erd"`, schema in `.hunt/diagram.schema.json`) as described in your
instructions:

- Scope: the diagram shows the entities the session's changes touch together with every table they reference or
  that references them. It is complete within that scope, so unchanged tables of the cluster are in it too.
- Nodes: every node is a `table` with the table's purpose in `description` and its `columns` in the order they are
  declared, each with its `name` and declared `type` and with `isPrimaryKey` or `isForeignKey` set to true where
  that applies.
- Edges: an edge runs from the table holding the foreign key (`source`, its column in `sourceColumn`) to the table
  holding the referenced key (`target`, its column in `targetColumn`), with `cardinality` giving how many rows take
  part on each side (`many` on the foreign-key side, `one` on the referenced primary key), a `label` naming the
  relationship as a verb (`belongs to`, `owns`) and a `description` of one to three sentences on what the
  relationship means.
- Change marks: mark every table and edge the session's changes introduce with `"change": "added"` and every one
  they alter (a column added, renamed, retyped or dropped; a key changed) with `"change": "changed"`; everything
  else carries no `change`.
- Ids: give every table a stable kebab-case `id` derived from its name.
- Language: write every label, description and title in {{language}}; column names and types stay as declared.
  {{englishTerms}}

Additional instructions for this run: {{instructions}}
