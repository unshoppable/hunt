import * as monaco from "monaco-editor";

/**
 * Colors of the WebStorm scheme "Darcula copy1" (~/Library/Application Support/JetBrains/WebStorm<version>/colors),
 * keyed by the scheme's attribute names so both stay easy to compare. Font styles follow the scheme's
 * FONT_TYPE: 1 bold, 2 italic, 3 bold italic.
 */
export const WEBSTORM = {
  TEXT: "f7e862",
  LINE_NUMBERS: "8790a5",
  INLAY_HINT_FOREGROUND: "868686",
  INLAY_HINT_BACKGROUND: "3b3b3b",
  KEYWORD: "c08cff",
  PRIMITIVE: "abb8ff",
  METADATA: "bef057",
  CLASS: "ff7ab3",
  INTERFACE: "fea7ff",
  ENUM: "a0afff",
  GLOBAL_FUNCTION: "ffa9a9",
  LOCAL_FUNCTION: "ffb5ac",
  STATIC_MEMBER_FUNCTION: "ff9b9c",
  STATIC_MEMBER_VARIABLE: "d8d1ac",
  GLOBAL_VARIABLE: "e7e648",
  TYPE_PARAMETER: "cceb7f",
  MODULE_NAME: "ff9b9c",
  INSTANCE_MEMBER_FUNCTION: "ff898a",
  INSTANCE_MEMBER_VARIABLE: "efee47",
  LOCAL_VARIABLE: "f7e9ba",
  PARAMETER: "b5eb44",
  STRING: "fbc966",
  STRING_ESCAPE: "cc7832",
  NUMBER: "99e4f9",
  REGEXP: "6a8759",
  COMMENT: "808080",
  DOC_COMMENT: "8b929f",
  DOC_MARKUP: "77b767",
  OPERATION_SIGN: "56b6c2",
  PUNCTUATION: "e9e9e9",
  CSS_PROPERTY_NAME: "c183f9",
  CSS_PROPERTY_VALUE: "fbad64",
  CSS_KEYWORD: "d75757",
  CSS_IDENT: "85c984",
  CSS_PSEUDO: "e8bf6a",
  CSS_FUNCTION: "fb73c0",
  CSS_HASH: "d1fc22",
  TAG: "629cfc",
  JSON_KEY: "9edafe",
} as const;

/**
 * Theme token rules mapping Monaco's token names to the scheme: the Monarch tokens of `typescriptLanguage` and the
 * built-in grammars, and one rule per WebStorm role of webstormRoles.ts (`class`, `parameter`, `instanceMethod`, …)
 * that the semantic tokens of semanticTokens.ts carry. The scheme's bold styles are left out: the editor font has
 * no bold weight, and the synthesized one breaks the monospace grid.
 */
export const WEBSTORM_TOKEN_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: "keyword", foreground: WEBSTORM.KEYWORD, fontStyle: "italic" },
  { token: "keyword.primitive", foreground: WEBSTORM.PRIMITIVE, fontStyle: "italic" },
  { token: "annotation", foreground: WEBSTORM.METADATA, fontStyle: "italic" },
  { token: "type.identifier", foreground: WEBSTORM.CLASS },
  { token: "type.identifier.interface", foreground: WEBSTORM.INTERFACE },
  { token: "type.identifier.alias", foreground: WEBSTORM.INTERFACE },
  { token: "type.identifier.enum", foreground: WEBSTORM.ENUM },
  { token: "identifier", foreground: WEBSTORM.LOCAL_VARIABLE },
  { token: "identifier.function", foreground: WEBSTORM.GLOBAL_FUNCTION },
  { token: "identifier.member", foreground: WEBSTORM.INSTANCE_MEMBER_VARIABLE },
  { token: "identifier.member.function", foreground: WEBSTORM.INSTANCE_MEMBER_FUNCTION },
  { token: "identifier.property", foreground: WEBSTORM.INSTANCE_MEMBER_VARIABLE },
  { token: "identifier.parameter", foreground: WEBSTORM.PARAMETER },
  { token: "variable", foreground: WEBSTORM.LOCAL_VARIABLE },

  // WebStorm roles of the semantic tokens (webstormRoles.ts)
  { token: "class", foreground: WEBSTORM.CLASS },
  { token: "interface", foreground: WEBSTORM.INTERFACE },
  { token: "enum", foreground: WEBSTORM.ENUM },
  // WebStorm colors type aliases, its own and those of the libraries (`Omit`, `Partial`), with TS.INTERFACE.
  { token: "typeAlias", foreground: WEBSTORM.INTERFACE },
  { token: "typeParameter", foreground: WEBSTORM.TYPE_PARAMETER },
  { token: "enumMember", foreground: WEBSTORM.STATIC_MEMBER_VARIABLE, fontStyle: "italic" },
  { token: "globalFunction", foreground: WEBSTORM.GLOBAL_FUNCTION },
  { token: "localFunction", foreground: WEBSTORM.LOCAL_FUNCTION },
  { token: "instanceMethod", foreground: WEBSTORM.INSTANCE_MEMBER_FUNCTION },
  { token: "staticMethod", foreground: WEBSTORM.STATIC_MEMBER_FUNCTION, fontStyle: "italic" },
  { token: "instanceField", foreground: WEBSTORM.INSTANCE_MEMBER_VARIABLE },
  { token: "staticField", foreground: WEBSTORM.STATIC_MEMBER_VARIABLE, fontStyle: "italic" },
  { token: "globalVariable", foreground: WEBSTORM.GLOBAL_VARIABLE },
  { token: "localVariable", foreground: WEBSTORM.LOCAL_VARIABLE },
  { token: "parameter", foreground: WEBSTORM.PARAMETER },
  { token: "moduleName", foreground: WEBSTORM.MODULE_NAME },
  { token: "label", foreground: WEBSTORM.MODULE_NAME },
  { token: "metadata", foreground: WEBSTORM.METADATA, fontStyle: "italic" },

  { token: "string", foreground: WEBSTORM.STRING },
  { token: "string.escape", foreground: WEBSTORM.STRING_ESCAPE },
  { token: "number", foreground: WEBSTORM.NUMBER },
  { token: "regexp", foreground: WEBSTORM.REGEXP },
  { token: "comment", foreground: WEBSTORM.COMMENT, fontStyle: "italic" },
  { token: "comment.doc", foreground: WEBSTORM.DOC_COMMENT, fontStyle: "" },
  { token: "comment.doc.tag", foreground: WEBSTORM.DOC_COMMENT, fontStyle: "italic underline" },
  { token: "comment.doc.markup", foreground: WEBSTORM.DOC_MARKUP },
  { token: "operator", foreground: WEBSTORM.OPERATION_SIGN, fontStyle: "italic" },
  { token: "operator.arrow", foreground: WEBSTORM.PUNCTUATION, fontStyle: "italic" },
  // Semicolons and commas are italic in the scheme; brackets and dots are upright and must say so to not inherit it.
  { token: "delimiter", foreground: WEBSTORM.PUNCTUATION, fontStyle: "italic" },
  { token: "delimiter.dot", foreground: WEBSTORM.PUNCTUATION, fontStyle: "" },
  { token: "delimiter.bracket", foreground: WEBSTORM.PUNCTUATION, fontStyle: "" },
  { token: "delimiter.array", foreground: WEBSTORM.PUNCTUATION, fontStyle: "" },
  { token: "delimiter.parenthesis", foreground: WEBSTORM.PUNCTUATION, fontStyle: "" },
  { token: "delimiter.angle", foreground: WEBSTORM.PUNCTUATION, fontStyle: "" },
  // WebStorm lexes the angle brackets of TypeScript generics as `<`/`>` operators (JS.OPERATION_SIGN).
  { token: "delimiter.angle.ts", foreground: WEBSTORM.OPERATION_SIGN, fontStyle: "italic" },
  { token: "delimiter.angle.js", foreground: WEBSTORM.OPERATION_SIGN, fontStyle: "italic" },

  // JSON (built-in grammar)
  { token: "string.key.json", foreground: WEBSTORM.JSON_KEY },
  { token: "string.value.json", foreground: WEBSTORM.STRING },
  { token: "keyword.json", foreground: WEBSTORM.KEYWORD, fontStyle: "italic" },

  // CSS / SCSS / LESS (built-in grammars)
  { token: "tag.css", foreground: WEBSTORM.TAG },
  { token: "tag.scss", foreground: WEBSTORM.TAG },
  { token: "tag.less", foreground: WEBSTORM.TAG },
  { token: "attribute.name.css", foreground: WEBSTORM.CSS_PROPERTY_NAME },
  { token: "attribute.name.scss", foreground: WEBSTORM.CSS_PROPERTY_NAME },
  { token: "attribute.name.less", foreground: WEBSTORM.CSS_PROPERTY_NAME },
  { token: "attribute.value.css", foreground: WEBSTORM.CSS_PROPERTY_VALUE },
  { token: "attribute.value.scss", foreground: WEBSTORM.CSS_PROPERTY_VALUE },
  { token: "attribute.value.less", foreground: WEBSTORM.CSS_PROPERTY_VALUE },
  { token: "attribute.value.number.css", foreground: WEBSTORM.NUMBER },
  { token: "attribute.value.unit.css", foreground: WEBSTORM.NUMBER },
  { token: "attribute.value.hex.css", foreground: WEBSTORM.NUMBER },
  { token: "keyword.css", foreground: WEBSTORM.CSS_KEYWORD },
  { token: "keyword.scss", foreground: WEBSTORM.CSS_KEYWORD },
  { token: "string.css", foreground: WEBSTORM.STRING },
  { token: "comment.css", foreground: WEBSTORM.COMMENT },
  { token: "delimiter.css", foreground: "f1f1f1", fontStyle: "" },
  { token: "number.css", foreground: WEBSTORM.NUMBER },

  // HTML / XML (built-in grammars)
  { token: "tag.html", foreground: WEBSTORM.TAG },
  { token: "delimiter.html", foreground: WEBSTORM.TAG, fontStyle: "" },
  { token: "metatag.html", foreground: WEBSTORM.TAG },
  { token: "attribute.name.html", foreground: WEBSTORM.CSS_IDENT, fontStyle: "" },
  { token: "attribute.value.html", foreground: WEBSTORM.STRING, fontStyle: "" },
  { token: "comment.html", foreground: WEBSTORM.COMMENT, fontStyle: "" },
  { token: "tag.xml", foreground: WEBSTORM.TAG, fontStyle: "" },
  { token: "delimiter.xml", foreground: WEBSTORM.TAG, fontStyle: "" },
  { token: "metatag.xml", foreground: WEBSTORM.TAG, fontStyle: "" },
  { token: "attribute.name.xml", foreground: WEBSTORM.CSS_IDENT, fontStyle: "" },
  { token: "attribute.value.xml", foreground: WEBSTORM.STRING, fontStyle: "" },
  { token: "comment.xml", foreground: WEBSTORM.COMMENT, fontStyle: "" },
];

/** Primitive type names and literals the scheme colors apart from the other keywords (JS.PRIMITIVE / JS.NULL_UNDEFINED). */
const TS_PRIMITIVES = ["string", "number", "boolean", "bigint", "symbol", "object", "any", "unknown", "never", "void", "undefined", "null", "true", "false"];

const TS_KEYWORDS = [
  "abstract", "as", "asserts", "async", "await", "break", "case", "catch", "class", "const", "constructor", "continue",
  "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from",
  "function", "get", "global", "if", "implements", "import", "in", "infer", "instanceof", "interface", "is", "keyof", "let",
  "module", "namespace", "new", "of", "out", "override", "package", "private", "protected", "public", "readonly", "require",
  "return", "satisfies", "set", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "unique",
  "var", "while", "with", "yield",
];

const TS_OPERATORS = [
  "<=", ">=", "==", "!=", "===", "!==", "+", "-", "**", "*", "/", "%", "++", "--", "<<", "</", ">>", ">>>", "&", "|", "^",
  "!", "~", "&&", "||", "??", "?", ":", "=", "+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "^=",
];

/**
 * Monarch grammar for TypeScript and JavaScript, derived from Monaco's built-in one but tokenizing the roles
 * WebStorm colors differently: decorators, declared names, member access, calls, properties and parameters.
 * A parenthesis context (`parens` state) turns `name:` into a parameter; a brace context turns it into a property.
 */
export function typescriptLanguage(tokenPostfix: ".ts" | ".js"): monaco.languages.IMonarchLanguage {
  const identifierRule: monaco.languages.IMonarchLanguageRule = [
    /#?[a-z_$][\w$]*/,
    { cases: { "@primitives": "keyword.primitive", "@keywords": "keyword", "@default": "identifier" } },
  ];
  const callRule: monaco.languages.IMonarchLanguageRule = [
    /#?[a-z_$][\w$]*(?=\s*\()/,
    { cases: { "@primitives": "keyword.primitive", "@keywords": "keyword", "@default": "identifier.function" } },
  ];
  /**
   * `name:` / `name?:` with the colon attached; the token depends on the surrounding bracket context. A primitive
   * name in this position (`{ undefined: 1 }`, `string: boolean`) is a property or parameter, not the type.
   */
  const annotatedNameRule = (token: string): monaco.languages.IMonarchLanguageRule => [
    /#?[a-z_$][\w$]*(?=\??:(?!:))/,
    { cases: { "@primitives": token, "@keywords": "keyword", "@default": token } },
  ];
  const openParen: monaco.languages.IMonarchLanguageRule = [/\(/, { token: "delimiter.parenthesis", next: "@parens" }];
  const openBrace: monaco.languages.IMonarchLanguageRule = [/\{/, { token: "delimiter.bracket", next: "@braces" }];

  return {
    defaultToken: "",
    tokenPostfix,
    keywords: TS_KEYWORDS,
    primitives: TS_PRIMITIVES,
    operators: TS_OPERATORS,
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    digits: /\d+(_+\d+)*/,
    octaldigits: /[0-7]+(_+[0-7]+)*/,
    binarydigits: /[0-1]+(_+[0-1]+)*/,
    hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,
    regexpctl: /[(){}\[\]\$\^|\-*+?\.]/,
    regexpesc: /\\(?:[bBdDfnrstvwWn0\\\/]|@regexpctl|c[A-Z]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/,
    tokenizer: {
      root: [openBrace, [/\}/, "delimiter.bracket"], openParen, [/\)/, "delimiter.parenthesis"], annotatedNameRule("identifier.property"), { include: "common" }],
      braces: [[/\}/, { token: "delimiter.bracket", next: "@pop" }], openBrace, openParen, [/\)/, "delimiter.parenthesis"], annotatedNameRule("identifier.property"), { include: "common" }],
      parens: [[/\)/, { token: "delimiter.parenthesis", next: "@pop" }], openParen, openBrace, [/\}/, "delimiter.bracket"], annotatedNameRule("identifier.parameter"), { include: "common" }],
      common: [
        [/@[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*/, "annotation"],
        [/(interface)(\s+)([A-Za-z_$][\w$]*)/, ["keyword", "", "type.identifier.interface"]],
        [/(enum)(\s+)([A-Za-z_$][\w$]*)/, ["keyword", "", "type.identifier.enum"]],
        [/(type)(\s+)([A-Za-z_$][\w$]*)/, ["keyword", "", "type.identifier.alias"]],
        [/(class)(\s+)([A-Za-z_$][\w$]*)/, ["keyword", "", "type.identifier"]],
        [/(function)(\s*\*?\s*)([A-Za-z_$][\w$]*)/, ["keyword", "", "identifier.function"]],
        [/(const|let|var)(\s+)([A-Za-z_$][\w$]*)/, ["keyword", "", "variable"]],
        [/(\.)(\s*)(#?[a-zA-Z_$][\w$]*)(?=\s*\()/, ["delimiter.dot", "", "identifier.member.function"]],
        [/(\.)(\s*)(#?[a-zA-Z_$][\w$]*)/, ["delimiter.dot", "", "identifier.member"]],
        callRule,
        identifierRule,
        [/[A-Z][A-Z0-9_$]+(?![\w$])/, "variable"],
        [/[A-Z][\w\$]*/, "type.identifier"],
        { include: "@whitespace" },
        [/\/(?=([^\\\/]|\\.)+\/([dgimsuy]*)(\s*)(\.|;|,|\)|\]|\}|$))/, { token: "regexp", bracket: "@open", next: "@regexp" }],
        [/[\[\]]/, "delimiter.array"],
        [/[<>](?!@symbols)/, "delimiter.angle"],
        [/=>/, "operator.arrow"],
        [/!(?=([^=]|$))/, "operator"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
        [/(@digits)[eE]([\-+]?(@digits))?/, "number.float"],
        [/(@digits)\.(@digits)([eE][\-+]?(@digits))?/, "number.float"],
        [/0[xX](@hexdigits)n?/, "number.hex"],
        [/0[oO]?(@octaldigits)n?/, "number.octal"],
        [/0[bB](@binarydigits)n?/, "number.binary"],
        [/(@digits)n?/, "number"],
        [/[;,]/, "delimiter"],
        [/\./, "delimiter.dot"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string_double"],
        [/'/, "string", "@string_single"],
        [/`/, "string", "@string_backtick"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@jsdoc"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[\/*]/, "comment"],
      ],
      jsdoc: [
        [/@[a-zA-Z]+/, "comment.doc.tag"],
        [/`[^`\n]*`/, "comment.doc.markup"],
        [/[^\/*@`]+/, "comment.doc"],
        [/\*\//, "comment.doc", "@pop"],
        [/[\/*@`]/, "comment.doc"],
      ],
      regexp: [
        [/(\{)(\d+(?:,\d*)?)(\})/, ["regexp.escape.control", "regexp.escape.control", "regexp.escape.control"]],
        [/(\[)(\^?)(?=(?:[^\]\\\/]|\\.)+)/, ["regexp.escape.control", { token: "regexp.escape.control", next: "@regexrange" }]],
        [/(\()(\?:|\?=|\?!)/, ["regexp.escape.control", "regexp.escape.control"]],
        [/[()]/, "regexp.escape.control"],
        [/@regexpctl/, "regexp.escape.control"],
        [/[^\\\/]/, "regexp"],
        [/@regexpesc/, "regexp.escape"],
        [/\\\./, "regexp.invalid"],
        [/(\/)([dgimsuy]*)/, [{ token: "regexp", bracket: "@close", next: "@pop" }, "keyword.other"]],
      ],
      regexrange: [
        [/-/, "regexp.escape.control"],
        [/\^/, "regexp.invalid"],
        [/@regexpesc/, "regexp.escape"],
        [/[^\]]/, "regexp"],
        [/\]/, { token: "regexp.escape.control", next: "@pop", bracket: "@close" }],
      ],
      string_double: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],
      string_single: [
        [/[^\\']+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/'/, "string", "@pop"],
      ],
      string_backtick: [
        [/\$\{/, { token: "delimiter.bracket", next: "@interpolation" }],
        [/[^\\`$]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/\$/, "string"],
        [/`/, "string", "@pop"],
      ],
      interpolation: [[/\}/, { token: "delimiter.bracket", next: "@pop" }], openBrace, openParen, [/\)/, "delimiter.parenthesis"], { include: "common" }],
    },
  };
}
