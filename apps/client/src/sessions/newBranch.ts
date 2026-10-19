/** Characters git refuses anywhere in a branch name, besides control characters and whitespace. */
const FORBIDDEN_CHARACTERS = /[\s~^:?*[\\\u0000-\u001f\u007f]/;

/**
 * Why `name` cannot be the branch a new session creates, or `null` when it can: the name must pass git's
 * `check-ref-format --branch` rules and must not name a branch the repository has already, locally or on a remote
 * (`branches` lists both, remote ones as `origin/<name>`). An empty name has no message; it is simply not a branch yet.
 */
export function newBranchProblem(name: string, branches: string[]): string | null {
  if (!name) return "";
  if (branches.includes(name)) return `Branch ${name} exists already`;
  if (branches.some((branch) => branch.endsWith(`/${name}`) && branch.indexOf("/") === branch.length - name.length - 1)) {
    return `Branch ${name} exists on a remote already`;
  }
  if (!isValidBranchName(name)) return `"${name}" is not a valid branch name`;
  return null;
}

/** Whether git accepts `name` as a branch name (`git check-ref-format --branch`). */
export function isValidBranchName(name: string): boolean {
  if (name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (FORBIDDEN_CHARACTERS.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  return name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}
