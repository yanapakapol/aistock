import 'server-only';
import bcrypt from 'bcryptjs';

// Cost 10 is OWASP-acceptable for low-stakes apps (no PCI / no PHI) and ~4x
// faster than cost 12. Existing hashes minted at cost 12 still verify fine via
// bcrypt.compare — the cost is encoded in the hash string itself.
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
