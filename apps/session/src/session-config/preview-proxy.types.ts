/** The part of Caddy's JSON configuration that the session VM's preview proxy (`preview-proxy.utils.ts`) uses. */

export interface CaddyRoute {
  match?: Record<string, unknown>[];
  handle: Record<string, unknown>[];
  terminal?: boolean;
}

export interface CaddyLog {
  level?: string;
  writer?: { output: "file"; filename: string; roll_size_mb: number; roll_keep: number };
  /** `level_format: "upper"` keeps the console format free of color codes. */
  encoder?: { format: string; level_format?: string };
  include?: string[];
  exclude?: string[];
}

export interface CaddyConfig {
  admin: { listen: string; config: { persist: boolean } };
  logging: { logs: { default: CaddyLog; access: CaddyLog } };
  apps: {
    http: {
      servers: {
        preview: {
          listen: string[];
          protocols: string[];
          automatic_https: { disable: boolean };
          trusted_proxies: { source: "static"; ranges: string[] };
          logs: { default_logger_name: string };
          routes: CaddyRoute[];
          /** What answers a request that `routes` failed to deliver. */
          errors: { routes: CaddyRoute[] };
        };
        desktop: {
          listen: string[];
          protocols: string[];
          automatic_https: { disable: boolean };
          routes: CaddyRoute[];
        };
      };
    };
  };
}
