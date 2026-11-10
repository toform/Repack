import { appState } from './config.js';
import { extractAreaCode, normalizeCustomerKey } from './utils.js';
import { saveBatchDraft, saveToLocalStorage, transitionToNewBatch } from './storage.js';
import { renderCards, showAppToast } from './renderCards.js';
import { renderBatchHistory, updateSummaryStats } from './sidebar.js';
import { initializeKioskEntry, setKioskEntryItems } from './kiosk.js';
import { getCatalogProducts, getProductUnitPrice } from './productCatalog.js';
const UNITS = ['BOX', 'BOXES', 'PCS'];
const DEFAULT_UNIT = 'BOXES';
const CURRENCY_FORMAT = '"₱"#,##0.00';
let loadedTemplateCustomerKey = null;
const selectedCustomerKeys = new Set();
let orderSelectionMode = 'single';
let selectedAreaFilter = '';
let pendingBatchOrders = null;

export function initializeOrderEntry() {
    const form = document.getElementById('repeatOrderForm');
    const rows = document.getElementById('repeatOrderItems');
    const customerGroups = document.getElementById('repeatOrderCustomerGroups');
    if (!form || !rows) return;

    form.noValidate = true;
    initializeKioskEntry(items => {
        rows.replaceChildren(...(items.length
            ? items.map(item => createItemRow(item))
            : [createItemRow()]));
        updateOrderTotals();
    });
    document.getElementById('repeatOrderCustomerSearch')?.addEventListener('input', refreshCustomerOptions);
    customerGroups?.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-repeat-customer]');
        if (!checkbox) return;
        if (orderSelectionMode === 'single') {
            selectedCustomerKeys.clear();
            if (checkbox.checked) selectedCustomerKeys.add(checkbox.value);
        } else if (checkbox.checked) {
            selectedCustomerKeys.add(checkbox.value);
        } else {
            selectedCustomerKeys.delete(checkbox.value);
        }
        updateCustomerSelection();
        refreshCustomerOptions();
    });
    document.getElementById('kioskSelectAllBtn')?.addEventListener('click', () => {
        const visible = getVisibleCustomerCheckboxes();
        if (orderSelectionMode === 'single') {
            selectedCustomerKeys.clear();
            if (visible[0]) selectedCustomerKeys.add(visible[0].value);
        } else {
            visible.forEach(checkbox => selectedCustomerKeys.add(checkbox.value));
        }
        updateCustomerSelection();
        refreshCustomerOptions();
    });
    document.getElementById('kioskDeselectAllBtn')?.addEventListener('click', () => {
        selectedCustomerKeys.clear();
        updateCustomerSelection();
        refreshCustomerOptions();
    });
    document.querySelectorAll('[data-order-mode]').forEach(button => {
        button.addEventListener('click', () => setOrderSelectionMode(button.dataset.orderMode));
    });
    document.getElementById('kioskAreaFilters')?.addEventListener('click', event => {
        const filter = event.target.closest('[data-area-filter]');
        if (!filter) return;
        selectedAreaFilter = filter.dataset.areaFilter;
        refreshCustomerOptions();
    });
    document.getElementById('reloadPreviousOrderBtn')?.addEventListener('click', () => {
        const [customer] = getSelectedCustomers();
        if (customer) loadCustomerOrder(customer);
    });
    document.getElementById('kioskExportExcelBtn')?.addEventListener('click', exportRepeatOrder);
    bindNewBatchDecisionControls();
    rows.addEventListener('input', updateOrderTotals);
    rows.addEventListener('change', event => {
        const productSelect = event.target.closest('[data-order-product]');
        if (productSelect) {
            const row = productSelect.closest('.repeat-order-row');
            const unitSelect = row?.querySelector('[data-order-unit]');
            if (unitSelect) unitSelect.value = inferUnit(productSelect.value);
            const priceInput = row?.querySelector('[data-order-price]');
            if (priceInput) priceInput.value = String(getProductUnitPrice(productSelect.value));
        }
        updateOrderTotals();
    });
    rows.addEventListener('click', event => {
        const quantityButton = event.target.closest('[data-quantity-step]');
        if (quantityButton) {
            const quantityInput = quantityButton.closest('.repeat-order-quantity-stepper')
                ?.querySelector('[data-order-quantity]');
            if (!quantityInput) return;
            const currentQuantity = Number(quantityInput.value) || 0;
            const step = Number(quantityButton.dataset.quantityStep);
            quantityInput.value = String(Math.max(0, currentQuantity + step));
            quantityInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
        const removeButton = event.target.closest('[data-remove-order-item]');
        if (!removeButton) return;
        const row = removeButton.closest('.repeat-order-row');
        if (row) row.remove();
        if (!rows.children.length) rows.appendChild(createItemRow());
        updateOrderTotals();
    });
    form.addEventListener('submit', event => {
        event.preventDefault();
        addOrderToBatch();
    });

    rows.appendChild(createItemRow());
    refreshCustomerOptions();
    updateOrderTotals();
}

function bindNewBatchDecisionControls() {
    const modal = document.getElementById('newBatchDecisionModal');
    const close = () => {
        modal?.classList.add('hidden');
        pendingBatchOrders = null;
    };
    document.getElementById('closeNewBatchDecision')?.addEventListener('click', close);
    document.getElementById('cancelNewBatchDecision')?.addEventListener('click', close);
    document.getElementById('btnDecisionArchive')?.addEventListener('click', () => {
        const archiveName = document.getElementById('currentBatchArchiveName')?.value.trim() || '';
        if (!archiveName) {
            document.getElementById('currentBatchArchiveName')?.focus();
            return;
        }
        activatePendingBatch(archiveName, 'ARCHIVE_OLD');
    });
    document.getElementById('btnDecisionDiscard')?.addEventListener('click', () => {
        if (!window.confirm('Sigurado ka bang gustong i-discard ang current active batch?')) return;
        activatePendingBatch('', 'DISCARD_OLD');
    });
    document.getElementById('saveNewBatchDraftBtn')?.addEventListener('click', () => {
        const draftName = document.getElementById('newBatchDraftName')?.value.trim() || '';
        if (!draftName) {
            document.getElementById('newBatchDraftName')?.focus();
            return;
        }
        savePendingBatchDraft(draftName);
    });
    modal?.addEventListener('click', event => {
        if (event.target === modal) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) close();
    });
}

function getSelectedCustomers() {
    return getOrderEntryCustomers().filter(customer =>
        selectedCustomerKeys.has(normalizeCustomerKey(customer.name))
    );
}

function getOrderEntryCustomers() {
    const activeOrders = appState.currentOrderEntry?.customerOrders || appState.customerOrders || [];
    const masterCustomers = appState.masterCustomers || [];
    const historyOrders = (appState.batchHistory || []).flatMap(batch => batch.customerOrders || []);
    const customersByKey = new Map();

    const addCustomerToMap = customer => {
        const name = String(customer?.name || '').trim();
        if (!name || /^CUSTOMER\s+\d+/i.test(name)) return;
        const key = normalizeCustomerKey(name);
        if (customersByKey.has(key)) return;

        customersByKey.set(key, {
            id: customer.id,
            name,
            area: customer.area || extractAreaCode(name).area,
            status: customer.status || 'pending',
            items: customer.items || customer.defaultItems || []
        });
    };

    activeOrders.forEach(addCustomerToMap);
    masterCustomers.forEach(addCustomerToMap);
    historyOrders.forEach(addCustomerToMap);

    return [...customersByKey.values()];
}

function getVisibleCustomerCheckboxes() {
    return [...(document.getElementById('repeatOrderCustomerGroups')?.querySelectorAll('[data-repeat-customer]') || [])];
}

function updateCustomerSelection() {
    const selected = getSelectedCustomers();
    const count = selected.length;
    const message = document.getElementById('repeatOrderBatchMessage');
    const summary = document.getElementById('repeatOrderSelectionSummary');
    const submitButton = document.getElementById('addRepeatOrderToBatchBtn');
    const reloadButton = document.getElementById('reloadPreviousOrderBtn');
    const activeCustomer = selected.find(customer =>
        normalizeCustomerKey(customer.name) === loadedTemplateCustomerKey
    ) || selected[0];
    if (message) {
        message.textContent = activeCustomer
            ? orderSelectionMode === 'individual' && count > 1
                ? `Preparing individual orders for ${count} selected customers.`
                : orderSelectionMode === 'batch' && count > 1
                    ? `Applying this order to ${count} selected customers.`
                    : `Editing order for ${activeCustomer.name}.`
            : 'Select a customer to load their previous order.';
    }
    if (summary) summary.textContent = `${count} Selected`;
    if (submitButton) submitButton.disabled = count === 0;
    if (reloadButton) reloadButton.disabled = count !== 1;

    if (count === 1 || (orderSelectionMode === 'batch' && count > 1)) {
        const customerKey = normalizeCustomerKey(activeCustomer.name);
        if (customerKey !== loadedTemplateCustomerKey) {
            loadCustomerOrder(activeCustomer);
        }
    } else {
        if (loadedTemplateCustomerKey) resetOrderItems();
        loadedTemplateCustomerKey = null;
    }

    updateOrderTotals();
}

function setOrderSelectionMode(mode) {
    if (!['single', 'batch', 'individual'].includes(mode) || mode === orderSelectionMode) return;
    orderSelectionMode = mode;
    document.querySelectorAll('[data-order-mode]').forEach(button => {
        const isActive = button.dataset.orderMode === mode;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });

    if (mode === 'individual') {
        const visible = getVisibleCustomerCheckboxes();
        selectedCustomerKeys.clear();
        visible.forEach(checkbox => selectedCustomerKeys.add(checkbox.value));
    } else if (mode === 'single' && selectedCustomerKeys.size > 1) {
        const firstCustomer = getSelectedCustomers()[0];
        selectedCustomerKeys.clear();
        if (firstCustomer) selectedCustomerKeys.add(normalizeCustomerKey(firstCustomer.name));
    }
    refreshCustomerOptions();
}

function reloadPreviousOrder() {
    const [customer] = getSelectedCustomers();
    if (customer) loadCustomerOrder(customer);
}

function loadCustomerOrder(customer) {
    const rows = document.getElementById('repeatOrderItems');
    if (!rows) return;
    const items = (customer.items || []).map(item => createItemRow(item));
    rows.replaceChildren(...(items.length ? items : [createItemRow()]));
    loadedTemplateCustomerKey = normalizeCustomerKey(customer.name);
    setKioskEntryItems(readCurrentOrderItems());
    const reloadButton = document.getElementById('reloadPreviousOrderBtn');
    if (reloadButton) reloadButton.disabled = getSelectedCustomers().length !== 1;
    updateOrderTotals();
    setStatus(`Loaded ${customer.name}'s previous order.`);
}

function resetOrderItems() {
    const rows = document.getElementById('repeatOrderItems');
    if (!rows) return;
    rows.replaceChildren(createItemRow());
    setKioskEntryItems([]);
    updateOrderTotals();
}

export function refreshCustomerOptions() {
    const list = document.getElementById('repeatOrderCustomerGroups');
    if (!list) return;
    const query = document.getElementById('repeatOrderCustomerSearch')?.value.trim().toLocaleLowerCase() || '';
    const uniqueNames = new Map();
    getOrderEntryCustomers().forEach(customer => {
        const name = String(customer.name || '').trim();
        if (name && !uniqueNames.has(normalizeCustomerKey(name))) {
            const { cleanName, area: parsedArea } = extractAreaCode(name);
            uniqueNames.set(normalizeCustomerKey(name), {
                name,
                cleanName,
                area: customer.area || parsedArea,
                items: customer.items || []
            });
        }
    });
    for (const key of selectedCustomerKeys) {
        if (!uniqueNames.has(key)) selectedCustomerKeys.delete(key);
    }

    const customers = [...uniqueNames.entries()].map(([key, customer]) => ({ key, ...customer }));
    renderAreaFilters(customers);

    if (!uniqueNames.size) {
        list.innerHTML = '<p class="batch-customer-empty">No customers are available in the master directory yet.</p>';
        updateCustomerSelection();
        return;
    }

    const filteredCustomers = customers
        .filter(customer => !query || `${customer.name} ${customer.area}`.toLocaleLowerCase().includes(query))
        .filter(customer => !selectedAreaFilter || customer.area === selectedAreaFilter)
        .sort((first, second) => first.name.localeCompare(second.name));
    list.innerHTML = filteredCustomers.length
        ? filteredCustomers.map(customer => {
            const isSelected = selectedCustomerKeys.has(customer.key);
            const isCurrent = customer.key === loadedTemplateCustomerKey;
            return `
                <label class="kiosk-cust-item${isSelected ? ' selected' : ''}${isCurrent ? ' current-order' : ''}">
                    <input type="checkbox" data-repeat-customer value="${escapeAttribute(customer.key)}" ${isSelected ? 'checked' : ''} aria-label="Select ${escapeHtml(customer.cleanName)}">
                    <span class="kiosk-cust-avatar" aria-hidden="true">${escapeHtml(getCustomerInitials(customer.cleanName))}</span>
                    <span class="kiosk-cust-info">
                        <strong>${escapeHtml(customer.cleanName)}</strong>
                        <small>${customer.area === 'NO_AREA' ? 'Unassigned' : `📍 ${escapeHtml(customer.area)}`}</small>
                    </span>
                </label>
            `;
        }).join('')
        : '<p class="batch-customer-empty">No customers match your search.</p>';
    updateCustomerSelection();
}

function renderAreaFilters(customers) {
    const filters = document.getElementById('kioskAreaFilters');
    if (!filters) return;
    const areas = [...new Set(customers.map(customer => customer.area))]
        .sort((first, second) => first === 'NO_AREA' ? 1 : second === 'NO_AREA' ? -1 : first.localeCompare(second));
    const validFilter = selectedAreaFilter === '' || areas.includes(selectedAreaFilter);
    if (!validFilter) selectedAreaFilter = '';
    filters.innerHTML = `
        <button type="button" class="kiosk-area-tab${selectedAreaFilter === '' ? ' active' : ''}" data-area-filter="">All</button>
        ${areas.map(area => `
            <button type="button" class="kiosk-area-tab${selectedAreaFilter === area ? ' active' : ''}" data-area-filter="${escapeAttribute(area)}">
                ${area === 'NO_AREA' ? 'Other' : escapeHtml(area)}
            </button>
        `).join('')}
    `;
}

export function loadArchivedBatchForEdit(batch) {
    if (!batch || !Array.isArray(batch.customerOrders) || !batch.customerOrders.length) return false;

    const previousOrders = appState.customerOrders;
    const previousEntry = appState.currentOrderEntry;
    const previousArchive = appState.editingArchivedBatch;
    appState.customerOrders = batch.customerOrders.map(customer => ({
        ...customer,
        items: (customer.items || []).map(item => ({ ...item }))
    }));
    appState.currentOrderEntry = null;
    appState.editingArchivedBatch = { id: batch.id, name: batch.name };
    if (!saveToLocalStorage()) {
        appState.customerOrders = previousOrders;
        appState.currentOrderEntry = previousEntry;
        appState.editingArchivedBatch = previousArchive;
        return false;
    }

    selectedCustomerKeys.clear();
    loadedTemplateCustomerKey = null;
    renderCards();
    updateSummaryStats();
    refreshCustomerOptions();
    return true;
}

function getCustomerInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return words.length === 1
        ? [...words[0]].slice(0, 2).join('').toLocaleUpperCase()
        : `${[...words[0]][0]}${[...words[1]][0]}`.toLocaleUpperCase();
}

function createItemRow(item = null) {
    const row = document.createElement('div');
    row.className = 'repeat-order-row';
    const description = String(item?.description || '');
    const products = getCatalogProducts().map(product => product.name);
    const matchingProduct = products.find(product => normalizeProduct(product) === normalizeProduct(description));
    const selectedProduct = matchingProduct || description;
    const productOptions = products.map(product =>
        `<option value="${escapeAttribute(product)}">${escapeHtml(product)}</option>`
    ).join('');
    const productOption = selectedProduct && !matchingProduct
        ? `<option value="${escapeAttribute(selectedProduct)}">${escapeHtml(selectedProduct)}</option>`
        : '';
    const selectedUnit = normalizeOrderUnit(item?.unit);
    const unitOptions = [...new Set([...UNITS, selectedUnit])].map(unit =>
        `<option value="${escapeAttribute(unit)}"${unit === selectedUnit ? ' selected' : ''}>${escapeHtml(unit)}</option>`
    ).join('');

    row.innerHTML = `
        <div class="repeat-order-row-toolbar">
            <span class="repeat-order-row-title">${item ? 'Repeat item' : 'New item'}</span>
            <button class="repeat-order-remove-btn" type="button" data-remove-order-item aria-label="Remove item" title="Remove item">🗑️</button>
        </div>
        <div class="repeat-order-product-field">
            <label>Item / Product
                <select data-order-product required>
                    <option value="">Select a product</option>
                    ${productOptions}
                    ${productOption}
                </select>
            </label>
        </div>
        <div>
            <label>Quantity
                <span class="repeat-order-quantity-stepper">
                    <button class="repeat-order-step-btn" type="button" data-quantity-step="-1" aria-label="Decrease quantity">−</button>
                    <input data-order-quantity type="number" min="0" step="any" inputmode="decimal" placeholder="0" value="${item ? escapeAttribute(item.qty) : ''}" required>
                    <button class="repeat-order-step-btn" type="button" data-quantity-step="1" aria-label="Increase quantity">+</button>
                </span>
            </label>
        </div>
        <div>
            <label>Unit
                <select data-order-unit>${unitOptions}</select>
            </label>
        </div>
        <div>
            <label>Unit Price (₱)
                <input data-order-price type="number" min="0" step="0.01" inputmode="decimal" value="${getDefaultPrice(item)}">
            </label>
        </div>
        <div class="repeat-order-line-total"><span>Line Total</span><strong data-order-line-total>₱0.00</strong></div>
    `;
    if (selectedProduct) row.querySelector('[data-order-product]').value = selectedProduct;
    return row;
}

function normalizeOrderUnit(unit) {
    const value = String(unit || '').trim();
    const normalized = value.toLocaleUpperCase();
    if (/^BOX$/.test(normalized)) return 'BOX';
    if (/^BOXES$/.test(normalized)) return 'BOXES';
    if (/^(?:PCS?|PIECES?)$/.test(normalized)) return 'PCS';
    return value || DEFAULT_UNIT;
}

function getDefaultPrice(item) {
    return getProductUnitPrice(item);
}

function inferUnit(product) {
    const productKey = normalizeProduct(product);
    const catalogProduct = getCatalogProducts().find(entry => normalizeProduct(entry.name) === productKey);
    if (catalogProduct) return catalogProduct.unit;
    const counts = new Map();
    getOrderEntryCustomers().forEach(customer => {
        (customer.items || []).forEach(item => {
            if (normalizeProduct(item.description) !== productKey) return;
            const rawUnit = String(item.unit || '').trim().toLocaleUpperCase();
            const unit = /^BOX(?:ES)?$/.test(rawUnit) ? rawUnit
                : /^(?:PCS?|PIECES?)$/.test(rawUnit) ? 'PCS' : '';
            if (unit) counts.set(unit, (counts.get(unit) || 0) + 1);
        });
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || DEFAULT_UNIT;
}

function readOrder(customerName) {
    const rows = [...(document.getElementById('repeatOrderItems')?.children || [])];
    const items = rows.map(row => {
        const description = row.querySelector('[data-order-product]')?.value || '';
        const qty = Number(row.querySelector('[data-order-quantity]')?.value);
        const unit = row.querySelector('[data-order-unit]')?.value || DEFAULT_UNIT;
        const unitPrice = Number(row.querySelector('[data-order-price]')?.value);
        const catalogProduct = getCatalogProducts().find(product =>
            normalizeProduct(product.name) === normalizeProduct(description)
        );
        return { description, category: catalogProduct?.exportCategory || catalogProduct?.category, qty, unit, unitPrice };
    });
    const invalid = !customerName
        || !items.length
        || items.some(item => !item.description.trim()
            || !Number.isFinite(item.qty) || item.qty <= 0
            || !item.unit.trim()
            || !Number.isFinite(item.unitPrice) || item.unitPrice < 0);

    if (invalid) {
        setStatus('Complete each item row with a valid product, quantity, unit, and price.', true);
        return null;
    }

    return { customerName, items };
}

function updateOrderTotals() {
    const preview = document.getElementById('repeatOrderKioskPreview');
    const selectedItems = readCurrentOrderItems();
    if (preview) {
        preview.innerHTML = selectedItems.length
            ? selectedItems.map(item => `
                <div class="repeat-order-kiosk-item">
                    <span><span aria-hidden="true">${getProductIcon(item.description)}</span> ${escapeHtml(item.description)}</span>
                    <strong>${escapeHtml(item.qty)} ${escapeHtml(item.unit)}</strong>
                    <span>${formatCurrency(item.qty * item.unitPrice)}</span>
                </div>
            `).join('')
            : '<p class="repeat-order-kiosk-empty">No products selected yet. Tap a product on the catalog to add it.</p>';
    }

    if (orderSelectionMode === 'individual') {
        let overallItems = 0;
        let overallPrice = 0;

        getSelectedCustomers().forEach(customer => {
            const items = customer.items?.length ? customer.items : customer.defaultItems || [];
            items.forEach(item => {
                const quantity = Number(item.qty) || 0;
                overallItems += quantity;
                overallPrice += quantity * getDefaultPrice(item);
            });
        });

        const quantityElement = document.getElementById('repeatOrderQuantityTotal');
        const priceElement = document.getElementById('repeatOrderPriceTotal');
        const priceLabel = document.getElementById('repeatOrderPriceLabel');
        if (quantityElement) quantityElement.textContent = overallItems.toLocaleString();
        if (priceElement) priceElement.textContent = formatCurrency(overallPrice);
        if (priceLabel) priceLabel.textContent = 'Batch Order Total (Individual):';
        return;
    }

    const rows = [...(document.getElementById('repeatOrderItems')?.children || [])];
    let quantityTotal = 0;
    let priceTotal = 0;
    rows.forEach(row => {
        const qty = Number(row.querySelector('[data-order-quantity]')?.value) || 0;
        const price = Number(row.querySelector('[data-order-price]')?.value) || 0;
        const lineTotal = qty * price;
        quantityTotal += qty;
        priceTotal += lineTotal;
        const lineTotalElement = row.querySelector('[data-order-line-total]');
        if (lineTotalElement) lineTotalElement.textContent = formatCurrency(lineTotal);
    });
    const quantityElement = document.getElementById('repeatOrderQuantityTotal');
    const priceElement = document.getElementById('repeatOrderPriceTotal');
    const selectedCount = getSelectedCustomers().length;
    const batchCount = orderSelectionMode === 'batch' ? selectedCount : 1;
    const batchTotalQuantity = quantityTotal * batchCount;
    const batchTotalPrice = priceTotal * batchCount;
    const priceLabel = document.getElementById('repeatOrderPriceLabel');
    if (quantityElement) quantityElement.textContent = batchTotalQuantity.toLocaleString();
    if (priceElement) priceElement.textContent = formatCurrency(batchTotalPrice);
    if (priceLabel) priceLabel.textContent = orderSelectionMode === 'batch' ? 'Batch Order Total:' : 'Order Total:';
}

function readCurrentOrderItems() {
    return [...(document.getElementById('repeatOrderItems')?.children || [])]
        .map(row => {
            const description = row.querySelector('[data-order-product]')?.value.trim() || '';
            const product = getCatalogProducts().find(entry =>
                normalizeProduct(entry.name) === normalizeProduct(description)
            );
            return {
                description,
                category: product?.exportCategory || product?.category,
                qty: Number(row.querySelector('[data-order-quantity]')?.value),
                unit: row.querySelector('[data-order-unit]')?.value || DEFAULT_UNIT,
                unitPrice: Number(row.querySelector('[data-order-price]')?.value)
            };
        })
        .filter(item => item.description && Number.isFinite(item.qty) && item.qty > 0)
        .map(item => ({ ...item, unitPrice: Number.isFinite(item.unitPrice) && item.unitPrice >= 0 ? item.unitPrice : 0 }));
}

function getProductIcon(description) {
    const catalogProduct = getCatalogProducts().find(product =>
        normalizeProduct(product.name) === normalizeProduct(description)
    );
    if (catalogProduct) return catalogProduct.icon;
    const value = String(description || '').toLocaleLowerCase();
    if (/mango/.test(value)) return '🥭';
    if (/angel bars/.test(value)) return '🍫';
    if (/milk/.test(value)) return '🥛';
    if (/spam/.test(value)) return '🥫';
    if (/cake|tais[a]?n|pastr/.test(value)) return '🍰';
    if (/cookie|lecheroon/.test(value)) return '🍪';
    return '📦';
}

function addOrderToBatch() {
    const selected = getSelectedCustomers();
    if (!selected.length) {
        setStatus('Select at least one customer for the repeat-order batch.', true);
        return;
    }

    const editedCustomer = selected.find(customer =>
        normalizeCustomerKey(customer.name) === loadedTemplateCustomerKey
    );
    const editedOrder = editedCustomer ? readOrder(editedCustomer.name) : null;
    if (editedCustomer && !editedOrder) return;

    pendingBatchOrders = selected.map(customer => {
        const isEditedCustomer = editedCustomer 
            && normalizeCustomerKey(customer.name) === loadedTemplateCustomerKey;

        let sourceItems;
        if (isEditedCustomer) {
            sourceItems = editedOrder.items;
        } else if (orderSelectionMode === 'batch' && editedOrder) {
            sourceItems = editedOrder.items;
        } else {
            sourceItems = customer.items && customer.items.length ? customer.items : customer.defaultItems || [];
        }

        return {
            id: customer.id || globalThis.crypto?.randomUUID?.() || `customer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: formatCustomerName(customer.name),
            status: 'pending',
            items: sourceItems.map(item => ({
                description: item.description,
                category: item.category || getCatalogProducts().find(product =>
                    normalizeProduct(product.name) === normalizeProduct(item.description)
                )?.exportCategory,
                qty: Number(item.qty),
                unit: item.unit || DEFAULT_UNIT,
                unitPrice: getDefaultPrice(item),
                checked: false
            }))
        };
    });

    if (appState.customerOrders.length) {
        document.getElementById('newBatchDecisionModal')?.classList.remove('hidden');
        return;
    }

    activatePendingBatch('', 'DISCARD_OLD');
}

function activatePendingBatch(archiveName, transition = 'ARCHIVE_OLD') {
    if (!pendingBatchOrders?.length) {
        setStatus('There is no prepared order batch to activate. Select customers and items first.', true);
        return;
    }
    const customerCount = pendingBatchOrders.length;
    if (!transitionToNewBatch(pendingBatchOrders, transition, archiveName)) {
        setStatus('The new batch could not be saved. Your active checklist and archives were not changed.', true);
        return;
    }

    finishBatchCreation();
    showRepackingView();
    showAppToast(`Naidagdag/Na-update ang order para sa ${customerCount} customer(s)!`);
}

function savePendingBatchDraft(name) {
    if (!pendingBatchOrders?.length) {
        setStatus('There is no prepared order batch to save. Select customers and items first.', true);
        return;
    }
    const batch = saveBatchDraft(name, pendingBatchOrders);
    if (!batch) {
        setStatus('The batch draft could not be saved. Your active checklist was not changed.', true);
        return;
    }

    finishBatchCreation();
    renderBatchHistory();
    showAppToast(`💾 "${batch.name}" saved to Archives as a draft.`);
}

function finishBatchCreation() {
    document.getElementById('newBatchDecisionModal')?.classList.add('hidden');
    pendingBatchOrders = null;
    appState.activeTab = 'pending';
    appState.customerSearchQuery = '';
    appState.selectedArea = '';
    const search = document.getElementById('customerSearch');
    if (search) search.value = '';
    const area = document.getElementById('areaFilter');
    if (area) area.value = '';
    document.querySelectorAll('.tab-btn[data-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === 'pending');
    });
    renderCards();
    updateSummaryStats();
    renderBatchHistory();
    selectedCustomerKeys.clear();
    loadedTemplateCustomerKey = null;
    resetOrderItems();
    refreshCustomerOptions();
    setStatus('');
}

function showRepackingView() {
    document.querySelectorAll('.app-view').forEach(view => {
        view.classList.toggle('hidden', view.id !== 'repackingView');
    });
}

function formatCurrentDate() {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
}

function exportRepeatOrder() {
    const selected = getSelectedCustomers();
    if (!selected.length || (orderSelectionMode === 'single' && selected.length !== 1)) {
        setStatus(orderSelectionMode === 'single'
            ? 'Select one customer to export a repeat order.'
            : 'Select at least one customer to export this batch order.', true);
        return;
    }
    const order = readOrder(selected[0].name);
    if (!order) return;
    if (typeof XLSX === 'undefined') {
        setStatus('Excel export is unavailable. Check that the SheetJS library loaded.', true);
        return;
    }

    try {
        const batchData = orderSelectionMode === 'batch'
            ? selected.map(customer => ({ name: formatCustomerName(customer.name), items: order.items }))
            : [{ name: order.customerName, items: order.items }];
        const batchLabel = orderSelectionMode === 'batch'
            ? `BATCH REPEAT ORDER - ${selected.length} CUSTOMERS`
            : `REPEAT ORDER - ${order.customerName}`;
        const filename = orderSelectionMode === 'batch'
            ? `batch-repeat-orders-${selected.length}-customers.xlsx`
            : `${safeFilename(order.customerName)}-repeat-order.xlsx`;
        generateMasterExcelExport(batchData, batchLabel, filename);
        setStatus('Repeat order exported to Excel.');
    } catch (error) {
        console.error('Repeat order Excel export failed:', error);
        setStatus('Could not export the Excel file. Check the browser download settings.', true);
    }
}

export function exportArchivedBatch(batch) {
    if (!batch || typeof XLSX === 'undefined') return false;

    try {
        generateMasterExcelExport(
            batch.customerOrders,
            batch.name,
            `${safeFilename(batch.name)}-archive.xlsx`
        );
        return true;
    } catch (error) {
        console.error('Archived batch Excel export failed:', error);
        return false;
    }
}

function showRepeatOrderToast(customerCount) {
    document.querySelector('.app-toast.toast-success')?.remove();
    const toast = document.createElement('div');
    toast.className = 'app-toast toast-success';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = `Successfully loaded repeat orders for ${customerCount} customers!`;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3500);
}

function generateMasterExcelExport(batchData, batchLabel, filename) {
    const workbook = XLSX.utils.book_new();
    const columns = ['NO.', 'NAME', 'QTY', 'UNIT', 'PCS/SIZE', 'PARTICULAR', 'AMOUNT', 'SUB TOTAL'];
    const sheetDefinitions = [
        { name: 'STL ACTUAL', matches: item => !isMilkOrSpamItem(item) },
        { name: 'MILK ACTUAL', matches: isMilkOrSpamItem }
    ];

    sheetDefinitions.forEach(({ name, matches }) => {
        const sheetItems = batchData.flatMap(customer =>
            (customer.items || [])
                .filter(matches)
                .map(item => ({
                    ...item,
                    customerName: customer.name,
                    unitPrice: getDefaultPrice(item)
                }))
        );
        addOrderSheet(workbook, name, columns, '', sheetItems);
    });

    XLSX.writeFile(workbook, filename);
}

function isMilkOrSpamItem(item) {
    const category = String(item.category || '').toLocaleLowerCase();
    const description = String(item.description || '').toLocaleLowerCase();
    return /milk|spam/.test(`${category} ${description}`);
}

function getItemSize(description) {
    const match = String(description || '').match(/\b\d+\s*(?:pcs?|pieces?|s)\b/i);
    return match ? match[0].trim() : '';
}

function addOrderSheet(workbook, sheetName, columns, customerName, items) {
    if (!items || !items.length) return;

    const isMultiCustomerBatch = Array.isArray(items) && items.length > 0 && items[0].customerName;
    const rows = [columns];
    const merges = [];
    let groupedCustomers = [];

    if (isMultiCustomerBatch) {
        const map = new Map();
        items.forEach(item => {
            const name = item.customerName || customerName;
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(item);
        });
        groupedCustomers = Array.from(map.entries()).map(([name, custItems]) => ({ name, items: custItems }));
    } else {
        groupedCustomers = [{ name: customerName, items }];
    }

    let currentRow = 1;
    let overallGrandTotal = 0;
    let overallTotalQty = 0;

    groupedCustomers.forEach((custGroup, custIdx) => {
        const startRow = currentRow;
        const custItems = custGroup.items;
        let custSubtotal = 0;

        custItems.forEach((item, itemIdx) => {
            const qty = Number(item.qty) || 0;
            const price = getProductUnitPrice(item);
            const lineTotal = qty * price;
            custSubtotal += lineTotal;
            overallTotalQty += qty;
            const isLastItem = itemIdx === custItems.length - 1;

            rows.push([
                custIdx + 1,
                custGroup.name,
                qty,
                item.unit || 'BOX',
                item.size || item.pcs || getItemSize(item.description),
                item.description,
                lineTotal,
                isLastItem ? custSubtotal : ''
            ]);

            currentRow++;
        });

        const endRow = currentRow - 1;
        overallGrandTotal += custSubtotal;
        if (endRow >= startRow) {
            merges.push({ s: { r: startRow, c: 0 }, e: { r: endRow, c: 0 } });
            merges.push({ s: { r: startRow, c: 1 }, e: { r: endRow, c: 1 } });
        }
    });

    const totalRowIndex = currentRow;
    rows.push([
        '',
        '',
        overallTotalQty,
        '',
        '',
        'OVERALL GRAND TOTAL',
        '',
        overallGrandTotal
    ]);

    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [
        { wch: 6 },
        { wch: 26 },
        { wch: 8 },
        { wch: 10 },
        { wch: 12 },
        { wch: 42 },
        { wch: 15 },
        { wch: 18 }
    ];
    sheet['!merges'] = merges;

    const thinBorder = {
        top: { style: 'thin', color: { rgb: 'A0A0A0' } },
        bottom: { style: 'thin', color: { rgb: 'A0A0A0' } },
        left: { style: 'thin', color: { rgb: 'A0A0A0' } },
        right: { style: 'thin', color: { rgb: 'A0A0A0' } }
    };
    const bgColors = ['FFFFFF', 'FDFBF5'];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    let currentCustColorIdx = 0;
    let lastSeenNo = null;

    for (let row = range.s.r; row <= range.e.r; row++) {
        if (row > 0 && row < totalRowIndex) {
            const noValue = sheet[XLSX.utils.encode_cell({ r: row, c: 0 })]?.v;
            if (noValue !== undefined && noValue !== '' && noValue !== lastSeenNo) {
                lastSeenNo = noValue;
                currentCustColorIdx = (currentCustColorIdx + 1) % bgColors.length;
            }
        }
        const blockBgColor = row === totalRowIndex ? 'B8860B' : bgColors[currentCustColorIdx];

        for (let column = range.s.c; column <= range.e.c; column++) {
            const cellRef = XLSX.utils.encode_cell({ c: column, r: row });
            if (!sheet[cellRef]) sheet[cellRef] = { v: '', t: 's' };
            const cell = sheet[cellRef];
            cell.s = {
                border: thinBorder,
                alignment: { vertical: 'center', horizontal: 'left' },
                fill: { fgColor: { rgb: blockBgColor } }
            };

            if (row === 0) {
                cell.s.font = { bold: true, color: { rgb: 'FFFFFF' }, name: 'Calibri', sz: 11 };
                cell.s.fill = { fgColor: { rgb: 'B8860B' } };
                cell.s.alignment = { vertical: 'center', horizontal: 'center' };
            } else if (row > 0 && row < totalRowIndex) {
                if (column === 0 || column === 2) cell.s.alignment.horizontal = 'center';
                if (column === 1) {
                    cell.s.font = { bold: true, name: 'Calibri', sz: 10 };
                    cell.s.alignment.vertical = 'center';
                }
                if ((column === 6 || column === 7) && typeof cell.v === 'number') {
                    cell.z = '"₱"#,##0.00';
                    cell.s.numFmt = '"₱"#,##0.00';
                    cell.s.alignment.horizontal = 'right';
                }
                if (column === 7 && cell.v !== '' && cell.v !== undefined) {
                    cell.s.font = { bold: true, color: { rgb: '2C221E' }, name: 'Calibri', sz: 11 };
                    cell.s.fill = { fgColor: { rgb: 'F4E6BF' } };
                    cell.s.border = {
                        top: { style: 'thin', color: { rgb: '8B6508' } },
                        bottom: { style: 'double', color: { rgb: '8B6508' } },
                        left: { style: 'thin', color: { rgb: '8B6508' } },
                        right: { style: 'thin', color: { rgb: '8B6508' } }
                    };
                }
            } else if (row === totalRowIndex) {
                cell.s.font = { bold: true, color: { rgb: 'FFFFFF' }, name: 'Calibri', sz: 11 };
                cell.s.fill = { fgColor: { rgb: 'B8860B' } };
                cell.s.border = {
                    top: { style: 'medium', color: { rgb: '8B6508' } },
                    bottom: { style: 'double', color: { rgb: 'FFFFFF' } },
                    left: { style: 'thin', color: { rgb: '8B6508' } },
                    right: { style: 'thin', color: { rgb: '8B6508' } }
                };
                if (column === 2) cell.s.alignment.horizontal = 'center';
                if (column === 5) cell.s.alignment.horizontal = 'right';
                if (column === 7) {
                    cell.z = '"₱"#,##0.00';
                    cell.s.numFmt = '"₱"#,##0.00';
                    cell.s.alignment.horizontal = 'right';
                }
            }
        }
    }

    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
}

function formatCustomerName(name) {
    const { cleanName, area } = extractAreaCode(name);
    return area === 'NO_AREA' ? name.trim() : `${cleanName} (${area})`;
}

function setStatus(message, isError = false) {
    const status = document.getElementById('repeatOrderStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
}

function formatCurrency(value) {
    return `₱${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function normalizeProduct(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeFilename(value) {
    return String(value || 'customer')
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
        .trim()
        .replace(/\s+/g, '-') || 'customer';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function escapeAttribute(value) {
    return escapeHtml(value);
}
