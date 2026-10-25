import type * as monaco from "monaco-editor";

/** Words the Angular template syntax colors as keywords: control flow parameters, microsyntax and `@defer` triggers. */
const TEMPLATE_KEYWORDS = ["as", "of", "track", "let", "typeof", "in", "void", "when", "on", "prefetch", "hydrate"];

const TEMPLATE_PRIMITIVES = ["null", "undefined", "true", "false", "this"];

/** Interpolations and block parameters may quote strings either way; an attribute's expression only with the other quote. */
const BOTH_QUOTES = ["'", '"'] as const;

/** Control flow blocks that take parameters in parentheses (`@if (…)`); `@else`, `@default` and `@empty` take none. */
const PARAMETRIZED_BLOCK = /(@(?:else\s+if|if|for|switch|case|defer|placeholder|loading|error))(\s*)(\()/;
const BLOCK = /@(?:else\s+if|if|else|for|switch|case|default|defer|placeholder|loading|error|empty)\b/;

/** Token of a tag name: elements with a dash are components and custom elements (`ng-container`, `app-card`). */
function tagToken(next?: string): monaco.languages.IExpandedMonarchLanguageAction {
  const tag = (token: string) => (next ? { token, next } : { token });
  return { cases: { "~.*-.*": tag("tag.custom"), "@default": tag("tag") } };
}

/**
 * Rules of an Angular expression (interpolations, bindings, block parameters). Names at the top of an expression
 * are `identifier.ng` (`identifier.ng.function` when called), which the semantic tokens of semanticTokens.ts color
 * by what the Angular language server says they are (signal, method, field); without a server (previews) a called
 * name keeps the method color. Members, pipes, keys and literals get their color here.
 */
function expressionRules(stringQuotes: readonly ("'" | '"')[]): monaco.languages.IMonarchLanguageRule[] {
  const strings = stringQuotes.map((quote): monaco.languages.IMonarchLanguageRule => [new RegExp(`${quote}(?:[^${quote}\\\\]|\\\\.)*${quote}?`), "string"]);
  return [
    [/\{/, { token: "delimiter.bracket", next: "@objectKey" }],
    [/(\|\|)/, "operator.ng"],
    [/(\|)(\s*)([a-zA-Z_$][\w$]*)/, ["operator.ng", "", "identifier.pipe"]],
    [/(\??\.)(\s*)([a-zA-Z_$][\w$]*)(?=\s*\()/, ["delimiter.dot", "", "identifier.member.function"]],
    [/(\??\.)(\s*)([a-zA-Z_$][\w$]*)/, ["delimiter.dot", "", "identifier.member"]],
    // A microsyntax key (`context:` of `*ngTemplateOutlet="…; context: …"`) names a directive input, not a member.
    [/[a-zA-Z_$][\w$]*(?=:(?!:))/, "identifier"],
    [/[a-zA-Z_$][\w$]*(?=\s*\()/, { cases: { "@primitives": "keyword.primitive", "@keywords": "keyword", "@default": "identifier.ng.function" } }],
    [/[a-zA-Z_$][\w$]*/, { cases: { "@primitives": "keyword.primitive", "@keywords": "keyword", "@default": "identifier.ng" } }],
    [/\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],
    ...strings,
    [/[()]/, "delimiter.parenthesis"],
    [/[[\]]/, "delimiter.array"],
    [/[;,]/, "delimiter.separator"],
    [/[=><!~?:&|+\-*/%^]+/, "operator.ng"],
    [/[ \t\r\n]+/, ""],
  ];
}

/**
 * Monarch grammar for HTML with Angular's template syntax, colored like WebStorm: control flow blocks, interpolations,
 * property, event and two-way bindings, structural directives, template references and variables, pipes, and
 * component tags. Plain HTML files read the same, since none of that syntax appears in them.
 */
export function angularTemplateLanguage(): monaco.languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix: ".html",
    keywords: TEMPLATE_KEYWORDS,
    primitives: TEMPLATE_PRIMITIVES,
    tokenizer: {
      root: [
        [/<!DOCTYPE/i, "metatag", "@doctype"],
        [/<!--/, "comment", "@comment"],
        [/(<)(script)\b/i, ["delimiter", { token: "tag", next: "@script" }]],
        [/(<)(style)\b/i, ["delimiter", { token: "tag", next: "@style" }]],
        [/(<\/?)([\w-]+(?::[\w-]+)?)/, ["delimiter", tagToken("@tag")]],
        [/</, "delimiter"],
        [/\{\{/, { token: "delimiter.interpolation", next: "@interpolation" }],
        // Monarch reads `@name` in a regex as one of the grammar's attributes; `[@]` is a literal `@`.
        [/([@]let)(\s+)/, ["keyword.block", { token: "", next: "@letDeclaration" }]],
        [PARAMETRIZED_BLOCK, ["keyword.block", "", { token: "delimiter.parenthesis", next: "@blockParameters" }]],
        [BLOCK, "keyword.block"],
        [/[{}]/, "delimiter.block"],
        [/&(?:[a-zA-Z]\w*|#\d+|#x[0-9a-fA-F]+);/, "entity"],
        [/[^<{}@&]+/, "text"],
        [/[@&]/, "text"],
      ],
      doctype: [
        [/[^>]+/, "metatag.content"],
        [/>/, "metatag", "@pop"],
      ],
      comment: [
        [/-->/, "comment", "@pop"],
        [/[^-]+/, "comment.content"],
        [/./, "comment.content"],
      ],
      tag: [
        [/\/?>/, "delimiter", "@pop"],
        [/\[\([\w.\-$]+\)\]/, { token: "attribute.name.banana", next: "@bindingValue" }],
        [/\[[\w.\-$@%]+\]|\([\w.\-$:@]+\)|\*[\w\-$]+/, { token: "attribute.name.binding", next: "@bindingValue" }],
        [/(#|let-|ref-)([\w\-$]+)/, ["attribute.name", "variable"]],
        [/[\w\-:.@$]+/, "attribute.name"],
        [/=/, "delimiter"],
        [/"/, { token: "attribute.value", next: "@valueDouble" }],
        [/'/, { token: "attribute.value", next: "@valueSingle" }],
        [/[ \t\r\n]+/, ""],
      ],
      bindingValue: [
        [/=/, "delimiter"],
        [/[ \t\r\n]+/, ""],
        [/"/, { token: "attribute.value", switchTo: "@expressionDouble" }],
        [/'/, { token: "attribute.value", switchTo: "@expressionSingle" }],
        [/./, { token: "@rematch", next: "@pop" }],
      ],
      expressionDouble: [[/"/, { token: "attribute.value", next: "@pop" }], ...expressionRules(["'"])],
      expressionSingle: [[/'/, { token: "attribute.value", next: "@pop" }], ...expressionRules(['"'])],
      valueDouble: [
        [/"/, { token: "attribute.value", next: "@pop" }],
        [/\{\{/, { token: "delimiter.interpolation", next: "@interpolation" }],
        [/[^"{]+/, "attribute.value"],
        [/\{/, "attribute.value"],
      ],
      valueSingle: [
        [/'/, { token: "attribute.value", next: "@pop" }],
        [/\{\{/, { token: "delimiter.interpolation", next: "@interpolation" }],
        [/[^'{]+/, "attribute.value"],
        [/\{/, "attribute.value"],
      ],
      interpolation: [[/\}\}/, { token: "delimiter.interpolation", next: "@pop" }], ...expressionRules(BOTH_QUOTES)],
      blockParameters: [
        [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
        [/\(/, { token: "delimiter.parenthesis", next: "@parentheses" }],
        ...expressionRules(BOTH_QUOTES),
      ],
      parentheses: [
        [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
        [/\(/, { token: "delimiter.parenthesis", next: "@parentheses" }],
        ...expressionRules(BOTH_QUOTES),
      ],
      letDeclaration: [[/;/, { token: "delimiter.separator", next: "@pop" }], ...expressionRules(BOTH_QUOTES)],
      // An object literal alternates between a key and its value; `,` starts the next key, `}` ends the literal.
      objectKey: [
        [/[ \t\r\n]+/, ""],
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/[a-zA-Z_$][\w$]*|'[^']*'|"[^"]*"/, { token: "identifier.property", switchTo: "@objectValue" }],
        [/./, { token: "@rematch", switchTo: "@objectValue" }],
      ],
      objectValue: [
        [/,/, { token: "delimiter.separator", switchTo: "@objectKey" }],
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        ...expressionRules(BOTH_QUOTES),
      ],
      script: [
        [/"[^"]*"|'[^']*'/, "attribute.value"],
        [/[\w-]+/, "attribute.name"],
        [/=/, "delimiter"],
        [/>/, { token: "delimiter", next: "@scriptEmbedded", nextEmbedded: "text/javascript" }],
        [/[ \t\r\n]+/, ""],
        [/(<\/)(script\s*)(>)/i, ["delimiter", "tag", { token: "delimiter", next: "@pop" }]],
      ],
      scriptEmbedded: [
        [/<\/script/i, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
        [/[^<]+/, ""],
      ],
      style: [
        [/"[^"]*"|'[^']*'/, "attribute.value"],
        [/[\w-]+/, "attribute.name"],
        [/=/, "delimiter"],
        [/>/, { token: "delimiter", next: "@styleEmbedded", nextEmbedded: "text/css" }],
        [/[ \t\r\n]+/, ""],
        [/(<\/)(style\s*)(>)/i, ["delimiter", "tag", { token: "delimiter", next: "@pop" }]],
      ],
      styleEmbedded: [
        [/<\/style/i, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
        [/[^<]+/, ""],
      ],
    },
  };
}

/** The semantic token types of a template, in legend order (see `templateRoleOfHover`). */
export const TEMPLATE_ROLES = ["signal", "instanceMethod", "instanceField"] as const;

export type TemplateRole = (typeof TEMPLATE_ROLES)[number];

/**
 * What a name at the top of a template expression is, from the signature in the Angular language server's hover:
 * `(property) Card.displayName: () => string` (a computed signal, printed as its call signature) or
 * `(property) Card.employee: InputSignal<…>` is a signal, `(method) Card.toggle(): void` a method, any other
 * component property a field. Template variables, references and pipes keep the grammar's color (null).
 */
export function templateRoleOfHover(signature: string): TemplateRole | null {
  const match = /^(?:[a-z]+ )*\((property|method)\) [\w$]+(?:<[^>]*>)?\.[\w$]+(\??:\s*([\s\S]*))?/.exec(signature);
  if (!match) return null;
  if (match[1] === "method") return "instanceMethod";
  const type = match[3] ?? "";
  return /^(?:\w*Signal\b|\(\) =>)/.test(type) ? "signal" : "instanceField";
}
