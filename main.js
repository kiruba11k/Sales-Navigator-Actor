
import { Actor } from 'apify';
import { chromium } from 'playwright';
import { SessionPool } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    salesNavigatorSearchUrl,
    maxResults = 500, // Start small for testing
    cookieString,
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
const sessionPool = await SessionPool.open({ maxPoolSize: 1 });
const browser = await chromium.launch({ headless: true });

// --- STEP 1: Link Extractor (With Safety Checks) ---
async function getCompanyLinks(page, max) {
    let links = new Set();
    
    // WAIT for the search results to actually appear on screen
    try {
        await page.waitForSelector('[data-test-search-result], .artdeco-entity-lockup', { timeout: 30000 });
    } catch (e) {
        console.error("Search results never loaded. LinkedIn might be blocking or cookie is invalid.");
        return [];
    }

    while (links.size < max) {
        const newLinks = await page.$$eval('a[data-anonymize="company-name"]', 
            anchors => anchors.map(a => a.href));
        
        newLinks.forEach(link => {
            if (links.size < max && link.includes('sales/company')) {
                links.add(link);
            }
        });
        
        console.log(`Found ${links.size} company links so far...`);
        if (links.size >= max) break;

        // SAFE SCROLL: Check if document.body exists before reading scrollHeight
        const scrollSuccess = await page.evaluate(() => {
            if (!document.body) return false;
            window.scrollBy(0, 800);
            return true;
        });

        if (!scrollSuccess) break;
        await page.waitForTimeout(3000);
        
        // If we've scrolled a lot and found nothing new, stop
        if (newLinks.length === 0) break;
    }
    return Array.from(links);
}

// --- STEP 2: Deep Detail Extractor ---
async function extractCompanyDetails(page, url) {
    console.log(`Scraping details: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000); // Give it time to load sub-elements

    return await page.evaluate(() => {
        const getVal = (label) => {
            const el = Array.from(document.querySelectorAll('dt'))
                .find(dt => dt.innerText.includes(label));
            return el ? el.nextElementSibling?.innerText.trim() : null;
        };

        return {
            companyName: document.querySelector('.artdeco-entity-lockup__title')?.innerText.trim() || "N/A",
            website: document.querySelector('a[data-anonymize="company-website"]')?.href || getVal('Website'),
            industry: getVal('Industry'),
            companySize: getVal('Company size'),
            location: getVal('Headquarters'),
            specialties: getVal('Specialties'),
            description: document.querySelector('.artdeco-entity-lockup__summary')?.innerText.trim(),
            linkedinUrl: window.location.href
        };
    });
}

try {
    const session = await sessionPool.getSession();
    const proxyInfo = await proxyConfiguration.newProxyInfo(session.id);
    const context = await browser.newContext({
        proxy: { server: proxyInfo.url },
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    if (cookieString) {
        const cookies = cookieString.split(';').map(c => {
            const [name, ...val] = c.trim().split('=');
            if (!name || val.length === 0) return null;
            return { name: name.trim(), value: val.join('=').trim(), domain: '.linkedin.com', path: '/' };
        }).filter(Boolean);
        await context.addCookies(cookies);
    }

    const page = await context.newPage();
    
    console.log("Loading search results...");
    await page.goto(salesNavigatorSearchUrl, { waitUntil: 'networkidle', timeout: 90000 });
    
    // Check for "Verify you are human" or Login Redirect
    if (page.url().includes('checkpoint') || page.url().includes('login')) {
        throw new Error("BLOCKED: LinkedIn is showing a security check. Free proxies are likely detected.");
    }

    const companyUrls = await getCompanyLinks(page, maxResults);

    if (companyUrls.length === 0) {
        console.log("No companies found. Check if the URL is a valid Sales Navigator Company Search.");
    }

    for (const url of companyUrls) {
        try {
            const details = await extractCompanyDetails(page, url);
            await Actor.pushData(details);
            await page.waitForTimeout(4000 + Math.random() * 3000); // Random human-like pause
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
