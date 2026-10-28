import { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";

/**
 * Why `name` cannot be the branch a new session creates, or `null` when it can: the name must be a valid `BranchName`
 * and must not name a branch the repository has already, locally or on a remote (`branches` lists both, remote ones as
 * `origin/<name>`). An empty name has no message; it is simply not a branch yet.
 */
export function newBranchProblem(name: string, branches: string[]): string | null {
  if (!name) return "";
  if (branches.includes(name)) return `Branch ${name} exists already`;
  if (branches.some((branch) => branch.endsWith(`/${name}`) && branch.indexOf("/") === branch.length - name.length - 1)) {
    return `Branch ${name} exists on a remote already`;
  }
  if (!BranchName.isValid(name)) return `"${name}" is not a valid branch name`;
  return null;
}
