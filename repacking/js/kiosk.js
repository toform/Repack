import { appState } from './config.js';
import { renderCards, showAppToast } from './renderCards.js';
import { updateDashboardBadges, updateSummaryStats } from './sidebar.js';
import { saveCustomProducts, saveToLocalStorage } from './storage.js';
import { getCatalogCategory, getCatalogProducts, getProductUnitPrice } from './productCatalog.js';

let kioskSession = null;
let activeCategory = 'all';
let entryProducts = [];
let entryCategory = 'all';
let entryOnChange = () => {};

export function initializeKiosk() {
    const overlay = document.getElementById('kioskModalOverlay');
    if (!overlay) return;

    document.getElementById('kioskCategoryTabs')?.addEventListener('click', event => {
        const tab = event.target.closest('[data-category]');
        if (!tab) return;
        activeCategory = tab.dataset.category;
        document.querySelectorAll('.kiosk-tab-btn').forEach(button => {
            button.classList.toggle('active', button === tab);
        });
        renderKioskProducts();
    });

    document.getElementById('kioskProductsGrid')?.addEventListener('click', event => {
        const button = event.target.closest('[data-quantity-step]');
        if (!button || !kioskSession) return;
        const entry = kioskSession.products[Number(button.dataset.productIndex)];
        if (!entry) return;
        entry.qty = Math.max(0, entry.qty + Number(button.dataset.quantityStep));
        renderKioskProducts();
        updateKioskSummary();
    });

    document.getElementById('kioskProductsGrid')?.addEventListener('input', event => {
        const input = event.target.closest('[data-product-quantity]');
        if (!input || !kioskSession) return;
        const entry = kioskSession.products[Number(input.dataset.productIndex)];
        if (!entry) return;
        const quantity = Number(input.value);
        entry.qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
        input.closest('.kiosk-product-card')?.classList.toggle('has-qty', entry.qty > 0);
        updateKioskSummary();
    });

    document.getElementById('closeKioskModalBtn')?.addEventListener('click', closeKiosk);
    document.getElementById('cancelKioskBtn')?.addEventListener('click', closeKiosk);
    document.getElementById('saveKioskOrderBtn')?.addEventListener('click', saveKiosk);
    bindProductCreation();
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeKiosk();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !overlay.classList.contains('hidden')) closeKiosk();
    });
}

function bindProductCreation() {
    const modal = document.getElementById('addProductModal');
    const form = document.getElementById('addProductForm');
    const close = () => modal?.classList.add('hidden');

    document.addEventListener('click', event => {
        if (!event.target.closest('[data-open-add-product]')) return;
        modal?.classList.remove('hidden');
        document.getElementById('prodName')?.focus();
    });
    document.getElementById('closeAddProductModal')?.addEventListener('click', close);
    document.getElementById('cancelAddProduct')?.addEventListener('click', close);
    modal?.addEventListener('click', event => {
        if (event.target === modal) close();
    });
    form?.addEventListener('submit', event => {
        event.preventDefault();
        const description = document.getElementById('prodName')?.value.trim() || '';
        const category = document.getElementById('prodCategory')?.value || '';
        const unit = document.getElementById('prodUnit')?.value.trim() || '';
        const unitPrice = Number(document.getElementById('prodPrice')?.value);
        const icon = document.getElementById('prodIcon')?.value || '';
        if (!description || !category || !unit || !Number.isFinite(unitPrice) || unitPrice < 0 || !icon) {
            showAppToast('Enter a product name, category, unit, and valid non-negative price.', 'error');
            return;
        }
        if (getCatalogProducts().some(product => normalizeProduct(product.name) === normalizeProduct(description))) {
            showAppToast('A product with that name is already in the catalog.', 'error');
            return;
        }

        const product = {
            id: globalThis.crypto?.randomUUID?.() || `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            description,
            category,
            unit,
            unitPrice,
            icon
        };
        const previousProducts = appState.customProducts;
        appState.customProducts = [...previousProducts, product];
        if (!saveCustomProducts()) {
            appState.customProducts = previousProducts;
            showAppToast('The product could not be saved to the catalog.', 'error');
            return;
        }

        const catalogProduct = getCatalogProducts().find(entry => entry.customProductId === product.id);
        if (kioskSession && catalogProduct) kioskSession.products.push(createKioskProduct(catalogProduct, []));
        if (entryOnChange && catalogProduct) entryProducts.push(createKioskProduct(catalogProduct, []));
        entryCategory = getCatalogCategory(category);
        activeCategory = getCatalogCategory(category);
        updateCatalogTabState();
        renderKioskProducts();
        renderEntryProducts();
        updateDashboardBadges();
        close();
        form.reset();
        showAppToast(`✨ Added "${description}" to the product catalog!`);
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) close();
    });
}

function updateCatalogTabState() {
    document.querySelectorAll('.kiosk-tab-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.category === activeCategory);
    });
    document.querySelectorAll('#kioskCatalogTabs [data-cat]').forEach(button => {
        button.classList.toggle('active', button.dataset.cat === entryCategory);
    });
}

export function initializeKioskEntry(onItemsChange) {
    const grid = document.getElementById('kioskCatalogGrid');
    const tabs = document.getElementById('kioskCatalogTabs');
    if (!grid || !tabs) return;
    entryOnChange = onItemsChange;

    tabs.addEventListener('click', event => {
        const tab = event.target.closest('[data-cat]');
        if (!tab) return;
        entryCategory = tab.dataset.cat;
        tabs.querySelectorAll('[data-cat]').forEach(button => {
            button.classList.toggle('active', button === tab);
        });
        renderEntryProducts();
    });

    grid.addEventListener('click', event => {
        const button = event.target.closest('[data-entry-quantity-step]');
        if (!button) return;
        const product = entryProducts[Number(button.dataset.productIndex)];
        if (!product) return;
        product.qty = Math.max(0, product.qty + Number(button.dataset.entryQuantityStep));
        renderEntryProducts();
        entryOnChange(getProductItems(entryProducts));
    });

    grid.addEventListener('input', event => {
        const input = event.target.closest('[data-entry-product-quantity]');
        if (!input) return;
        const product = entryProducts[Number(input.dataset.productIndex)];
        if (!product) return;
        const quantity = Number(input.value);
        product.qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
        input.closest('.catalog-product-card')?.classList.toggle('has-qty', product.qty > 0);
        const indicator = input.closest('.catalog-product-card')?.querySelector('.catalog-selected-indicator');
        if (indicator) indicator.hidden = product.qty === 0;
        entryOnChange(getProductItems(entryProducts));
    });

    setKioskEntryItems([]);
}

export function setKioskEntryItems(items) {
    entryProducts = createKioskProducts(items);
    renderEntryProducts();
}

export function openKiosk({ title, items = [], onSave }) {
    const overlay = document.getElementById('kioskModalOverlay');
    const titleElement = document.getElementById('kioskCustomerName');
    if (!overlay || !titleElement || typeof onSave !== 'function') return false;

    const products = createKioskProducts(items);

    kioskSession = { products, onSave };
    activeCategory = 'all';
    document.querySelectorAll('.kiosk-tab-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.category === 'all');
    });
    titleElement.textContent = title || 'Edit Order';
    renderKioskProducts();
    updateKioskSummary();
    overlay.classList.remove('hidden');
    document.getElementById('saveKioskOrderBtn')?.focus();
    return true;
}

export function openCustomerKiosk(customerIndex) {
    const customer = appState.customerOrders[customerIndex];
    if (!customer) return false;

    return openKiosk({
        title: customer.name,
        items: customer.items || [],
        onSave: items => {
            const previousItems = customer.items;
            const previousStatus = customer.status;
            customer.items = items;
            const packedCount = items.filter(item => item.checked).length;
            customer.status = items.length && packedCount === items.length
                ? 'completed'
                : packedCount ? 'incomplete' : 'pending';

            if (!saveToLocalStorage()) {
                customer.items = previousItems;
                customer.status = previousStatus;
                showAppToast('Changes could not be saved. The customer order was not updated.', 'error');
                return false;
            }

            renderCards();
            updateSummaryStats();
            showAppToast(`${customer.name}'s order updated.`);
            return true;
        }
    });
}

export function closeKiosk() {
    document.getElementById('kioskModalOverlay')?.classList.add('hidden');
    kioskSession = null;
}

function createKioskProduct(product, items) {
    const key = normalizeProduct(product.name);
    const matchingItems = (items || []).filter(item => normalizeProduct(item.description) === key);
    const quantity = matchingItems.reduce((total, item) => total + (Number(item.qty) || 0), 0);
    const previous = matchingItems[0];
    const historicalPrice = findHistoricalPrice(key);
    const savedPrice = Number(previous?.unitPrice ?? previous?.defaultPrice ?? previous?.price);
    const price = Number.isFinite(savedPrice) && savedPrice >= 0
        ? savedPrice
        : getProductUnitPrice(product) || historicalPrice || 0;

    return {
        ...product,
        key,
        qty: quantity,
        originalQty: quantity,
        originalChecked: matchingItems.length > 0 && matchingItems.every(item => item.checked),
        unit: previous?.unit || product.unit,
        price
    };
}

function createKioskProducts(items) {
    const products = getCatalogProducts().map(product => createKioskProduct(product, items));
    const catalogKeys = new Set(products.map(product => product.key));
    (items || []).forEach(item => {
        const key = normalizeProduct(item.description);
        if (key && !catalogKeys.has(key)) {
            products.push(createKioskProduct({
                name: String(item.description),
                category: 'Other',
                exportCategory: item.category || 'Other',
                icon: '📦',
                unit: item.unit || 'BOXES'
            }, items));
            catalogKeys.add(key);
        }
    });
    return products;
}

function findHistoricalPrice(key) {
    const customers = [
        ...appState.customerOrders,
        ...appState.batchHistory.flatMap(batch => batch.customerOrders || [])
    ];
    for (const customer of customers) {
        for (const item of customer.items || []) {
            if (normalizeProduct(item.description) !== key) continue;
            const price = getProductUnitPrice(item);
            if (Number.isFinite(price) && price >= 0) return price;
        }
    }
    return null;
}

function renderKioskProducts() {
    const grid = document.getElementById('kioskProductsGrid');
    if (!grid || !kioskSession) return;

    const visibleProducts = kioskSession.products.filter(product =>
        activeCategory === 'all'
            || product.category === activeCategory
            || (activeCategory === 'all' && product.category === 'Other')
    );
    grid.innerHTML = visibleProducts.map(product => {
        const index = kioskSession.products.indexOf(product);
        return `
            <article class="kiosk-product-card${product.qty > 0 ? ' has-qty' : ''}">
                <div class="kiosk-product-icon" aria-hidden="true">${escapeHtml(product.icon)}</div>
                <h3 class="kiosk-product-name">${escapeHtml(product.name)}</h3>
                <span class="kiosk-product-unit">${escapeHtml(product.unit || 'BOXES')}</span>
                <p class="kiosk-product-price">${formatCurrency(product.price)}</p>
                <div class="kiosk-stepper">
                    <button type="button" class="kiosk-stepper-btn" data-quantity-step="-1" data-product-index="${index}" aria-label="Decrease ${escapeHtml(product.name)} quantity">−</button>
                    <input class="kiosk-qty-input" type="number" min="0" step="any" inputmode="decimal" value="${product.qty || ''}" placeholder="0" data-product-quantity data-product-index="${index}" aria-label="${escapeHtml(product.name)} quantity">
                    <button type="button" class="kiosk-stepper-btn" data-quantity-step="1" data-product-index="${index}" aria-label="Increase ${escapeHtml(product.name)} quantity">+</button>
                </div>
                ${product.qty > 0 ? '<span class="kiosk-selected-indicator">Added to order</span>' : ''}
            </article>
        `;
    }).join('') + renderAddProductTile();
}

function renderEntryProducts() {
    const grid = document.getElementById('kioskCatalogGrid');
    if (!grid) return;
    const visibleProducts = entryProducts.filter(product =>
        entryCategory === 'all'
            || product.category === entryCategory
            || (entryCategory === 'all' && product.category === 'Other')
    );
    grid.innerHTML = visibleProducts.map(product => {
        const index = entryProducts.indexOf(product);
        return `
            <article class="catalog-product-card${product.qty > 0 ? ' has-qty' : ''}">
                <div class="catalog-product-icon" aria-hidden="true">${escapeHtml(product.icon)}</div>
                <h3 class="catalog-product-title">${escapeHtml(product.name)}</h3>
                <span class="kiosk-product-unit">${escapeHtml(product.unit || 'BOXES')}</span>
                <p class="catalog-product-price">${formatCurrency(product.price)}</p>
                <div class="kiosk-card-stepper">
                    <button type="button" data-entry-quantity-step="-1" data-product-index="${index}" aria-label="Decrease ${escapeHtml(product.name)} quantity">−</button>
                    <input type="number" min="0" step="any" inputmode="decimal" value="${product.qty || ''}" placeholder="0" data-entry-product-quantity data-product-index="${index}" aria-label="${escapeHtml(product.name)} quantity">
                    <button type="button" data-entry-quantity-step="1" data-product-index="${index}" aria-label="Increase ${escapeHtml(product.name)} quantity">+</button>
                </div>
                <span class="catalog-selected-indicator"${product.qty > 0 ? '' : ' hidden'}>Added to order</span>
            </article>
        `;
    }).join('') + renderAddProductTile();
}

function renderAddProductTile() {
    return `
        <button type="button" class="catalog-product-card add-product-card" data-open-add-product>
            <span class="add-product-icon" aria-hidden="true">➕</span>
            <span class="add-product-title">Add New Product</span>
            <span class="add-product-desc">Create a custom catalog item</span>
        </button>
    `;
}

function getProductItems(products) {
    return products.filter(product => product.qty > 0).map(product => ({
        description: product.name,
        category: product.exportCategory || product.category,
        qty: product.qty,
        unit: product.unit,
        unitPrice: product.price,
        checked: product.qty === product.originalQty && product.originalChecked
    }));
}

function updateKioskSummary() {
    if (!kioskSession) return;
    const selected = kioskSession.products.filter(product => product.qty > 0);
    const itemCount = selected.reduce((total, product) => total + product.qty, 0);
    const amount = selected.reduce((total, product) => total + product.qty * product.price, 0);
    const itemCountElement = document.getElementById('kioskTotalItemsCount');
    const priceElement = document.getElementById('kioskTotalPrice');
    if (itemCountElement) itemCountElement.textContent = itemCount.toLocaleString();
    if (priceElement) priceElement.textContent = formatCurrency(amount);
}

function saveKiosk() {
    if (!kioskSession) return;
    const items = getProductItems(kioskSession.products);
    if (kioskSession.onSave(items) === false) return;
    closeKiosk();
}

function normalizeProduct(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatCurrency(value) {
    return `₱${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}
