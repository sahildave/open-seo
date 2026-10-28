import { safeHostname } from "@/shared/safe-url";
import type { SerpSnapshotInput } from "@/types/schemas/serpSnapshots";
type OrganicResult = SerpSnapshotInput["organic"][number];

function bareHost(value: string) {
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  return safeHostname(withProtocol.trim().toLowerCase());
}

// Best organic position of the project's domain (subdomains count), or null
// when the project has no domain or does not rank in the captured results.
export function findOurResult(domain: string | null, organic: OrganicResult[]) {
  const ours = domain ? bareHost(domain) : null;
  if (!ours) return null;
  const results = organic.filter((result) => {
    const host = bareHost(result.url);
    return host === ours || host?.endsWith(`.${ours}`);
  });
  return results.reduce<OrganicResult | null>(
    (best, result) =>
      !best || result.position < best.position ? result : best,
    null,
  );
}
