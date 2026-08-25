import { bumpCacheVersion } from "./cache.service";
import { logger } from "../logger";

export async function invalidateCacheDomains(domains: string[]): Promise<void> {
  const unique = [...new Set(domains.filter(Boolean))];
  await Promise.all(
    unique.map(async (domain) => {
      try {
        await bumpCacheVersion(domain);
      } catch (err) {
        logger.warn({ err, domain }, "Cache domain invalidation failed; continuing");
      }
    }),
  );
}
