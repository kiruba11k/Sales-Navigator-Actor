import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

const input = await Actor.getInput();

const {
    salesNavigatorSearchUrl,
    maxResults = 500,
    cookieString,
    maxConcurrency = 3
} = input;

// -----------------------------
// Proxy (RESIDENTIAL)
// -----------------------------
const proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: true,
    groups: ['RESIDENTIAL'],
});

// -----------------------------
// Session Pool (LinkedIn accounts)
// -----------------------------
const sessionPool = await Actor.openSessionPool({
    maxPoolSize: maxConcurrency,
    sessionOptions: {
        maxUsageCount: 50
    }
});

// -----------------------------
// Browser launch
// -----------------------------
const browser = await chromium.launch({
    headless: true,
});

// -----------------------------
// Helper: Inject Cookies
// -----------------------------
async function createContext(session) {

    const context = await browser.newContext({
        proxy: proxyConfiguration ? await proxyConfiguration.newProxyInfo() : undefined
    });

    if (cookieString) {
        const cookies = cookieString.split(';').map(c => {
            const [name, value] = c.trim().split('=');
            return {
                name,
                value,
                domain: '.linkedin.com',
                path: '/'
            };
        });

        await context.addCookies(cookies);
    }

    return context;
}

// -----------------------------
// Extract companies
// -----------------------------
async function extractCompanies(page) {

    return await page.$$eval('[data-test-search-result]', nodes => {

        return nodes.map(node => {

            const name =
                node.querySelector('span[dir="ltr"]')?.innerText?.trim();

            const linkedinUrl =
                node.querySelector('a')?.href;

            const text = node.innerText;

            const headcountMatch = text.match(/(\d{1,3},?\d*\+?\s?employees)/i);

            return {
                companyName: name,
                linkedinUrl,
                headcount: headcountMatch?.[0] || null,
                rawText: text
            };
        });
    });
}

// -----------------------------
// Smart scrolling engine
// -----------------------------
async function scrollAndCollect(page, maxResults) {

    let results = [];
    let previousHeight = 0;
    let sameHeightCount = 0;

    while (results.length < maxResults && sameHeightCount < 5) {

        const newItems = await extractCompanies(page);

        results.push(...newItems);

        // Deduplicate
        results = Array.from(
            new Map(results.map(i => [i.linkedinUrl, i])).values()
        );

        console.log(`Collected: ${results.length}`);

        const currentHeight = await page.evaluate(() => document.body.scrollHeight);

        if (currentHeight === previousHeight) {
            sameHeightCount++;
        } else {
            sameHeightCount = 0;
        }

        previousHeight = currentHeight;

        await page.mouse.wheel(0, 4000);

        // Human-like delay
        await page.waitForTimeout(2000 + Math.random() * 2000);
    }

    return results.slice(0, maxResults);
}

// -----------------------------
// Main Run
// -----------------------------
const session = await sessionPool.getSession();

const context = await createContext(session);

const page = await context.newPage();

try {

    console.log("Opening Sales Navigator...");

    await page.goto(salesNavigatorSearchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    // Detect login issue
    if (page.url().includes("login")) {
        throw new Error("LinkedIn session expired");
    }

    await page.waitForSelector('[data-test-search-result]', {
        timeout: 15000
    });

    const companies = await scrollAndCollect(page, maxResults);

    console.log(`Final companies: ${companies.length}`);

    // Save results
    for (const item of companies) {
        await Actor.pushData(item);
    }

} catch (err) {

    console.error("Error:", err);

    session.markBad();

} finally {

    await page.close();
    await context.close();
}

await browser.close();
await Actor.exit();
