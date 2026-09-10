from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def patch(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing patch target in {path}: {old[:120]}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# Upgrade cards can be filtered by current rank; commerce decoration must bind by code, not position.
patch('extension/account.js',
      "const card = document.createElement('article'); card.className = 'plan';",
      "const card = document.createElement('article'); card.className = 'plan'; card.dataset.planCode = plan.code;")
patch('extension/account-commerce.js',
      "const plan = state.config.plans?.[index]; if (!plan || card.dataset.commerceDecorated === plan.code) return;",
      "const plan = state.config.plans?.find((item) => item.code === card.dataset.planCode) || state.config.plans?.[index]; if (!plan || card.dataset.commerceDecorated === plan.code) return;")

# Keep popup reward refresh aligned with the account gate's event name.
patch('extension/popup-rewards.js',
      "document.addEventListener('gptwork-account-changed', () => void refresh());",
      "window.addEventListener('gptlock-account-changed', () => void refresh());\ndocument.addEventListener('gptwork-account-changed', () => void refresh());")

print('post migration fixes applied')
