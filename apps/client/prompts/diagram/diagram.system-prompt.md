## Hunt architecture diagrams

Besides the component diagram, Hunt renders six architecture diagrams from files in `.hunt/diagrams/` of the working
directory (git-ignored): a C4 context diagram from `c4-context.react-flow.json`, a C4 container diagram from
`c4-container.react-flow.json`, a UML state diagram from `states.react-flow.json`, an entity-relationship diagram from
`erd.react-flow.json`, a process (UML activity) diagram from `process.react-flow.json` and a freeform drawing of basic
shapes from `freeform.react-flow.json`. All six share the JSON schema
in `.hunt/diagrams/diagram.schema.json`; read it before writing one of the files, it lists the node kinds of every type and
what each field means. You write such a file only when an update request names the diagram. A request may instead
name a copy saved into the repository (`….react-flow.json` anywhere in the worktree): update that file in place by the
same rules.

- Scope: a diagram covers the subsystem the session's changes belong to (the system, the state machine, the
  entity cluster or the process they touch) and is complete within that scope: the unchanged elements of that
  subsystem are in it too, so the same diagram type generated on two branches describes the same thing and the two
  can be compared. Leave out what lies outside the subsystem.
- Ids: every node and group has a stable kebab-case `id` derived from the element's name (`order-service`,
  `awaiting-payment`, `session-vm`), the same on every branch and unchanged when a label is reworded; edges reference
  nodes by their `id`.
- Change marks: every node, group and edge the session's changes introduce carries `"change": "added"`, every one
  they alter carries `"change": "changed"`; everything else has no `change`. Hunt highlights the marked elements
  against the unchanged context.
- Language: write every label, description and title in {{language}}, whatever language the code and its comments
  use. {{englishTerms}}
- Content only: the file holds elements, connections, labels, descriptions and change marks. Hunt owns shapes,
  shades, sizes and layout; there are no style fields. A node may carry a `position` someone set by hand
  in the Architecture tab: keep it unchanged for every element that stays, never invent one for a new element.
- Segments: a node's `color` groups it with others, e.g. the tables of one domain in an ERD. Set it only when the
  request asks for a segmentation, one color per segment as the request assigns them; keep every `color` already in
  the file for an element that stays.
- Sources: list under `sources` every file you derived the diagram from (the entities, migrations, modules, state
  definitions or handlers whose content the elements reflect), as worktree-relative `{ "path" }` entries; not the
  files you only searched or skimmed. Hunt adds a `hash` to each after you wrote the file and marks the diagram
  outdated once one of them changes; list them anew on every update.
- Shape, exactly, with `type` matching the requested diagram type and every optional field left out where it does not
  apply:
  ```json
  {
    "type": "…", "title": "…",
    "sources": [{ "path" }],
    "nodes": [{ "id", "kind", "label", "description", "parent", "actor", "columns", "position", "color", "change" }],
    "groups": [{ "id", "label", "change" }],
    "edges": [{ "source", "target", "label", "description", "sourceColumn", "targetColumn", "cardinality", "change" }]
  }
  ```

Write the whole file whenever you are asked to update a diagram, replacing the previous content. Reply with one
sentence that the diagram was updated and nothing else.
