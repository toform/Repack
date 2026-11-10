import { appState } from './config.js';

export const ALL_PRODUCTS = [
    { id: 'ab_asstd_24', description: 'Angel Bars Assorted (24s)', unit: 'BOX', unitPrice: 525, category: 'Angel Bars', icon: '🥭' },
    { id: 'ab_asstd_12', description: 'Angel Bars Assorted (12s)', unit: 'BOX', unitPrice: 270, category: 'Angel Bars', icon: '🥭' },
    { id: 'ab_mango_24', description: 'Mango Only Angel Bars (24s)', unit: 'BOX', unitPrice: 535, category: 'Angel Bars', icon: '🥭' },
    { id: 'ab_mango_12', description: 'Mango Only Angel Bars (12s)', unit: 'BOX', unitPrice: 275, category: 'Angel Bars', icon: '🥭' },
    { id: 'cake_cheesy_8', description: 'Cheesy Pastillas Cake Round 8"', unit: 'PCS', unitPrice: 650, category: 'Cakes & Pastries', icon: '🍰' },
    { id: 'cake_ube_8', description: 'Ube Pastillas Cake Round 8"', unit: 'PCS', unitPrice: 675, category: 'Cakes & Pastries', icon: '🍰' },
    { id: 'cake_choco_8', description: 'Chocolate Round 8"', unit: 'PCS', unitPrice: 750, category: 'Cakes & Pastries', icon: '🍰' },
    { id: 'taisan_classic', description: 'Classic Taisan', unit: 'PCS', unitPrice: 195, category: 'Cakes & Pastries', icon: '🍰' },
    { id: 'cookie_asstd_5', description: 'Assorted Cookies (5 pcs)', unit: 'BOXES', unitPrice: 650, category: 'Cookies', icon: '🍪' },
    { id: 'cookie_rv_5', description: 'Red Velvet Cookies Only (5 pcs)', unit: 'BOXES', unitPrice: 700, category: 'Cookies', icon: '🍪' },
    { id: 'lecheroons_12', description: 'Lecheroons (12 pcs)', unit: 'BOXES', unitPrice: 230, category: 'Cookies', icon: '🍪' },
    { id: 'milk_oat', description: 'Oat Milk', unit: 'PCS', unitPrice: 160, category: 'Milk & Spam', icon: '🥛' },
    { id: 'milk_oat_choco', description: 'Oat Milk Choco', unit: 'PCS', unitPrice: 180, category: 'Milk & Spam', icon: '🥛' },
    { id: 'spam_can', description: 'Spam', unit: 'PCS', unitPrice: 85, category: 'Milk & Spam', icon: '🥫' }
];

const LEGACY_PRODUCT_NAMES = new Map([
    ['angelbarsmangoonly24s', 'Mango Only Angel Bars (24s)'],
    ['angelbarsmangoonly12s', 'Mango Only Angel Bars (12s)']
]);

export function getCatalogProducts() {
    return [
        ...ALL_PRODUCTS.map(product => ({
            ...product,
            name: product.description,
            exportCategory: product.category,
            category: getCatalogCategory(product.category)
        })),
        ...appState.customProducts.map(product => ({
            id: product.id,
            description: product.description,
            name: product.description,
            category: getCatalogCategory(product.category),
            exportCategory: product.category,
            icon: product.icon,
            unit: product.unit,
            unitPrice: Number(product.unitPrice) || 0,
            customProductId: product.id
        }))
    ];
}

export function getCatalogProduct(description) {
    const key = normalizeProductName(typeof description === 'string' ? description : description?.description ?? description?.name);
    const canonicalName = LEGACY_PRODUCT_NAMES.get(key);
    const lookupKey = canonicalName ? normalizeProductName(canonicalName) : key;
    return getCatalogProducts().find(product =>
        normalizeProductName(product.description) === lookupKey
    );
}

export function getProductUnitPrice(product) {
    const value = typeof product === 'string' ? {} : product || {};
    const catalogMatch = getCatalogProduct(typeof product === 'string' ? product : value.description);
    const price = Number(value.unitPrice || value.price || value.defaultPrice || catalogMatch?.unitPrice || 0);
    return Number.isFinite(price) && price >= 0 ? price : Number(catalogMatch?.unitPrice) || 0;
}

export function getCatalogCategory(category) {
    return category === 'Milk & Spam' ? 'Milk' : category;
}

function normalizeProductName(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}