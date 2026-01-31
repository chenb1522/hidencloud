/*
HidenCloud 本地自动续期脚本
用途: 从本地 cookie.json 读取 cookie{x} 字段，对用户进行自动续期
运行方式: node local_renew.js
*/

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// 配置
const RENEW_DAYS = 10;  // 续期天数
const COOKIE_FILE = path.join(__dirname, 'cookie.json');  // Cookie 文件路径
const CACHE_FILE = path.join(__dirname, 'hiden_cookies_cache.json');  // 缓存文件路径

const sleep = (min = 3000, max = 8000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

// 本地缓存管理
const CacheManager = {
    load() {
        if (fs.existsSync(CACHE_FILE)) {
            try {
                return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            } catch (e) {
                console.log('📁 读取缓存文件失败，将重新创建');
            }
        }
        return {};
    },
    save(data) {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    },
    get(cookieKey) {
        const data = this.load();
        return data[cookieKey] || null;
    },
    update(cookieKey, cookieStr) {
        const data = this.load();
        data[cookieKey] = cookieStr;
        this.save(data);
        console.log(`💾 [${cookieKey}] 最新 Cookie 已保存到本地缓存`);
    }
};

class HidenCloudBot {
    constructor(cookieStr, cookieKey) {
        this.cookieKey = cookieKey;
        this.originalCookie = cookieStr;
        this.cookieData = {};
        this.logMsg = [];

        // 优先尝试读取缓存
        const cachedCookie = CacheManager.get(cookieKey);
        if (cachedCookie) {
            console.log(`[${cookieKey}] 🔄 发现本地缓存 Cookie，优先使用...`);
            this.parseCookieStr(cachedCookie);
        } else {
            console.log(`[${cookieKey}] 📝 使用 cookie.json 中的 Cookie...`);
            this.parseCookieStr(cookieStr);
        }

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
            // 每次更新 Cookie 都保存到本地
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
                    this.log(`🔄 重定向 -> ${location}`);
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
        this.log('🔍 正在验证登录状态...');
        try {
            const res = await this.request('GET', '/dashboard');

            // 检查失效
            if (res.headers.location && res.headers.location.includes('/login')) {
                this.log('❌ 当前 Cookie 已失效');
                return false;
            }

            const $ = cheerio.load(res.data);
            this.extractTokens($);

            // 解析服务列表
            $('a[href*="/service/"]').each((i, el) => {
                const href = $(el).attr('href');
                const match = href.match(/\/service\/(\d+)\/manage/);
                if (match) {
                    this.services.push({ id: match[1], url: href });
                }
            });
            this.services = this.services.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

            this.log(`✅ 登录成功，发现 ${this.services.length} 个服务`);
            return true;
        } catch (e) {
            this.log(`❌ 初始化异常: ${e.message}`);
            return false;
        }
    }

    // 重置为原始 Cookie
    resetToOriginal() {
        this.cookieData = {};
        this.parseCookieStr(this.originalCookie);
        console.log(`[${this.cookieKey}] 🔄 切换回 cookie.json 原始 Cookie 重试...`);
    }

    async processService(service) {
        await sleep(2000, 4000);
        this.log(`>>> 处理服务 ID: ${service.id}`);

        try {
            const manageRes = await this.request('GET', `/service/${service.id}/manage`);
            const $ = cheerio.load(manageRes.data);
            const formToken = $('input[name="_token"]').val();

            this.log(`📅 提交续期 (${RENEW_DAYS}天)...`);
            await sleep(1000, 2000);

            const params = new URLSearchParams();
            params.append('_token', formToken);
            params.append('days', RENEW_DAYS);

            const res = await this.request('POST', `/service/${service.id}/renew`, params, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': `https://dash.hidencloud.com/service/${service.id}/manage`
            });

            if (res.finalUrl && res.finalUrl.includes('/invoice/')) {
                this.log(`⚡️ 续期成功，前往支付`);
                await this.performPayFromHtml(res.data, res.finalUrl);
            } else {
                this.log('⚠️ 续期后未跳转，检查账单列表...');
                await this.checkAndPayInvoices(service.id);
            }

        } catch (e) {
            this.log(`❌ 处理异常: ${e.message}`);
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
                this.log(`✅ 无未支付账单`);
                return;
            }

            for (const url of uniqueInvoices) {
                await this.paySingleInvoice(url);
                await sleep(3000, 5000);
            }
        } catch (e) {
            this.log(`❌ 查账单出错: ${e.message}`);
        }
    }

    async paySingleInvoice(url) {
        try {
            this.log(`📄 打开账单: ${url}`);
            const res = await this.request('GET', url);
            await this.performPayFromHtml(res.data, url);
        } catch (e) {
            this.log(`❌ 访问失败: ${e.message}`);
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
            this.log(`⚪ 页面未找到支付表单 (可能已支付)`);
            return;
        }

        const payParams = new URLSearchParams();
        targetForm.find('input').each((i, el) => {
            const name = $(el).attr('name');
            const value = $(el).val();
            if (name) payParams.append(name, value || '');
        });

        this.log(`💳 提交支付...`);

        try {
            const payRes = await this.request('POST', targetAction, payParams, {
                'X-CSRF-TOKEN': this.csrfToken,
                'Referer': currentUrl
            });

            if (payRes.status === 200) {
                this.log(`✅ 支付成功！`);
            } else {
                this.log(`⚠️ 支付响应: ${payRes.status}`);
            }
        } catch (e) {
            this.log(`❌ 支付失败: ${e.message}`);
        }
    }

    getSummary() {
        return {
            cookieKey: this.cookieKey,
            success: this.services.length > 0,
            serviceCount: this.services.length,
            logs: this.logMsg
        };
    }
}

// 主函数
(async () => {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   HidenCloud 自动续期脚本 v3.0           ║');
    console.log('╚════════════════════════════════════════════╝\n');

    let cookieData = {};
    let isCloudMode = false;

    // 优先从环境变量读取（云端模式）
    const envCookies = {};
    for (let i = 1; i <= 10; i++) {
        const envKey = `COOKIE${i}`;
        const envValue = process.env[envKey];
        if (envValue && envValue.trim()) {
            envCookies[`cookie${i}`] = envValue.trim();
        }
    }

    if (Object.keys(envCookies).length > 0) {
        console.log('☁️  检测到环境变量配置，使用云端模式\n');
        cookieData = envCookies;
        isCloudMode = true;
    } else {
        // 本地模式：从 cookie.json 读取
        console.log('💻 使用本地文件模式\n');

        if (!fs.existsSync(COOKIE_FILE)) {
            console.log(`❌ 未找到 ${COOKIE_FILE} 文件`);
            console.log(`💡 请在同目录下创建 cookie.json 文件，格式如下：`);
            console.log(`{
    "cookie1": "your_cookie_string_here",
    "cookie2": "your_cookie_string_here"
}`);
            console.log('\n或者设置环境变量 COOKIE1, COOKIE2...');
            return;
        }

        try {
            cookieData = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
        } catch (e) {
            console.log(`❌ 读取 cookie.json 失败: ${e.message}`);
            return;
        }
    }

    // 过滤出有效的 cookie (cookie1, cookie2, ...)
    const cookies = Object.keys(cookieData)
        .filter(key => key.startsWith('cookie') && cookieData[key] && cookieData[key].trim())
        .sort();

    if (cookies.length === 0) {
        console.log('❌ 没有找到有效的 Cookie 配置');
        console.log('💡 请确保字段名为 cookie1, cookie2... 且值不为空');
        return;
    }

    console.log(`📋 共找到 ${cookies.length} 个账号${isCloudMode ? ' (云端模式)' : ' (本地模式)'}\n`);

    const summaries = [];

    for (let i = 0; i < cookies.length; i++) {
        const cookieKey = cookies[i];
        const cookieStr = cookieData[cookieKey];

        console.log(`\n${'='.repeat(50)}`);
        console.log(`开始处理: ${cookieKey} (${i + 1}/${cookies.length})`);
        console.log('='.repeat(50));

        const bot = new HidenCloudBot(cookieStr, cookieKey);

        // 第一次尝试（可能用的是缓存）
        let success = await bot.init();

        // 如果失败，且当前用的是缓存，则回退到原始 cookie 重试
        if (!success && CacheManager.get(cookieKey)) {
            bot.resetToOriginal();
            success = await bot.init();
        }

        if (success) {
            for (const svc of bot.services) {
                await bot.processService(svc);
            }
        }

        summaries.push(bot.getSummary());

        if (i < cookies.length - 1) {
            console.log('\n⏳ 等待 5-10 秒后处理下一个账号...');
            await sleep(5000, 10000);
        }
    }

    // 输出总结
    console.log('\n\n╔════════════════════════════════════════════╗');
    console.log('║              续期结果汇总                  ║');
    console.log('╚════════════════════════════════════════════╝\n');

    summaries.forEach((summary, idx) => {
        console.log(`📊 ${summary.cookieKey}:`);
        if (summary.success) {
            console.log(`   ✅ 成功续期 ${summary.serviceCount} 个服务`);
        } else {
            console.log(`   ❌ 登录失败，请检查 Cookie 是否过期`);
        }
    });

    console.log('\n✨ 脚本执行完毕！');
})();
