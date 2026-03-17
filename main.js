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

const proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: true,
});

const sessionPool = await Actor.openSessionPool({
    maxPoolSize: maxConcurrency,
    sessionOptions: { maxUsageCount: 50 }
});

const browser = await chromium.launch({ headless: true });

async function extractCompanies(page) {
    return await page.$$eval('[data-test-search-result]', nodes => {
        return nodes.map(node => {
            const name = node.querySelector('span[dir="ltr"]') ? node.querySelector('span[dir="ltr"]').innerText.trim() : 'Unknown';
            const linkedinUrl = node.querySelector('a') ? node.querySelector('a').href : null;
            const text = node.innerText;
            const headcountMatch = text.match(/(\d{1,3},?\d*\+?\s?employees)/i);

            return {
                companyName: name,
                linkedinUrl,
                headcount: headcountMatch ? headcountMatch[0] : null, // FIXED: Added [0]
                rawText: text.slice(0, 500) // Truncated to save memory
            };
        });
    });
}

try {
    const session = await sessionPool.getSession();
    const proxyInfo = await proxyConfiguration.newProxyInfo(session.id);

    const context = await browser.newContext({
        proxy: proxyInfo ? { server: proxyInfo.url } : undefined,
        // More realistic viewport and user agent to avoid detection on free proxies
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    if (cookieString) {
        const cookies = cookieString.split(';').map(c => {
            const [name, ...valueParts] = c.trim().split('=');
            if (!name || valueParts.length === 0) return null;
            return {
                name: name.trim(),
                value: valueParts.join('=').trim(),
                domain: '.linkedin.com',
                path: '/'
            };
        }).filter(Boolean);
        await context.addCookies(cookies);
    }

    const page = await context.newPage();

    console.log("Opening Sales Navigator...");
    await page.goto(salesNavigatorSearchUrl, {
        waitUntil: 'networkidle', // Changed to networkidle for better stability
        timeout: 60000
    });

    // Check for login wall
    if (page.url().includes("login") || page.url().includes("checkpoint")) {
        session.markBad();
        throw new Error("LinkedIn blocked the request or session expired. Check your li_at cookie.");
    }

    await page.waitForSelector('[data-test-search-result]', { timeout: 20000 });

    let results = [];
    let previousHeight = 0;
    let sameHeightCount = 0;

    while (results.length < maxResults && sameHeightCount < 5) {
        const newItems = await extractCompanies(page);
        results.push(...newItems);

        // Unique results only
        results = Array.from(new Map(results.filter(i => i.linkedinUrl).map(i => [i.linkedinUrl, i])).values());
        
        console.log(`Current Count: ${results.length}`);

        const currentHeight = await page.evaluate(() => {
            window.scrollBy(0, 1000);
            return document.body.scrollHeight;
        });

        if (currentHeight === previousHeight) {
            sameHeightCount++;
        } else {
            sameHeightCount = 0;
        }
        previousHeight = currentHeight;

        await page.waitForTimeout(3000 + Math.random() * 2000);
    }

    const finalData = results.slice(0, maxResults);
    await Actor.pushData(finalData);
    console.log(`Finished! Exported ${finalData.length} companies.`);

} catch (err) {
    console.error("Critical Actor Error:", err.message);
    // Throwing error here ensures Apify marks the run as 'Failed' so you know to check it
    throw err; 
} finally {
    await browser.close();
    await Actor.exit();
}
