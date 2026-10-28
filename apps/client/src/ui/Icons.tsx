/** Small stroke icons for buttons; they inherit the text color and size via `className`. */

import { useId } from "react";

export function CloseIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** The arrow of the send button. */
export function SendIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}

/** Paper plane of the push button. */
export function PaperPlaneIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 1.5L1.5 6.3l5.3 2.4 2.4 5.8z" />
      <path d="M14.5 1.5L6.8 8.7" />
    </svg>
  );
}

export function SearchIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

/** The agent sparkle (see `--sparkle-mask` in index.css) filled with the text color, for buttons on an accent surface. */
export function SparkleIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 1.5c.4 2.9 2.6 5.1 5.5 5.5-2.9.4-5.1 2.6-5.5 5.5-.4-2.9-2.6-5.1-5.5-5.5 2.9-.4 5.1-2.6 5.5-5.5Z" />
      <path d="M12.5 10.5c.2 1.1 1 1.9 2 2-1 .2-1.8 1-2 2-.2-1-1-1.8-2-2 1-.2 1.8-1 2-2Z" />
    </svg>
  );
}

export function PlusIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/**
 * Rotating ring for in-progress states: a faint track and a quarter arc in the text color. Drawn as SVG so the
 * stroke stays uniform and the rotation centre exact at any size; a bordered box of fractional width snaps its
 * sides to different pixels and wobbles while it spins.
 */
export function Spinner({ className = "size-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`animate-spin ${className}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" className="opacity-25" />
      <circle cx="8" cy="8" r="6.5" strokeDasharray="10.2 30.6" transform="rotate(-90 8 8)" />
    </svg>
  );
}

/** Disclosure chevron: points right when collapsed and down when expanded. */
export function ChevronIcon({ expanded, className = "size-3.5" }: { expanded: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${className} transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** A downward chevron, for buttons that open a dropdown. */
export function ChevronDownIcon({ className = "size-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

/** Arrow out of a box, for actions that open something in another app. */
export function ExternalIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

/** A window lifted off another one, for moving a popup into a window of its own. */
export function DetachIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M5.5 2.5h7a1 1 0 0 1 1 1v7" />
    </svg>
  );
}

/** An arrow into a window, for putting a popup back into its app window. */
export function AttachIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M11 5 6.5 9.5M6.5 6v3.5H10" />
    </svg>
  );
}

/** A tick, for things that passed or were approved. */
export function CheckIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

/** A speech bubble, for comment counts. */
export function CommentIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5A1 1 0 0 1 3.5 2.5h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3h-.5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** Two overlapping sheets, for copy actions. */
export function CopyIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="5.5" y="5.5" width="7" height="8" rx="1.2" />
      <path d="M10.5 5.5V3.7A1.2 1.2 0 0 0 9.3 2.5H4.7a1.2 1.2 0 0 0-1.2 1.2v6.1a1.2 1.2 0 0 0 1.2 1.2h.8" />
    </svg>
  );
}

/** An eye, for toggling a preview. */
export function EyeIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** A framed picture, for image attachments. */
export function ImageIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <circle cx="5.75" cy="6.25" r="1.1" />
      <path d="M14 10.5 10.7 7.4a1 1 0 0 0-1.4.03L4.5 12.5" />
    </svg>
  );
}

/** A globe, for the Chrome of a local session. */
export function GlobeIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5" />
      <path d="M8 1.75c1.7 1.8 2.5 3.85 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.4 5.5 8S6.3 3.55 8 1.75Z" />
    </svg>
  );
}

/** A page with a plus over a minus, for diffs. */
export function DiffIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.25 2.75a1 1 0 0 1 1-1h4.9l3.6 3.6v7.9a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10.5Z" />
      <path d="M8 5.5v3.5M6.25 7.25h3.5M6.25 11h3.5" />
    </svg>
  );
}

/** Three boxes joined by lines, for diagrams. */
export function DiagramIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="1.75" width="5" height="3.5" rx="0.75" />
      <rect x="1.75" y="10.75" width="5" height="3.5" rx="0.75" />
      <rect x="9.25" y="10.75" width="5" height="3.5" rx="0.75" />
      <path d="M8 5.25V8M4.25 10.75V8h7.5v2.75" />
    </svg>
  );
}

/** A monitor on a stand, for a remote desktop. */
export function MonitorIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.25" />
      <path d="M8 11v2.75M5.5 13.75h5" />
    </svg>
  );
}

/** A prompt in a window, for terminals. */
export function TerminalIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5" />
      <path d="m4.75 6 2 2-2 2M8.5 10.5h2.75" />
    </svg>
  );
}

/** A pencil, for edited things. */
export function PencilIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.75 2.5a1.4 1.4 0 0 1 2 0l.75.75a1.4 1.4 0 0 1 0 2L5.75 13 2.5 13.5 3 10.25Z" />
      <path d="m9.5 3.75 2.75 2.75" />
    </svg>
  );
}

/** An archive box, for shelved changes. */
export function ArchiveIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="3.5" rx="1" />
      <path d="M2.75 6.25v6a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-6M6.5 9h3" />
    </svg>
  );
}

/** A shield, for the repository's guardrails (rules, skills, ADRs). */
export function ShieldIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.75 2.75 3.9v4.1c0 3 2.2 5.2 5.25 6.25C11.05 13.2 13.25 11 13.25 8V3.9L8 1.75Z" />
      <path d="m5.75 8 1.6 1.6L10.5 6.4" />
    </svg>
  );
}

/** A floppy disk, for saving something for later. */
export function SaveIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.75 3.75a1 1 0 0 1 1-1h7.1l2.4 2.4v7.1a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-8.5Z" />
      <path d="M5.25 2.75v3h5v-3M5.25 13.25v-4h5.5v4" />
    </svg>
  );
}

/** A circled "i", for help buttons. */
export function InfoIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v3.75M8 5.1v.1" />
    </svg>
  );
}

/** A circled exclamation mark, for failures. */
export function AlertIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8.5M8 10.9v.1" />
    </svg>
  );
}
/** Trash can, for delete buttons. */
export function TrashIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4 4.5l.7 8.3a1 1 0 0 0 1 .95h4.6a1 1 0 0 0 1-.95l.7-8.3M6.6 7.2v3.8M9.4 7.2v3.8" />
    </svg>
  );
}

export function EraserIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5 2.75 9.25a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0L13.5 6.5a1 1 0 0 0 0-1.4l-2.6-2.6a1 1 0 0 0-1.4 0ZM6 6l4 4M8.5 13.5h5" />
    </svg>
  );
}

/** A tag on a string, for tag names. */
export function TagIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

/** A git branch forking off a line, for branch names. */
export function BranchIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10a6 6 0 0 1-6 6H6" />
    </svg>
  );
}

/** A cloud, for sessions that run on a remote VM. */
/** Arrow up out of a tray: a push to the remote. */
export function PushIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** Arrow down into a tray: a fetch from the remote. */
export function FetchIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

export function CloudIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

/** A cloud with a circular arrow, for looking up the remote sessions on the session VMs again. */
export function CloudSyncIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 19H7a5 5 0 1 1 1.6-9.74A6 6 0 0 1 20 11.5a4 4 0 0 1-1 7.37" />
      <path d="M16.5 15.5a3.5 3.5 0 1 0-1 2.45" />
      <path d="M16.5 12.5v3h-3" />
    </svg>
  );
}

/** Two branches with a merge arrow, the common symbol for a pull request. */
export function PullRequestIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M6 7v10M18 17v-7a3 3 0 0 0-3-3h-3M14.5 4.5 12 7l2.5 2.5" />
    </svg>
  );
}

/** A ticket stub with a perforation, for the issue a session works on. */
export function TicketIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6Z" />
      <path d="M14 5v2M14 11v2M14 17v2" />
    </svg>
  );
}

/** A bound book, the common symbol for a repository. */
export function RepoIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20M10 2v8l3-3 3 3V2" />
    </svg>
  );
}

/** The GitHub mark, for actions that reach the repository's GitHub remote. */
export function GitHubIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** An "H", for the heading action of a markdown toolbar. */
export function HeadingIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3.5 3v10M12.5 3v10M3.5 8h9" />
    </svg>
  );
}

/** A heavy "B", for the bold action of a markdown toolbar. */
export function BoldIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 3h4.25a2.5 2.5 0 0 1 0 5H4.5zM4.5 8h5a2.5 2.5 0 0 1 0 5h-5z" />
    </svg>
  );
}

/** A slanted "I", for the italic action of a markdown toolbar. */
export function ItalicIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 3h5M4.5 13h5M9.5 3l-3 10" />
    </svg>
  );
}

/** A quotation mark, for the quote action of a markdown toolbar. */
export function QuoteIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5h11M5.5 8h8M5.5 11.5h8M2.5 7.5v4.5" />
    </svg>
  );
}

/** Angle brackets, for code: the code action of a markdown toolbar and the Editor tab. */
export function CodeIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 4.5-3.5 3.5L5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.5 3l-3 10" />
    </svg>
  );
}

/** Two chain links, for the link action of a markdown toolbar. */
export function LinkIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 9.5a3 3 0 0 0 4.25 0l1.75-1.75a3 3 0 0 0-4.25-4.25l-.9.9" />
      <path d="M9.5 6.5a3 3 0 0 0-4.25 0L3.5 8.25a3 3 0 0 0 4.25 4.25l.9-.9" />
    </svg>
  );
}

/** Three dotted lines, for the bullet list action of a markdown toolbar. */
export function BulletListIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.75 4h.1M2.75 8h.1M2.75 12h.1" />
    </svg>
  );
}

/** Three numbered lines, for the numbered list action of a markdown toolbar. */
export function NumberedListIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7M2 3l1.25-.75V6M2 9.5a1.1 1.1 0 0 1 2.1.5c0 1-2.1 2-2.1 2h2.2" />
    </svg>
  );
}

/** Lines with checkboxes, for checklists: the task list action of a markdown toolbar and the Checks tab. */
export function TaskListIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.25" width="4.5" height="4.5" rx="1" />
      <path d="m3 4.5 1 1 1.75-2M9 4.5h5M9 11.5h5" />
      <rect x="1.75" y="9.25" width="4.5" height="4.5" rx="1" />
    </svg>
  );
}

/** An "@", for the mention action of a markdown toolbar. */
export function MentionIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v1a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.6 4.95" />
    </svg>
  );
}

/**
 * WebStorm's product logo: a gradient tile with the black "WS" square, drawn in its own colors. Each instance owns its
 * gradient id, because a shared id resolves to the first instance, which paints nothing while it sits in a hidden pane.
 */
export function WebstormIcon({ className = "size-4" }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="16" x2="16" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#07C3F2" />
          <stop offset="0.55" stopColor="#087CFA" />
          <stop offset="1" stopColor="#FCF84A" />
        </linearGradient>
      </defs>
      <rect width="16" height="16" rx="3.5" fill={`url(#${gradientId})`} />
      <rect x="3" y="3" width="10" height="10" rx="0.5" fill="#000" />
      <text x="4" y="8.6" fill="#fff" fontFamily="system-ui, sans-serif" fontSize="4.6" fontWeight="700">WS</text>
      <rect x="4" y="10.6" width="3.8" height="0.9" fill="#fff" />
    </svg>
  );
}

/** Folder outline, 16px: marks a repository. */
export function FolderIcon({ className = "size-4 shrink-0" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
