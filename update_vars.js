/*
GitHub 仓库变量更新脚本
用途: 读取缓存的最新 Cookie 并通过 GitHub API 更新到仓库变量
环境变量: GITHUB_TOKEN, GITHUB_REPOSITORY
*/

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, 'hiden_cookies_cache.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // format: owner/repo

console.log('╔════════════════════════════════════════════╗');
console.log('║     GitHub 仓库变量更新工具 v1.0         ║');
console.log('╚════════════════════════════════════════════╝\n');

// 验证环境变量
if (!GITHUB_TOKEN) {
    console.log('❌ 错误: 未设置 GITHUB_TOKEN 环境变量');
    console.log('💡 请在 GitHub Actions 中设置 Secret: ACTION_VARS_TOKEN');
    process.exit(1);
}

if (!GITHUB_REPOSITORY) {
    console.log('❌ 错误: 未设置 GITHUB_REPOSITORY 环境变量');
    console.log('💡 格式: owner/repo');
    process.exit(1);
}

// 读取缓存文件
if (!fs.existsSync(CACHE_FILE)) {
    console.log('⚠️  未找到缓存文件，跳过更新');
    console.log('💡 缓存文件会在首次运行续期脚本后生成');
    process.exit(0);
}

let cacheData = {};
try {
    cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`📁 成功读取缓存文件: ${Object.keys(cacheData).length} 个条目\n`);
} catch (e) {
    console.log(`❌ 读取缓存文件失败: ${e.message}`);
    process.exit(1);
}

// GitHub API 请求封装
function githubApiRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            port: 443,
            path: path,
            method: method,
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'HidenCloud-Renew-Bot'
            }
        };

        if (data) {
            const jsonData = JSON.stringify(data);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(jsonData);
        }

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ statusCode: res.statusCode, body: body ? JSON.parse(body) : null });
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                }
            });
        });

        req.on('error', reject);

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

// 获取现有变量列表
async function getExistingVariables() {
    const path = `/repos/${GITHUB_REPOSITORY}/actions/variables`;
    try {
        const result = await githubApiRequest('GET', path);
        return result.body.variables || [];
    } catch (e) {
        console.log(`⚠️  获取现有变量失败: ${e.message}`);
        return [];
    }
}

// 创建新变量
async function createVariable(name, value) {
    const path = `/repos/${GITHUB_REPOSITORY}/actions/variables`;
    const data = { name, value };

    try {
        await githubApiRequest('POST', path, data);
        console.log(`  ✅ 创建变量: ${name}`);
        return true;
    } catch (e) {
        console.log(`  ❌ 创建失败 (${name}): ${e.message}`);
        return false;
    }
}

// 更新现有变量
async function updateVariable(name, value) {
    const path = `/repos/${GITHUB_REPOSITORY}/actions/variables/${name}`;
    const data = { value };

    try {
        await githubApiRequest('PATCH', path, data);
        console.log(`  ✅ 更新变量: ${name}`);
        return true;
    } catch (e) {
        console.log(`  ❌ 更新失败 (${name}): ${e.message}`);
        return false;
    }
}

// 主流程
(async () => {
    try {
        // 获取现有变量
        console.log('🔍 正在获取现有仓库变量...');
        const existingVars = await getExistingVariables();
        const existingVarNames = new Set(existingVars.map(v => v.name));
        console.log(`📊 发现 ${existingVars.length} 个现有变量\n`);

        // 准备要更新的变量
        const updates = [];
        for (let i = 0; i < 10; i++) { // 支持最多 10 个账号
            const cookieKey = `cookie${i + 1}`;
            const varName = `COOKIE${i + 1}`;

            if (cacheData[cookieKey]) {
                updates.push({
                    name: varName,
                    value: cacheData[cookieKey],
                    exists: existingVarNames.has(varName)
                });
            }
        }

        if (updates.length === 0) {
            console.log('⚠️  缓存中没有有效的 Cookie 数据');
            process.exit(0);
        }

        console.log(`📝 准备更新 ${updates.length} 个变量\n`);
        console.log('─'.repeat(50));

        // 执行更新
        let successCount = 0;
        for (const update of updates) {
            const action = update.exists ? '更新' : '创建';
            console.log(`\n${action} ${update.name}...`);

            const success = update.exists
                ? await updateVariable(update.name, update.value)
                : await createVariable(update.name, update.value);

            if (success) successCount++;

            // 避免触发速率限制
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('\n' + '─'.repeat(50));
        console.log(`\n✨ 完成！成功 ${successCount}/${updates.length} 个变量更新`);

        if (successCount < updates.length) {
            console.log('\n⚠️  部分变量更新失败，请检查:');
            console.log('  1. ACTION_VARS_TOKEN 是否有效');
            console.log('  2. Token 是否有 Variables (Read and write) 权限');
            console.log('  3. 仓库名称是否正确');
            process.exit(1);
        }

    } catch (e) {
        console.log(`\n❌ 发生错误: ${e.message}`);
        process.exit(1);
    }
})();
