/** Presentation identity only; execution uses the controller's durable exchange identity. */
export function responseUIKey(text) {
  const raw = text.trim();
  let digest = 2166136261;
  for (let i = 0; i < raw.length; i++) digest = Math.imul(digest ^ raw.charCodeAt(i), 16777619);
  return raw.length + ':' + (digest >>> 0).toString(36);
}
