/**
 * The identifier roles WebStorm's JS/TS highlighting distinguishes, named after the scheme attributes they are colored
 * with (`JS.CLASS`, `JS.INSTANCE_MEMBER_FUNCTION`, …). The index in this array is the role id the worker encodes
 * (see webstorm-classifier.utils.ts) and the semantic token type index of the Monaco legend (see semantic-tokens.monaco.ts).
 */
export const WEBSTORM_ROLES = [
  "class",
  "interface",
  "enum",
  "typeAlias",
  "typeParameter",
  "enumMember",
  "globalFunction",
  "localFunction",
  "instanceMethod",
  "staticMethod",
  "instanceField",
  "staticField",
  "globalVariable",
  "localVariable",
  "parameter",
  "moduleName",
  "label",
  "metadata",
] as const;

export type WebstormRole = (typeof WEBSTORM_ROLES)[number];
