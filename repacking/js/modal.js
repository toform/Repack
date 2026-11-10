import { appState } from './config.js';
import { escapeHtml, formatInventoryQuantity, getDuplicatePairKey, mergeCustomerData, normalizeCustomerKey } from './utils.js';
import { saveDuplicateDecisions, saveToLocalStorage } from './storage.js';
import { renderCards } from './renderCards.js';
import { updateSummaryStats } from './sidebar.js';
import { refreshCustomerOptions } from './orderEntry.js';
import { closeKiosk, openCustomerKiosk } from './kiosk.js';

export function showDuplicateModal() {
    const modal = document.getElementById('duplicateModal');
    if (!modal) return;
    if (!appState.pendingDuplicateMerges.length) {
        modal.classList.add('hidden');
        return;
    }
    renderDuplicatePrompt();
    modal.classList.remove('hidden');
}

export function decideDuplicateMerge(action) {
    const candidate = appState.pendingDuplicateMerges.shift();
    if (!candidate) return;

    const decision = {
        primaryKey: candidate.primaryKey,
        secondaryKey: candidate.secondaryKey,
        action
    };
    const pairKey = getDuplicatePairKey(decision.primaryKey, decision.secondaryKey);
    appState.duplicateDecisions = appState.duplicateDecisions.filter(existing =>
        getDuplicatePairKey(existing.primaryKey, existing.secondaryKey) !== pairKey
    );
    appState.duplicateDecisions.push(decision);
    saveDuplicateDecisions();

    if (action === 'merge') {
        mergeDuplicateCustomers(candidate);
        rewirePendingCandidates(candidate);
        saveToLocalStorage();
    }

    renderCards();
    updateSummaryStats();
    refreshCustomerOptions();
    showDuplicateModal();
}

export function openModal(index) {
    openCustomerKiosk(index);
}

export function closeModal() {
    closeKiosk();
    appState.currentActiveCustomerIndex = null;
}

function renderDuplicatePrompt() {
    const modal = document.getElementById('duplicateModal');
    const details = document.getElementById('duplicateDetails');
    const counter = document.getElementById('duplicateCounter');
    const candidate = appState.pendingDuplicateMerges[0];
    if (!modal || !details || !candidate) return;

    const primary = findCustomer(candidate.primaryKey);
    const secondary = findCustomer(candidate.secondaryKey);
    if (!primary || !secondary) {
        appState.pendingDuplicateMerges.shift();
        showDuplicateModal();
        return;
    }

    counter.textContent = `${appState.pendingDuplicateMerges.length} possible duplicate${appState.pendingDuplicateMerges.length === 1 ? '' : 's'} remaining`;
    details.innerHTML = `
        <section class="duplicate-order-card">
            <h3>Card A · ${escapeHtml(primary.name)}</h3>
            ${renderDuplicateItems(primary)}
        </section>
        <div class="duplicate-versus" aria-hidden="true">OR</div>
        <section class="duplicate-order-card">
            <h3>Card B · ${escapeHtml(secondary.name)}</h3>
            ${renderDuplicateItems(secondary)}
        </section>
    `;
}

function renderDuplicateItems(customer) {
    const items = (customer.items || []).map(item =>
        `<li>${escapeHtml(formatInventoryQuantity(item.qty, item.unit))} ${escapeHtml(item.description)}</li>`
    ).join('');
    return `<ul>${items || '<li>No order items</li>'}</ul>`;
}

function findCustomer(key) {
    return appState.customerOrders.find(customer => normalizeCustomerKey(customer.name) === key);
}

function mergeDuplicateCustomers(candidate) {
    const primaryIndex = appState.customerOrders.findIndex(customer =>
        normalizeCustomerKey(customer.name) === candidate.primaryKey
    );
    const secondaryIndex = appState.customerOrders.findIndex(customer =>
        normalizeCustomerKey(customer.name) === candidate.secondaryKey
    );
    if (primaryIndex === -1 || secondaryIndex === -1 || primaryIndex === secondaryIndex) return;

    mergeCustomerData(
        appState.customerOrders[primaryIndex],
        appState.customerOrders[secondaryIndex]
    );
    appState.customerOrders.splice(secondaryIndex, 1);
}

function rewirePendingCandidates(mergedCandidate) {
    const rewired = new Map();
    appState.pendingDuplicateMerges.forEach(candidate => {
        const primaryKey = candidate.primaryKey === mergedCandidate.secondaryKey
            ? mergedCandidate.primaryKey
            : candidate.primaryKey;
        const secondaryKey = candidate.secondaryKey === mergedCandidate.secondaryKey
            ? mergedCandidate.primaryKey
            : candidate.secondaryKey;
        if (primaryKey === secondaryKey) return;

        const pairKey = getDuplicatePairKey(primaryKey, secondaryKey);
        if (!rewired.has(pairKey)) {
            const primary = findCustomer(primaryKey);
            const secondary = findCustomer(secondaryKey);
            if (primary && secondary) {
                rewired.set(pairKey, {
                    primaryKey,
                    secondaryKey,
                    primaryName: primary.name,
                    secondaryName: secondary.name,
                    similarity: candidate.similarity
                });
            }
        }
    });
    appState.pendingDuplicateMerges = [...rewired.values()];
}
