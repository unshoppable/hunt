/**
 * The Caddy configuration of the session VM's preview proxy (hunt-proxy.service), which serves the port and open hosts
 * of a session (`session-host.value-object.ts`) and forwards the desktop client to the desktop.
 */
import { RESERVED_PORTS } from "./hunt-json.rules.ts";
import type { CaddyConfig, CaddyRoute } from "./preview-proxy.types.ts";
import type { ServiceConfig } from "./service-config.value-object.ts";
import type { SessionHost } from "./session-host.value-object.ts";

/** Where the preview proxy listens; the gateway forwards every preview request there with its original Host header. */
const PROXY_LISTEN = ":8080";
/** The gateway's health check, answered on every host. */
const HEALTH_PATH = "/hunt-healthz";
/** Caddy's admin API, in the runtime folder of hunt-proxy.service. */
const PROXY_ADMIN = "unix//run/hunt-proxy/admin.sock";
/** The access log of every preview request, in the logs folder of hunt-proxy.service; `hunt-idle-check` reads it. */
const ACCESS_LOG = "/var/log/hunt-proxy/access.log";
/** Caddy names the access logger of a server `http.log.access.<default_logger_name>`. */
const ACCESS_LOGGER = "preview";
/** The review server of `hunt-review.service` (`../review/review-server.main.ts`), which adds the review widget to the guarded pages. */
const REVIEW_SERVER = "127.0.0.1:9232";
/** The paths of the review server on every guarded port host: the widget's script and where it posts annotations. */
const REVIEW_PATHS = "/__hunt/*";
/** The headers that tell the review server the dev server behind a page; hunt-proxy sets them, a browser's are overwritten. */
const UPSTREAM_PORT_HEADER = "X-Hunt-Upstream-Port";
const UPSTREAM_TLS_HEADER = "X-Hunt-Upstream-Tls";
/** A browser loading a page, which the review server answers. */
const PAGE_LOAD = { method: ["GET"], header: { Accept: ["*text/html*"] } };
/** How the review server marks the 502 of a dev server that refused the connection. */
const UNREACHABLE_MARK = { "X-Hunt-Upstream": ["unreachable"] };
/** Where the desktop proxy listens; the desktop client reaches it through an SSH port forward. */
const DESKTOP_LISTEN = "127.0.0.1:9231";
/** The Waymote gateway of `hunt-desktop.service`, which streams the desktop. */
const WAYMOTE_GATEWAY = "127.0.0.1:9230";
/** The origins of the desktop client's pages: the bundled app and the Vite dev server of `tauri dev`. */
const DESKTOP_ORIGINS = ["tauri://localhost", "http://localhost:1420"];
/** The private ranges of a VPC's internal addresses: the gateway connects from one, so its X-Forwarded-* headers pass on. */
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const IAP_HEADERS = ["X-Goog-Iap-Jwt-Assertion", "X-Goog-Authenticated-User-Email", "X-Goog-Authenticated-User-Id"];
const IAP_COOKIE = "(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*";
/** A port from 1024 to 65535, without leading zeros, as capture group 1. */
const PORT_PATTERN = "(102[4-9]|10[3-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const NOT_OPEN_BODY = 'This port has no public host: only a service with "guarded": false in the repository\'s hunt.json has one.\n';
/** Caddy's error status when the upstream of a reverse_proxy refuses the connection, because nothing listens on its port. */
const UNREACHABLE = "{http.error.status_code} == 502";
/** What an open host answers when its service does not run; the gateway's edge answers the same while the VM is off. */
const NOT_RUNNING_BODY = "The preview is not running.\n";

/**
 * The Caddy configuration of the session VM's preview proxy. It listens on PROXY_LISTEN in plain HTTP behind the
 * gateway and sends `<short>-<port>.<domain>` to that port and `<short>-<port>-open.<domain>` of a service that is not
 * guarded to the service's port, both on localhost, which reaches servers bound to 127.0.0.1 as well as ::1. The ports of
 * services with `tls` are reached over HTTPS without checking the certificate. Every upstream gets the request's own
 * Host header, which Caddy would replace with the upstream's address for HTTPS, but never IAP's headers and cookies;
 * responses are flushed at once (server-sent events). HEALTH_PATH answers 200 on every host, the reserved ports answer
 * 403, and `<short>.<domain>` and every other `-open` host answer 404 with an explanation. When nothing listens on the
 * port, a port host answers 503 with an explanation that names the service of that port, an open host 503 with
 * NOT_RUNNING_BODY, which tells a stranger nothing about the services. Every request except the health check goes to
 * ACCESS_LOG as one JSON line; Caddy writes Cookie and Authorization headers there redacted. Caddy's own warnings and
 * errors, such as an upstream that refuses the connection, go to stderr, hunt-proxy's journal, as one readable line each.
 *
 * On the port hosts, never the open hosts, the review server on REVIEW_SERVER answers REVIEW_PATHS and the page loads
 * (GET with `text/html` in Accept), except those of the services with `"review": false`: it adds the review widget to
 * the HTML it fetches from the port in UPSTREAM_PORT_HEADER, over HTTPS when UPSTREAM_TLS_HEADER is `true`, with the
 * same Host header and without IAP's headers and cookies. Its 502 for a port nothing listens on (UNREACHABLE_MARK)
 * becomes an error of the proxy, which then answers with the same 503 as for a request it proxied itself.
 *
 * A second server on DESKTOP_LISTEN passes the desktop client's requests on to the Waymote gateway and answers every
 * other one 403. The gateway accepts a WebSocket only from its own origin, which the desktop client's pages cannot have,
 * so the proxy lets DESKTOP_ORIGINS through as that origin; a web page that reaches the forwarded port stays refused.
 */
export function proxyConfig(services: readonly ServiceConfig[], host: SessionHost): CaddyConfig {
  const hostMatch = (name: string, pattern: string) => ({
    vars_regexp: { "{http.request.host}": { name, pattern: `^${host.short}-${pattern}\\.${host.domain.replaceAll(".", "\\.")}$` } },
  });
  const route = (match: Record<string, unknown>, handler: Record<string, unknown>): CaddyRoute => ({ match: [match], handle: [handler], terminal: true });
  const notFound = (body: string) => ({ handler: "static_response", status_code: 404, body });
  const notRunning = (match: Record<string, unknown>, body: string) =>
    route({ ...match, expression: UNREACHABLE }, { handler: "static_response", status_code: 503, body });
  const mainHostBody = `This session has no main page: each service of the repository's hunt.json answers at https://${host.portHost("<port>")}.\n`;
  return {
    admin: { listen: PROXY_ADMIN, config: { persist: false } },
    logging: {
      logs: {
        default: { level: "WARN", encoder: { format: "console", level_format: "upper" }, exclude: [`http.log.access.${ACCESS_LOGGER}`] },
        access: {
          writer: { output: "file", filename: ACCESS_LOG, roll_size_mb: 20, roll_keep: 2 },
          encoder: { format: "json" },
          include: [`http.log.access.${ACCESS_LOGGER}`],
        },
      },
    },
    apps: {
      http: {
        servers: {
          preview: {
            listen: [PROXY_LISTEN],
            protocols: ["h1"],
            automatic_https: { disable: true },
            trusted_proxies: { source: "static", ranges: PRIVATE_RANGES },
            logs: { default_logger_name: ACCESS_LOGGER },
            routes: [
              {
                match: [{ path: [HEALTH_PATH] }],
                handle: [{ handler: "vars", log_skip: true }, { handler: "static_response", status_code: 200, body: "ok" }],
                terminal: true,
              },
              route(
                { host: [...RESERVED_PORTS.keys()].map((port) => host.portHost(port)) },
                { handler: "static_response", status_code: 403, body: "This port is not served.\n" },
              ),
              route({ host: [host.mainHost] }, notFound(mainHostBody)),
              ...services
                .filter((service) => !service.guarded)
                .map((service) => route({ host: [host.openHost(service.port)] }, proxy(`localhost:${service.port}`, service.tls))),
              route(hostMatch("open", "[0-9]+-open"), notFound(NOT_OPEN_BODY)),
              ...services
                .filter((service) => !service.review)
                .map((service) => route({ host: [host.portHost(service.port)] }, proxy(`localhost:${service.port}`, service.tls))),
              route({ ...hostMatch("port", PORT_PATTERN), path: [REVIEW_PATHS] }, proxy(REVIEW_SERVER, false)),
              ...services
                .filter((service) => service.review && service.tls)
                .map((service) => route({ host: [host.portHost(service.port)], ...PAGE_LOAD }, reviewProxy(String(service.port), true))),
              route({ ...hostMatch("port", PORT_PATTERN), ...PAGE_LOAD }, reviewProxy("{http.regexp.port.1}", false)),
              ...services
                .filter((service) => service.review && service.tls)
                .map((service) => route({ host: [host.portHost(service.port)] }, proxy(`localhost:${service.port}`, true))),
              route(hostMatch("port", PORT_PATTERN), proxy("localhost:{http.regexp.port.1}", false)),
              { handle: [{ handler: "static_response", status_code: 404 }] },
            ],
            errors: {
              routes: [
                notRunning(hostMatch("open", "[0-9]+-open"), NOT_RUNNING_BODY),
                ...services.map((service) =>
                  notRunning(
                    { host: [host.portHost(service.port)] },
                    `The service ${service.name} is not running, so nothing answers on port ${service.port}. ` +
                      "Ask the agent to start it, then reload this page.\n",
                  ),
                ),
                notRunning(hostMatch("port", PORT_PATTERN), "Nothing answers on port {http.regexp.port.1} of the session VM.\n"),
              ],
            },
          },
          desktop: {
            listen: [DESKTOP_LISTEN],
            protocols: ["h1"],
            automatic_https: { disable: true },
            routes: [
              route(
                { expression: `{http.request.header.Origin} in [${DESKTOP_ORIGINS.map((origin) => `'${origin}'`).join(", ")}]` },
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: WAYMOTE_GATEWAY }],
                  flush_interval: -1,
                  headers: { request: { set: { Host: [WAYMOTE_GATEWAY], Origin: [`http://${WAYMOTE_GATEWAY}`] } } },
                },
              ),
              { handle: [{ handler: "static_response", status_code: 403 }] },
            ],
          },
        },
      },
    },
  };
}

/** Passes the request on to `dial` with its own Host header and without IAP's headers and cookies; `headers` are set on top. */
function proxy(dial: string, tls: boolean, headers: Record<string, string[]> = {}): Record<string, unknown> {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial }],
    flush_interval: -1,
    headers: {
      request: {
        set: { Host: ["{http.request.hostport}"], ...headers },
        delete: IAP_HEADERS,
        replace: { Cookie: [{ search_regexp: IAP_COOKIE, replace: "" }] },
      },
    },
    ...(tls ? { transport: { protocol: "http", tls: { insecure_skip_verify: true } } } : {}),
  };
}

/** Passes a page load on to the review server for the dev server on `port`; a port nothing listens on becomes an error. */
function reviewProxy(port: string, tls: boolean): Record<string, unknown> {
  return {
    ...proxy(REVIEW_SERVER, false, { [UPSTREAM_PORT_HEADER]: [port], [UPSTREAM_TLS_HEADER]: [String(tls)] }),
    handle_response: [{ match: { status_code: [502], headers: UNREACHABLE_MARK }, routes: [{ handle: [{ handler: "error", status_code: 502 }] }] }],
  };
}
