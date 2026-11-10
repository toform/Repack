import { appState } from './config.js';
import { escapeHtml, formatInventoryQuantity, normalizeInventoryUnit } from './utils.js';
import { getCatalogProducts } from './productCatalog.js';

const CATEGORY_DEFINITIONS = [
    { id: 'milk', title: 'Milk', icon: '🥛', matches: /milk/i },
    { id: 'spam', title: 'Spam', icon: '🥫', matches: /spam|canned/i },
    { id: 'angel-bars', title: 'Angel Bars', icon: '🍫', matches: /angel\s*bars?/i },
    { id: 'cookies', title: 'Cookies', icon: '🍪', matches: /cookie/i },
    { id: 'cakes-pastries', title: 'Cakes & Pastries', icon: '🎂', matches: /lecheroon|taisan|cake|pastr|pastillas/i }
];

const STOCKROOM_CONVERSIONS = {
    milk: { matches: /oat\s*milk/i, boxSize: 6, looseUnit: 'Pcs' }
};

const ANGEL_BAR_VARIANTS = [
    { key: 'assorted-24', variant: 'Assorted', size: 24 },
    { key: 'assorted-12', variant: 'Assorted', size: 12 },
    { key: 'mango-only-24', variant: 'Mango Only', size: 24 },
    { key: 'mango-only-12', variant: 'Mango Only', size: 12 }
];
const ANGEL_BAR_VARIANT_ORDER = new Map(ANGEL_BAR_VARIANTS.map((variant, index) => [variant.key, index]));

export function updateTabBadges() {
    const counts = {
        pending: appState.customerOrders.filter(customer => customer.status === 'pending').length,
        incomplete: appState.customerOrders.filter(customer => customer.status === 'incomplete').length,
        completed: appState.customerOrders.filter(customer => customer.status === 'completed').length
    };

    Object.entries(counts).forEach(([status, count]) => {
        const badge = document.getElementById(`count-${status}`);
        if (badge) badge.textContent = count;
    });
    updateDashboardBadges();
}

export function renderBatchHistory() {
    const historyList = document.getElementById('batchHistoryList');
    if (!historyList) return;

    historyList.innerHTML = appState.batchHistory.length
        ? appState.batchHistory.map(batch => `
            <article class="batch-history-card">
                <div class="batch-history-card-heading">
                    <h3>${escapeHtml(batch.name)}</h3>
                    <span>${batch.customerOrders.length} customer${batch.customerOrders.length === 1 ? '' : 's'}</span>
                </div>
                <time datetime="${escapeHtml(batch.archivedAt)}">${escapeHtml(formatBatchArchiveDate(batch.archivedAt))}</time>
                <div class="batch-history-actions">
                    <button type="button" class="batch-history-action batch-history-view" data-batch-action="view" data-batch-id="${escapeHtml(batch.id)}">👁️ View</button>
                    <button type="button" class="batch-history-action" data-batch-action="edit" data-batch-id="${escapeHtml(batch.id)}">✏️ Edit Batch</button>
                    <button type="button" class="batch-history-action" data-batch-action="export" data-batch-id="${escapeHtml(batch.id)}">📥 Excel</button>
                    <button type="button" class="batch-history-action batch-history-delete" data-batch-action="delete" data-batch-id="${escapeHtml(batch.id)}" aria-label="Delete ${escapeHtml(batch.name)} archive">🗑️</button>
                </div>
            </article>
        `).join('')
        : '<p class="batch-history-empty">No archived batches yet. Archive a completed cut-off to create your first history folder.</p>';
    updateDashboardBadges();
}

export function updateDashboardBadges() {
    const pendingCount = appState.customerOrders.filter(customer => customer.status === 'pending').length;
    const pendingBadge = document.getElementById('dashPendingBadge');
    if (pendingBadge) pendingBadge.textContent = `${pendingCount} Pending Orders`;

    const archiveBadge = document.getElementById('dashArchiveBadge');
    if (archiveBadge) archiveBadge.textContent = `${appState.batchHistory.length} Saved Batches`;
    const productBadge = document.getElementById('dashProductBadge');
    if (productBadge) productBadge.textContent = `${getCatalogProducts().length} Catalog Products`;
}

function formatBatchArchiveDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? 'Archived date unavailable'
        : `Archived ${new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(date)}`;
}

export function updateSummaryStats() {
    updateTabBadges();
    const categories = CATEGORY_DEFINITIONS.map(category => ({
        ...category,
        items: new Map(),
        pieces: new Map(),
        stockroom: { total: 0, packed: 0 }
    }));
    const angelBarsCategory = categories.find(category => category.id === 'angel-bars');
    ANGEL_BAR_VARIANTS.forEach(({ key, variant, size }) => {
        const description = `Angel Bars ${variant} ${size}s`;
        angelBarsCategory.items.set(key, {
            description,
            unit: 'Boxes',
            quantity: 0,
            packedQuantity: 0
        });
        angelBarsCategory.pieces.set(key, {
            label: `${variant} ${size}s`,
            quantity: 0
        });
    });
    let neededItems = 0;
    let packedItems = 0;

    appState.customerOrders.forEach(customer => {
        (customer.items || []).forEach(item => {
            const rawDescription = String(item.description || '').replace(/\s+/g, ' ').trim();
            const unit = normalizeInventoryUnit(item.unit);
            const category = getInventoryCategory(item.category, rawDescription, unit, categories);
            const angelBar = category.id === 'angel-bars' ? getAngelBarVariant(rawDescription) : null;
            const displayName = getInventoryDisplayName(rawDescription, angelBar);
            const angelBarKey = angelBar ? `${angelBar.variant.toLocaleLowerCase().replace(/\s+/g, '-')}-${angelBar.size}` : null;
            const itemKey = angelBar ? angelBarKey : `${normalizeInventoryDescription(displayName)}|${unit.toLocaleLowerCase()}`;
            const quantity = Number(item.qty) || 0;

            if (!category.items.has(itemKey)) {
                category.items.set(itemKey, { description: displayName, unit, quantity: 0, packedQuantity: 0 });
            }
            const inventoryItem = category.items.get(itemKey);
            inventoryItem.quantity += quantity;
            if (item.checked) inventoryItem.packedQuantity += quantity;

            neededItems += quantity;
            if (item.checked) packedItems += quantity;

            const stockroomConversion = STOCKROOM_CONVERSIONS[category.id];
            if (stockroomConversion?.matches.test(rawDescription) && /^pcs?$/.test(unit.toLocaleLowerCase())) {
                category.stockroom.total += quantity;
                if (item.checked) category.stockroom.packed += quantity;
            }

            const multiplier = getPieceMultiplier(category.id, unit, angelBar, rawDescription);
            if (multiplier) {
                const key = category.id === 'angel-bars' ? angelBarKey : category.id;
                const label = category.id === 'angel-bars'
                    ? `${angelBar.variant} ${angelBar.size}s`
                    : category.id === 'cookies' ? 'Cookies' : 'Lecheroons';
                const total = category.pieces.get(key) || { label, quantity: 0 };
                total.quantity += quantity * multiplier;
                category.pieces.set(key, total);
            }
        });
    });

    const inventoryList = document.getElementById('itemTotalsList');
    if (!inventoryList) return;

    const packingTotals = `
        <section class="inventory-packing-totals" aria-label="Packed and remaining item totals">
            <div class="inventory-total-cell"><span>Needed</span><strong>${neededItems.toLocaleString()}</strong></div>
            <div class="inventory-total-cell"><span>Packed</span><strong>${packedItems.toLocaleString()}</strong></div>
            <div class="inventory-total-cell"><span>Remaining</span><strong>${(neededItems - packedItems).toLocaleString()}</strong></div>
        </section>
    `;

    inventoryList.innerHTML = packingTotals + categories.map(category => {
        const items = [...category.items.values()].sort((a, b) => {
            if (category.id === 'angel-bars') {
                const activeDifference = Number(b.quantity > 0) - Number(a.quantity > 0);
                const aKey = getAngelBarVariantKey(a.description);
                const bKey = getAngelBarVariantKey(b.description);
                return activeDifference
                    || (ANGEL_BAR_VARIANT_ORDER.get(aKey) ?? Number.MAX_SAFE_INTEGER)
                        - (ANGEL_BAR_VARIANT_ORDER.get(bKey) ?? Number.MAX_SAFE_INTEGER);
            }
            return a.description.localeCompare(b.description);
        });
        const itemRows = items.length
            ? items.map(item => `
                <li class="inventory-item">
                    <span class="inventory-item-name">
                        <span class="inventory-item-icon" aria-hidden="true">${category.id === 'angel-bars' ? getAngelBarItemIcon(item.description) : category.icon}</span>
                        <span>${escapeHtml(item.description)}</span>
                    </span>
                    <span class="inventory-quantity">
                        <strong class="inventory-quantity-badge">${escapeHtml(formatInventoryQuantity(item.quantity, item.unit))}</strong>
                    </span>
                    <small class="inventory-quantity-details">${escapeHtml(formatInventoryQuantity(item.packedQuantity, item.unit))} packed · ${escapeHtml(formatInventoryQuantity(item.quantity - item.packedQuantity, item.unit))} remaining</small>
                </li>
            `).join('')
            : '<li class="inventory-empty">0 items</li>';
        const pieceBadges = [...category.pieces.values()];
        const pieceSummary = pieceBadges.length
            ? `<div class="inventory-piece-totals">
                <span class="inventory-piece-label">Production pieces</span>
                ${pieceBadges.map(total => `<strong class="inventory-piece-badge">${escapeHtml(total.label)}: ${total.quantity.toLocaleString()} pcs</strong>`).join('')}
            </div>`
            : '';
        const stockroomConversion = STOCKROOM_CONVERSIONS[category.id];
        const stockroomSummary = stockroomConversion && category.stockroom.total
            ? `<div class="inventory-stockroom-badge">
                <span>Stockroom case conversion</span>
                <strong>Total: ${category.stockroom.total.toLocaleString()} Pcs ➔ ${Math.floor(category.stockroom.total / stockroomConversion.boxSize).toLocaleString()} Boxes, ${(category.stockroom.total % stockroomConversion.boxSize).toLocaleString()} ${stockroomConversion.looseUnit} loose</strong>
                <small>${category.stockroom.packed.toLocaleString()} Pcs packed · ${(category.stockroom.total - category.stockroom.packed).toLocaleString()} Pcs remaining</small>
            </div>`
            : '';

        return `
            <section class="inventory-category inventory-category-${category.id}">
                <div class="inventory-category-header"><h3><span aria-hidden="true">${category.icon}</span> ${category.title}</h3></div>
                <ul class="inventory-item-list">${itemRows}</ul>
                ${stockroomSummary}
                ${pieceSummary}
            </section>
        `;
    }).join('');
}

function getInventoryCategory(itemCategory, description, unit, categories) {
    const explicitCategory = String(itemCategory || '').toLocaleLowerCase();
    if (explicitCategory.includes('milk') || explicitCategory.includes('spam')) {
        return /spam|canned/i.test(description)
            ? categories.find(group => group.id === 'spam')
            : categories.find(group => group.id === 'milk');
    }
    if (explicitCategory.includes('angel')) return categories.find(group => group.id === 'angel-bars');
    if (explicitCategory.includes('cookie')) return categories.find(group => group.id === 'cookies');
    if (explicitCategory.includes('cake') || explicitCategory.includes('pastr')) {
        return categories.find(group => group.id === 'cakes-pastries');
    }
    return categories.find(group => group.matches.test(`${description} ${unit}`))
        || categories.find(group => group.id === 'cakes-pastries');
}

function getAngelBarItemIcon(description) {
    const desc = String(description || '').toLocaleLowerCase();
    if (desc.includes('mango')) return '🥭';
    return '🍫';
}

function getAngelBarVariant(description) {
    const isMango = isAngelBarsVariant(description, 'MANGO_24S')
        || isAngelBarsVariant(description, 'MANGO_12S');
    const isTwelve = isMango
        ? isAngelBarsVariant(description, 'MANGO_12S')
        : isAngelBarsVariant(description, 'ASSTD_12S');
    const variant = isMango ? 'Mango Only' : 'Assorted';
    const size = isTwelve ? 12 : 24;
    return { variant, size };
}

function isAngelBarsVariant(itemDescription, variantType) {
    const desc = String(itemDescription || '').toLocaleUpperCase();
    if (!desc.includes('ANGEL')) return false;

    const isMango = desc.includes('MANGO');
    const is12s = desc.includes('12') || desc.includes('12S') || desc.includes('12 PCS');

    switch (variantType) {
        case 'ASSTD_24S': return !isMango && !is12s;
        case 'ASSTD_12S': return !isMango && is12s;
        case 'MANGO_24S': return isMango && !is12s;
        case 'MANGO_12S': return isMango && is12s;
        default: return false;
    }
}

function getAngelBarVariantKey(description) {
    const { variant, size } = getAngelBarVariant(description);
    return `${variant.toLocaleLowerCase().replace(/\s+/g, '-')}-${size}`;
}

function getInventoryDisplayName(description, angelBar) {
    if (angelBar) {
        return `Angel Bars ${angelBar.variant}${angelBar.size ? ` ${angelBar.size}s` : ' (size unspecified)'}`;
    }
    if (/lecheroon/i.test(description) && !/12\s*[- ]?pc/i.test(description)) {
        return `${description} (12-pc box)`;
    }
    if (/cookie/i.test(description) && !/5\s*[- ]?pc/i.test(description)) {
        return `${description} (5-pc box)`;
    }
    return description;
}

function getPieceMultiplier(categoryId, unit, angelBar, description) {
    if (categoryId === 'angel-bars') return angelBar.size;
    if (!unit.toLocaleLowerCase().includes('box')) return 0;
    if (categoryId === 'cookies') return 5;
    if (categoryId === 'cakes-pastries' && /lecheroon/i.test(description)) return 12;
    return 0;
}

function normalizeInventoryDescription(description) {
    return String(description || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/\b(\d+)\s*[- ]?\s*pcs?\s*box\b/g, '$1pcbox')
        .replace(/[^a-z0-9]/g, '');
}
