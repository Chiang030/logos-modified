import { isIPv4 } from "node:net";

/** Permit explicit HTTP access only on a matching private VPN IPv4 listener. */
export function vpnHttpAllowed(host: string, address: URL, port: number, enabled: boolean): boolean {
  if (!enabled || !isIPv4(host) || address.protocol !== "http:" || address.hostname !== host) return false;
  if (Number(address.port || 80) !== port) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}
