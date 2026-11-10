import { appState } from './config.js';
import { escapeHtml, extractCustomerArea, formatInventoryQuantity, normalizeCustomerKey, sortCustomerItemLists } from './utils.js';
import { updateSummaryStats, updateTabBadges } from './sidebar.js';
import { saveToLocalStorage } from './storage.js';

export function getCustomerArea(customerName) {
    return extractCustomerArea(customerName) || 'No Area';
}

export function renderCards() {
    const cardsGrid = document.getElementById('cardsGrid');
    const archivedEditBanner = document.getElementById('archivedBatchEditBanner');
    const archivedEditName = document.getElementById('archivedBatchEditName');
    const editingArchivedBatch = appState.editingArchivedBatch;
    if (archivedEditBanner) archivedEditBanner.hidden = !editingArchivedBatch;
    if (archivedEditName) archivedEditName.textContent = editingArchivedBatch?.name || '';
    if (!cardsGrid) return;
    sortCustomerItemLists(appState.customerOrders);
    cardsGrid.innerHTML = '';
    updateAreaFilterOptions();

    const queuedDuplicateKeys = new Set(appState.pendingDuplicateMerges.flatMap(candidate => [
        candidate.primaryKey,
        candidate.secondaryKey
    ]));
    const filteredCustomers = appState.customerOrders
        .filter(customer => customer.status === appState.activeTab)
        .filter(customer => !queuedDuplicateKeys.has(normalizeCustomerKey(customer.name)))
        .filter(customer => !appState.selectedArea || getCustomerArea(customer.name) === appState.selectedArea)
        .filter(matchesSearch)
        .sort(compareCustomers);

    if (!filteredCustomers.length) {
        const hasOrdersInTab = appState.customerOrders.some(customer => customer.status === appState.activeTab);
        cardsGrid.innerHTML = appState.customerOrders.length === 0
            ? '<div class="empty-state">Upload your Excel file to start repacking.</div>'
            : `<div class="empty-state">${hasOrdersInTab
            ? 'No orders match the selected search and filters.'
            : `Walang order sa <strong>${escapeHtml(appState.activeTab.toLocaleUpperCase())}</strong> list.`}</div>`;
    }

    filteredCustomers.forEach(customer => {
        const index = appState.customerOrders.indexOf(customer);
        const packedCount = customer.items.filter(item => item.checked).length;
        const totalItems = customer.items.length;
        const progress = totalItems ? Math.round((packedCount / totalItems) * 100) : 0;
        const card = document.createElement('article');
        card.className = 'customer-card';
        card.tabIndex = 0;
        card.setAttribute('aria-label', `Edit order for ${customer.name}`);
        card.dataset.customerIndex = index;
        card.dataset.area = getCustomerArea(customer.name);

        const itemRows = customer.items.map((item, itemIndex) => `
            <div class="card-item-preview${item.checked ? ' is-packed' : ''}" data-checked="${Boolean(item.checked)}">
                <input type="checkbox" data-item-index="${itemIndex}" aria-label="Mark ${escapeHtml(item.description)} packed" ${item.checked ? 'checked' : ''}>
                <span class="card-item-icon" aria-hidden="true">${getItemIcon(item.description)}</span>
                <span class="card-item-name">${escapeHtml(item.description)}</span>
                <span class="card-item-quantity">${escapeHtml(formatInventoryQuantity(item.qty, item.unit))}</span>
            </div>
        `).join('');

        card.innerHTML = `
            <div>
                <div class="customer-name">${escapeHtml(customer.name)}</div>
                <div class="packing-summary">
                    <span>Packed: <strong>${packedCount}/${totalItems} items</strong></span>
                    <span>${progress}%</span>
                </div>
                <div class="progress-track" role="progressbar" aria-label="Order packing progress" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100">
                    <div class="progress-fill" style="width: ${progress}%"></div>
                </div>
                <div class="card-items">${itemRows}</div>
                <div class="packing-signoff" aria-hidden="true">
                    <span>Packed by: __________________</span>
                    <span>Checked by: ________________</span>
                </div>
            </div>
            <div class="card-actions">${getActionButtons(index, appState.activeTab)}</div>
        `;
        cardsGrid.appendChild(card);
    });

    updateTabBadges();
}

export function resetCurrentBatch() {
    appState.customerOrders.forEach(customer => {
        customer.status = 'pending';
        customer.items.forEach(item => { item.checked = false; });
    });
    appState.orderSort = 'oatmilk-desc';
    appState.activeTab = 'pending';
    appState.customerSearchQuery = '';
    appState.selectedArea = '';
    const sort = document.getElementById('orderSort');
    if (sort) sort.value = appState.orderSort;
    const search = document.getElementById('customerSearch');
    if (search) search.value = '';
    const area = document.getElementById('areaFilter');
    if (area) area.value = '';
    document.querySelectorAll('.tab-btn[data-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === 'pending');
    });

    saveToLocalStorage();
    renderCards();
    updateSummaryStats();
}

export function toggleCustomerItem(customerIndex, itemIndex, isChecked) {
    const customer = appState.customerOrders[customerIndex];
    const item = customer?.items[itemIndex];
    if (!item) return;

    const previousChecked = item.checked;
    const previousStatus = customer.status;
    item.checked = isChecked;
    const checkedCount = customer.items.filter(orderItem => orderItem.checked).length;
    const totalItems = customer.items.length;
    customer.status = totalItems > 0 && checkedCount === totalItems
        ? 'completed'
        : checkedCount > 0 && previousStatus !== 'pending' ? 'incomplete' : 'pending';

    if (!saveToLocalStorage()) {
        item.checked = previousChecked;
        customer.status = previousStatus;
        renderCards();
        showAppToast('The item check could not be saved. Your order progress was not changed.', 'error');
        return;
    }

    renderCards();
    updateSummaryStats();

    if (totalItems > 0 && checkedCount === totalItems) {
        showAppToast(`🎉 ${customer.name}'s repacking completed!`);
    }
}

export function completeCustomerOrder(index) {
    const customer = appState.customerOrders[index];
    const card = document.querySelector(`.customer-card[data-customer-index="${index}"]`);
    if (!customer || !card) return;
    if (!customer.items.length) {
        showAppToast('This order has no items to pack. Reload the Excel file or update the order first.', 'error');
        return;
    }

    customer.items.forEach(item => { item.checked = true; });
    customer.status = 'completed';
    saveToLocalStorage();
    updateSummaryStats();
    updateTabBadges();

    card.classList.add('is-completing');
    card.querySelectorAll('.card-item-preview').forEach(item => {
        item.classList.add('is-packed');
        item.dataset.checked = 'true';
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = true;
    });
    const packedLabel = card.querySelector('.packing-summary strong');
    if (packedLabel) packedLabel.textContent = `${customer.items.length}/${customer.items.length} items`;
    const progressLabel = card.querySelector('.packing-summary > span:last-child');
    if (progressLabel) progressLabel.textContent = '100%';
    const progressBar = card.querySelector('.progress-fill');
    if (progressBar) progressBar.style.width = '100%';
    card.querySelector('.progress-track')?.setAttribute('aria-valuenow', '100');

    showAppToast(`${customer.name} marked complete.`);
    window.setTimeout(renderCards, 360);
}

export function uncheckCustomerOrderItems(index) {
    const customer = appState.customerOrders[index];
    if (!customer) return;

    const previousChecks = customer.items.map(item => item.checked);
    const previousStatus = customer.status;
    customer.items.forEach(item => { item.checked = false; });
    customer.status = 'pending';
    if (!saveToLocalStorage()) {
        customer.items.forEach((item, index) => { item.checked = previousChecks[index]; });
        customer.status = previousStatus;
        showAppToast('The order checks could not be saved. Your progress was not changed.', 'error');
        return;
    }

    renderCards();
    updateSummaryStats();
    showAppToast(`${customer.name}'s order checks cleared.`);
}

export function showCardsError(message) {
    const cardsGrid = document.getElementById('cardsGrid');
    if (!cardsGrid) return;
    cardsGrid.innerHTML = `
        <section class="error-state" role="alert">
            <span class="error-state-icon" aria-hidden="true">⚠️</span>
            <h2>We couldn't load this order file</h2>
            <p>${escapeHtml(message)}</p>
            <button type="button" class="btn-card-reload" data-reload-file>📁 Reload File</button>
        </section>
    `;
}

export function showAppToast(message, type = 'success') {
    document.querySelector('.app-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = `app-toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3500);
}

function matchesSearch(customer) {
    if (!appState.customerSearchQuery) return true;
    const searchable = `${customer.name} ${customer.items.map(item => item.description).join(' ')}`.toLocaleLowerCase();
    return searchable.includes(appState.customerSearchQuery);
}

function compareCustomers(a, b) {
    if (appState.orderSort === 'oatmilk-desc') {
        const comboDifference = Number(hasFiveMilkFiveSpamCombo(b)) - Number(hasFiveMilkFiveSpamCombo(a));
        return comboDifference
            || getCustomerOatMilkQty(b) - getCustomerOatMilkQty(a)
            || a.name.localeCompare(b.name);
    }
    if (appState.orderSort === 'progress') {
        return getProgress(a) - getProgress(b) || a.name.localeCompare(b.name);
    }
    if (appState.orderSort === 'area') {
        return getCustomerArea(a.name).localeCompare(getCustomerArea(b.name)) || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
}

function hasFiveMilkFiveSpamCombo(customer) {
    if (!Array.isArray(customer?.items)) return false;
    let hasFiveMilk = false;
    let hasFiveSpam = false;

    customer.items.forEach(item => {
        const description = String(item.description || '').toLocaleLowerCase();
        const quantity = Number(item.qty) || 0;
        if (description.includes('milk') && quantity === 5) hasFiveMilk = true;
        if (description.includes('spam') && quantity === 5) hasFiveSpam = true;
    });

    return hasFiveMilk && hasFiveSpam;
}

function getCustomerOatMilkQty(customer) {
    if (!Array.isArray(customer?.items)) return 0;
    return customer.items.reduce((total, item) => {
        return String(item.description || '').toLocaleLowerCase().includes('milk')
            ? total + (Number(item.qty) || 0)
            : total;
    }, 0);
}

function getProgress(customer) {
    if (!customer.items.length) return 0;
    return customer.items.filter(item => item.checked).length / customer.items.length;
}

function getActionButtons(index, status) {
    const items = appState.customerOrders[index]?.items || [];
    const checkedCount = items.filter(item => item.checked).length;
    const totalItems = items.length;
    if (status === 'pending') {
        return `
            <button class="btn-card-status btn-card-incomplete btn-mark-incomplete" data-order-action="incomplete" data-customer-index="${index}"${checkedCount === 0 || checkedCount === totalItems ? ' disabled' : ''}>Mark Incomplete</button>
            <button class="btn-card-status btn-card-complete" data-order-action="completed" data-customer-index="${index}">Mark Complete</button>
            <button class="btn-card-status btn-card-toggle btn-uncheck-all" data-order-action="uncheck-all" data-customer-index="${index}">↺ Uncheck All</button>
        `;
    }
    if (status === 'incomplete') {
        return `
            <button class="btn-card-status btn-card-incomplete" data-order-action="pending" data-customer-index="${index}">Move to Pending</button>
            <button class="btn-card-status btn-card-complete" data-order-action="completed" data-customer-index="${index}">Mark Complete</button>
            <button class="btn-card-status btn-card-toggle btn-uncheck-all" data-order-action="uncheck-all" data-customer-index="${index}">↺ Uncheck All</button>
        `;
    }
    return `
        <button class="btn-card-status btn-card-incomplete" data-order-action="pending" data-customer-index="${index}">Reopen Order</button>
        <button class="btn-card-status btn-card-toggle btn-uncheck-all" data-order-action="uncheck-all" data-customer-index="${index}">↺ Uncheck All</button>
    `;
}

function getItemIcon(description) {
    if (/milk/i.test(description)) return '🥛';
    if (/spam|canned/i.test(description)) return '🥫';
    if (/angel\s*bars?/i.test(description)) return '🍫';
    if (/cookie/i.test(description)) return '🍪';
    return '📦';
}

function updateAreaFilterOptions() {
    const select = document.getElementById('areaFilter');
    if (!select) return;

    const areas = [...new Set(appState.customerOrders.map(customer => getCustomerArea(customer.name)))]
        .sort((a, b) => a.localeCompare(b));
    if (appState.selectedArea && !areas.includes(appState.selectedArea)) appState.selectedArea = '';
    select.innerHTML = '<option value="">All areas</option>' + areas.map(area =>
        `<option value="${escapeHtml(area)}">${escapeHtml(area)}</option>`
    ).join('');
    select.value = appState.selectedArea;
}