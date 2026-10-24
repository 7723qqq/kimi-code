const BCRYPT_COST = 12;

export async function resolvePasswordHash(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const plaintext = env['KIMI_CODE_PASSWORD'];
  if (!plaintext) {
    return undefined;
  }
  return Bun.password.hash(plaintext, { algorithm: 'bcrypt', cost: BCRYPT_COST });
}

export async function verifyPassword(
  candidate: string,
  passwordHash: string | undefined,
): Promise<boolean> {
  if (passwordHash === undefined) {
    return false;
  }
  try {
    return await Bun.password.verify(candidate, passwordHash);
  } catch {
    return false;
  }
}
