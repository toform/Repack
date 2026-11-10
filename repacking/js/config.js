export const SCHEMA_VERSION = 2;

export const DEFAULT_MASTER_CUSTOMERS = [];

export const appState = {
    customerOrders: [],
    masterCustomers: [],
    batchHistory: [],
    customProducts: [],
    activeTab: 'pending',
    currentActiveCustomerIndex: null,
    customerSearchQuery: '',
    selectedArea: '',
    orderSort: 'oatmilk-desc',
    currentOrderEntry: null,
    editingArchivedBatch: null,
    duplicateDecisions: [],
    pendingDuplicateMerges: []
};
