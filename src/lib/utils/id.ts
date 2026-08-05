/** Generate a UUID for D1 primary keys */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Generate a short readable ticket code */
export function generateTicketCode(prefix = "QH"): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  for (let i = 0; i < 6; i++) {
    code += chars[array[i] % chars.length];
  }
  return `${prefix}-${code}`;
}
