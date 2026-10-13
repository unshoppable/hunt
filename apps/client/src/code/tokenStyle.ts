import type * as monaco from "monaco-editor";

/** Font style bits as Monaco encodes them in token metadata. */
export const FontStyle = { None: 0, Italic: 1, Bold: 2, Underline: 4, Strikethrough: 8 } as const;

/** Rule did not set a font style; the token inherits its parent's. */
const FONT_STYLE_NOT_SET = -1;

/** Resolved look of a token: `foreground` is a `#rrggbb` color, `fontStyle` a combination of `FontStyle` bits. */
export type TokenStyle = { foreground: string; fontStyle: number };

/** `style` attribute values for a token style; the object is also usable as React inline style. */
export type TokenStyleDeclarations = { color: string; fontStyle?: "italic"; fontWeight?: "bold"; textDecoration?: string };

type ParsedRule = { token: string; index: number; fontStyle: number; foreground: string | null };

const COLOR_PATTERN = /^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/;

/**
 * Node of the rule trie: every dot-separated segment of a token selector is one level, and each node starts
 * as a copy of its parent so a child rule only overrides what it sets, same as Monaco's `ThemeTrieElement`.
 */
class RuleNode {
  private readonly children = new Map<string, RuleNode>();

  constructor(private style: TokenStyle) {}

  match(token: string): TokenStyle {
    if (token === "") return this.style;
    const dotIndex = token.indexOf(".");
    const head = dotIndex === -1 ? token : token.slice(0, dotIndex);
    const tail = dotIndex === -1 ? "" : token.slice(dotIndex + 1);
    const child = this.children.get(head);
    return child ? child.match(tail) : this.style;
  }

  insert(token: string, fontStyle: number, foreground: string | null): void {
    if (token === "") {
      this.style = {
        foreground: foreground ?? this.style.foreground,
        fontStyle: fontStyle === FONT_STYLE_NOT_SET ? this.style.fontStyle : fontStyle,
      };
      return;
    }
    const dotIndex = token.indexOf(".");
    const head = dotIndex === -1 ? token : token.slice(0, dotIndex);
    const tail = dotIndex === -1 ? "" : token.slice(dotIndex + 1);
    let child = this.children.get(head);
    if (!child) {
      child = new RuleNode(this.style);
      this.children.set(head, child);
    }
    child.insert(tail, fontStyle, foreground);
  }
}

function parseFontStyle(fontStyle: string | undefined): number {
  if (typeof fontStyle !== "string") return FONT_STYLE_NOT_SET;
  let result: number = FontStyle.None;
  for (const segment of fontStyle.split(" ")) {
    switch (segment) {
      case "italic":
        result |= FontStyle.Italic;
        break;
      case "bold":
        result |= FontStyle.Bold;
        break;
      case "underline":
        result |= FontStyle.Underline;
        break;
      case "strikethrough":
        result |= FontStyle.Strikethrough;
        break;
    }
  }
  return result;
}

function parseColor(color: string | undefined): string | null {
  if (typeof color !== "string") return null;
  const match = color.match(COLOR_PATTERN);
  if (!match) throw new Error(`Illegal value for token color: ${color}`);
  return `#${match[1].toLowerCase()}`;
}

/**
 * Builds a lookup from Monaco token names (`keyword.ts`, `member.static`, `string.key.json`) to their style under
 * `rules`, resolving the rules the way Monaco's `TokenTheme` does: rules for the empty token set the defaults,
 * a token is matched segment by segment and falls back to the longest matching prefix, and later rules win.
 * Styles are shared objects, so equal styles are also identical by reference.
 */
export function createTokenStyleResolver(rules: monaco.editor.ITokenThemeRule[]): (token: string) => TokenStyle {
  const parsed: ParsedRule[] = rules.map((rule, index) => ({
    token: rule.token ?? "",
    index,
    fontStyle: parseFontStyle(rule.fontStyle),
    foreground: parseColor(rule.foreground),
  }));
  parsed.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : a.index - b.index));

  const root = new RuleNode({ foreground: "#000000", fontStyle: FontStyle.None });
  for (const rule of parsed) {
    root.insert(rule.token, rule.fontStyle, rule.foreground);
  }

  const cache = new Map<string, TokenStyle>();
  const byKey = new Map<string, TokenStyle>();
  return (token) => {
    let style = cache.get(token);
    if (style) return style;
    const matched = root.match(token);
    const key = `${matched.foreground}/${matched.fontStyle}`;
    style = byKey.get(key);
    if (!style) {
      style = matched;
      byKey.set(key, style);
    }
    cache.set(token, style);
    return style;
  };
}

const declarationsCache = new WeakMap<TokenStyle, TokenStyleDeclarations>();

/** CSS declarations of a token style, cached per style object. */
export function tokenStyleDeclarations(style: TokenStyle): TokenStyleDeclarations {
  let declarations = declarationsCache.get(style);
  if (declarations) return declarations;
  declarations = { color: style.foreground };
  if (style.fontStyle & FontStyle.Italic) {
    declarations.fontStyle = "italic";
  }
  if (style.fontStyle & FontStyle.Bold) {
    declarations.fontWeight = "bold";
  }
  const decorations = [style.fontStyle & FontStyle.Underline ? "underline" : "", style.fontStyle & FontStyle.Strikethrough ? "line-through" : ""].filter(Boolean);
  if (decorations.length) {
    declarations.textDecoration = decorations.join(" ");
  }
  declarationsCache.set(style, declarations);
  return declarations;
}

/** The declarations as a `style` attribute string (`color:#fbc966;font-style:italic`). */
export function tokenStyleAttribute(style: TokenStyle): string {
  const declarations = tokenStyleDeclarations(style);
  const parts = [`color:${declarations.color}`];
  if (declarations.fontStyle) {
    parts.push(`font-style:${declarations.fontStyle}`);
  }
  if (declarations.fontWeight) {
    parts.push(`font-weight:${declarations.fontWeight}`);
  }
  if (declarations.textDecoration) {
    parts.push(`text-decoration:${declarations.textDecoration}`);
  }
  return parts.join(";");
}
