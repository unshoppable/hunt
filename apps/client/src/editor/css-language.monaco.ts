import * as monaco from "monaco-editor";

/**
 * Monarch grammar for CSS and SCSS that tokenizes what WebStorm colors apart: the parts of a selector (tag, class, id,
 * pseudo, `&`, attribute), at-rule keywords and their arguments (`@apply`'s Tailwind classes), property names and
 * values, numbers and their units, functions, colors, variables and interpolation. Every token is one segment plus the
 * postfix, so the theme picks the scheme's CSS.* color for `.css` and its SASS_* color for `.scss` (see
 * `stylesheetRules` in webstorm-scheme.monaco.ts).
 */
export function cssLanguage(tokenPostfix: ".css" | ".scss"): monaco.languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix,
    identifier: /-{0,2}(?:[a-zA-Z_]|\\.)(?:[\w-]|\\.)*/,
    number: /-?(?:\d*\.)?\d+(?:[eE][\-+]?\d+)?/,
    tokenizer: {
      root: [{ include: "@rule" }],
      // Selectors, at-rules and variable declarations: the top level, and what a block holds besides declarations.
      rule: [
        { include: "@whitespace" },
        [/(\$@identifier)(\s*)(:)/, ["variable", "", { token: "delimiter", next: "@value" }]],
        // Monarch reads `@name` in a regex as one of the grammar's attributes; `[@]` is a literal `@`.
        [/[@]apply(?![\w-])/, { token: "keyword", next: "@classList" }],
        [/[@][\w-]+/, { token: "keyword", next: "@atRule" }],
        [/#\{/, { token: "interpolation", next: "@interpolation" }],
        [/&/, "parentSelector"],
        [/(\.)(@identifier)/, ["delimiter", "className"]],
        [/%@identifier/, "className"],
        [/#@identifier/, "idSelector"],
        [/(::?)(@identifier)/, ["delimiter", "pseudo"]],
        [/\[/, { token: "delimiter", next: "@attributeSelector" }],
        [/\(/, { token: "delimiter", next: "@selectorArguments" }],
        [/\{/, { token: "delimiter", next: "@block" }],
        [/@identifier|\*/, "tag"],
        [/(@number)(%)/, ["number", "unit"]],
        [/@number/, "number"],
        [/[>+~]/, "operator"],
        [/[,;.:]/, "delimiter"],
      ],
      // A rule's body: declarations, nested rules and at-rules. A name followed by a colon is a property unless the
      // rest of the line reads like a selector (`a:hover {`).
      block: [
        [/\}/, { token: "delimiter", next: "@pop" }],
        [/([*_]?@identifier)(\s*)(:)(?=\s|\d|[^{;}]*[;}])/, ["propertyName", "", { token: "delimiter", next: "@value" }]],
        { include: "@rule" },
      ],
      value: [
        [/;/, { token: "delimiter", next: "@pop" }],
        [/(?=\})/, { token: "", next: "@pop" }],
        // SCSS nested properties (`font: { family: serif; }`)
        [/\{/, { token: "delimiter", switchTo: "@block" }],
        { include: "@term" },
      ],
      // The prelude of an at-rule up to its block or semicolon (`@media screen and (…)`, `@include name(…)`).
      atRule: [
        [/;/, { token: "delimiter", next: "@pop" }],
        [/\{/, { token: "delimiter", switchTo: "@block" }],
        [/(?=\})/, { token: "", next: "@pop" }],
        [/(?:and|or|not|only|if|in|from|through|to)(?![\w-])/, "keyword"],
        [/(@identifier)(\()/, ["function", { token: "delimiter", next: "@arguments" }]],
        [/@identifier/, "identifier"],
        { include: "@term" },
      ],
      // The class names of `@apply`, which may hold Tailwind's variant and value syntax (`hover:bg-red-500/50`).
      classList: [
        [/;/, { token: "delimiter", next: "@pop" }],
        [/(?=\})/, { token: "", next: "@pop" }],
        { include: "@whitespace" },
        [/!important(?![\w-])/, "important"],
        [/[^\s;}]+/, "identifier"],
      ],
      term: [
        { include: "@whitespace" },
        [/(url(?:-prefix)?)(\()/, ["function", { token: "delimiter", next: "@url" }]],
        [/(@identifier)(\()/, ["function", { token: "delimiter", next: "@arguments" }]],
        [/\(/, { token: "delimiter", next: "@arguments" }],
        [/(@number)(%|[a-zA-Z]+)/, ["number", "unit"]],
        [/@number/, "number"],
        [/#[0-9a-fA-F]+(?![\w-])/, "color"],
        [/"/, { token: "string", next: "@stringDouble" }],
        [/'/, { token: "string", next: "@stringSingle" }],
        [/\$@identifier/, "variable"],
        [/#\{/, { token: "interpolation", next: "@interpolation" }],
        [/!\s*(?:important|default|global|optional)(?![\w-])/, "important"],
        // A media feature or SCSS map key (`(min-width: 768px)`, `(primary: $blue)`)
        [/(@identifier)(\s*)(:)(?!:)/, ["propertyName", "", "delimiter"]],
        [/@identifier/, "propertyValue"],
        [/[+\-*\/%=<>!~^|&]+/, "operator"],
        [/[,.:]/, "delimiter"],
      ],
      arguments: [[/\)/, { token: "delimiter", next: "@pop" }], { include: "@term" }],
      selectorArguments: [[/\)/, { token: "delimiter", next: "@pop" }], { include: "@rule" }],
      attributeSelector: [
        [/\]/, { token: "delimiter", next: "@pop" }],
        [/"/, { token: "string", next: "@stringDouble" }],
        [/'/, { token: "string", next: "@stringSingle" }],
        [/@identifier/, "attributeName"],
        [/[~|^$*]?=/, "operator"],
        [/\s+/, ""],
      ],
      interpolation: [[/\}/, { token: "interpolation", next: "@pop" }], { include: "@term" }],
      url: [
        [/\)/, { token: "delimiter", next: "@pop" }],
        [/"/, { token: "string", next: "@stringDouble" }],
        [/'/, { token: "string", next: "@stringSingle" }],
        [/[^)"'\s]+/, "url"],
        [/\s+/, ""],
      ],
      stringDouble: [
        [/[^\\"]+/, "string"],
        [/\\./, "string"],
        [/"/, { token: "string", next: "@pop" }],
      ],
      stringSingle: [
        [/[^\\']+/, "string"],
        [/\\./, "string"],
        [/'/, { token: "string", next: "@pop" }],
      ],
      whitespace: [
        [/\s+/, ""],
        [/\/\*/, { token: "comment", next: "@comment" }],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[^*]+/, "comment"],
        [/\*/, "comment"],
      ],
    },
  };
}
