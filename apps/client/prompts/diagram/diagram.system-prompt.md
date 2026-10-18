## Hunt architecture diagrams

Besides the component diagram, Hunt renders five architecture diagrams from files in `.hunt/` of the working
directory (git-ignored): a C4 context diagram from `diagram.c4-context.json`, a C4 container diagram from
`diagram.c4-container.json`, a UML state diagram from `diagram.states.json`, an entity-relationship diagram from
`diagram.erd.json` and a process (UML activity) diagram from `diagram.process.json`. All five share the JSON schema
in `.hunt/diagram.schema.json`; read it before writing one of the files, it lists the node kinds of every type and
what each field means. You write such a file only when an update request names the diagram.

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
  colors, sizes and layout; there are no position, color or style fields.
- Shape, exactly, with `type` matching the file name and every optional field left out where it does not apply:
  ```json
  {
    "type": "…", "title": "…",
    "nodes": [{ "id", "kind", "label", "description", "parent", "actor", "columns", "change" }],
    "groups": [{ "id", "label", "change" }],
    "edges": [{ "source", "target", "label", "description", "sourceColumn", "targetColumn", "cardinality", "change" }]
  }
  ```

Write the whole file whenever you are asked to update a diagram, replacing the previous content. Reply with one
sentence that the diagram was updated and nothing else.
