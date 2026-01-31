/*
 * HidenCloud Cloud Renewal Script (Combined)
 * Merges login automation and service renewal.
 * Intended for GitHub Actions execution.
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

// --- HidenCloudBot Logic (from local_renew.js) ---

const RENEW_DAYS = 10;
// We can optimize cache file path or ignore it in cloud, but let's keep it to avoid breaking logic
const CACHE_FILE = path.join(__dirname, 'hiden_cookies_cache.json');

const sleep = (min = 3000, max = 8000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

const CacheManager = {
    load() {
        if (fs.existsSync(CACHE_FILE)) {
            try {
                return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            } catch (e) { }
        }
        return {};
    },
    save(data) {
        try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch (e) { }
    },
    get(cookieKey) {
        const data = this.load();
        return data[cookieKey] || null;
    },
    update(cookieKey, cookieStr) {
        const data = this.load();
        data[cookieKey] = cookieStr;
        this.save(data);
        console.log(`💾 [${cookieKey}] Cookie cache updated.`);
    }
};

class HidenCloudBot {
    constructor(cookieStr, cookieKey) {
        this.cookieKey = cookieKey;
        this.originalCookie = cookieStr;
        this.cookieData = {};
        this.logMsg = [];

        // In combined script, we trust the fresh cookie from Playwright first, but we can respect cache structure
        this.parseCookieStr(cookieStr);
        // We also update cache immediately to sync with the logic
        CacheManager.update(cookieKey, cookieStr);

        this.commonHeaders = {
            'Host': 'dash.hidencloud.com',
            'Connection': 'keep-alive',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Referer': 'https://dash.hidencloud.com/',
        };

        this.client = axios.create({
            baseURL: 'https://dash.hidencloud.com',
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 500,
            timeout: 30000
        });

        this.services = [];
        this.csrfToken = '';
    }

    log(msg) {
        const logLine = `[${this.cookieKey}] ${msg}`;
        console.log(logLine);
        this.logMsg.push(msg);
    }

    parseCookieStr(str) {
        if (!str) return;
        str.split(';').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const key = pair.substring(0, idx).trim();
                const val = pair.substring(idx + 1).trim();
                if (!['path', 'domain', 'expires', 'httponly', 'secure', 'samesite'].includes(key.toLowerCase())) {
                    this.cookieData[key] = val;
                }
            }
        });
    }

    updateCookiesFromResponse(headers) {
        const setCookie = headers['set-cookie'];
        if (setCookie) {
            setCookie.forEach(sc => {
                const firstPart = sc.split(';')[0];
                const idx = firstPart.indexOf('=');
                if (idx > 0) {
                    const key = firstPart.substring(0, idx).trim();
                    const val = firstPart.substring(idx + 1).trim();
                    this.cookieData[key] = val;
                }
            });
            CacheManager.update(this.cookieKey, this.getCookieStr());
        }
    }

    getCookieStr() {
        return Object.keys(this.cookieData).map(k => `${k}=${this.cookieData[k]}`).join('; ');
    }

    async request(method, url, data = null, extraHeaders = {}) {
        let currentUrl = url;
        let methodToUse = method;
        let finalResponse = null;

        const requestHeaders = {
            ...this.commonHeaders,
            ...extraHeaders,
            'Cookie': this.getCookieStr()
        };

        if (methodToUse === 'POST' && !requestHeaders['Content-Type']) {
            requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        try {
            const res = await this.client({
                method: methodToUse,
                url: currentUrl,
                headers: requestHeaders,
                data: data
            });

            this.updateCookiesFromResponse(res.headers);
            res.finalUrl = currentUrl;
            finalResponse = res;

            if (res.status === 301 || res.status === 302) {
                const location = res.headers['location'];
                if (location) {
                    this.log(`🔄 Redirect -> ${location}`);
                    currentUrl = location.startsWith('http') ? location : `https://dash.hidencloud.com${location.startsWith('/') ? '' : '/'}${location}`;
                    return this.request('GET', currentUrl);
                }
            }
            finalResponse.finalUrl = currentUrl;
            return finalResponse;
        } catch (err) {
            throw err;
        }
    }

    extractTokens($) {
        const metaToken = $('meta[name="csrf-token"]').attr('content');
        if (metaToken) this.csrfToken = metaToken;
    }

    async init() {
        this.log('🔍 Verifying login status...');
        try {
            const res = await this.request('GET', '/dashboard');

            if (res.headers.location && res.headers.location.includes('/login')) {
                this.log('❌ Cookie invalid');
                return false;
            }

            const $ = cheerio.load(res.data);
            this.extractTokens($);

            $('a[href*="/service/"]').each((i, el) => {
                const href = $(el).attr('href');
                const match = href.match(/\/service\/(\d+)\/manage/);
                if (match) {
                    this.services.push({ id: match[1], url: href });
                }
            });
            this.services = this.services.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

            this.log(`✅ Login Success. Found ${this.services.length} services.`);
            return true;
        } catch (e) {
            this.log(`❌ Init Exception: ${e.message}`);
            return false;
        }
    }

    async processService(service) {
        await sleep(2000, 4000);
        this.log(`>>> Processing Service ID: ${service.id}`);

        try {
            const manageRes = await this.request('GET', `/service/${service.id}/manage`);
            const $ = cheerio.load(manageRes.data);
            const formToken = $('input[name="_token"]').val();

            this.log(`📅 Submitting Renewal (${RENEW_DAYS} days)...`);
            await sleep(1000, 2000);

            const params = new URLSearchParams();
            params.append('_token', formToken);
            params.append('days', RENEW_DAYS);

            const res = await this.request('POST', `/service/${service.id}/renew`, params, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': `https://dash.hidencloud.com/service/${service.id}/manage`
            });

            if (res.finalUrl && res.finalUrl.includes('/invoice/')) {
                this.log(`⚡️ Renewed. Proceeding to payment...`);
                await this.performPayFromHtml(res.data, res.finalUrl);
            } else {
                this.log('⚠️ No redirect to invoice. Checking list...');
                await this.checkAndPayInvoices(service.id);
            }

        } catch (e) {
            this.log(`❌ Process Exception: ${e.message}`);
        }
    }

    async checkAndPayInvoices(serviceId) {
        await sleep(2000, 3000);
        try {
            const res = await this.request('GET', `/service/${serviceId}/invoices?where=unpaid`);
            const $ = cheerio.load(res.data);

            const invoiceLinks = [];
            $('a[href*="/invoice/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && !href.includes('download')) invoiceLinks.push(href);
            });

            const uniqueInvoices = [...new Set(invoiceLinks)];
            if (uniqueInvoices.length === 0) {
                this.log(`✅ No unpaid invoices.`);
                return;
            }

            for (const url of uniqueInvoices) {
                await this.paySingleInvoice(url);
                await sleep(3000, 5000);
            }
        } catch (e) {
            this.log(`❌ Check Invoices Error: ${e.message}`);
        }
    }

    async paySingleInvoice(url) {
        try {
            this.log(`📄 Open Invoice: ${url}`);
            const res = await this.request('GET', url);
            await this.performPayFromHtml(res.data, url);
        } catch (e) {
            this.log(`❌ Access Failed: ${e.message}`);
        }
    }

    async performPayFromHtml(html, currentUrl) {
        const $ = cheerio.load(html);

        let targetForm = null;
        let targetAction = '';

        $('form').each((i, form) => {
            const btnText = $(form).find('button').text().trim().toLowerCase();
            const action = $(form).attr('action');
            if (btnText.includes('pay') && action && !action.includes('balance/add')) {
                targetForm = $(form);
                targetAction = action;
                return false;
            }
        });

        if (!targetForm) {
            this.log(`⚪ No payment form found (Already paid?)`);
            return;
        }

        const payParams = new URLSearchParams();
        targetForm.find('input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).val();
            if (name) payParams.append(name, value || '');
        });

        this.log(`💳 Submitting Payment...`);

        try {
            const payRes = await this.request('POST', targetAction, payParams, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': currentUrl
            });

            if (payRes.status === 200) {
                this.log(`✅ Payment Successful!`);
            } else {
                this.log(`⚠️ Payment Status: ${payRes.status}`);
            }
        } catch (e) {
            this.log(`❌ Payment Failed: ${e.message}`);
        }
    }
}


// --- Playwright / Main Logic (from login.js / action_renew.js) ---

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome is already open.');
        return;
    }
    console.log(`Launching Chrome...`);
    // Minimal args for cloud/CI environment
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu',
        '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'
    ];
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('Waiting for Chrome...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome launch failed');
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) { console.error('Error parsing USERS_JSON:', e); }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> Found Turnstile in frame.');
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP Click sent.');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

async function handleVerification(page) {
    console.log('Checking verification...');
    for (let i = 0; i < 30; i++) {
        if (await page.getByRole('textbox', { name: 'Email or Username' }).isVisible()) {
            console.log('Login form detected.');
            return;
        }
        await attemptTurnstileCdp(page);
        await page.waitForTimeout(1000);
    }
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('No users found in USERS_JSON');
        process.exit(0);
    }

    await launchChrome();
    console.log(`Connecting to Chrome...`);
    let browser;
    try {
        browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    } catch (e) {
        console.error('Failed to connect to Chrome:', e);
        process.exit(1);
    }

    const context = browser.contexts()[0];
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== Processing User ${i + 1}: ${user.username} ===`);

        try {
            // 1. Login
            await page.goto('https://dash.hidencloud.com/auth/login');
            await handleVerification(page);
            await page.getByRole('textbox', { name: 'Email or Username' }).waitFor({ timeout: 20000 });

            console.log('Filling Credentials...');
            await page.getByRole('textbox', { name: 'Email or Username' }).click();
            await page.getByRole('textbox', { name: 'Email or Username' }).fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).click();
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);

            // Turnstile after password?
            console.log('Checking post-password verification...');
            for (let j = 0; j < 5; j++) {
                if (await attemptTurnstileCdp(page)) {
                    await page.waitForTimeout(2000);
                }
                await page.waitForTimeout(500);
            }

            // Setup Request Listener to capture headers
            let dashboardCookie = '';
            const requestListener = (request) => {
                if (request.url() === 'https://dash.hidencloud.com/dashboard') {
                    const headers = request.headers();
                    if (headers['cookie']) {
                        console.log('✅ Captured cookie from /dashboard request headers.');
                        dashboardCookie = headers['cookie'];
                    }
                }
            };
            page.on('request', requestListener);

            console.log('Clicking Sign In...');
            await page.getByRole('button', { name: 'Sign in to your account' }).click();

            try {
                await page.waitForURL('**/dashboard', { timeout: 30000 });
                console.log('Login Successful (URL verified)!');
            } catch (e) {
                console.log('❌ Login Failed: Did not redirect to dashboard within time limit.');

                // Check specific errors
                if (await page.getByText('Incorrect password').isVisible()) {
                    console.error('Error: Incorrect password.');
                }

                await page.screenshot({ path: `login_failed_${i}.png` });
                console.log(`Screenshot saved to login_failed_${i}.png`);

                // Stop listener and skip this user
                page.off('request', requestListener);
                continue;
            }

            // Remove listener
            page.off('request', requestListener);

            // 2. Validate Cookies
            if (!dashboardCookie) {
                console.warn('⚠️ Warning: Dashboard loaded but captured no cookie header. Trying fallback...');
                const allCookies = await context.cookies();
                const relevantCookies = allCookies.filter(c => c.domain.includes('hidencloud.com'));
                dashboardCookie = relevantCookies.map(c => `${c.name}=${c.value}`).join('; ');
            }

            const cookieStr = dashboardCookie;

            // PRINT COOKIE (User Requirement)
            console.log(`[User ${i + 1}] Cookie: ${cookieStr}`);

            if (!cookieStr) {
                console.error('❌ Failed to obtain cookies. Skipping renewal.');
                continue;
            }

            // 3. Run Renewal Logic (Directly)
            console.log(`Starting Renewal for User ${i + 1}...`);
            const bot = new HidenCloudBot(cookieStr, `User${i + 1}`);

            // Re-verify login via bot (redundant but good for class logic initialization)
            const initSuccess = await bot.init();
            if (initSuccess) {
                for (const svc of bot.services) {
                    await bot.processService(svc);
                }
            } else {
                console.error('Bot init failed even after fresh login.');
            }

            // Cleanup
            await context.clearCookies();

        } catch (err) {
            console.error(`Error processing user ${i}:`, err);
            await page.screenshot({ path: `error_${i}.png` });
        }
    }

    try { if (browser) await browser.close(); } catch (e) { }
    console.log('Done.');
    process.exit(0);
})();
