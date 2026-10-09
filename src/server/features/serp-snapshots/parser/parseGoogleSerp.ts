import * as cheerio from "cheerio";
import type { SerpSnapshotInput } from "@/types/schemas/serpSnapshots";

type ParsedResults = {
  kind: "results";
  organic: SerpSnapshotInput["organic"];
  paa: string[];
  related: string[];
  videos: SerpSnapshotInput["videos"];
  aiOverview: SerpSnapshotInput["aiOverview"];
};

type ParsedBlocked = {
  kind: "blocked";
  reason: "captcha" | "sorry";
};

export type ParsedSerp = ParsedResults | ParsedBlocked;

const GOOGLE_HOST = /(^|\.)google\./i;
const YOUTUBE_HOST = /(^|\.)youtube\.com$/i;

function cleanText(value: string) {
  const cssStart = value.search(/\.[A-Za-z_-][A-Za-z\d_-]*\{|\{/);
  const withoutCss = cssStart === -1 ? value : value.slice(0, cssStart);
  return withoutCss.replace(/\s+/g, " ").trim();
}

function httpUrl(value: string, base = "https://www.google.com") {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.toString().length > 2048) return null;
    return url;
  } catch {
    return null;
  }
}

function youtubeVideoId(url: URL) {
  if (url.hostname === "youtu.be") {
    return url.pathname.slice(1).split("/")[0] || null;
  }
  if (!YOUTUBE_HOST.test(url.hostname)) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const pathParts = url.pathname.split("/").filter(Boolean);
  return pathParts[0] === "shorts" || pathParts[0] === "embed"
    ? (pathParts[1] ?? null)
    : null;
}

function isGoogleUrl(url: URL) {
  return GOOGLE_HOST.test(url.hostname);
}

function extractBlockedReason(
  $: cheerio.CheerioAPI,
  html: string,
): ParsedBlocked["reason"] | null {
  const bodyText = $("body").text();
  const hasCaptcha =
    $(
      "form[action*='sorry'], form[action*='recaptcha'], .g-recaptcha, iframe[src*='recaptcha']",
    ).length > 0 || /unusual traffic|recaptcha/i.test(bodyText);
  if (hasCaptcha) return "captcha";
  if (/\/sorry(?:[/?#"'\\]|$)/i.test(html)) return "sorry";
  return null;
}

function parsePaa($: cheerio.CheerioAPI) {
  const questions = new Set<string>();
  $(".related-question-pair").each((_index, element) => {
    const question = cleanText(
      $(element).attr("data-q") ??
        $(element).find("[data-q]").first().attr("data-q") ??
        $(element).text(),
    ).slice(0, 500);
    if (question) questions.add(question);
  });
  return [...questions].slice(0, 50);
}

function parseRelated($: cheerio.CheerioAPI) {
  const related = new Set<string>();
  const add = (value: string) => {
    const text = cleanText(value).slice(0, 500);
    if (text) related.add(text);
  };

  $("a.Q2kp9d").each((_index, element) => {
    const href = $(element).attr("href");
    const url = href ? httpUrl(href) : null;
    add(url?.searchParams.get("q") ?? $(element).text());
  });

  if (related.size === 0) {
    $("#search .MjjYud").each((_index, element) => {
      const blockText = cleanText($(element).text()).slice(0, 160);
      if (!/related searches/i.test(blockText)) return;
      $(element)
        .find("a[href]")
        .each((_linkIndex, link) => {
          const href = $(link).attr("href");
          const url = href ? httpUrl(href) : null;
          if (url?.pathname === "/search") add(url.searchParams.get("q") ?? "");
        });
    });
  }

  return [...related].slice(0, 50);
}

function parseOrganic($: cheerio.CheerioAPI) {
  const organic: SerpSnapshotInput["organic"] = [];
  const seen = new Set<string>();
  const headings = $("#search h3").length > 0 ? $("#search h3") : $("h3");

  headings.each((_index, element) => {
    if (organic.length >= 10) return;
    const block = $(element).closest(".MjjYud");
    const blockStart = cleanText(block.text()).slice(0, 180);
    if (
      /sponsored result|people also ask|^videos|things to know|ai overview|ai mode reply/i.test(
        blockStart,
      ) ||
      block.find(".related-question-pair, a[href*='youtube.com/watch']")
        .length > 0
    ) {
      return;
    }

    const link =
      $(element).closest("a").attr("href") ??
      block.find("a[href]").first().attr("href");
    const url = link ? httpUrl(link) : null;
    const title = cleanText($(element).text()).slice(0, 500);
    if (!url || !title || isGoogleUrl(url) || youtubeVideoId(url)) return;
    const key = url.toString();
    if (seen.has(key)) return;
    seen.add(key);

    const snippet = cleanText(
      block.find(".VwiC3b, [data-sncf]").first().text(),
    ).slice(0, 2000);
    const result: SerpSnapshotInput["organic"][number] = {
      position: organic.length + 1,
      title,
      url: url.toString(),
    };
    if (snippet) result.snippet = snippet;
    organic.push(result);
  });

  return organic;
}

function parseVideos($: cheerio.CheerioAPI) {
  const videosById = new Map<string, SerpSnapshotInput["videos"][number]>();

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const url = href ? httpUrl(href) : null;
    if (!url) return;
    const videoId = youtubeVideoId(url);
    if (!videoId) return;

    const labelledTitle = ($(element).attr("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((labelId) => cleanText($(`#${labelId}`).first().text()))
      .find(Boolean);
    const title =
      cleanText(
        $(element)
          .find(".V5XKdd .cHaqb, [role='heading'] .cHaqb, .cHaqb")
          .first()
          .text(),
      ) ||
      labelledTitle ||
      "";
    const anchorText = cleanText($(element).text());
    const isDescription =
      $(element).is(".q9yZOe") || /^from\s+\d/i.test(anchorText);
    const candidateTitle =
      title ||
      (!isDescription && !/^\d{1,2}:\d{2}/.test(anchorText) ? anchorText : "");
    const canonicalUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const channel =
      cleanText(
        $(element)
          .find(".Sg4azc span")
          .eq(1)
          .text()
          .replace(/^\s*[·•]\s*/, ""),
      ).slice(0, 200) ||
      cleanText(
        ($(element).attr("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((labelId) => $(`#${labelId}`).find(".BtZxob").text())
          .find(Boolean) ?? "",
      ).slice(0, 200);
    const existing = videosById.get(videoId);
    if (existing) {
      if (existing.title.startsWith("YouTube video ") && candidateTitle) {
        const replacement: SerpSnapshotInput["videos"][number] = {
          ...existing,
          title: candidateTitle.slice(0, 500),
        };
        if (channel && !existing.channel) replacement.channel = channel;
        videosById.set(videoId, replacement);
      }
      return;
    }

    const video: SerpSnapshotInput["videos"][number] = {
      title: (candidateTitle || `YouTube video ${videoId}`).slice(0, 500),
      url: canonicalUrl,
      position: videosById.size + 1,
    };
    if (channel) video.channel = channel;
    videosById.set(videoId, video);
  });

  return [...videosById.values()].slice(0, 50);
}

function parseAiOverview(
  $: cheerio.CheerioAPI,
): SerpSnapshotInput["aiOverview"] {
  const candidates = $(
    ".ai-overview, .nk9vdc, [aria-label*='AI Overview'], [data-attrid*='AI Overview']",
  );
  const containerElement = candidates.toArray().find((element) => {
    const text = cleanText($(element).text());
    return (
      /ai overview/i.test(text) &&
      !/not available|can't generate|try again later/i.test(text)
    );
  });

  if (!containerElement) return { present: false };
  const container = $(containerElement);

  const citedUrls = new Set<string>();
  container.find("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const url = href ? httpUrl(href) : null;
    if (url && !isGoogleUrl(url)) citedUrls.add(url.toString());
  });

  const excerptContainer = container.clone();
  excerptContainer.find("a, h1, h2, h3, [class*='Fzsovc']").remove();
  const excerpt = cleanText(excerptContainer.text())
    .replace(/^AI Overview\s*/i, "")
    .slice(0, 5000);
  const overview: SerpSnapshotInput["aiOverview"] = { present: true };
  if (excerpt) overview.excerpt = excerpt;
  if (citedUrls.size > 0) overview.citedUrls = [...citedUrls].slice(0, 50);
  return overview;
}

export function parseGoogleSerp(html: string): ParsedSerp {
  const $ = cheerio.load(html);
  const blockedReason = extractBlockedReason($, html);
  if (blockedReason) return { kind: "blocked", reason: blockedReason };

  return {
    kind: "results",
    organic: parseOrganic($),
    paa: parsePaa($),
    related: parseRelated($),
    videos: parseVideos($),
    aiOverview: parseAiOverview($),
  };
}
