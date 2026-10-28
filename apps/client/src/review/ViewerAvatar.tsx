import { Avatar } from "../ui/Avatar";
import { useGithubViewer } from "./github-viewer.hook";

/** The `Avatar` of the viewer (see `useGithubViewer`); empty while it loads or when it cannot be looked up. */
export function ViewerAvatar({ sessionId, size }: { sessionId: string; size: string }) {
  const viewer = useGithubViewer(sessionId);
  return <Avatar login={viewer?.login ?? null} url={viewer?.avatarUrl} size={size} />;
}
