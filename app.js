// 模型配置
const MODELS = [
    // ========== Token 计费（便宜）==========
    { id: 'gemini-3-pro-preview-thinking', name: 'Gemini 3 Pro Preview Thinking', points: 0.02, provider: 'Google', billing: 'token' },
    { id: 'gemini-3.1-pro-preview-thinking', name: 'Gemini 3.1 Pro Thinking', points: 0.02, provider: 'Google', billing: 'token' },
    { id: 'gpt-5.2', name: 'GPT-5.2', points: 0.03, provider: 'OpenAI', billing: 'token', highlight: true },

    // ========== 次数计费（较贵）==========
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', points: 100, provider: 'Anthropic', billing: 'count' },
    { id: 'claude-haiku-4-5-20251001-thinking', name: 'Claude Haiku 4.5 Thinking', points: 200, provider: 'Anthropic', billing: 'count' },
    { id: 'gemini-3-flash-preview-thinking', name: 'Gemini 3 Flash Thinking', points: 200, provider: 'Google', billing: 'count' },

    // ========== 次数计费（贵）==========
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', points: 300, provider: 'OpenAI', billing: 'count' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', points: 300, provider: 'OpenAI', billing: 'count' },
    { id: 'gpt-5.4', name: 'GPT-5.4', points: 300, provider: 'OpenAI', billing: 'count' },
    { id: 'gpt-5.2-all', name: 'GPT-5.2 All', points: 750, provider: 'OpenAI', billing: 'count' },
    { id: 'gpt-5.2-thinking', name: 'GPT-5.2 Thinking', points: 750, provider: 'OpenAI', billing: 'count' },
    { id: 'gpt-5.2-thinking-all', name: 'GPT-5.2 Thinking All', points: 750, provider: 'OpenAI', billing: 'count' },

    // ========== 次数计费（最贵）==========
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', points: 1000, provider: 'Anthropic', billing: 'count', highlight: true },
    { id: 'claude-sonnet-4-6-thinking', name: 'Claude Sonnet 4.6 Thinking', points: 1000, provider: 'Anthropic', billing: 'count' },
];

// 默认 API Key
const DEFAULT_API_KEY = 'sk-XDYrk1vlX3p84KrXC7531cCd488d4e0dA453542dCd0241B1';

// 应用状态
const state = {
    results: [],
    isTesting: false,
    totalPoints: 0
};

// DOM 元素
const $ = id => document.getElementById(id);

// 初始化
function init() {
    initModelSelect();
    loadConfig();
    bindEvents();
    // 默认选择 Token 计费模型
    selectTokenBillingModels();
    updateSelectionInfo();
}

// 初始化模型列表
function initModelSelect() {
    const select = $('modelSelect');
    let html = '<optgroup label="📊 Token 计费（便宜）">';

    MODELS.filter(m => m.billing === 'token').forEach(model => {
        const hl = model.highlight ? 'data-highlight="true"' : '';
        html += `<option value="${model.id}" ${hl}>${model.name} (${model.points} 积分/token) - ${model.provider}</option>`;
    });

    html += '</optgroup><optgroup label="🔢 次数计费（较贵）">';

    MODELS.filter(m => m.billing === 'count' && m.points < 300).forEach(model => {
        html += `<option value="${model.id}">${model.name} (${model.points} 积分/次) - ${model.provider}</option>`;
    });

    html += '</optgroup><optgroup label="🔢 次数计费（贵）">';

    MODELS.filter(m => m.billing === 'count' && m.points >= 300 && m.points < 1000).forEach(model => {
        const hl = model.highlight ? 'data-highlight="true"' : '';
        html += `<option value="${model.id}" ${hl}>${model.name} (${model.points} 积分/次) - ${model.provider}</option>`;
    });

    html += '</optgroup><optgroup label="🔢 次数计费（最贵）">';

    MODELS.filter(m => m.billing === 'count' && m.points >= 1000).forEach(model => {
        const hl = model.highlight ? 'data-highlight="true"' : '';
        html += `<option value="${model.id}" ${hl}>${model.name} (${model.points} 积分/次) - ${model.provider}</option>`;
    });

    html += '</optgroup>';

    select.innerHTML = html;
}

// 选择 Token 计费模型
function selectTokenBillingModels() {
    const select = $('modelSelect');
    Array.from(select.options).forEach(opt => {
        const model = MODELS.find(m => m.id === opt.value);
        opt.selected = model && model.billing === 'token';
    });
}

// 加载配置
function loadConfig() {
    const saved = localStorage.getItem('aiTesterConfig');
    if (saved) {
        const config = JSON.parse(saved);
        $('apiEndpoint').value = config.apiEndpoint || $('apiEndpoint').value;
        $('apiKey').value = config.apiKey || DEFAULT_API_KEY;
    } else {
        $('apiKey').value = DEFAULT_API_KEY;
    }
}

// 保存配置
function saveConfig() {
    localStorage.setItem('aiTesterConfig', JSON.stringify({
        apiEndpoint: $('apiEndpoint').value,
        apiKey: $('apiKey').value
    }));
}

// 绑定事件
function bindEvents() {
    // API Key 切换显示
    $('toggleApiKey').onclick = () => {
        const input = $('apiKey');
        input.type = input.type === 'password' ? 'text' : 'password';
        $('toggleApiKey').textContent = input.type === 'password' ? '👁️' : '🙈';
    };

    // 全选
    $('selectAll').onclick = () => {
        Array.from($('modelSelect').options).forEach(o => o.selected = true);
        updateSelectionInfo();
    };

    // 取消全选
    $('deselectAll').onclick = () => {
        Array.from($('modelSelect').options).forEach(o => o.selected = false);
        updateSelectionInfo();
    };

    // 选择 Token 计费
    $('selectTokenBilling').onclick = () => {
        selectTokenBillingModels();
        updateSelectionInfo();
    };

    // 模型变化
    $('modelSelect').onchange = updateSelectionInfo;

    // 并发检测
    $('checkOnline').onclick = async () => {
        const models = getSelectedModels();
        if (models.length === 0) return alert('请选择模型');
        if (!confirm(`即将并发检测 ${models.length} 个模型的在线状态，是否继续？`)) return;
        await checkModelsParallel(models);
    };

    // 清空结果
    $('clearResults').onclick = () => {
        if (state.results.length && !confirm('确定清空结果？')) return;
        state.results = [];
        state.totalPoints = 0;
        renderResults();
        updateSummary();
    };

    // 保存配置
    $('apiEndpoint').onchange = saveConfig;
    $('apiKey').onchange = saveConfig;
}

// 更新选择信息
function updateSelectionInfo() {
    const models = getSelectedModels();
    const tokenCount = models.filter(id => {
        const m = MODELS.find(x => x.id === id);
        return m && m.billing === 'token';
    }).length;

    let html = `已选择 <strong>${models.length}</strong> 个模型`;
    if (tokenCount > 0) {
        html += `（含 <strong>${tokenCount}</strong> 个 Token 计费）`;
    }
    $('selectionInfo').innerHTML = html;
}

// 获取选中模型
function getSelectedModels() {
    return Array.from($('modelSelect').selectedOptions).map(o => o.value);
}

// 获取模型信息
function getModel(id) {
    return MODELS.find(m => m.id === id) || { name: id, points: 0, provider: 'Unknown', billing: 'count' };
}

// 并发检测模型在线状态
async function checkModelsParallel(modelIds) {
    if (state.isTesting) return alert('检测进行中');

    const apiKey = $('apiKey').value.trim();
    if (!apiKey) return alert('请输入 API Key');

    state.isTesting = true;
    showLoading(true, `并发检测 ${modelIds.length} 个模型...`);

    // 创建所有结果对象
    const results = modelIds.map(id => {
        const m = getModel(id);
        return {
            model: id,
            modelName: m.name,
            provider: m.provider,
            points: m.points,
            billing: m.billing,
            status: 'testing',
            timestamp: new Date().toISOString()
        };
    });

    // 添加到结果列表（并发执行）
    state.results = [...results, ...state.results];
    renderResults();

    // 并发执行所有请求
    const promises = modelIds.map(async (modelId, index) => {
        const result = results[index];

        try {
            const start = Date.now();
            const res = await callAPI(modelId, apiKey);

            result.duration = ((Date.now() - start) / 1000).toFixed(2);
            result.status = res.success ? 'success' : 'error';
            result.response = res.data;
            result.error = res.error;

            if (res.success) {
                result.actualPoints = calcPoints(result, res.data);
                state.totalPoints += result.actualPoints;
            }
        } catch (e) {
            result.status = 'error';
            result.error = e.message;
        }

        // 每个完成后立即更新显示
        renderResults();
        updateSummary();
    });

    // 等待所有完成
    await Promise.all(promises);

    state.isTesting = false;
    showLoading(false);
    renderResults();
    updateSummary();
}

// 调用 API
async function callAPI(model, apiKey) {
    const endpoint = $('apiEndpoint').value.trim();
    const msg = $('testMessage').value.trim() || 'Hello!';
    const timeout = parseInt($('timeout').value) * 1000;

    const messages = [{ role: 'user', content: msg }];

    try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), timeout);

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ model, stream: false, messages }),
            signal: ctrl.signal
        });

        clearTimeout(tid);
        const data = await res.json();

        if (!res.ok) {
            return { success: false, error: data.error?.message || `HTTP ${res.status}`, data };
        }

        return { success: true, data };
    } catch (e) {
        if (e.name === 'AbortError') return { success: false, error: `超时（${timeout/1000}s）` };
        return { success: false, error: e.message };
    }
}

// 计算积分
function calcPoints(result, data) {
    if (result.billing === 'token' && data?.usage?.total_tokens) {
        return Math.ceil(result.points * data.usage.total_tokens);
    }
    return result.points;
}

// 渲染结果
function renderResults() {
    if (!state.results.length) {
        $('resultsList').innerHTML = '<p class="no-results">暂无结果，请选择模型并点击"并发检测选中"</p>';
        return;
    }

    $('resultsList').innerHTML = state.results.map((r, i) => {
        const cls = r.status === 'success' ? 'success' : r.status === 'error' ? 'error' : 'pending';
        const txt = r.status === 'success' ? '✅ 在线' : r.status === 'error' ? '❌ 离线' : '⏳ 检测中';
        const icon = r.billing === 'token' ? '📊' : '🔢';
        const pts = r.actualPoints !== undefined
            ? `${icon} ${r.actualPoints} 积分`
            : r.billing === 'token' ? `${icon} ${r.points} 积分/token` : `${icon} ${r.points} 积分/次`;

        return `
<div class="result-item">
    <div class="result-header" onclick="toggleBody(${i})">
        <div class="result-model-info">
            <div class="result-model">${esc(r.modelName)}</div>
            <div class="result-points">${pts} | ${r.provider}</div>
        </div>
        <div class="result-status">
            <span class="status-badge ${cls}">${txt}</span>
            ${r.duration ? `<span class="result-time">${r.duration}s</span>` : ''}
        </div>
    </div>
    <div class="result-body" id="body-${i}">
        ${r.error ? `<div class="result-section"><div class="result-label">错误</div><div class="result-content error-text">${esc(r.error)}</div></div>` : ''}
        ${r.response ? `<div class="result-section"><div class="result-label">响应</div><div class="result-content">${fmtRes(r.response)}</div></div>` : ''}
    </div>
</div>`;
    }).join('');
}

function toggleBody(i) {
    document.getElementById(`body-${i}`)?.classList.toggle('expanded');
}

function fmtRes(data) {
    if (typeof data === 'object' && data !== null) {
        let out = '';
        if (data.usage) {
            out += `Token: 输入 ${data.usage.prompt_tokens || 0} / 输出 ${data.usage.completion_tokens || 0} / 总计 ${data.usage.total_tokens || 0}\n\n`;
        }
        if (data.choices?.[0]?.message?.content) {
            out += `回复:\n${esc(data.choices[0].message.content)}`;
        }
        return out || JSON.stringify(data, null, 2);
    }
    return esc(String(data));
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function updateSummary() {
    $('totalCount').textContent = state.results.length;
    $('successCount').textContent = state.results.filter(r => r.status === 'success').length;
    $('errorCount').textContent = state.results.filter(r => r.status === 'error').length;
    $('pointsCount').textContent = state.totalPoints;
}

function showLoading(show, text = '检测中...') {
    $('loadingText').textContent = text;
    $('loadingOverlay').classList.toggle('active', show);
}

init();
