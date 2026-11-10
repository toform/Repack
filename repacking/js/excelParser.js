import { appState } from './config.js';
import {
    extractAreaCode,
    getDuplicatePairKey,
    getItemSortPriority,
    getNameSimilarity,
    mergeCustomerData,
    normalizeCustomerKey,
    normalizeItemKey
} from './utils.js';
import { saveToLocalStorage, syncExcelCustomersToMaster } from './storage.js';
import { renderCards, showAppToast, showCardsError } from './renderCards.js';
import { updateSummaryStats } from './sidebar.js';
import { showDuplicateModal } from './modal.js';
import { refreshCustomerOptions } from './orderEntry.js';

const HEADER_ALIASES = {
    name: new Set(['name', 'customer', 'customername', 'customersname', 'nameofcustomer', 'client', 'clientname']),
    qty: new Set(['qty', 'quantity', 'orderqty', 'quantityordered', 'quantityrequired', 'qtyrequired']),
    unit: new Set(['unit', 'uom', 'measure', 'unitofmeasure', 'units']),
    size: new Set(['size', 'variant', 'packsize', 'boxsize', 'pcs']),
    particular: new Set(['particular', 'particulars', 'item', 'itemname', 'itemdescription', 'product', 'description']),
    unitPrice: new Set(['price', 'unitprice', 'priceperunit', 'unitcost']),
    amount: new Set(['amount', 'lineamount', 'totalamount'])
};

export function handleFileUpload(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
        console.error('Excel file read failed:', reader.error);
        const message = 'We could not read that file. Please choose a valid Excel file and try again.';
        showAppToast(message, 'error');
        showCardsError(message);
        input.value = '';
    };
    reader.onload = loadWorkbook;
    reader.readAsArrayBuffer(file);
}

function loadWorkbook(event) {
    const input = document.getElementById('excelFileInput');
    try {
        if (typeof XLSX === 'undefined') throw new Error('Excel reader library is unavailable.');
        const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
        if (!workbook.SheetNames?.length) throw new Error('Walang nahanap na sheet sa Excel file.');

        const orderSheets = workbook.SheetNames.filter(name =>
            !isSummarySheet(name) && /\b(STL|MILK)\b/i.test(name)
        );
        if (!orderSheets.length) {
            throw new Error('Walang nahanap na customer order sheet (STL o MILK) sa Excel file.');
        }

        const customersMap = {};
        orderSheets.forEach(sheetName => {
            const source = /\bMILK\b/i.test(sheetName) ? 'MILK' : 'STL';
            parseSheet(workbook, sheetName, customersMap, source);
        });

        const parsedCustomers = Object.values(customersMap);
        if (!parsedCustomers.length) throw new Error('Walang nahanap na customer data sa file. Suriin ang mga column at laman ng sheet.');

        applyRememberedMerges(parsedCustomers);
        mergeExistingState(parsedCustomers);
        appState.pendingDuplicateMerges = findPotentialDuplicates(parsedCustomers);
        if (!syncExcelCustomersToMaster(parsedCustomers)) {
            showAppToast('Orders loaded, but the permanent customer directory could not be updated.', 'error');
        }
        appState.customerOrders = parsedCustomers;
        appState.currentOrderEntry = null;
        appState.editingArchivedBatch = null;
        saveToLocalStorage();
        renderCards();
        updateSummaryStats();
        refreshCustomerOptions();
        if (appState.pendingDuplicateMerges.length) showDuplicateModal();
        if (input) input.value = '';
    } catch (error) {
        console.error('Excel parse failed:', error);
        const message = error.message || 'The Excel file could not be read. Please choose another file.';
        showAppToast(message, 'error');
        showCardsError(message);
        if (input) input.value = '';
    }
}

function findPotentialDuplicates(customers) {
    const decisions = new Set(appState.duplicateDecisions.map(decision =>
        getDuplicatePairKey(decision.primaryKey, decision.secondaryKey)
    ));
    const candidates = [];

    for (let first = 0; first < customers.length; first++) {
        for (let second = first + 1; second < customers.length; second++) {
            const primary = customers[first];
            const secondary = customers[second];
            const primaryCustomer = extractAreaCode(primary.name);
            const secondaryCustomer = extractAreaCode(secondary.name);
            if (primaryCustomer.area === 'NO_AREA' || primaryCustomer.area !== secondaryCustomer.area) continue;

            const primaryKey = normalizeCustomerKey(primary.name);
            const secondaryKey = normalizeCustomerKey(secondary.name);
            const pairKey = getDuplicatePairKey(primaryKey, secondaryKey);
            if (decisions.has(pairKey)) continue;

            const similarity = getNameSimilarity(primaryCustomer.cleanName, secondaryCustomer.cleanName);
            if (similarity >= 0.8) {
                candidates.push({
                    primaryKey,
                    secondaryKey,
                    primaryName: primary.name,
                    secondaryName: secondary.name,
                    similarity
                });
            }
        }
    }
    return candidates;
}

function applyRememberedMerges(customers) {
    const mergeDecisions = appState.duplicateDecisions.filter(decision => decision.action === 'merge');
    let changed = true;
    while (changed) {
        changed = false;
        mergeDecisions.forEach(decision => {
            const primaryIndex = customers.findIndex(customer => normalizeCustomerKey(customer.name) === decision.primaryKey);
            const secondaryIndex = customers.findIndex(customer => normalizeCustomerKey(customer.name) === decision.secondaryKey);
            if (primaryIndex === -1 || secondaryIndex === -1 || primaryIndex === secondaryIndex) return;

            mergeCustomerData(customers[primaryIndex], customers[secondaryIndex]);
            customers.splice(secondaryIndex, 1);
            changed = true;
        });
    }
}

function parseSheet(workbook, sheetName, customersMap, source) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const columns = detectColumns(rows, source);
    let currentCustomer = '';
    let lastSeenCategory = '';
    let inSummarySection = false;

    for (let rowIndex = columns.firstDataRow; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (!Array.isArray(row) || !row.length) continue;

        const rawName = getCell(row, columns.name).trim();
        if (isSummarySectionRow(row)) {
            inSummarySection = true;
            currentCustomer = '';
            lastSeenCategory = '';
            continue;
        }
        if (inSummarySection) continue;
        if (isSummaryCustomerName(rawName)) {
            currentCustomer = '';
            lastSeenCategory = '';
            continue;
        }
        if (rawName && !/^(name|customer|customer name)$/i.test(rawName)) {
            if (currentCustomer && normalizeCustomerKey(currentCustomer) !== normalizeCustomerKey(rawName)) {
                lastSeenCategory = '';
            }
            currentCustomer = rawName;
        }
        if (!currentCustomer) continue;

        const quantity = parseQuantity(getCell(row, columns.qty));
        const unit = getCell(row, columns.unit).trim();
        const size = columns.size === null ? '' : getCell(row, columns.size).trim();
        const particular = getCell(row, columns.particular).trim();

        // Kumuha lamang ng order-related columns (QTY, UNIT, SIZE/PCS, PARTICULAR)
        const orderTexts = [size, unit, particular].filter(Boolean);
        const categoryRowText = orderTexts.join(' ');
        const rowCategory = getAngelBarCategoryContext(categoryRowText);
        if (rowCategory) lastSeenCategory = rowCategory;

        const hasAngelBarSize = hasAngelBarSizeMarker(categoryRowText);
        const sourceDescription = particular || (hasAngelBarSize ? lastSeenCategory : '');
        if (!sourceDescription || quantity <= 0) continue;
        const inheritedAngelCategory = !particular && hasAngelBarSize ? lastSeenCategory : '';

        const description = normalizeAngelBarDescription(
            sourceDescription,
            size,
            orderTexts,
            inheritedAngelCategory
        );
        const amount = parsePrice(getCell(row, columns.amount));
        const unitPrice = parsePrice(getCell(row, columns.unitPrice))
            ?? (amount !== null && quantity ? amount / quantity : null);
        const customerKey = normalizeCustomerKey(currentCustomer);
        if (!customersMap[customerKey]) {
            customersMap[customerKey] = {
                name: currentCustomer,
                status: 'pending',
                items: []
            };
        }
        customersMap[customerKey].items.push({
            description,
            qty: quantity,
            unit,
            ...(unitPrice !== null ? { unitPrice } : {}),
            checked: false,
            priority: getItemSortPriority(description)
        });
    }

    Object.values(customersMap).forEach(customer => {
        customer.items.sort((a, b) => a.priority - b.priority);
    });
}

function isSummarySheet(sheetName) {
    return /\b(?:SUMMARY|TOTALS|INVENTORY\s+SUMMARY)\b/i.test(String(sheetName || ''));
}

function isSummarySectionRow(row) {
    return row.some(cell => /^(?:SUMMARY|TOTALS|INVENTORY\s+SUMMARY)$/i.test(String(cell || '').trim()));
}

function isSummaryCustomerName(name) {
    return /\b(?:SUBTOTAL|TOTALS?|SUMMARY)\b/i.test(name);
}

function detectColumns(rows, source) {
    const fallback = source === 'STL'
        ? { name: 1, qty: 2, unit: 3, size: 4, particular: 5, unitPrice: null, amount: null, firstDataRow: 2 }
        : { name: 1, qty: 2, unit: 3, size: null, particular: 4, unitPrice: null, amount: null, firstDataRow: 2 };
    let best = null;

    rows.slice(0, 12).forEach((row, rowIndex) => {
        if (!Array.isArray(row)) return;
        const found = { name: null, qty: null, unit: null, size: null, particular: null, unitPrice: null, amount: null };
        row.forEach((value, columnIndex) => {
            const key = normalizeHeader(value);
            Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
                if (found[field] === null && aliases.has(key)) found[field] = columnIndex;
            });
        });
        const score = Object.values(found).filter(index => index !== null).length;
        if (found.qty !== null && found.particular !== null && score >= 2 && (!best || score > best.score)) {
            best = { ...found, rowIndex, score };
        }
    });

    if (!best) return fallback;
    return {
        name: best.name ?? fallback.name,
        qty: best.qty,
        unit: best.unit ?? fallback.unit,
        size: best.size ?? fallback.size,
        particular: best.particular,
        unitPrice: best.unitPrice,
        amount: best.amount,
        firstDataRow: best.rowIndex + 1
    };
}

function normalizeHeader(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function getCell(row, index) {
    if (index === null || index === undefined) return '';
    const value = row[index];
    return value === null || value === undefined ? '' : String(value).trim();
}

function parseQuantity(value) {
    const normalized = String(value || '').replace(/,/g, '').trim();
    const quantity = Number(normalized);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

function parsePrice(value) {
    const normalized = String(value || '').replace(/[₱,$\s]/g, '').trim();
    if (!normalized) return null;
    const price = Number(normalized);
    return Number.isFinite(price) && price >= 0 ? price : null;
}

function appendSize(description, size) {
    if (!size || description.toLocaleLowerCase().includes(size.toLocaleLowerCase())) return description;
    const count = size.match(/\b(12|24)\b/);
    return `${description} (${count ? `${count[1]}s` : size})`;
}

function getAngelBarCategoryContext(text) {
    const upperText = String(text || '').toLocaleUpperCase();
    if (isOtherProductDescription(upperText)) return '';
    if (upperText.includes('MANGO')) return 'MANGO ONLY ANGEL BARS';
    if (/\bASSTD\b|\bASSORTED\b/.test(upperText)) return 'ANGEL BARS ASSORTED';
    if (/ANGEL\s*BARS?/i.test(upperText)) return 'ANGEL BARS';
    return '';
}

function hasAngelBarSizeMarker(text) {
    return /\b(?:12|24)\s*(?:PCS?|PIECES?|S)\b|\((?:12|24)\b/i.test(String(text || ''));
}

function parseAngelBarVariant(rowCells, categoryContext = '') {
    const fullRowText = `${rowCells.map(cell => String(cell || '')).join(' ')} ${categoryContext}`.toLocaleUpperCase();
    if (isOtherProductDescription(fullRowText)) return null;
    const isAngelBar = /ANGEL\s*BARS?/i.test(fullRowText)
        || /\bASSTD\b|\bASSORTED\b/.test(fullRowText)
        || fullRowText.includes('MANGO');
    if (!isAngelBar) return null;

    const isMango = fullRowText.includes('MANGO');
    const isAssorted = fullRowText.includes('ASSTD') || fullRowText.includes('ASSORTED') || !isMango;
    
    // Suriin kung may 12 PCS / 12s marker sa order text
    const is12s = /\b12\s*(?:PCS?|PIECES?|S)?\b|\(12\b/i.test(fullRowText);

    if (isMango) return `Angel Bars Mango Only (${is12s ? '12s' : '24s'})`;
    if (isAssorted) return `Angel Bars Assorted (${is12s ? '12s' : '24s'})`;
    return null;
}

function isOtherProductDescription(text) {
    return /\b(?:COOKIES?|TAISAN|LECHEROONS?|MILK|SPAM|CAKES?|PASTR(?:Y|IES))\b/i.test(text);
}

function normalizeAngelBarDescription(description, size = '', rowCells = [], categoryContext = '') {
    const rowVariant = parseAngelBarVariant([size, description, ...rowCells], categoryContext);
    if (rowVariant) return rowVariant;
    if (!/angel\s*bars?/i.test(description)) return appendSize(description, size);
    const fullText = `${size} ${description}`.toLocaleLowerCase();
    const hasTwelve = /(?:^|\D)12(?:\s*(?:pcs?|pieces?)|s\b|\b)/i.test(fullText);
    const sizeLabel = hasTwelve ? '12s' : '24s';
    if (/mango/i.test(fullText)) return `Angel Bars Mango Only (${sizeLabel})`;
    if (/assorted/i.test(fullText)) return `Angel Bars Assorted (${sizeLabel})`;
    return appendSize(description, size);
}

function mergeExistingState(parsedCustomers) {
    const existing = new Map(appState.customerOrders.map(customer => [
        normalizeCustomerKey(customer.name),
        customer
    ]));

    parsedCustomers.forEach(customer => {
        const previous = existing.get(normalizeCustomerKey(customer.name));
        if (!previous) return;

        customer.status = previous.status || 'pending';
        const previousPrices = new Map();
        (previous.items || []).forEach(item => {
            if (item.unitPrice === undefined || item.unitPrice === null || !Number.isFinite(Number(item.unitPrice))) return;
            const key = normalizeItemKey(normalizeAngelBarDescription(item.description), item.unit);
            if (!previousPrices.has(key)) previousPrices.set(key, []);
            previousPrices.get(key).push(Number(item.unitPrice));
        });
        const packedItems = new Set((previous.items || [])
            .filter(item => item.checked)
            .map(item => normalizeItemKey(normalizeAngelBarDescription(item.description), item.unit)));
        customer.items.forEach(item => {
            const itemKey = normalizeItemKey(normalizeAngelBarDescription(item.description), item.unit);
            item.checked = packedItems.has(itemKey);
            if (item.unitPrice === undefined || item.unitPrice === null || !Number.isFinite(Number(item.unitPrice))) {
                const prices = previousPrices.get(itemKey);
                if (prices?.length) item.unitPrice = prices.shift();
            }
        });
    });
}