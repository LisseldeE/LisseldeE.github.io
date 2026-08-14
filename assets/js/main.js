// Wait for i18n system to be ready
(function() {
    if (typeof window.applyI18n !== 'function') {
        console.warn('i18n.js not loaded before main.js');
    }
})();

// ========== 会话检测：关闭页面重新加入时强制刷新 ==========
(function() {
    const SESSION_KEY = 'portfolio_session_active';

    // 检查是否是新会话（关闭页面后重新打开）
    if (!sessionStorage.getItem(SESSION_KEY)) {
        // 新会话，清除所有 changelog 缓存
        console.log('新会话检测到，清除旧缓存...');
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('changelog_')) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        console.log(`已清除 ${keysToRemove.length} 个缓存项`);

        // 标记会话为活跃
        sessionStorage.setItem(SESSION_KEY, 'true');
    }
})();

// ========== CHANGELOG 解析和获取工具 ==========
window.ChangelogParser = {
    /**
     * 解析 CHANGELOG.md 内容
     * @param {string} markdown - CHANGELOG.md 的原始内容
     * @returns {Object} 解析后的版本数据
     */
    parse(markdown) {
        const lines = markdown.split('\n');
        const versions = [];
        let currentVersion = null;
        let currentChange = null;

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            // 版本标题: ## 2026.6.29 R6
            const versionMatch = line.match(/^##\s+(\d{4}\.\d{1,2}\.\d{1,2})\s+R(\d+)/);
            if (versionMatch) {
                if (currentVersion) {
                    versions.push(currentVersion);
                }
                currentVersion = {
                    version: `R${versionMatch[2]}`,
                    date: versionMatch[1],
                    tag: versions.length === 0 ? '最新' : '',
                    changes: []
                };
                currentChange = null;
                continue;
            }

            // 更新号: ### #07 或 ### #06 发布版本v6.6.0.0
            const changeMatch = line.match(/^###\s+#(\d+(?:\.\d+)?)(?:\s+(.+))?/);
            if (changeMatch && currentVersion) {
                currentChange = {
                    section: `#${changeMatch[1]}`,
                    note: changeMatch[2] || ''
                };
                continue;
            }

            // 更新内容: - 关键词：内容
            const itemMatch = line.match(/^- (新增|优化|修复|更新|修改|添加)：(.+)/);
            if (itemMatch && currentVersion) {
                const typeMap = {
                    '新增': 'feature',
                    '优化': 'improvement',
                    '修复': 'fix',
                    '更新': 'update',
                    '修改': 'improvement',
                    '添加': 'feature'
                };
                
                currentVersion.changes.push({
                    type: typeMap[itemMatch[1]] || 'other',
                    text: itemMatch[2],
                    section: currentChange ? currentChange.section : '#00'
                });
            }
        }

        // 添加最后一个版本
        if (currentVersion) {
            versions.push(currentVersion);
        }

        return { versions };
    },

    /**
     * 从远程获取 CHANGELOG.md
     * @param {string} project - 项目名称
     * @param {string} url - GitHub raw URL
     * @returns {Promise<Object>} 解析后的数据
     */
    async fetch(project, url) {
        // 检查缓存（仅作为降级使用）
        const cacheKey = `changelog_${project}`;
        const cacheTimeKey = `changelog_${project}_time`;
        const cached = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        // 使用 CORS 代理获取，添加时间戳绕过缓存
        const timestamp = Date.now();
        const urlWithTimestamp = `${url}?t=${timestamp}`;
        const corsProxies = [
            // CORS代理（更稳定）
            `https://corsproxy.io/?${encodeURIComponent(urlWithTimestamp)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(urlWithTimestamp)}`,
            // 直接访问GitHub（不稳定，放最后）
            urlWithTimestamp
        ];

        for (const proxyUrl of corsProxies) {
            try {
                console.log(`Trying ${proxyUrl}`);
                const response = await fetch(proxyUrl);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const markdown = await response.text();
                const data = this.parse(markdown);
                
                // 缓存数据（作为备用）
                localStorage.setItem(cacheKey, JSON.stringify(data));
                localStorage.setItem(cacheTimeKey, Date.now().toString());
                
                console.log(`Successfully fetched ${project} changelog`);
                return data;
            } catch (error) {
                console.error(`Proxy ${proxyUrl} failed:`, error);
                continue;
            }
        }

        // 所有代理都失败了，尝试使用缓存
        if (cached) {
            console.log(`Using cached data for ${project}`);
            try {
                return JSON.parse(cached);
            } catch (e) {
                console.error('Cache parse error:', e);
            }
        }

        throw new Error('所有代理都失败了，且无缓存数据');
    },

    /**
     * 获取项目更新数据（带降级处理）
     * @param {string} project - 项目名称
     * @param {string} url - GitHub raw URL
     * @returns {Promise<Object|null>} 数据或null
     */
    async getData(project, url) {
        try {
            const data = await this.fetch(project, url);
            return data;
        } catch (error) {
            console.error(`Failed to fetch changelog for ${project}:`, error);
            return null;
        }
    }
};

// ========== 命令解析器 ==========
const CommandParser = {
    /**
     * 解析 Markdown 中的 ## 命令 表格
     * @param {string} markdown - 原始 Markdown 文本
     * @returns {Object|null} 含有 commands 数组的对象
     */
    parse(markdown) {
        // 找到 ## 命令 / ## Commands 部分（兼容单/双换行）
        const headerPattern = window.getCurrentLang() === 'en'
            ? /## Commands\n+([\s\S]*?)(?=\n##|\n---|$)/
            : /## 命令\n+([\s\S]*?)(?=\n##|\n---|$)/;
        const cmdSection = markdown.match(headerPattern);
        if (!cmdSection) return null;

        const tableText = cmdSection[1];
        // 匹配表格行
        const rows = tableText.match(/^\|.*\|$/gm);
        if (!rows || rows.length < 3) return null;

        // 跳过表头（第1行）和分隔线（第2行）
        const dataRows = rows.slice(2);

        const commands = dataRows.map(row => {
            const cells = row.split('|').filter(cell => cell.trim());
            if (cells.length < 2) return null;

            const cmdCell = cells[0].trim();
            const descCell = cells[1].trim();

            // 提取命令：`nt u <port|url>`
            const cmdMatch = cmdCell.match(/`(.+?)`/);
            const command = cmdMatch ? cmdMatch[1] : cmdCell;

            // 说明中的反引号转为 <code> 标签
            const description = descCell.replace(/`(.+?)`/g, '<code>$1</code>');

            return { command, description };
        }).filter(Boolean);

        return { commands };
    },

    /**
     * 从远程获取 NT.md
     * @param {string} url - GitHub raw URL
     * @returns {Promise<Object>} 解析后的命令数据
     */
    async fetch(url) {
        const timestamp = Date.now();
        const urlWithTimestamp = `${url}?t=${timestamp}`;
        const corsProxies = [
            `https://corsproxy.io/?${encodeURIComponent(urlWithTimestamp)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(urlWithTimestamp)}`,
            urlWithTimestamp
        ];

        for (const proxyUrl of corsProxies) {
            try {
                const response = await fetch(proxyUrl);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const markdown = await response.text();
                const data = this.parse(markdown);
                if (data) {
                    return data;
                }
                throw new Error('无法解析命令表格');
            } catch (error) {
                console.log(`CommandParser proxy failed: ${proxyUrl}`, error);
            }
        }

        throw new Error('所有代理都失败了');
    },

    /**
     * 获取命令数据（带降级处理）
     * @param {string} url - GitHub raw URL
     * @returns {Promise<Object|null>} 数据或null
     */
    async getData(url) {
        try {
            return await this.fetch(url);
        } catch (error) {
            console.error('Failed to fetch commands:', error);
            return null;
        }
    }
};

function renderCommands(commands) {
    const container = document.getElementById('command-list-nexusterminal');
    if (!container) return;

    container.innerHTML = commands.map(cmd => `
        <div class="command-item">
            <span class="command-item-code">${cmd.command}</span>
            <span class="command-item-desc">${cmd.description}</span>
        </div>
    `).join('');
}

function showCommandError(container) {
    if (!container) container = document.getElementById('command-list-nexusterminal');
    if (!container) return;
    container.innerHTML = `
        <div class="command-list-error">
            <div>${window.t('error.commands')}</div>
            <div class="command-list-retry" onclick="retryFetchCommands()">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                </svg>
                <span>${window.t('error.retry')}</span>
            </div>
        </div>
    `;
}

async function loadCommands() {
    const container = document.getElementById('command-list-nexusterminal');
    if (!container) return;

    // 显示加载动画
    container.innerHTML = `
        <div class="command-list-loading">
            <div class="update-tree-scanner"></div>
        </div>
    `;

    const url = 'https://raw.githubusercontent.com/LisseldeE/Nexus-Terminal/main/NT.md';
    const data = await CommandParser.getData(url);

    if (data && data.commands && data.commands.length > 0) {
        renderCommands(data.commands);
    } else {
        showCommandError(container);
    }
}

async function retryFetchCommands() {
    const container = document.getElementById('command-list-nexusterminal');
    if (!container) return;

    container.innerHTML = `
        <div class="command-list-loading">
            <div class="update-tree-scanner"></div>
        </div>
    `;

    const url = 'https://raw.githubusercontent.com/LisseldeE/Nexus-Terminal/main/NT.md';
    const data = await CommandParser.getData(url);

    if (data && data.commands && data.commands.length > 0) {
        renderCommands(data.commands);
    } else {
        showCommandError(container);
    }
}

// ========== 快速导航解析器 ==========
const QuickNavParser = {
    /**
     * 解析 Markdown 中的 ### 快速导航 列表
     */
    parse(markdown) {
        const headerPattern = window.getCurrentLang() === 'en'
            ? /### Quick Navigation\n\n?([\s\S]*?)(?=\n###|\n##|\n---|$)/
            : /### 快速导航\n\n?([\s\S]*?)(?=\n###|\n##|\n---|$)/;
        const section = markdown.match(headerPattern);
        if (!section) return null;

        const listText = section[1];
        // 去掉开头的空行
        const cleanListText = listText.replace(/^\n+/, '');
        // 匹配所有列表行：- xxx 或     - xxx
        const lines = cleanListText.split('\n').filter(line => /^\s*- /.test(line));
        if (lines.length === 0) return null;

        // 解析每行：计算缩进深度，提取标签和命令
        const items = lines.map(line => {
            const indent = line.search(/\S/); // 首非空字符位置
            const depth = Math.floor(indent / 4); // 每4空格=1级
            const content = line.replace(/^\s*- /, '');
            // 提取括号中的命令，如 "隧道 (u / url)" -> label="隧道", command="u / url"
            const cmdMatch = content.match(/^(.*?)\s*\((.+?)\)\s*$/);
            if (cmdMatch) {
                return { depth, label: cmdMatch[1].trim(), command: cmdMatch[2] };
            }
            return { depth, label: content, command: null };
        });

        // 构建树结构
        function buildTree(items, startIdx, parentDepth) {
            const children = [];
            let i = startIdx;
            while (i < items.length) {
                const item = items[i];
                if (item.depth <= parentDepth) break;
                if (item.depth === parentDepth + 1) {
                    const subTree = buildTree(items, i + 1, item.depth);
                    children.push({
                        label: item.label,
                        command: item.command,
                        children: subTree.children
                    });
                    i = subTree.nextIndex;
                } else {
                    i++;
                }
            }
            return { children, nextIndex: i };
        }

        const tree = buildTree(items, 0, -1);
        return tree.children.length > 0 ? { tree: tree.children } : null;
    },

    /**
     * 渲染树为 HTML
     */
    render(tree) {
        if (!tree || tree.length === 0) return '';

        // Separate categories with children from leaf items
        const withChildren = tree.filter(item => item.children && item.children.length > 0);
        const leafs = tree.filter(item => !item.children || item.children.length === 0);

        let html = '<div class="quick-nav-rows">';

        withChildren.forEach(cat => {
            html += '<div class="quick-nav-row">';
            html += `<span class="quick-nav-cat">${cat.label}</span>`;
            html += '<div class="quick-nav-items">';
            cat.children.forEach((sub, si) => {
                const cmd = sub.command ? `<span class="quick-nav-cmd">${sub.command}</span>` : '';
                if (si > 0) html += '<span class="quick-nav-entry-sep">·</span>';
                html += `<span class="quick-nav-entry">${sub.label}${cmd}</span>`;
            });
            html += '</div></div>';
        });

        // Leaf items grouped into one row
        if (leafs.length > 0) {
            html += '<div class="quick-nav-row">';
            html += '<span class="quick-nav-cat">其他</span>';
            html += '<div class="quick-nav-items">';
            leafs.forEach((leaf, li) => {
                const cmd = leaf.command ? `<span class="quick-nav-cmd">${leaf.command}</span>` : '';
                if (li > 0) html += '<span class="quick-nav-entry-sep">·</span>';
                html += `<span class="quick-nav-entry">${leaf.label}${cmd}</span>`;
            });
            html += '</div></div>';
        }

        html += '</div>';
        return html;
    },

    async fetch(url) {
        const timestamp = Date.now();
        const urlWithTimestamp = `${url}?t=${timestamp}`;
        const corsProxies = [
            `https://corsproxy.io/?${encodeURIComponent(urlWithTimestamp)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(urlWithTimestamp)}`,
            urlWithTimestamp
        ];

        for (const proxyUrl of corsProxies) {
            try {
                const response = await fetch(proxyUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const markdown = await response.text();
                const data = this.parse(markdown);
                if (data) return data;
                throw new Error('无法解析快速导航');
            } catch (error) {
                console.log(`QuickNavParser proxy failed: ${proxyUrl}`, error);
            }
        }
        throw new Error('所有代理都失败了');
    },

    async getData(url) {
        try {
            return await this.fetch(url);
        } catch (error) {
            console.error('Failed to fetch quick nav:', error);
            return null;
        }
    }
};

function renderQuickNav(tree) {
    const container = document.getElementById('quick-nav-nexusterminal');
    if (!container) return;
    container.innerHTML = QuickNavParser.render(tree);
}

function showQuickNavError() {
    const container = document.getElementById('quick-nav-nexusterminal');
    if (!container) return;
    container.innerHTML = `
        <div class="quick-nav-error">
            <div>${window.t('error.quicknav')}</div>
            <div class="command-list-retry" onclick="retryFetchQuickNav()">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                </svg>
                <span>${window.t('error.retry')}</span>
            </div>
        </div>
    `;
}

async function loadQuickNav() {
    const container = document.getElementById('quick-nav-nexusterminal');
    if (!container) return;

    container.innerHTML = `
        <div class="quick-nav-loading">
            <div class="update-tree-scanner"></div>
        </div>
    `;

    const lang = window.getCurrentLang();
    const mdFile = lang === 'en' ? 'README_EN.md' : 'README.md';
    const url = `https://raw.githubusercontent.com/LisseldeE/Nexus-Terminal/main/${mdFile}`;
    const data = await QuickNavParser.getData(url);

    if (data && data.tree && data.tree.length > 0) {
        renderQuickNav(data.tree);
    } else {
        showQuickNavError();
    }
}

async function retryFetchQuickNav() {
    const container = document.getElementById('quick-nav-nexusterminal');
    if (!container) return;

    container.innerHTML = `
        <div class="quick-nav-loading">
            <div class="update-tree-scanner"></div>
        </div>
    `;

    const lang = window.getCurrentLang();
    const mdFile = lang === 'en' ? 'README_EN.md' : 'README.md';
    const url = `https://raw.githubusercontent.com/LisseldeE/Nexus-Terminal/main/${mdFile}`;
    const data = await QuickNavParser.getData(url);

    if (data && data.tree && data.tree.length > 0) {
        renderQuickNav(data.tree);
    } else {
        showQuickNavError();
    }
}

// 重新获取更新日志
async function retryFetchChangelog(project) {
    const urls = {
        'lansyncbox': 'https://raw.githubusercontent.com/LisseldeE/LANSyncBox/main/CHANGELOG.md',
        'syncgui': 'https://raw.githubusercontent.com/LisseldeE/SyncGUI/main/CHANGELOG.md',
        'tokenpeek': 'https://raw.githubusercontent.com/LisseldeE/TokenPeek/main/CHANGELOG.md',
        'deskhelper': 'https://raw.githubusercontent.com/LisseldeE/DeskHelperGUI/main/CHANGELOG.md',
        'iconformsix': 'https://raw.githubusercontent.com/LisseldeE/IconForMsix/main/CHANGELOG.md',
        'nexusterminal': 'https://raw.githubusercontent.com/LisseldeE/Nexus-Terminal/main/CHANGELOG.md'
    };

    const url = urls[project];
    if (!url) return;

    // 清除该项目的缓存，确保获取最新数据
    const cacheKey = `changelog_${project}`;
    const cacheTimeKey = `changelog_${project}_time`;
    localStorage.removeItem(cacheKey);
    localStorage.removeItem(cacheTimeKey);
    console.log(`已清除 ${project} 的缓存`);

    // 显示加载动画
    const latestBuildEl = document.getElementById(`latest-build-${project}`);
    if (latestBuildEl) {
        latestBuildEl.innerHTML = `
            <div class="project-latest-build-loading">
                <div class="project-latest-build-spinner"></div>
                <span class="project-latest-build-loading-text">${window.t('loading.fetching')}</span>
            </div>
        `;
    }

    const container = document.getElementById(`update-container-${project}`);
    if (container) {
        container.innerHTML = `
            <div class="update-tree-loading">
                <div class="update-tree-scanner"></div>
            </div>
        `;
    }

    // 重新获取数据
    const data = await ChangelogParser.getData(project, url);
    
    if (data) {
        window.__UPDATE_TREE__ = window.__UPDATE_TREE__ || {};
        window.__UPDATE_TREE__[project] = data;
        renderLatestBuild(project, data);
        renderUpdateTree(project, data);
    } else {
        // 获取失败
        if (latestBuildEl) {
            latestBuildEl.innerHTML = `
                <span class="project-latest-build-label" style="color: var(--accent-blue); display: flex; align-items: center; gap: 0.375rem;">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                    ${window.t('error.retry')}
                </span>
            `;
            latestBuildEl.style.cursor = 'pointer';
            latestBuildEl.onclick = () => retryFetchChangelog(project);
        }
        
        if (container) {
            container.innerHTML = `
                <div class="update-tree-error">
                    <div>${window.t('error.fetch')}</div>
                    <div class="update-tree-retry" onclick="retryFetchChangelog('${project}')">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                        </svg>
                        <span>${window.t('error.retry')}</span>
                    </div>
                </div>
            `;
        }
    }
}

// 导航切换逻辑
const navItems = document.querySelectorAll('.nav-item, .nav-home');
const projectPages = document.querySelectorAll('.project-page');

// 小工具链接单独处理
const toolsLink = document.querySelector('.sidebar-link[data-project="tools"]');
if (toolsLink) {
    toolsLink.addEventListener('click', (e) => {
        e.preventDefault();
        const targetProject = 'tools';

        if (targetProject === currentProject) return;

        // 移动端：立即关闭侧边栏
        if (window.innerWidth <= 899) {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            if (sidebar && overlay) {
                sidebar.classList.remove('drawer-open');
                overlay.classList.remove('active');
                document.body.style.overflow = '';
            }
        }

        // 切换页面（与其他项目保持一致）
        const currentPage = document.getElementById(currentProject);
        const targetPage = document.getElementById(targetProject);

        currentPage.classList.add('exit-left');
        currentPage.classList.remove('active');

        // 等待退出动画完成后,再滚动到顶部并显示新页面
        setTimeout(() => {
            currentPage.classList.remove('exit-left');

            // 滚动到顶部
            const mainContent = document.querySelector('.main-content');
            mainContent.scrollTop = 0;

            // 显示新页面
            targetPage.classList.add('active');

            currentProject = targetProject;

            // 更新 URL hash
            updateHash(targetProject);
        }, 200);
    });
}

// 项目映射（数字ID -> 项目名称）
const projectIdMap = {
    '0': 'home',
    '1': 'lansyncbox',
    '2': 'syncgui',
    '3': 'tokenpeek',
    '4': 'deskhelper',
    '5': 'iconformsix',
    '6': 'nexusterminal',
    'X': 'tools'
};

// 项目名称映射（项目名称 -> 数字ID）
const projectNameMap = {
    'home': '0',
    'lansyncbox': '1',
    'syncgui': '2',
    'tokenpeek': '3',
    'deskhelper': '4',
    'iconformsix': '5',
    'nexusterminal': '6',
    'tools': 'X'
};

let currentProject = 'home';

// 根据 URL hash 切换项目
function switchProjectByHash() {
    const hash = window.location.hash.slice(1); // 移除 # 符号
    if (hash && projectIdMap[hash]) {
        const targetProject = projectIdMap[hash];
        if (targetProject !== currentProject) {
            const targetNav = document.querySelector(`[data-project="${targetProject}"]`);
            if (targetNav) {
                targetNav.click();
            }
        }
    }
}

// 切换项目时更新 URL hash
function updateHash(projectName) {
    const hash = projectNameMap[projectName];
    if (hash) {
        window.history.replaceState(null, '', window.location.pathname + `#${hash}`);
    }
}

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const targetProject = item.dataset.project;

        if (targetProject === currentProject) return;

        // 更新导航状态
        document.querySelectorAll('.nav-item, .nav-home').forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');

        // 切换页面
        const currentPage = document.getElementById(currentProject);
        const targetPage = document.getElementById(targetProject);

        currentPage.classList.add('exit-left');
        currentPage.classList.remove('active');

        // 等待退出动画完成后,再滚动到顶部并显示新页面
        setTimeout(() => {
            currentPage.classList.remove('exit-left');

            // 滚动到顶部
            const mainContent = document.querySelector('.main-content');
            mainContent.scrollTop = 0;

            // 显示新页面
            targetPage.classList.add('active');

            currentProject = targetProject;

            // 更新 URL hash
            updateHash(targetProject);
        }, 200);
    });
});

// 主页项目卡片点击事件
document.querySelectorAll('.home-project-card').forEach(card => {
    card.addEventListener('click', () => {
        const targetProject = card.dataset.project;
        const targetNav = document.querySelector(`[data-project="${targetProject}"]`);
        if (targetNav) {
            targetNav.click();
        }
    });
});

// 键盘导航
document.addEventListener('keydown', (e) => {
    const projectOrder = ['home', 'lansyncbox', 'syncgui', 'deskhelper', 'tokenpeek', 'iconformsix', 'nexusterminal'];
    const currentIndex = projectOrder.indexOf(currentProject);

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        const nextIndex = (currentIndex + 1) % projectOrder.length;
        const nextNav = document.querySelector(`[data-project="${projectOrder[nextIndex]}"]`);
        if (nextNav) nextNav.click();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        const prevIndex = (currentIndex - 1 + projectOrder.length) % projectOrder.length;
        const prevNav = document.querySelector(`[data-project="${projectOrder[prevIndex]}"]`);
        if (prevNav) prevNav.click();
    }
});

// ========== 移动端汉堡菜单切换 ==========
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebar = document.querySelector('.sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

function toggleMobileMenu(open) {
    const isOpen = sidebar.classList.toggle('drawer-open', open === undefined ? !sidebar.classList.contains('drawer-open') : open);
    if (sidebarOverlay) {
        sidebarOverlay.classList.toggle('active', isOpen);
    }
    document.body.style.overflow = isOpen ? 'hidden' : '';
}

if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileMenu();
    });
}

if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => toggleMobileMenu(false));
}

// 切换项目后自动关闭抽屉
navItems.forEach(item => {
    item.addEventListener('click', () => {
        if (window.innerWidth <= 899) {
            toggleMobileMenu(false);
        }
    });
});

// Escape 键关闭抽屉
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('drawer-open')) {
        toggleMobileMenu(false);
    }
});

// ========== 触摸滑动切换项目 ==========
let touchStartX = 0;
let touchStartY = 0;
let touchEndX = 0;
let touchEndY = 0;

document.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;
    handleSwipe();
}, { passive: true });

function handleSwipe() {
    // 抽屉打开时不触发滑动切换
    if (sidebar.classList.contains('drawer-open')) return;

    // Lightbox打开时不触发滑动切换
    const lightbox = document.getElementById('lightbox');
    if (lightbox && lightbox.classList.contains('active')) return;

    const diffX = touchStartX - touchEndX;
    const diffY = touchStartY - touchEndY;

    // 只在水平滑动幅度明显大于垂直时触发
    if (Math.abs(diffX) < Math.abs(diffY) * 0.8) return;
    if (Math.abs(diffX) < 50) return;

    const projectOrder = ['home', 'lansyncbox', 'syncgui', 'deskhelper', 'tokenpeek', 'iconformsix', 'nexusterminal'];
    const currentIndex = projectOrder.indexOf(currentProject);

    if (diffX > 0) {
        // 左滑 -> 下一个
        const nextIndex = (currentIndex + 1) % projectOrder.length;
        const nextNav = document.querySelector(`[data-project="${projectOrder[nextIndex]}"]`);
        if (nextNav) nextNav.click();
    } else {
        // 右滑 -> 上一个
        const prevIndex = (currentIndex - 1 + projectOrder.length) % projectOrder.length;
        const prevNav = document.querySelector(`[data-project="${projectOrder[prevIndex]}"]`);
        if (prevNav) prevNav.click();
    }
}

// ========== 更新树 - 大版本分组 + 折叠 ==========
const typeLabels = {
    'feature': '新增',
    'improvement': '优化',
    'fix': '修复',
    'update': '更新',
    'other': '其他'
};

function formatVersionShort(v) {
    // Version strings are already "RN" format like "R6", "R11"
    return v;
}

function getMajorVersion(v) {
    // Extract number from "R6" -> 6, "R11" -> 11
    const m = v.match(/R(\d+)/);
    return m ? parseInt(m[1]) : 0;
}

function toggleMajorGroup(headerEl) {
    const group = headerEl.closest('.update-major-group');
    const body = group.querySelector('.update-major-versions');
    const toggle = headerEl.querySelector('.update-major-toggle');
    const isCollapsed = group.classList.contains('collapsed');

    if (isCollapsed) {
        // 展开
        group.classList.remove('collapsed');
        body.style.maxHeight = body.scrollHeight + 'px';
        body.style.opacity = '1';
        toggle.textContent = '\u2212';
    } else {
        // 收起
        group.classList.add('collapsed');
        body.style.maxHeight = '0';
        body.style.opacity = '0';
        toggle.textContent = '+';
    }
}

function loadUpdateTree(projectId) {
    const container = document.getElementById(`update-container-${projectId}`);
    if (!container) return;

    const projectUrls = {
        'lansyncbox': 'https://raw.githubusercontent.com/LisseldeE/LANSyncBox/main/CHANGELOG.md',
        'syncgui': 'https://raw.githubusercontent.com/LisseldeE/SyncGUI/main/CHANGELOG.md',
        'tokenpeek': 'https://raw.githubusercontent.com/LisseldeE/TokenPeek/main/CHANGELOG.md',
        'deskhelper': 'https://raw.githubusercontent.com/LisseldeE/DeskHelperGUI/main/CHANGELOG.md',
        'iconformsix': 'https://raw.githubusercontent.com/LisseldeE/IconForMsix/main/CHANGELOG.md',
        'nexusterminal': 'https://raw.githubusercontent.com/LisseldeE/Nexus-Terminal/main/CHANGELOG.md'
    };

    const url = projectUrls[projectId];
    if (!url) return;

    // 检查数据是否已加载
    const data = (window.__UPDATE_TREE__ || {})[projectId];
    if (data && data.versions && data.versions.length > 0) {
        renderUpdateTree(projectId, data);
        return;
    }

    // 显示加载动画
    container.innerHTML = `
        <div class="update-tree-loading">
            <div class="update-tree-scanner"></div>
        </div>
    `;

    // 异步获取数据
    (async () => {
        const fetchedData = await ChangelogParser.getData(projectId, url);
        
        if (fetchedData) {
            window.__UPDATE_TREE__ = window.__UPDATE_TREE__ || {};
            window.__UPDATE_TREE__[projectId] = fetchedData;
            renderUpdateTree(projectId, fetchedData);
            renderLatestBuild(projectId, fetchedData);
        } else {
            // 获取失败
            container.innerHTML = `
                <div class="update-tree-error">
                    <div>${window.t('error.fetch')}</div>
                    <div class="update-tree-retry" onclick="retryFetchChangelog('${projectId}')">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                        </svg>
                        <span>${window.t('error.retry')}</span>
                    </div>
                </div>
            `;

            const latestBuildEl = document.getElementById(`latest-build-${projectId}`);
            if (latestBuildEl) {
                latestBuildEl.innerHTML = `
                    <span class="project-latest-build-label" style="color: var(--accent-blue); display: flex; align-items: center; gap: 0.375rem;">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                        </svg>
                        ${window.t('error.retry')}
                    </span>
                `;
                latestBuildEl.style.cursor = 'pointer';
                latestBuildEl.onclick = () => retryFetchChangelog(projectId);
            }
        }
    })();
}

function renderLatestBuild(projectId, data) {
    const latestBuildEl = document.getElementById(`latest-build-${projectId}`);
    if (!latestBuildEl) return;

    // 数据不存在或为空
    if (!data || !data.versions || data.versions.length === 0) {
        latestBuildEl.innerHTML = `
            <span class="project-latest-build-label" style="color: var(--accent-blue); display: flex; align-items: center; gap: 0.375rem;">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                </svg>
                ${window.t('error.retry')}
            </span>
        `;
        latestBuildEl.style.cursor = 'pointer';
        latestBuildEl.onclick = () => retryFetchChangelog(projectId);
        return;
    }

    const latestVersion = data.versions[0];
    let latestSection = '';
    if (latestVersion.changes && latestVersion.changes.length > 0) {
        const firstChangeWithSection = latestVersion.changes.find(c => c.section);
        if (firstChangeWithSection) {
            latestSection = firstChangeWithSection.section;
        }
    }

    const majorVersion = latestVersion.version;
    const buildLabel = latestSection ? `${majorVersion}${latestSection}` : majorVersion;

    latestBuildEl.innerHTML = `
        <span class="project-latest-build-label">${window.t('build.latest')}</span>
        <span class="project-latest-build-version">${buildLabel}</span>
    `;
    
    latestBuildEl.style.cursor = 'pointer';
    latestBuildEl.onclick = () => {
        const updateTreeEl = document.getElementById(`update-tree-${projectId}`);
        if (updateTreeEl) {
            updateTreeEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };
}

function renderUpdateTree(projectId, data) {
    const container = document.getElementById(`update-container-${projectId}`);
    const section = document.getElementById(`update-tree-${projectId}`);
    if (!container) return;

    // 更新项目头部的最新构建标签
    renderLatestBuild(projectId, data);

    section.classList.add('loading');

    // Group versions by major version number
    const groups = {};
    data.versions.forEach((v) => {
        const major = getMajorVersion(v.version);
        if (!groups[major]) groups[major] = [];
        groups[major].push(v);
    });

    // Sort groups descending by major
    const sortedMajors = Object.keys(groups).map(Number).sort((a, b) => b - a);
    const latestMajor = sortedMajors[0];

    let html = '';

    sortedMajors.forEach((major, gi) => {
        const versions = groups[major];
        const isLatestGroup = gi === 0;

        // 计算小版本（构建）数量：统计所有changes中有section的唯一section数量
        const allSections = new Set();
        versions.forEach(v => {
            if (v.changes) {
                v.changes.forEach(c => {
                    if (c.section) allSections.add(c.section);
                });
            }
        });
        const buildCount = allSections.size || 1;

        let headerTag = '';
        if (isLatestGroup) headerTag = window.t('updatetree.latest_major');

        // 获取最新构建版本号
        let latestBuildSection = '';
        if (versions.length > 0 && versions[0].changes) {
            const firstChangeWithSection = versions[0].changes.find(c => c.section);
            if (firstChangeWithSection) {
                latestBuildSection = firstChangeWithSection.section;
            }
        }

        html += `<div class="update-major-group${isLatestGroup ? '' : ' collapsed'}">`;

        // Group header
        html += `<div class="update-major-header" onclick="toggleMajorGroup(this)">`;
        html += `<span class="update-major-badge">R${major}</span>`;
        html += `<span class="update-major-label">${headerTag || buildCount + ' ' + window.t('updatetree.builds')}</span>`;
        html += `<span class="update-major-toggle">${isLatestGroup ? '\u2212' : '+'}</span>`;
        html += `</div>`;

        // Versions body
        html += `<div class="update-major-versions"${isLatestGroup ? ' style="max-height: 2000px;"' : ' style="max-height: 0; opacity: 0;"'}>`;

        versions.forEach((v, vi) => {
            const isLatest = gi === 0 && vi === 0;
            const nodeClass = isLatest ? 'update-node latest' : 'update-node';

            // 第一行显示：RX#0X（最新构建版本）
            const displayVersion = (vi === 0 && latestBuildSection) ? `R${major}${latestBuildSection}` : `R${major}`;

            html += `<div class="${nodeClass}">`;
            html += `<div class="update-node-header">`;
            html += `<span class="update-version-badge">${displayVersion}</span>`;
            html += `<span class="update-date">${v.date}</span>`;
            if (v.tag === '最新') {
                html += `<span class="update-tag latest-tag">最新</span>`;
            }
            html += `</div>`;

            if (v.changes && v.changes.length > 0) {
                // Check if any changes have section markers
                const hasSections = v.changes.some(c => c.section);
                
                if (hasSections) {
                    html += `<div class="update-sections">`;
                    let lastSection = '';
                    let rowOpen = false;
                    
                    v.changes.forEach((change, ci) => {
                        // Start new section row
                        if (change.section && change.section !== lastSection) {
                            if (rowOpen) {
                                html += `</div></div>`; // close body + row
                            }

                            html += `<div class="update-section-row">`;
                            html += `<div class="update-section-side">`;
                            html += `<span class="update-section-badge">${change.section}</span>`;
                            html += `</div>`;
                            html += `<div class="update-section-body">`;

                            rowOpen = true;
                            lastSection = change.section;

                            // 查找当前section内所有note类型的变更
                            const sectionNotes = v.changes.filter(c => c.section === change.section && c.type === 'note');
                            if (sectionNotes.length > 0) {
                                // 在内容列第一行显示note(独占一行)
                                sectionNotes.forEach(note => {
                                    html += `<div class="update-change-item" style="margin-bottom: 0.5rem;">`;
                                    html += `<span class="update-change-text" style="font-weight: 600; color: var(--text-primary);">${note.text}</span>`;
                                    html += `</div>`;
                                });
                            }

                            if (change.type === 'note') {
                                return;
                            }
                        }

                        // 跳过note类型的变更(已经在上面的section开始时显示了)
                        if (change.type === 'note') return;

                        const label = typeLabels[change.type] || change.type;
                        html += `<div class="update-change-item">`;
                        html += `<span class="update-change-type ${change.type}">${label}</span>`;
                        html += `<span class="update-change-text">${change.text}</span>`;
                        html += `</div>`;
                    });

                    if (rowOpen) {
                        html += `</div></div>`;
                    }
                    html += `</div>`; // close update-sections
                } else {
                    // No sections - render changes flat
                    html += `<div class="update-changes">`;
                    v.changes.forEach(change => {
                        if (change.type === 'note') return;
                        const label = typeLabels[change.type] || change.type;
                        html += `<div class="update-change-item">`;
                        html += `<span class="update-change-type ${change.type}">${label}</span>`;
                        html += `<span class="update-change-text">${change.text}</span>`;
                        html += `</div>`;
                    });
                    html += `</div>`;
                }
            }

            html += `</div>`;
        });
        
        html += `</div>`; // close update-major-versions
        html += `</div>`; // close update-major-group
    });

    container.innerHTML = html;
    section.classList.remove('loading');
}

// 初始加载当前激活项目的更新树
loadUpdateTree(currentProject);
loadCommands();
loadQuickNav();

// 切换项目时重新加载
document.querySelectorAll('.nav-item, .nav-home').forEach(item => {
    item.addEventListener('click', () => {
        const targetProject = item.dataset.project;
        setTimeout(() => loadUpdateTree(targetProject), 100);

        // 切换项目时重新加载命令列表
        setTimeout(() => loadCommands(), 100);
        setTimeout(() => loadQuickNav(), 100);

        // 重置图片列表到第一张
        const galleryMap = {
            'home': null,
            'lansyncbox': 'gallery-lansyncbox',
            'syncgui': 'gallery-syncgui',
            'deskhelpergui': 'gallery-deskhelper',
            'tokenpeek': 'gallery-tokenpeek',
            'iconformsix': 'gallery-iconformsix',
            'nexusterminal': 'gallery-nexusterminal'
        };
        if (galleryMap[targetProject]) {
            resetGallery(galleryMap[targetProject]);
        }
    });
});

// 键盘/触摸切换后补加载
document.addEventListener('keydown', () => {
    setTimeout(() => {
        const activePage = document.querySelector('.project-page.active');
        if (activePage) {
            loadUpdateTree(activePage.id);
            loadCommands();
            loadQuickNav();
            // 重置图片列表
            const galleryMap = {
                'home': null,
                'lansyncbox': 'gallery-lansyncbox',
                'syncgui': 'gallery-syncgui',
                'deskhelpergui': 'gallery-deskhelper',
                'tokenpeek': 'gallery-tokenpeek',
                'nexusterminal': 'gallery-nexusterminal'
            };
            if (galleryMap[activePage.id]) {
                resetGallery(galleryMap[activePage.id]);
            }
        }
    }, 150);
});

// 页面加载完成隐藏加载动画（只等待DOM，不等待图片）
document.addEventListener('DOMContentLoaded', () => {
    const pageLoader = document.getElementById('pageLoader');
    if (pageLoader) {
        pageLoader.classList.add('fade-out');
        setTimeout(() => {
            pageLoader.remove();

            // 页面加载完成后检查 URL hash
            // 如果没有 hash，设置默认 hash 为 #0（主页）
            if (!window.location.hash) {
                window.history.replaceState(null, '', window.location.pathname + '#0');
            } else {
                switchProjectByHash();
            }
        }, 400);
    }

    // ========== 语言切换器 ==========
    const langSwitcher = document.getElementById('langSwitcher');
    const langToggle = document.getElementById('langSwitcherToggle');

    if (langSwitcher && langToggle) {
        // 切换下拉菜单
        langToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            langSwitcher.classList.toggle('open');
        });

        // 点击外部关闭下拉
        document.addEventListener('click', (e) => {
            if (!langSwitcher.contains(e.target)) {
                langSwitcher.classList.remove('open');
            }
        });

        // 语言选项点击
        langSwitcher.querySelectorAll('.lang-option').forEach(option => {
            option.addEventListener('click', () => {
                const targetLang = option.getAttribute('data-lang');
                const currentLang = window.getCurrentLang();
                if (targetLang === currentLang) {
                    langSwitcher.classList.remove('open');
                    return;
                }

                // 保存语言偏好
                localStorage.setItem('site-lang', targetLang);

                // 保持当前 hash，跳转到对应语言目录
                const hash = window.location.hash || '#0';
                const targetPath = targetLang === 'en' ? '/en/' : '/zh-cn/';
                window.location.href = targetPath + hash;
            });
        });
    }
});

// 监听 hash 变化事件（支持浏览器前进/后退按钮）
window.addEventListener('hashchange', () => {
    switchProjectByHash();
});

// 图片展示切换逻辑
function initGallery(galleryId) {
    const gallery = document.getElementById(galleryId);
    if (!gallery) return;

    const thumbs = gallery.querySelectorAll('.gallery-thumb');
    const counter = gallery.querySelector('.gallery-counter');
    const caption = gallery.querySelector('.gallery-caption');

    const captions = ['LANSyncBox 界面截图', 'LANSyncBox 界面截图'];

    thumbs.forEach((thumb, index) => {
        thumb.addEventListener('click', () => {
            // 移除所有active
            thumbs.forEach(t => t.classList.remove('active'));
            thumb.classList.add('active');

            // 每次点击重新获取当前元素
            const currentImg = gallery.querySelector('.gallery-main-image.current');
            const nextImg = gallery.querySelector('.gallery-main-image.next');

            // 获取新图片src
            const imgSrc = thumb.querySelector('img').src;

            // 如果是当前图片，不切换
            if (currentImg.src === imgSrc) return;

            // 交叉淡入淡出
            nextImg.src = imgSrc;
            currentImg.classList.add('hidden');
            nextImg.classList.remove('hidden');

            // 动画完成后交换角色
            setTimeout(() => {
                currentImg.classList.remove('current');
                currentImg.classList.add('next', 'hidden');
                nextImg.classList.remove('next', 'hidden');
                nextImg.classList.add('current');
            }, 350);

            // 更新计数器和描述
            if (counter) counter.textContent = `${index + 1} / ${thumbs.length}`;
            if (caption) caption.textContent = captions[index] || '';
        });
    });
}

// 重置图片列表到第一张
function resetGallery(galleryId) {
    const gallery = document.getElementById(galleryId);
    if (!gallery) return;

    const thumbs = gallery.querySelectorAll('.gallery-thumb');
    const firstThumb = thumbs[0];
    if (!firstThumb) return;

    // 获取第一张图片src
    const firstImgSrc = firstThumb.querySelector('img').src;

    // 重置缩略图active状态
    thumbs.forEach(t => t.classList.remove('active'));
    firstThumb.classList.add('active');

    // 重置图片
    const currentImg = gallery.querySelector('.gallery-main-image.current');
    const nextImg = gallery.querySelector('.gallery-main-image.next');
    currentImg.src = firstImgSrc;
    nextImg.src = firstImgSrc;

    // 重置计数器
    const counter = gallery.querySelector('.gallery-counter');
    if (counter) counter.textContent = `1 / ${thumbs.length}`;
}

// 初始化所有画廊
window.addEventListener('load', () => {
    applyI18n();
    initGallery('gallery-lansyncbox');
    initGallery('gallery-syncgui');
    initGallery('gallery-deskhelper');
    initGallery('gallery-tokenpeek');
    initGallery('gallery-nexusterminal');
    initLightbox();
});

// Lightbox 放大查看功能
function initLightbox() {
    const lightbox = document.getElementById('lightbox');
    const lightboxImage = document.getElementById('lightboxImage');
    const lightboxClose = document.getElementById('lightboxClose');

    let scale = 1;
    let lastTouchDistance = 0;
    let isDragging = false;
    let startX = 0, startY = 0;
    let offsetX = 0, offsetY = 0;

    // 点击大图打开lightbox
    document.querySelectorAll('.gallery-main').forEach(main => {
        main.addEventListener('click', (e) => {
            if (e.target.classList.contains('gallery-main-image')) {
                const imgSrc = e.target.src;
                lightboxImage.src = imgSrc;
                lightbox.classList.add('active');
                scale = 1;
                offsetX = 0;
                offsetY = 0;
                updateImageTransform();
            }
        });
    });

    // 更新图片transform
    function updateImageTransform() {
        lightboxImage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    }

    // 关闭lightbox
    function closeLightbox() {
        lightbox.classList.remove('active');
        isDragging = false;
    }

    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
    });

    // ESC关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLightbox();
    });

    // 鼠标拖动
    lightboxImage.addEventListener('mousedown', (e) => {
        if (scale > 1) {
            e.preventDefault();
            isDragging = true;
            startX = e.clientX - offsetX;
            startY = e.clientY - offsetY;
            lightboxImage.style.cursor = 'grabbing';
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            offsetX = e.clientX - startX;
            offsetY = e.clientY - startY;
            updateImageTransform();
        }
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        lightboxImage.style.cursor = scale > 1 ? 'grab' : 'default';
    });

    // 鼠标滚轮缩放
    lightboxImage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        scale = Math.min(Math.max(0.5, scale + delta), 3);
        lightboxImage.style.cursor = scale > 1 ? 'grab' : 'default';
        if (scale <= 1) {
            offsetX = 0;
            offsetY = 0;
        }
        updateImageTransform();
    });

    // 双击放大/还原
    lightboxImage.addEventListener('dblclick', () => {
        scale = scale === 1 ? 2 : 1;
        offsetX = 0;
        offsetY = 0;
        lightboxImage.style.cursor = scale > 1 ? 'grab' : 'default';
        updateImageTransform();
    });

    // 移动端双指缩放
    lightbox.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const distance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY
            );
            if (lastTouchDistance > 0) {
                const delta = (distance - lastTouchDistance) * 0.01;
                scale = Math.min(Math.max(0.5, scale + delta), 3);
                if (scale <= 1) {
                    offsetX = 0;
                    offsetY = 0;
                }
                updateImageTransform();
            }
            lastTouchDistance = distance;
        } else if (e.touches.length === 1 && scale > 1 && isDragging) {
            e.preventDefault();
            offsetX = e.touches[0].clientX - startX;
            offsetY = e.touches[0].clientY - startY;
            updateImageTransform();
        }
    });

    lightbox.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            lastTouchDistance = Math.hypot(
                e.touches[1].clientX - e.touches[0].clientX,
                e.touches[1].clientY - e.touches[0].clientY
            );
        } else if (e.touches.length === 1 && scale > 1) {
            isDragging = true;
            startX = e.touches[0].clientX - offsetX;
            startY = e.touches[0].clientY - offsetY;
        }
    });

    lightbox.addEventListener('touchend', () => {
        lastTouchDistance = 0;
        isDragging = false;
    });
}

// 返回顶部按钮逻辑
window.addEventListener('load', () => {
    const backToTopBtn = document.getElementById('backToTop');
    const mainContent = document.querySelector('.main-content');

    if (mainContent && backToTopBtn) {
        mainContent.addEventListener('scroll', () => {
            if (mainContent.scrollTop > 300) {
                backToTopBtn.classList.add('show');
            } else {
                backToTopBtn.classList.remove('show');
            }
        });

        backToTopBtn.addEventListener('click', () => {
            mainContent.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
});

// ========== 小工具 - 随机数生成器 ==========
(function initRandomNumberGenerator() {
    const minInput = document.getElementById('randMin');
    const maxInput = document.getElementById('randMax');
    const btn = document.getElementById('randGenerateBtn');
    const resultEl = document.getElementById('randResult');

    if (!minInput || !maxInput || !btn || !resultEl) return;

    function randInt(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function generate() {
        const minVal = Number(minInput.value);
        const maxVal = Number(maxInput.value);

        // 输入验证
        if (isNaN(minVal) || isNaN(maxVal)) {
            resultEl.textContent = '请输入有效数字';
            resultEl.style.color = 'var(--accent-orange)';
            return;
        }

        if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
            resultEl.textContent = '数值超出范围';
            resultEl.style.color = 'var(--accent-orange)';
            return;
        }

        if (minVal > maxVal) {
            resultEl.textContent = '最小值 > 最大值';
            resultEl.style.color = 'var(--accent-orange)';
            return;
        }

        // 生成随机数
        const n = randInt(minVal, maxVal);
        resultEl.textContent = n;
        resultEl.style.color = 'var(--accent-blue)';

        // 添加弹跳动画
        resultEl.classList.remove('pop');
        void resultEl.offsetWidth; // 触发重绘
        resultEl.classList.add('pop');
    }

    btn.addEventListener('click', generate);

    // 支持 Enter 键生成
    [minInput, maxInput].forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') generate();
        });
    });

    // 页面加载时自动生成一个随机数
    generate();
})();