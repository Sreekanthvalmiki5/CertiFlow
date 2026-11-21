const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_DISTRICT: 'With district',
  PENDING_QUALITY: 'With quality team',
  PENDING_STATE: 'With state office',
  RETURNED: 'Sent back',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
  VALID: 'Valid',
  REVOKED: 'Cancelled',
  SENT: 'Delivered',
  PENDING: 'Pending',
  FAILED: 'Failed',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status.toLowerCase()}`}>{STATUS_TEXT[status] ?? status}</span>;
}

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
