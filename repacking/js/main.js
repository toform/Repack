import { appState } from './config.js';
import { addMasterCustomer, clearAppData, deleteArchivedBatch, loadBatchHistory, loadDuplicateDecisions, loadFromLocalStorage, loadMasterCustomers, promoteArchivedBatchToActive, saveArchivedBatchChanges, saveBatchToArchive, saveMasterCustomers, saveToLocalStorage, transitionToNewBatch } from './storage.js';
import { handleFileUpload } from './excelParser.js';
import { completeCustomerOrder, renderCards, resetCurrentBatch, showAppToast, toggleCustomerItem, uncheckCustomerOrderItems } from './renderCards.js';
import { closeModal, decideDuplicateMerge, openModal } from './modal.js';
import { renderBatchHistory, updateDashboardBadges, updateSummaryStats } from './sidebar.js';
import { exportArchivedBatch, initializeOrderEntry, loadArchivedBatchForEdit, refreshCustomerOptions } from './orderEntry.js';
import { initializeKiosk, openCustomerKiosk } from './kiosk.js';
import { extractAreaCode, normalizeCustomerKey } from './utils.js';
import { getProductUnitPrice } from './productCatalog.js';

document.addEventListener('DOMContentLoaded', initializeApp);
let previewedArchiveId = null;

function initializeApp() {
    bindSidebarControls();
    bindOrderTabs();
    bindOrderFilters();
    bindOrderActions();
    bindModalControls();
    bindArchiveControls();
    bindArchivePreviewControls();
    bindArchivedEditControls();

    loadFromLocalStorage();
    loadDuplicateDecisions();
    loadBatchHistory();
    loadMasterCustomers();
    renderCards();
    updateSummaryStats();
    renderBatchHistory();
    initializeOrderEntry();
    initializeKiosk();
    bindViewNavigation();
    bindCustomerCreation();
}

function bindSidebarControls() {
    const sidebar = document.getElementById('sidebarPanel');
    const overlay = document.getElementById('sidebarOverlay');
    document.getElementById('openSidebarBtn')?.addEventListener('click', () => setSidebarOpen(true));
    document.getElementById('closeSidebarBtn')?.addEventListener('click', () => setSidebarOpen(false));
    overlay?.addEventListener('click', () => setSidebarOpen(false));
    document.querySelectorAll('.sidebar-tab-btn[data-sidebar-tab]').forEach(button => {
        button.addEventListener('click', () => {
            selectSidebarTab(button.dataset.sidebarTab);
        });
    });

    document.getElementById('batchHistoryList')?.addEventListener('click', event => {
        const actionButton = event.target.closest('[data-batch-action]');
        if (!actionButton) return;
        handleBatchHistoryAction(actionButton.dataset.batchAction, actionButton.dataset.batchId);
    });

    function setSidebarOpen(isOpen) {
        sidebar?.classList.toggle('active', isOpen);
        overlay?.classList.toggle('active', isOpen);
    }
}

function bindViewNavigation() {
    document.getElementById('homeNavBtn')?.addEventListener('click', () => showAppView('homeDashboardView'));
    document.getElementById('navToRepackingCard')?.addEventListener('click', () => showAppView('repackingView'));
    document.getElementById('navToOrderEntryCard')?.addEventListener('click', handleCreateNewBatchClick);
    document.getElementById('navToArchivesCard')?.addEventListener('click', () => showAppView('archiveView'));
    document.querySelectorAll('[data-home-back]').forEach(button => {
        button.addEventListener('click', () => showAppView('homeDashboardView'));
    });
}

function handleCreateNewBatchClick() {
    if (!appState.customerOrders.length && !transitionToNewBatch([], 'DISCARD_OLD')) {
        showAppToast('A new batch could not be started. Please check browser storage and try again.', 'error');
        return;
    }

    showAppView('orderEntryView');
}

function showAppView(viewId) {
    document.querySelectorAll('.app-view').forEach(view => {
        view.classList.toggle('hidden', view.id !== viewId);
    });
    if (viewId === 'homeDashboardView') updateDashboardBadges();
}

function selectSidebarTab(selectedTab) {
    document.querySelectorAll('.sidebar-tab-btn[data-sidebar-tab]').forEach(tab => {
        const isSelected = tab.dataset.sidebarTab === selectedTab;
        tab.classList.toggle('active', isSelected);
        tab.setAttribute('aria-selected', String(isSelected));
    });
    document.querySelectorAll('.sidebar-tab-panel[data-sidebar-panel]').forEach(panel => {
        panel.hidden = panel.dataset.sidebarPanel !== selectedTab;
    });
}

function bindOrderTabs() {
    document.querySelectorAll('.tab-btn[data-tab]').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(tab => tab.classList.remove('active'));
            button.classList.add('active');
            appState.activeTab = button.dataset.tab;
            renderCards();
        });
    });
}

function bindOrderFilters() {
    const search = document.getElementById('customerSearch');
    const area = document.getElementById('areaFilter');
    const sort = document.getElementById('orderSort');

    search?.addEventListener('input', () => {
        appState.customerSearchQuery = search.value.trim().toLocaleLowerCase();
        renderCards();
    });
    area?.addEventListener('change', () => {
        appState.selectedArea = area.value;
        renderCards();
    });
    sort?.addEventListener('change', () => {
        appState.orderSort = sort.value;
        renderCards();
    });
    document.getElementById('resetBatchBtn')?.addEventListener('click', () => {
        const confirmed = window.confirm('Sigurado ka bang gusto mong i-reset ang kasalukuyang batch? Mabubura ang lahat ng progress at ticks ng mga customer.');
        if (confirmed) resetCurrentBatch();
    });
}

function bindCustomerCreation() {
    const modal = document.getElementById('addCustomerModal');
    const form = document.getElementById('addCustomerForm');
    const close = () => {
        modal?.classList.add('hidden');
        form?.reset();
    };

    document.getElementById('headerAddCustomerBtn')?.addEventListener('click', () => {
        modal?.classList.remove('hidden');
        document.getElementById('newCustName')?.focus();
    });
    document.getElementById('closeAddCustomerModal')?.addEventListener('click', close);
    document.getElementById('cancelAddCustomer')?.addEventListener('click', close);
    modal?.addEventListener('click', event => {
        if (event.target === modal) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) close();
    });
    form?.addEventListener('submit', event => {
        event.preventDefault();
        const enteredName = document.getElementById('newCustName')?.value.trim() || '';
        const area = document.getElementById('newCustArea')?.value || 'UNASSIGNED';
        const { cleanName } = extractAreaCode(enteredName);
        if (!cleanName) {
            document.getElementById('newCustName')?.focus();
            return;
        }
        const fullName = area === 'UNASSIGNED' ? cleanName : `${cleanName} (${area})`;
        if (appState.customerOrders.some(customer =>
            normalizeCustomerKey(customer.name) === normalizeCustomerKey(fullName)
        )) {
            showAppToast(`"${fullName}" is already in the active customer list.`, 'error');
            return;
        }

        const customer = {
            id: globalThis.crypto?.randomUUID?.() || `customer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: fullName,
            status: 'pending',
            items: []
        };
        const previousMasterCustomers = appState.masterCustomers;
        if (!addMasterCustomer({ name: fullName, area, defaultItems: [] })) {
            showAppToast('The customer could not be saved to the permanent customer directory.', 'error');
            return;
        }
        appState.customerOrders.push(customer);
        if (!saveToLocalStorage()) {
            appState.customerOrders.pop();
            appState.masterCustomers = previousMasterCustomers;
            if (!saveMasterCustomers()) {
                showAppToast('The active order failed to save, and the customer directory could not be rolled back.', 'error');
                return;
            }
            showAppToast('The new customer could not be saved to the active checklist.', 'error');
            return;
        }

        const customerIndex = appState.customerOrders.length - 1;
        appState.activeTab = 'pending';
        appState.customerSearchQuery = '';
        appState.selectedArea = '';
        const search = document.getElementById('customerSearch');
        if (search) search.value = '';
        const areaFilter = document.getElementById('areaFilter');
        if (areaFilter) areaFilter.value = '';
        document.querySelectorAll('.tab-btn[data-tab]').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === 'pending');
        });
        close();
        renderCards();
        updateSummaryStats();
        refreshCustomerOptions();
        showAppToast(`👤 Customer "${fullName}" added. Opening order kiosk...`);
        if (!openCustomerKiosk(customerIndex)) {
            showAppToast('The customer was added, but the order kiosk could not be opened.', 'error');
        }
    });
}

function bindOrderActions() {
    document.getElementById('excelFileInput')?.addEventListener('change', handleFileUpload);
    document.getElementById('cardsGrid')?.addEventListener('click', event => {
        if (event.target.closest('[data-reload-file]')) {
            document.getElementById('excelFileInput')?.click();
            return;
        }
        const itemRow = event.target.closest('.card-item-preview');
        if (itemRow) {
            event.stopPropagation();
            const checkbox = itemRow.querySelector('input[type="checkbox"][data-item-index]');
            if (checkbox && event.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return;
        }

        const actionButton = event.target.closest('[data-order-action]');
        if (actionButton) {
            event.stopPropagation();
            const index = Number(actionButton.dataset.customerIndex);
            if (actionButton.dataset.orderAction === 'uncheck-all') {
                uncheckCustomerOrderItems(index);
            } else if (actionButton.dataset.orderAction === 'incomplete') {
                openModal(index);
            } else {
                setOrderStatus(index, actionButton.dataset.orderAction);
            }
            return;
        }

        const card = event.target.closest('.customer-card[data-customer-index]');
        if (card) openModal(Number(card.dataset.customerIndex));
    });
    document.getElementById('cardsGrid')?.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const card = event.target.closest('.customer-card[data-customer-index]');
        if (!card || event.target !== card) return;
        event.preventDefault();
        openModal(Number(card.dataset.customerIndex));
    });
    document.getElementById('cardsGrid')?.addEventListener('change', event => {
        const checkbox = event.target.closest('.card-item-preview input[type="checkbox"][data-item-index]');
        if (!checkbox) return;
        event.stopPropagation();
        const card = checkbox.closest('.customer-card[data-customer-index]');
        if (!card) return;
        toggleCustomerItem(
            Number(card.dataset.customerIndex),
            Number(checkbox.dataset.itemIndex),
            checkbox.checked
        );
    });
}

function setOrderStatus(index, status) {
    const customer = appState.customerOrders[index];
    if (!customer) return;

    if (status === 'completed') {
        completeCustomerOrder(index);
        return;
    } else if (status === 'pending') {
        customer.status = 'pending';
    } else {
        return;
    }
    saveToLocalStorage();
    renderCards();
    updateSummaryStats();
}

function bindArchiveControls() {
    const modal = document.getElementById('archiveBatchModal');
    const form = document.getElementById('archiveBatchForm');
    const nameInput = document.getElementById('archiveBatchName');

    document.getElementById('archiveBatchBtn')?.addEventListener('click', () => {
        if (!appState.customerOrders.length) {
            showAppToast('There is no active batch to archive.', 'error');
            return;
        }
        if (nameInput) nameInput.value = '';
        modal?.classList.remove('hidden');
        nameInput?.focus();
    });
    document.getElementById('cancelArchiveBatchBtn')?.addEventListener('click', () => modal?.classList.add('hidden'));
    modal?.addEventListener('click', event => {
        if (event.target === modal) modal.classList.add('hidden');
    });
    form?.addEventListener('submit', event => {
        event.preventDefault();
        const batchName = nameInput?.value.trim();
        if (!batchName) {
            nameInput?.focus();
            return;
        }

        const archivedBatch = saveBatchToArchive(batchName);
        if (!archivedBatch) {
            showAppToast('The batch could not be archived. Check browser storage availability and try again.', 'error');
            return;
        }

        const previousOrders = appState.customerOrders;
        const previousArchiveEdit = appState.editingArchivedBatch;
        appState.customerOrders = [];
        appState.editingArchivedBatch = null;
        if (!saveToLocalStorage()) {
            appState.customerOrders = previousOrders;
            appState.editingArchivedBatch = previousArchiveEdit;
            renderCards();
            updateSummaryStats();
            renderBatchHistory();
            showAppToast('The archive was saved, but the active batch could not be cleared. Your active orders were kept.', 'error');
            return;
        }

        resetBatchView();
        modal?.classList.add('hidden');
        renderCards();
        updateSummaryStats();
        refreshCustomerOptions();
        renderBatchHistory();
        showAppToast(`“${archivedBatch.name}” archived. The active checklist is ready for the next batch.`);
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') modal?.classList.add('hidden');
    });
}

function bindArchivePreviewControls() {
    const modal = document.getElementById('archivePreviewModal');
    document.getElementById('closeArchiveModalBtn')?.addEventListener('click', closeArchivePreviewModal);
    modal?.addEventListener('click', event => {
        if (event.target === modal) closeArchivePreviewModal();
    });
    document.getElementById('restoreArchiveBtn')?.addEventListener('click', () => {
        const batch = findPreviewedBatch();
        if (!batch) return;
        if (appState.customerOrders.length
            && !window.confirm('Restoring this archive replaces the current active checklist. Continue?')) return;
        if (restoreArchivedBatch(batch)) closeArchivePreviewModal();
    });
    document.getElementById('editArchiveBtn')?.addEventListener('click', () => {
        const batch = findPreviewedBatch();
        if (!batch) return;
        activateArchivedBatchForEditing(batch);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !modal?.classList.contains('hidden')) {
            closeArchivePreviewModal();
        }
    });
}

function activateArchivedBatchForEditing(batch) {
    if (!loadArchivedBatchForEdit(batch)) {
        showAppToast('This archived batch could not be loaded into the active checklist.', 'error');
        return false;
    }
    closeArchivePreviewModal();
    resetBatchFilters();
    selectVisibleStatusTab();
    renderCards();
    updateSummaryStats();
    showAppView('repackingView');
    showAppToast(`“${batch.name}” is now loaded as the active checklist. Changes are saved to the active list.`);
    return true;
}

function bindArchivedEditControls() {
    document.getElementById('saveArchiveChangesBtn')?.addEventListener('click', () => {
        const previousArchiveEdit = appState.editingArchivedBatch;
        if (!previousArchiveEdit) return;
        const batch = appState.batchHistory.find(entry => entry.id === previousArchiveEdit.id);
        if (!batch) {
            showAppToast('The original archived batch could not be found. No archive changes were saved.', 'error');
            return;
        }
        if (!saveArchivedBatchChanges(previousArchiveEdit.id)) {
            showAppToast(`Archived batch '${batch.name}' changes could not be saved. Try again.`, 'error');
            return;
        }
        renderCards();
        updateSummaryStats();
        renderBatchHistory();
        showAppToast(`Archived batch '${batch.name}' changes saved successfully!`);
    });

    document.getElementById('putActiveBatchBtn')?.addEventListener('click', () => {
        if (!appState.editingArchivedBatch) return;
        if (!promoteArchivedBatchToActive()) {
            showAppToast('The active batch could not be saved. Archived edit mode is still active.', 'error');
            return;
        }
        renderCards();
        updateSummaryStats();
        renderBatchHistory();
        showAppToast('Naka-set na bilang Primary Active Batch!', 'success');
    });
}

function openArchivePreviewModal(batchId) {
    const batch = appState.batchHistory.find(entry => entry.id === batchId);
    if (!batch) return;

    previewedArchiveId = batch.id;
    const title = document.getElementById('archiveModalTitle');
    const date = document.getElementById('archiveModalDate');
    const content = document.getElementById('archiveModalContent');
    const modal = document.getElementById('archivePreviewModal');
    if (!title || !date || !content || !modal) return;

    const orders = batch.customerOrders || [];
    const itemCount = orders.reduce((total, customer) => total + (customer.items || []).length, 0);
    const batchTotal = orders.reduce((total, customer) => total + (customer.items || []).reduce((customerTotal, item) =>
        customerTotal + (Number(item.qty) || 0) * getArchivedItemPrice(item), 0), 0);

    title.textContent = batch.name;
    date.textContent = `Archived ${formatArchiveDate(batch.archivedAt)}`;
    content.innerHTML = `
        <div class="archive-preview-summary">
            <span><strong>${orders.length}</strong> ${orders.length === 1 ? 'customer' : 'customers'}</span>
            <span><strong>${itemCount}</strong> ${itemCount === 1 ? 'item' : 'items'}</span>
            <span><strong>${escapeHtml(formatArchiveCurrency(batchTotal))}</strong> total amount</span>
        </div>
        ${orders.length ? orders.map(customer => {
            const customerItems = customer.items || [];
            const customerTotal = customerItems.reduce((total, item) =>
                total + (Number(item.qty) || 0) * getArchivedItemPrice(item), 0);
            return `
                <article class="archive-customer-block">
                    <div class="archive-customer-heading">
                        <h3>${escapeHtml(customer.name)}</h3>
                        <span class="archive-customer-status status-${escapeHtml(customer.status)}">${escapeHtml(formatOrderStatus(customer.status))}</span>
                    </div>
                    <ul class="archive-preview-items">
                        ${customerItems.map(item => {
                const quantity = Number(item.qty) || 0;
                const amount = quantity * getArchivedItemPrice(item);
                return `<li>
                                <span class="archive-preview-item-name">${escapeHtml(item.description)}</span>
                                <span class="archive-preview-quantity">${escapeHtml(quantity)} ${escapeHtml(item.unit || '')}</span>
                                <span class="archive-preview-check">${item.checked ? '✓ Packed' : '○ Not packed'}</span>
                                <span class="archive-preview-amount">${escapeHtml(formatArchiveCurrency(amount))}</span>
                            </li>`;
            }).join('')}
                    </ul>
                    <div class="archive-customer-subtotal"><span>Customer total</span><strong>${escapeHtml(formatArchiveCurrency(customerTotal))}</strong></div>
                </article>
            `;
        }).join('') : '<p class="archive-preview-empty">This archived batch contains no customer orders.</p>'}
    `;
    modal.classList.remove('hidden');
}

function closeArchivePreviewModal() {
    document.getElementById('archivePreviewModal')?.classList.add('hidden');
    previewedArchiveId = null;
}

function findPreviewedBatch() {
    return appState.batchHistory.find(batch => batch.id === previewedArchiveId);
}

function restoreArchivedBatch(batch) {
    const previousOrders = appState.customerOrders;
    const previousMerges = appState.pendingDuplicateMerges;
    const previousIndex = appState.currentActiveCustomerIndex;
    const previousOrderEntry = appState.currentOrderEntry;
    const previousArchivedEdit = appState.editingArchivedBatch;
    appState.customerOrders = batch.customerOrders.map(customer => ({
        ...customer,
        items: (customer.items || []).map(item => ({ ...item }))
    }));
    appState.pendingDuplicateMerges = [];
    appState.currentActiveCustomerIndex = null;
    appState.currentOrderEntry = null;
    appState.editingArchivedBatch = null;

    if (!saveToLocalStorage()) {
        appState.customerOrders = previousOrders;
        appState.pendingDuplicateMerges = previousMerges;
        appState.currentActiveCustomerIndex = previousIndex;
        appState.currentOrderEntry = previousOrderEntry;
        appState.editingArchivedBatch = previousArchivedEdit;
        showAppToast('The archived batch could not be restored because browser storage could not save the active checklist.', 'error');
        return false;
    }

    resetBatchFilters();
    selectVisibleStatusTab();
    renderCards();
    updateSummaryStats();
    refreshCustomerOptions();
    showAppView('repackingView');
    showAppToast('Batch restored to active repacking list!');
    return true;
}

function handleBatchHistoryAction(action, batchId) {
    const batch = appState.batchHistory.find(entry => entry.id === batchId);
    if (!batch) return;

    if (action === 'delete') {
        if (!window.confirm(`Permanently delete the “${batch.name}” archived batch?`)) return;
        if (!deleteArchivedBatch(batch.id)) {
            showAppToast('The archived batch could not be deleted. Check browser storage availability.', 'error');
            return;
        }
        renderBatchHistory();
        showAppToast(`“${batch.name}” deleted from batch history.`);
    } else if (action === 'view') {
        openArchivePreviewModal(batchId);
    } else if (action === 'edit') {
        activateArchivedBatchForEditing(batch);
    } else if (action === 'export') {
        if (!exportArchivedBatch(batch)) {
            showAppToast('Could not export this batch. Check that the Excel library loaded and downloads are allowed.', 'error');
            return;
        }
        showAppToast(`“${batch.name}” Excel summary downloaded.`);
    }
}

function formatArchiveDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? 'date unavailable'
        : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatOrderStatus(status) {
    return String(status || 'pending').replace(/^\w/, letter => letter.toLocaleUpperCase());
}

function getArchivedItemPrice(item) {
    return getProductUnitPrice(item);
}

function formatArchiveCurrency(amount) {
    return `₱${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function resetBatchView() {
    resetBatchFilters();
    appState.activeTab = 'pending';
    appState.currentActiveCustomerIndex = null;
    appState.pendingDuplicateMerges = [];
    document.querySelectorAll('.tab-btn[data-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === 'pending');
    });
}

function resetBatchFilters() {
    appState.customerSearchQuery = '';
    appState.selectedArea = '';
    appState.orderSort = 'oatmilk-desc';
    const search = document.getElementById('customerSearch');
    if (search) search.value = '';
    const area = document.getElementById('areaFilter');
    if (area) area.value = '';
    const sort = document.getElementById('orderSort');
    if (sort) sort.value = appState.orderSort;
}

function selectVisibleStatusTab() {
    const visibleStatus = ['pending', 'incomplete', 'completed'].find(status =>
        appState.customerOrders.some(customer => customer.status === status)
    ) || 'pending';
    appState.activeTab = visibleStatus;
    document.querySelectorAll('.tab-btn[data-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === visibleStatus);
    });
}

function bindModalControls() {
    document.getElementById('mergeDuplicateBtn')?.addEventListener('click', () => decideDuplicateMerge('merge'));
    document.getElementById('keepDuplicateSeparateBtn')?.addEventListener('click', () => decideDuplicateMerge('separate'));
    document.getElementById('clearAllDataBtn')?.addEventListener('click', () => {
        const confirmed = window.confirm('Mabubura ang active checklist at saved file. Archived batches in Batch History will be kept. Kailangan mong mag-upload ng bagong Excel file.');
        if (!confirmed) return;

        try {
            clearAppData();
        } catch (error) {
            window.alert('Hindi ma-clear ang saved data. Pakisuri ang browser storage settings.');
            return;
        }

        const fileInput = document.getElementById('excelFileInput');
        if (fileInput) fileInput.value = '';
        const search = document.getElementById('customerSearch');
        if (search) search.value = '';
        appState.customerSearchQuery = '';
        appState.selectedArea = '';
        appState.orderSort = 'oatmilk-desc';
        const sort = document.getElementById('orderSort');
        if (sort) sort.value = appState.orderSort;
        const area = document.getElementById('areaFilter');
        if (area) area.value = '';
        appState.activeTab = 'pending';
        document.querySelectorAll('.tab-btn[data-tab]').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === 'pending');
        });
        closeModal();
        document.getElementById('duplicateModal')?.classList.add('hidden');
        renderCards();
        updateSummaryStats();
        refreshCustomerOptions();
        renderBatchHistory();
    });
}
