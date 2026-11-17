import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DuckDB ships a native binary: load it with Node's require instead of bundling it.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  // The binding loads libduckdb.so from its platform package at runtime. File tracing
  // follows the .node file but not the shared library beside it, so include the package
  // for every route: the page imports the tool catalogue, which imports the engine.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@duckdb/node-bindings-linux-x64/**/*"],
  },
};

export default nextConfig;
