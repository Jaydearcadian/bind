import path from "node:path";

/**
 * Root directory for generated (derived) artifacts such as workflow evidence
 * files and materialised workspace templates.
 *
 * PostgreSQL remains the canonical source of truth; these files are derived
 * output. On serverless platforms the deployment bundle is read-only, so we
 * redirect writes to a writable temp directory while keeping the local
 * checkout the default elsewhere.
 */
export function derivedArtifactsRoot(): string {
  if (process.env.BIND_ARTIFACTS_DIR) {
    return process.env.BIND_ARTIFACTS_DIR;
  }
  if (process.env.VERCEL) {
    return path.join("/tmp", "bind-artifacts");
  }
  return process.cwd();
}

export function workflowsArtifactsDir(): string {
  return process.env.WORKFLOW_ARTIFACTS_DIR ?? path.resolve(derivedArtifactsRoot(), "workflows");
}

export function templatesArtifactsDir(): string {
  return process.env.TEMPLATES_ARTIFACTS_DIR ?? path.resolve(derivedArtifactsRoot(), "templates");
}
