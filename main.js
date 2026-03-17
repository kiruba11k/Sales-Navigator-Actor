import { Actor } from 'apify';
import { chromium } from 'playwright';
import { SessionPool } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    salesNavigatorSearchUrl,
    maxResults = 500, // Keep this low for testing
    cookieString,
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
const sessionPool = await SessionPool.open({ maxPoolSize: 1 });
const browser = await chromium.launch({ headless: true });

// --- STEP 1: Link Extractor ---
async function getCompanyLinks(page, max) {
    let links = new Set();
    while (links.size < max) {
        const newLinks = await page.$$eval('a[data-anonymize="company-name"]', 
            anchors => anchors.map(a => a.href));
        
        newLinks.forEach(link => links.size < max && links.add(link));
        console.log(`Found ${links.size} company links...`);

        if (links.size >= max) break;

        const currentHeight = await page.evaluate(() => {
            window.scrollBy(0, 1000);
            return document.body.scrollHeight;
        });
        await page.waitForTimeout(2000);
    }
    return Array.from(links);
}

// --- STEP 2: Deep Detail Extractor ---
async function extractCompanyDetails(page, url) {
    console.log(`Scraping details for: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    return await page.evaluate(() => {
        const getVal = (label) => {
            const el = Array.from(document.querySelectorAll('dt'))
                .find(dt => dt.innerText.includes(label));
            return el ? el.nextElementSibling?.innerText.trim() : null;
        };

        return {
            companyName: document.querySelector('.artdeco-entity-lockup__title')?.innerText.trim(),
            website: document.querySelector('a[data-anonymize="company-website"]')?.href || getVal('Website'),
            industry: getVal('Industry'),
            companySize: getVal('Company size'),
            headquarters: getVal('Headquarters'),
            specialties: getVal('Specialties'),
            description: document.querySelector('.artdeco-entity-lockup__summary')?.innerText.trim(),
            linkedinUrl: window.location.href
        };
    });
}

// --- MAIN RUN ---
try {
    const session = await sessionPool.getSession();
    const proxyInfo = await proxyConfiguration.newProxyInfo(session.id);
    const context = await browser.newContext({
        proxy: { server: proxyInfo.url },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    if (cookieString) {
        const cookies = cookieString.split(';').map(c => {
            const [name, ...val] = c.trim().split('=');
            return { name: name.trim(), value: val.join('=').trim(), domain: '.linkedin.com', path: '/' };
        }).filter(c => c.name);
        await context.addCookies(cookies);
    }

    const page = await context.newPage();
    
    console.log("Loading search results...");
    await page.goto(salesNavigatorSearchUrl, { waitUntil: 'networkidle' });
    
    // 1. Get the list of links
    const companyUrls = await getCompanyLinks(page, maxResults);

    // 2. Visit each link for "Deep Search"
    for (const url of companyUrls) {
        try {
            const details = await extractCompanyDetails(page, url);
            await Actor.pushData(details);
            // Random delay to mimic human behavior
            await page.waitForTimeout(3000 + Math.random() * 3000);
        } catch (e) {
            console.error(`Failed to scrape ${url}:`, e.message);
        }
    }

} catch (err) {
    console.error("Fatal Error:", err.message);
} finally {
    await browser.close();
    await Actor.exit();
}
