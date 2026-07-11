import puppeteer, { type Browser } from "puppeteer-core";

// Pin to whichever release matches @sparticuz/chromium-min's version
// (148.0.0). Override via CHROMIUM_REMOTE_URL if you need a different one.
const DEFAULT_REMOTE_CHROMIUM =
  "https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar";

const LOCAL_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

async function firstExisting(paths: string[]): Promise<string | null> {
  const { promises: fs } = await import("node:fs");
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch { /* not present */ }
  }
  return null;
}

async function launchBrowser(): Promise<Browser> {
  const isProduction = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

  if (isProduction) {
    // Vercel / serverless path: chromium-min loaded from a remote pack
    const chromium = (await import("@sparticuz/chromium-min")).default;
    const remoteUrl = process.env.CHROMIUM_REMOTE_URL || DEFAULT_REMOTE_CHROMIUM;
    return await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(remoteUrl),
      headless: true,
    });
  }

  // Local dev path: use system Chrome if present, else fall back to chromium-min
  const localPath = process.env.PUPPETEER_EXECUTABLE_PATH || (await firstExisting(LOCAL_CHROME_PATHS));
  if (localPath) {
    return await puppeteer.launch({
      executablePath: localPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  // Fall back to chromium-min even locally — slow first run while it downloads.
  const chromium = (await import("@sparticuz/chromium-min")).default;
  return await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(process.env.CHROMIUM_REMOTE_URL || DEFAULT_REMOTE_CHROMIUM),
    headless: true,
  });
}

export async function renderPdf(html: string): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // The HTML embeds LLM-authored fragments (prompt-injectable via scraped
    // sources). Nothing in the render needs page scripts — fonts load via CSS
    // and Puppeteer's own evaluate() runs over CDP regardless — so disable JS
    // outright; an injected handler can then never execute here.
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 250));
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * Renders the same HTML to a PDF AND captures one PNG per .page element.
 * Page images are sized for web embedding (1240x1754 ≈ 150 DPI of A4).
 * Re-uses a single browser launch to keep render time tight.
 */
export async function renderPdfAndPageImages(html: string): Promise<{ pdf: Buffer; images: Buffer[] }> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Same JS lockdown as renderPdf — LLM-authored markup never executes.
    await page.setJavaScriptEnabled(false);
    // 1240 x 1754 ≈ A4 portrait at 150 DPI. deviceScaleFactor 1 keeps the
    // bitmap exactly this size; bumping it gives retina but inflates zip.
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 250));

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    // CSS lays out each section as .page { width: 210mm; height: 297mm }.
    // Override on-screen sizing so each .page fills the 1240x1754 viewport
    // exactly when screenshotted, then snap one per element.
    await page.addStyleTag({
      content: `
        html, body { background: transparent; }
        .page {
          width: 1240px !important;
          height: 1754px !important;
          padding: 82px 94px !important;
          margin: 0 !important;
          page-break-after: auto !important;
        }
      `,
    });
    // Let the new sizes settle before screenshotting.
    await new Promise((r) => setTimeout(r, 150));

    const handles = await page.$$(".page");
    const images: Buffer[] = [];
    for (const handle of handles) {
      const shot = await handle.screenshot({ type: "png", omitBackground: false });
      images.push(Buffer.from(shot));
    }
    return { pdf: Buffer.from(pdf), images };
  } finally {
    await browser.close();
  }
}
