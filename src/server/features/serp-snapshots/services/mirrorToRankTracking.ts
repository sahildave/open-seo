import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { toRankTrackingTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";
import type { SerpSnapshot } from "./SerpSnapshotService";
import { findOurResult } from "./serpSnapshotPosition";

export async function mirrorToRankTracking(
  project: { id: string; domain: string | null },
  snapshots: SerpSnapshot[],
) {
  const result = { configsTouched: 0, runsWritten: 0 };
  const domain = project.domain;
  if (!domain) return result;

  const markets = new Map<string, SerpSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.locationCode}:${snapshot.languageCode}`;
    const group = markets.get(key) ?? [];
    group.push(snapshot);
    markets.set(key, group);
  }

  for (const captures of markets.values()) {
    const { locationCode, languageCode } = captures[0];
    const lookup = () =>
      RankTrackingRepository.getConfigByProjectDomainMarket(
        project.id,
        domain,
        locationCode,
        languageCode,
        null,
      );
    let config = await lookup();
    if (!config) {
      try {
        await RankTrackingRepository.createConfig({
          id: crypto.randomUUID(),
          projectId: project.id,
          domain,
          locationCode,
          languageCode,
          locationName: null,
          devices: captures[0].device,
          serpDepth: 10,
          scheduleInterval: "manual",
        });
      } catch (error) {
        // A concurrent ingest can win the config's unique key. Re-read only
        // that key; unrelated database failures must still surface.
        if (!(await lookup())) throw error;
      }
      config = await lookup();
    }
    if (!config) throw new Error("Rank tracking config was not created");

    const devices = new Set(captures.map((s) => s.device));
    devices.add(config.devices === "both" ? "desktop" : config.devices);
    if (config.devices === "both") devices.add("mobile");
    const deepestPosition = Math.max(
      config.serpDepth,
      10,
      ...captures.flatMap((s) => s.organic.map((r) => r.position)),
    );
    // Config forms and paid-check inputs accept depths in steps of ten.
    const serpDepth = Math.ceil(deepestPosition / 10) * 10;
    await RankTrackingRepository.updateConfig(config.id, project.id, {
      devices: devices.size === 2 ? "both" : captures[0].device,
      serpDepth,
    });
    await RankTrackingRepository.addKeywordsToConfig(
      [...new Set(captures.map((s) => s.keyword.trim().toLowerCase()))].map(
        (keyword) => ({
          id: crypto.randomUUID(),
          configId: config.id,
          keyword,
        }),
      ),
    );
    const keywords = await RankTrackingRepository.getKeywordsForConfig(
      config.id,
    );
    const keywordIds = new Map(keywords.map((k) => [k.keyword, k.id]));
    const days = new Map<string, SerpSnapshot[]>();
    for (const capture of captures) {
      const day = capture.collectedAt.slice(0, 10);
      const group = days.get(day) ?? [];
      group.push(capture);
      days.set(day, group);
    }
    for (const [day, collected] of days) {
      const runId = `serp-${config.id}-${day}`;
      const latest = new Map<string, SerpSnapshot>();
      // Repository orders captures oldest first; the last keyword/device wins.
      for (const capture of collected) {
        latest.set(
          `${capture.keyword.trim().toLowerCase()}:${capture.device}`,
          capture,
        );
      }
      const keywordCount = new Set(
        collected.map((s) => s.keyword.trim().toLowerCase()),
      ).size;
      await RankTrackingRepository.upsertCollectedRun(
        {
          id: runId,
          configId: config.id,
          projectId: project.id,
          status: "completed",
          keywordsTotal: keywordCount,
          keywordsChecked: keywordCount,
          isSubsetRun: keywordCount < keywords.length,
          startedAt: toRankTrackingTimestamp(
            new Date(collected[0].collectedAt),
          ),
          completedAt: toRankTrackingTimestamp(
            new Date(collected[collected.length - 1].collectedAt),
          ),
        },
        [...latest.values()].map((capture) => {
          const keyword = capture.keyword.trim().toLowerCase();
          const trackingKeywordId = keywordIds.get(keyword);
          if (!trackingKeywordId)
            throw new Error("Mirrored keyword was not created");
          const features = ["organic"];
          if (capture.paa.length) features.push("people_also_ask");
          if (capture.videos.length) features.push("video");
          if (capture.aiOverview.present) features.push("ai_overview");
          return {
            runId,
            trackingKeywordId,
            keyword,
            device: capture.device,
            position: capture.ourPosition,
            url: findOurResult(project.domain, capture.organic)?.url ?? null,
            serpFeatures: JSON.stringify(features),
            checkedAt: toRankTrackingTimestamp(new Date(capture.collectedAt)),
          };
        }),
      );
      result.runsWritten++;
    }
    result.configsTouched++;
  }
  return result;
}
