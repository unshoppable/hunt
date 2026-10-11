/**
 * What a dependency is for, as far as names can tell: the role a file name or an imported identifier implies, and
 * the check that an edge label names a purpose rather than a symbol or a file.
 */
import { baseName } from "../ui/path";

/**
 * Role by a word of a file stem, a parent directory or an identifier: `user.service.ts` and `UserService` are
 * business logic, `src/ipc/types.ts` is types only. The last word wins over earlier ones.
 */
const ROLE_BY_WORD: Record<string, string> = {
  service: "business logic", services: "business logic", usecase: "business logic", usecases: "business logic",
  controller: "HTTP endpoints", controllers: "HTTP endpoints", route: "HTTP endpoints", routes: "HTTP endpoints", router: "HTTP endpoints",
  resolver: "GraphQL resolver", resolvers: "GraphQL resolver",
  module: "module wiring", modules: "module wiring",
  repository: "data access", repositories: "data access", repo: "data access", dao: "data access",
  entity: "data model", entities: "data model", model: "data model", models: "data model",
  dto: "data contract", dtos: "data contract", request: "data contract", response: "data contract",
  result: "response shape", results: "response shape", paginated: "pagination", pagination: "pagination",
  query: "query shape", queries: "query shape",
  guard: "request handling", guards: "request handling", interceptor: "request handling", interceptors: "request handling", middleware: "request handling",
  pipe: "validation", pipes: "validation", validator: "validation", validators: "validation", validation: "validation",
  config: "configuration", configuration: "configuration", settings: "configuration",
  seeder: "seed data", seeders: "seed data", seed: "seed data", seeds: "seed data", fixture: "seed data", fixtures: "seed data",
  migration: "schema migration", migrations: "schema migration",
  component: "UI component", components: "UI component", view: "UI component", views: "UI component", page: "UI component", pages: "UI component", screen: "UI component", screens: "UI component",
  store: "state", state: "state", reducer: "state", reducers: "state", slice: "state", slices: "state",
  hook: "hook", hooks: "hook",
  util: "helpers", utils: "helpers", helper: "helpers", helpers: "helpers",
  types: "types only", type: "types only", typings: "types only", interface: "types only", interfaces: "types only",
  constants: "constants", const: "constants", enum: "constants", enums: "constants",
  client: "API client", api: "API client", gateway: "API client",
  event: "events", events: "events", listener: "events", listeners: "events",
  schema: "schema", schemas: "schema",
  ipc: "IPC calls", command: "commands", commands: "commands",
  error: "error handling", errors: "error handling", exception: "error handling", exceptions: "error handling",
  decorator: "decorators", decorators: "decorators",
  mapper: "data mapping", mappers: "data mapping", factory: "object creation", factories: "object creation",
  provider: "providers", providers: "providers", adapter: "adapter", adapters: "adapter",
  logger: "logging", logging: "logging", log: "logging",
  auth: "authentication", authentication: "authentication",
  mock: "test doubles", mocks: "test doubles", stub: "test doubles", stubs: "test doubles",
  style: "styles", styles: "styles", theme: "styles",
  context: "shared context", worker: "background work", parser: "parsing", formatter: "formatting", filter: "filtering", filters: "filtering",
};

/** Role of a file that is not code, by extension. */
const ROLE_BY_EXTENSION: Record<string, string> = {
  css: "styles", scss: "styles", sass: "styles", less: "styles",
  json: "static data", yaml: "static data", yml: "static data",
  svg: "image asset", png: "image asset", jpg: "image asset", jpeg: "image asset", gif: "image asset", webp: "image asset",
};

/** The role words without a space, so a label equal to one of them counts as a purpose and not as a file name. */
const SINGLE_WORD_ROLES = new Set(Object.values(ROLE_BY_WORD).filter((role) => !role.includes(" ")));

/** The lower-case words of an identifier or file stem: `PaginatedResult` → `paginated result`, `user-list.query` → `user list query`. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s._$-]+/)
    .filter(Boolean);
}

/** The role `ROLE_BY_WORD` assigns to `path`, by extension, the words of its file stem (last first) or its parent directory. */
export function roleOfFile(path: string): string | null {
  const segments = path.split("/");
  const file = segments.pop() ?? path;
  const extension = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
  if (ROLE_BY_EXTENSION[extension]) return ROLE_BY_EXTENSION[extension];
  const stem = file.replace(/\.[^.]+$/, "");
  if (/^use[A-Z]/.test(stem)) return "hook";
  for (const word of wordsOf(stem).reverse()) {
    if (ROLE_BY_WORD[word]) return ROLE_BY_WORD[word];
  }
  const directory = segments.pop()?.toLowerCase();
  return directory && ROLE_BY_WORD[directory] ? ROLE_BY_WORD[directory] : null;
}

/**
 * The role the imported `names` imply when the target's file name says nothing: a hook, a role word inside a name
 * (`NotFoundException` → error handling), constants, classes or components, functions. Without names the import is
 * loaded for its side effects.
 */
export function roleOfNames(names: string[], target: string): string {
  if (!names.length) return "side effects";
  const isConstant = (name: string) => /^[A-Z][A-Z0-9_]+$/.test(name);
  if (names.every(isConstant)) return "constants";
  for (const name of names) {
    if (/^use[A-Z]/.test(name)) return "hook";
    if (isConstant(name)) continue;
    for (const word of wordsOf(name).reverse()) {
      if (ROLE_BY_WORD[word]) return ROLE_BY_WORD[word];
    }
  }
  if (names.every((name) => /^[A-Z]/.test(name))) return /\.[jt]sx$/.test(target) ? "UI component" : "classes & types";
  if (names.every((name) => /^[a-z]/.test(name))) return "function calls";
  return "shared code";
}

/**
 * True when `label` is an identifier or a file name instead of a purpose: camelCase or PascalCase of several words,
 * UPPER_SNAKE, a dotted name such as `user.service.ts`, or the stem or name of one of `paths`. A role word such as `hook` passes.
 */
export function isSymbolLikeLabel(label: string, ...paths: string[]): boolean {
  const trimmed = label.trim();
  if (!trimmed || /\s/.test(trimmed) || SINGLE_WORD_ROLES.has(trimmed.toLowerCase())) return false;
  if (/^[a-z$_][\w$]*[A-Z]/.test(trimmed)) return true;
  if (/^[A-Z][a-z0-9]+[A-Z][a-z]/.test(trimmed)) return true;
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(trimmed)) return true;
  if (/^[a-z][\w$-]*(\.[a-z][\w$-]*)+$/i.test(trimmed)) return true;
  const normalized = normalize(trimmed);
  return paths.some((path) => {
    const file = baseName(path);
    const stem = file.replace(/\.[^.]+$/, "");
    return normalize(file) === normalized || normalize(stem) === normalized;
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}
