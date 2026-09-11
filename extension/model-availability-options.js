import {
  MODEL_AVAILABILITY_STORAGE_KEY,
  MODEL_UNAVAILABLE_MESSAGE,
  MODEL_UNAVAILABLE_MESSAGE_EN,
  normalizeAvailabilityState,
} from './model-availability.js';
import { normalizeConcreteModelId } from './policy.js';

const container = document.getElementById('modelChoices');
let availability = normalizeAvailabilityState(null);
let tooltipTimer = null;

function availabilityFor(input) {
  const model = normalizeConcreteModelId(input?.value);
  return model ? availability.models?.[model] || null : null;
}

function ensureTooltip(row) {
  let tooltip = row.querySelector('.model-unavailable-tooltip');
  if (tooltip) return tooltip;
  tooltip = document.createElement('span');
  tooltip.className = 'model-unavailable-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = `${MODEL_UNAVAILABLE_MESSAGE} / ${MODEL_UNAVAILABLE_MESSAGE_EN}`;
  row.append(tooltip);
  return tooltip;
}

function applyRow(input) {
  if (!(input instanceof HTMLInputElement) || input.name !== 'model') return;
  const row = input.closest('.check-row');
  if (!row) return;
  const unavailable = availabilityFor(input)?.status === 'unavailable';

  if (unavailable) {
    row.classList.add('model-unavailable');
    row.dataset.modelUnavailable = 'true';
    row.title = MODEL_UNAVAILABLE_MESSAGE;
    row.tabIndex = 0;
    input.checked = false;
    input.disabled = true;
    input.dataset.availabilityDisabled = 'true';
    input.setAttribute('aria-disabled', 'true');
    ensureTooltip(row);
    return;
  }

  if (input.dataset.availabilityDisabled === 'true') {
    input.disabled = false;
    input.removeAttribute('aria-disabled');
    delete input.dataset.availabilityDisabled;
  }
  row.classList.remove('model-unavailable');
  delete row.dataset.modelUnavailable;
  delete row.dataset.tooltipOpen;
  if (row.title === MODEL_UNAVAILABLE_MESSAGE) row.removeAttribute('title');
  if (row.tabIndex === 0) row.removeAttribute('tabindex');
  row.querySelector('.model-unavailable-tooltip')?.remove();
}

function applyAvailability() {
  if (!container) return;
  for (const input of container.querySelectorAll('input[name="model"]')) applyRow(input);
}

async function refreshAvailability() {
  const stored = await chrome.storage.local.get(MODEL_AVAILABILITY_STORAGE_KEY);
  availability = normalizeAvailabilityState(stored[MODEL_AVAILABILITY_STORAGE_KEY]);
  applyAvailability();
}

function showClickTooltip(row) {
  clearTimeout(tooltipTimer);
  row.dataset.tooltipOpen = 'true';
  tooltipTimer = window.setTimeout(() => {
    delete row.dataset.tooltipOpen;
  }, 2400);
}

container?.addEventListener('click', (event) => {
  const row = event.target?.closest?.('.model-unavailable');
  if (!row) return;
  event.preventDefault();
  event.stopPropagation();
  showClickTooltip(row);
}, true);

container?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const row = event.target?.closest?.('.model-unavailable');
  if (!row) return;
  event.preventDefault();
  showClickTooltip(row);
});

if (container) {
  const observer = new MutationObserver(applyAvailability);
  observer.observe(container, { childList: true, subtree: true });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[MODEL_AVAILABILITY_STORAGE_KEY]) return;
  availability = normalizeAvailabilityState(changes[MODEL_AVAILABILITY_STORAGE_KEY].newValue);
  applyAvailability();
});

void refreshAvailability().catch(() => {});
