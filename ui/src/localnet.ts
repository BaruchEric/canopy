import { crossesIntoLocal } from "./backends";

/** Chrome's local network access permission for this page, when reaching
 *  `base` from `pageOrigin` needs it and the browser has such a permission:
 *  the status to read and to watch for a change. Null where the request
 *  stays on one side of the network, or the browser knows no such
 *  permission (Firefox, Safari), in which case a dial just goes out. */
export async function localNetworkPermission(pageOrigin: string, base: string): Promise<PermissionStatus | null> {
  if (!crossesIntoLocal(pageOrigin, base)) return null;
  try {
    const perms = typeof navigator === "undefined" ? undefined : navigator.permissions;
    if (!perms || typeof perms.query !== "function") return null;
    return await perms.query({ name: "local-network-access" as PermissionName });
  } catch {
    return null;
  }
}
