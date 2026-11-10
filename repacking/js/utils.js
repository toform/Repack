export function getItemSortPriority(description) {
    const text = String(description || '').toLocaleLowerCase();
    if (text.includes('milk')) return 1;
    if (text.includes('spam')) return 2;
    if (text.includes('angel')) return 3;
    if (text.includes('cookie')) return 4;
    return 5;
}

export function sortCustomerItemLists(customerList) {
    customerList.forEach(customer => {
        if (!Array.isArray(customer?.items)) return;
        customer.items.sort((a, b) =>
            getItemSortPriority(a.description) - getItemSortPriority(b.description)
        );
    });
}

export function normalizeCustomerKey(name) {
    return normalizeAreaCode(name)
        .normalize('NFKC')
        .toLocaleUpperCase()
        .replace(/\s+/g, '')
        .replace(/[()]/g, '');
}

export function normalizeAreaCode(name) {
    if (!name) return '';
    const areaAliases = {
        AR: 'AUR',
        OCC: 'OCCM',
        NE: 'N-ECIJA',
        CV: 'CVT'
    };
    return String(name).replace(/\(([^)]+)\)/g, (match, code) =>
        `(${areaAliases[code.trim().toLocaleUpperCase()] || code.trim().toLocaleUpperCase()})`
    );
}

export function extractAreaCode(name) {
    const customerName = String(name || '');
    const normalizedName = normalizeAreaCode(customerName);
    const match = normalizedName.match(/\(([^)]+)\)/);
    if (!match) return { cleanName: customerName.trim(), area: 'NO_AREA' };

    return {
        cleanName: normalizedName.replace(/\([^)]+\)/g, '').trim(),
        area: match[1].trim().toLocaleUpperCase()
    };
}

export function extractCustomerArea(name) {
    const { area } = extractAreaCode(name);
    return area === 'NO_AREA' ? '' : area.normalize('NFKC');
}

export function normalizeCustomerName(name) {
    return String(name || '')
        .normalize('NFKC')
        .replace(/\([^)]*\)/g, ' ')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function getNameSimilarity(left, right) {
    const a = normalizeCustomerName(left);
    const b = normalizeCustomerName(right);
    if (!a || !b) return 0;
    if (a === b) return 1;

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row++) {
        const current = [row];
        for (let column = 1; column <= b.length; column++) {
            const substitutionCost = a[row - 1] === b[column - 1] ? 0 : 1;
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + substitutionCost
            );
        }
        previous = current;
    }

    return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function getDuplicatePairKey(firstKey, secondKey) {
    return [firstKey, secondKey].sort().join('::');
}

export function mergeCustomerData(primary, secondary) {
    primary.items.push(...secondary.items);
    const checkedCount = primary.items.filter(item => item.checked).length;
    if (primary.items.length && checkedCount === primary.items.length) {
        primary.status = 'completed';
    } else if (checkedCount > 0) {
        primary.status = 'incomplete';
    } else if (primary.status !== secondary.status) {
        primary.status = 'pending';
    }
    return primary;
}

export function normalizeInventoryUnit(unit) {
    const value = String(unit || '').trim();
    const normalized = value.toLocaleLowerCase();
    if (/^box(?:es)?$/.test(normalized)) return 'Boxes';
    if (/^(pcs?|pieces?)$/.test(normalized)) return 'Pcs';
    return value;
}

export function formatInventoryUnit(unit, quantity = 2) {
    const normalized = String(unit || '').trim().toLocaleLowerCase();
    if (/^box(?:es)?$/.test(normalized)) return quantity === 1 ? 'Box' : 'Boxes';
    if (/^(pcs?|pieces?)$/.test(normalized)) return quantity === 1 ? 'Pc' : 'Pcs';
    return String(unit || '').trim() || 'items';
}

export function formatInventoryQuantity(quantity, unit) {
    const count = Number(quantity) || 0;
    return `${count.toLocaleString()} ${formatInventoryUnit(unit, count)}`;
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

export function normalizeItemKey(description, unit) {
    return `${String(description || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()}|${normalizeInventoryUnit(unit).toLocaleLowerCase()}`;
}
