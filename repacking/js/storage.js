import { appState, DEFAULT_MASTER_CUSTOMERS, SCHEMA_VERSION } from './config.js';
import { extractCustomerArea, normalizeCustomerKey } from './utils.js';

const STORAGE_KEY = 'repackingCustomerOrders';
const DUPLICATE_DECISIONS_KEY = 'repackingCustomerDuplicateDecisions';
const BATCH_HISTORY_KEY = 'repackingBatchHistory';
const CUSTOM_PRODUCTS_KEY = 'repackingCustomProducts';
const MASTER_CUSTOMERS_KEY = 'repackingMasterCustomers';
const LEGACY_MERGED_ALIASES_KEY = 'mergedCustomerAliases';
const RECOVERY_MESSAGE = 'Nadetect na may lumang data format, in-reset ang cache para sa panibagong upload.';
let recoveryNoticeShown = false;

/**
 * Automatic / Manual LocalStorage Save.
 * Kapag nasa Archive Edit Mode, automatic nitong ina-update ang history item IN-PLACE.
 */
export function saveToLocalStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: SCHEMA_VERSION,
            data: appState.customerOrders,
            editingArchivedBatch: appState.editingArchivedBatch
        }, (key, value) => key === 'priority' ? undefined : value));

        // In-place update sa batchHistory kapag nag-e-edit ng archived batch
        if (appState.editingArchivedBatch?.id) {
            updateArchivedHistoryInPlace(appState.editingArchivedBatch.id, appState.customerOrders);
        }

        return true;
    } catch (error) {
        console.error('LocalStorage write failed:', error);
        return false;
    }
}

export function loadFromLocalStorage() {
    loadCustomProducts();
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                if (!isValidCustomerData(parsed)) throw new Error('Unsupported saved customer data schema.');
                appState.customerOrders = parsed;
                appState.editingArchivedBatch = null;
            } else if (parsed && parsed.version === SCHEMA_VERSION && Array.isArray(parsed.data)) {
                if (!isValidCustomerData(parsed.data)) throw new Error('Unsupported saved customer data schema.');
                appState.customerOrders = parsed.data;
                const archivedBatch = parsed.editingArchivedBatch;
                const hasValidArchivedBatch = archivedBatch === null || archivedBatch === undefined
                    || (typeof archivedBatch.id === 'string' && typeof archivedBatch.name === 'string');
                
                appState.editingArchivedBatch = hasValidArchivedBatch && archivedBatch
                    ? { id: archivedBatch.id, name: archivedBatch.name }
                    : null;
            } else if (parsed !== null) {
                throw new Error('Unsupported saved order data format.');
            }
        }
    } catch (error) {
        console.error('LocalStorage read failed:', error);
        appState.customerOrders = [];
        appState.editingArchivedBatch = null;
        purgeCorruptedKeys([STORAGE_KEY]);
        showRecoveryNotice();
    }
}

export function loadMasterCustomers() {
    try {
        const saved = localStorage.getItem(MASTER_CUSTOMERS_KEY);
        if (saved !== null) {
            const parsed = JSON.parse(saved);
            if (!Array.isArray(parsed) || !parsed.every(isValidMasterCustomer)) {
                throw new Error('Unsupported master customer directory format.');
            }
            appState.masterCustomers = parsed.filter(customer => !isDummyCustomer(customer.name));
            saveMasterCustomers();
            return;
        }
    } catch (error) {
        console.error('Failed to load saved master customers:', error);
        showRecoveryNotice();
    }

    appState.masterCustomers = DEFAULT_MASTER_CUSTOMERS.map(customer => ({
        ...customer,
        defaultItems: customer.defaultItems.map(item => ({ ...item }))
    }));
    saveMasterCustomers();
}

export function saveMasterCustomers() {
    try {
        localStorage.setItem(MASTER_CUSTOMERS_KEY, JSON.stringify(appState.masterCustomers));
        return true;
    } catch (error) {
        console.error('Master customer directory write failed:', error);
        return false;
    }
}

export function addMasterCustomer(customer) {
    const name = String(customer?.name || '').trim();
    if (!name) return false;
    const key = normalizeCustomerKey(name);
    if (appState.masterCustomers.some(existing => normalizeCustomerKey(existing.name) === key)) return true;

    const previousCustomers = appState.masterCustomers;
    appState.masterCustomers = [...previousCustomers, {
        name,
        area: String(customer.area || extractCustomerArea(name)),
        defaultItems: (customer.defaultItems || []).map(item => ({ ...item, checked: false }))
    }];
    if (saveMasterCustomers()) return true;
    appState.masterCustomers = previousCustomers;
    return false;
}

export function syncExcelCustomersToMaster(uploadedCustomers) {
    if (!Array.isArray(uploadedCustomers)) return false;
    const previousCustomers = appState.masterCustomers || [];
    const cleanPrevious = previousCustomers.filter(customer => !isDummyCustomer(customer?.name));
    const customersByKey = new Map(cleanPrevious.map(customer => [
        normalizeCustomerKey(customer.name),
        customer
    ]));
    let updated = cleanPrevious.length !== previousCustomers.length;

    uploadedCustomers.forEach(customer => {
        const name = String(customer?.name || '').trim();
        if (!name || isDummyCustomer(name)) return;
        const key = normalizeCustomerKey(name);
        const existing = customersByKey.get(key);
        const nextCustomer = {
            ...(existing || {}),
            name,
            area: String(customer.area || extractCustomerArea(name) || existing?.area || ''),
            defaultItems: (customer.items || existing?.defaultItems || []).map(item => ({
                ...item,
                checked: false
            }))
        };
        if (!existing || JSON.stringify(existing) !== JSON.stringify(nextCustomer)) {
            customersByKey.set(key, nextCustomer);
            updated = true;
        }
    });

    if (!updated) return true;
    appState.masterCustomers = [...customersByKey.values()];
    if (saveMasterCustomers()) return true;
    appState.masterCustomers = previousCustomers;
    return false;
}

function isDummyCustomer(name) {
    return /^CUSTOMER\s+\d+/i.test(String(name || '').trim());
}

/**
 * Unified Archiving Action.
 * - Kung galing sa Archive Edit Mode -> ina-update ang umiiral na batch ID (WALANG DUPLICATE).
 * - Kung galing sa Live Active Mode -> gumagawa ng bagong unique archive ID.
 */
export function saveBatchToArchive(batchName) {
    const name = String(batchName || '').trim();
    if (!name || !appState.customerOrders.length) return null;

    try {
        // Scenario A: Editing an existing archived batch -> Update in-place
        if (appState.editingArchivedBatch?.id) {
            const existingId = appState.editingArchivedBatch.id;
            const updated = updateArchivedHistoryInPlace(existingId, appState.customerOrders, name);
            if (updated) {
                appState.customerOrders = [];
                appState.editingArchivedBatch = null;
                saveToLocalStorage();
                return updated;
            }
        }

        // Scenario B: Live Active Batch -> Lumikha ng bagong archive record
        const batch = {
            id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name,
            archivedAt: new Date().toISOString(),
            customerOrders: cloneCustomerOrders(appState.customerOrders)
        };

        const nextHistory = [batch, ...appState.batchHistory];
        localStorage.setItem(BATCH_HISTORY_KEY, JSON.stringify(nextHistory));
        appState.batchHistory = nextHistory;

        // I-reset ang active workspace
        appState.customerOrders = [];
        appState.editingArchivedBatch = null;
        saveToLocalStorage();

        return batch;
    } catch (error) {
        console.error('Batch archive write failed:', error);
        return null;
    }
}

/**
 * Save current snapshot as draft in history without clearing active workspace.
 */
export function saveBatchDraft(batchName, customerOrders = appState.customerOrders) {
    const orders = cloneCustomerOrders(customerOrders);
    const name = String(batchName || '').trim();
    if (!name || !orders?.length) return null;

    try {
        if (appState.editingArchivedBatch?.id) {
            return updateArchivedHistoryInPlace(appState.editingArchivedBatch.id, orders, name);
        }

        const batch = {
            id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name,
            archivedAt: new Date().toISOString(),
            customerOrders: orders
        };
        const nextHistory = [batch, ...appState.batchHistory];
        localStorage.setItem(BATCH_HISTORY_KEY, JSON.stringify(nextHistory));
        appState.batchHistory = nextHistory;
        return batch;
    } catch (error) {
        console.error('Batch draft write failed:', error);
        return null;
    }
}

/**
 * Unified Transition para sa pag-start ng Bagong Batch Order.
 * Options: 'ARCHIVE_OLD' | 'DRAFT_OLD' | 'DISCARD_OLD'
 */
export function transitionToNewBatch(newOrders = [], option = 'DISCARD_OLD', archiveName = '') {
    const nextOrders = cloneCustomerOrders(newOrders) || [];
    if (!nextOrders || !['ARCHIVE_OLD', 'DRAFT_OLD', 'DISCARD_OLD'].includes(option)) return false;

    const shouldSaveOldBatch = appState.customerOrders.length > 0
        && (option === 'ARCHIVE_OLD' || option === 'DRAFT_OLD');
    const oldBatch = shouldSaveOldBatch
        ? createBatchSnapshot(archiveName, appState.customerOrders)
        : null;
    if (shouldSaveOldBatch && !oldBatch) return false;

    let previousActiveStorage = null;
    let previousHistoryStorage = null;
    let storageSnapshotReady = false;
    const previousOrders = appState.customerOrders;
    const previousHistory = appState.batchHistory;
    const previousArchiveEdit = appState.editingArchivedBatch;
    const previousOrderEntry = appState.currentOrderEntry;
    const nextHistory = oldBatch ? [oldBatch, ...previousHistory] : previousHistory;

    try {
        previousActiveStorage = localStorage.getItem(STORAGE_KEY);
        previousHistoryStorage = localStorage.getItem(BATCH_HISTORY_KEY);
        storageSnapshotReady = true;

        if (oldBatch) localStorage.setItem(BATCH_HISTORY_KEY, JSON.stringify(nextHistory));
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: SCHEMA_VERSION,
            data: nextOrders,
            editingArchivedBatch: null
        }, (key, value) => key === 'priority' ? undefined : value));

        appState.customerOrders = nextOrders;
        appState.batchHistory = nextHistory;
        appState.editingArchivedBatch = null;
        appState.currentOrderEntry = null;
        return true;
    } catch (error) {
        console.error('New batch transition could not be saved:', error);
        if (storageSnapshotReady) {
            restoreStorageValue(STORAGE_KEY, previousActiveStorage);
            restoreStorageValue(BATCH_HISTORY_KEY, previousHistoryStorage);
        }
        appState.customerOrders = previousOrders;
        appState.batchHistory = previousHistory;
        appState.editingArchivedBatch = previousArchiveEdit;
        appState.currentOrderEntry = previousOrderEntry;
        return false;
    }
}

/**
 * I-load ang Archived Batch para sa Editing Mode (Yellow Banner).
 */
export function loadArchivedBatchForEditing(batchId) {
    const batch = appState.batchHistory.find(b => b.id === batchId);
    if (!batch) return false;

    appState.customerOrders = cloneCustomerOrders(batch.customerOrders);
    appState.editingArchivedBatch = { id: batch.id, name: batch.name };
    saveToLocalStorage();
    return true;
}

/**
 * Gawing Primary Active Batch ang kasalukuyang ine-edit na archive.
 */
export function promoteArchivedBatchToActive() {
    if (!appState.editingArchivedBatch) return false;
    const previousArchiveEdit = appState.editingArchivedBatch;
    appState.editingArchivedBatch = null;
    if (saveToLocalStorage()) return true;
    appState.editingArchivedBatch = previousArchiveEdit;
    return false;
}

/**
 * In-place update ng batch item sa batchHistory gamit ang ID.
 */
function updateArchivedHistoryInPlace(batchId, customerOrders, newName = null) {
    const index = appState.batchHistory.findIndex(b => b.id === batchId);
    if (index === -1) return null;

    const existing = appState.batchHistory[index];
    const updatedBatch = {
        ...existing,
        name: newName ? String(newName).trim() : existing.name,
        customerOrders: cloneCustomerOrders(customerOrders),
        updatedAt: new Date().toISOString()
    };

    const nextHistory = [...appState.batchHistory];
    nextHistory[index] = updatedBatch;

    try {
        localStorage.setItem(BATCH_HISTORY_KEY, JSON.stringify(nextHistory));
        appState.batchHistory = nextHistory;
        return updatedBatch;
    } catch (err) {
        console.error('Failed to update archived history in place:', err);
        return null;
    }
}

export function saveArchivedBatchChanges(batchId) {
    return !!updateArchivedHistoryInPlace(batchId, appState.customerOrders);
}

export function loadBatchHistory() {
    try {
        const saved = localStorage.getItem(BATCH_HISTORY_KEY);
        if (saved === null) {
            appState.batchHistory = [];
            return;
        }

        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed) || !parsed.every(batch =>
            batch
            && typeof batch.id === 'string'
            && typeof batch.name === 'string'
            && typeof batch.archivedAt === 'string'
            && Array.isArray(batch.customerOrders)
            && isValidCustomerData(batch.customerOrders)
        )) throw new Error('Unsupported archived batch data format.');

        appState.batchHistory = parsed;
    } catch (error) {
        console.error('Batch archive read failed:', error);
        appState.batchHistory = [];
        purgeCorruptedKeys([BATCH_HISTORY_KEY]);
        showRecoveryNotice();
    }
}

export function deleteArchivedBatch(batchId) {
    const nextHistory = appState.batchHistory.filter(batch => batch.id !== batchId);
    if (nextHistory.length === appState.batchHistory.length) return false;

    try {
        localStorage.setItem(BATCH_HISTORY_KEY, JSON.stringify(nextHistory));
        appState.batchHistory = nextHistory;
        
        if (appState.editingArchivedBatch?.id === batchId) {
            appState.editingArchivedBatch = null;
            saveToLocalStorage();
        }
        return true;
    } catch (error) {
        console.error('Archived batch delete failed:', error);
        return false;
    }
}

function loadCustomProducts() {
    try {
        const saved = localStorage.getItem(CUSTOM_PRODUCTS_KEY);
        if (saved === null) {
            appState.customProducts = [];
            return;
        }

        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed) || !parsed.every(product =>
            product
            && typeof product.id === 'string'
            && typeof product.description === 'string'
            && typeof product.category === 'string'
            && typeof product.unit === 'string'
            && Number.isFinite(Number(product.unitPrice))
            && typeof product.icon === 'string'
        )) throw new Error('Unsupported custom product data format.');

        appState.customProducts = parsed;
    } catch (error) {
        console.error('Custom product catalog read failed:', error);
        appState.customProducts = [];
        purgeCorruptedKeys([CUSTOM_PRODUCTS_KEY]);
        showRecoveryNotice();
    }
}

export function saveCustomProducts() {
    try {
        localStorage.setItem(CUSTOM_PRODUCTS_KEY, JSON.stringify(appState.customProducts));
        return true;
    } catch (error) {
        console.error('Custom product catalog write failed:', error);
        return false;
    }
}

export function saveDuplicateDecisions() {
    try {
        localStorage.setItem(DUPLICATE_DECISIONS_KEY, JSON.stringify(appState.duplicateDecisions));
    } catch (error) {
        console.error('Duplicate decision write failed:', error);
    }
}

export function loadDuplicateDecisions() {
    try {
        const saved = localStorage.getItem(DUPLICATE_DECISIONS_KEY);
        if (saved === null) return;
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed) || !parsed.every(decision =>
            decision
            && typeof decision.primaryKey === 'string'
            && typeof decision.secondaryKey === 'string'
            && ['merge', 'separate'].includes(decision.action)
        )) throw new Error('Unsupported duplicate decision format.');
        appState.duplicateDecisions = parsed;
    } catch (error) {
        console.error('Duplicate decision read failed:', error);
        appState.duplicateDecisions = [];
        purgeCorruptedKeys([DUPLICATE_DECISIONS_KEY]);
        showRecoveryNotice();
    }
}

export function clearAppData() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(DUPLICATE_DECISIONS_KEY);
        localStorage.removeItem(LEGACY_MERGED_ALIASES_KEY);
    } catch (error) {
        console.error('LocalStorage clear failed:', error);
        throw error;
    }

    appState.customerOrders = [];
    appState.currentOrderEntry = null;
    appState.editingArchivedBatch = null;
    appState.duplicateDecisions = [];
    appState.pendingDuplicateMerges = [];
    appState.currentActiveCustomerIndex = null;
}

function purgeCorruptedKeys(keys) {
    try {
        keys.forEach(key => localStorage.removeItem(key));
    } catch (error) {
        console.error('Corrupted localStorage cleanup failed:', error);
    }
}

function isValidCustomerData(customers) {
    return customers.every(customer =>
        customer
        && typeof customer.name === 'string'
        && ['pending', 'incomplete', 'completed'].includes(customer.status)
        && Array.isArray(customer.items)
        && customer.items.every(item =>
            item
            && typeof item.description === 'string'
            && Number.isFinite(Number(item.qty))
            && typeof item.checked === 'boolean'
        )
    );
}

function isValidMasterCustomer(customer) {
    return customer
        && typeof customer.name === 'string'
        && typeof customer.area === 'string'
        && Array.isArray(customer.defaultItems)
        && customer.defaultItems.every(item =>
            item
            && typeof item.description === 'string'
            && Number.isFinite(Number(item.qty))
            && typeof item.checked === 'boolean'
        );
}

function cloneCustomerOrders(customerOrders) {
    if (!Array.isArray(customerOrders)) return null;
    return JSON.parse(JSON.stringify(customerOrders, (key, value) =>
        key === 'priority' ? undefined : value
    ));
}

function createBatchSnapshot(name, customerOrders) {
    const batchName = String(name || '').trim();
    const orders = cloneCustomerOrders(customerOrders);
    if (!batchName || !orders?.length) return null;

    return {
        id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: batchName,
        archivedAt: new Date().toISOString(),
        customerOrders: orders
    };
}

function showRecoveryNotice() {
    if (recoveryNoticeShown) return;
    recoveryNoticeShown = true;

    const notice = document.createElement('div');
    notice.className = 'app-toast';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.textContent = RECOVERY_MESSAGE;
    document.body.appendChild(notice);
    window.setTimeout(() => notice.remove(), 6000);
}