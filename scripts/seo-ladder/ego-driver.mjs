import { mkdir, writeFile } from "node:fs/promises";

const { taskSpace } = await import(["ego", "browser"].join("-"));

const GOOGLE_HOME = "https://www.google.com/?hl=en";
const GAP_MS = [45_000, 51_000, 57_000, 48_000, 54_000];
const CONSENT_SELECTORS = [
  "button[aria-label='Reject all']",
  "button[name='reject']",
  "#W0wltc",
];

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function allAfter(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function slugify(value, index) {
  const slug = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "query"}-${index + 1}`;
}

function googleHost(value) {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase();
    return hostname === "google.com" || hostname.endsWith(".google.com");
  } catch {
    return false;
  }
}

async function clickOnGoogle(page, selector) {
  await page.click(selector);
  const stillOnGoogle = googleHost(await page.url());
  if (!stillOnGoogle) {
    await page.goto(GOOGLE_HOME);
    return false;
  }
  return true;
}

async function rejectConsent(page) {
  for (const selector of CONSENT_SELECTORS) {
    try {
      return await clickOnGoogle(page, selector);
    } catch {
      // The selector is absent on ordinary result pages.
    }
  }
  return true;
}

async function collect() {
  const args = process.argv.slice(2);
  const runDir = valueAfter(args, "--run-dir");
  const queries = allAfter(args, "--query").slice(0, 25);
  if (!runDir || queries.length === 0) {
    throw new Error("ego-driver requires --run-dir and at least one --query");
  }
  await mkdir(runDir, { recursive: true });

  const task = await taskSpace(`seo-ladder-${Date.now()}`);
  const page = task.page("p1");
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    await page.goto(GOOGLE_HOME);
    const consentOnGoogle = await rejectConsent(page);
    if (!consentOnGoogle) continue;
    const searchOnGoogle = await clickOnGoogle(page, "textarea[name='q']");
    if (!searchOnGoogle) continue;
    await page.keyboard.type(query, { delay: 90 });
    await page.keyboard.press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const finalUrl = await page.url();
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const slug = slugify(query, index);
    await writeFile(`${runDir}/${slug}.html`, html, "utf8");
    await writeFile(
      `${runDir}/${slug}.meta.json`,
      JSON.stringify(
        { query, collectedAt: new Date().toISOString(), finalUrl },
        null,
        2,
      ),
      "utf8",
    );

    if (
      /\/sorry(?:[/?#]|$)/i.test(finalUrl) ||
      /recaptcha|unusual traffic/i.test(html)
    ) {
      return 2;
    }
    if (index < queries.length - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, GAP_MS[index % GAP_MS.length]),
      );
    }
  }
  return 0;
}

try {
  process.exitCode = await collect();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "EgoLite collection failed"}\n`,
  );
  process.exitCode = 3;
}
