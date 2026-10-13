/** Text files imported with `?raw`: Vitest and the esbuild build (scripts/buildVmArtifact.ts) inline their content. */
declare module "*?raw" {
  const content: string;
  export default content;
}
