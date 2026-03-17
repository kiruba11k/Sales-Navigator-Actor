import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

const input = await Actor.getInput() || {};
const {
    salesNavigatorSearchUrl,
    maxResults = 500,
    cookieString,
    maxProxyAttempts = 3,
    proxyGroups,
    proxyCountry,
    useApifyProxy = true,
} = input;

if (!salesNavigatorSearchUrl) {
    throw new Error('Input "salesNavigatorSearchUrl" is required.');
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    useApifyProxy: useApifyProxy !== false,
    groups: Array.isArray(proxyGroups) ? proxyGroups : undefined,
    countryCode: typeof proxyCountry === 'string' ? proxyCountry : undefined,
});

const browser = await chromium.launch({ headless: true });

const BLOCK_HINT = 'LinkedIn is blocking this session/proxy or the cookie is no longer valid.';

const isBlockedUrl = (url = '') => /checkpoint|challenge|captcha|login|authwall/i.test(url);

async function detectSearchPageState(page) {
    const result = await page.waitForFunction(() => {
        const url = window.location.href;
        const hasResultCards = !!document.querySelector('a[data-anonymize="company-name"], .artdeco-entity-lockup, [data-test-search-result]');
        const pageText = (document.body?.innerText || '').toLowerCase();
        const blockedText = ['verify you are human', 'security verification', 'captcha', 'unusual activity'].some((t) => pageText.includes(t));
        const emptyText = ['no results found', 'we could not find any results'].some((t) => pageText.includes(t));

        return {
            url,
            hasResultCards,
            blockedText,
            emptyText,
        };
    }, { timeout: 45000 });

    return result.jsonValue();
}

async function getCompanyLinks(page, max) {
    const links = new Set();
    let staleRounds = 0;

    const state = await detectSearchPageState(page);
    if (isBlockedUrl(state.url) || state.blockedText) {
        throw new Error(`Search results did not load because of a LinkedIn checkpoint/authwall. ${BLOCK_HINT}`);
    }
    if (!state.hasResultCards && state.emptyText) {
        console.log('Search page loaded but LinkedIn returned an empty result set.');
        return [];
    }
    if (!state.hasResultCards) {
        throw new Error(`Search results never appeared. ${BLOCK_HINT}`);
    }

    while (links.size < max && staleRounds < 4) {
        const before = links.size;
        const newLinks = await page.$$eval('a[data-anonymize="company-name"]', (anchors) => anchors.map((a) => a.href));

        for (const link of newLinks) {
            if (links.size >= max) break;
            if (link.includes('/sales/company/')) links.add(link);
        }

        console.log(`Found ${links.size} company links so far...`);

        if (links.size === before) {
            staleRounds += 1;
        } else {
            staleRounds = 0;
        }

        if (links.size >= max) break;

        await page.evaluate(() => {
            window.scrollBy(0, Math.max(800, window.innerHeight));
        });
        await page.waitForTimeout(2500);
    }

    return Array.from(links);
}

async function extractCompanyDetails(page, url) {
    console.log(`Scraping details: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    if (isBlockedUrl(page.url())) {
        throw new Error(`LinkedIn redirected to ${page.url()} while opening company details. ${BLOCK_HINT}`);
    }

    return page.evaluate(() => {
        const getVal = (label) => {
            const el = Array.from(document.querySelectorAll('dt'))
                .find((dt) => dt.innerText.includes(label));
            return el ? el.nextElementSibling?.innerText.trim() : null;
        };

        return {
            companyName: document.querySelector('.artdeco-entity-lockup__title')?.innerText.trim() || 'N/A',
            website: document.querySelector('a[data-anonymize="company-website"]')?.href || getVal('Website'),
            industry: getVal('Industry'),
            companySize: getVal('Company size'),
            location: getVal('Headquarters'),
            specialties: getVal('Specialties'),
            description: document.querySelector('.artdeco-entity-lockup__summary')?.innerText.trim(),
            linkedinUrl: window.location.href,
        };
    });
}

async function buildCookieObjects(rawCookieString) {
    if (!rawCookieString) return [];

    return rawCookieString
        .split(';')
        .map((c) => {
            const [name, ...val] = c.trim().split('=');
            if (!name || val.length === 0) return null;
            return {
                name: name.trim(),
                value: val.join('=').trim(),
                domain: '.linkedin.com',
                path: '/',
                secure: true,
            };
        })
        .filter(Boolean);
}

try {
    const cookies = await buildCookieObjects(cookieString);
    let companyUrls = [];
    let page;
    let context;

    for (let attempt = 1; attempt <= maxProxyAttempts; attempt += 1) {
        const proxySessionId = `linkedin_search_${Date.now()}_${attempt}_${Math.random().toString(36).slice(2, 8)}`;
        const proxyInfo = await proxyConfiguration.newProxyInfo(proxySessionId);

        console.log(`Loading search results (attempt ${attempt}/${maxProxyAttempts}) with proxy ${proxyInfo?.hostname || proxyInfo?.url || 'disabled'} (session ${proxySessionId}) ...`);

        context = await browser.newContext({
            proxy: proxyInfo?.url ? { server: proxyInfo.url } : undefined,
            viewport: { width: 1280, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        });

        if (cookies.length > 0) {
            await context.addCookies(cookies);
        }

        page = await context.newPage();

        try {
            await page.goto(salesNavigatorSearchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
            await page.waitForTimeout(5000);

            if (isBlockedUrl(page.url())) {
                throw new Error(`Blocked immediately on load at ${page.url()}. ${BLOCK_HINT}`);
            }

            companyUrls = await getCompanyLinks(page, maxResults);
            if (companyUrls.length === 0) {
                console.log('No companies found. Make sure this is a valid Sales Navigator company search URL and the account has access.');
            }
            break;
        } catch (error) {
            const isTimeout = /timeout/i.test(error?.message || '');
            const timeoutHint = isTimeout
                ? ' This usually means the proxy cannot reach LinkedIn. Free Apify datacenter proxies are often blocked; try RESIDENTIAL proxies, disable proxy usage, or use a different country.'
                : '';

            console.error(`Attempt ${attempt} failed: ${error.message}${timeoutHint}`);
            await context.close();
            page = undefined;
            context = undefined;

            if (attempt === maxProxyAttempts) throw error;
        }
    }

    if (!page || !context) {
        throw new Error(`Could not open a usable LinkedIn session after ${maxProxyAttempts} attempts.`);
    }

    for (const url of companyUrls) {
        try {
            const details = await extractCompanyDetails(page, url);
            await Actor.pushData(details);
            await page.waitForTimeout(4000 + Math.random() * 3000);
        } catch (e) {
            console.error(`Failed to scrape ${url}: ${e.message}`);
        }
    }

    await context.close();
} catch (err) {
    console.error('Fatal Error:', err.message);
} finally {
    await browser.close();
    await Actor.exit();
}
