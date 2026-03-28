export type AuthPayload = {
  userId?: string;
  role?: string;
  jti?: string;
} | null;

export function hasValidAdminKeyHeader(adminKey: string, headerValue: string | undefined): boolean {
  return !!adminKey && !!headerValue && headerValue === adminKey;
}

export function canOverrideUserQuery(payload: AuthPayload, hasAdminKey: boolean): boolean {
  return hasAdminKey || payload?.role === "admin" || payload?.role === "support";
}

export function validateWalletLinkMessage(params: {
  message: string;
  walletAddress: string;
  userId: string;
  prefix: string;
}): boolean {
  const { message, walletAddress, userId, prefix } = params;
  const expectedUserLine = `User ID: ${userId}`;
  const expectedWalletLine = `Wallet: ${walletAddress.toLowerCase()}`.toLowerCase();

  return (
    message.includes(prefix) &&
    message.includes(expectedUserLine) &&
    message.toLowerCase().includes(expectedWalletLine)
  );
}
