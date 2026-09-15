// Shared by the Sidebar (client, writes it) and the dashboard layout (server, reads it on render).
export const SIDEBAR_COLLAPSED_COOKIE = 'sidebar_collapsed';

export function parseCollapsedSections(value: string | undefined): string[] {
  if (!value) return [];
  try {
    return decodeURIComponent(value).split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
